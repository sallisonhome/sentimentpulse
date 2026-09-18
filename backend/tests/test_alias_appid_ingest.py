"""Tests for the alias-appid parent/child support in daily ingest.

Landing A of the 2026-09-18 Hellraiser Revival demo work. When
`games.alias_steam_app_ids` is populated, Step 2 (Steam reviews) and
Step 3 (Steam forums) must fetch for the primary appid AND each
alias, writing all rows under the same game.id.

Non-goals in this test file:
  - Data migration for existing splits (that's Landing B).
  - HTTP admin surface for setting aliases (see test_alias_appid_admin.py).
  - Actual Steam network calls (mocked; fetch_reviews and
    scrape_forum_threads are patched to return canned batches).
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from services.ingestor import (
    _resolve_steam_appids,
    _step2_steam_reviews,
    _step3_steam_forums,
)
from models import RawPost, SourceEnum


# ---------------------------------------------------------------------------
# _resolve_steam_appids
# ---------------------------------------------------------------------------


class TestResolveSteamAppids:
    def test_no_aliases_returns_only_primary(self, db, game):
        """NULL / missing alias_steam_app_ids returns just the primary."""
        game.alias_steam_app_ids = None
        db.add(game); db.commit()
        assert _resolve_steam_appids(game) == [game.steam_app_id]

    def test_empty_list_returns_only_primary(self, db, game):
        game.alias_steam_app_ids = []
        db.add(game); db.commit()
        assert _resolve_steam_appids(game) == [game.steam_app_id]

    def test_single_alias_appended_after_primary(self, db, game):
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()
        assert _resolve_steam_appids(game) == [game.steam_app_id, 5184670]

    def test_multiple_aliases_preserve_order(self, db, game):
        game.alias_steam_app_ids = [111, 222, 333]
        db.add(game); db.commit()
        assert _resolve_steam_appids(game) == [game.steam_app_id, 111, 222, 333]

    def test_duplicate_of_primary_dropped(self, db, game):
        """If an alias accidentally equals the primary, it must not fetch twice."""
        game.alias_steam_app_ids = [game.steam_app_id, 999]
        db.add(game); db.commit()
        assert _resolve_steam_appids(game) == [game.steam_app_id, 999]

    def test_string_alias_coerced_to_int(self, db, game):
        """JSON round-trips may return strings; coerce to int for the API call."""
        game.alias_steam_app_ids = ["5184670"]
        db.add(game); db.commit()
        assert _resolve_steam_appids(game) == [game.steam_app_id, 5184670]

    def test_garbage_alias_skipped_not_crash(self, db, game):
        """Non-numeric alias must be skipped, not crash the ingest step."""
        game.alias_steam_app_ids = ["not-an-int", 42, None, 0]
        db.add(game); db.commit()
        # 0 dropped by the `if a_int and ...` guard; None/"not-an-int" skipped.
        assert _resolve_steam_appids(game) == [game.steam_app_id, 42]


# ---------------------------------------------------------------------------
# _step2_steam_reviews with aliases
# ---------------------------------------------------------------------------


def _review(rid: str, text: str = "great", ts: int = 1_700_000_000) -> dict:
    """Shape returned by services.steam_service.fetch_reviews."""
    return {
        "external_id": rid,
        "author": "user_" + rid,
        "title": None,
        "body": text,
        "url": f"https://store.steampowered.com/app/x/reviews/{rid}",
        "upvotes": 0,
        "post_date": None,
        "collected_at": None,
    }


class TestStep2WithAliases:
    def test_no_aliases_calls_fetch_reviews_once(self, db, game):
        """Regression guard: pre-Landing-A behavior when there are no aliases."""
        game.alias_steam_app_ids = None
        db.add(game); db.commit()

        with patch("services.ingestor.fetch_reviews") as mock_fetch, \
             patch("services.ingestor._bulk_save_posts", return_value=0) as mock_save:
            mock_fetch.return_value = [_review("r1")]
            log_lines, errors = [], []
            saved, fetched = _step2_steam_reviews(db, game, log_lines, errors)
        assert mock_fetch.call_count == 1
        assert mock_fetch.call_args_list[0].args[0] == game.steam_app_id
        assert fetched == 1
        assert saved == 0

    def test_alias_triggers_one_call_per_appid(self, db, game):
        """With one alias, fetch_reviews must be called twice with the right appids."""
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()

        with patch("services.ingestor.fetch_reviews") as mock_fetch, \
             patch("services.ingestor._bulk_save_posts", return_value=3) as mock_save:
            mock_fetch.side_effect = [
                [_review("main_1"), _review("main_2")],
                [_review("demo_1")],
            ]
            log_lines, errors = [], []
            saved, fetched = _step2_steam_reviews(db, game, log_lines, errors)
        assert mock_fetch.call_count == 2
        # Primary first, alias second.
        assert mock_fetch.call_args_list[0].args[0] == game.steam_app_id
        assert mock_fetch.call_args_list[1].args[0] == 5184670
        # Combined batch handed to _bulk_save_posts.
        args, _ = mock_save.call_args
        # signature: (db, game_id, source, posts, errors)
        assert args[1] == game.id
        assert args[2] == SourceEnum.steam_review
        assert len(args[3]) == 3
        assert fetched == 3

    def test_alias_error_does_not_lose_primary_batch(self, db, game):
        """If the alias fetch raises, the primary batch still saves."""
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()

        with patch("services.ingestor.fetch_reviews") as mock_fetch, \
             patch("services.ingestor._bulk_save_posts", return_value=2) as mock_save:
            mock_fetch.side_effect = [
                [_review("main_1"), _review("main_2")],
                RuntimeError("Steam API blip on demo appid"),
            ]
            log_lines, errors = [], []
            saved, fetched = _step2_steam_reviews(db, game, log_lines, errors)
        assert saved == 2
        # Fetched only reflects successful batches.
        assert fetched == 2
        assert any("5184670" in e for e in errors)
        # Primary batch's rows still got to _bulk_save_posts.
        args, _ = mock_save.call_args
        assert len(args[3]) == 2

    def test_known_ids_shared_across_appids(self, db, game):
        """A review whose external_id is already known must NOT be pulled
        again by the alias appid's fetch call."""
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()

        seen_known_ids_per_call: list[set] = []

        def _capture(appid, known_ids=None):
            # Snapshot the known_ids the ingest passed us on each call.
            seen_known_ids_per_call.append(set(known_ids or set()))
            if appid == game.steam_app_id:
                return [_review("shared_1"), _review("main_only")]
            # Alias call: return the shared_1 recommendationid + a demo-only.
            return [_review("shared_1"), _review("demo_only")]

        with patch("services.ingestor.fetch_reviews", side_effect=_capture), \
             patch("services.ingestor._bulk_save_posts", return_value=0):
            log_lines, errors = [], []
            _step2_steam_reviews(db, game, log_lines, errors)

        # First call started empty. Second call must have "shared_1" and
        # "main_only" already in known_ids so the demo fetch dedups against
        # the primary batch too.
        assert seen_known_ids_per_call[0] == set()
        assert "shared_1" in seen_known_ids_per_call[1]
        assert "main_only" in seen_known_ids_per_call[1]


# ---------------------------------------------------------------------------
# _step3_steam_forums with aliases
# ---------------------------------------------------------------------------


def _forum(external_id: str, title: str = "hi") -> dict:
    return {
        "external_id": external_id,
        "author": "user",
        "title": title,
        "body": "body text",
        "url": f"https://steamcommunity.com/app/x/discussions/{external_id}",
        "upvotes": 0,
        "post_date": None,
        "collected_at": None,
    }


class TestStep3WithAliases:
    def test_no_aliases_calls_scrape_once(self, db, game):
        game.alias_steam_app_ids = None
        db.add(game); db.commit()

        with patch("services.ingestor.scrape_forum_threads", return_value=[_forum("t1")]) as mock_scrape, \
             patch("services.ingestor._bulk_save_posts", return_value=0):
            log_lines, errors = [], []
            _step3_steam_forums(db, game, log_lines, errors)
        assert mock_scrape.call_count == 1
        assert mock_scrape.call_args_list[0].args[0] == game.steam_app_id

    def test_alias_triggers_one_scrape_per_appid(self, db, game):
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()

        with patch("services.ingestor.scrape_forum_threads") as mock_scrape, \
             patch("services.ingestor._bulk_save_posts", return_value=3) as mock_save:
            mock_scrape.side_effect = [
                [_forum("main_a"), _forum("main_b")],
                [_forum("demo_a")],
            ]
            log_lines, errors = [], []
            saved, fetched = _step3_steam_forums(db, game, log_lines, errors)
        assert mock_scrape.call_count == 2
        assert mock_scrape.call_args_list[0].args[0] == game.steam_app_id
        assert mock_scrape.call_args_list[1].args[0] == 5184670
        args, _ = mock_save.call_args
        assert args[1] == game.id
        assert args[2] == SourceEnum.steam_forum
        assert len(args[3]) == 3
        assert fetched == 3

    def test_per_appid_wallclock_budget_split(self, db, game):
        """The 90s budget is divided across appids so aliased games don't
        starve later games in the queue."""
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()

        seen_budgets: list[int] = []

        def _capture(appid, **kwargs):
            seen_budgets.append(kwargs.get("wallclock_budget_s"))
            return []

        with patch("services.ingestor.scrape_forum_threads", side_effect=_capture), \
             patch("services.ingestor._bulk_save_posts", return_value=0):
            log_lines, errors = [], []
            _step3_steam_forums(db, game, log_lines, errors)
        # Two appids × 45s each = 90s total.
        assert seen_budgets == [45, 45]

    def test_alias_error_does_not_lose_primary_batch(self, db, game):
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()

        with patch("services.ingestor.scrape_forum_threads") as mock_scrape, \
             patch("services.ingestor._bulk_save_posts", return_value=2) as mock_save:
            mock_scrape.side_effect = [
                [_forum("main_a"), _forum("main_b")],
                RuntimeError("Steam forum DOM change on demo appid"),
            ]
            log_lines, errors = [], []
            saved, fetched = _step3_steam_forums(db, game, log_lines, errors)
        assert saved == 2
        assert fetched == 2
        assert any("5184670" in e for e in errors)
        args, _ = mock_save.call_args
        assert len(args[3]) == 2
