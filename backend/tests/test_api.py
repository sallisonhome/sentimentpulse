"""
Integration tests for all FastAPI routers.

Each test function uses the `client` fixture which provides a TestClient
backed by an in-memory SQLite database. Seed data is injected via the
focused fixtures defined in conftest.py.
"""
import pytest


# ── Health ─────────────────────────────────────────────────────────────────────

class TestHealth:
    def test_health_returns_ok(self, client):
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


# ── Publisher ──────────────────────────────────────────────────────────────────

class TestPublisher:
    def test_no_publisher_returns_404(self, client):
        r = client.get("/api/publishers/me")
        assert r.status_code == 404

    def test_publisher_returned_when_seeded(self, client, publisher):
        r = client.get("/api/publishers/me")
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "Acme Games"
        assert "id" in data


# ── Games ──────────────────────────────────────────────────────────────────────

class TestGames:
    def test_empty_games_list(self, client, publisher):
        r = client.get("/api/games")
        assert r.status_code == 200
        assert r.json() == []

    def test_games_list_with_game(self, client, game):
        r = client.get("/api/games")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 1
        assert data[0]["name"] == "Test Game"
        assert data[0]["steam_app_id"] == 12345

    def test_get_game_by_id(self, client, game):
        r = client.get(f"/api/games/{game.id}")
        assert r.status_code == 200
        data = r.json()
        assert data["id"] == game.id
        assert data["name"] == "Test Game"

    def test_get_game_not_found(self, client):
        r = client.get("/api/games/99999")
        assert r.status_code == 404

    def test_get_latest_game(self, client, game):
        r = client.get("/api/games/latest")
        assert r.status_code == 200
        assert r.json()["id"] == game.id

    def test_get_latest_no_games(self, client, publisher):
        r = client.get("/api/games/latest")
        assert r.status_code == 404

    def test_update_game_settings(self, client, game):
        r = client.patch(
            f"/api/games/{game.id}",
            json={"subreddits": ["testgame", "gaming"], "is_active": False},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["is_active"] is False
        assert "testgame" in data["subreddits"]

    def test_update_game_not_found(self, client):
        r = client.patch("/api/games/99999", json={"is_active": True})
        assert r.status_code == 404


# ── Dashboard ──────────────────────────────────────────────────────────────────

class TestDashboard:
    def test_dashboard_game_not_found(self, client):
        r = client.get("/api/games/99999/dashboard")
        assert r.status_code == 404

    def test_dashboard_empty_returns_zero_counts(self, client, game):
        r = client.get(f"/api/games/{game.id}/dashboard")
        assert r.status_code == 200
        data = r.json()
        assert data["game_id"] == game.id
        assert data["sentiment_today"]["total"] == 0
        assert data["sentiment_today"]["positive_pct"] == 0.0

    def test_dashboard_with_data(self, client, game, sentiment_record):
        r = client.get(f"/api/games/{game.id}/dashboard?period=weekly")
        assert r.status_code == 200
        data = r.json()
        assert data["sentiment_today"]["total"] >= 0
        assert "net_sentiment_trend" in data
        assert "volume_by_source" in data
        assert "sentiment_velocity" in data

    def test_dashboard_period_param_accepted(self, client, game):
        for period in ("weekly", "monthly", "quarterly", "lifetime"):
            r = client.get(f"/api/games/{game.id}/dashboard?period={period}")
            assert r.status_code == 200, f"Failed for period={period}"


# ── Summaries ──────────────────────────────────────────────────────────────────

class TestSummaries:
    def test_summaries_empty(self, client, game):
        r = client.get(f"/api/games/{game.id}/summaries")
        assert r.status_code == 200
        assert r.json() == []

    def test_summaries_with_data(self, client, game, daily_summary):
        r = client.get(f"/api/games/{game.id}/summaries?period=lifetime")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 1
        assert data[0]["positive_count"] == 80
        assert data[0]["executive_summary"] == "Overall sentiment is positive."

    def test_latest_summary(self, client, game, daily_summary):
        r = client.get(f"/api/games/{game.id}/summaries/latest")
        assert r.status_code == 200
        data = r.json()
        assert data["id"] == daily_summary.id

    def test_latest_summary_not_found(self, client, game):
        r = client.get(f"/api/games/{game.id}/summaries/latest")
        assert r.status_code == 404

    def test_summaries_game_not_found(self, client):
        r = client.get("/api/games/99999/summaries")
        assert r.status_code == 404


# ── Topics ─────────────────────────────────────────────────────────────────────

class TestTopics:
    def test_topics_empty(self, client, game):
        r = client.get(f"/api/games/{game.id}/topics")
        assert r.status_code == 200
        assert r.json() == []

    def test_topics_with_data(self, client, game, topic_trend):
        r = client.get(f"/api/games/{game.id}/topics?period=lifetime")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 1
        assert data[0]["topic_label"] == "gameplay"
        assert data[0]["trend_direction"] == "rising"
        assert data[0]["mention_count"] == 42

    def test_topics_sentiment_filter(self, client, game, topic_trend):
        r = client.get(f"/api/games/{game.id}/topics?period=lifetime&sentiment=positive")
        assert r.status_code == 200
        assert len(r.json()) == 1

        r = client.get(f"/api/games/{game.id}/topics?period=lifetime&sentiment=negative")
        assert r.status_code == 200
        assert len(r.json()) == 0

    def test_topics_invalid_sentiment_returns_400(self, client, game):
        r = client.get(f"/api/games/{game.id}/topics?sentiment=amazing")
        assert r.status_code == 400

    def test_topics_game_not_found(self, client):
        r = client.get("/api/games/99999/topics")
        assert r.status_code == 404


# ── Posts ──────────────────────────────────────────────────────────────────────

class TestPosts:
    def test_posts_empty(self, client, game):
        r = client.get(f"/api/games/{game.id}/posts")
        assert r.status_code == 200
        data = r.json()
        assert data["total"] == 0
        assert data["items"] == []

    def test_posts_with_data(self, client, game, raw_post, sentiment_record):
        r = client.get(f"/api/games/{game.id}/posts")
        assert r.status_code == 200
        data = r.json()
        assert data["total"] == 1
        assert data["items"][0]["title"] == "Great game!"
        assert data["items"][0]["source"] == "steam_review"
        assert data["items"][0]["sentiment_info"]["sentiment"] == "positive"

    def test_posts_sentiment_filter(self, client, game, raw_post, sentiment_record):
        r = client.get(f"/api/games/{game.id}/posts?sentiment=positive")
        assert r.status_code == 200
        assert r.json()["total"] == 1

        r = client.get(f"/api/games/{game.id}/posts?sentiment=negative")
        assert r.status_code == 200
        assert r.json()["total"] == 0

    def test_posts_source_filter(self, client, game, raw_post):
        r = client.get(f"/api/games/{game.id}/posts?source=steam_review")
        assert r.status_code == 200
        assert r.json()["total"] == 1

        r = client.get(f"/api/games/{game.id}/posts?source=reddit")
        assert r.status_code == 200
        assert r.json()["total"] == 0

    def test_posts_pagination(self, client, game, raw_post):
        r = client.get(f"/api/games/{game.id}/posts?page=1&page_size=10")
        assert r.status_code == 200
        data = r.json()
        assert data["page"] == 1
        assert data["page_size"] == 10
        assert data["total_pages"] >= 1

    def test_posts_invalid_sentiment_returns_400(self, client, game):
        r = client.get(f"/api/games/{game.id}/posts?sentiment=fantastic")
        assert r.status_code == 400

    def test_posts_game_not_found(self, client):
        r = client.get("/api/games/99999/posts")
        assert r.status_code == 404


# ── Ingest ─────────────────────────────────────────────────────────────────────

class TestIngest:
    def test_ingest_status(self, client):
        r = client.get("/api/ingest/status")
        assert r.status_code == 200
        data = r.json()
        assert "is_running" in data
        assert "last_run_at" in data
        assert isinstance(data["last_run_errors"], list)

    def test_ingest_run_returns_202(self, client):
        from unittest.mock import patch
        with patch("routers.ingest.run_ingestion", return_value={
            "status": "completed",
            "games_processed": 0,
            "posts_collected": 0,
            "errors": [],
        }):
            r = client.post("/api/ingest/run")
        assert r.status_code == 202
        data = r.json()
        assert data["status"] in ("completed", "skipped", "already_running")
