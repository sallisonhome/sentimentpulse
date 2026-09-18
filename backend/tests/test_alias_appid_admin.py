"""Tests for the PATCH /api/games/{id} handler's alias_steam_app_ids field.

Landing A of the 2026-09-18 parent/child support work.

Validation contract:
  - Only positive integers accepted.
  - Alias cannot equal the game's own primary steam_app_id.
  - Alias cannot equal any OTHER game's PRIMARY steam_app_id.
  - Empty list clears the aliases (safe — game keeps its primary).
  - GameResponse now includes alias_steam_app_ids on GET.
"""
from __future__ import annotations

import pytest


class TestAliasSteamAppIdsPatch:
    def test_patch_adds_alias_and_get_returns_it(self, client, db, game):
        """Basic happy path: PATCH with one alias, GET reads it back."""
        resp = client.patch(
            f"/api/games/{game.id}",
            json={"alias_steam_app_ids": [5184670]},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["alias_steam_app_ids"] == [5184670]

        get_resp = client.get(f"/api/games/{game.id}")
        assert get_resp.status_code == 200
        assert get_resp.json()["alias_steam_app_ids"] == [5184670]

    def test_multiple_aliases_preserved_in_order(self, client, game):
        resp = client.patch(
            f"/api/games/{game.id}",
            json={"alias_steam_app_ids": [111, 222, 333]},
        )
        assert resp.status_code == 200
        assert resp.json()["alias_steam_app_ids"] == [111, 222, 333]

    def test_empty_list_clears_aliases(self, client, db, game):
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()

        resp = client.patch(
            f"/api/games/{game.id}",
            json={"alias_steam_app_ids": []},
        )
        assert resp.status_code == 200
        # Server stores None (NULL) so _resolve_steam_appids's isinstance(list)
        # guard returns primary-only.
        assert resp.json()["alias_steam_app_ids"] in (None, [])

    def test_alias_equal_to_primary_rejected(self, client, game):
        resp = client.patch(
            f"/api/games/{game.id}",
            json={"alias_steam_app_ids": [game.steam_app_id]},
        )
        assert resp.status_code == 400
        assert "primary steam_app_id" in resp.json()["detail"]

    def test_negative_alias_rejected(self, client, game):
        resp = client.patch(
            f"/api/games/{game.id}",
            json={"alias_steam_app_ids": [-1]},
        )
        # Pydantic may coerce; server-side guard also rejects non-positive.
        assert resp.status_code in (400, 422)

    def test_zero_alias_rejected(self, client, game):
        resp = client.patch(
            f"/api/games/{game.id}",
            json={"alias_steam_app_ids": [0]},
        )
        assert resp.status_code == 400

    def test_alias_conflict_with_another_games_primary(self, client, db, game):
        """If another game has this appid as its PRIMARY, reject with 409.
        Matches the Hellraiser case: id=155 already owns 5184670 as primary,
        so aliasing it under id=21 must fail until id=155 is deactivated."""
        from models import Game, Publisher
        pub = db.query(Publisher).first()
        other = Game(
            publisher_id=pub.id,
            steam_app_id=5184670,
            name="Other Demo",
            is_active=True,
            distinctive_keywords=["other demo"],
        )
        db.add(other); db.commit()

        resp = client.patch(
            f"/api/games/{game.id}",
            json={"alias_steam_app_ids": [5184670]},
        )
        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert "5184670" in detail
        assert "Other Demo" in detail
        assert "Deactivate" in detail

    def test_duplicate_aliases_in_input_deduplicated(self, client, game):
        resp = client.patch(
            f"/api/games/{game.id}",
            json={"alias_steam_app_ids": [111, 111, 222]},
        )
        assert resp.status_code == 200
        assert resp.json()["alias_steam_app_ids"] == [111, 222]

    def test_omitting_field_leaves_existing_aliases_untouched(self, client, db, game):
        """PATCH is partial-update: omitting alias_steam_app_ids must not
        clear an existing value."""
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()

        resp = client.patch(
            f"/api/games/{game.id}",
            json={"is_active": True},  # unrelated field
        )
        assert resp.status_code == 200
        assert resp.json()["alias_steam_app_ids"] == [5184670]
