"""v0028 (2026-08-28) regression tests for the post_date NULL fallback.

Bug being locked out: 12.5% of Steam forum posts (up to 54% for some
titles) were saved with post_date=NULL because Steam's DOM sometimes
omits data-timestamp and the text-parse fallback doesn't match every
locale/format. Every dashboard / digest / diag query groups by
`func.date(post_date)` and filters NULL out, so those posts were
silently invisible.

Fix: `_bulk_save_posts` now populates `post_date=utcnow()` when the
row's payload has post_date=None. Worse than a real timestamp but
strictly better than the row being invisible.

Rule to preserve: no RawPost row should ever be persisted with
`post_date=NULL`. Enforced here.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from models import RawPost, SourceEnum
from services.ingestor import _bulk_save_posts


class TestPostDateFallback:
    def test_missing_post_date_falls_back_to_utcnow(self, db, game):
        """A post without post_date must land with a non-NULL post_date."""
        before = datetime.utcnow() - timedelta(seconds=5)
        saved = _bulk_save_posts(
            db,
            game.id,
            SourceEnum.steam_forum,
            [{
                "external_id": "test_no_pd_1",
                "author": "steam_user",
                "title": "Test thread",
                "body": "sample body",
                "url": "https://steamcommunity.com/app/1/discussions/x/",
                "upvotes": 0,
                # post_date deliberately omitted
            }],
            [],
        )
        assert saved == 1
        after = datetime.utcnow() + timedelta(seconds=5)
        row = db.query(RawPost).filter(
            RawPost.external_id == "test_no_pd_1"
        ).first()
        assert row is not None
        assert row.post_date is not None, (
            "v0028: no RawPost should ever have post_date=NULL. "
            "Silent-invisible-post regression."
        )
        assert before <= row.post_date <= after, (
            f"post_date {row.post_date} should be utcnow() at insertion; "
            f"expected between {before} and {after}"
        )

    def test_explicit_post_date_is_preserved(self, db, game):
        """When the payload HAS post_date, it must be preserved as-is."""
        real_pd = datetime(2026, 8, 15, 12, 30, 0)
        saved = _bulk_save_posts(
            db,
            game.id,
            SourceEnum.steam_forum,
            [{
                "external_id": "test_with_pd_1",
                "author": "steam_user",
                "title": "Real thread",
                "body": "body",
                "url": "https://steamcommunity.com/app/1/discussions/y/",
                "upvotes": 0,
                "post_date": real_pd,
            }],
            [],
        )
        assert saved == 1
        row = db.query(RawPost).filter(
            RawPost.external_id == "test_with_pd_1"
        ).first()
        assert row is not None
        assert row.post_date == real_pd, (
            "Explicit post_date must be preserved unchanged."
        )

    def test_null_post_date_explicit(self, db, game):
        """Payload with an EXPLICIT post_date=None should also fall back."""
        before = datetime.utcnow() - timedelta(seconds=5)
        saved = _bulk_save_posts(
            db,
            game.id,
            SourceEnum.reddit,
            [{
                "external_id": "test_explicit_none_1",
                "author": "u/x",
                "title": "reddit post",
                "body": "body",
                "url": "https://reddit.com/r/x/comments/y/",
                "upvotes": 0,
                "post_date": None,
            }],
            [],
        )
        assert saved == 1
        after = datetime.utcnow() + timedelta(seconds=5)
        row = db.query(RawPost).filter(
            RawPost.external_id == "test_explicit_none_1"
        ).first()
        assert row is not None
        assert row.post_date is not None
        assert before <= row.post_date <= after
