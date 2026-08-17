"""
Regression tests for services.new_game_onboarding.

The v2 (2026-08-17) fix addressed two bugs that were silently degrading
every child/competitor title added to SentimentPulse:

  Bug 1 — Steam Reviews were never backfilled during onboarding. Fixed
          by calling backfill_steam_reviews_for_game alongside the
          Forums backfill inside _run_onboarding_backfill.

  Bug 2 — A crashed onboarding thread left the game_id permanently in
          the in-memory _ONBOARDING_INFLIGHT set, silently blocking any
          future retry. Fixed by making the guard time-bounded.

The v3 (2026-08-17 evening) fix addressed the analogous Reddit omission:

  Bug 3 — Reddit backfill was never invoked during onboarding, so any
          game with a `subreddits` list had zero historical reddit data
          until the daily cron slowly accreted ~100 posts/sub/day.
          Fixed by calling backfill_reddit_for_game after the Steam pair.

These tests lock all three fixes in place so a future refactor can't
remove the Reviews/Reddit calls or revert the guard to a bare set. They
intentionally mock at the boundary layer (the three backfill helpers,
sentiment/topics/daily-summary steps, and the DB session) so we don't
hit the real Steam / Arctic Shift APIs or open a real SQLite session.
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock, patch


def _install_common_mocks(stack, *, subreddits=None):
    """
    Wire up the imports that _run_onboarding_backfill uses. Returns a
    dict with the three backfill mocks so tests can assert on call counts.

    `subreddits` argument controls whether the fake game has a reddit
    config — default is a non-empty list (mirrors game 147/148 in prod).
    Pass `subreddits=[]` to exercise the "skip reddit backfill" branch.
    """
    if subreddits is None:
        subreddits = ["insurgency", "InsurgencySandstorm", "Saberinteractive"]

    # Fake game — id + steam_app_id + subreddits are all the code path reads.
    # v3 (2026-08-17 evening): subreddits attribute now matters because
    # _run_onboarding_backfill guards the reddit call on `if game.subreddits`.
    fake_game = MagicMock(
        id=999,
        steam_app_id=581320,
        name="Insurgency: Sandstorm",
        subreddits=subreddits,
    )

    # DB session mock: SessionLocal() returns something whose .query(...)
    # .filter_by(...).first() returns the fake_game.
    fake_session = MagicMock()
    fake_session.query.return_value.filter_by.return_value.first.return_value = fake_game

    stack.enter_context(patch("database.SessionLocal", return_value=fake_session))

    # All three backfill helpers return an int (rows saved). We patch on the
    # scripts.historical_backfill module because that's where
    # new_game_onboarding imports them from (see the local imports inside
    # _run_onboarding_backfill).
    forums_mock = MagicMock(return_value=42)
    reviews_mock = MagicMock(return_value=17)
    reddit_mock = MagicMock(return_value=203)
    stack.enter_context(patch(
        "scripts.historical_backfill.backfill_steam_forums_for_game", forums_mock,
    ))
    stack.enter_context(patch(
        "scripts.historical_backfill.backfill_steam_reviews_for_game", reviews_mock,
    ))
    stack.enter_context(patch(
        "scripts.historical_backfill.backfill_reddit_for_game", reddit_mock,
    ))

    # Skip the sentiment/topics/daily-summary steps — they need a real
    # NLP model. We're only testing the orchestrator here.
    stack.enter_context(patch(
        "services.ingestor._step5_classify_sentiment", MagicMock(),
    ))
    stack.enter_context(patch(
        "services.ingestor._step6_extract_topics", MagicMock(),
    ))
    stack.enter_context(patch(
        "services.ingestor._step7_daily_summary", MagicMock(),
    ))
    stack.enter_context(patch(
        "services.nlp_service.load_model", MagicMock(),
    ))

    return {
        "forums": forums_mock,
        "reviews": reviews_mock,
        "reddit": reddit_mock,
        "game": fake_game,
    }


def test_v2_backfills_both_steam_forums_AND_steam_reviews():
    """
    Bug 1 regression: prior to v2 (2026-08-17), _run_onboarding_backfill
    only invoked backfill_steam_forums_for_game. Reviews were silently
    skipped, so every competitor/child game added had 0 Steam review
    rows in perpetuity. This test asserts BOTH helpers get called
    exactly once per onboarding.
    """
    from contextlib import ExitStack
    from services.new_game_onboarding import _run_onboarding_backfill

    with ExitStack() as stack:
        mocks = _install_common_mocks(stack)
        _run_onboarding_backfill(game_id=999, days_back=90)

        assert mocks["forums"].call_count == 1, (
            "backfill_steam_forums_for_game must be called exactly once during onboarding"
        )
        assert mocks["reviews"].call_count == 1, (
            "v2 (2026-08-17) fix: backfill_steam_reviews_for_game MUST be called "
            "during onboarding — before this fix it was silently omitted and every "
            "newly-added game had 0 Steam review rows."
        )


def test_v3_backfills_reddit_when_game_has_subreddits():
    """
    Bug 3 regression: prior to v3 (2026-08-17 evening),
    _run_onboarding_backfill only invoked the two Steam helpers. Reddit
    was silently skipped, so any game with a configured `subreddits` list
    had 0 historical reddit rows until the daily cron slowly accreted
    them. WWZ (147) and Insurgency (148) both had 0 reddit rows after
    a full 90-day reonboard verified against the live droplet on
    2026-08-17. This test asserts backfill_reddit_for_game gets called.

    It also verifies that start_epoch is passed as an int (seconds since
    epoch), not a datetime — the historical_backfill.py helper's
    signature requires an int, and passing a datetime would raise
    TypeError only when the function actually paged the network.
    """
    from contextlib import ExitStack
    from services.new_game_onboarding import _run_onboarding_backfill

    with ExitStack() as stack:
        mocks = _install_common_mocks(stack)
        _run_onboarding_backfill(game_id=999, days_back=365)

        assert mocks["reddit"].call_count == 1, (
            "v3 (2026-08-17 evening) fix: backfill_reddit_for_game MUST be called "
            "during onboarding when the game has a subreddits list — before this "
            "fix reddit was silently omitted and every game had 0 historical reddit "
            "rows."
        )

        # Verify start_epoch is an int (matches backfill_reddit_for_game's
        # signature: start_epoch: int). If we accidentally passed the
        # datetime, this would silently fail at network-call time.
        args, kwargs = mocks["reddit"].call_args
        # Signature: (db, game, start_epoch, errors) — positional order.
        assert len(args) >= 3, (
            "backfill_reddit_for_game must be called positionally with at least "
            f"(db, game, start_epoch, errors) — got args={args}, kwargs={kwargs}"
        )
        start_epoch = args[2]
        assert isinstance(start_epoch, int), (
            f"start_epoch must be int (seconds), got {type(start_epoch).__name__}={start_epoch!r}. "
            "backfill_reddit_for_game's signature is (db, game, start_epoch: int, errors) — "
            "passing a datetime would crash at page-request time."
        )
        # Sanity: the epoch for 365 days back should be well before "now"
        # and well after 2020 (unless someone's system clock is very wrong).
        import time as _time
        now = int(_time.time())
        assert start_epoch < now, (
            f"start_epoch ({start_epoch}) should be in the past; now={now}"
        )
        # 365 days = ~31.5M seconds; give some slop for slow test envs.
        expected_min_delta = 365 * 24 * 3600 - 60
        assert (now - start_epoch) >= expected_min_delta, (
            f"start_epoch should be ~365 days before now for days_back=365; "
            f"delta was {now - start_epoch}s (expected ≥ {expected_min_delta}s)."
        )


def test_v3_skips_reddit_backfill_when_game_has_no_subreddits():
    """
    Guard the empty-subreddits path: some games (DLC entries, cosmetic
    packs, portfolio watchlist entries added without reddit config) have
    an empty or null subreddits list. The onboarding code short-circuits
    the reddit call in that case with an INFO log — without this guard,
    backfill_reddit_for_game would still be called and log a warning of
    its own, cluttering logs and wasting a redundant no-op DB commit.
    """
    from contextlib import ExitStack
    from services.new_game_onboarding import _run_onboarding_backfill

    with ExitStack() as stack:
        mocks = _install_common_mocks(stack, subreddits=[])
        _run_onboarding_backfill(game_id=999, days_back=90)

        assert mocks["reddit"].call_count == 0, (
            "Reddit backfill must be skipped when game.subreddits is empty — "
            "otherwise onboarding wastes a network call and logs a redundant "
            "warning from inside backfill_reddit_for_game."
        )
        # Steam still runs — the guard is scoped to reddit only.
        assert mocks["forums"].call_count == 1
        assert mocks["reviews"].call_count == 1


def test_stale_inflight_entry_does_not_block_a_new_run():
    """
    Bug 2 regression: prior to v2, _ONBOARDING_INFLIGHT was a bare set
    and a crashed thread (deploy killed mid-scrape, uncaught exception)
    left the game_id permanently in the set. Every future POST /games
    or POST /competitors call for that game silently returned False
    and the game stayed with 0 Steam data forever.

    v2 stores a timestamp and lets a fresh call through once the entry
    is older than MAX_ONBOARDING_SECS. This test injects an ancient
    entry and confirms the next schedule_onboarding_backfill call
    reclaims it.
    """
    import services.new_game_onboarding as ngo

    game_id = 9997
    # Inject a stale entry (older than the guard budget — 90 min as of v3).
    with ngo._LOCK:
        ngo._ONBOARDING_INFLIGHT[game_id] = time.time() - (ngo.MAX_ONBOARDING_SECS + 60)

    # Patch out the thread spawn so we don't actually run a background
    # scrape during the test — we're only verifying the guard logic.
    with patch("services.new_game_onboarding.threading.Thread") as thread_mock:
        thread_instance = MagicMock()
        thread_mock.return_value = thread_instance

        scheduled = ngo.schedule_onboarding_backfill(game_id)

        assert scheduled is True, (
            "v2 fix: a stale in-flight entry (older than MAX_ONBOARDING_SECS) "
            "MUST allow a new onboarding to be scheduled — otherwise a crashed "
            "thread leaves the game permanently stuck at 0 Steam data."
        )
        thread_instance.start.assert_called_once()

    # Cleanup so the next test isn't polluted.
    with ngo._LOCK:
        ngo._ONBOARDING_INFLIGHT.pop(game_id, None)


def test_fresh_inflight_entry_still_blocks_concurrent_run():
    """
    Companion to the stale-entry test: a RECENT entry (less than the
    budget) must still block a concurrent schedule call so we don't
    spawn two parallel scrapes for the same game.
    """
    import services.new_game_onboarding as ngo

    game_id = 9998
    with ngo._LOCK:
        ngo._ONBOARDING_INFLIGHT[game_id] = time.time()   # brand new

    with patch("services.new_game_onboarding.threading.Thread") as thread_mock:
        scheduled = ngo.schedule_onboarding_backfill(game_id)

        assert scheduled is False, (
            "A fresh in-flight entry must block a concurrent onboarding call — "
            "otherwise we'd spawn parallel scrapes for the same game and rate-limit "
            "ourselves against Steam."
        )
        thread_mock.assert_not_called()

    with ngo._LOCK:
        ngo._ONBOARDING_INFLIGHT.pop(game_id, None)
