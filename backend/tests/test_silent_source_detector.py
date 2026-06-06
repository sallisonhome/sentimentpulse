"""Regression tests for the silent-source detector (Gap 3).

Catches the silent-failure pattern where a source's fetch counters look
healthy (fetched > 0) but persistence collapses — the 2026-05-30 Reddit
and 2026-06-06 Bluesky bugs.  CLAUDE.md §19: ground truth is the
user-facing row count, not in-memory counters.

The detector reads `raw_posts.collected_at` and compares the last-24h
row count to the prior-7d daily average.  When today is < 10% of the
baseline AND the baseline is ≥ 5/day, the source is flagged 'silent'.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from models import Base, Game, Publisher, RawPost, SourceEnum


@pytest.fixture
def db_with_history():
    """Empty in-memory DB; tests seed RawPost rows as needed."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    pub = Publisher(name="TestPub")
    session.add(pub)
    session.commit()
    game = Game(
        publisher_id=pub.id, steam_app_id=1, name="GameA",
        is_active=True, subreddits=["GameASub"],
    )
    session.add(game)
    session.commit()
    yield session, game
    session.close()


def _seed_posts(session, game_id, source, count, collected_at):
    """Insert `count` RawPost rows for the given source at collected_at."""
    for i in range(count):
        session.add(RawPost(
            game_id=game_id,
            source=source,
            external_id=f"{source.value}-{collected_at.isoformat()}-{i}",
            title=f"post {i}",
            body="body",
            url=f"https://example.com/{i}",
            upvotes=0,
            collected_at=collected_at,
            post_date=collected_at,
        ))
    session.commit()


def test_silent_source_detected_when_today_drops_90_percent(db_with_history):
    """7-day baseline of 70 posts (10/day avg); today=0 → silent."""
    from services.ingestor import _detect_silent_sources
    session, game = db_with_history
    now = datetime.now(timezone.utc)
    # Seed 7 days of history: 10 posts/day for the past 7 days
    for d in range(1, 8):
        _seed_posts(
            session, game.id, SourceEnum.reddit, 10,
            now - timedelta(days=d, hours=12),
        )
    # Today: 0 posts in the last 24h

    log: list[str] = []
    result = _detect_silent_sources(session, log)
    assert result["reddit"] is True
    assert result["bluesky"] is False  # no history at all
    assert any("reddit" in line and "SILENT" in line for line in log)


def test_healthy_source_not_flagged(db_with_history):
    """Baseline 10/day, today=10 → not silent."""
    from services.ingestor import _detect_silent_sources
    session, game = db_with_history
    now = datetime.now(timezone.utc)
    for d in range(1, 8):
        _seed_posts(
            session, game.id, SourceEnum.reddit, 10,
            now - timedelta(days=d, hours=12),
        )
    # Today: 10 posts within the last 24h
    _seed_posts(
        session, game.id, SourceEnum.reddit, 10,
        now - timedelta(hours=2),
    )

    log: list[str] = []
    result = _detect_silent_sources(session, log)
    assert result["reddit"] is False


def test_low_baseline_skipped(db_with_history):
    """Baseline < 5/day → detector skips (avoids quiet-source false positives)."""
    from services.ingestor import _detect_silent_sources
    session, game = db_with_history
    now = datetime.now(timezone.utc)
    # Only 14 posts over 7 days = 2/day (below MIN_BASELINE=5)
    for d in range(1, 8):
        _seed_posts(
            session, game.id, SourceEnum.reddit, 2,
            now - timedelta(days=d, hours=12),
        )
    # Today: 0
    log: list[str] = []
    result = _detect_silent_sources(session, log)
    assert result["reddit"] is False
    assert any("baseline" in line and "skipped" in line for line in log)


def test_partial_drop_not_silent(db_with_history):
    """Baseline 10/day, today=5 (50% drop) → not silent (threshold is 90%)."""
    from services.ingestor import _detect_silent_sources
    session, game = db_with_history
    now = datetime.now(timezone.utc)
    for d in range(1, 8):
        _seed_posts(
            session, game.id, SourceEnum.reddit, 10,
            now - timedelta(days=d, hours=12),
        )
    _seed_posts(
        session, game.id, SourceEnum.reddit, 5,
        now - timedelta(hours=2),
    )

    log: list[str] = []
    result = _detect_silent_sources(session, log)
    assert result["reddit"] is False


def test_multiple_sources_independent(db_with_history):
    """Reddit silent, Bluesky healthy — detector reports per-source verdicts."""
    from services.ingestor import _detect_silent_sources
    session, game = db_with_history
    now = datetime.now(timezone.utc)
    # Reddit: 7d baseline of 10/day, today 0 → SILENT
    for d in range(1, 8):
        _seed_posts(
            session, game.id, SourceEnum.reddit, 10,
            now - timedelta(days=d, hours=12),
        )
    # Bluesky: 7d baseline of 10/day, today healthy
    for d in range(1, 8):
        _seed_posts(
            session, game.id, SourceEnum.bluesky, 10,
            now - timedelta(days=d, hours=12),
        )
    _seed_posts(
        session, game.id, SourceEnum.bluesky, 10,
        now - timedelta(hours=2),
    )

    log: list[str] = []
    result = _detect_silent_sources(session, log)
    assert result["reddit"] is True
    assert result["bluesky"] is False


def test_silent_overrides_ok_to_silent_in_run(db_with_history, monkeypatch):
    """End-to-end: when run_ingestion completes with all sources 'ok' but the
    silent detector flags Reddit, the run status must be 'partial_failure'
    and reddit_health must be 'silent'."""
    from unittest.mock import patch
    from services import ingestor

    session, game = db_with_history
    now = datetime.now(timezone.utc)
    # Seed a 7-day baseline of 20 reddit/day, but today 0
    for d in range(1, 8):
        _seed_posts(
            session, game.id, SourceEnum.reddit, 20,
            now - timedelta(days=d, hours=12),
        )

    monkeypatch.setenv("BLUESKY_HANDLE", "test.bsky.social")
    monkeypatch.setenv("BLUESKY_APP_PASSWORD", "test-pw-test-pw")
    monkeypatch.delenv("BLUESKY_ENABLED", raising=False)

    def reddit_ok(db, g, log, errs):
        # Pretend Reddit fetched fine — counters green, but the detector
        # will see today=0 in the DB and flip the verdict to 'silent'.
        if not g.subreddits:
            return (0, 0)
        return (5, 25)

    patches = [
        patch("services.ingestor.SessionLocal", autospec=True),
        patch("services.ingestor.load_model", lambda: None),
        patch("services.ingestor.time.sleep", lambda _: None),
        patch("services.ingestor._step1_discover_games"),
        patch("services.ingestor._step2_steam_reviews", return_value=(1, 10)),
        patch("services.ingestor._step3_steam_forums", return_value=(1, 10)),
        patch("services.ingestor._step4_reddit", side_effect=reddit_ok),
        patch("services.ingestor._step4b_bluesky", return_value=(1, 10)),
        patch("services.ingestor._step5_classify_sentiment"),
        patch("services.ingestor._step6_extract_topics"),
        patch("services.ingestor._step7_daily_summary"),
        patch("services.ingestor._step9_monthly_summaries"),
        patch("services.ingestor._step8_write_log"),
    ]
    started = [p.start() for p in patches]
    try:
        started[0].return_value = session
        started[3].return_value = [game]
        ingestor._status["is_running"] = False
        result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    assert result["reddit_health"] == "silent"
    assert result["status"] == "partial_failure"


def test_detector_exception_does_not_break_run():
    """If the detector throws, the run continues and the source is not flagged.
    Uses a stub db whose .query() raises on every call."""
    from services.ingestor import _detect_silent_sources

    class BrokenDB:
        def query(self, *args, **kwargs):
            raise RuntimeError("db is busted")

    log: list[str] = []
    result = _detect_silent_sources(BrokenDB(), log)
    # All sources should be False (not silent) and run continues
    assert result["reddit"] is False
    assert result["bluesky"] is False
    assert result["steam_review"] is False
    assert result["steam_forum"] is False
    assert any("detector error" in line for line in log)
