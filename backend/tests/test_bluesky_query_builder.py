"""Unit tests for bluesky_service._build_search_query (v3, 2026-07-28).

The 2026-07-28 rewrite replaced the delegation-to-Reddit's-single-word
extractor with a Bluesky-native exact-phrase query builder. These tests
lock in the intended behavior against every real portfolio game name in
production, so future changes can't silently regress phrase-matching for
any specific title.

The upstream integration test
`test_multi_word_game_name_produces_quoted_query` already covers the
Space Marine 2 case end-to-end; this file adds unit-level assertions
for the full portfolio and edge cases.
"""
from __future__ import annotations

import pytest

from services.bluesky_service import _build_search_query


# ── Multi-word titles ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("game_name, expected", [
    # Basic multi-word: quote it
    ("Space Marine 2", '"Space Marine 2"'),
    ("John Wick", '"John Wick"'),
    ("Tempest Rising", '"Tempest Rising"'),
    ("Dakar Desert Rally", '"Dakar Desert Rally"'),
    ("Bus Bound", '"Bus Bound"'),
    ("Untitled John Wick Game", '"Untitled John Wick Game"'),

    # Colon-separated titles: colon becomes space
    ("SILENT HILL: Townfall", '"SILENT HILL Townfall"'),
    ("Turok: Origins", '"Turok Origins"'),
    ("Jurassic Park: Survival", '"Jurassic Park Survival"'),
    ("A Quiet Place: The Road Ahead", '"A Quiet Place The Road Ahead"'),
    ("Halloween: The Game", '"Halloween The Game"'),
    ("Docked - Contraband", '"Docked Contraband"'),

    # Trailing generic tail gets dropped
    ("Halo 2: Anniversary", '"Halo 2"'),
    ("Halo: Combat Evolved Anniversary", '"Halo Combat Evolved"'),
    ("Crysis 3 Remastered", '"Crysis 3"'),
    ("HITMAN Classic Trilogy Remastered", '"HITMAN Classic"'),
    # Note: 'Classic Trilogy Remastered' -> drop Remastered -> drop Trilogy
    # (both in _BSKY_GENERIC_TAIL), leaves 'HITMAN Classic'. Verified.
])
def test_multi_word_produces_quoted_phrase(game_name, expected):
    assert _build_search_query(game_name) == expected


# ── Single-word titles: NOT quoted ────────────────────────────────────────────

@pytest.mark.parametrize("game_name, expected", [
    ("Hellraiser", "Hellraiser"),
    ("Turok", "Turok"),
    ("SnowRunner", "SnowRunner"),
    ("MudRunner", "MudRunner"),
    ("RoadCraft", "RoadCraft"),
    ("Gloomhaven", "Gloomhaven"),
    ("Docked", "Docked"),
    ("Inversion", "Inversion"),
    ("ILL", "ILL"),
    ("TimeShift", "TimeShift"),
])
def test_single_word_returns_bare_no_quotes(game_name, expected):
    # Bluesky exact-phrase quoting on a single token is unnecessary and
    # some search engines treat "foo" specially (require-exact). Keep
    # single tokens bare.
    assert _build_search_query(game_name) == expected


# ── Possessive prefixes ───────────────────────────────────────────────────────

@pytest.mark.parametrize("game_name, expected", [
    # Studio/director possessive is stripped, then the actual title is quoted
    ("John Carpenter's Toxic Commando", '"Toxic Commando"'),
    ("Clive Barker's Hellraiser: Revival", '"Hellraiser Revival"'),
    # Single-token title after possessive strip: NOT quoted (single token).
    ("Sid Meier's Civilization", "Civilization"),
    # Single-word title after possessive strip: bare, no quotes
    ("Someone's Hellraiser", "Hellraiser"),
])
def test_possessive_prefix_is_stripped(game_name, expected):
    assert _build_search_query(game_name) == expected


# ── Trademark symbols + punctuation ───────────────────────────────────────────

@pytest.mark.parametrize("game_name, expected", [
    # \u2122 / \u00ae / \u00a9 must be removed silently
    ("TimeShift\u2122", "TimeShift"),
    ("Inversion\u2122", "Inversion"),
    # Multi-word with trademark
    ("Warhammer 40,000: Space Marine 2", '"Warhammer 40 000 Space Marine 2"'),
    # Colons AND commas both normalize to spaces
    ("Ghostbusters: The Video Game Remastered", '"Ghostbusters The Video Game"'),
])
def test_punctuation_and_trademark_symbols_normalized(game_name, expected):
    assert _build_search_query(game_name) == expected



# ── Edge cases ────────────────────────────────────────────────────────────────

def test_all_generic_tail_returns_fallback():
    # If EVERYTHING is generic edition-tail (unlikely in practice), we
    # must not return an empty query — that would search Bluesky's
    # global firehose. Verify non-empty.
    result = _build_search_query("Anniversary Edition Remastered")
    assert result, "never return empty query"


def test_empty_string_does_not_crash():
    # Defensive: don't crash on a blank game_name.
    result = _build_search_query("")
    assert isinstance(result, str)


def test_only_punctuation_does_not_crash():
    # Defensive: don't crash if the game name is somehow pure punctuation.
    result = _build_search_query(":—–,")
    assert isinstance(result, str)


def test_leading_generic_is_kept():
    # 'Ultimate' at the START of a title is part of the title, not a
    # tail marker. Must NOT be stripped — otherwise "Ultimate Marvel vs
    # Capcom 3" would become "Marvel vs Capcom 3" and we'd miss fans
    # who use the full canonical name.
    result = _build_search_query("Ultimate Marvel vs Capcom 3")
    assert result == '"Ultimate Marvel vs Capcom 3"'


# ── distinctive_keywords path (2026-07-28 quality fix) ─────────────────────

def test_distinctive_keywords_overrides_name_based_query():
    # For ambiguous single-word titles like Inversion, distinctive_keywords
    # must be used as an OR of quoted phrases instead of the raw title.
    result = _build_search_query(
        "Inversion",
        distinctive_keywords=["Inversion 2012", "Saber Inversion", "Airtight Games"],
    )
    # Order must be preserved (deterministic), each phrase quoted, joined with ' OR '.
    assert result == '"Inversion 2012" OR "Saber Inversion" OR "Airtight Games"'


def test_distinctive_keywords_single_entry_still_quoted():
    # Even a single distinctive keyword must be quoted — the caller passed
    # it as a distinct signal, not a fallback.
    result = _build_search_query(
        "Docked",
        distinctive_keywords=["Docked Contraband"],
    )
    assert result == '"Docked Contraband"'


def test_distinctive_keywords_caps_at_8():
    # Bluesky's query string has an implicit ~500 char limit. Cap at 8
    # keywords so a runaway keyword list can't hit that limit.
    kws = [f"keyword{i}" for i in range(20)]
    result = _build_search_query("Anything", distinctive_keywords=kws)
    # Should contain exactly 8 quoted keywords
    assert result.count(" OR ") == 7
    assert '"keyword0"' in result
    assert '"keyword7"' in result
    assert '"keyword8"' not in result


def test_empty_distinctive_keywords_falls_back_to_name():
    # Empty list must fall back to name-based behavior, not crash and not
    # return empty.
    result = _build_search_query("Hellraiser", distinctive_keywords=[])
    assert result == "Hellraiser"


def test_none_distinctive_keywords_falls_back_to_name():
    # None also falls back — same as not passing it at all.
    result = _build_search_query("Hellraiser", distinctive_keywords=None)
    assert result == "Hellraiser"


def test_distinctive_keywords_ignores_blank_entries():
    # Blank/whitespace entries must be silently skipped (defensive against
    # sloppy operator input).
    result = _build_search_query(
        "Anything",
        distinctive_keywords=["real keyword", "", "  ", "another one"],
    )
    assert result == '"real keyword" OR "another one"'
