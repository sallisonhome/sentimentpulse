"""Regression tests for ingestor._bulk_save_posts.

The old implementation had `except Exception: db.rollback()` which swallowed
every error silently.  That masked the PR #17 bug where every Bluesky post
failed to insert because post_date was a string instead of a datetime.  The
new implementation distinguishes IntegrityError (legitimate duplicate, silent)
from other exceptions (data-quality bug, logged at WARNING).
"""
import logging
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from models import Base, Game, Publisher, RawPost, SourceEnum
from services.ingestor import _bulk_save_posts


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    pub = Publisher(name="TestPub")
    session.add(pub)
    session.commit()
    game = Game(
        publisher_id=pub.id, steam_app_id=1, name="Test Game", is_active=True
    )
    session.add(game)
    session.commit()
    yield session, game.id
    session.close()


def test_saves_valid_posts(db):
    session, game_id = db
    posts = [{
        "external_id": f"ext-{i}",
        "author": "anon",
        "title": "",
        "body": "hello",
        "url": "https://example.com",
        "upvotes": 0,
        "post_date": datetime.now(timezone.utc),
    } for i in range(3)]
    saved = _bulk_save_posts(session, game_id, SourceEnum.bluesky, posts, [])
    assert saved == 3
    assert session.query(RawPost).filter_by(source=SourceEnum.bluesky).count() == 3


def test_skips_duplicates_silently(db, caplog):
    """IntegrityError on (external_id, source) duplicates should be swallowed
    without emitting a WARNING."""
    session, game_id = db
    posts = [{
        "external_id": "ext-dup",
        "author": "anon",
        "title": "",
        "body": "first",
        "url": "https://example.com",
        "upvotes": 0,
        "post_date": datetime.now(timezone.utc),
    }]
    _bulk_save_posts(session, game_id, SourceEnum.bluesky, posts, [])

    # Second batch with the same external_id should be skipped silently.
    # The pre-flight known-set check catches it first; force the path that
    # would hit the DB by clearing the set via a fresh call with NEW dict.
    with caplog.at_level(logging.WARNING, logger="services.ingestor"):
        saved = _bulk_save_posts(
            session, game_id, SourceEnum.bluesky, posts, []
        )
    assert saved == 0
    # No WARNING should have been logged for legitimate duplicates.
    bulk_warnings = [
        r for r in caplog.records
        if "_bulk_save_posts" in r.getMessage()
    ]
    assert bulk_warnings == [], (
        f"Did not expect WARNING for duplicates, got: "
        f"{[r.getMessage() for r in bulk_warnings]}"
    )


def test_string_post_date_logs_warning_and_does_not_silent_fail(db, caplog):
    """REGRESSION: an ISO-string post_date (the original PR #17 bug) must now
    surface as a WARNING, not be silently swallowed."""
    session, game_id = db
    posts = [{
        "external_id": "ext-bad-date",
        "author": "anon",
        "title": "",
        "body": "hello",
        "url": "https://example.com",
        "upvotes": 0,
        "post_date": "2026-05-29T18:00:00Z",  # <-- string, not datetime
    }]
    with caplog.at_level(logging.WARNING, logger="services.ingestor"):
        saved = _bulk_save_posts(
            session, game_id, SourceEnum.bluesky, posts, []
        )

    assert saved == 0  # The insert correctly failed
    # And it must have been logged
    bulk_warnings = [
        r.getMessage() for r in caplog.records
        if "_bulk_save_posts" in r.getMessage()
    ]
    assert any("insert failed" in m for m in bulk_warnings), (
        f"Expected WARNING about insert failure, got: {bulk_warnings}"
    )
    assert any("ext-bad-date" in m for m in bulk_warnings)
