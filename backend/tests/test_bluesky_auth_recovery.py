"""End-to-end tests for the ingestor's Bluesky auth-broken surfacing (#2)
and cron-end auto-recovery (#4) shipped 2026-06-07.

These run an entire ingest cycle with mocked source steps, then assert the
final _status dict and run-result reflect the new hardening behavior.
"""
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from models import Base, Game, Publisher


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    pub = Publisher(name="TestPub")
    s.add(pub)
    s.commit()
    g = Game(
        publisher_id=pub.id, steam_app_id=1, name="GameA",
        is_active=True, subreddits=["GameASub"],
    )
    s.add(g)
    s.commit()
    yield s, g
    s.close()


def _enable_bluesky(monkeypatch):
    monkeypatch.setenv("BLUESKY_HANDLE", "test.bsky.social")
    monkeypatch.setenv("BLUESKY_APP_PASSWORD", "app-pw-app-pw-app")
    monkeypatch.delenv("BLUESKY_ENABLED", raising=False)


def _common_run_patches(session, game, **step_overrides):
    """Returns a list of patcher objects.  Caller is responsible for start()/stop()."""
    from unittest.mock import patch as _p
    from services import ingestor

    patches = [
        _p("services.ingestor.SessionLocal", autospec=True),
        _p("services.ingestor.load_model", lambda: None),
        _p("services.ingestor.time.sleep", lambda _: None),
        _p("services.ingestor._step1_discover_games"),
        _p("services.ingestor._step2_steam_reviews",
           return_value=step_overrides.get("steam_review_return", (1, 10))),
        _p("services.ingestor._step3_steam_forums",
           return_value=step_overrides.get("steam_forum_return", (1, 10))),
        _p("services.ingestor._step4_reddit",
           return_value=step_overrides.get("reddit_return", (1, 10))),
        _p("services.ingestor._step4b_bluesky",
           side_effect=step_overrides.get("bluesky_side_effect", lambda *a, **k: (0, 0))),
        _p("services.ingestor._step5_classify_sentiment"),
        _p("services.ingestor._step6_extract_topics"),
        _p("services.ingestor._step7_daily_summary"),
        _p("services.ingestor._step9_monthly_summaries"),
        _p("services.ingestor._step8_write_log"),
        _p("services.ingestor._detect_silent_sources", return_value={}),
    ]
    started = [p.start() for p in patches]
    started[0].return_value = session
    started[3].return_value = [game]
    return patches, started


# ── #2 auth_broken surfacing ─────────────────────────────────────────────────

def test_ingestor_surfaces_bluesky_auth_broken(db_session, monkeypatch):
    """When bluesky_service.get_auth_health() returns 'refresh_failed', the
    ingestor must set bluesky_health='auth_broken' (not 'failed') and the
    run must end as partial_failure."""
    session, game = db_session
    _enable_bluesky(monkeypatch)

    from services import ingestor

    patches, _ = _common_run_patches(
        session, game,
        bluesky_side_effect=lambda *a, **k: (0, 0),  # 0 fetches
    )
    try:
        with patch("services.bluesky_service.get_auth_health",
                   return_value="refresh_failed"), \
             patch("services.bluesky_service.force_session_recreate",
                   return_value=False):
            ingestor._status["is_running"] = False
            result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    assert result["bluesky_health"] == "auth_broken"
    assert result["status"] == "partial_failure"


def test_ingestor_keeps_failed_when_auth_health_is_ok(db_session, monkeypatch):
    """auth_health='ok' but fetched=0 → keep 'failed' (not auth_broken)."""
    session, game = db_session
    _enable_bluesky(monkeypatch)

    from services import ingestor

    patches, _ = _common_run_patches(
        session, game,
        bluesky_side_effect=lambda *a, **k: (0, 0),
    )
    try:
        # auth_health='ok' means creds aren't the problem; force_recreate
        # also returns no posts, so verdict stays 'failed'.
        with patch("services.bluesky_service.get_auth_health", return_value="ok"), \
             patch("services.bluesky_service.force_session_recreate",
                   return_value=True):
            ingestor._status["is_running"] = False
            result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    assert result["bluesky_health"] == "failed"
    assert result["status"] == "partial_failure"


# ── #4 cron-end auto-recovery ────────────────────────────────────────────────

def test_auto_recovery_runs_and_recovers_bluesky(db_session, monkeypatch):
    """When bluesky_health=failed, auto-recovery must call force_session_recreate
    and re-run _step4b_bluesky for every active game.  If the retry succeeds,
    bluesky_health must flip from 'failed' to 'degraded' (retries>0)."""
    session, game = db_session
    _enable_bluesky(monkeypatch)

    from services import ingestor

    # Phase B fires 1 initial call + 2 backoff retries = 3 calls, all (0,0).
    # Auto-recovery then fires 1 call per active game = 1 call, returning (5,20).
    # Total: 4 calls.
    call_count = {"n": 0}
    def step4b_side(*args, **kwargs):
        call_count["n"] += 1
        # Recovery is the 4th call (after 3 zero-result calls in Phase B)
        if call_count["n"] < 4:
            return (0, 0)
        return (5, 20)

    patches, _ = _common_run_patches(
        session, game, bluesky_side_effect=step4b_side,
    )
    try:
        with patch("services.bluesky_service.get_auth_health", return_value="ok"), \
             patch("services.bluesky_service.force_session_recreate",
                   return_value=True) as mock_force:
            ingestor._status["is_running"] = False
            result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    # force_recreate was called exactly once during auto-recovery
    assert mock_force.call_count == 1
    # Phase B (initial + 2 backoff retries) + auto-recovery pass = 4 calls
    assert call_count["n"] == 4
    # Recovery succeeded → degraded (retries>0) rather than failed
    assert result["bluesky_health"] == "degraded"
    assert result["bluesky_fetched_total"] == 20


def test_auto_recovery_skipped_when_already_auth_broken(db_session, monkeypatch):
    """Auto-recovery must NOT run when bluesky_health is already auth_broken —\
    creds are bad, more retries won't help."""
    session, game = db_session
    _enable_bluesky(monkeypatch)

    from services import ingestor

    call_count = {"n": 0}
    def step4b_side(*args, **kwargs):
        call_count["n"] += 1
        return (0, 0)

    patches, _ = _common_run_patches(
        session, game, bluesky_side_effect=step4b_side,
    )
    try:
        with patch("services.bluesky_service.get_auth_health",
                   return_value="refresh_failed"), \
             patch("services.bluesky_service.force_session_recreate",
                   return_value=True) as mock_force:
            ingestor._status["is_running"] = False
            result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    # Auth health surfaces, auto-recovery is skipped
    assert result["bluesky_health"] == "auth_broken"
    assert mock_force.call_count == 0
    # Phase B ran 3 times (initial + 2 backoff retries), but auto-recovery
    # is skipped because health is already auth_broken — so no 4th call.
    assert call_count["n"] == 3


def test_auto_recovery_marks_auth_broken_when_force_recreate_fails(db_session, monkeypatch):
    """If force_session_recreate() returns False during auto-recovery, the\n    final bluesky_health must flip to 'auth_broken' so the operator gets a\n    clear signal that creds need rotation."""
    session, game = db_session
    _enable_bluesky(monkeypatch)

    from services import ingestor

    patches, _ = _common_run_patches(
        session, game, bluesky_side_effect=lambda *a, **k: (0, 0),
    )
    try:
        # Initial auth_health='ok' (not yet broken), but force_recreate fails
        with patch("services.bluesky_service.get_auth_health", return_value="ok"), \
             patch("services.bluesky_service.force_session_recreate",
                   return_value=False):
            ingestor._status["is_running"] = False
            result = ingestor.run_ingestion()
    finally:
        for p in patches:
            p.stop()

    assert result["bluesky_health"] == "auth_broken"
    assert result["status"] == "partial_failure"
