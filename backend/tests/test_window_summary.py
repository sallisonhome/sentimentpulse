"""
Tests for window summary (on-demand 7-day) generation and caching.

- Cache MISS: creates a new WindowSummary row.
- Cache HIT: returns the same row without regenerating.
- The cache key is (game_id, window_days, ingest_date).
- The POST /window-summary endpoint works.
"""
import pytest
from datetime import date, datetime
from unittest.mock import patch

from models import RawPost, SentimentRecord, SentimentEnum, SourceEnum, WindowSummary
from services.period_summary_service import generate_window_summary


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
def recent_post(db, game):
    """A raw post from a specific recent date."""
    post = RawPost(
        game_id=game.id,
        source=SourceEnum.steam_review,
        external_id="rev_window_001",
        title="Recent post",
        body="Content.",
        upvotes=3,
        collected_at=datetime(2024, 5, 15, 10, 0, 0),
        post_date=datetime(2024, 5, 15, 10, 0, 0),
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    return post


@pytest.fixture()
def sentiment_positive(db, recent_post):
    sr = SentimentRecord(
        raw_post_id=recent_post.id,
        sentiment=SentimentEnum.positive,
        sentiment_score=0.9,
        topics=["gameplay", "graphics"],
    )
    db.add(sr)
    db.commit()
    db.refresh(sr)
    return sr


# ── Service-level tests ───────────────────────────────────────────────────────

class TestGenerateWindowSummary:

    def test_cache_miss_creates_row(self, db, game):
        """On a cache miss, a new WindowSummary row is created."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec text", "actions text", [], {}),
        ) as mock_claude:
            row = generate_window_summary(db, game.id, days=7)

        assert row.id is not None
        assert row.game_id == game.id
        assert row.window_days == 7
        assert mock_claude.call_count == 1

    def test_cache_hit_skips_claude(self, db, game):
        """On a cache HIT, Claude is not called again."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec text", "actions text", [], {}),
        ) as mock_claude:
            row1 = generate_window_summary(db, game.id, days=7)
            row2 = generate_window_summary(db, game.id, days=7)

        # Claude called once only
        assert mock_claude.call_count == 1
        # Same row returned
        assert row1.id == row2.id

    def test_cache_keyed_on_ingest_date(self, db, game):
        """
        Two calls with the same game/days but different ingest_dates (different
        most-recent posts) produce different rows.

        We simulate this by manually inserting a pre-existing WindowSummary with
        a different ingest_date, then checking a new call generates a fresh one.
        """
        # Pre-seed a row for a specific ingest_date
        old_date = date(2024, 4, 1)
        old_row = WindowSummary(
            game_id=game.id,
            window_days=7,
            ingest_date=old_date,
            positive_count=5,
            negative_count=0,
            neutral_count=0,
            total_posts=5,
            executive_summary="Old exec",
            recommended_actions="Old actions",
        )
        db.add(old_row)
        db.commit()

        # Now generate with NO posts in DB → ingest_date defaults to today
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("new exec", "new actions", [], {}),
        ) as mock_claude:
            # This should be a cache miss since today != 2024-04-01
            new_row = generate_window_summary(db, game.id, days=7)

        # A new row was created (different ingest_date)
        assert new_row.id != old_row.id
        assert new_row.executive_summary == "new exec"

    def test_raises_for_unknown_game(self, db):
        with pytest.raises(ValueError, match="not found"):
            generate_window_summary(db, 99999, days=7)

    def test_posts_counted_in_window(self, db, game, recent_post, sentiment_positive):
        """Posts within the 7-day window from the max post date are counted."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec", "actions", [], {}),
        ):
            row = generate_window_summary(db, game.id, days=7)

        assert row.total_posts >= 1
        assert row.positive_count >= 1

    def test_different_window_sizes_are_separate_cache_entries(self, db, game):
        """7-day and 14-day summaries are cached separately."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec", "actions", [], {}),
        ):
            row_7  = generate_window_summary(db, game.id, days=7)
            row_14 = generate_window_summary(db, game.id, days=14)

        assert row_7.id != row_14.id
        assert row_7.window_days == 7
        assert row_14.window_days == 14


# ── API endpoint tests ────────────────────────────────────────────────────────

class TestWindowSummaryEndpoint:

    def test_post_creates_summary(self, client, db, game):
        """POST /window-summary returns a WindowSummaryResponse."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec text", "1. Action.", [], {}),
        ):
            r = client.post(
                f"/api/games/{game.id}/window-summary",
                json={"days": 7},
            )

        assert r.status_code == 200
        data = r.json()
        assert data["game_id"] == game.id
        assert data["window_days"] == 7
        assert "ingest_date" in data
        assert "executive_summary" in data

    def test_post_default_days(self, client, game):
        """POST with empty body defaults to days=7."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec", "actions", [], {}),
        ):
            r = client.post(f"/api/games/{game.id}/window-summary", json={})

        assert r.status_code == 200
        assert r.json()["window_days"] == 7

    def test_post_cache_hit_returns_instantly(self, client, db, game):
        """Second POST for the same cache key returns without Claude call."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec", "actions", [], {}),
        ) as mock_claude:
            r1 = client.post(f"/api/games/{game.id}/window-summary", json={"days": 7})
            r2 = client.post(f"/api/games/{game.id}/window-summary", json={"days": 7})

        assert r1.status_code == 200
        assert r2.status_code == 200
        # Claude should only be called once (cache hit on second)
        assert mock_claude.call_count == 1
        assert r1.json()["id"] == r2.json()["id"]

    def test_post_game_not_found(self, client):
        r = client.post("/api/games/99999/window-summary", json={"days": 7})
        assert r.status_code == 404

    def test_bold_ideas_in_response(self, client, game):
        """When Claude returns bold ideas, they appear in the response."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec", "actions", ["Bold idea number one"], {}),
        ):
            r = client.post(f"/api/games/{game.id}/window-summary", json={"days": 7})

        assert r.status_code == 200
        data = r.json()
        assert data["bold_ideas"] == ["Bold idea number one"]
