"""2026-07-31 regression guard: OR-joined distinctive_keywords silently
returned zero Bluesky results for every portfolio game.

Bug: `_build_search_query` produced queries like

    "Space Marine 2" OR "SM2" OR "WH40K Space Marine 2"

but Bluesky's app.bsky.feed.searchPosts endpoint treats `OR` as a
literal word to match — not a boolean operator. Every query with
`OR` in it therefore returned HTTP 200 with an empty result set,
and the ingester logged `posts=0 pages=1 status=ok` for every
game across the daily cron. The `bluesky_health=silent` verdict
correctly flagged the regression, but the code kept the broken
query shape.

Only Rideshare "Stimulator" (distinctive_keywords=NULL) still
worked because it hit the game-name fallback path.

This file guards against:

1. `OR` never appearing in an outgoing search query, regardless of
    how many distinctive_keywords are passed.
2. The first distinctive_keyword being the one used as the search
    query (phrase-quoted when multi-token, bare when single-token).
3. Every real portfolio game producing a Bluesky-valid, non-empty,
    OR-free query.
"""
from __future__ import annotations

from typing import Iterable

import pytest

from services.bluesky_service import _build_search_query


# Real portfolio (as of 2026-07-31) plus the exact distinctive_keywords
# that were live in production. If someone adds a new game they should
# add it here so the OR guard covers it too.
_PORTFOLIO_KW_FIXTURES: list[tuple[str, list[str]]] = [
    (
        "Warhammer 40,000: Space Marine 2",
        ["Space Marine 2", "SM2", "Warhammer Space Marine 2",
         "WH40K Space Marine 2", "Space Marine II", "SpaceMarine2",
         "Space Marne 2", "Warhammer 40k Space Marine 2",
         "Space Marine 2 game"],
    ),
    ("SILENT HILL: Townfall", ["SILENT HILL Townfall", "SH Townfall", "Townfall SH"]),
    ("Halloween: The Game", ["Halloween The Game", "Halloween Illfonic", "Halloween Gun Media"]),
    ("ILL", ["ILL Team Clout", "ILL horror game", "ILL Mundfish"]),
    ("Docked - Contraband", ["Docked Contraband", "Docked Saber"]),
    ("Inversion", ["Inversion 2012", "Saber Inversion", "Airtight Games"]),
    ("Clive Barker's Hellraiser: Revival", ["Hellraiser Revival"]),
    ("Untitled John Wick Game", ["Untitled John Wick Game", "John Wick game Saber"]),
    ("Jurassic Park: Survival", ["Jurassic Park Survival"]),
    ("Turok: Origins", ["Turok Origins"]),
]


class TestNoORInSearchQuery:
    """The core invariant: no outgoing Bluesky query may contain ` OR `."""

    @pytest.mark.parametrize("game_name, kws", _PORTFOLIO_KW_FIXTURES)
    def test_portfolio_game_produces_or_free_query(self, game_name, kws):
        q = _build_search_query(game_name, distinctive_keywords=kws)
        assert " OR " not in q, (
            f"Bluesky query for game={game_name!r} contains ' OR ' — this "
            f"will silently return zero results. Got: {q!r}"
        )

    def test_no_or_when_10_keywords_passed(self):
        kws = [f"kw {i}" for i in range(10)]
        q = _build_search_query("Anything", distinctive_keywords=kws)
        assert " OR " not in q
        # And should be just the first one, quoted
        assert q == '"kw 0"'

    def test_no_or_when_a_keyword_contains_or_substring(self):
        # A keyword like "Bornholm" contains 'orn' but no ` OR `. Guard
        # against future implementations that accidentally reintroduce
        # a substring bug.
        q = _build_search_query("Anything", distinctive_keywords=["Bornholm"])
        assert " OR " not in q
        assert q == "Bornholm"


class TestFirstKeywordSemantics:
    """The first keyword is the search query. Everything else is post-filter."""

    def test_multi_token_first_kw_is_quoted(self):
        q = _build_search_query(
            "Anything",
            distinctive_keywords=["First Keyword Phrase", "second thing"],
        )
        assert q == '"First Keyword Phrase"'

    def test_single_token_first_kw_is_not_quoted(self):
        q = _build_search_query(
            "Anything",
            distinctive_keywords=["OneWord", "other stuff"],
        )
        assert q == "OneWord"

    def test_first_kw_wins_even_when_later_kws_shorter(self):
        # Guard against a future "pick shortest" heuristic that would
        # silently change the semantic contract.
        q = _build_search_query(
            "Anything",
            distinctive_keywords=["Long Distinctive Phrase", "short"],
        )
        assert q == '"Long Distinctive Phrase"'


class TestFallbackWhenNoKeywords:
    """Ensure the OR-free change didn't break the no-keyword fallback."""

    def test_none_keywords_uses_game_name(self):
        assert _build_search_query("Space Marine 2", distinctive_keywords=None) == '"Space Marine 2"'

    def test_empty_list_uses_game_name(self):
        assert _build_search_query("Space Marine 2", distinctive_keywords=[]) == '"Space Marine 2"'

    def test_all_blank_kws_uses_game_name(self):
        assert _build_search_query("Space Marine 2", distinctive_keywords=["", "  ", "\t"]) == '"Space Marine 2"'
