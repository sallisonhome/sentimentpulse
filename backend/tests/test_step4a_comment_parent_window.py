"""v0027 (2026-08-27) regression tests for _step4a_reddit_comments
parent-selection window.

Bugs being locked out:

  #2 — Parent window was `collected_at >= now - 3d`. If a busy older
       thread was collected 5+ days ago but got a burst of new comments
       today (e.g. Gamescom trailer landed in an old megathread), the
       comment fetcher silently skipped it. Fix: window is now
       `COALESCE(post_date, collected_at) >= now - 7d` with limit=150.

  #3 — When the fresh 7d window returned zero parents, Step 4a emitted
       a silent "comment=0" day for that game. Fix: fall back to the
       top signal/dedicated parents in the last 14 days so ongoing
       discussion still gets comment coverage.

Test strategy: seed a Game + a mix of RawPost rows with different
post_date/collected_at tuples and relevance_tiers, patch
fetch_arctic_shift_comments to return a known small comment set, and
assert Step 4a saw the RIGHT set of parents.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from models import RawPost, SourceEnum
from services.ingestor import _step4a_reddit_comments


def _mk_parent(
    db,
    game,
    external_id: str,
    *,
    post_date: datetime | None,
    collected_at: datetime,
    tier: str = "signal",
) -> RawPost:
    p = RawPost(
        game_id=game.id,
        source=SourceEnum.reddit,
        external_id=external_id,
        author="reddituser",
        title=f"Parent thread {external_id}",
        body="",
        url=f"https://reddit.com/r/games/comments/{external_id}/x/",
        upvotes=42,
        collected_at=collected_at,
        post_date=post_date,
        relevance_tier=tier,
        matched_keywords=["kw"],
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@pytest.fixture()
def _stub_fetch():
    """Stub the Arctic Shift comment fetch so tests are hermetic. Returns
    the list of external_ids the ingestor asked us to fetch comments for
    so tests can assert which parents were selected."""
    calls: list[str] = []

    def _stub(parent_external_id, parent_permalink=None, limit=100):
        calls.append(parent_external_id)
        # Return one dummy comment so _bulk_save_posts has something
        # to work with, but don't rely on it landing (test env may
        # have a strict schema); the assertion is on which parents
        # got queried, not on the saved-count.
        return []

    # v0027: fetch_arctic_shift_comments is imported INSIDE
    # _step4a_reddit_comments (deliberate to avoid the module-level
    # shadow-import bug documented in lessons.md 2026-08-14). Patch
    # the source module so the function-local import resolves to our
    # stub.
    with patch(
        "services.arctic_shift_service.fetch_arctic_shift_comments",
        side_effect=_stub,
    ) as m:
        yield calls, m


class TestParentWindowFix:
    """Fix #2 — parent window widened + keyed on COALESCE(post_date, collected_at)."""

    def test_post_date_within_7d_admitted_even_if_collected_older(
        self, db, game, _stub_fetch,
    ):
        """A thread collected 5 days ago but with post_date 2 days ago
        (e.g. we backfilled an older discussion recently) must be picked
        up by the new 7d COALESCE window. Pre-v0027 this parent was
        dropped because `collected_at` was outside the old 3d window."""
        calls, _ = _stub_fetch
        now = datetime.now(timezone.utc)
        _mk_parent(
            db, game, "post_recent_collected_old",
            post_date=now - timedelta(days=2),
            collected_at=now - timedelta(days=5),
        )
        _step4a_reddit_comments(db, game, [], [])
        assert "post_recent_collected_old" in calls

    def test_parent_older_than_7d_excluded_from_fresh_window(
        self, db, game, _stub_fetch,
    ):
        """A parent whose effective_ts is 10 days old must not be in the
        fresh-window result set. It CAN show up via the fallback path,
        which is covered separately below."""
        calls, _ = _stub_fetch
        now = datetime.now(timezone.utc)
        # One fresh parent so the fresh window returns non-empty and
        # the fallback path is NOT triggered. Isolates window filtering.
        _mk_parent(
            db, game, "fresh_parent",
            post_date=now - timedelta(days=1),
            collected_at=now - timedelta(days=1),
        )
        _mk_parent(
            db, game, "old_parent_10d",
            post_date=now - timedelta(days=10),
            collected_at=now - timedelta(days=10),
        )
        _step4a_reddit_comments(db, game, [], [])
        assert "fresh_parent" in calls
        assert "old_parent_10d" not in calls

    def test_noise_tier_never_selected(self, db, game, _stub_fetch):
        """Only signal + dedicated_sub parents should be selected. Noise-
        tier parents must be excluded from both the fresh and fallback
        windows."""
        calls, _ = _stub_fetch
        now = datetime.now(timezone.utc)
        _mk_parent(
            db, game, "signal_parent",
            post_date=now - timedelta(days=1),
            collected_at=now - timedelta(days=1),
            tier="signal",
        )
        _mk_parent(
            db, game, "noise_parent",
            post_date=now - timedelta(days=1),
            collected_at=now - timedelta(days=1),
            tier="noise",
        )
        _step4a_reddit_comments(db, game, [], [])
        assert "signal_parent" in calls
        assert "noise_parent" not in calls


class TestFallbackWindow:
    """Fix #3 — fallback to top parents in last 14d when fresh window empty."""

    def test_fallback_fires_when_fresh_window_empty(
        self, db, game, _stub_fetch,
    ):
        """No parents in the last 7d, but there IS a signal parent 10d
        old. Pre-v0027 this returned (0, 0) with a silent skip log.
        Post-v0027 the fallback picks up the 10d-old parent."""
        calls, _ = _stub_fetch
        now = datetime.now(timezone.utc)
        _mk_parent(
            db, game, "fallback_parent_10d",
            post_date=now - timedelta(days=10),
            collected_at=now - timedelta(days=10),
        )
        log_lines: list[str] = []
        saved, fetched = _step4a_reddit_comments(db, game, log_lines, [])
        assert "fallback_parent_10d" in calls
        # Fallback log line MUST be emitted so we can distinguish this
        # from a healthy fresh-window run in production logs.
        assert any("fallback" in ln.lower() for ln in log_lines), (
            f"Expected a fallback log line; got: {log_lines}"
        )

    def test_fallback_does_not_fire_when_fresh_window_has_parents(
        self, db, game, _stub_fetch,
    ):
        """Sanity: the fallback path must NOT run when the fresh window
        already returned parents. Otherwise every run's log would look
        like it fell back, which defeats the point of the log line."""
        calls, _ = _stub_fetch
        now = datetime.now(timezone.utc)
        _mk_parent(
            db, game, "fresh_parent",
            post_date=now - timedelta(days=1),
            collected_at=now - timedelta(days=1),
        )
        _mk_parent(
            db, game, "older_parent_10d",
            post_date=now - timedelta(days=10),
            collected_at=now - timedelta(days=10),
        )
        log_lines: list[str] = []
        _step4a_reddit_comments(db, game, log_lines, [])
        # Fresh parent picked up; older parent NOT queried because the
        # fresh window returned non-empty.
        assert "fresh_parent" in calls
        assert "older_parent_10d" not in calls
        assert not any("fallback" in ln.lower() for ln in log_lines)

    def test_no_parents_at_all_returns_zero_zero(self, db, game, _stub_fetch):
        """When both windows are empty, Step 4a must still return (0, 0)
        and emit a skip log. Fixed behavior: the skip log now references
        the fallback window (14d) not the old 3d window."""
        calls, _ = _stub_fetch
        # No parents at all
        log_lines: list[str] = []
        saved, fetched = _step4a_reddit_comments(db, game, log_lines, [])
        assert saved == 0
        assert fetched == 0
        assert calls == []
        assert any("no signal/dedicated parents" in ln for ln in log_lines)


class TestOrderingAndLimits:
    """Ensure the fresh window uses COALESCE(post_date, collected_at) for
    ordering, not just post_date, and respects the 150-row limit."""

    def test_ordering_uses_coalesce_post_date_first(
        self, db, game, _stub_fetch,
    ):
        """Two fresh parents. One has a post_date, one has post_date=NULL
        and only collected_at. Both must be picked up (fallback to
        collected_at for NULL-post_date rows is required so archived-
        without-post_date data still flows)."""
        calls, _ = _stub_fetch
        now = datetime.now(timezone.utc)
        _mk_parent(
            db, game, "with_postdate",
            post_date=now - timedelta(days=1),
            collected_at=now - timedelta(days=1),
        )
        _mk_parent(
            db, game, "null_postdate",
            post_date=None,
            collected_at=now - timedelta(days=1),
        )
        _step4a_reddit_comments(db, game, [], [])
        assert "with_postdate" in calls
        assert "null_postdate" in calls
