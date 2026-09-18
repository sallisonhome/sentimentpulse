"""Tests for the alias-appid loop in historical backfill helpers.

Landing A.1 of the 2026-09-18 parent/child support work. Extends the two
steam backfill helpers (backfill_steam_reviews_for_game,
backfill_steam_forums_for_game) so a game with alias_steam_app_ids
walks the primary appid AND each alias, writing all rows under the
same game.id.

Companion to Landing A which did the same for the DAILY cron path
(_step2_steam_reviews, _step3_steam_forums).
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from scripts.historical_backfill import (
    backfill_steam_forums_for_game,
    backfill_steam_reviews_for_game,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _forum_post(external_id: str, ts_epoch: int) -> dict:
    return {
        "external_id": external_id,
        "author": "u",
        "title": "hi",
        "body": "body",
        "url": f"https://steamcommunity.com/app/x/discussions/{external_id}",
        "upvotes": 0,
        "post_date": datetime.fromtimestamp(ts_epoch, tz=timezone.utc).replace(tzinfo=None),
    }


def _reviews_page(ids: list[str], ts_epoch: int, cursor_next: str = "") -> dict:
    """Shape returned by store.steampowered.com/appreviews/{appid}?json=1."""
    return {
        "reviews": [
            {
                "recommendationid": rid,
                "review": f"review body {rid}",
                "author": {"steamid": f"user_{rid}"},
                "votes_up": 0,
                "timestamp_created": ts_epoch,
            }
            for rid in ids
        ],
        "cursor": cursor_next,
    }


# ---------------------------------------------------------------------------
# backfill_steam_forums_for_game with aliases
# ---------------------------------------------------------------------------


class TestBackfillForumsWithAliases:
    def test_no_aliases_calls_scrape_once(self, db, game):
        game.alias_steam_app_ids = None
        db.add(game); db.commit()
        start_dt = datetime(2026, 8, 1, tzinfo=timezone.utc)
        # scrape_forum_threads returns two in-window posts.
        recent_ts = int(datetime(2026, 9, 1).timestamp())
        with patch("scripts.historical_backfill.scrape_forum_threads",
                   return_value=[_forum_post("f1", recent_ts), _forum_post("f2", recent_ts)]) as mock_scrape, \
             patch("scripts.historical_backfill._bulk_save_posts", return_value=2) as mock_save:
            saved = backfill_steam_forums_for_game(db, game, start_dt, [])
        assert mock_scrape.call_count == 1
        # Called with the primary appid.
        assert mock_scrape.call_args_list[0].args[0] == game.steam_app_id
        assert saved == 2

    def test_alias_triggers_one_scrape_per_appid(self, db, game):
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()
        start_dt = datetime(2026, 8, 1, tzinfo=timezone.utc)
        recent_ts = int(datetime(2026, 9, 1).timestamp())

        with patch("scripts.historical_backfill.scrape_forum_threads") as mock_scrape, \
             patch("scripts.historical_backfill._bulk_save_posts", return_value=1) as mock_save:
            mock_scrape.side_effect = [
                [_forum_post("main_a", recent_ts)],
                [_forum_post("demo_a", recent_ts), _forum_post("demo_b", recent_ts)],
            ]
            saved = backfill_steam_forums_for_game(db, game, start_dt, [])
        assert mock_scrape.call_count == 2
        # Primary first, alias second.
        assert mock_scrape.call_args_list[0].args[0] == game.steam_app_id
        assert mock_scrape.call_args_list[1].args[0] == 5184670
        # 1 (main) + 1 (demo call) = 2 save calls, each returning 1.
        assert saved == 2

    def test_per_appid_wallclock_budget_split(self, db, game):
        """15-min budget must split across appids so an aliased game
        doesn't silently starve one of its own appids on the fetch."""
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()
        start_dt = datetime(2026, 8, 1, tzinfo=timezone.utc)
        seen_budgets: list[int] = []

        def _capture(appid, **kwargs):
            seen_budgets.append(kwargs.get("wallclock_budget_s"))
            return []

        with patch("scripts.historical_backfill.scrape_forum_threads", side_effect=_capture), \
             patch("scripts.historical_backfill._bulk_save_posts", return_value=0):
            backfill_steam_forums_for_game(db, game, start_dt, [])
        # Two appids → each gets max(5min, 15min/2) = 7.5min = 450s each.
        assert seen_budgets == [450, 450]

    def test_alias_error_does_not_lose_primary_batch(self, db, game):
        """If the alias fetch raises, the primary batch still saves."""
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()
        start_dt = datetime(2026, 8, 1, tzinfo=timezone.utc)
        recent_ts = int(datetime(2026, 9, 1).timestamp())

        with patch("scripts.historical_backfill.scrape_forum_threads") as mock_scrape, \
             patch("scripts.historical_backfill._bulk_save_posts", return_value=2) as mock_save:
            mock_scrape.side_effect = [
                [_forum_post("main_a", recent_ts), _forum_post("main_b", recent_ts)],
                RuntimeError("demo forum DOM change"),
            ]
            errors: list[str] = []
            saved = backfill_steam_forums_for_game(db, game, start_dt, errors)
        # Primary batch's saves still count.
        assert saved == 2
        assert any("5184670" in e for e in errors)


# ---------------------------------------------------------------------------
# backfill_steam_reviews_for_game with aliases
# ---------------------------------------------------------------------------


class TestBackfillReviewsWithAliases:
    def _stub_httpx_get(self, per_call_payloads: list[dict]):
        """Return a fake httpx.get whose responses come from per_call_payloads."""
        call_index = {"i": 0}

        def _get(url, params=None, timeout=None):
            i = call_index["i"]
            call_index["i"] += 1
            payload = per_call_payloads[i] if i < len(per_call_payloads) else {"reviews": [], "cursor": ""}
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = payload
            return resp

        return _get, call_index

    def test_no_aliases_hits_only_primary(self, db, game):
        game.alias_steam_app_ids = None
        db.add(game); db.commit()
        start_dt = datetime(2026, 8, 1, tzinfo=timezone.utc)
        recent_ts = int(datetime(2026, 9, 1).timestamp())

        # One page of 2 reviews then empty cursor to terminate.
        get_stub, counter = self._stub_httpx_get([_reviews_page(["r1", "r2"], recent_ts)])
        with patch("scripts.historical_backfill.httpx.get", side_effect=get_stub) as mock_get, \
             patch("scripts.historical_backfill._bulk_save_posts", return_value=2) as mock_save, \
             patch("scripts.historical_backfill.time.sleep"):  # skip 1s sleep
            saved = backfill_steam_reviews_for_game(db, game, start_dt, [])
        # One httpx.get call for the one page; url must include the primary appid.
        assert mock_get.call_count == 1
        url = mock_get.call_args_list[0].args[0]
        assert str(game.steam_app_id) in url
        assert saved == 2

    def test_alias_triggers_full_walk_of_both_appids(self, db, game):
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()
        start_dt = datetime(2026, 8, 1, tzinfo=timezone.utc)
        recent_ts = int(datetime(2026, 9, 1).timestamp())

        # 4 calls total: primary appid gets 1 page (2 reviews), alias appid
        # gets 1 page (3 reviews). Both terminate on empty cursor.
        pages = [
            _reviews_page(["main_r1", "main_r2"], recent_ts),
            _reviews_page(["demo_r1", "demo_r2", "demo_r3"], recent_ts),
        ]
        get_stub, _ = self._stub_httpx_get(pages)
        with patch("scripts.historical_backfill.httpx.get", side_effect=get_stub) as mock_get, \
             patch("scripts.historical_backfill._bulk_save_posts") as mock_save, \
             patch("scripts.historical_backfill.time.sleep"):
            # save returns count of the batch it receives so we can check summing
            mock_save.side_effect = lambda db, gid, source, posts, errors: len(posts)
            saved = backfill_steam_reviews_for_game(db, game, start_dt, [])
        # Two appid walks, one httpx.get per walk (page returns then empty cursor).
        assert mock_get.call_count == 2
        primary_url = mock_get.call_args_list[0].args[0]
        alias_url = mock_get.call_args_list[1].args[0]
        assert str(game.steam_app_id) in primary_url
        assert "5184670" in alias_url
        # 2 primary + 3 alias = 5 reviews saved.
        assert saved == 5

    def test_alias_http_error_does_not_lose_primary_batch(self, db, game):
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()
        start_dt = datetime(2026, 8, 1, tzinfo=timezone.utc)
        recent_ts = int(datetime(2026, 9, 1).timestamp())

        # Primary returns a page. Alias raises.
        primary_page = _reviews_page(["main_r1"], recent_ts)

        def _get(url, params=None, timeout=None):
            if "5184670" in url:
                raise RuntimeError("demo API blip")
            resp = MagicMock(); resp.status_code = 200; resp.json.return_value = primary_page
            return resp

        with patch("scripts.historical_backfill.httpx.get", side_effect=_get), \
             patch("scripts.historical_backfill._bulk_save_posts", side_effect=lambda db, gid, s, p, e: len(p)), \
             patch("scripts.historical_backfill.time.sleep"):
            errors: list[str] = []
            saved = backfill_steam_reviews_for_game(db, game, start_dt, errors)
        assert saved == 1  # only the primary's row
        assert any("5184670" in e for e in errors)

    def test_writes_all_reviews_under_the_same_game_id(self, db, game):
        game.alias_steam_app_ids = [5184670]
        db.add(game); db.commit()
        start_dt = datetime(2026, 8, 1, tzinfo=timezone.utc)
        recent_ts = int(datetime(2026, 9, 1).timestamp())
        pages = [
            _reviews_page(["main_r1"], recent_ts),
            _reviews_page(["demo_r1", "demo_r2"], recent_ts),
        ]
        get_stub, _ = self._stub_httpx_get(pages)

        seen_game_ids: list[int] = []

        def _save(db_arg, gid, source, posts, errors):
            seen_game_ids.append(gid)
            return len(posts)

        with patch("scripts.historical_backfill.httpx.get", side_effect=get_stub), \
             patch("scripts.historical_backfill._bulk_save_posts", side_effect=_save), \
             patch("scripts.historical_backfill.time.sleep"):
            backfill_steam_reviews_for_game(db, game, start_dt, [])
        # Every save call was under game.id (parent), never under the alias appid.
        assert all(gid == game.id for gid in seen_game_ids)
