"""
Tests for source_cursor_service (v0018, 2026-08-19).

Covers:
  * read_cursor returns None on first lookup
  * write_cursor creates a row, subsequent reads return the epoch
  * write_cursor uses MAX() semantics (older epoch is a no-op)
  * write_cursor rejects non-positive epochs
  * write_cursor is a no-op inside backfill_suppress_cursor_updates()
  * subreddit scope_key is normalized (lowercased, r/ stripped)
  * source-scoped cursor (empty scope_key) is distinct from subreddit-scoped
  * compute_after_epoch: returns cursor - 48h buffer when set
  * compute_after_epoch: returns now - 48h when cursor is None
  * compute_after_epoch: clamps at 0 to avoid negative epochs
  * epoch_from_post_dict handles datetime + int + missing
  * newest_epoch_from_posts on empty / mixed / single-post lists
  * backfill_suppress_cursor_updates: nested contexts don't leak
  * backfill_suppress_cursor_updates: cursor writes resume after exit
"""

import time
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import Publisher, Game
from services.source_cursor_service import (
    read_cursor,
    write_cursor,
    compute_after_epoch,
    backfill_suppress_cursor_updates,
    epoch_from_post_dict,
    newest_epoch_from_posts,
    CURSOR_OVERLAP_BUFFER_S,
    DEFAULT_FALLBACK_DAYS,
    _is_backfill_active,
)


@pytest.fixture
def db():
    """Fresh in-memory SQLite with schema for each test."""
    eng = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng, future=True)
    s = Session()
    # Minimum game row so cursor FK is satisfied
    pub = Publisher(name="TestCo")
    s.add(pub)
    s.commit()
    game = Game(name="TestGame", publisher_id=pub.id, steam_app_id=1)
    s.add(game)
    s.commit()
    s._test_game_id = game.id  # attach for tests
    yield s
    s.close()


# ----- read_cursor / write_cursor basics ---------------------------------

def test_read_cursor_returns_none_when_absent(db):
    assert read_cursor(db, db._test_game_id, "reddit", "gaming") is None


def test_write_then_read_returns_epoch(db):
    epoch = 1_700_000_000
    write_cursor(db, db._test_game_id, "reddit", "gaming", epoch)
    db.commit()
    assert read_cursor(db, db._test_game_id, "reddit", "gaming") == epoch


def test_write_cursor_uses_max_semantics(db):
    gid = db._test_game_id
    write_cursor(db, gid, "reddit", "gaming", 1_700_000_000)
    db.commit()
    # Attempt to move backwards - should be a no-op
    write_cursor(db, gid, "reddit", "gaming", 1_600_000_000)
    db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") == 1_700_000_000
    # Move forward - should update
    write_cursor(db, gid, "reddit", "gaming", 1_800_000_000)
    db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") == 1_800_000_000


def test_write_cursor_rejects_zero_and_negative(db):
    gid = db._test_game_id
    write_cursor(db, gid, "reddit", "gaming", 0)
    write_cursor(db, gid, "reddit", "gaming", -1)
    db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") is None


# ----- Scope-key normalization -------------------------------------------

def test_subreddit_scope_normalized_lowercase(db):
    gid = db._test_game_id
    write_cursor(db, gid, "reddit", "Gaming", 1_700_000_000)
    db.commit()
    # Different casing should hit the same row
    assert read_cursor(db, gid, "reddit", "gaming") == 1_700_000_000
    assert read_cursor(db, gid, "reddit", "GAMING") == 1_700_000_000


def test_subreddit_scope_strips_r_prefix(db):
    gid = db._test_game_id
    write_cursor(db, gid, "reddit", "r/pcgaming", 1_700_000_000)
    db.commit()
    assert read_cursor(db, gid, "reddit", "pcgaming") == 1_700_000_000
    assert read_cursor(db, gid, "reddit", "r/pcgaming") == 1_700_000_000


def test_source_scoped_distinct_from_subreddit(db):
    """A source-scoped cursor (empty scope) must not collide with a
    subreddit-scoped cursor of the same source."""
    gid = db._test_game_id
    write_cursor(db, gid, "bluesky", "", 1_700_000_000)
    write_cursor(db, gid, "reddit", "gaming", 1_800_000_000)
    db.commit()
    assert read_cursor(db, gid, "bluesky", "") == 1_700_000_000
    assert read_cursor(db, gid, "reddit", "gaming") == 1_800_000_000


def test_different_games_have_independent_cursors(db):
    """Backfill safety guarantee #1: cursor writes for game A must NOT
    affect game B's cursor."""
    gid_a = db._test_game_id
    # Create a second game
    pub = db.query(Publisher).first()
    game_b = Game(name="OtherGame", publisher_id=pub.id, steam_app_id=2)
    db.add(game_b)
    db.commit()
    gid_b = game_b.id

    write_cursor(db, gid_a, "reddit", "gaming", 1_700_000_000)
    write_cursor(db, gid_b, "reddit", "gaming", 1_500_000_000)
    db.commit()
    assert read_cursor(db, gid_a, "reddit", "gaming") == 1_700_000_000
    assert read_cursor(db, gid_b, "reddit", "gaming") == 1_500_000_000


# ----- backfill_suppress_cursor_updates ----------------------------------

def test_backfill_suppress_prevents_cursor_write(db):
    """Backfill safety guarantee #2: writes inside the suppress context
    are silently skipped so a historical backfill can't move the daily
    cursor forward past today's posts."""
    gid = db._test_game_id
    assert not _is_backfill_active()
    with backfill_suppress_cursor_updates():
        assert _is_backfill_active()
        write_cursor(db, gid, "reddit", "gaming", 1_700_000_000)
        db.commit()
        # Write should have been swallowed
        assert read_cursor(db, gid, "reddit", "gaming") is None
    # And the flag must have been cleared on exit
    assert not _is_backfill_active()


def test_backfill_suppress_context_resumes_after_exit(db):
    """Writes after the context exits should behave normally."""
    gid = db._test_game_id
    with backfill_suppress_cursor_updates():
        write_cursor(db, gid, "reddit", "gaming", 1_700_000_000)
        db.commit()
    # After exit, writes take effect
    write_cursor(db, gid, "reddit", "gaming", 1_800_000_000)
    db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") == 1_800_000_000


def test_backfill_suppress_nesting_preserves_state(db):
    """Nested contexts must not clear the flag on inner-exit."""
    gid = db._test_game_id
    assert not _is_backfill_active()
    with backfill_suppress_cursor_updates():
        assert _is_backfill_active()
        with backfill_suppress_cursor_updates():
            assert _is_backfill_active()
            write_cursor(db, gid, "reddit", "gaming", 1_700_000_000)
            db.commit()
        # Inner exited but outer still active
        assert _is_backfill_active()
        write_cursor(db, gid, "reddit", "gaming", 1_800_000_000)
        db.commit()
    # Both exited, flag cleared, no writes landed
    assert not _is_backfill_active()
    assert read_cursor(db, gid, "reddit", "gaming") is None


# ----- compute_after_epoch ------------------------------------------------

def test_compute_after_epoch_with_cursor_subtracts_buffer():
    cursor = 1_700_000_000
    result = compute_after_epoch(cursor)
    assert result == cursor - CURSOR_OVERLAP_BUFFER_S


def test_compute_after_epoch_none_uses_fallback():
    now = int(time.time())
    result = compute_after_epoch(None)
    expected = now - DEFAULT_FALLBACK_DAYS * 86400
    # Allow 5s slack for time drift between the two now() calls
    assert abs(result - expected) < 5


def test_compute_after_epoch_clamps_at_zero():
    # A cursor lower than the overlap buffer would produce negative
    assert compute_after_epoch(1000) == 0


# ----- helpers ------------------------------------------------------------

def test_epoch_from_post_dict_datetime():
    dt = datetime(2026, 8, 19, 12, 0, 0, tzinfo=timezone.utc)
    epoch = epoch_from_post_dict({"post_date": dt})
    assert epoch == int(dt.timestamp())


def test_epoch_from_post_dict_int():
    assert epoch_from_post_dict({"post_date": 1_700_000_000}) == 1_700_000_000


def test_epoch_from_post_dict_missing():
    assert epoch_from_post_dict({}) is None
    assert epoch_from_post_dict({"post_date": None}) is None


def test_newest_epoch_from_posts_empty():
    assert newest_epoch_from_posts([]) is None


def test_newest_epoch_from_posts_returns_max():
    posts = [
        {"post_date": datetime(2026, 8, 1, tzinfo=timezone.utc)},
        {"post_date": datetime(2026, 8, 19, tzinfo=timezone.utc)},  # newest
        {"post_date": datetime(2026, 8, 10, tzinfo=timezone.utc)},
    ]
    expected = int(datetime(2026, 8, 19, tzinfo=timezone.utc).timestamp())
    assert newest_epoch_from_posts(posts) == expected


def test_newest_epoch_ignores_missing_and_zero():
    posts = [
        {"post_date": datetime(2026, 8, 1, tzinfo=timezone.utc)},
        {"post_date": None},
        {},
        {"post_date": 0},
    ]
    expected = int(datetime(2026, 8, 1, tzinfo=timezone.utc).timestamp())
    assert newest_epoch_from_posts(posts) == expected


# ----- 3-day incremental simulation ---------------------------------------

def test_three_day_incremental_simulation(db):
    """End-to-end sanity: simulate 3 consecutive daily runs and confirm
    the cursor advances monotonically.

    Day 1: no cursor -> fallback (now - 48h).  Save 3 posts, newest at T0.
    Day 2: cursor at T0.  after = T0 - 48h buffer.  Save 2 new posts,
           newest at T0 + 1 day.
    Day 3: cursor at T0 + 1 day.  after = (T0 + 1 day) - 48h buffer.
           Save 1 new post, newest at T0 + 2 days.
    """
    gid = db._test_game_id
    now = int(time.time())
    # Day 1
    assert read_cursor(db, gid, "reddit", "gaming") is None
    assert compute_after_epoch(None) == pytest.approx(now - 2 * 86400, abs=5)
    day1_posts = [
        {"post_date": datetime.fromtimestamp(now - 3 * 3600, tz=timezone.utc)},
        {"post_date": datetime.fromtimestamp(now - 6 * 3600, tz=timezone.utc)},
        {"post_date": datetime.fromtimestamp(now - 12 * 3600, tz=timezone.utc)},
    ]
    d1_newest = newest_epoch_from_posts(day1_posts)
    write_cursor(db, gid, "reddit", "gaming", d1_newest)
    db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") == d1_newest

    # Day 2
    after_d2 = compute_after_epoch(read_cursor(db, gid, "reddit", "gaming"))
    assert after_d2 == d1_newest - CURSOR_OVERLAP_BUFFER_S
    day2_posts = [
        {"post_date": datetime.fromtimestamp(d1_newest + 3600, tz=timezone.utc)},
        {"post_date": datetime.fromtimestamp(d1_newest + 86400, tz=timezone.utc)},  # newest
    ]
    d2_newest = newest_epoch_from_posts(day2_posts)
    write_cursor(db, gid, "reddit", "gaming", d2_newest)
    db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") == d2_newest

    # Day 3
    after_d3 = compute_after_epoch(read_cursor(db, gid, "reddit", "gaming"))
    assert after_d3 == d2_newest - CURSOR_OVERLAP_BUFFER_S
    day3_posts = [
        {"post_date": datetime.fromtimestamp(d2_newest + 86400, tz=timezone.utc)},
    ]
    d3_newest = newest_epoch_from_posts(day3_posts)
    write_cursor(db, gid, "reddit", "gaming", d3_newest)
    db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") == d3_newest

    # Cursor advanced monotonically across all 3 days
    assert d3_newest > d2_newest > d1_newest


# ----- Backfill-during-daily-cursor safety -------------------------------

def test_backfill_run_preserves_daily_cursor(db):
    """Simulate a backfill that finds a much OLDER newest post than the
    daily cursor already has.  The suppress context must prevent the
    cursor from being moved at all — either forward past today's posts
    OR backward to an older date.  Combined with MAX() semantics, this
    is defense-in-depth.
    """
    gid = db._test_game_id
    # Daily cron has caught up to Aug 19 2026
    daily_epoch = int(datetime(2026, 8, 19, tzinfo=timezone.utc).timestamp())
    write_cursor(db, gid, "reddit", "gaming", daily_epoch)
    db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") == daily_epoch

    # A backfill runs covering Jan 2025 - Aug 2025.  Its newest post is
    # Aug 25 2025.  Inside the suppress context, this write is silently
    # swallowed — the daily cursor stays at Aug 19 2026.
    backfill_newest = int(datetime(2025, 8, 25, tzinfo=timezone.utc).timestamp())
    with backfill_suppress_cursor_updates():
        write_cursor(db, gid, "reddit", "gaming", backfill_newest)
        db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") == daily_epoch

    # And a hypothetical backfill that somehow found a FUTURE newest
    # post also can't advance the cursor — same suppress guarantee.
    hypothetical_future = int(datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp())
    with backfill_suppress_cursor_updates():
        write_cursor(db, gid, "reddit", "gaming", hypothetical_future)
        db.commit()
    assert read_cursor(db, gid, "reddit", "gaming") == daily_epoch
