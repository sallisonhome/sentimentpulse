"""Tests for the 2026-09-19 Steam ingest coverage bumps.

Motivated by the Hellraiser Revival demo underfetching:
- Steam reported 940 total demo reviews / 883 positive; we had 638 English
  rows in DB (English-only + 500-per-run cap were the constraints).
- Steam demo forum listing redirects to the store page (no real demo
  forum exists); all demo-related forum activity is on the MAIN game's
  forum (appid 1551980). Main forum had ~347 posts in past 24h, our
  cron saved 41 (45s wallclock/appid ran out at post #46).

Three changes ship together:
- F1: `_step3_steam_forums` total_budget_s 90 -> 180.
- F2: `fetch_reviews` max_pages 5 -> 10.
- F3: `fetch_reviews` default language 'english' -> 'all'.
"""
from __future__ import annotations

import inspect
from unittest.mock import patch

from services import ingestor
from services.steam_service import fetch_reviews


# ---------------------------------------------------------------------------
# F2 + F3: fetch_reviews defaults
# ---------------------------------------------------------------------------


class TestFetchReviewsDefaults:
    def test_default_max_pages_is_ten(self):
        sig = inspect.signature(fetch_reviews)
        assert sig.parameters["max_pages"].default == 10, (
            "F2: max_pages default must be 10 (per-appid per-run cap 1000)"
        )

    def test_default_language_is_all(self):
        sig = inspect.signature(fetch_reviews)
        assert sig.parameters["language"].default == "all", (
            "F3: default language must be 'all' — English-only was leaving "
            "the non-English demo review tail on the floor."
        )

    def test_language_is_still_overrideable(self):
        """Regression guard: callers who explicitly want English (e.g. a
        legacy backfill) can still ask for it."""
        with patch("services.steam_service._get") as mock_get:
            mock_get.return_value = None  # short-circuit the walk
            fetch_reviews(1551980, language="english")
        # Assert the URL params included language=english.
        _, kwargs = mock_get.call_args
        assert kwargs["params"]["language"] == "english"

    def test_default_call_uses_all_languages_on_the_wire(self):
        with patch("services.steam_service._get") as mock_get:
            mock_get.return_value = None
            fetch_reviews(1551980)
        _, kwargs = mock_get.call_args
        assert kwargs["params"]["language"] == "all"


# ---------------------------------------------------------------------------
# F1: forum wallclock budget
# ---------------------------------------------------------------------------


class TestForumBudget:
    """The budget change is baked into _step3_steam_forums as a literal
    constant. Assert the effective per-appid budget the ingestor computes
    for 1-appid and 2-appid games — this is the number that ends up being
    passed to scrape_forum_threads(wallclock_budget_s=...).
    """

    def _budget_for_n_appids(self, n_appids: int) -> int:
        """Re-derive what _step3_steam_forums computes for N appids by
        reading the source of the function and running the arithmetic.
        This keeps the test resilient to file layout changes while still
        binding to the constants that ship."""
        src = inspect.getsource(ingestor._step3_steam_forums)
        # Extract the numeric constant assigned to total_budget_s.
        import re
        m = re.search(r"total_budget_s\s*=\s*(\d+)", src)
        assert m, "total_budget_s literal not found in _step3_steam_forums"
        total = int(m.group(1))
        return max(30, total // n_appids)

    def test_solo_game_gets_180s_per_appid(self):
        assert self._budget_for_n_appids(1) == 180, (
            "F1: solo-appid games must get the full 180s budget"
        )

    def test_aliased_game_gets_90s_per_appid(self):
        assert self._budget_for_n_appids(2) == 90, (
            "F1: 2-appid games must get 90s each (was 45s, only walked "
            "~13 threads before hitting the cap on Hellraiser main forum)"
        )

    def test_extreme_aliased_game_hits_the_floor(self):
        """8-appid game: 180 // 8 = 22, floor of 30 wins."""
        assert self._budget_for_n_appids(8) == 30
