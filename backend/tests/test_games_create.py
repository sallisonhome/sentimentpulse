"""Tests for POST /api/games — manual game addition.

Why this endpoint exists: Steam's publisher search facet excludes some
legitimately-published titles (Bus Bound app 2095420 was missing from the
'Saber Interactive' facet results on 2026-06-22 despite SteamDB clearly
listing 'Publisher: Saber Interactive Inc.'), so the auto-discovery in
/api/publisher will never pick them up.  This endpoint is the manual
fallback.
"""
from unittest.mock import patch

import pytest

from models import Game


# ── Happy paths ──────────────────────────────────────────────────────────────

def test_create_with_explicit_name_and_subreddits(client, publisher):
    """When name + subreddits are supplied, no upstream calls are made."""
    body = {
        "steam_app_id": 2095420,
        "name": "Bus Bound",
        "subreddits": ["BusBound"],
    }
    r = client.post("/api/games", json=body)
    assert r.status_code == 201, r.text
    game = r.json()
    assert game["steam_app_id"] == 2095420
    assert game["name"] == "Bus Bound"
    assert game["subreddits"] == ["BusBound"]
    assert game["is_active"] is True


def test_create_resolves_name_from_steam_when_omitted(client, publisher):
    """If name is omitted, the endpoint calls get_app_details and uses
    Steam's returned name + release_date."""
    with patch("services.steam_service.get_app_details", return_value={
        "name": "Bus Bound",
        "release_date": {"date": "30 Apr, 2026"},
    }) as mock_details, patch(
        "services.reddit_service.discover_subreddits", return_value=["BusBound"]
    ):
        r = client.post("/api/games", json={"steam_app_id": 2095420})
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "Bus Bound"
    assert r.json()["release_date"] == "30 Apr, 2026"
    mock_details.assert_called_once_with(2095420)


def test_create_discovers_subreddits_when_omitted(client, publisher):
    """When subreddits is omitted, discover_subreddits is called once with
    the resolved game name."""
    with patch(
        "services.reddit_service.discover_subreddits",
        return_value=["BusBound", "BusSimulator"],
    ) as mock_disc:
        r = client.post("/api/games", json={
            "steam_app_id": 2095420,
            "name": "Bus Bound",
        })
    assert r.status_code == 201, r.text
    assert r.json()["subreddits"] == ["BusBound", "BusSimulator"]
    mock_disc.assert_called_once_with("Bus Bound")


def test_create_persists_to_db(client, publisher, db):
    r = client.post("/api/games", json={
        "steam_app_id": 2095420,
        "name": "Bus Bound",
        "subreddits": ["BusBound"],
    })
    assert r.status_code == 201
    row = db.query(Game).filter_by(steam_app_id=2095420).first()
    assert row is not None
    assert row.name == "Bus Bound"
    assert row.is_active is True
    assert row.publisher_id == publisher.id


def test_create_is_active_false(client, publisher):
    """Operator can add a game inactive (e.g. to backfill historical data later)."""
    r = client.post("/api/games", json={
        "steam_app_id": 99999,
        "name": "Test",
        "subreddits": [],
        "is_active": False,
    })
    assert r.status_code == 201
    assert r.json()["is_active"] is False


# ── Failure modes ────────────────────────────────────────────────────────────

def test_no_publisher_returns_422(client, db):
    """With no Publisher row, the endpoint must refuse the create."""
    r = client.post("/api/games", json={
        "steam_app_id": 2095420,
        "name": "Bus Bound",
        "subreddits": [],
    })
    assert r.status_code == 422, r.text
    assert "publisher" in r.json()["detail"].lower()


def test_duplicate_steam_app_id_returns_409(client, publisher, db):
    """Re-adding the same app id must 409, not silently create a duplicate."""
    db.add(Game(
        publisher_id=publisher.id, steam_app_id=2095420,
        name="Bus Bound", is_active=True, subreddits=[],
    ))
    db.commit()

    r = client.post("/api/games", json={
        "steam_app_id": 2095420,
        "name": "Bus Bound",
        "subreddits": [],
    })
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert "already exists" in detail
    assert "Bus Bound" in detail  # surfaces existing name for the operator


def test_unresolvable_name_returns_422(client, publisher):
    """When Steam appdetails returns nothing AND name was omitted, 422."""
    with patch("services.steam_service.get_app_details", return_value=None):
        r = client.post("/api/games", json={"steam_app_id": 99999999})
    assert r.status_code == 422
    assert "99999999" in r.json()["detail"]


def test_subreddit_discovery_failure_falls_back_to_empty(client, publisher):
    """If discover_subreddits raises, the game is still created with [].
    Operator can PATCH /api/games/{id} later to set subreddits manually."""
    with patch(
        "services.reddit_service.discover_subreddits",
        side_effect=RuntimeError("Reddit search rate-limited"),
    ):
        r = client.post("/api/games", json={
            "steam_app_id": 2095420,
            "name": "Bus Bound",
        })
    assert r.status_code == 201
    assert r.json()["subreddits"] == []
