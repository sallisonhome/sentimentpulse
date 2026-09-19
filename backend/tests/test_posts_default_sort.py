"""Tests for the /api/games/{id}/posts default-sort fix (2026-09-19).

The previous default (`ORDER BY collected_at DESC`) let bulk-ingested
sources (Steam reviews/forum — writes ~155 rows at the same second) get
buried behind streamed sources (Bluesky, reddit_comment — write per-row
a few seconds later). The user's SentimentPulse UI showed "no Steam
posts" for Hellraiser Revival on 2026-09-19 despite the daily cron
successfully saving 113 reviews + 42 forum posts that morning.

The fix: default sort is now
    ORDER BY COALESCE(post_date, collected_at) DESC, id DESC
so content-recency wins, with `id DESC` as a deterministic tiebreaker
for same-second bulk writes.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from database import get_db
from main import app
from models import RawPost, SourceEnum

client = TestClient(app)


def _mkpost(db, game_id, source, external_id, post_date, collected_at, body="hi"):
    p = RawPost(
        game_id=game_id,
        source=source,
        external_id=external_id,
        author="u",
        body=body,
        url=f"https://x/{external_id}",
        upvotes=0,
        post_date=post_date,
        collected_at=collected_at,
    )
    db.add(p); db.commit(); db.refresh(p)
    return p


import pytest


@pytest.fixture(autouse=True)
def _override_get_db(db):
    """Route the FastAPI dependency to the test db so TestClient sees fixtures."""
    app.dependency_overrides[get_db] = lambda: db
    yield
    app.dependency_overrides.pop(get_db, None)


class TestDefaultSortByPostDate:
    def test_bulk_steam_reviews_outrank_later_collected_bluesky(self, db, game):
        """Regression for 2026-09-19 Hellraiser bug.

        Simulates the actual pathology: 3 Steam reviews all collected at
        the SAME second, with post_dates from yesterday evening. Then a
        single Bluesky post collected 5 seconds later, whose post_date
        is much older. Under the old sort (collected_at DESC) the
        Bluesky wins page 1; under the new sort the Steam reviews win
        because their content is fresher.
        """
        g = game
        bulk_ca = datetime(2026, 9, 19, 10, 57, 5, tzinfo=timezone.utc)
        # Steam bulk: same collected_at, post_dates yesterday evening.
        for i, ts in enumerate([
            datetime(2026, 9, 18, 21, 53, tzinfo=timezone.utc),
            datetime(2026, 9, 18, 21, 40, tzinfo=timezone.utc),
            datetime(2026, 9, 18, 21, 32, tzinfo=timezone.utc),
        ], start=1):
            _mkpost(db, g.id, SourceEnum.steam_review, f"sr_{i}",
                    post_date=ts, collected_at=bulk_ca)
        # Bluesky: collected 5s later, but post_date is 4 days OLDER.
        _mkpost(db, g.id, SourceEnum.bluesky, "bs_1",
                post_date=datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc),
                collected_at=bulk_ca.replace(second=10))

        r = client.get(f"/api/games/{g.id}/posts?page_size=10")
        assert r.status_code == 200
        items = r.json()["items"]
        # Top 3 must be the Steam reviews (newest post_dates), then Bluesky.
        assert [p["source"] for p in items[:3]] == ["steam_review"] * 3
        assert items[3]["source"] == "bluesky"

    def test_deterministic_tiebreaker_on_identical_post_date(self, db, game):
        """Bulk-ingested rows with identical post_dates order by id DESC
        so consecutive page reads don't shuffle."""
        g = game
        ts = datetime(2026, 9, 19, 10, 57, 5, tzinfo=timezone.utc)
        ca = ts
        # Insert in order 1,2,3 — so ids are ascending.
        posts = [
            _mkpost(db, g.id, SourceEnum.steam_forum, f"sf_{i}",
                    post_date=ts, collected_at=ca)
            for i in range(1, 4)
        ]
        r = client.get(f"/api/games/{g.id}/posts?page_size=10")
        # Expected: newest id first (sf_3, sf_2, sf_1).
        assert [p["external_id"] for p in r.json()["items"][:3]] == \
               ["sf_3", "sf_2", "sf_1"]

    def test_null_post_date_falls_back_to_collected_at(self, db, game):
        """A row with post_date=None should still rank by collected_at."""
        g = game
        # Row with post_date=None but recent collected_at.
        _mkpost(db, g.id, SourceEnum.steam_forum, "nopd",
                post_date=None,
                collected_at=datetime(2026, 9, 19, 10, 57, tzinfo=timezone.utc))
        # Row with older post_date but even older collected_at.
        _mkpost(db, g.id, SourceEnum.bluesky, "old_pd",
                post_date=datetime(2026, 9, 14, tzinfo=timezone.utc),
                collected_at=datetime(2026, 9, 14, tzinfo=timezone.utc))
        r = client.get(f"/api/games/{g.id}/posts?page_size=10")
        items = r.json()["items"]
        # The nopd row's collected_at (Sep 19 10:57) beats old_pd's
        # post_date (Sep 14) via COALESCE.
        assert items[0]["external_id"] == "nopd"
        assert items[1]["external_id"] == "old_pd"

    def test_pagination_is_stable_across_pages(self, db, game):
        """With the id-DESC tiebreaker, page 1 and page 2 must partition
        the corpus without duplicates or gaps."""
        g = game
        ts = datetime(2026, 9, 19, 10, 57, 5, tzinfo=timezone.utc)
        for i in range(1, 8):
            _mkpost(db, g.id, SourceEnum.steam_forum, f"pg_{i}",
                    post_date=ts, collected_at=ts)

        r1 = client.get(f"/api/games/{g.id}/posts?page_size=3&page=1").json()
        r2 = client.get(f"/api/games/{g.id}/posts?page_size=3&page=2").json()
        r3 = client.get(f"/api/games/{g.id}/posts?page_size=3&page=3").json()
        ids = [p["external_id"] for r in (r1, r2, r3) for p in r["items"]]
        # 7 items, no dupes, no gaps, id-DESC order across pages.
        assert ids == ["pg_7", "pg_6", "pg_5", "pg_4", "pg_3", "pg_2", "pg_1"]

    def test_days_filter_still_works_with_new_sort(self, db, game):
        """?days=1 must exclude rows whose COALESCE(post_date, collected_at)
        is older than 24h, regardless of the new sort."""
        g = game
        # In-window: post_date yesterday (well within 24h if we assume
        # test runs "now").
        _mkpost(db, g.id, SourceEnum.steam_review, "in_win",
                post_date=datetime.now(timezone.utc).replace(microsecond=0),
                collected_at=datetime.now(timezone.utc).replace(microsecond=0))
        # Out-of-window: post_date 10 days ago.
        old_ts = datetime(2026, 9, 9, tzinfo=timezone.utc)
        _mkpost(db, g.id, SourceEnum.bluesky, "out_win",
                post_date=old_ts, collected_at=old_ts)
        r = client.get(f"/api/games/{g.id}/posts?days=1&page_size=10")
        items = r.json()["items"]
        ids = [p["external_id"] for p in items]
        assert "in_win" in ids
        assert "out_win" not in ids
