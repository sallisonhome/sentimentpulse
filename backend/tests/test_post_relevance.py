"""
Tests for the §14 post-relevance filter (post_relevance.py).

CLAUDE.md §14: posts must be substantively *about* the focal game, not merely
*mentioning* the underlying IP, movie, or brand.

Critical test case (must pass): the "Survival Horror" John Wick post.
  title: "When just one guy one of my favourite Survival Horror games in years."
  body contains "Wicked Seed"
  → filter MUST exclude it (not relevant to Untitled John Wick Game)
"""
import pytest
from unittest.mock import MagicMock

from services.post_relevance import is_post_relevant_to_game, GAME_KEYWORD_FALLBACK


# ── Helper: make a fake Game object ──────────────────────────────────────────

def _make_game(name: str, keywords=None) -> MagicMock:
    """Create a mock Game with a given name and optional distinctive_keywords."""
    g = MagicMock()
    g.name = name
    g.distinctive_keywords = keywords  # None → will use fallback registry
    return g


# ── The critical test case from the task spec ─────────────────────────────────

class TestJohnWickSurvivalHorrorCriticalCase:
    """
    This is the case that prompted §14:
    A post about a *survival horror game* ending up attributed to the
    "Untitled John Wick Game" purely because the word "Wicked" (or "Wick")
    triggered a keyword match, while the post is clearly about a horror game.
    """

    def test_survival_horror_post_with_wicked_seed_excluded(self):
        """
        The exact case from the task spec:
          title = 'When just one guy one of my favourite Survival Horror games in years.'
          body contains 'Wicked Seed'

        The keyword 'wick' in the fallback registry must NOT match 'Wicked'.
        Even if it did, 'Wicked Seed' is a horror game — not the John Wick game.
        The filter MUST return False.
        """
        game = _make_game("Untitled John Wick Game")
        title = "When just one guy one of my favourite Survival Horror games in years."
        body = (
            "I just finished Wicked Seed and it's absolutely terrifying. "
            "The atmosphere is incredible and the jump scares are perfectly timed. "
            "This might be the best indie horror I've played this year."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, (
            "Survival Horror post mentioning 'Wicked Seed' should be EXCLUDED "
            "from the John Wick Game — 'Wicked' is not a whole-word match for 'wick'."
        )

    def test_wicked_does_not_match_wick_keyword(self):
        """
        'wick' as a keyword must not match 'Wicked' — whole-word boundary check.
        """
        game = _make_game("Untitled John Wick Game")
        title = "Wicked games are so fun"
        body = "A long enough body text about playing wicked games with friends online."
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, (
            "'Wicked' must not trigger whole-word match for keyword 'wick'."
        )

    def test_wickedly_does_not_match_wick_keyword(self):
        """'wickedly' must not match keyword 'wick'."""
        game = _make_game("Untitled John Wick Game")
        title = "Wickedly hard level design"
        body = (
            "The level design is wickedly clever in this game. "
            "I loved every moment of it. Highly recommended for action fans."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False


# ── Real John Wick game posts that SHOULD be relevant ─────────────────────────

class TestJohnWickGamePositiveCases:
    """Posts that are genuinely about the Untitled John Wick Game — must pass."""

    def test_explicit_game_mention(self):
        """Post using 'John Wick game' explicitly — must be INCLUDED."""
        game = _make_game("Untitled John Wick Game")
        title = "John Wick game impressions after 10 hours"
        body = (
            "I've been playing the John Wick game for about 10 hours now and "
            "the combat system is unlike anything I've tried before. "
            "The way you chain kills is so satisfying."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is True, "Explicit 'John Wick game' mention should be INCLUDED."

    def test_continental_keyword(self):
        """Post using 'Continental game' — must be INCLUDED."""
        game = _make_game("Untitled John Wick Game")
        title = "The Continental game is finally here"
        body = (
            "Been waiting for the Continental game for ages. "
            "The assassin mechanics are buttery smooth and the level design is top tier. "
            "Can't believe how good it runs on PC."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is True, "'Continental game' keyword should trigger inclusion."

    def test_bithell_john_wick_keyword(self):
        """Post about Bithell's John Wick game — must be INCLUDED."""
        game = _make_game("Untitled John Wick Game")
        title = "Bithell John Wick is actually phenomenal"
        body = (
            "Bithell John Wick dropped this week and I'm genuinely impressed. "
            "The strategic action gameplay pairs perfectly with the IP. "
            "Really recommend picking this one up at launch."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is True, "'Bithell John Wick' keyword should trigger inclusion."

    def test_wick_assassin_game_keyword(self):
        """Post using 'Wick assassin game' — must be INCLUDED."""
        game = _make_game("Untitled John Wick Game")
        title = "Loving the Wick assassin game"
        body = (
            "The Wick assassin game really nails the feeling of being an unstoppable force. "
            "Each level is challenging but fair. The boss encounters are especially memorable."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is True, "'Wick assassin game' keyword should trigger inclusion."


# ── Movie / IP cue near keyword → excluded ────────────────────────────────────

class TestMovieIPCueExclusion:
    """Posts where the keyword match is surrounded by movie/IP context."""

    def test_just_watched_movie_context(self):
        """Post about the film using 'John Wick game' in comparison — should be excluded."""
        game = _make_game("Untitled John Wick Game")
        title = "John Wick 4 is amazing"
        body = (
            "Just watched John Wick 4 and Keanu absolutely kills it again. "
            "After watching I looked up the John Wick game but honestly the movie "
            "is so much better. Chapter 4 raised the bar."
        )
        result = is_post_relevant_to_game(title, body, game)
        # "Just watched" near "John Wick game" → IP cue present → should exclude
        assert result is False, (
            "Post where 'just watched' appears near the keyword should be excluded."
        )

    def test_keanu_context(self):
        """Post primarily about Keanu Reeves should be excluded."""
        game = _make_game("Untitled John Wick Game")
        title = "Why Keanu Reeves is the best action star"
        body = (
            "Keanu Reeves in the John Wick film series is peak cinema. "
            "Chapter 2 is my favourite. The fight choreography is unreal."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, "Keanu + film-focused post should be excluded."

    def test_film_keyword_near_match(self):
        """'film' keyword near the match should trigger exclusion."""
        game = _make_game("Untitled John Wick Game")
        title = "Comparing John Wick game to the film"
        body = (
            "The John Wick game looks inspired by the film franchise. "
            "Having now played 2 hours, the film definitely does the action better. "
            "The movie sequences are breathtaking."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, "'film' near keyword match should trigger exclusion."


# ── Edge cases ────────────────────────────────────────────────────────────────

class TestEdgeCases:

    def test_empty_title_and_body_excluded(self):
        """Empty post → NOT relevant."""
        game = _make_game("Untitled John Wick Game")
        result = is_post_relevant_to_game("", "", game)
        assert result is False

    def test_none_title_and_body_excluded(self):
        """None title and body → NOT relevant."""
        game = _make_game("Untitled John Wick Game")
        result = is_post_relevant_to_game(None, None, game)
        assert result is False

    def test_very_short_text_excluded(self):
        """Text < 30 chars → NOT relevant regardless of keyword."""
        game = _make_game("Untitled John Wick Game")
        result = is_post_relevant_to_game("John Wick game", "", game)
        # Combined text is only 14 chars → too short
        assert result is False

    def test_just_the_game_name_excluded(self):
        """Just the game name alone (too short) → NOT relevant."""
        game = _make_game("Untitled John Wick Game")
        result = is_post_relevant_to_game("Untitled John Wick Game", "", game)
        # 23 chars → below 30
        assert result is False

    def test_game_name_with_minimal_body_excluded(self):
        """Game name as title + very short body → NOT relevant."""
        game = _make_game("Untitled John Wick Game")
        result = is_post_relevant_to_game("John Wick game", "nice", game)
        # "John Wick game nice" → 19 chars → too short
        assert result is False

    def test_no_keywords_configured_blocks_all(self):
        """
        v2 (2026-07-24): games with no keywords configured (no DB column, no
        fallback) are now gated OUT — the old 'pass all through' escape hatch
        was removed because it silently classified sentiment for games with
        zero relevance signal.
        """
        game = _make_game("Unknown Indie Game XYZ 2099")  # not in fallback
        game.distinctive_keywords = None
        title = "This game is amazing and I love it so much"
        body = (
            "The level design is fantastic and the combat system is really well polished. "
            "Highly recommend to anyone who enjoys action games."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, "Games without keywords must now be filtered out, not passed through."

    def test_custom_db_keywords_override_fallback(self):
        """Game.distinctive_keywords from DB is used instead of fallback registry."""
        game = _make_game("Some Game", keywords=["unique_phrase_xyz", "another phrase"])
        title = "I love unique_phrase_xyz in this game"
        body = (
            "The unique_phrase_xyz mechanic is so well designed and satisfying to use. "
            "Best game I've played this year by a wide margin."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is True, "Custom DB keywords should be used for matching."

    def test_custom_multiword_phrase_matches(self):
        """Multi-word keyword from DB must match as a whole phrase."""
        game = _make_game("Some Game", keywords=["magic sword adventure"])
        title = "This magic sword adventure is incredible"
        body = (
            "Magic sword adventure really nails the fantasy genre. "
            "The progression system keeps you hooked for hours on end."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is True

    def test_partial_multiword_does_not_match(self):
        """Only part of a multi-word keyword present → NOT relevant."""
        game = _make_game("Some Game", keywords=["magic sword adventure"])
        title = "Magic swords are cool in fantasy games"
        body = (
            "I love how fantasy games handle magic swords and enchantments. "
            "The best mechanic in RPGs hands down without any doubt at all."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, "Partial phrase match should not pass."


# ── Halo MCC-specific tests ───────────────────────────────────────────────────

class TestHaloMCC:
    """Halo: The Master Chief Collection keyword tests."""

    def test_mcc_abbreviation_matches(self):
        """'MCC' abbreviation should match for Halo MCC."""
        game = _make_game("Halo: The Master Chief Collection")
        title = "MCC is the best way to play classic Halo"
        body = (
            "The MCC package is incredible value. Six campaigns, thousands of "
            "multiplayer maps, and cross-play with PC players. Highly recommended."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is True

    def test_master_chief_collection_phrase_matches(self):
        """Full 'Master Chief Collection' phrase should match."""
        game = _make_game("Halo: The Master Chief Collection")
        title = "Master Chief Collection patch notes are out"
        body = (
            "The Master Chief Collection just dropped a major update. "
            "New anti-cheat, performance improvements, and three new maps. "
            "The team is clearly committed to this game long-term."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is True

    def test_halo_alone_does_not_match_without_qualifier(self):
        """'Halo' alone should NOT match for MCC (too generic)."""
        game = _make_game("Halo: The Master Chief Collection")
        title = "Halo is still the king of FPS games"
        body = (
            "Halo defined an entire generation of gaming and still holds up today. "
            "The franchise has something for everyone from casual to competitive."
        )
        result = is_post_relevant_to_game(title, body, game)
        # "Halo" alone is not in MCC's distinctive_keywords → no match
        assert result is False, "'Halo' alone should not match MCC keywords."


# ── Cross-genre contamination ─────────────────────────────────────────────────

class TestCrossGenreContamination:
    """Posts about horror games that mention the John Wick game in passing."""

    def test_horror_genre_comparison_excluded(self):
        """
        Post mentioning Resident Evil + Silent Hill + John Wick game:
        The John Wick game belongs to action/stealth; Resident Evil and Silent Hill
        are horror-only → ≥2 other-genre titles → cross-genre contaminated.
        """
        game = _make_game("Untitled John Wick Game")
        title = "Best horror games of the decade"
        body = (
            "Resident Evil Village set the new standard for horror, and Silent Hill 2 "
            "remake is genuinely terrifying. Some people mention the John Wick game "
            "but that doesn't belong in this horror list at all in my opinion."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, (
            "Post with ≥2 horror-genre titles (different from action/stealth) "
            "should be excluded even if John Wick game keyword appears."
        )

    def test_stealth_comparison_allowed(self):
        """
        Post mentioning Hitman + John Wick game + Dishonored:
        Both Hitman and Dishonored share stealth/action genre with John Wick game
        → NOT cross-genre contaminated → should be included.
        """
        game = _make_game("Untitled John Wick Game")
        title = "Best stealth games to play after John Wick game"
        body = (
            "If you loved the John Wick game, check out Hitman and Dishonored. "
            "They share that same fluid, player-agency-driven stealth action loop "
            "that makes the genre so satisfying. All worth your time."
        )
        result = is_post_relevant_to_game(title, body, game)
        # Hitman and Dishonored share stealth genre with JW game → no cross-genre reject
        assert result is True, (
            "Same-genre comparison (stealth/action) should not trigger exclusion."
        )


# ── Fallback registry completeness check ──────────────────────────────────────

class TestFallbackRegistry:

    def test_fallback_has_john_wick_game(self):
        assert "Untitled John Wick Game" in GAME_KEYWORD_FALLBACK
        kws = GAME_KEYWORD_FALLBACK["Untitled John Wick Game"]
        assert len(kws) >= 2
        # Must include the multi-word phrase from the spec
        assert any(" " in k for k in kws), (
            "John Wick game must have at least one multi-word keyword to avoid "
            "matching common words like 'wick'."
        )

    def test_fallback_has_halo_mcc(self):
        assert "Halo: The Master Chief Collection" in GAME_KEYWORD_FALLBACK
        kws = GAME_KEYWORD_FALLBACK["Halo: The Master Chief Collection"]
        assert "MCC" in kws or any("MCC" in k for k in kws)

    def test_fallback_has_docked(self):
        assert "Docked" in GAME_KEYWORD_FALLBACK
        kws = GAME_KEYWORD_FALLBACK["Docked"]
        # All keywords must be multi-word (single-word "Docked" is too ambiguous)
        for k in kws:
            assert " " in k, (
                f"Docked keyword '{k}' must be multi-word (ambiguous single-word title)."
            )

    def test_fallback_has_inversion(self):
        assert "Inversion" in GAME_KEYWORD_FALLBACK
        kws = GAME_KEYWORD_FALLBACK["Inversion"]
        # Must have multi-word phrases (ambiguous single-word title)
        assert any(" " in k for k in kws), (
            "Inversion must have at least one multi-word keyword."
        )


# ── Layer 2 fuzzy fallback (2026-07-24) ────────────────────────────────────────

class TestLayer2FuzzyMatch:
    """
    Layer 2 only runs when Layer 1 (exact substring match) finds nothing, and
    only fuzzy-matches multi-word keywords >= 8 characters. Single-word
    keywords and short phrases are exact-only.
    """

    def test_typo_of_multiword_keyword_matches(self):
        """'Bus Buond' (transposition typo of 'Bus Bound') should still match."""
        game = _make_game("Bus Bound", keywords=["Bus Bound", "BusBound", "Saber Bus Bound"])
        title = "Bus Buond just got a new update today"
        body = (
            "The devs pushed a big patch for Bus Buond this week with new routes "
            "and vehicle physics improvements. Really enjoying the driving model."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is True, "Layer 2 fuzzy match should catch 'Bus Buond' as a typo of 'Bus Bound'."

    def test_unrelated_skyrim_shout_does_not_match(self):
        """
        'Fus Bound' should NOT match 'Bus Bound' — 'Fus' (Skyrim's 'Fus Ro Dah'
        shout) is not within edit-distance range of 'Bus', so this must not be
        treated as a typo.
        """
        game = _make_game("Bus Bound", keywords=["Bus Bound", "BusBound", "Saber Bus Bound"])
        title = "Fus Bound to the wall by the shout mechanic in this mod"
        body = (
            "This Skyrim mod makes the Fus Ro Dah shout so much stronger that "
            "enemies get bound to walls on impact. Total chaos in dungeons."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, "'Fus Bound' must not fuzzy-match 'Bus Bound' — different first word."

    def test_single_word_keyword_never_fuzzy_matched(self):
        """Single-word keywords are exact-only; typos of them must not match via Layer 2."""
        game = _make_game("Gloomhaven", keywords=["Gloomhaven"])
        title = "Gloomhavne is such a fantastic tactical game to play"
        body = (
            "I've been playing Gloomhavne with friends every week and the "
            "combat system keeps getting deeper the more scenarios we unlock."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, "Single-word keywords must never be fuzzy-matched."

    def test_short_multiword_keyword_below_length_floor_not_fuzzy_matched(self):
        """Multi-word keywords under the 8-char length floor are exact-only."""
        game = _make_game("H2A", keywords=["H2A"])  # single token anyway, but also short
        game.distinctive_keywords = ["H2 MCC"]  # 6 chars, multi-word but below floor
        title = "H3 MCC campaign co-op run was incredible last night"
        body = (
            "We finished the whole H3 MCC campaign in one sitting on legendary "
            "difficulty. The checkpoint system held up great the entire way through."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, "'H2 MCC' is below the 8-char fuzzy floor, so 'H3 MCC' must not match it."

    def test_cross_game_exact_match_takes_precedence_over_fuzzy(self):
        """
        If the post text contains an EXACT Layer-1 hit for a different game,
        Layer 2 must not fire a fuzzy match for the focal game, even if a
        fuzzy candidate is technically within edit distance.
        """
        game = _make_game("Bus Bound", keywords=["Bus Bound"])
        # "Bus Bund" is a 1-edit typo of "Bus Bound", but the text also
        # contains an exact, unrelated keyword phrase for a different game
        # in the static fallback registry: "Master Chief Collection".
        title = "Bus Bund review plus my thoughts on Master Chief Collection today"
        body = (
            "Playing Bus Bund alongside the Master Chief Collection this week. "
            "Two very different games but both keeping me busy most evenings."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, (
            "Cross-game precedence guard should block the fuzzy hit when an exact "
            "match for a different catalogue game is present in the same text."
        )

    def test_fuzzy_layer_disabled_via_config_flag(self, monkeypatch):
        """When RELEVANCE_FUZZY_LAYER_ENABLED is False, Layer 2 never fires."""
        from config import settings as _settings
        from services import post_relevance as pr_module

        monkeypatch.setattr(pr_module.settings, "relevance_fuzzy_layer_enabled", False)

        game = _make_game("Bus Bound", keywords=["Bus Bound"])
        title = "Bus Buond just got a new update today"
        body = (
            "The devs pushed a big patch for Bus Buond this week with new routes "
            "and vehicle physics improvements. Really enjoying the driving model."
        )
        result = is_post_relevant_to_game(title, body, game)
        assert result is False, "Layer 2 must not run when the config flag is disabled."
