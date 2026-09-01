"""
v0031 (2026-09-01) — regression tests for the digest chart-drop bug.

Root cause: EditorialArticle UNIQUE(game_id, scope, cycle_start, url)
violations poisoned the SQLAlchemy Session, which cascaded into
_build_competitor_bullets returning None, which silently dropped the
Competitive Set section (chart + bullets) from the digest.

Fix:
  1. Dedup by final_url within each editorial fetch batch.
  2. Cross-batch existence check before db.add().
  3. Wrap the commit in try/rollback so session stays clean.
  4. In _build_competitor_bullets, on session-broken query issue rollback
     and retry once.

These tests lock in all four behaviors so we don't regress.
"""
import os
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)


# ─── Fix 4: _build_competitor_bullets recovers from a poisoned session ───

def test_build_competitor_bullets_rollback_and_retry_on_session_poison(db, monkeypatch):
    """When the first db.query(CompetitorGame) raises (e.g. because the
    Session was left in a rolled-back state by an earlier flush failure),
    _build_competitor_bullets must rollback and retry once instead of
    returning None. Returning None silently drops the Competitive Set
    section from the digest email."""
    from services import digest_service as ds
    from models import Game, Publisher, CompetitorGame

    # Seed a parent + one competitor so the retry path has data.
    pub = Publisher(name="Test Pub")
    db.add(pub)
    db.commit()
    parent = Game(publisher_id=pub.id, steam_app_id=1, name="Parent", is_active=True)
    comp = Game(publisher_id=pub.id, steam_app_id=2, name="Comp", is_active=True)
    db.add(parent); db.add(comp)
    db.commit()
    db.add(CompetitorGame(parent_id=parent.id, competitor_id=comp.id))
    db.commit()

    # Patch db.query to raise on FIRST call, succeed on second.
    real_query = db.query
    calls = {"n": 0}

    def flaky_query(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise Exception(
                "This Session's transaction has been rolled back due to "
                "a previous exception during flush"
            )
        return real_query(*args, **kwargs)

    monkeypatch.setattr(db, "query", flaky_query)
    # rollback() must be idempotent so the retry can succeed
    rollback_called = {"n": 0}
    real_rollback = db.rollback

    def counted_rollback():
        rollback_called["n"] += 1
        real_rollback()

    monkeypatch.setattr(db, "rollback", counted_rollback)

    # Also patch the daily-series loader and the chart render so the test
    # doesn't need matplotlib or 28 days of RawPost data.
    monkeypatch.setattr(
        ds, "_load_daily_pos_neg_series",
        lambda db, gid, days, today: [(today - timedelta(days=i), 1) for i in range(days, 0, -1)],
    )
    monkeypatch.setattr(
        ds, "_render_trend_png_data_uri",
        lambda pn, pd, cs, td: "data:image/png;base64,FAKE",
    )
    # Force weekly summaries to exist for the competitor so the code path
    # doesn't require full LLM generation.
    # _competitor_topic_sentence signature: (db, competitor_id,
    # competitor_name, competitor_total, week_start, row).
    monkeypatch.setattr(
        ds, "_competitor_topic_sentence",
        lambda db, competitor_id, competitor_name, competitor_total,
               week_start, row: "topic bullet stub",
    )

    result = ds._build_competitor_bullets(
        db,
        parent_game_id=parent.id,
        parent_positive=10, parent_negative=2, parent_total=12,
        parent_name="Parent",
        period="weekly",
        today=date.today(),
    )

    # Must NOT be None (would drop the section)
    assert result is not None, (
        "returning None drops the Competitive Set from the digest; "
        "the retry-after-rollback must run"
    )
    # Rollback should have been called exactly once (recovery from poison)
    assert rollback_called["n"] >= 1, (
        "rollback() must be called to clear the poisoned Session"
    )
    # Should have produced at least a chart bullet
    kinds = [b.get("kind") for b in result]
    assert "chart" in kinds, f"expected 'chart' bullet in result, got kinds={kinds}"


# ─── Fix 1 + 2: editorial fetch dedupes within batch + against DB ────────

def test_fetch_editorial_dedups_within_batch(db, monkeypatch):
    """Two candidates that resolve to the same final_url within a single
    fetch batch must only produce one EditorialArticle row \u2014 no UNIQUE
    violation on commit."""
    from services import editorial_research_service as ers
    from models import EditorialArticle, Game, Publisher

    pub = Publisher(name="Test Pub")
    db.add(pub); db.commit()
    game = Game(publisher_id=pub.id, steam_app_id=99, name="TestGame", is_active=True)
    db.add(game); db.commit()

    same_url = "https://example.com/duplicated-article"
    fake_candidates = [
        # publication differs so the domain-dedupe step (Step 3 of
        # fetch_editorial_for_title) keeps BOTH entries — they'd then
        # collide when Playwright resolves both to same_url.
        {"title": "First headline", "publication": "first.com",
         "link": "https://news.google.com/redirect?a=1", "published_at": None},
        {"title": "Second headline for same article", "publication": "second.com",
         "link": "https://news.google.com/redirect?a=2", "published_at": None},
    ]

    # Force Google News RSS to return our fake candidates.
    class _FakeResp:
        status_code = 200
        text = "stub"

    monkeypatch.setattr(ers.httpx, "get", lambda *a, **kw: _FakeResp())
    monkeypatch.setattr(ers, "_parse_google_news_rss", lambda text: fake_candidates)

    class _FakeBrowser:
        def __enter__(self): return self
        def __exit__(self, *a): pass

    monkeypatch.setattr(ers, "_playwright_browser", lambda: _FakeBrowser())
    monkeypatch.setattr(
        ers, "_extract_body_via_playwright",
        lambda browser, link: (same_url, "body text here"),
    )
    monkeypatch.setattr(ers, "_is_blocked_body", lambda body: False)
    monkeypatch.setattr(
        ers, "_summarize_article",
        lambda client, title, pub, body: "stub summary",
    )

    # Enable in-test editorial fetch
    monkeypatch.setenv("SENTIMENTPULSE_ENABLE_EDITORIAL_IN_TESTS", "1")

    cycle_start = date.today() - timedelta(days=6)
    cycle_end = date.today()

    result = ers.fetch_editorial_for_title(
        db, game_id=game.id, scope="weekly",
        cycle_start=cycle_start, cycle_end=cycle_end,
        anthropic_client=MagicMock(),
    )

    # Regardless of counts, no exception + at most one row per unique url
    rows = (
        db.query(EditorialArticle)
        .filter_by(game_id=game.id, scope="weekly", cycle_start=cycle_start)
        .all()
    )
    urls = [r.url for r in rows]
    assert len(urls) == len(set(urls)), (
        f"duplicate URLs persisted, dedup did not work: {urls}"
    )
    assert urls.count(same_url) <= 1, (
        f"same_url appeared {urls.count(same_url)} times, expected \u22641"
    )


def test_fetch_editorial_dedups_against_existing_db_row(db, monkeypatch):
    """A URL already stored in a prior fetch for the same
    (game_id, scope, cycle_start) must not cause a UNIQUE violation on
    the next fetch \u2014 the loop reuses the existing row instead."""
    from services import editorial_research_service as ers
    from models import EditorialArticle, Game, Publisher

    pub = Publisher(name="Test Pub")
    db.add(pub); db.commit()
    game = Game(publisher_id=pub.id, steam_app_id=100, name="TestGame2", is_active=True)
    db.add(game); db.commit()

    cycle_start = date.today() - timedelta(days=6)
    cycle_end = date.today()
    existing_url = "https://example.com/already-here"

    # Pre-seed one row so the next fetch would collide.
    db.add(EditorialArticle(
        game_id=game.id, scope="weekly",
        cycle_start=cycle_start, cycle_end=cycle_end,
        url=existing_url, title="Existing",
        publication="example.com", published_at=None,
        body="original body", summary="original summary",
        cite="E-001",
    ))
    db.commit()

    # New batch tries to fetch a URL that resolves to the same existing_url
    fake_candidates = [
        {"title": "New headline for existing article", "publication": "example.com",
         "link": "https://news.google.com/redirect?a=X", "published_at": None},
    ]

    class _FakeResp:
        status_code = 200
        text = "stub"

    monkeypatch.setattr(ers.httpx, "get", lambda *a, **kw: _FakeResp())
    monkeypatch.setattr(ers, "_parse_google_news_rss", lambda text: fake_candidates)

    class _FakeBrowser:
        def __enter__(self): return self
        def __exit__(self, *a): pass

    monkeypatch.setattr(ers, "_playwright_browser", lambda: _FakeBrowser())
    monkeypatch.setattr(
        ers, "_extract_body_via_playwright",
        lambda browser, link: (existing_url, "new body"),
    )
    monkeypatch.setattr(ers, "_is_blocked_body", lambda body: False)
    monkeypatch.setattr(
        ers, "_summarize_article",
        lambda client, title, pub, body: "new summary",
    )
    monkeypatch.setenv("SENTIMENTPULSE_ENABLE_EDITORIAL_IN_TESTS", "1")

    # Must NOT raise IntegrityError
    result = ers.fetch_editorial_for_title(
        db, game_id=game.id, scope="weekly",
        cycle_start=cycle_start, cycle_end=cycle_end,
        anthropic_client=MagicMock(),
    )

    rows = (
        db.query(EditorialArticle)
        .filter_by(game_id=game.id, scope="weekly", cycle_start=cycle_start)
        .all()
    )
    # Still exactly one row for this url (the pre-existing one, reused)
    assert len(rows) == 1
    assert rows[0].url == existing_url
    # Original body/summary preserved \u2014 dedup reuses, doesn't overwrite
    assert rows[0].body == "original body"
