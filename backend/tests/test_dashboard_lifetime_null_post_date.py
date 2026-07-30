"""Regression test for the Dashboard `period=lifetime` 500 fix (2026-07-30).

Bug
---
GET /api/games/{game_id}/dashboard?period=lifetime returned HTTP 500 for
every game with the error:

    ValueError: Invalid isoformat string: 'None'

Root cause: on the lifetime path the endpoint doesn't apply a
`func.date(post_date) >= p_start` predicate (p_start is None), so RawPost
rows with NULL post_date survived into the trend/volume/topics queries.
When the DB grouped rows on `func.date(post_date)`, the NULL rows came
back as a single grouped bucket with `day == None`, and the downstream
_to_date(row.day) call blew up with `Invalid isoformat string: 'None'`.

The block comment above the KPI query already documents the intent:
"Now we use only post_date and skip rows without a real timestamp."
That was enforced implicitly by the p_start filter for other periods
but not for lifetime.

Fix
---
1. Every query that joins RawPost also filters `RawPost.post_date IS NOT NULL`
   explicitly, so the intent holds for lifetime too.
2. _to_date() is now tolerant of None / 'None' / 'NULL' inputs and returns
   None so callers can skip them defensively.
3. Each _to_date call site in dashboard.py now skips None results before
   using them as a dict key.

These tests assert:
  * The lifetime endpoint returns 200 even when the game has posts with
    NULL post_date.
  * NULL-post_date rows are excluded from KPI counts / trend / volume /
    topics on every period, matching the documented intent.
  * _to_date is null-tolerant.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from models import Game, Publisher, RawPost, SentimentEnum, SentimentRecord, SourceEnum
from routers.dashboard import _to_date


# ── Unit: _to_date is null-tolerant ─────────────────────────────────────────

class TestToDate:
    def test_none_returns_none(self):
        assert _to_date(None) is None

    def test_literal_none_string_returns_none(self):
        # SQLAlchemy/SQLite has been observed to return the string 'None'
        # when grouping on a NULL column with func.date().
        assert _to_date("None") is None

    def test_literal_null_string_returns_none(self):
        assert _to_date("NULL") is None

    def test_empty_string_returns_none(self):
        assert _to_date("") is None

    def test_date_object_pass_through(self):
        d = date(2026, 7, 30)
        assert _to_date(d) == d

    def test_iso_string_parsed(self):
        assert _to_date("2026-07-30") == date(2026, 7, 30)

    def test_datetime_string_parsed(self):
        # SQLite frequently returns 'YYYY-MM-DD HH:MM:SS' — we only look at
        # the first 10 chars.
        assert _to_date("2026-07-30 12:34:56") == date(2026, 7, 30)


# ── Integration: lifetime path with NULL post_date rows ─────────────────────

@pytest.fixture()
def game_with_null_post_date_rows(db):
    """Create a game with a mix of real-post_date and NULL-post_date posts.

    Mirrors the production state where legacy scraper runs left ~thousands
    of RawPost rows with NULL post_date. Any of these grouped on
    func.date(post_date) would previously trigger the lifetime 500.
    """
    pub = Publisher(name="Test Publisher")
    db.add(pub)
    db.flush()

    game = Game(
        publisher_id=pub.id,
        steam_app_id=99992,
        name="Lifetime NULL Test Game",
        is_active=True,
        distinctive_keywords=["testgame_lifetime_null"],
    )
    db.add(game)
    db.flush()

    today = date.today()

    # 3 rows with real post_date (today, yesterday, 30 days ago).
    for offset, sentiment in [(0, "positive"), (1, "negative"), (30, "positive")]:
        post_dt = datetime.combine(today - timedelta(days=offset), datetime.min.time(), tzinfo=timezone.utc)
        raw = RawPost(
            game_id=game.id,
            source=SourceEnum.reddit,
            external_id=f"real_{offset}",
            body=f"Content posted {offset}d ago",
            is_relevant=True,
            post_date=post_dt,
            collected_at=datetime.now(timezone.utc),
        )
        db.add(raw)
        db.flush()
        sr = SentimentRecord(
            raw_post_id=raw.id,
            sentiment=SentimentEnum[sentiment],
            sentiment_score=0.9 if sentiment == "positive" else -0.9,
            topics=[f"topic_{sentiment}"],
        )
        db.add(sr)

    # 4 rows with NULL post_date — these must be excluded from all counts.
    for i in range(4):
        raw = RawPost(
            game_id=game.id,
            source=SourceEnum.steam_forum,
            external_id=f"nulldate_{i}",
            body=f"NULL-date content {i}",
            is_relevant=True,
            post_date=None,
            collected_at=datetime.now(timezone.utc),
        )
        db.add(raw)
        db.flush()
        sr = SentimentRecord(
            raw_post_id=raw.id,
            sentiment=SentimentEnum.positive,
            sentiment_score=0.8,
            topics=["null_date_topic"],
        )
        db.add(sr)

    db.commit()
    yield game.id


class TestLifetimeReturns200:
    def test_period_lifetime_does_not_500(self, client: TestClient, game_with_null_post_date_rows):
        """The exact bug the user reported: period=lifetime returns 500."""
        gid = game_with_null_post_date_rows
        r = client.get(f"/api/games/{gid}/dashboard?period=lifetime")
        assert r.status_code == 200, r.text

    def test_lifetime_kpi_excludes_null_post_date(self, client: TestClient, game_with_null_post_date_rows):
        """KPI counts should be 2 positive + 1 negative (real posts only)."""
        gid = game_with_null_post_date_rows
        r = client.get(f"/api/games/{gid}/dashboard?period=lifetime")
        assert r.status_code == 200
        d = r.json()
        st = d["sentiment_today"]  # despite the name, this is the period aggregate
        assert st["positive"] == 2, f"NULL-post_date rows leaked into KPI: {st}"
        assert st["negative"] == 1
        assert st["total"] == 3

    def test_lifetime_trend_only_real_dates(self, client: TestClient, game_with_null_post_date_rows):
        """Trend should have entries only for the real post_date days."""
        gid = game_with_null_post_date_rows
        r = client.get(f"/api/games/{gid}/dashboard?period=lifetime")
        assert r.status_code == 200
        d = r.json()
        trend = d["net_sentiment_trend"]
        for pt in trend:
            assert pt["summary_date"] is not None
            date.fromisoformat(pt["summary_date"])

    def test_lifetime_volume_only_real_dates(self, client: TestClient, game_with_null_post_date_rows):
        """Volume by source should have entries only for real post_date days."""
        gid = game_with_null_post_date_rows
        r = client.get(f"/api/games/{gid}/dashboard?period=lifetime")
        assert r.status_code == 200
        d = r.json()
        for pt in d["volume_by_source"]:
            assert pt["day"] is not None
            date.fromisoformat(pt["day"])

    def test_all_periods_agree_kpi_is_null_free(self, client: TestClient, game_with_null_post_date_rows):
        """Every period should exclude NULL-post_date rows, not just lifetime."""
        gid = game_with_null_post_date_rows
        for period in ["today", "weekly", "monthly", "quarterly", "lifetime"]:
            r = client.get(f"/api/games/{gid}/dashboard?period={period}")
            assert r.status_code == 200, f"period={period} failed: {r.text}"
            d = r.json()
            assert d["sentiment_today"]["positive"] <= 2, (
                f"period={period}: NULL-post_date leaked into positive count "
                f"({d['sentiment_today']})"
            )
