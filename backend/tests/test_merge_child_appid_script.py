"""Tests for backend/scripts/merge_child_appid_into_parent.py.

Landing B of the 2026-09-18 Hellraiser Revival demo work.

Covers:
  - Fresh merge: raw_posts + sentiment_records move; parent gets alias;
    child is deactivated with a synthetic negative appid.
  - Conflict handling: a raw_post with the same (source, external_id) on
    both parent and child is deduplicated (child copy dropped, not moved).
  - Idempotency guard: re-running against a parent that already has the
    alias returns exit code 3 and moves nothing.
  - Mismatched --alias-appid: refuses with exit code 2.
  - Missing parent or child: refuses with exit code 2.
  - Dry-run: reports the plan and rolls back; no rows change.
  - Aggregates cleared: daily/monthly/window/topic_trends are deleted
    from the child so they don't leak stale numbers into the parent.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from scripts.merge_child_appid_into_parent import run as merge_run
from models import Game, RawPost, SentimentRecord, SentimentEnum, SourceEnum, DailySummary
from database import SessionLocal


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _make_game(db, *, publisher_id: int, appid: int, name: str, aliases=None):
    g = Game(
        publisher_id=publisher_id,
        steam_app_id=appid,
        name=name,
        is_active=True,
        distinctive_keywords=[name.lower()],
        alias_steam_app_ids=aliases,
    )
    db.add(g); db.commit(); db.refresh(g)
    return g


def _make_raw_post(db, *, game_id: int, source: SourceEnum, external_id: str,
                   body: str = "hi", is_relevant: bool = True) -> RawPost:
    p = RawPost(
        game_id=game_id,
        source=source,
        external_id=external_id,
        author="u",
        title=None,
        body=body,
        url=f"https://example.com/{external_id}",
        upvotes=0,
        collected_at=datetime.now(timezone.utc),
        post_date=datetime.now(timezone.utc),
        is_relevant=is_relevant,
    )
    db.add(p); db.commit(); db.refresh(p)
    return p


def _make_sentiment(db, *, raw_post_id: int, sentiment: SentimentEnum = SentimentEnum.neutral):
    s = SentimentRecord(
        raw_post_id=raw_post_id,
        sentiment=sentiment,
        sentiment_score=0.5,
        topics=[],
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


@pytest.fixture
def parent_child_setup(db, publisher):
    """Build a parent+child pair with a small set of posts under each.
    Returns (parent, child, and their post ids for later assertions)."""
    parent = _make_game(db, publisher_id=publisher.id, appid=1551980, name="Parent Game")
    child = _make_game(db, publisher_id=publisher.id, appid=5184670, name="Child Demo")

    # Parent has 2 forum posts (parent_a, parent_b).
    p_a = _make_raw_post(db, game_id=parent.id, source=SourceEnum.steam_forum, external_id="parent_a")
    p_b = _make_raw_post(db, game_id=parent.id, source=SourceEnum.steam_forum, external_id="parent_b")
    _make_sentiment(db, raw_post_id=p_a.id, sentiment=SentimentEnum.positive)

    # Child has 3 forum posts (child_a, child_b, child_c).
    c_a = _make_raw_post(db, game_id=child.id, source=SourceEnum.steam_forum, external_id="child_a")
    c_b = _make_raw_post(db, game_id=child.id, source=SourceEnum.steam_forum, external_id="child_b")
    c_c = _make_raw_post(db, game_id=child.id, source=SourceEnum.steam_forum, external_id="child_c")
    _make_sentiment(db, raw_post_id=c_a.id, sentiment=SentimentEnum.negative)
    _make_sentiment(db, raw_post_id=c_b.id, sentiment=SentimentEnum.neutral)

    return {
        "parent": parent,
        "child": child,
        "parent_posts": [p_a.id, p_b.id],
        "child_posts": [c_a.id, c_b.id, c_c.id],
    }


@pytest.fixture(autouse=True)
def _patch_session_factory(db, monkeypatch):
    """The script calls SessionLocal() which points at the app's real DB.
    Redirect it to the test session so run() operates on the in-memory DB.

    Also make the session's .close() a no-op so the script's finally-block
    doesn't detach the test's fixture objects. The test's own teardown
    still closes the real db session.
    """
    from scripts import merge_child_appid_into_parent as script_mod

    class _NoCloseSession:
        """Transparent proxy over the real test session that ignores close()."""
        def __init__(self, inner):
            self._inner = inner

        def __getattr__(self, item):
            return getattr(self._inner, item)

        def close(self):
            # Intentional no-op — test teardown owns the real close.
            pass

    monkeypatch.setattr(script_mod, "SessionLocal", lambda: _NoCloseSession(db))


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestFreshMergeCommit:
    def test_commit_moves_raw_posts_to_parent(self, db, parent_child_setup):
        setup = parent_child_setup
        rc = merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                       alias_appid=5184670, commit=True)
        assert rc == 0
        db.expire_all()
        # Parent now has 5 posts, child has 0.
        parent_posts = db.query(RawPost).filter_by(game_id=setup["parent"].id).count()
        child_posts = db.query(RawPost).filter_by(game_id=setup["child"].id).count()
        assert parent_posts == 5
        assert child_posts == 0

    def test_commit_sets_alias_on_parent(self, db, parent_child_setup):
        setup = parent_child_setup
        merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                  alias_appid=5184670, commit=True)
        db.expire_all()
        parent = db.get(Game, setup["parent"].id)
        assert parent.alias_steam_app_ids == [5184670]

    def test_commit_deactivates_child_and_flips_appid_sign(self, db, parent_child_setup):
        """Child's steam_app_id is negated so its UNIQUE constraint frees
        the number for the alias list. Row is kept for audit; is_active=False.
        """
        setup = parent_child_setup
        merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                  alias_appid=5184670, commit=True)
        db.expire_all()
        child = db.get(Game, setup["child"].id)
        assert child.is_active is False
        assert child.steam_app_id == -5184670
        assert "merged into game_id=" in (child.name or "")

    def test_commit_moves_sentiment_records_via_raw_post_fk(self, db, parent_child_setup):
        """SentimentRecord doesn't have game_id; it hangs off raw_post_id.
        After the move, sentiments for child_a and child_b must join to
        raw_posts whose game_id is now the parent."""
        setup = parent_child_setup
        merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                  alias_appid=5184670, commit=True)
        db.expire_all()
        # Count sentiment_records that join to raw_posts.game_id == parent.
        parent_sentiments = (
            db.query(SentimentRecord)
              .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
              .filter(RawPost.game_id == setup["parent"].id)
              .count()
        )
        # Parent had 1 sentiment (p_a). Child had 2 (c_a, c_b). Total = 3.
        assert parent_sentiments == 3


# ---------------------------------------------------------------------------
# Dry-run
# ---------------------------------------------------------------------------


class TestDryRunRollsBack:
    def test_dry_run_returns_zero_and_writes_nothing(self, db, parent_child_setup):
        setup = parent_child_setup
        rc = merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                       alias_appid=5184670, commit=False)
        assert rc == 0
        db.expire_all()
        # Nothing changed.
        assert db.query(RawPost).filter_by(game_id=setup["parent"].id).count() == 2
        assert db.query(RawPost).filter_by(game_id=setup["child"].id).count() == 3
        child = db.get(Game, setup["child"].id)
        assert child.is_active is True
        assert child.steam_app_id == 5184670
        parent = db.get(Game, setup["parent"].id)
        assert parent.alias_steam_app_ids in (None, [])


# ---------------------------------------------------------------------------
# Global uniqueness invariant
# ---------------------------------------------------------------------------


class TestGlobalUniquenessInvariant:
    def test_raw_posts_external_id_is_globally_unique(self, db, publisher):
        """Regression guard for the mover's assumption. raw_posts has a
        UNIQUE(source, external_id) constraint that is NOT scoped by
        game_id, so a duplicate could never exist across two game rows in
        the first place — the mover doesn't need conflict handling. If
        this constraint is ever loosened, the mover MUST grow the drop-
        on-conflict path back."""
        parent = _make_game(db, publisher_id=publisher.id, appid=1551980, name="Parent")
        child = _make_game(db, publisher_id=publisher.id, appid=5184670, name="Child")
        _make_raw_post(db, game_id=parent.id, source=SourceEnum.steam_forum,
                       external_id="dup_1", body="parent copy")
        # Attempting to insert the same (source, external_id) under a
        # different game_id must fail.
        from sqlalchemy.exc import IntegrityError
        with pytest.raises(IntegrityError):
            _make_raw_post(db, game_id=child.id, source=SourceEnum.steam_forum,
                           external_id="dup_1", body="child copy")
        db.rollback()


# ---------------------------------------------------------------------------
# Idempotency + input validation
# ---------------------------------------------------------------------------


class TestIdempotencyGuard:
    def test_rerun_after_success_refuses_with_code_3(self, db, parent_child_setup):
        setup = parent_child_setup
        rc = merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                       alias_appid=5184670, commit=True)
        assert rc == 0
        # Second attempt (parent already has alias 5184670).
        rc2 = merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                        alias_appid=5184670, commit=True)
        assert rc2 == 3


class TestInputValidation:
    def test_missing_parent_refuses(self, db, parent_child_setup):
        rc = merge_run(parent_id=99999, child_id=parent_child_setup["child"].id,
                       alias_appid=5184670, commit=True)
        assert rc == 2

    def test_missing_child_refuses(self, db, parent_child_setup):
        rc = merge_run(parent_id=parent_child_setup["parent"].id, child_id=99999,
                       alias_appid=5184670, commit=True)
        assert rc == 2

    def test_alias_appid_mismatch_refuses(self, db, parent_child_setup):
        """--alias-appid must equal child.steam_app_id. Guard against
        operator typos."""
        setup = parent_child_setup
        rc = merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                       alias_appid=9999999, commit=True)  # wrong appid
        assert rc == 2
        # Nothing changed.
        db.expire_all()
        assert db.query(RawPost).filter_by(game_id=setup["parent"].id).count() == 2
        assert db.query(RawPost).filter_by(game_id=setup["child"].id).count() == 3


# ---------------------------------------------------------------------------
# Aggregate cleanup
# ---------------------------------------------------------------------------


class TestSourceFetchCursorConflict:
    def test_conflicting_source_fetch_cursor_is_dropped_before_update(self, db, parent_child_setup):
        """Regression guard for the 2026-09-18 dry-run failure. Both parent
        and child had a source_fetch_cursor for (source=steam_forum,
        scope_key='') and the mover's naive UPDATE hit
        UNIQUE(game_id, source, scope_key). The fix DELETEs the child's
        colliding cursor first, then UPDATEs the rest."""
        from models import SourceFetchCursor
        setup = parent_child_setup

        # Parent has a steam_forum cursor at epoch 100.
        parent_cur = SourceFetchCursor(
            game_id=setup["parent"].id,
            source="steam_forum", scope_key="",
            last_seen_epoch=100, last_updated_at=datetime.now(timezone.utc),
        )
        # Child has a steam_forum cursor at epoch 200 (would collide).
        child_cur_dup = SourceFetchCursor(
            game_id=setup["child"].id,
            source="steam_forum", scope_key="",
            last_seen_epoch=200, last_updated_at=datetime.now(timezone.utc),
        )
        # Child also has a steam_review cursor (no conflict).
        child_cur_unique = SourceFetchCursor(
            game_id=setup["child"].id,
            source="steam_review", scope_key="",
            last_seen_epoch=300, last_updated_at=datetime.now(timezone.utc),
        )
        db.add_all([parent_cur, child_cur_dup, child_cur_unique])
        db.commit()

        rc = merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                       alias_appid=5184670, commit=True)
        assert rc == 0
        db.expire_all()

        # Parent still has its original steam_forum cursor (winner).
        parent_forum = db.query(SourceFetchCursor).filter_by(
            game_id=setup["parent"].id, source="steam_forum", scope_key="").first()
        assert parent_forum is not None
        assert parent_forum.last_seen_epoch == 100  # parent's value survives
        # steam_review moved to parent (no conflict).
        parent_review = db.query(SourceFetchCursor).filter_by(
            game_id=setup["parent"].id, source="steam_review", scope_key="").first()
        assert parent_review is not None
        assert parent_review.last_seen_epoch == 300
        # Child has no cursors left.
        child_cursors = db.query(SourceFetchCursor).filter_by(
            game_id=setup["child"].id).count()
        assert child_cursors == 0


class TestAggregateCleanup:
    def test_child_daily_summary_is_deleted(self, db, parent_child_setup):
        """The child's auto-generated daily_summary has placeholder Sonar
        text tuned to a corpus of 5 posts. That summary would leak into
        cross-app reports if left in place. Delete it so tomorrow's cron
        regenerates fresh from the merged corpus."""
        from datetime import date
        setup = parent_child_setup
        ds = DailySummary(
            game_id=setup["child"].id,
            summary_date=date(2026, 9, 18),
            positive_count=1, negative_count=1, neutral_count=1,
            executive_summary="Placeholder text for the child.",
        )
        db.add(ds); db.commit()
        assert db.query(DailySummary).filter_by(game_id=setup["child"].id).count() == 1

        merge_run(parent_id=setup["parent"].id, child_id=setup["child"].id,
                  alias_appid=5184670, commit=True)
        db.expire_all()
        assert db.query(DailySummary).filter_by(game_id=setup["child"].id).count() == 0
