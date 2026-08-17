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

These tests lock both fixes in place so a future refactor can't remove
the Reviews call or revert the guard to a bare set. They intentionally
mock at the boundary layer (the two backfill helpers, sentiment/topics/
daily-summary steps, and the DB session) so we don't hit the real
Steam API or open a real SQLite session.
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock, patch


def _install_common_mocks(stack):
    """
    Wire up the imports that _run_onboarding_backfill uses. Returns a
    dict with the two backfill mocks so tests can assert on call counts.
    """
    # Fake game — id + steam_app_id are all the code path reads.
    fake_game = MagicMock(id=999, steam_app_id=581320, name="Insurgency: Sandstorm")

    # DB session mock: SessionLocal() returns something whose .query(...)
    # .filter_by(...).first() returns the fake_game.
    fake_session = MagicMock()
    fake_session.query.return_value.filter_by.return_value.first.return_value = fake_game

    stack.enter_context(patch("database.SessionLocal", return_value=fake_session))

    # Both backfill helpers return an int (rows saved). We patch on the
    # scripts.historical_backfill module because that's where
    # new_game_onboarding imports them from (see the local imports inside
    # _run_onboarding_backfill).
    forums_mock = MagicMock(return_value=42)
    reviews_mock = MagicMock(return_value=17)
    stack.enter_context(patch(
        "scripts.historical_backfill.backfill_steam_forums_for_game", forums_mock,
    ))
    stack.enter_context(patch(
        "scripts.historical_backfill.backfill_steam_reviews_for_game", reviews_mock,
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

    return {"forums": forums_mock, "reviews": reviews_mock, "game": fake_game}


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
    # Inject a stale entry (older than the 30-minute budget).
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
