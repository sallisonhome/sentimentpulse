"""
Integration tests for the competitor-tracking feature:
  - GET/POST/DELETE /api/games/{parent_id}/competitors
  - GET /api/games/{parent_id}/competitor-timeseries
  - GET /api/games?exclude_competitors=true

Steam's appdetails API is always mocked (services.steam_service.get_app_details)
— tests never hit the real network per project rules.
"""
from datetime import date, datetime, timedelta
from unittest.mock import patch

import pytest


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _steam_details(name: str, release_date: str = "1 Jan, 2024"):
    """Shape returned by services.steam_service.get_app_details on success."""
    return {
        "name": name,
        "steam_appid": 999,
        "release_date": {"coming_soon": False, "date": release_date},
    }


def _make_competitor(client, parent_id, steam_app_id, name="Rival Game"):
    with patch(
        "services.steam_service.get_app_details",
        return_value=_steam_details(name),
    ):
        return client.post(
            f"/api/games/{parent_id}/competitors",
            json={"steam_app_id": steam_app_id},
        )


# ── GET /games/{parent_id}/competitors ──────────────────────────────────────────

class TestListCompetitors:
    def test_empty_list_for_parent_with_no_competitors(self, client, game):
        r = client.get(f"/api/games/{game.id}/competitors")
        assert r.status_code == 200
        assert r.json() == []

    def test_parent_not_found(self, client):
        r = client.get("/api/games/99999/competitors")
        assert r.status_code == 404


# ── POST /games/{parent_id}/competitors ─────────────────────────────────────────

class TestAddCompetitor:
    def test_creates_competitor_when_steam_appid_resolves(self, client, game):
        r = _make_competitor(client, game.id, 555555, name="Silent Hill: Townfall")
        assert r.status_code == 201
        data = r.json()
        assert data["name"] == "Silent Hill: Townfall"
        assert data["steam_app_id"] == 555555
        assert data["subreddits"] == []

        # Confirmed listed under the parent now.
        r2 = client.get(f"/api/games/{game.id}/competitors")
        assert r2.status_code == 200
        assert len(r2.json()) == 1
        assert r2.json()[0]["name"] == "Silent Hill: Townfall"

    def test_keyword_autopopulation_on_add(self, client, game):
        with patch(
            "services.steam_service.get_app_details",
            return_value=_steam_details("Hellraiser: Revival"),
        ):
            r = client.post(
                f"/api/games/{game.id}/competitors",
                json={"steam_app_id": 424242},
            )
        assert r.status_code == 201
        data = r.json()
        assert isinstance(data["distinctive_keywords"], list)
        assert len(data["distinctive_keywords"]) >= 1

    def test_returns_404_when_steam_appid_not_found(self, client, game):
        with patch("services.steam_service.get_app_details", return_value=None):
            r = client.post(
                f"/api/games/{game.id}/competitors",
                json={"steam_app_id": 1},
            )
        assert r.status_code == 404
        assert "not found" in r.json()["detail"].lower()

    def test_returns_409_at_max_four_competitors(self, client, game):
        for i in range(4):
            r = _make_competitor(client, game.id, 100000 + i, name=f"Rival {i}")
            assert r.status_code == 201

        r5 = _make_competitor(client, game.id, 200000, name="Rival 5")
        assert r5.status_code == 409
        assert "maximum of 4 competitors" in r5.json()["detail"]

    def test_returns_409_when_already_a_competitor_under_this_parent(self, client, game):
        r1 = _make_competitor(client, game.id, 300000, name="Rival X")
        assert r1.status_code == 201
        new_id = r1.json()["id"]

        # Re-adding the SAME steam_app_id under the same parent -> 409.
        r2 = _make_competitor(client, game.id, 300000, name="Rival X")
        assert r2.status_code == 409
        assert "already tracked" in r2.json()["detail"].lower()

    def test_returns_409_when_target_already_a_saber_title(self, client, game, publisher):
        from models import Game as GameModel

        # `game` fixture already has steam_app_id=12345; adding it as a
        # competitor of itself (or of another parent) must be rejected.
        r = client.post(
            f"/api/games/{game.id}/competitors",
            json={"steam_app_id": game.steam_app_id},
        )
        assert r.status_code == 409

    def test_parent_not_found(self, client):
        r = _make_competitor(client, 99999, 400000)
        assert r.status_code == 404


# ── DELETE /games/{parent_id}/competitors/{competitor_id} ──────────────────────

class TestRemoveCompetitor:
    def test_removes_competitor_and_cascades_posts(self, client, db, game):
        from models import Game as GameModel, RawPost, SentimentEnum, SentimentRecord, SourceEnum

        r = _make_competitor(client, game.id, 700000, name="Doomed Rival")
        assert r.status_code == 201
        competitor_id = r.json()["id"]

        # Attach a raw post + sentiment record to the competitor to verify cascade.
        post = RawPost(
            game_id=competitor_id,
            source=SourceEnum.steam_review,
            external_id="rev_1",
            author="bob",
            body="not bad",
            url="https://example.com",
            upvotes=0,
            collected_at=datetime.utcnow(),
            post_date=datetime.utcnow(),
        )
        db.add(post)
        db.commit()
        db.refresh(post)
        sr = SentimentRecord(
            raw_post_id=post.id,
            sentiment=SentimentEnum.neutral,
            sentiment_score=0.5,
            topics=["gameplay"],
        )
        db.add(sr)
        db.commit()

        d = client.delete(f"/api/games/{game.id}/competitors/{competitor_id}")
        assert d.status_code == 204

        # Competitor gone from the list.
        r2 = client.get(f"/api/games/{game.id}/competitors")
        assert r2.json() == []

        # Underlying Game row + posts + sentiment records gone too.
        assert db.query(GameModel).filter_by(id=competitor_id).first() is None
        assert db.query(RawPost).filter_by(game_id=competitor_id).first() is None
        assert db.query(SentimentRecord).filter_by(raw_post_id=post.id).first() is None

    def test_returns_404_when_not_a_tracked_competitor(self, client, game):
        r = client.delete(f"/api/games/{game.id}/competitors/99999")
        assert r.status_code == 404


# ── One-Saber-title = 4-competitors-max invariant ───────────────────────────────

class TestFourCompetitorInvariant:
    def test_removing_one_allows_adding_another(self, client, game):
        ids = []
        for i in range(4):
            r = _make_competitor(client, game.id, 900000 + i, name=f"Slot {i}")
            assert r.status_code == 201
            ids.append(r.json()["id"])

        # At capacity.
        full = _make_competitor(client, game.id, 950000, name="Overflow")
        assert full.status_code == 409

        # Remove one, capacity freed up.
        d = client.delete(f"/api/games/{game.id}/competitors/{ids[0]}")
        assert d.status_code == 204

        ok = _make_competitor(client, game.id, 950001, name="Replacement")
        assert ok.status_code == 201


# ── GET /games?exclude_competitors=true ─────────────────────────────────────────

class TestExcludeCompetitorsFilter:
    def test_excludes_competitor_games_from_list(self, client, game):
        r = _make_competitor(client, game.id, 111222, name="Hidden Rival")
        assert r.status_code == 201
        competitor_id = r.json()["id"]

        all_games = client.get("/api/games").json()
        all_ids = {g["id"] for g in all_games}
        assert competitor_id in all_ids
        assert game.id in all_ids

        filtered = client.get("/api/games?exclude_competitors=true").json()
        filtered_ids = {g["id"] for g in filtered}
        assert competitor_id not in filtered_ids
        assert game.id in filtered_ids


# ── GET /games/{parent_id}/competitor-timeseries ────────────────────────────────

class TestCompetitorTimeseries:
    def test_parent_alone_when_no_competitors(self, client, game):
        r = client.get(f"/api/games/{game.id}/competitor-timeseries?period=lifetime")
        assert r.status_code == 200
        data = r.json()
        assert len(data["games"]) == 1
        assert data["games"][0]["game_id"] == game.id
        assert data["games"][0]["is_parent"] is True

    def test_parent_not_found(self, client):
        r = client.get("/api/games/99999/competitor-timeseries")
        assert r.status_code == 404

    def test_parent_and_competitor_with_correct_daily_counts(self, client, db, game):
        from models import RawPost, SentimentEnum, SentimentRecord, SourceEnum

        r = _make_competitor(client, game.id, 800000, name="Counted Rival")
        assert r.status_code == 201
        competitor_id = r.json()["id"]

        today = datetime.utcnow()

        def _add_post(game_id, external_id, when):
            post = RawPost(
                game_id=game_id,
                source=SourceEnum.steam_review,
                external_id=external_id,
                author="x",
                body="body",
                url="https://example.com",
                upvotes=0,
                collected_at=when,
                post_date=when,
            )
            db.add(post)
            db.commit()
            db.refresh(post)
            sr = SentimentRecord(
                raw_post_id=post.id,
                sentiment=SentimentEnum.positive,
                sentiment_score=0.9,
                topics=[],
            )
            db.add(sr)
            db.commit()

        # 3 posts for parent today, 5 for competitor today.
        for i in range(3):
            _add_post(game.id, f"parent_{i}", today)
        for i in range(5):
            _add_post(competitor_id, f"comp_{i}", today)

        r2 = client.get(f"/api/games/{game.id}/competitor-timeseries?period=today")
        assert r2.status_code == 200
        data = r2.json()
        assert len(data["games"]) == 2
        assert len(data["timeseries"]) == 1
        counts = data["timeseries"][0]["counts"]
        assert counts[str(game.id)] == 3
        assert counts[str(competitor_id)] == 5
