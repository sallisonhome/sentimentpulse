"""Regression tests for the Reddit retry hardening introduced after the
2026-05-30 cron returned 0 Reddit posts silently.

Covers:
  - First-pass success (reddit_health='ok', no retries, success status)
  - First-pass 0 then retry recovers (degraded, success status)
  - All retries exhausted (failed, partial_failure status)
  - No games have subreddits configured (skipped, success status)
"""
import logging
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from models import Base, Game, Publisher


@pytest.fixture
def db_with_games():
    """Three active games: two with subreddits, one without."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    pub = Publisher(name="TestPub")
    session.add(pub)
    session.commit()
    games = [
        Game(publisher_id=pub.id, steam_app_id=1, name="GameA",
             is_active=True, subreddits=["GameASub"]),
        Game(publisher_id=pub.id, steam_app_id=2, name="GameB",
             is_active=True, subreddits=["GameBSub"]),
        Game(publisher_id=pub.id, steam_app_id=3, name="GameC",
             is_active=True, subreddits=[]),
    ]
    for g in games:
        session.add(g)
    session.commit()
    yield session
    session.close()


# Helpers: monkeypatch every dependency run_ingestion touches so we can drive
# its control flow purely through _step4_reddit.

def _patches_for(
    reddit_step_side_effect,
    *,
    steam_review_return=(1, 10),
    steam_forum_return=(1, 10),
    bluesky_return=(1, 10),
):
    """Build the patch context for run_ingestion.

    Defaults make Steam and Bluesky 'healthy' so they don't trigger
    partial_failure during Reddit-focused tests.  Override per-source
    return values to exercise specific scenarios.

    All source steps now return (saved, fetched) tuples.
    """
    return [
        patch("services.ingestor.SessionLocal", autospec=True),
        patch("services.ingestor.load_model", lambda: None),
        patch("services.ingestor.time.sleep", lambda _: None),  # skip backoffs
        patch("services.ingestor._step1_discover_games"),
        patch("services.ingestor._step2_steam_reviews", return_value=steam_review_return),
        patch("services.ingestor._step3_steam_forums", return_value=steam_forum_return),
        patch("services.ingestor._step4_reddit", side_effect=reddit_step_side_effect),
        patch("services.ingestor._step4b_bluesky", return_value=bluesky_return),
        patch("services.ingestor._step5_classify_sentiment"),
        patch("services.ingestor._step6_extract_topics"),
        patch("services.ingestor._step7_daily_summary"),
        patch("services.ingestor._step9_monthly_summaries"),
        patch("services.ingestor._step8_write_log"),
    ]


def _run_with(db_with_games, reddit_step_side_effect):
    from services import ingestor

    patches = _patches_for(reddit_step_side_effect)
    started = [p.start() for p in patches]
    try:
        # Wire SessionLocal so it returns our test db
        started[0].return_value = db_with_games
        # Wire _step1_discover_games to return our three games
        from sqlalchemy.orm import Session as _S
        started[3].return_value = db_with_games.query(Game).all()
        # Reset module state so prior tests don't leak in
        ingestor._status["is_running"] = False
        ingestor._status["reddit_health"] = "unknown"
        ingestor._status["reddit_retries"] = 0
        ingestor._status["reddit_fetched_total"] = 0
        return ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()


def test_first_pass_success(db_with_games):
    """Step 4 returns posts on first call -> ok / success."""
    def step4(db, game, log, errs):
        # Mirror real _step4_reddit's no-subreddits behaviour: return (0,0)
        # for games whose subreddits list is empty.
        if not game.subreddits:
            return (0, 0)
        return (5, 25)  # saved=5, fetched=25 for each eligible game
    result = _run_with(db_with_games, step4)
    assert result["reddit_health"] == "ok"
    assert result["reddit_retries"] == 0
    # 25 each from 2 eligible games
    assert result["reddit_fetched_total"] == 50
    assert result["status"] == "success"


def test_retry_recovers(db_with_games):
    """First pass returns 0; retry returns posts -> degraded / success."""
    # Tracks how many times we've been called per game so first pass returns
    # 0 for eligible games but retry returns posts.
    call_count_per_game: dict[int, int] = {}

    def step4(db, game, log, errs):
        if not game.subreddits:
            return (0, 0)  # Mirror real no-subreddits behaviour
        call_count_per_game[game.id] = call_count_per_game.get(game.id, 0) + 1
        if call_count_per_game[game.id] == 1:
            return (0, 0)  # First pass: nothing
        return (5, 25)     # Retry: success

    result = _run_with(db_with_games, step4)
    assert result["reddit_health"] == "degraded"
    assert result["reddit_retries"] == 1
    assert result["reddit_fetched_total"] == 50  # 2 eligible games * 25 on retry
    assert result["status"] == "success"


def test_all_retries_exhausted(db_with_games):
    """Every call returns 0 fetched -> failed / partial_failure."""
    def step4(db, game, log, errs):
        return (0, 0)  # Universal failure (even no-sub games matter not here)
    result = _run_with(db_with_games, step4)
    assert result["reddit_health"] == "failed"
    assert result["reddit_retries"] == 2  # both backoffs exhausted
    assert result["reddit_fetched_total"] == 0
    assert result["status"] == "partial_failure"


def test_no_eligible_games_marks_skipped(db_with_games):
    """If no game has subreddits configured -> reddit_health=skipped.

    Reddit alone returning skipped should NOT mark the run as partial_failure
    — status stays success because the other sources still ingested.
    """
    from services import ingestor
    no_sub_games = [g for g in db_with_games.query(Game).all() if not g.subreddits]
    assert len(no_sub_games) == 1

    patches = _patches_for(lambda *a: (0, 0))
    started = [p.start() for p in patches]
    try:
        started[0].return_value = db_with_games
        started[3].return_value = no_sub_games
        ingestor._status["is_running"] = False
        result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    assert result["reddit_health"] == "skipped"
    assert result["reddit_retries"] == 0
    assert result["status"] == "success"


# ── New tests for cross-source partial_failure hardening (2026-06-06) ─────────

def test_bluesky_failure_marks_partial_failure(db_with_games, monkeypatch):
    """If Bluesky returns 0 fetched across all games even after retries,
    the run must be marked partial_failure even when Reddit is healthy.
    Regression test for the 2026-06-06 silent failure."""
    # Bluesky eligibility requires creds env vars
    monkeypatch.setenv("BLUESKY_HANDLE", "test.bsky.social")
    monkeypatch.setenv("BLUESKY_APP_PASSWORD", "test-pw-test-pw")
    monkeypatch.delenv("BLUESKY_ENABLED", raising=False)

    def step4(db, game, log, errs):
        if not game.subreddits:
            return (0, 0)
        return (5, 25)  # Reddit healthy

    patches = _patches_for(
        step4,
        bluesky_return=(0, 0),   # Bluesky always returns 0 fetched
    )
    # Pin Bluesky auth-health helpers so the 2026-06-07 #2/#4 hardening
    # doesn't flip this test's expected verdict to 'auth_broken'.  We're
    # specifically testing the upstream-quiet failure mode here.
    patches.append(patch("services.bluesky_service.get_auth_health", return_value="ok"))
    patches.append(patch("services.bluesky_service.force_session_recreate", return_value=True))

    started = [p.start() for p in patches]
    try:
        from services import ingestor
        started[0].return_value = db_with_games
        started[3].return_value = db_with_games.query(Game).all()
        ingestor._status["is_running"] = False
        result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    assert result["reddit_health"] == "ok"
    assert result["bluesky_health"] == "failed"
    # Phase B uses up both backoff retries (2); auto-recovery adds 1 more.
    assert result["bluesky_retries"] == 3
    assert result["status"] == "partial_failure"


def test_steam_review_failure_marks_partial_failure(db_with_games):
    """If Steam reviews returns 0 fetched across all games, the run must
    be marked partial_failure even when other sources are healthy."""
    def step4(db, game, log, errs):
        if not game.subreddits:
            return (0, 0)
        return (5, 25)

    patches = _patches_for(
        step4,
        steam_review_return=(0, 0),  # Steam reviews silent
    )
    started = [p.start() for p in patches]
    try:
        from services import ingestor
        started[0].return_value = db_with_games
        started[3].return_value = db_with_games.query(Game).all()
        ingestor._status["is_running"] = False
        result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    assert result["steam_review_health"] == "failed"
    assert result["status"] == "partial_failure"


def test_bluesky_retry_recovers(db_with_games, monkeypatch):
    """First-pass Bluesky returns 0 but retry succeeds -> bluesky_health=degraded
    and overall status=success."""
    monkeypatch.setenv("BLUESKY_HANDLE", "test.bsky.social")
    monkeypatch.setenv("BLUESKY_APP_PASSWORD", "test-pw-test-pw")
    monkeypatch.delenv("BLUESKY_ENABLED", raising=False)

    call_count = {"n": 0}

    def bluesky_step(db, game, log, errs):
        call_count["n"] += 1
        # First 3 calls (one per game in Phase A) return 0; later calls (retry) succeed
        if call_count["n"] <= 3:
            return (0, 0)
        return (5, 25)

    def reddit_step(db, game, log, errs):
        if not game.subreddits:
            return (0, 0)
        return (5, 25)

    # Build patches manually so we can set side_effect on the bluesky one
    patches = [
        patch("services.ingestor.SessionLocal", autospec=True),
        patch("services.ingestor.load_model", lambda: None),
        patch("services.ingestor.time.sleep", lambda _: None),
        patch("services.ingestor._step1_discover_games"),
        patch("services.ingestor._step2_steam_reviews", return_value=(1, 10)),
        patch("services.ingestor._step3_steam_forums", return_value=(1, 10)),
        patch("services.ingestor._step4_reddit", side_effect=reddit_step),
        patch("services.ingestor._step4b_bluesky", side_effect=bluesky_step),
        patch("services.ingestor._step5_classify_sentiment"),
        patch("services.ingestor._step6_extract_topics"),
        patch("services.ingestor._step7_daily_summary"),
        patch("services.ingestor._step9_monthly_summaries"),
        patch("services.ingestor._step8_write_log"),
    ]
    started = [p.start() for p in patches]
    try:
        from services import ingestor
        started[0].return_value = db_with_games
        started[3].return_value = db_with_games.query(Game).all()
        ingestor._status["is_running"] = False
        result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    assert result["bluesky_health"] == "degraded"
    assert result["bluesky_retries"] == 1
    assert result["status"] == "success"
