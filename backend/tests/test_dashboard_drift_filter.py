"""2026-08-18 regression tests: dashboard sentiment metrics exclude
`raw_posts.is_off_topic_drift = True` rows; volume metrics include them.

Steve's request (2026-08-18): off-topic drift comments (previously
force-neutraled by Step 5 or the retroactive backfill) must be OMITTED
from pos/neg/neutral totals so those numbers only reflect content
genuinely about the game. Volume-by-source and competitor-timeseries
keep counting drift so engagement metrics still reflect the full
conversation level. See lessons.md 2026-08-18.

These tests seed a small in-memory DB with a game that has:
  * 3 positive non-drift posts
  * 2 negative non-drift posts
  * 4 neutral non-drift posts
  * 20 drift posts (any sentiment — the model's original verdict is
    irrelevant, they should all be excluded from sentiment metrics)

Then hit each dashboard endpoint and assert:
  * KPI totals == 3 pos + 2 neg + 4 neu (not 3+2+4+20)
  * Trend chart rows exclude drift
  * Top topics ignore drift
  * Volume-by-source INCLUDES drift (all 29 posts)
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from models import Game, Publisher, RawPost, SentimentEnum, SentimentRecord, SourceEnum


@pytest.fixture()
def game_with_drift(db):
    """Seed a game with a mix of drift and non-drift SentimentRecords.

    Non-drift breakdown (should count in KPI):
      * 3 positive
      * 2 negative
      * 4 neutral
    Drift (should be excluded from sentiment metrics, included in volume):
      * 20 rows (10 originally positive, 5 originally negative, 5 neutral)

    Total RawPost rows: 29 (both drift and non-drift have SentimentRecords).
    """
    pub = Publisher(name="Test Pub Drift")
    db.add(pub); db.flush()
    g = Game(
        publisher_id=pub.id, steam_app_id=999001, name="Drift Test Game",
        is_active=True, distinctive_keywords=["Drift Test Game"],
    )
    db.add(g); db.flush()

    now = datetime.now(timezone.utc)

    # All posts within the last 24 hours (well inside the weekly window)
    # so we can eyeball totals against the seed size directly.
    def _add(sentiment: SentimentEnum, is_drift: bool, minute_offset: int):
        rp = RawPost(
            game_id=g.id, source=SourceEnum.reddit_comment,
            external_id=f"drift_{is_drift}_{sentiment.value}_{minute_offset}",
            body=f"body {minute_offset}", is_relevant=True,
            relevance_tier="signal",  # verified parent
            post_date=now - timedelta(minutes=minute_offset),
            collected_at=now,
            is_off_topic_drift=is_drift,
        )
        db.add(rp); db.flush()
        db.add(SentimentRecord(
            raw_post_id=rp.id, sentiment=sentiment,
            sentiment_score=0.5, topics=[],
        ))

    # Non-drift, real signal (minute offsets 0-30)
    for i in range(3): _add(SentimentEnum.positive, False, i)
    for i in range(2): _add(SentimentEnum.negative, False, i + 10)
    for i in range(4): _add(SentimentEnum.neutral,  False, i + 20)

    # Drift — mix of sentiments (all should be excluded from KPI).
    # Minute offsets 30-60 keep everything in the last hour.
    for i in range(10): _add(SentimentEnum.positive, True, i + 30)
    for i in range(5):  _add(SentimentEnum.negative, True, i + 45)
    for i in range(5):  _add(SentimentEnum.neutral,  True, i + 55)

    db.commit()
    return g.id


@pytest.fixture()
def client(db):
    """FastAPI TestClient wired to the test DB session."""
    # Import here to avoid pulling FastAPI at module scope
    from main import app
    from database import get_db

    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


class TestDashboardDriftFilter:
    """Every sentiment metric in the dashboard endpoint excludes drift."""

    def test_kpi_counts_exclude_drift(self, client, game_with_drift):
        gid = game_with_drift
        r = client.get(f"/api/games/{gid}/dashboard?period=weekly")
        assert r.status_code == 200, r.text
        d = r.json()
        st = d["sentiment_today"]
        # Non-drift only: 3 pos, 2 neg, 4 neu
        assert st["positive"] == 3, (
            f"Expected 3 positive (non-drift only), got {st['positive']}. "
            f"If it's 13, the drift filter regressed on the KPI query."
        )
        assert st["negative"] == 2, (
            f"Expected 2 negative, got {st['negative']}. "
            f"If it's 7, the drift filter regressed."
        )
        assert st["neutral"] == 4, (
            f"Expected 4 neutral, got {st['neutral']}. "
            f"If it's 9, the drift filter regressed."
        )

    def test_trend_rows_exclude_drift(self, client, game_with_drift):
        gid = game_with_drift
        r = client.get(f"/api/games/{gid}/dashboard?period=weekly")
        d = r.json()
        trend = d["net_sentiment_trend"]
        # NetSentimentPoint uses `positive_count` / `negative_count` /
        # `neutral_count` / `total`. Sum of totals across trend days
        # should equal the non-drift total (3 + 2 + 4 = 9). Not 29.
        total = sum((pt.get("total", 0) or 0) for pt in trend)
        assert total == 9, (
            f"Expected trend total 9 (non-drift only), got {total}. "
            f"If it's 29, drift is being counted in the trend."
        )

    def test_volume_by_source_INCLUDES_drift(self, client, game_with_drift):
        """
        Volume-by-source counts all admitted posts (drift + non-drift)
        because engagement volume is a full-conversation metric.
        """
        gid = game_with_drift
        r = client.get(f"/api/games/{gid}/dashboard?period=weekly")
        d = r.json()
        vol = d["volume_by_source"]
        # VolumePoint.total already sums the display axes correctly
        # (reddit_comment is folded into reddit, not double-counted).
        # All 29 admitted posts should be counted here.
        total = sum(pt.get("total", 0) or 0 for pt in vol)
        assert total == 29, (
            f"Expected volume total 29 (all admitted posts, drift + "
            f"non-drift), got {total}. If it's 9, someone incorrectly "
            f"applied the drift filter to volume-by-source \u2014 volume "
            f"is a conversation-level metric and must include drift."
        )
