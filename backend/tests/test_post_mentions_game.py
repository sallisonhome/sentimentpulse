"""
Tests for _post_mentions_game filter (v0019, 2026-08-19).

Also asserts single-source-of-truth for _post_mentions_game and
_GENERAL_SUBREDDITS across services/reddit_service and
services/arctic_shift_service.

Bug being fixed:
  * Prior to v0019, two divergent _GENERAL_SUBREDDITS lists meant daily
    ingest treated 18 popular subs (r/pcmasterrace, r/playstation,
    r/XboxSeriesX, r/GamingLeaksAndRumours, r/truegaming, r/ShouldIbuythisgame,
    r/gamingnews, r/gamingsuggestions, r/gamedeals, r/SteamDeck, etc.)
    as DEDICATED subs \u2014 skipping the title/selftext search AND the
    _post_mentions_game filter. This silently saved 100 random posts per
    day per affected game as if they were about the game.
  * _post_mentions_game itself was too permissive: any single \u22654-char
    word from the search query matching once was enough. For games
    with common-English titles (Rideshare 'Stimulator', Docked, etc.)
    the primary keyword matched thousands of unrelated industry posts.
"""

import pytest

from services import reddit_service as rs
from services import arctic_shift_service as ass


# ----- Single-source-of-truth guards -------------------------------------

def test_post_mentions_game_is_same_function_object():
    """arctic_shift_service.py must import _post_mentions_game from
    reddit_service, not maintain its own copy. Two copies drifted before."""
    assert ass._post_mentions_game is rs._post_mentions_game


def test_arctic_shift_general_subs_includes_full_reddit_service_list():
    """ARCTIC_SHIFT_GENERAL_SUBS must be a superset (in lowercase) of
    reddit_service._GENERAL_SUBREDDITS. Otherwise daily ingest silently
    treats general subs as dedicated (the v0019 bug)."""
    rs_lower = {s.lower() for s in rs._GENERAL_SUBREDDITS}
    ass_lower = {s.lower() for s in ass.ARCTIC_SHIFT_GENERAL_SUBS}
    missing = rs_lower - ass_lower
    assert not missing, (
        f"Subs in reddit_service._GENERAL_SUBREDDITS but not in "
        f"ARCTIC_SHIFT_GENERAL_SUBS: {sorted(missing)}. The v0019 bug "
        "was exactly this divergence."
    )


def test_previously_polluted_subs_are_now_general():
    """Regression guard for the exact subs that were the 2026-08-19 bug."""
    ass_lower = {s.lower() for s in ass.ARCTIC_SHIFT_GENERAL_SUBS}
    for sub in [
        "pcmasterrace", "playstation", "xboxseriesx", "xboxone",
        "steamdeck", "nintendoswitch", "nintendo",
        "shouldibuythisgame", "gamingsuggestions", "truegaming",
        "gamedeals", "gamingleaksandrumours", "gamingnews", "gamedev",
        "retrogaming", "cozygamers", "gamecollecting", "gamingcirclejerk",
    ]:
        assert sub in ass_lower, (
            f"r/{sub} must be treated as general (case-insensitive), "
            "or daily ingest will save random non-game posts for every "
            "game that lists it as a subreddit."
        )


# ----- Path B: legacy any-word match --------------------------------------

def test_legacy_matches_when_word_present():
    post = {"title": "I love Hellraiser Revival", "body": ""}
    assert rs._post_mentions_game(post, "Hellraiser") is True


def test_legacy_rejects_when_no_word_present():
    post = {"title": "Random Cyberpunk 2077 review", "body": ""}
    assert rs._post_mentions_game(post, "Hellraiser") is False


def test_legacy_case_insensitive():
    post = {"title": "HELLRAISER is back", "body": ""}
    assert rs._post_mentions_game(post, "hellraiser") is True


def test_legacy_stopword_ignored():
    """'the'/'and'/'game' etc are stopwords \u2014 must not trigger a match
    by themselves."""
    post = {"title": "Just a random gaming post", "body": ""}
    assert rs._post_mentions_game(post, "the game") is False


def test_legacy_short_word_ignored():
    """<4 char tokens are ignored even without stopword listing."""
    post = {"title": "IP news today", "body": ""}
    # 'IP' is 2 chars — legacy path skips it
    assert rs._post_mentions_game(post, "IP") is False


def test_legacy_empty_text():
    assert rs._post_mentions_game({"title": "", "body": ""}, "hellraiser") is False


def test_legacy_body_only_match():
    post = {"title": "Random title", "body": "Actually about Hellraiser inside"}
    assert rs._post_mentions_game(post, "Hellraiser") is True


# ----- Path A: strict two-token gate --------------------------------------

def test_strict_rejects_industry_post_missing_companion():
    """The core bug being fixed: 'rideshare' matches a ride-share industry
    post, but with distinctive_keywords=['stimulator','saber'] the strict
    path rejects it because no companion keyword is present."""
    post = {"title": "Anyone else notice rideshare prices going up?", "body": ""}
    assert rs._post_mentions_game(
        post, "Rideshare",
        distinctive_keywords=["stimulator", "saber"],
    ) is False


def test_strict_keeps_post_with_primary_plus_companion():
    post = {"title": "Rideshare Stimulator is fun", "body": ""}
    assert rs._post_mentions_game(
        post, "Rideshare",
        distinctive_keywords=["stimulator", "saber"],
    ) is True


def test_strict_keeps_post_with_variant_spelling_companion():
    """Post says 'Rideshare Saber' \u2014 no 'stimulator' but 'saber' matches."""
    post = {"title": "Rideshare game by Saber Interactive", "body": ""}
    assert rs._post_mentions_game(
        post, "Rideshare",
        distinctive_keywords=["stimulator", "saber"],
    ) is True


def test_strict_rejects_when_primary_missing():
    """Even with a companion keyword, missing primary is a rejection."""
    post = {"title": "Saber Interactive announced a new game", "body": ""}
    assert rs._post_mentions_game(
        post, "Rideshare",
        distinctive_keywords=["stimulator", "saber"],
    ) is False


def test_strict_rejects_body_that_has_primary_but_body_only_companion_ok():
    """Companion CAN be in body while primary is in title (same post)."""
    post = {"title": "Rideshare is out", "body": "Saber did a great job"}
    assert rs._post_mentions_game(
        post, "Rideshare",
        distinctive_keywords=["stimulator", "saber"],
    ) is True


def test_strict_empty_distinctive_keywords_falls_back_to_legacy():
    """distinctive_keywords=[] should behave the same as None (legacy)."""
    post = {"title": "Anyone else notice rideshare prices going up?", "body": ""}
    # Legacy path: primary word 'rideshare' matches
    assert rs._post_mentions_game(post, "Rideshare", distinctive_keywords=[]) is True
    assert rs._post_mentions_game(post, "Rideshare", distinctive_keywords=None) is True


def test_strict_skips_short_distinctive_keywords():
    """<3-char keywords must be filtered so 'IP' or 'V2' can't be used
    to over-match. The distinctive_keywords normalizer drops <3 chars."""
    post = {"title": "Anyone else notice rideshare prices going up?", "body": ""}
    # Only "ip" as distinctive would leave no valid keywords \u2014 primary
    # is present but no valid companion \u2014 reject.
    assert rs._post_mentions_game(
        post, "Rideshare",
        distinctive_keywords=["ip"],
    ) is False


def test_strict_case_insensitive_companion():
    post = {"title": "Rideshare STIMULATOR release date", "body": ""}
    assert rs._post_mentions_game(
        post, "Rideshare",
        distinctive_keywords=["Stimulator"],
    ) is True


def test_strict_whitespace_only_keywords_ignored():
    """Whitespace-only entries must be filtered by the normalizer."""
    post = {"title": "Rideshare industry news", "body": ""}
    # Only whitespace entries \u2014 same as empty list \u2014 falls to legacy
    # path via the outer `if distinctive_keywords:` check which is
    # truthy for [' ', ''] but the normalizer drops them.
    # Result should be False because in Path A no valid companion exists.
    assert rs._post_mentions_game(
        post, "Rideshare",
        distinctive_keywords=[" ", ""],
    ) is False


# ----- Real-world scenarios (from the 17 affected games) ------------------

def test_real_world_rideshare_pcmasterrace_pollution():
    """The 'UPGRADE?' post from r/pcmasterrace that was tagged to Rideshare."""
    post = {"title": "UPGRADE?", "body": ""}
    assert rs._post_mentions_game(
        post, "Rideshare",
        distinctive_keywords=["stimulator", "saber"],
    ) is False


def test_real_world_hellraiser_revival_dedicated_variant():
    """A legitimate Hellraiser post from r/hellraiser \u2014 no distinctive
    keywords needed because dedicated subs skip the filter entirely."""
    post = {"title": "New footage from the game", "body": "Excited for the revival"}
    # This test verifies the OTHER path: no distinctive_keywords, legacy match
    # succeeds because 'revival' is a stopword-adjacent but present. Actually
    # 'revival' isn't in _MENTION_STOP so 'hellraiser revival' will match on
    # 'revival' alone. That's fine because dedicated subs bypass this filter.
    assert rs._post_mentions_game(post, "Hellraiser Revival") is True


def test_real_world_twisted_tower_generic_word_fine():
    """Twisted Tower has 'twisted' as its distinctive fallback \u2014 an
    unrelated post about a twisted knee wouldn't have the primary word."""
    unrelated = {"title": "I twisted my knee playing", "body": ""}
    # Primary word 'twisted' present but no distinctive_keywords set.
    # This is the legacy Path B behavior. The daily ingest tagger's
    # noise-tier verdict handles the disambiguation downstream.
    assert rs._post_mentions_game(unrelated, "Twisted") is True
    # With a distinctive_keywords companion (e.g. 'tower') it correctly rejects.
    assert rs._post_mentions_game(
        unrelated, "Twisted", distinctive_keywords=["tower"],
    ) is False
