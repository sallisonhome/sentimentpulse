"""2026-08-05 — Dashboard Top Topics widget redesigned to a concise
text summary ranked by raw post volume across the selected period.

Contract:
  * `top_topics_summary` is present on every DashboardResponse.
  * Contains positive / negative / neutral lists of TopicSummary objects.
  * Ordering is by `volume` desc.
  * Top 1 by default; runner-up included only when runner_vol / leader_vol >= 0.70.
  * Empty when the period has no qualifying topics (frontend renders empty state).
  * `top_positive_topics` / `top_negative_topics` / `top_neutral_topics`
    are now always empty arrays — kept for schema back-compat only.
  * The window respects the `period` param exactly.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from models import Game, Publisher, RawPost, SentimentEnum, SentimentRecord, SourceEnum


def _mk_post(db, game_id, sentiment, topics, days_ago, external_id):
    """Create a RawPost + SentimentRecord back-dated N days ago."""
    post_dt = datetime.combine(
        date.today() - timedelta(days=days_ago),
        datetime.min.time(),
        tzinfo=timezone.utc,
    )
    raw = RawPost(
        game_id=game_id,
        source=SourceEnum.reddit,
        external_id=external_id,
        body=f"post {external_id}",
        is_relevant=True,
        post_date=post_dt,
        collected_at=datetime.now(timezone.utc),
    )
    db.add(raw)
    db.flush()
    sr = SentimentRecord(
        raw_post_id=raw.id,
        sentiment=sentiment,
        sentiment_score=0.9 if sentiment == SentimentEnum.positive else -0.9,
        topics=topics,
    )
    db.add(sr)
    return raw, sr


@pytest.fixture()
def game_with_topic_history(db):
    """Craft a corpus with known topic frequencies:

      Positive (last 30d):
        gunplay:        10 posts
        campaign_story:  9 posts   (90% of leader → passes 70% runner-up rule)
        graphics:        5 posts   (50% of leader → does NOT pass)

      Negative (last 30d):
        matchmaking:    12 posts
        bugs:            3 posts   (25% of leader → does NOT pass)

      Neutral: no topics at all → empty
    """
    pub = Publisher(name="Test Publisher")
    db.add(pub)
    db.flush()
    game = Game(
        publisher_id=pub.id,
        steam_app_id=88881,
        name="Top Topics Test Game",
        is_active=True,
        distinctive_keywords=["testkw"],
    )
    db.add(game)
    db.flush()

    # Positive: gunplay leader (10 posts over past 30 days)
    for i in range(10):
        _mk_post(db, game.id, SentimentEnum.positive, ["gunplay"], i, f"pos_gun_{i}")
    # Positive: campaign_story (9 posts) — 90% of leader
    for i in range(9):
        _mk_post(db, game.id, SentimentEnum.positive, ["campaign_story"], i, f"pos_camp_{i}")
    # Positive: graphics (5 posts) — 50% of leader (below 70% threshold)
    for i in range(5):
        _mk_post(db, game.id, SentimentEnum.positive, ["graphics"], i, f"pos_gfx_{i}")

    # Negative: matchmaking (12 posts) + bugs (3 posts, 25% of leader)
    for i in range(12):
        _mk_post(db, game.id, SentimentEnum.negative, ["matchmaking"], i, f"neg_mm_{i}")
    for i in range(3):
        _mk_post(db, game.id, SentimentEnum.negative, ["bugs"], i, f"neg_bug_{i}")

    # Neutral: 2 posts with empty topics lists — should produce empty summary
    _mk_post(db, game.id, SentimentEnum.neutral, [], 0, "neu_1")
    _mk_post(db, game.id, SentimentEnum.neutral, [], 1, "neu_2")

    db.commit()
    return game.id


class TestSchemaShape:
    def test_top_topics_summary_present_on_response(self, client: TestClient, game_with_topic_history):
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        assert r.status_code == 200, r.text
        d = r.json()
        assert "top_topics_summary" in d
        s = d["top_topics_summary"]
        assert set(s.keys()) == {"positive", "negative", "neutral"}

    def test_topic_item_arrays_are_now_empty(self, client: TestClient, game_with_topic_history):
        """The old TopicItem[] fields are retained for schema back-compat
        but must always be empty — no UI reads them anymore."""
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        d = r.json()
        assert d["top_positive_topics"] == []
        assert d["top_negative_topics"] == []
        assert d["top_neutral_topics"] == []


class TestRankingByVolume:
    def test_positive_leader_is_gunplay_at_10(self, client: TestClient, game_with_topic_history):
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        d = r.json()
        pos = d["top_topics_summary"]["positive"]
        assert len(pos) >= 1
        assert pos[0]["label"] == "gunplay"
        assert pos[0]["volume"] == 10

    def test_negative_leader_is_matchmaking_at_12(self, client: TestClient, game_with_topic_history):
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        d = r.json()
        neg = d["top_topics_summary"]["negative"]
        assert len(neg) >= 1
        assert neg[0]["label"] == "matchmaking"
        assert neg[0]["volume"] == 12


class TestRunnerUpRule:
    def test_positive_shows_runner_up_when_close(self, client: TestClient, game_with_topic_history):
        """campaign_story (9) is 90% of gunplay (10) — must be included."""
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        pos = r.json()["top_topics_summary"]["positive"]
        assert len(pos) == 2, f"expected 2, got {len(pos)}: {pos}"
        labels = [t["label"] for t in pos]
        assert labels == ["gunplay", "campaign_story"]

    def test_positive_omits_third_below_threshold(self, client: TestClient, game_with_topic_history):
        """graphics (5) is 50% of leader — excluded."""
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        labels = [t["label"] for t in r.json()["top_topics_summary"]["positive"]]
        assert "graphics" not in labels

    def test_negative_shows_only_leader_when_runner_up_far_behind(self, client: TestClient, game_with_topic_history):
        """matchmaking (12) vs bugs (3): 25% ratio, below 70% → only 1 shown."""
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        neg = r.json()["top_topics_summary"]["negative"]
        assert len(neg) == 1
        assert neg[0]["label"] == "matchmaking"


class TestEmptyState:
    def test_neutral_returns_empty_when_no_topics(self, client: TestClient, game_with_topic_history):
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        assert r.json()["top_topics_summary"]["neutral"] == []


class TestPeriodWindow:
    """The widget must honor the `period` chip exactly. A topic that only
    appears outside the window must not surface."""

    def test_today_only_shows_posts_from_today(self, client: TestClient, db, game_with_topic_history):
        """Add a fresh 'todayonly' topic today, then hit period=today.
        The 30-day topics (gunplay, matchmaking, etc.) all backdate their
        posts to previous days, so 'today' should surface the new topic
        instead."""
        # Fixture created posts backdated 0..11 days ago. Some ARE today
        # (days_ago=0). To verify the window filter, add a today-only topic
        # and check it appears.
        _mk_post(db, game_with_topic_history, SentimentEnum.positive,
                 ["todayonly"], 0, "pos_today_new")
        _mk_post(db, game_with_topic_history, SentimentEnum.positive,
                 ["todayonly"], 0, "pos_today_new_2")
        _mk_post(db, game_with_topic_history, SentimentEnum.positive,
                 ["todayonly"], 0, "pos_today_new_3")
        db.commit()

        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=today")
        assert r.status_code == 200
        pos = r.json()["top_topics_summary"]["positive"]
        labels_today = [t["label"] for t in pos]
        # 'todayonly' should be in today's summary. gunplay has 1 post
        # today (days_ago=0), campaign_story has 1, graphics has 1, and
        # todayonly has 3, so todayonly wins.
        assert "todayonly" in labels_today
        # And it should be the leader (volume 3, beats gunplay's 1)
        assert pos[0]["label"] == "todayonly"
        assert pos[0]["volume"] == 3


class TestDetailLineShape:
    def test_positive_detail_reads_naturally(self, client: TestClient, game_with_topic_history):
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        pos = r.json()["top_topics_summary"]["positive"]
        assert pos[0]["detail"] == "Players are praising gunplay."

    def test_negative_detail_uses_criticizing(self, client: TestClient, game_with_topic_history):
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        neg = r.json()["top_topics_summary"]["negative"]
        assert neg[0]["detail"] == "Players are criticizing matchmaking."

    def test_detail_does_not_mention_period(self, client: TestClient, game_with_topic_history):
        """Spec: detail line describes the topic, not the window. The
        period is communicated by the filter chip above the widget."""
        r = client.get(f"/api/games/{game_with_topic_history}/dashboard?period=monthly")
        pos = r.json()["top_topics_summary"]["positive"]
        for period_word in ["day", "week", "month", "quarter", "year", "period"]:
            assert period_word not in pos[0]["detail"].lower(), (
                f"Detail line should not mention the period: {pos[0]['detail']!r}"
            )
