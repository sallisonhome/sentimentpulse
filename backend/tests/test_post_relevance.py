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

    def test_just_the_game_name_with_game_word_admitted(self):
        """
        v3 (2026-07-24 fast-path): a title containing both the game name
        (which serves as a keyword) AND the context word 'game' IS admitted
        even at 23 chars, because it clearly IS a post about the game.
        Under the pre-v3 rules this would have been rejected as too short.
        The user-directive fast-path admits keyword + context regardless
        of the strict content-substance thresholds.
        """
        game = _make_game("Untitled John Wick Game")
        result = is_post_relevant_to_game("Untitled John Wick Game", "", game)
        # 23 chars → above the fast-path's 20-char minimum, and contains
        # both a keyword hit and the 'game' context word.
        assert result is True

    def test_game_name_with_minimal_body_excluded(self):
        """Game name as title + very short body → NOT relevant."""
        game = _make_game("Untitled John Wick Game")
        result = is_post_relevant_to_game("John Wick game", "nice", game)
        # "John Wick game nice" → 19 chars → too short
        assert result is False

    def test_below_60_chars_combined_excluded(self):
        """
        v3 (2026-07-24): Rule 1 raised from 30 to 60 chars. A 50-char combined
        message about the game is now rejected as insufficient substance.
        """
        game = _make_game("Bus Bound")
        # 50 chars, mentions the game, but too short to be substantive
        result = is_post_relevant_to_game("Bus Bound", "looking forward to launch someday", game)
        combined = "Bus Bound looking forward to launch someday"
        assert len(combined) < 60
        assert result is False

    def test_word_count_below_8_excluded(self):
        """
        v3 Rule 1c: a post with ≥60 chars but fewer than 8 substantive words
        (e.g. long URLs, emoji strings, hashtag walls) is rejected.
        """
        game = _make_game("Bus Bound")
        # 64 chars combined but only 4 real words after tokenization
        result = is_post_relevant_to_game(
            "Bus Bound",
            "https://example.com/very/long/url/that/pads/length 👍",
            game,
        )
        assert result is False

    def test_no_component_reaches_40_chars_excluded(self):
        """
        v3 Rule 1d: neither title nor body reaches 40 chars — fragments
        totaling 60+ but split evenly aren't substantive enough. A Steam
        Forum post with a 20-char title and a 41-char body is fine; two
        30-char fragments are not.
        """
        game = _make_game("Bus Bound")
        # Title 27c + body 34c = 62c combined, plenty of words, but neither
        # component reaches the 40-char floor.
        result = is_post_relevant_to_game(
            "Bus Bound is cool tho maybe",
            "waiting for Bus Bound to release yes",
            game,
        )
        assert result is False

    def test_substantive_reddit_title_only_accepted(self):
        """
        v3: a Reddit post with a substantive title-only (≥40 chars)
        containing the game name and enough words is accepted.
        """
        game = _make_game("Bus Bound", keywords=["Bus Bound", "BusBound"])
        # 87-char title, 12 real words, mentions the game
        title = "Bus Bound looks like the transit management sim I have been waiting for since 2023"
        result = is_post_relevant_to_game(title, "", game)
        assert result is True

    def test_substantive_body_only_review_accepted(self):
        """
        v3: a Steam review with a substantive body-only (≥40 chars, ≥8 words)
        containing the game name is accepted.
        """
        game = _make_game("Bus Bound", keywords=["Bus Bound", "BusBound"])
        body = "Really enjoying the Bus Bound early access build so far, driving mechanics feel great"
        result = is_post_relevant_to_game("", body, game)
        assert result is True

    def test_layer2_concat_matches_url_slug(self):
        """
        v2 Layer-2b (2026-07-24): a URL/handle slug that concatenates a
        multi-word keyword (e.g. 'turokorigins' from x.com/turokorigins)
        matches the 'Turok Origins' keyword via the concat fallback. Without
        this, real Turok posts that ONLY reference the game via a URL slug
        or @handle are wrongly filtered out.
        """
        game = _make_game(
            "Turok: Origins",
            keywords=["Turok Origins", "Turok game"],
        )
        # Real steam-forum body observed in prod on 2026-07-24 that was
        # incorrectly rejected before this fix.
        body = (
            "Originally posted by Saber Eric: another example here "
            "https://x.com/turokorigins/status/2020204808423043275 "
            "will we get Steam cloud saves so we can keep our progress "
            "when we switch devices or perhaps later play it on the Steam Deck?"
        )
        result = is_post_relevant_to_game("", body, game)
        assert result is True

    def test_layer2_concat_rejects_unrelated_common_tokens(self):
        """
        v2 Layer-2b must not over-match on bare common words. A post about
        Warhammer 40k lore that mentions 'space marine' (with a space) must
        NOT trigger a Space Marine 2 (game #24) fuzzy hit via the concat
        path, because 'space marine' with a space stays two tokens and the
        concat target is 'spacemarine2' — far outside the 2-char edit budget
        for a 12-char keyword.
        """
        game = _make_game(
            "Warhammer 40,000: Space Marine 2",
            keywords=["Space Marine 2", "SM2"],
        )
        body = (
            "Been painting my space marine chapter for years now. The "
            "Blood Angels palette really pops next to the Ultramarines. "
            "Anyone else here into Warhammer 40k tabletop lately?"
        )
        result = is_post_relevant_to_game("", body, game)
        assert result is False

    def test_fast_path_admits_short_post_with_keyword_and_platform(self):
        """
        v3 fast-path (2026-07-24): user rule — posts that combine a game
        keyword AND a game-context word (saber / game / games / platform)
        should be admitted regardless of the 60-char / 8-word / 40-char
        content-substance thresholds.
        """
        game = _make_game(
            "Clive Barker's Hellraiser: Revival",
            keywords=["Hellraiser Revival", "Hellraiser game"],
        )
        # 44 chars, 6 words, no 40-char component — fails all three of
        # Rules 1a/1b/1c under the strict path.
        result = is_post_relevant_to_game(
            "Love Hellraiser Revival on PS5", "", game,
        )
        assert result is True

    def test_fast_path_admits_saber_plus_keyword(self):
        """'saber' publisher mention + game keyword = fast-path admit."""
        game = _make_game("Turok: Origins", keywords=["Turok Origins"])
        result = is_post_relevant_to_game(
            "Saber Turok Origins hype", "", game,
        )
        assert result is True

    def test_fast_path_requires_both_signals(self):
        """
        Fast-path requires BOTH the game keyword AND a game-context word.
        A short post with only 'PS5' (no game keyword) still fails.
        """
        game = _make_game(
            "Clive Barker's Hellraiser: Revival",
            keywords=["Hellraiser Revival"],
        )
        # Only 'PS5' — no Hellraiser keyword
        result = is_post_relevant_to_game(
            "Just got a PS5", "", game,
        )
        assert result is False

    def test_fast_path_requires_context_word(self):
        """
        Fast-path requires the context word. A short post with the keyword
        but no game/platform context word still fails the standard rules
        (falls through to the 60-char gate and gets rejected).
        """
        game = _make_game(
            "Clive Barker's Hellraiser: Revival",
            keywords=["Hellraiser Revival"],
        )
        # 22 chars, no game/platform word — fails Rule 1a (≥60 chars)
        result = is_post_relevant_to_game(
            "Hellraiser Revival hype", "", game,
        )
        assert result is False

    def test_fast_path_ignores_gamertag_substring(self):
        """
        Word-boundary check on context words: 'gamertag' should NOT trigger
        the 'game' context match, because it's a substring not a whole word.
        """
        game = _make_game(
            "Clive Barker's Hellraiser: Revival",
            keywords=["Hellraiser Revival"],
        )
        # 'gamertag' contains 'game' as substring but not as a whole word.
        # Post is short (< 60 chars) and has no 40-char component, so if
        # the fast-path fires it would incorrectly admit. If word-boundary
        # matching works, the fast-path passes over 'gamertag' and the
        # post falls through to Rule 1a which rejects it.
        result = is_post_relevant_to_game(
            "Hellraiser Revival gamertag ideas", "", game,
        )
        assert result is False

    def test_bare_token_admits_short_reddit_hellraiser_on_ps5(self):
        """
        v3 bare-token fast-path (2026-07-24): a Reddit title 'Hellraiser
        looks amazing on PS5' contains no full keyword ('Hellraiser Revival'
        etc.) but has the proper-noun 'Hellraiser' as a bare token AND the
        PS5 context word. Should be admitted.

        Root cause of user's 'nerfed too much' report: 386 Hellraiser raw
        posts today matched no multi-word keyword because Reddit users
        say 'Hellraiser' not 'Hellraiser Revival'. The bare-token
        + context fast-path fixes this while preserving the IP-cue
        rejection safety belt.
        """
        game = _make_game(
            "Clive Barker's Hellraiser: Revival",
            keywords=["Hellraiser Revival", "Hellraiser game"],
        )
        result = is_post_relevant_to_game(
            "Hellraiser looks amazing on PS5", "", game,
        )
        assert result is True

    def test_bare_token_rejects_hellraiser_comic_reference(self):
        """
        Bare-token fast-path still rejects IP-only references. A post
        'The Turok comic series from the 1950s is still worth reading.
        Not sure if the new games really capture the same feel' has
        both bare 'Turok' + context 'games' but ALSO 'comic series'
        within 120 chars — IP-cue rejection fires.
        """
        game = _make_game(
            "Turok: Origins",
            keywords=["Turok Origins"],
        )
        body = (
            "The Turok comic series from the 1950s is still worth reading. "
            "Not sure if the new games really capture the same feel."
        )
        result = is_post_relevant_to_game("", body, game)
        assert result is False

    def test_bare_token_rejects_all_lowercase_fantasy_kw(self):
        """
        Bare-token extraction requires the source keyword word to be
        proper-noun-cased. A test-fixture keyword like 'magic sword
        adventure' (all-lowercase, gaming-vocab) does NOT contribute
        any bare tokens — so a post 'magic swords are cool in fantasy
        games' correctly falls through to the strict path (where the
        partial phrase doesn't match).
        """
        game = _make_game("Some Game", keywords=["magic sword adventure"])
        result = is_post_relevant_to_game(
            "Magic swords are cool in fantasy games",
            "I love how fantasy games handle magic swords and enchantments. "
            "The best mechanic in RPGs hands down without any doubt at all.",
            game,
        )
        assert result is False

    def test_fast_path_ipcue_still_enforced(self):
        """
        Fast-path still enforces the IP-cue rejection: a post like
        'Hellraiser Revival movie ending on PS5' has all three signals
        (keyword + platform + IP cue near the keyword) and should be
        rejected as IP-only discussion.
        """
        game = _make_game(
            "Clive Barker's Hellraiser: Revival",
            keywords=["Hellraiser Revival"],
        )
        # 'Hellraiser Revival' with 'movie' cue immediately before + PS5.
        result = is_post_relevant_to_game(
            "Watching the Hellraiser Revival movie on PS5 tonight", "", game,
        )
        assert result is False

    def test_layer2_concat_no_hit_on_bare_first_word(self):
        """
        v2 Layer-2b must not fire when only the FIRST word of the keyword
        appears (bare 'turok' with no 'origins') — that path is the sliding
        window's territory and correctly stays out.
        """
        game = _make_game(
            "Turok: Origins",
            keywords=["Turok Origins"],
        )
        # Not a real Turok post — just a lore reference. Should not match.
        body = (
            "The Turok comic series from the 1950s is still worth reading. "
            "Not sure if the new games really capture the same feel."
        )
        result = is_post_relevant_to_game("", body, game)
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


class TestFranchiseBareTokenStopwords_2026_07_24_Evening:
    """
    Regression tests for the SILENT HILL: Townfall data-corruption fix.
    Franchise-generic bare tokens ('silent', 'hill', 'resident', 'evil',
    'dying', 'light', ...) must NOT admit posts via the bare-token fast
    path, even when a game's keyword list contains those capitalized
    words in a multi-word phrase.
    See lessons.md 2026-07-24 (evening).
    """
    def test_silent_bare_token_stopwords_a_franchise_post_from_townfall(self):
        from types import SimpleNamespace
        from services.post_relevance import is_post_relevant_to_game

        game = SimpleNamespace(
            id=999,
            name="SILENT HILL: Townfall",
            distinctive_keywords=[
                "Silent Hill Townfall",
                "Silent Hill: Townfall",
                "SH Townfall",
                "Townfall Silent Hill",
                "Screen Burn Townfall",
                "No Code Townfall",
                "Townfall game",
            ],
        )

        # These are franchise-generic posts that used to pass the bare
        # 'silent' token fast-path admission. They must all reject now.
        franchise_noise_titles = [
            "GOG Silent Hill 4 Issues",
            "How are Silent Hill fans feeling about the new Hellraiser: Revival game?",
            "Silent Hill f drawing on my PS5",
            "I Made A Silent Hill Poster!",
            "Is Spec Ops the Line an honorary Silent Hill game?",
        ]
        for title in franchise_noise_titles:
            assert not is_post_relevant_to_game(
                title, "some longer body content" * 5, game
            ), f"Franchise noise leaked through gate: {title!r}"

    def test_townfall_specific_posts_still_admitted(self):
        from types import SimpleNamespace
        from services.post_relevance import is_post_relevant_to_game

        game = SimpleNamespace(
            id=999,
            name="SILENT HILL: Townfall",
            distinctive_keywords=[
                "Silent Hill Townfall",
                "Silent Hill: Townfall",
                "SH Townfall",
                "Townfall Silent Hill",
                "Screen Burn Townfall",
                "No Code Townfall",
                "Townfall game",
            ],
        )
        # These posts explicitly mention Townfall — must admit.
        townfall_posts = [
            ("Silent Hill: Townfall release date on PS5", "Konami and Screen Burn announced Silent Hill: Townfall for September 24, 2026."),
            ("New Townfall trailer looks great", "Silent Hill Townfall from Screen Burn is looking really strong on the new gameplay trailer for PC and PS5."),
        ]
        for title, body in townfall_posts:
            assert is_post_relevant_to_game(title, body, game), \
                f"Legit Townfall post was rejected: {title!r}"


class TestShortCollisionWordsFuzzyGuard_2026_07_25:
    """
    Regression tests for the 2026-07-25 ILL false-positive fix. Multi-word
    keywords that contain a short English collision word (ILL, GO, PC, RE,
    IN, etc.) must be forced to Layer 1 exact match only — the fuzzy
    sliding-window layer admits false positives on those because the short
    word appears everywhere in normal English.

    See lessons.md 2026-07-25 (ILL contamination fix).
    """
    def test_ill_game_all_caps_contraction_does_not_admit(self):
        from types import SimpleNamespace
        from services.post_relevance import is_post_relevant_to_game

        game = SimpleNamespace(
            id=999, name="ILL",
            distinctive_keywords=["Team Clout ILL", "Mundfish ILL", "ILL game",
                                  "ILLgame", "ILL horror game", "ILL Team Clout",
                                  "ILL Mundfish"],
        )
        # Post is a caps-lock help-me-find-a-game post that contains "ILL"
        # as a contraction of "I'll" and "GAME" multiple times. Prior to the
        # 2026-07-25 fix, this admitted via Layer 2 fuzzy on 'ILL game'.
        title = "HELP ME I NEED A GAME"
        body = ("HELP, I DUG MYSELF INTO A HORROR GAME HOLE AND NOW IM NOT "
                "SCARD OF A GOOD CHUNK. GIVE ME A GAME ILL PLAY IT, I JUST "
                "NEED TO PLAY SOMETHING!")
        assert not is_post_relevant_to_game(title, body, game), \
            f"Caps-contraction false positive leaked through: {title!r}"

    def test_ill_lowercase_contraction_does_not_admit(self):
        from types import SimpleNamespace
        from services.post_relevance import is_post_relevant_to_game

        game = SimpleNamespace(
            id=999, name="ILL",
            distinctive_keywords=["ILL game", "ILL horror game", "Team Clout ILL"],
        )
        title = "Me and friends arguing about refund time"
        body = ("To start off with, I ended up getting abiotic factor. Me and "
                "friends did not like it, I forgot to close the game when I left "
                "the house and had 3.8 hours on it. Ill play through more before "
                "asking for a refund but the ill-considered decision to buy is "
                "already bugging me. What do you think, should Steam extend the "
                "refund window on games like this?")
        assert not is_post_relevant_to_game(title, body, game), \
            f"Lowercase contraction false positive leaked through: {title!r}"

    def test_real_ill_launch_announcement_still_admits(self):
        from types import SimpleNamespace
        from services.post_relevance import is_post_relevant_to_game

        game = SimpleNamespace(
            id=999, name="ILL",
            distinctive_keywords=["Team Clout ILL", "Mundfish ILL", "ILL game",
                                  "ILLgame", "ILL horror game", "ILL Team Clout",
                                  "ILL Mundfish"],
        )
        title = "Bloody First-Person Survival Horror Game 'ILL' Launches in 2027 [Trailer]"
        body = ("ILL from Team Clout and Mundfish is a first-person survival "
                "horror game targeting a 2027 launch on PC and consoles.")
        assert is_post_relevant_to_game(title, body, game), \
            "Legitimate ILL launch announcement was incorrectly rejected."

    def test_bus_bound_typo_still_works_for_short_distinctive_word(self):
        """
        The fix targets English contractions (ILL, GO). Distinctive short
        proper nouns like 'Bus' in 'Bus Bound' must still be fuzzy-eligible
        so real typos ('Bus Buond') admit. Bus isn't in the collision list.
        """
        from types import SimpleNamespace
        from services.post_relevance import is_post_relevant_to_game

        game = SimpleNamespace(
            id=999, name="Bus Bound",
            distinctive_keywords=["Bus Bound", "BusBound", "Saber Bus Bound"],
        )
        title = "Bus Buond just got a new update today"
        body = ("The devs pushed a big patch for Bus Buond this week with new "
                "routes and vehicle physics improvements. Really enjoying the "
                "driving model, though a couple of the trucks feel underpowered.")
        assert is_post_relevant_to_game(title, body, game), \
            "'Bus Buond' typo should still fuzzy-match to 'Bus Bound' — regression!"
