"""Regression test for the Dashboard "Top Topics" widget fix (2026-07-28).

Bug
---
Previously `_top_topics` in `backend/routers/dashboard.py` read from the
`topic_trends` table without any period filter. `topic_trends` is populated
opportunistically by the ingestor and was empty across every production
game, leaving the dashboard's Top Topics widget completely blank in every
sentiment tab, for every game, across every period selector.

Fix
---
Derive top topics from `DailySummary.top_{pos,neg,neu}_topics` rows scoped
to the currently-selected period window, aggregated with rank weighting
(rank 1=5, 2=4, 3=3, 4=2, 5=1) so a topic that ranks #1 for multiple days
outranks one that ranks low across many days. This mirrors the Summary
page's `_weighted_top` logic but runs independently, per the user's spec:
the widget must function independently of the summary widget so long as
it clusters top 3 topics dynamically weighted by volume in the filtered
range.

These tests assert:
  - Top Topics is NOT blank when the DB has DailySummary rows.
  - Different `period` values produce different top-3 rankings.
  - Ranking is dynamic-volume-weighted (rank #1 for many days > rank #5).
  - Empty period returns an empty list, never crashes.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from models import DailySummary, Game, Publisher


@pytest.fixture()
def game_with_daily_summaries(db):
    """Create a game and 10 DailySummary rows spanning today back 9 days.

    Ranking layout so weighted-vote scoring is exercised:
      - i in 0..2  (today, today-1, today-2):
          ["Combat Feel", "Boss Fight", "Roguelike Loop", "Music", "Art"]
      - i in 3..6  (today-3 .. today-6):
          ["Roguelike Loop", "Combat Feel", "Meta Progression",
           "Boss Fight", "Music"]
      - i in 7..9  (older; outside weekly window):
          ["Old Topic A", ..., "Old Topic E"]
    """
    pub = Publisher(name="Fixture Pub")
    db.add(pub)
    db.commit()
    game = Game(
        publisher_id=pub.id,
        steam_app_id=99991,
        name="TopicTestGame",
        is_active=True,
    )
    db.add(game)
    db.commit()

    today = date.today()
    for i in range(10):
        d = today - timedelta(days=i)
        if i < 3:
            pos = ["Combat Feel", "Boss Fight", "Roguelike Loop", "Music", "Art"]
        elif i < 7:
            pos = [
                "Roguelike Loop", "Combat Feel", "Meta Progression",
                "Boss Fight", "Music",
            ]
        else:
            pos = [
                "Old Topic A", "Old Topic B", "Old Topic C",
                "Old Topic D", "Old Topic E",
            ]
        db.add(DailySummary(
            game_id=game.id,
            summary_date=d,
            positive_count=10,
            negative_count=2,
            neutral_count=3,
            top_positive_topics=pos,
            top_negative_topics=["Bugs", "Crashes", "Balance"],
            top_neutral_topics=["Story", "Setting"],
        ))
    db.commit()
    yield game.id


def _get(client: TestClient, game_id: int, period: str) -> dict:
    r = client.get(f"/api/games/{game_id}/dashboard", params={"period": period})
    assert r.status_code == 200, r.text
    return r.json()


def test_top_topics_not_blank(client, game_with_daily_summaries):
    """The core bug: widget was blank on every game, every period."""
    data = _get(client, game_with_daily_summaries, "weekly")
    assert data["top_positive_topics"], "top_positive_topics is blank — regression!"
    assert data["top_negative_topics"], "top_negative_topics is blank — regression!"
    assert data["top_neutral_topics"], "top_neutral_topics is blank — regression!"


def test_top_topics_returns_three_items(client, game_with_daily_summaries):
    data = _get(client, game_with_daily_summaries, "weekly")
    assert len(data["top_positive_topics"]) == 3


def test_top_topics_are_period_scoped(client, game_with_daily_summaries):
    """Different period selectors must yield different rankings."""
    today = _get(client, game_with_daily_summaries, "today")
    weekly = _get(client, game_with_daily_summaries, "weekly")
    assert today["top_positive_topics"] != weekly["top_positive_topics"], (
        "Period filter has no effect on top topics — regression to "
        "unscoped topic_trends query."
    )


def test_top_topics_weighted_by_volume(client, game_with_daily_summaries):
    """Combat Feel ranks #1 on 3 days AND #2 on 4 days -> weight 15+16=31.
    Roguelike Loop ranks #1 on 4 days AND #3 on 3 days -> weight 20+9=29.
    Combat Feel MUST win in the 7-day window under rank-weighted volume."""
    weekly = _get(client, game_with_daily_summaries, "weekly")
    labels = [t["topic_label"] for t in weekly["top_positive_topics"]]
    assert labels[0] == "Combat Feel", (
        f"Weekly top-1 should be 'Combat Feel' by rank-weighted volume, "
        f"got {labels}"
    )
    assert "Roguelike Loop" in labels
    assert "Boss Fight" in labels


def test_top_topics_mention_count_is_positive_int(client, game_with_daily_summaries):
    """The widget renders mention_count as a numeric badge and as a bar
    width; it must be a positive int for every topic returned."""
    data = _get(client, game_with_daily_summaries, "weekly")
    for topic in data["top_positive_topics"]:
        assert isinstance(topic["mention_count"], int)
        assert topic["mention_count"] > 0, topic


def test_top_topics_empty_for_gameless_period(client, db):
    """A game with no DailySummary rows in the window must return []
    (no crash, no None)."""
    pub = Publisher(name="Empty Pub")
    db.add(pub); db.commit()
    g = Game(publisher_id=pub.id, steam_app_id=99992, name="EmptyGame", is_active=True)
    db.add(g); db.commit()
    data = _get(client, g.id, "weekly")
    assert data["top_positive_topics"] == []
    assert data["top_negative_topics"] == []
    assert data["top_neutral_topics"] == []
