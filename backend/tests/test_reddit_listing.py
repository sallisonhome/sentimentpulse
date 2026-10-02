from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from services import reddit_listing as listing, reddit_transport as rt


@pytest.fixture
def run(monkeypatch):
    rt.begin_run()
    rt._local.started_epoch = 1000
    monkeypatch.setattr(listing, "PAGE_SIZE", 3)
    fetch = Mock()
    monkeypatch.setattr(rt, "fetch_json", fetch)
    yield fetch
    rt.end_run()


def post(pid, epoch, title="", body=""):
    return {"id": pid, "created_utc": epoch, "title": title, "selftext": body,
            "author": "player", "subreddit": "gaming", "score": 1}


def test_shared_listing_pages_cover_both_fields_and_overlap(run):
    run.side_effect = [
        {"data": [post("a", 990, "Hellraiser game"), post("x", 980), post("b", 970, body="Hellraiser")]},
        {"data": [post("b", 970, body="Hellraiser"), post("c", 960, "Hellraiser"), post("y", 950)]},
        {"data": [post("y", 950), post("d", 940, body="Hellraiser")]},
    ]
    result = listing.fetch_candidates("Gaming", "Hellraiser", after=900)
    assert {p["id"] for p in result} == {"a", "b", "c", "d"}
    assert result.complete and result.checked_through == 1000
    assert [c.args[1]["before"] for c in run.call_args_list] == [1000, 971, 951]
    other = listing.fetch_candidates("gaming", "Another", after=900)
    assert other == [] and other.complete and other.checked_through == 1000
    assert run.call_count == 3


def test_original_after_window_is_not_clamped(run):
    run.side_effect = [
        {"data": [post("a", 900), post("b", 800), post("c", 700)]},
        {"data": [post("c", 700), post("d", 600), post("e", 500)]},
        {"data": [post("e", 500), post("f", 400, body="Hellraiser")]},
    ]
    rows = listing.fetch_candidates("gaming", "Hellraiser", after=200)
    assert [p["id"] for p in rows] == ["f"]
    assert rows.complete and run.call_count == 3


def test_after_is_exclusive_and_boundary_stops_scan(run):
    run.return_value = {"data": [post("a", 990, "Game"), post("b", 980, "Game"), post("c", 970, "Game")]}
    rows = listing.fetch_candidates("gaming", "Game", after=980)
    assert [p["id"] for p in rows] == ["a"]
    assert rows.complete and rows.checked_through == 1000


def test_per_field_caps_preserved_without_false_exhaustion(run):
    run.return_value = {"data": [post("a", 990, "Game"), post("b", 980, body="Game"), post("c", 970)]}
    rows = listing.fetch_candidates("gaming", "Game", after=500, limit=1)
    assert {p["id"] for p in rows} == {"a", "b"}
    assert rows.complete and rows.checked_through is None


def test_empty_window_is_proven_not_failed(run):
    run.return_value = {"data": []}
    rows = listing.fetch_candidates("gaming", "Game", after=500)
    assert rows == [] and rows.complete and rows.checked_through == 1000


def test_failed_page_retains_prior_candidates_and_no_watermark(run):
    run.side_effect = [
        {"data": [post("a", 990, "Game"), post("b", 980), post("c", 970)]},
        rt.UpstreamFailure("HTTP 429"),
    ]
    rows = listing.fetch_candidates("gaming", "Game", after=500)
    assert [p["id"] for p in rows] == ["a"]
    assert not rows.complete and rows.checked_through is None


@pytest.mark.parametrize("budgets", [{"max_pages": 0}, {"max_seconds": 0}])
def test_budgets_never_claim_complete(run, budgets):
    rows = listing.fetch_candidates("gaming", "Game", after=500, **budgets)
    assert not rows.complete and rows.checked_through is None
    run.assert_not_called()


def test_same_second_saturation_is_not_silently_skipped(run):
    run.side_effect = [
        {"data": [post("a", 990, "Game"), post("b", 990), post("c", 990)]},
        {"data": [post("a", 990, "Game"), post("b", 990), post("c", 990)]},
    ]
    rows = listing.fetch_candidates("gaming", "Game", after=500)
    assert not rows.complete and rows.checked_through is None


def test_invalid_response_does_not_earn_coverage(run):
    run.return_value = {"data": [{"id": "a", "title": "Game"}]}
    rows = listing.fetch_candidates("gaming", "Game", after=500)
    assert not rows.complete and rows.checked_through is None


def test_cache_copies_cannot_leak_game_annotations_and_are_cleaned(run):
    run.return_value = {"data": [post("a", 990, "Game")]}
    rows = listing.fetch_candidates("gaming", "Game", after=500)
    rows[0]["override_tier"] = "noise"
    again = listing.fetch_candidates("gaming", "Game", after=500)
    assert "override_tier" not in again[0]
    path = Path(rt._local.listing_cache.directory.name)
    assert path.exists()
    rt.end_run()
    assert not path.exists()


def test_daily_path_retains_game_gate_and_checked_watermark(run):
    from services.arctic_shift_service import fetch_arctic_shift_subreddit_posts
    run.return_value = {"data": [
        post("a", 990, "Rideshare", "Uber fares increased"),
        post("b", 980, "Rideshare Saber game"),
    ]}
    game = SimpleNamespace(name='Rideshare "Stimulator"', distinctive_keywords=["Saber"])
    rows = fetch_arctic_shift_subreddit_posts("gaming", game_name=game.name,
                                             is_general_sub=True, game=game, after=500)
    assert [p["external_id"] for p in rows] == ["b"]
    assert rows.complete and rows.checked_through == 1000
    assert rows[0]["url"] == "https://www.reddit.com/r/gaming/comments/b/"
    assert rows[0]["post_date"].timestamp() == 980


@pytest.mark.parametrize("health,errors,expected", [
    ("ok", ["[Step 4] upstream incomplete"], "partial"),
    ("degraded", ["[Step 4a] upstream incomplete"], "partial"),
    ("ok", ["[Step 2] failure"], "ok"),
    ("ok", [], "ok"),
    ("failed", ["[Step 4] upstream incomplete"], "failed"),
    ("skipped", ["[Step 4] upstream incomplete"], "skipped"),
])
def test_health_reflects_read_completeness(health, errors, expected):
    from services.ingestor import _reddit_completeness_health
    assert _reddit_completeness_health(health, errors) == expected


@pytest.mark.parametrize("complete,checked,save_error,expected", [
    (True, 1000, False, 1000),
    (False, None, False, None),
    (True, 1000, True, None),
])
def test_step4_advances_proven_empty_window_only_after_safe_save(
        db, monkeypatch, complete, checked, save_error, expected):
    from models import Game, Publisher
    from services import ingestor
    from services.source_cursor_service import read_cursor
    publisher = Publisher(name="Test")
    db.add(publisher)
    db.flush()
    game = Game(name="Example", steam_app_id=1, publisher_id=publisher.id,
                subreddits=["gaming"], is_active=True)
    db.add(game)
    db.commit()
    monkeypatch.setattr(ingestor, "fetch_subreddit_posts",
                        lambda *a, **kw: rt.FetchRows([], complete=complete, checked_through=checked))
    if save_error:
        def failed_save(db, gid, source, rows, errors):
            errors.append("save failed")
            return 0
        monkeypatch.setattr(ingestor, "_bulk_save_posts", failed_save)
    errors = []
    ingestor._step4_reddit(db, game, [], errors)
    assert read_cursor(db, game.id, "reddit", "gaming") == expected


def test_status_corrects_legacy_green_health_without_rewriting_history(monkeypatch):
    from services import ingestor
    old = {"last_run_at": "2026-09-28T09:45:00Z", "last_run_status": "partial",
           "reddit_health": "ok", "last_run_errors": ["[Step 4] upstream incomplete"],
           "reddit_fetched_total": 25153}
    monkeypatch.setattr(ingestor, "_status", old.copy())
    status = ingestor.get_status()
    assert status["reddit_health"] == "partial"
    assert status["last_run_errors"] == old["last_run_errors"]
    assert ingestor._status["reddit_health"] == "ok"


def test_status_http_response_exposes_partial(client, monkeypatch):
    from services import ingestor
    monkeypatch.setitem(ingestor._status, "last_run_at", "2026-09-28T09:45:00Z")
    monkeypatch.setitem(ingestor._status, "reddit_health", "ok")
    monkeypatch.setitem(ingestor._status, "last_run_errors", ["[Step 4] incomplete"])
    response = client.get("/api/ingest/status")
    assert response.status_code == 200
    assert response.json()["reddit_health"] == "partial"


def test_disk_payload_budget_evicts_old_pages_without_corruption(run, monkeypatch):
    monkeypatch.setattr(listing, "CACHE_BYTES", 260)
    cache = listing._cache()
    for i in range(5):
        cache.put("gaming", 999-i, [post(str(i), 990, title=str(i)*300)])
    assert cache.size <= 260
    assert cache.get("gaming", 999) is None
    assert cache.get("gaming", 995)[0]["id"] == "4"


def test_creator_name_cannot_supply_duplicate_game_keyword_as_companion():
    from services.reddit_service import _post_mentions_game
    args = dict(search_query="Aliens", distinctive_keywords=["aliens", "fireteam", "xenomorph"],
                game_name="Aliens: Fireteam Elite 2")
    assert not _post_mentions_game(
        {"title":"Gentoo Rescue", "body":"Gameplay from Aliensrock's series about penguin puzzles."}, **args)
    assert _post_mentions_game(
        {"title":"Aliens: Fireteam Elite 2", "body":"Fireteam combat feels great."}, **args)


def test_single_word_game_name_must_not_match_inside_a_creator_handle():
    from services.reddit_service import _post_mentions_game
    args = dict(search_query="SnowRunner", distinctive_keywords=["snowrunner"], game_name="SnowRunner")
    assert not _post_mentions_game({"title":"Other game", "body":"SnowRunnerGuy plays a puzzle."}, **args)
    assert _post_mentions_game({"title":"SnowRunner", "body":"The mud physics feel great."}, **args)


# ── 2026-10-02: resumable deep windows (Knightling r/Games ratchet) ─────────

class Provider:
    """Simulated Arctic Shift listing: newest-first pages of PAGE_SIZE=3,
    with a clock that advances 5s per request (budget 10s = 2 pages)."""

    def __init__(self, epochs, hits=()):
        self.posts = [post(f"p{e}", e, "Knightling" if e in hits else "") for e in epochs]
        self.calls = 0
        self.befores = []

    def __call__(self, url, params, **kw):
        self.calls += 1
        self.befores.append(params["before"])
        rows = [p for p in self.posts if p["created_utc"] < params["before"]]
        rows.sort(key=lambda p: -p["created_utc"])
        return {"data": rows[:3]}

    def clock(self):
        return self.calls * 5


def budgeted(run, monkeypatch, provider, *, upper, after, resume=None):
    rt._local.started_epoch = upper
    rt._local.listing_cache = None      # each daily run starts with a cold cache
    run.side_effect = provider
    monkeypatch.setattr(listing.time, "monotonic", provider.clock)
    start = provider.calls
    rows = listing.fetch_candidates("Games", "Knightling", after=after,
                                    max_seconds=10, resume=resume)
    provider.calls_this_run = provider.calls - start
    return rows


def test_time_budget_returns_scanned_interval_not_completion(run, monkeypatch):
    prov = Provider(range(990, 700, -10))
    rows = budgeted(run, monkeypatch, prov, upper=1000, after=100)
    assert not rows.complete and rows.checked_through is None
    assert rows.stop_reason == "time_budget"
    # Pages before=1000 (990,980,970) and before=971 (970,960,950; one-second
    # overlap) were read; continue strictly below the oldest page boundary.
    assert prov.befores == [1000, 971]
    assert rows.resume == {"after": 100, "before": 951, "upper": 1000}


def test_resume_reads_new_top_then_continues_below_old_boundary(run):
    # Earlier run read [931, 1000) for after=100; this run's upper is 1100.
    rt._local.started_epoch = 1100
    rt._local.listing_cache = None
    run.side_effect = [
        # New top segment 1100 -> down to old upper 1000 (exclusive 999).
        {"data": [post("n1", 1090, "Knightling"), post("n2", 1050), post("n3", 990)]},
        # Continue below 931 down to after=100.
        {"data": [post("o1", 920, body="Knightling"), post("o2", 500), post("o3", 300)]},
        {"data": [post("o4", 200)]},
    ]
    rows = listing.fetch_candidates("Games", "Knightling", after=100,
                                    resume={"after": 100, "before": 931, "upper": 1000})
    assert {p["id"] for p in rows} == {"n1", "o1"}
    assert rows.complete and rows.checked_through == 1100 and rows.resume is None
    assert [c.args[1]["before"] for c in run.call_args_list] == [1100, 931, 301]


def test_deep_window_finishes_with_resume_but_never_by_restarting(run, monkeypatch):
    """The production failure: restarting at the top never finishes."""
    epochs = list(range(990, 870, -10))          # 12 posts = 4 pages
    hits = {950, 890}
    # Old behaviour: every run restarts at the top and stops after 2 pages.
    for _ in range(3):
        restart = budgeted(run, monkeypatch, Provider(epochs, hits), upper=1000, after=880)
        assert not restart.complete and {p["id"] for p in restart} == {"p950"}
    # New behaviour: each run resumes below the previous boundary until done.
    prov = Provider(epochs, hits)
    found, resume, runs = set(), None, 0
    while True:
        runs += 1
        rows = budgeted(run, monkeypatch, prov, upper=1000, after=880, resume=resume)
        found |= {p["id"] for p in rows}
        assert runs <= 6, "resume must make monotonic progress"
        if rows.complete:
            break
        assert rows.resume and (resume is None or rows.resume["before"] < resume["before"])
        resume = rows.resume
    assert rows.checked_through == 1000 and rows.resume is None and runs > 1
    assert found == {"p950", "p890"}


def test_new_posts_above_old_upper_are_read_before_resuming(run, monkeypatch):
    prov = Provider([1090, 1050] + list(range(990, 870, -10)), hits={1090})
    prior = {"after": 880, "before": 941, "upper": 1000}
    rows = budgeted(run, monkeypatch, prov, upper=1100, after=880, resume=prior)
    # Top segment 1100 -> 999 first (one page reaches 990), then below 941;
    # the 2-page budget ends mid-way and the new record spans [921, 1100).
    assert prov.befores[0] == 1100 and prov.befores[1] == 941
    assert "p1090" in {p["id"] for p in rows}
    assert not rows.complete
    assert rows.resume == {"after": 880, "before": 921, "upper": 1100}


def test_mismatched_or_malformed_resume_is_ignored(run):
    run.return_value = {"data": []}
    for bad in ({"after": 99, "before": 931, "upper": 1000},
                {"after": 100, "before": 2000, "upper": 3000},
                {"after": 100, "before": 50, "upper": 1000},
                {"before": 931}, "junk"):
        rows = listing.fetch_candidates("Games", "Knightling", after=100, resume=bad)
        assert rows.complete and rows.checked_through == 1000
        assert run.call_args_list[-1].args[1]["before"] == 1000


def test_unfinished_top_segment_keeps_prior_record(run, monkeypatch):
    clock = iter([0, 999, 999, 999])
    monkeypatch.setattr(listing.time, "monotonic", lambda: next(clock))
    rt._local.started_epoch = 1100
    rt._local.listing_cache = None
    prior = {"after": 100, "before": 931, "upper": 1000}
    run.side_effect = [{"data": [post("n1", 1090), post("n2", 1080), post("n3", 1070)]}]
    rows = listing.fetch_candidates("Games", "Knightling", after=100,
                                    max_seconds=10, resume=prior)
    assert not rows.complete and rows.resume == prior


def test_upstream_error_returns_no_new_resume(run):
    run.side_effect = rt.UpstreamFailure("HTTP 422")
    rows = listing.fetch_candidates("Games", "Knightling", after=100)
    assert not rows.complete and rows.resume is None


@pytest.mark.parametrize("scenario", ["partial", "complete", "save_error", "backfill"])
def test_step4_persists_and_retires_resume_records(db, monkeypatch, scenario):
    from models import Game, Publisher
    from services import ingestor
    from services.source_cursor_service import (
        read_cursor, read_listing_resume, write_listing_resume,
        backfill_suppress_cursor_updates,
    )
    publisher = Publisher(name="Test")
    db.add(publisher)
    db.flush()
    game = Game(name="Example", steam_app_id=1, publisher_id=publisher.id,
                subreddits=["Games"], is_active=True)
    db.add(game)
    db.commit()
    seen = {}
    prior = {"after": 100, "before": 931, "upper": 1000}
    if scenario in ("complete", "save_error"):
        write_listing_resume(db, game.id, "games", prior)
    new = {"after": 100, "before": 500, "upper": 1100}

    def fake_fetch(*a, **kw):
        seen["resume"] = kw.get("resume")
        if scenario == "complete":
            return rt.FetchRows([], complete=True, checked_through=1100)
        return rt.FetchRows([], complete=False, stop_reason="time_budget", resume=new)
    monkeypatch.setattr(ingestor, "fetch_subreddit_posts", fake_fetch)
    if scenario == "save_error":
        def failed_save(db, gid, source, rows, errors):
            errors.append("save failed")
            return 0
        monkeypatch.setattr(ingestor, "_bulk_save_posts", failed_save)
    log_lines, errors = [], []
    if scenario == "backfill":
        with backfill_suppress_cursor_updates():
            ingestor._step4_reddit(db, game, log_lines, errors)
    else:
        ingestor._step4_reddit(db, game, log_lines, errors)
    stored = read_listing_resume(db, game.id, "Games")
    if scenario == "partial":
        assert seen["resume"] is None and stored == new
        assert read_cursor(db, game.id, "reddit", "Games") is None
        assert any("listing progress saved" in l for l in log_lines)
    elif scenario == "complete":
        assert seen["resume"] == prior and stored is None
        assert read_cursor(db, game.id, "reddit", "Games") == 1100
    elif scenario == "save_error":
        assert stored == prior                 # never advanced past unsaved rows
        assert read_cursor(db, game.id, "reddit", "Games") is None
    else:
        assert stored is None                  # backfills never write progress


def test_partial_fallback_preserves_listing_resume(monkeypatch):
    from services import reddit_service, arctic_shift_service
    resume = {"after": 100, "before": 500, "upper": 1100}
    monkeypatch.setattr(arctic_shift_service, "fetch_arctic_shift_subreddit_posts",
                        lambda *a, **kw: rt.FetchRows([], complete=False,
                                                      stop_reason="time_budget", resume=resume))
    monkeypatch.setattr(reddit_service, "_load_gist_data", lambda: {})
    monkeypatch.setattr(reddit_service, "_fetch_pullpush", lambda *a, **kw: [])
    rows = reddit_service.fetch_subreddit_posts("Games", limit=100, game_name="Knightling",
                                                after=100, resume=resume)
    assert not rows.complete and rows.resume == resume
    assert rows.stop_reason == "time_budget"
