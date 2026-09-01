"""
Shared pytest fixtures for SentimentPulse backend tests.

Uses an in-memory SQLite database and patches out the expensive startup
operations (NLP model loading, APScheduler) so tests run fast.

Each test gets a fresh in-memory database (function-scoped engine + session)
to avoid UNIQUE-constraint bleed-through between tests that call db.commit().
"""
from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


# ── Ensure models are registered once ─────────────────────────────────────────

@pytest.fixture(scope="session", autouse=True)
def _register_models():
    """Import models once per session so Base.metadata knows about all tables."""
    import models  # noqa: F401


# ── Reset Bluesky session singleton between tests ────────────────────────
# The Bluesky service uses a module-level _session singleton.  Tests that
# touch authentication (proactive refresh, force_recreate, ingestor end-to-end)
# can leave it in a 'refresh_failed' state, which then poisons subsequent
# ingestor tests that read get_auth_health().  An autouse fixture resets the
# singleton before every test so each test starts from a clean slate.
@pytest.fixture(autouse=True)
def _reset_bluesky_session_singleton():
    try:
        import services.bluesky_service as _bsvc
        _bsvc._session = None
    except Exception:
        pass
    yield


# ── Per-test engine factory ────────────────────────────────────────────────────

def _make_test_engine():
    return create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


# ── Per-test DB session ────────────────────────────────────────────────────────

@pytest.fixture()
def db():
    from database import Base
    engine = _make_test_engine()
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = session_factory()
    yield session
    session.close()
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


# ── FastAPI TestClient with patched lifespan ───────────────────────────────────

@pytest.fixture()
def client(db):
    from database import get_db
    from main import app

    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db

    mock_scheduler = MagicMock()
    mock_scheduler.start    = MagicMock()
    mock_scheduler.shutdown = MagicMock()

    # v0030 (2026-09-01): main.py's lifespan uses main.SessionLocal directly
    # (not FastAPI's get_db dependency) for the startup keyword-check and
    # publisher-seed logic. Without patching, it talks to the local dev DB
    # file which may lack columns like games.distinctive_keywords and
    # produces spurious "Startup keyword check failed" errors that cascade
    # into 404s. Point SessionLocal at the same in-memory engine the test
    # is using so lifespan sees a fully-migrated schema.
    def override_session_local():
        # Return a Session bound to the test's in-memory engine.
        return db.get_bind()  # unused — SessionLocal is a callable

    from sqlalchemy.orm import sessionmaker
    test_session_local = sessionmaker(
        autocommit=False, autoflush=False, bind=db.get_bind()
    )

    with (
        patch("main.load_model"),
        patch("main.create_scheduler", return_value=mock_scheduler),
        patch("main.Base.metadata.create_all"),   # don't touch the prod DB file
        patch("main.SessionLocal", test_session_local),
    ):
        with TestClient(app, raise_server_exceptions=True) as c:
            yield c

    app.dependency_overrides.clear()


# ── Seed-data fixtures ─────────────────────────────────────────────────────────

@pytest.fixture()
def publisher(db):
    from models import Publisher
    p = Publisher(name="Acme Games")
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@pytest.fixture()
def game(db, publisher):
    from models import Game
    g = Game(
        publisher_id=publisher.id,
        steam_app_id=12345,
        name="Test Game",
        release_date=date(2023, 1, 1),
        is_active=True,
        subreddits=["testgame"],
    )
    db.add(g)
    db.commit()
    db.refresh(g)
    return g


@pytest.fixture()
def raw_post(db, game):
    from models import RawPost, SourceEnum
    post = RawPost(
        game_id=game.id,
        source=SourceEnum.steam_review,
        external_id="review_001",
        author="alice",
        title="Great game!",
        body="Really enjoyed the gameplay.",
        url="https://store.steampowered.com/app/12345/#review_001",
        upvotes=10,
        collected_at=datetime.utcnow(),
        post_date=datetime.utcnow(),
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    return post


@pytest.fixture()
def sentiment_record(db, raw_post):
    from models import SentimentRecord, SentimentEnum
    sr = SentimentRecord(
        raw_post_id=raw_post.id,
        sentiment=SentimentEnum.positive,
        sentiment_score=0.92,
        topics=["gameplay", "graphics"],
    )
    db.add(sr)
    db.commit()
    db.refresh(sr)
    return sr


@pytest.fixture()
def daily_summary(db, game):
    from models import DailySummary
    s = DailySummary(
        game_id=game.id,
        summary_date=date.today(),
        positive_count=80,
        negative_count=10,
        neutral_count=10,
        top_positive_topics=["gameplay", "graphics"],
        top_negative_topics=["bugs", "performance"],
        top_neutral_topics=["updates"],
        sentiment_trend_delta=0.05,
        executive_summary="Overall sentiment is positive.",
        recommended_actions="- Keep updating the game.",
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


@pytest.fixture()
def topic_trend(db, game):
    from models import TopicTrend, SentimentEnum, TrendDirectionEnum
    t = TopicTrend(
        game_id=game.id,
        topic_label="gameplay",
        sentiment=SentimentEnum.positive,
        first_seen=date.today(),
        last_seen=date.today(),
        mention_count=42,
        trend_direction=TrendDirectionEnum.rising,
        velocity=3.5,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return t
