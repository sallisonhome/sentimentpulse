"""
Tests for monthly summary generation.

- Generating a monthly summary creates a row in monthly_summaries.
- Re-generating is idempotent (updates the existing row, no duplicate).
- Posts are selected via COALESCE(post_date, collected_at).
- The API endpoints return the expected shapes.
"""
import pytest
from datetime import date, datetime
from unittest.mock import patch

from models import MonthlySummary, RawPost, SentimentRecord, SentimentEnum, SourceEnum
from services.period_summary_service import generate_monthly_summary, _parse_bold_ideas


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
def post_with_post_date(db, game):
    """A raw post whose post_date falls in April 2024."""
    post = RawPost(
        game_id=game.id,
        source=SourceEnum.steam_review,
        external_id="rev_monthly_001",
        title="Great April game",
        body="Really enjoyed it.",
        upvotes=5,
        collected_at=datetime(2024, 5, 1),   # collected in May
        post_date=datetime(2024, 4, 15),      # but posted in April
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    return post


@pytest.fixture()
def post_no_post_date(db, game):
    """A raw post with no post_date — falls back to collected_at in April 2024."""
    post = RawPost(
        game_id=game.id,
        source=SourceEnum.reddit,
        external_id="reddit_monthly_001",
        title="Reddit discussion April",
        body="Some content.",
        upvotes=2,
        collected_at=datetime(2024, 4, 20),
        post_date=None,
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    return post


@pytest.fixture()
def sentiment_for(db):
    """Factory to create a SentimentRecord for a given post."""
    def _make(post, sentiment=SentimentEnum.positive, topics=None):
        sr = SentimentRecord(
            raw_post_id=post.id,
            sentiment=sentiment,
            sentiment_score=0.8,
            topics=topics or ["gameplay"],
        )
        db.add(sr)
        db.commit()
        db.refresh(sr)
        return sr
    return _make


# ── Service-level tests ───────────────────────────────────────────────────────

class TestGenerateMonthlySummary:

    def test_creates_row(self, db, game):
        """generate_monthly_summary creates a MonthlySummary row."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec text", "actions text", []),
        ):
            row = generate_monthly_summary(db, game.id, 2024, 4)

        assert row.id is not None
        assert row.game_id == game.id
        assert row.period_year == 2024
        assert row.period_month == 4

    def test_uses_post_date_for_filtering(self, db, game, post_with_post_date, sentiment_for):
        """Posts with post_date=April 2024 are counted in the April 2024 summary."""
        sentiment_for(post_with_post_date, SentimentEnum.positive, ["combat"])

        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec", "actions", []),
        ):
            row = generate_monthly_summary(db, game.id, 2024, 4)

        assert row.total_posts >= 1
        assert row.positive_count >= 1

    def test_uses_collected_at_fallback(self, db, game, post_no_post_date, sentiment_for):
        """Posts without post_date use collected_at (April 2024) for filtering."""
        sentiment_for(post_no_post_date, SentimentEnum.negative, ["bugs"])

        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec", "actions", []),
        ):
            row = generate_monthly_summary(db, game.id, 2024, 4)

        assert row.total_posts >= 1
        assert row.negative_count >= 1

    def test_idempotent_regeneration(self, db, game):
        """Re-generating the same month updates the row instead of creating a duplicate."""
        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("first exec", "first actions", []),
        ):
            row1 = generate_monthly_summary(db, game.id, 2024, 3)

        first_id = row1.id

        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("second exec", "second actions", ["Bold idea here"]),
        ):
            row2 = generate_monthly_summary(db, game.id, 2024, 3)

        # Same row (same primary key), updated content
        assert row2.id == first_id
        assert row2.executive_summary == "second exec"
        assert row2.bold_ideas == ["Bold idea here"]

        # Only one row in DB
        count = db.query(MonthlySummary).filter_by(
            game_id=game.id, period_year=2024, period_month=3
        ).count()
        assert count == 1

    def test_excludes_out_of_window_posts(self, db, game, post_with_post_date, sentiment_for):
        """Posts in April 2024 are NOT counted in the May 2024 summary."""
        sentiment_for(post_with_post_date, SentimentEnum.positive)

        with patch(
            "services.period_summary_service._call_claude_for_period",
            return_value=("exec", "actions", []),
        ):
            row = generate_monthly_summary(db, game.id, 2024, 5)

        # April post should NOT appear in May window
        assert row.positive_count == 0

    def test_raises_for_unknown_game(self, db):
        with pytest.raises(ValueError, match="not found"):
            generate_monthly_summary(db, 99999, 2024, 4)


# ── Bold ideas parsing ────────────────────────────────────────────────────────

class TestParseBoldIdeas:

    def test_none_returns_empty_list(self):
        assert _parse_bold_ideas("NONE") == []
        assert _parse_bold_ideas("none") == []
        assert _parse_bold_ideas("  NONE  ") == []

    def test_numbered_list_parsed(self):
        raw = "1. First bold idea here.\n2. Second bold idea here."
        result = _parse_bold_ideas(raw)
        assert len(result) == 2
        assert "First bold idea" in result[0]
        assert "Second bold idea" in result[1]

    def test_single_idea(self):
        raw = "1. Only one bold idea."
        result = _parse_bold_ideas(raw)
        assert len(result) == 1

    def test_multiline_idea(self):
        raw = "1. A bold idea that spans\nmultiple lines.\n2. Another idea."
        result = _parse_bold_ideas(raw)
        assert len(result) >= 1


# ── API endpoint tests ────────────────────────────────────────────────────────

class TestMonthlySummaryEndpoints:

    def test_list_empty(self, client, game):
        r = client.get(f"/api/games/{game.id}/monthly-summaries")
        assert r.status_code == 200
        assert r.json() == []

    def test_single_not_found(self, client, game):
        r = client.get(f"/api/games/{game.id}/monthly-summaries/2024/4")
        assert r.status_code == 404

    def test_game_not_found(self, client):
        r = client.get("/api/games/99999/monthly-summaries")
        assert r.status_code == 404

    def test_list_returns_month_label(self, client, db, game):
        """Seeding a MonthlySummary row and listing it returns month_label."""
        row = MonthlySummary(
            game_id=game.id,
            period_year=2024,
            period_month=4,
            positive_count=10,
            negative_count=5,
            neutral_count=3,
            total_posts=18,
            executive_summary="April exec summary.",
            recommended_actions="1. Do something.",
            bold_ideas=None,
        )
        db.add(row)
        db.commit()

        r = client.get(f"/api/games/{game.id}/monthly-summaries")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 1
        assert data[0]["month_label"] == "April 2024"
        assert data[0]["positive_count"] == 10

    def test_single_returns_row(self, client, db, game):
        row = MonthlySummary(
            game_id=game.id,
            period_year=2024,
            period_month=6,
            positive_count=7,
            negative_count=2,
            neutral_count=1,
            total_posts=10,
            bold_ideas=["A bold idea"],
        )
        db.add(row)
        db.commit()

        r = client.get(f"/api/games/{game.id}/monthly-summaries/2024/6")
        assert r.status_code == 200
        data = r.json()
        assert data["month_label"] == "June 2024"
        assert data["bold_ideas"] == ["A bold idea"]
