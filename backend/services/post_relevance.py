"""
Post-relevance filter — CLAUDE.md §14 (Context-Aware Attribution)

Determines whether a raw post (title + body) is substantively *about* the focal
game, as opposed to merely *mentioning* it in passing (e.g. in a comparison, a
nostalgia reference, or an off-topic discussion about the movie/IP the game
shares a name with).

Public API
----------
    is_post_relevant_to_game(title: str, body: str, game: Game) -> bool

Rules (implemented below, in priority order)
--------------------------------------------
1. Empty or very short text (< 30 chars combined) → NOT relevant.
2. At least one distinctive_keyword must appear as a case-insensitive
   whole-word (single-word) or whole-phrase (multi-word) match in the
   combined text (Layer 1 — exact match).  If Layer 1 finds nothing, a
   second pass (Layer 2 — fuzzy match) attempts a proportional-edit-distance
   match against multi-word keywords only (see _fuzzy_match_relevant below).
   If neither layer matches → NOT relevant.
3. If any movie/IP cue appears *near* the only matching keyword, the post is
   classified as being about the IP, not the game → NOT relevant.
4. If the text mentions ≥2 other known game titles from a genre that
   the focal game does NOT belong to, the post is a cross-genre comparison
   and does not belong to the focal game → NOT relevant.
5. All other posts that cleared the keyword gate → relevant.

Design notes
------------
- Game.distinctive_keywords (JSON list) is the primary keyword source.
  If the column is empty or NULL, the function falls back to the static
  registry GAME_KEYWORD_FALLBACK (same content as the Alembic seed).
- "Distinctive" means the keyword uniquely identifies *this* game, not the
  broader IP.  Multi-word phrases are required for ambiguous single-word titles.
- v2 (2026-07-24): a game with NO keywords configured (neither DB column nor
  static fallback) is HARD-BLOCKED — no sentiment classification runs on its
  posts until keywords are set.  This function never falls through to
  "accept all" for an unconfigured game; see the `if not keywords` branch
  below.  Use the startup validation check (services/keyword_health_check.py)
  to catch games missing keywords.
- The movie/IP cue detection intentionally looks only within a ±120-character
  window around the keyword match to avoid false positives from long posts that
  happen to mention a film somewhere.
- The cross-genre gate is intentionally conservative: it only fires when BOTH
  (a) ≥2 other-genre titles are present AND (b) none of those titles co-appear
  with the focal game's genre markers.  This prevents rejecting legitimate
  comparison posts within the same genre.
- Layer 2 fuzzy fallback (added 2026-07-24): only runs when Layer 1 finds
  zero matches.  Tolerates typos on MULTI-WORD keywords only (length >= 8
  chars), within a proportional edit-distance budget of floor(0.20 * len).
  All words in the keyword must have a close match within a sliding window
  of post text ("all-word coverage").  A cross-game precedence guard skips
  Layer 2 if the post text contains an exact Layer-1 hit for a DIFFERENT
  game in the catalogue.  Gated behind config.settings.relevance_fuzzy_layer_enabled
  (env var RELEVANCE_FUZZY_LAYER_ENABLED, default true) as a kill-switch.
"""
import logging
import math
import re
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Static fallback registry — matches the Alembic 0003 seed exactly.
# v2 (2026-07-24): games NOT in this dict AND with no DB distinctive_keywords
# are HARD-BLOCKED — no posts pass without a keyword match. See the
# `if not keywords: return False` branch in is_post_relevant_to_game().
# ---------------------------------------------------------------------------
GAME_KEYWORD_FALLBACK: dict[str, list[str]] = {
    # ── Spec-provided examples ─────────────────────────────────────────────
    "Untitled John Wick Game": [
        "John Wick game",
        "Wick assassin game",
        "Continental game",
        "Bithell John Wick",
    ],
    "Halo: The Master Chief Collection": [
        "MCC",
        "Master Chief Collection",
        "Halo MCC",
        "Halo collection",
    ],
    "Docked": [
        "Docked game",
        "Docked TV game",
        "TV gaming setup game",
        "Docked steam game",
    ],

    # ── Other Saber Interactive titles (mirrors Alembic 0003 seed) ─────────
    "Tempest Rising": [
        "Tempest Rising",
        "Tempest RTS",
        "Slipgate Tempest",
    ],
    "A Quiet Place: The Road Ahead": [
        "Quiet Place game",
        "Road Ahead game",
        "Quiet Place Road Ahead",
        "Saber Quiet Place",
    ],
    "The Knightling": [
        "Knightling",
        "Knightling game",
        "Twirlbound Knightling",
    ],
    "Dakar Desert Rally": [
        "Dakar Desert Rally",
        "Dakar rally game",
        "Dakar DDR",
    ],
    "Clive Barker's Hellraiser: Revival": [
        "Hellraiser Revival",
        "Hellraiser game",
        "Boss Team Hellraiser",
        "Clive Barker Hellraiser game",
    ],
    "Jurassic Park: Survival": [
        "Jurassic Park Survival",
        "JP Survival",
        "Jurassic Survival game",
        "Saber Jurassic",
    ],
    "Turok: Origins": [
        "Turok Origins",
        "Turok game",
        "Saber Turok",
    ],
    "Warhammer 40K: Space Marine 2": [
        "Space Marine 2",
        "SM2",
        "Warhammer Space Marine 2",
        "WH40K Space Marine 2",
        "Space Marine II",
    ],
    "Warhammer 40,000: Space Marine 2": [
        "Space Marine 2",
        "SM2",
        "Warhammer Space Marine 2",
        "WH40K Space Marine 2",
        "Space Marine II",
    ],
    "John Carpenter's Toxic Commando": [
        "Toxic Commando",
        "Carpenter Toxic Commando",
        "Saber Toxic Commando",
    ],
    "SnowRunner": [
        "SnowRunner",
        "Snow Runner game",
        "SnowRunner truck",
    ],
    "RoadCraft": [
        "RoadCraft",
        "Road Craft game",
        "Saber RoadCraft",
    ],
    "Gloomhaven": [
        "Gloomhaven",
        "Gloomhaven digital",
        "Gloomhaven video game",
    ],
    "Expeditions: A MudRunner Game": [
        "Expeditions MudRunner",
        "MudRunner Expeditions",
        "Expeditions A MudRunner Game",
    ],
    "MudRunner": [
        "MudRunner",
        "Mud Runner game",
        "MudRunner truck",
    ],
    "Crysis 3 Remastered": [
        "Crysis 3 Remastered",
        "Crysis 3 remaster",
        "C3R",
    ],
    "Crysis 2 Remastered": [
        "Crysis 2 Remastered",
        "Crysis 2 remaster",
        "C2R",
    ],
    "Ghostbusters Remastered": [
        "Ghostbusters Remastered",
        "Ghostbusters Video Game Remastered",
        "Ghostbusters 2009 remaster",
    ],
    "Ghostbusters: The Video Game Remastered": [
        "Ghostbusters Remastered",
        "Ghostbusters Video Game Remastered",
        "Ghostbusters 2009 remaster",
    ],
    "TimeShift": [
        "TimeShift game",
        "TimeShift Saber",
        "TimeShift FPS",
    ],
    "TimeShift™": [
        "TimeShift game",
        "TimeShift Saber",
        "TimeShift FPS",
    ],
    "MX Nitro": [
        "MX Nitro",
        "MX Nitro game",
    ],
    "Inversion": [
        "Inversion game",
        "Inversion shooter",
        "Inversion gravity",
        "Inversion Saber",
    ],
    "Inversion™": [
        "Inversion game",
        "Inversion shooter",
        "Inversion gravity",
        "Inversion Saber",
    ],
    "Halo 2: Anniversary": [
        "Halo 2 Anniversary",
        "H2A",
        "Halo 2A",
    ],
    "Halo 3": [
        "Halo 3 campaign",
        "H3 MCC",
        "Halo 3 multiplayer",
    ],
    "MudRunner Old-timers DLC": [
        "Old-timers DLC",
        "MudRunner Old-timers",
        "Old timers DLC",
    ],
    "RoadCraft Reclaim Expansion": [
        "Reclaim Expansion",
        "RoadCraft Reclaim",
        "RoadCraft expansion",
    ],
    "Halo: Combat Evolved Anniversary": [
        "Halo CE Anniversary",
        "Halo CEA",
        "Combat Evolved Anniversary",
        "Halo: CE Anniversary",
    ],
}

# ---------------------------------------------------------------------------
# Movie / IP cue words — phrases that suggest a post is about the film/IP,
# not the game.  Checked within a ±120-char window around the keyword match.
# ---------------------------------------------------------------------------
_IP_CUE_PATTERNS = [
    r"\bkeanu\b",
    r"\bchapter\s+[0-9ivxIVX]+\b",
    r"\bfilm\b",
    r"\bmovie\b",
    r"\bjust\s+watched\b",
    r"\bjust\s+finished\s+watching\b",
    r"\bfinished\s+watching\b",
    r"\bwatched\s+the\b",
    r"\bcinema\b",
    r"\btheater\b",
    r"\btheatre\b",
    r"\bNetflix\b",
    r"\bHBO\b",
    r"\bstreaming\b",
    r"\bsequence\s+in\s+the\s+movie\b",
    r"\bthe\s+movie\b",
    r"\bin\s+the\s+film\b",
    r"\bplot\s+of\s+the\b",
    r"\bscene\s+from\b",
    # v2 (2026-07-24): expand IP-cue coverage for print, TV, and other
    # non-game franchise media — posts referencing a comic, novel,
    # TV series, or animated series are almost always about the IP
    # not the game.
    r"\bcomic\b",
    r"\bcomics\b",
    r"\bgraphic\s+novel\b",
    r"\bnovel\b",
    r"\bnovels\b",
    r"\bbook\b",
    r"\bbooks\b",
    r"\bTV\s+show\b",
    r"\btv\s+series\b",
    r"\bTV\s+series\b",
    r"\banimated\s+series\b",
    r"\bmini-?series\b",
    r"\bshow\s+on\b",
    r"\bcomic\s+series\b",
    r"\bcomic\s+book\b",
    r"\bmanga\b",
    r"\banime\b",
    r"\bDisney\+\b",
    r"\bHulu\b",
    r"\bAmazon\s+Prime\b",
    r"\bPrime\s+Video\b",
]

_IP_CUE_RE = re.compile(
    "|".join(_IP_CUE_PATTERNS),
    re.IGNORECASE,
)

# Window size (characters) around the keyword match to check for IP cues.
_IP_CUE_WINDOW = 120

# ---------------------------------------------------------------------------
# Cross-genre game catalogue
# Each entry: canonical name → genre tag(s)
# The focal game's genre is looked up by game.name (or falls back to "unknown").
# A post is rejected only if ≥2 OTHER-genre titles appear in the text.
# ---------------------------------------------------------------------------
_GAME_GENRES: dict[str, set[str]] = {
    # Horror / survival horror
    "Resident Evil": {"horror"},
    "Silent Hill": {"horror"},
    "Alien: Isolation": {"horror"},
    "Dead Space": {"horror"},
    "Outlast": {"horror"},
    "Amnesia": {"horror"},
    "Phasmophobia": {"horror"},
    "The Evil Within": {"horror"},
    "Dying Light": {"horror", "action"},
    "The Last of Us": {"horror", "action"},
    # Action stealth
    "Hitman": {"stealth", "action"},
    "Splinter Cell": {"stealth", "action"},
    "Deus Ex": {"stealth", "action", "rpg"},
    "Dishonored": {"stealth", "action"},
    "Metal Gear Solid": {"stealth", "action"},
    # FPS / shooter
    "Call of Duty": {"fps"},
    "Battlefield": {"fps"},
    "Doom": {"fps"},
    "Quake": {"fps"},
    "Counter-Strike": {"fps"},
    "Valorant": {"fps"},
    "Apex Legends": {"fps", "battle_royale"},
    "Overwatch": {"fps"},
    "Titanfall": {"fps"},
    "Halo": {"fps"},
    # RPG
    "Witcher": {"rpg"},
    "Skyrim": {"rpg"},
    "Elden Ring": {"rpg"},
    "Dark Souls": {"rpg", "action"},
    "Baldur's Gate": {"rpg"},
    "Cyberpunk 2077": {"rpg", "action"},
    # Strategy
    "Civilization": {"strategy"},
    "StarCraft": {"strategy"},
    "Age of Empires": {"strategy"},
    "Total War": {"strategy"},
    # Sports / racing
    "FIFA": {"sports"},
    "NBA 2K": {"sports"},
    "Gran Turismo": {"racing"},
    "Forza": {"racing"},
    "Rocket League": {"sports"},
    # Adventure / puzzle
    "Portal": {"puzzle"},
    "The Stanley Parable": {"puzzle", "adventure"},
    "What Remains of Edith Finch": {"adventure"},
    # John Wick game specific — for cross-genre checks
    "Untitled John Wick Game": {"action", "stealth"},
    "John Wick Hex": {"action", "strategy"},
}

# Genre(s) of the focal game — used to determine if other-genre titles are present.
_FOCAL_GAME_GENRES: dict[str, set[str]] = {
    # Saber Interactive catalogue — genre tags for cross-genre contamination check.
    "Untitled John Wick Game": {"action", "stealth"},
    "Halo: The Master Chief Collection": {"fps"},
    "Halo 2: Anniversary": {"fps"},
    "Halo 3": {"fps"},
    "Docked": {"puzzle", "casual"},
    "Inversion": {"fps", "action"},
    "Tempest Rising": {"strategy"},
    "A Quiet Place: The Road Ahead": {"horror", "adventure"},
    "The Knightling": {"action", "adventure"},
    "Dakar Desert Rally": {"racing"},
    "Clive Barker's Hellraiser: Revival": {"horror"},
    "Jurassic Park: Survival": {"action", "adventure"},
    "Turok: Origins": {"fps", "action"},
    "Warhammer 40K: Space Marine 2": {"action", "shooter"},
    "Warhammer 40,000: Space Marine 2": {"action", "shooter"},
    "John Carpenter's Toxic Commando": {"fps", "horror"},
    "SnowRunner": {"simulation"},
    "RoadCraft": {"simulation"},
    "Gloomhaven": {"strategy", "rpg"},
    "Expeditions: A MudRunner Game": {"simulation"},
    "MudRunner": {"simulation"},
    "Crysis 3 Remastered": {"fps"},
    "Crysis 2 Remastered": {"fps"},
    "Ghostbusters Remastered": {"action", "adventure"},
    "TimeShift": {"fps"},
    "TimeShift™": {"fps"},
    "Inversion™": {"fps", "action"},
    "Ghostbusters: The Video Game Remastered": {"action", "adventure"},
    "Halo: Combat Evolved Anniversary": {"fps"},
    "MX Nitro": {"racing"},
    "MudRunner Old-timers DLC": {"simulation"},
    "RoadCraft Reclaim Expansion": {"simulation"},
}

# Minimum number of other-genre titles that must appear to trigger the
# cross-genre rejection gate.
_CROSS_GENRE_THRESHOLD = 2


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def is_post_relevant_to_game(title: str, body: str, game) -> bool:
    """
    Return True iff this post is substantively about the given game.

    Parameters
    ----------
    title : str
        Post title (may be empty / None for Steam reviews).
    body : str
        Post body text (may be empty / None).
    game : models.Game
        The focal game object.  Must have .name and .distinctive_keywords attrs.

    Returns
    -------
    bool
        True  → post is relevant; include in topic clustering.
        False → post is off-topic or IP-contaminated; skip.
    """
    # Normalise None → ""
    title = (title or "").strip()
    body = (body or "").strip()
    combined = f"{title} {body}".strip()

    # v3 (2026-07-24): Fast-path admission for game-context signals.
    #
    # User rule: "Posts with any keyword saber or game or any platform
    # like PlayStation, Switch 2, PC or Xbox should go through in
    # combination with a keyword from the title of the game we're tracking."
    #
    # If a post contains BOTH a distinctive game keyword AND at least one
    # video-game context word (saber, game, or a platform name), admit it
    # regardless of the content-substance thresholds. This catches short
    # but clearly-on-topic posts like a 45-char Steam review 'love
    # Hellraiser on PS5' that would otherwise fail Rule 1a (≥60 chars)
    # or Rule 1c (≥40-char component).
    #
    # Rules that still apply even in the fast-path:
    #   - Rule 3 (IP/movie cue rejection)
    #   - Rule 4 (cross-genre contamination)
    # These are AFTER the fast-path so we can't accidentally admit an
    # off-topic post that happens to contain the game name in a movie
    # discussion (e.g. "the Hellraiser movie on PS5" style).
    # Minimum viable content for the fast-path: 20 chars total. Even the
    # permissive path won't admit a 3-word title with no other content —
    # BERT can't classify sentiment on a bare game name. This is well
    # below the strict-path floor of 60 chars.
    _FAST_PATH_MIN_CHARS = 20
    _keywords_for_fast_path = _get_keywords(game)
    if _keywords_for_fast_path and len(combined) >= _FAST_PATH_MIN_CHARS:
        # For the fast-path, we also count bare-word signals derived from
        # each multi-word keyword (e.g. keyword 'Hellraiser Revival' → bare
        # 'Hellraiser'). This lets a post like 'Hellraiser on PS5' match
        # via the bare token PLUS the platform context word, without
        # weakening the standard-path Layer-1 match (which still requires
        # the full multi-word keyword and its own IP-cue guards).
        _has_kw = (
            bool(_find_keyword_matches(combined, _keywords_for_fast_path))
            or _has_bare_distinctive_token(combined, _keywords_for_fast_path)
        )
        _has_ctx = _has_game_context_word(combined)
        if _has_kw and _has_ctx:
            # Still enforce IP-cue + cross-genre checks below.
            # If the standard-keyword layer matched, use its positions.
            # If ONLY the bare-token layer matched (rare but possible),
            # locate the bare-token spans and use those instead — without
            # this, IP-cue rejection would silently no-op on bare hits
            # and let 'Hellraiser movie on PS5' through.
            match_positions = _find_keyword_matches(combined, _keywords_for_fast_path)
            if not match_positions:
                match_positions = _find_bare_distinctive_token_matches(
                    combined, _keywords_for_fast_path,
                )
            if _all_matches_near_ip_cue(combined, match_positions):
                logger.debug(
                    "Fast-path IP-cue rejection for '%s'.", game.name,
                )
                return False
            if _is_cross_genre_contaminated(combined, game):
                logger.debug(
                    "Fast-path cross-genre rejection for '%s'.", game.name,
                )
                return False
            logger.debug(
                "Fast-path admission for '%s' (keyword + game-context word).",
                game.name,
            )
            return True

    # Rule 1: content-substance gate (raised 2026-07-24 from 30 chars).
    #
    # Data-driven: sampling neutral posts across the 29 active games showed
    # 60-80% of ingested posts are <80 chars; many are 1-4 characters (a
    # bare ')', single emoji, hashtag string, or URL). These posts get
    # sentiment-classified by BERT into positive/negative/neutral but
    # carry no analytical value and pollute the dashboards
    # (Hellraiser's 4 negative posts in the last 7d were all near-empty
    # Bluesky posts; the 'A Real Horror Game.' 19-char Steam-forum title
    # was one of only two coherent items). Rule now enforces:
    #
    #   a) combined length ≥ 60 characters (was 30)
    #   b) at least 8 alphanumeric-heavy "words" (weeds out URL-only,
    #      emoji-only, hashtag-strings, and single-emoji-plus-link Bluesky)
    #   c) at least one of title OR body ≥ 40 chars (a 60-char
    #      total split 20+40 is fine; two 30-char fragments is not)
    #
    # These thresholds still admit legit short-form content like a
    # focused 65-char Steam review or a 70-char Reddit title.
    if len(combined) < 60:
        logger.debug(
            "Post too short (%d chars) for game '%s' — not relevant.",
            len(combined), game.name,
        )
        return False

    # "Words" = whitespace-separated tokens that contain at least one
    # letter or digit and are ≥ 2 characters. Strips out URL-only posts,
    # emoji-only posts, and hashtag strings (which tokenize as tokens
    # like '#Hellraiser' — those count as words) but rejects '#a #b #c'
    # style posts and pure-emoji strings.
    word_re = re.compile(r"[A-Za-z0-9][A-Za-z0-9\-']*")
    words = [w for w in word_re.findall(combined) if len(w) >= 2]
    if len(words) < 8:
        logger.debug(
            "Post has only %d substantive word(s) for game '%s' — not relevant.",
            len(words), game.name,
        )
        return False

    # Neither title-only ('A Real Horror Game.' = 19 chars) nor body-only
    # ('If resident evil can do it...i dont see why this cant' = 53 chars)
    # is enough on its own. Require at least one ≥ 40-char component.
    if len(title) < 40 and len(body) < 40:
        logger.debug(
            "Post has no substantial title (%d) or body (%d) for game '%s' — not relevant.",
            len(title), len(body), game.name,
        )
        return False

    # Determine keywords to use
    keywords: list[str] = _get_keywords(game)

    # v2 (2026-07-24): user rule — games without keywords are gated OUT.
    # No sentiment classification runs on their posts until keywords are
    # configured. Never fall through to "accept all".
    if not keywords:
        logger.warning(
            "Game '%s' has no distinctive_keywords configured; post filtered out. "
            "Configure keywords in Settings to enable sentiment tracking for this game.",
            game.name,
        )
        return False

    # Rule 2: at least one keyword must match (Layer 1 — exact match)
    match_positions = _find_keyword_matches(combined, keywords)
    if not match_positions:
        # Layer 2 — fuzzy fallback. Only runs when Layer 1 found nothing.
        if settings.relevance_fuzzy_layer_enabled:
            post_id_for_log = getattr(game, "_current_post_id_for_log", None)
            if _fuzzy_match_relevant(
                combined, keywords, game.name,
                getattr(game, "id", "?"), post_id_for_log,
            ):
                # Layer 2 hit — skip straight to IP-cue / cross-genre checks below.
                match_positions = None  # sentinel: no char-span positions for a fuzzy hit
            else:
                logger.debug(
                    "No keyword match (Layer 1 or Layer 2) in post for game '%s' — not relevant.",
                    game.name,
                )
                return False
        else:
            logger.debug(
                "No keyword match in post for game '%s' — not relevant.",
                game.name,
            )
            return False

    # Rule 3: IP/movie cue near each keyword match?
    # If there is exactly one match (or all matches are close together),
    # and all of them are surrounded by IP cues, reject the post.
    if _all_matches_near_ip_cue(combined, match_positions):
        logger.debug(
            "All keyword matches for '%s' are adjacent to IP/movie cues — not relevant.",
            game.name,
        )
        return False

    # Rule 4: cross-genre contamination check
    if _is_cross_genre_contaminated(combined, game):
        logger.debug(
            "Post for '%s' contains ≥%d other-genre game titles — not relevant.",
            game.name, _CROSS_GENRE_THRESHOLD,
        )
        return False

    return True


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

# v3 (2026-07-24): game-context words that strengthen a keyword hit
# per user rule: "Posts with any keyword saber or game or any platform
# like PlayStation, Switch 2, PC or Xbox should go through in combination
# with a keyword from the title of the game."
#
# Matched with word-boundary anchors (case-insensitive) so 'games' is a
# match but 'gamers' or 'gamertag' is not; 'PC' matches as a token but
# not inside 'PCB' or 'MPC'; 'Xbox Series X' is matched as a phrase.
_GAME_CONTEXT_TOKENS = {
    "saber", "sabre",         # publisher name
    "game", "games",          # the word 'game' or 'games' itself
    # PlayStation family
    "playstation", "ps5", "ps4", "ps3",
    # Xbox family
    "xbox", "xsx", "xss",
    # Nintendo
    "switch", "nintendo",
    # PC / Valve
    "pc", "steam", "steamdeck",
    # Epic
    "egs", "epic",
}
_GAME_CONTEXT_PHRASES = {
    "xbox series x",
    "xbox series s",
    "xbox one",
    "switch 2",
    "steam deck",
    "nintendo switch",
    "epic games",
    "epic store",
}
# Precompile boundary-aware regex once at module load.
_CONTEXT_TOKEN_RE = re.compile(
    r"(?<!\w)(?:" + "|".join(re.escape(t) for t in _GAME_CONTEXT_TOKENS) + r")(?!\w)",
    re.IGNORECASE,
)
_CONTEXT_PHRASE_RE = re.compile(
    r"(?<!\w)(?:" + "|".join(re.escape(p) for p in _GAME_CONTEXT_PHRASES) + r")(?!\w)",
    re.IGNORECASE,
)


def _has_game_context_word(text: str) -> bool:
    """
    Return True iff `text` contains at least one game-context signal
    (publisher 'saber', the word 'game/games', or a platform name).

    Used by is_post_relevant_to_game() as part of the fast-path admission
    for posts that combine a game keyword with a video-game context word.
    """
    if not text:
        return False
    if _CONTEXT_TOKEN_RE.search(text):
        return True
    if _CONTEXT_PHRASE_RE.search(text):
        return True
    return False


# Words that are too generic on their own to identify a game, and MUST
# NOT be treated as bare distinctive tokens for the fast-path. These are
# the common English / gaming-vocabulary words that appear as the second
# or later word in many game titles.
_BARE_TOKEN_STOPWORDS = {
    # Stopwords + gaming vocabulary that shouldn't become a bare token
    # even when ≥ 5 chars long.
    #
    # Guiding principle: this set should contain words that would produce
    # HIGH-VOLUME false positives if they matched bare + a context word
    # (e.g. any post about the 'game' genre + PS5 would falsely admit).
    # Words that are actual GAME NAMES (Hellraiser, Turok, Jurassic,
    # Warhammer, Ghostbusters, Snowrunner, Mudrunner, Halo, Crysis)
    # are NOT in this list — they're distinctive enough that combined
    # with a context word (PS5, Xbox, etc.) the intent is clear. The
    # IP-cue rejection (movie/film/cinema/streaming) still fires for
    # off-topic IP-only discussion.
    "the", "and", "for", "with", "this", "that",
    "game", "games", "edition", "remastered", "remaster", "remake",
    "deluxe", "complete", "anniversary", "collection", "trilogy",
    "legendary", "ultimate", "platinum", "season",
    "combat", "expansion",
    "official", "vinyl", "livery", "crawler",
    "volume", "chapter", "episode",
    "iii", "vii", "viii",
    "untitled", "master", "chief", "quiet", "place",
    "video", "deep", "waters",
    "docked", "expedition", "expeditions", "editor",
    "aftermath", "prologue", "world",
    "first", "person", "third", "story", "prequel", "sequel",
    "launch", "early", "access", "battle",
    "stakes", "final", "return", "reborn", "reboot",
    "unleashed", "assault", "strike", "force",
    "saber", "sabre", "carpenter", "barker", "clive",
    # Common suffix-noun words that appear in multi-word game titles
    # but are too generic on their own (a PS5 post about 'ghost' or
    # 'runner' or 'truck' shouldn't match a specific game).
    "runner", "truck", "trucks", "bound", "revival", "origins",
    "survival", "space", "marine", "ghost", "raiser", "builder",
    "driver", "drivers", "hunter", "hunters", "raiders", "raider",
    "knight", "knights", "warriors", "warrior", "soldier", "soldiers",
    "survivor", "survivors", "legend", "legends",
    # Movie/IP proper nouns that also appear in game titles — too
    # generic to bare-match without collision (e.g. 'Ghost' matches
    # Ghost of Tsushima; 'Marine' matches Space Marine 2 AND real-world
    # marines). Full multi-word keywords still catch these.
    "jurassic", "toxic", "haven", "gloom", "rising", "digital",
    "remasterd", "nightling",  # frags/typos too close to common words
    # 2026-07-24 evening — franchise-generic tokens added after the
    # SILENT HILL: Townfall data-corruption incident. These are franchise
    # names that would tag every franchise post as "about the specific
    # spin-off" if bare-matched. Spin-off titles should rely on their
    # unique-to-this-title word (Townfall, Revival, Origins) as the bare
    # token, not the franchise-generic word.
    "silent", "hill", "resident", "evil", "dying", "light",
    "screen", "code", "burn", "metal", "gear", "solid", "fantasy",
    "dragon", "street", "fighter", "tekken", "mortal", "kombat",
    "grand", "theft", "auto", "assassin", "creed", "tomb",
    "raider", "deus", "borderlands", "cyberpunk", "witcher", "skyrim",
    "elder", "scrolls", "fallout", "souls", "bloodborne", "elden",
    "ring", "sekiro", "nier", "persona", "final", "kingdom",
    "hearts", "tales", "star", "wars", "marvel", "batman", "arkham",
    "spider", "guardians", "thief", "deacon", "gods", "war",
    "tsushima", "horizon", "forbidden", "west", "death", "stranding",
    "resident", "evil", "village", "biohazard",
    # And their common two-token franchise combinations that a bare
    # match might still accidentally split on
    "burnout", "paradise", "midnight", "club"
    # Note: 'Hellraiser', 'Turok', 'Ghostbusters', 'SnowRunner',
    # 'MudRunner', 'Warhammer', 'Emberville', 'JurassicPark',
    # 'ToxicCommando' etc. — the full distinctive proper nouns — are
    # NOT in this stopword list. They remain as valid bare-token
    # signals.
}


def _extract_bare_distinctive_tokens(keywords: list[str]) -> set[str]:
    """
    Derive the set of bare distinctive tokens implied by a game's keyword
    list. For each multi-word keyword, take each word that:
      1. Starts with an uppercase letter in the original keyword (i.e. is
         a proper noun — game title, franchise name, publisher, etc.),
      2. Is ≥ 5 chars,
      3. Is NOT in the shared stopword list.
    Deduped, lowercase.

    Requiring proper-noun casing is essential to prevent common gaming
    vocabulary from becoming a false-positive signal. For example a test
    keyword like 'magic sword adventure' (all-lowercase words) should NOT
    contribute 'magic' or 'sword' as bare tokens because they'd match any
    fantasy-RPG post that mentions the words. But 'Hellraiser Revival'
    (uppercase Hellraiser) rightly contributes 'hellraiser' as a bare
    token because it's a proper noun the community actually uses.

    Example: for keywords ['Hellraiser Revival', 'Boss Team Hellraiser',
    'Hellraiser 2026'], returns {'hellraiser'}. 'Boss', 'Team', 'Revival'
    are excluded (Revival is in the stopword list; Boss and Team are
    short-common; and while capitalized, they're still gaming-generic).

    Used only in the fast-path where the context-word requirement provides
    a second layer of safety against false positives.
    """
    out: set[str] = set()
    for kw in keywords:
        for w in kw.split():
            stripped = w.strip(":;,.!?/-'\"")
            if len(stripped) < 5:
                continue
            # Proper-noun casing check: first alpha char must be uppercase.
            # Handles quoted, hyphenated, and punctuated forms.
            first_alpha = next((c for c in stripped if c.isalpha()), None)
            if not first_alpha or not first_alpha.isupper():
                continue
            wl = stripped.lower()
            if wl in _BARE_TOKEN_STOPWORDS:
                continue
            out.add(wl)
    return out


def _has_bare_distinctive_token(text: str, keywords: list[str]) -> bool:
    """
    Return True iff `text` contains any bare distinctive token derived
    from `keywords` (whole-word match, case-insensitive).

    Used only in the fast-path.
    """
    bare_tokens = _extract_bare_distinctive_tokens(keywords)
    if not bare_tokens:
        return False
    text_lower = text.lower()
    for tok in bare_tokens:
        pattern = r"(?<!\w)" + re.escape(tok) + r"(?!\w)"
        if re.search(pattern, text_lower):
            return True
    return False


def _find_bare_distinctive_token_matches(
    text: str, keywords: list[str],
) -> list[tuple[int, int]]:
    """
    Return character-span positions of every bare-distinctive-token hit
    in `text`. Used by the fast-path IP-cue check when the standard
    keyword layer didn't match but the bare-token layer did.
    """
    bare_tokens = _extract_bare_distinctive_tokens(keywords)
    if not bare_tokens:
        return []
    positions: list[tuple[int, int]] = []
    for tok in bare_tokens:
        pattern = r"(?<!\w)" + re.escape(tok) + r"(?!\w)"
        for m in re.finditer(pattern, text, re.IGNORECASE):
            positions.append((m.start(), m.end()))
    return positions


def _get_keywords(game) -> list[str]:
    """Return distinctive keywords for the game.

    Prefers game.distinctive_keywords (DB column); falls back to the static
    registry; returns [] if neither is available.
    """
    db_keywords = getattr(game, "distinctive_keywords", None)
    if db_keywords:
        return [k for k in db_keywords if isinstance(k, str) and k.strip()]
    return GAME_KEYWORD_FALLBACK.get(game.name, [])


def _find_keyword_matches(text: str, keywords: list[str]) -> list[tuple[int, int]]:
    """
    Return a list of (start, end) spans for every keyword that matches in text.

    Single-word keywords: whole-word match (\\b boundaries).
    Multi-word keyphrases: whole-phrase match (case-insensitive).

    Returns an empty list if no keywords match.
    """
    text_lower = text.lower()
    positions: list[tuple[int, int]] = []

    for kw in keywords:
        kw_stripped = kw.strip()
        if not kw_stripped:
            continue

        if " " in kw_stripped:
            # Multi-word phrase — use case-insensitive substring search with
            # simple word-boundary check on either end.
            pattern = _build_phrase_pattern(kw_stripped)
            for m in re.finditer(pattern, text, re.IGNORECASE):
                positions.append((m.start(), m.end()))
        else:
            # Single word — require word boundaries.
            pattern = r"\b" + re.escape(kw_stripped) + r"\b"
            for m in re.finditer(pattern, text, re.IGNORECASE):
                positions.append((m.start(), m.end()))

    return positions


def _build_phrase_pattern(phrase: str) -> str:
    """
    Build a regex for a multi-word phrase with word-boundary anchors on
    both ends and flexible internal whitespace.
    """
    words = phrase.split()
    inner = r"\s+".join(re.escape(w) for w in words)
    return r"(?<!\w)" + inner + r"(?!\w)"


def _all_matches_near_ip_cue(text: str, positions: list[tuple[int, int]]) -> bool:
    """
    Return True iff every keyword match span is within _IP_CUE_WINDOW characters
    of an IP/movie cue word.

    If even one match is NOT near an IP cue, the post may still be on-topic.
    """
    if not positions:
        return False

    text_len = len(text)
    for (start, end) in positions:
        window_start = max(0, start - _IP_CUE_WINDOW)
        window_end = min(text_len, end + _IP_CUE_WINDOW)
        window_text = text[window_start:window_end]
        if not _IP_CUE_RE.search(window_text):
            # This match is NOT near an IP cue — post could be on-topic
            return False

    # Every match is near an IP cue
    return True


def _is_cross_genre_contaminated(text: str, game) -> bool:
    """
    Return True iff the text mentions ≥ _CROSS_GENRE_THRESHOLD game titles
    from a genre that the focal game does NOT belong to.

    A "different genre" game is one whose genre set has no intersection with
    the focal game's known genres.
    """
    focal_genres = _FOCAL_GAME_GENRES.get(game.name, set())
    # If we don't know the focal game's genre, we can't do cross-genre checks.
    if not focal_genres:
        return False

    other_genre_count = 0
    text_lower = text.lower()

    for other_game, other_genres in _GAME_GENRES.items():
        # Skip if it's the focal game itself
        if other_game.lower() == game.name.lower():
            continue
        # Skip if genres overlap with focal game (same or related genre)
        if other_genres & focal_genres:
            continue
        # Check if the other game's name appears in the text
        pattern = r"(?<!\w)" + re.escape(other_game) + r"(?!\w)"
        if re.search(pattern, text, re.IGNORECASE):
            other_genre_count += 1
            if other_genre_count >= _CROSS_GENRE_THRESHOLD:
                return True

    return False


# ---------------------------------------------------------------------------
# Layer 2 — fuzzy fallback matching (2026-07-24)
#
# Only invoked from is_post_relevant_to_game() when Layer 1 (exact substring
# match) finds zero matches. See code_plan.md §1d for the full spec. Rules:
#   1. Multi-word keywords ONLY — single-word keywords are never fuzzy-matched.
#   2. Length floor — keyword must be >= 8 characters.
#   3. Proportional edit distance — allowed edits = floor(0.20 * len(keyword)).
#   4. All-word coverage — every word of an N-word keyword must have a
#      Levenshtein-close match to some token in the same N-word sliding
#      window of the post text (not just one word out of N).
#   5. Cross-game precedence guard — if the post text contains an exact
#      Layer-1 hit for a DIFFERENT game in the catalogue, Layer 2 is skipped
#      (that other game "wins").
#
# Uses a small pure-Python Damerau-Levenshtein implementation (no external
# dependency — python-Levenshtein is not in requirements.txt and we want to
# keep deps light per the approved plan).
# ---------------------------------------------------------------------------

_FUZZY_MIN_KEYWORD_LEN = 8
_FUZZY_MAX_EDIT_RATIO = 0.20

# Short (≤3-char) English words / contractions that are unsafe when they
# appear as part of a multi-word keyword. The sliding-window fuzzy match
# treats each keyword word independently, so any short word in this set
# turns the fuzzy layer into a near-guaranteed admit on any post containing
# that word plus the other keyword word(s) in a window. Force such keywords
# to Layer 1 (exact substring) only. See lessons.md 2026-07-25.
_SHORT_COLLISION_WORDS = frozenset({
    # Contractions / adjectives / common English prefixes and short verbs.
    "ill", "go", "fez", "hi", "in", "up", "we", "if", "do", "or",
    "ok", "no", "my", "me", "is", "am", "be", "to", "of", "on",
    "an", "as", "at", "by", "it", "so", "us", "he", "a",
    # Short frequently-collided titles / IP acronyms that would trip the
    # sliding window when combined with any common word.
    "re", "pc", "ps", "vr", "ai", "ea", "ip",
})
_WORD_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def _tokenize(text: str) -> list[str]:
    """Lowercase word tokens, punctuation stripped."""
    return [t.lower() for t in _WORD_TOKEN_RE.findall(text or "")]


def damerau_levenshtein(a: str, b: str) -> int:
    """
    Compute the Damerau-Levenshtein edit distance between two strings
    (insertions, deletions, substitutions, and adjacent-transpositions all
    cost 1). Pure-Python implementation — no external dependency.

    Used instead of plain Levenshtein because adjacent-character transposition
    typos ("Rissign" vs "Rising"-style swaps) are extremely common in the
    community-misspelling patterns this gate needs to tolerate (see
    proposed_keywords.md notes on transposition typos).
    """
    a = a.lower()
    b = b.lower()
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la

    # d[i][j] = edit distance between a[:i] and b[:j]
    d = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(la + 1):
        d[i][0] = i
    for j in range(lb + 1):
        d[0][j] = j

    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(
                d[i - 1][j] + 1,        # deletion
                d[i][j - 1] + 1,        # insertion
                d[i - 1][j - 1] + cost,  # substitution
            )
            if (
                i > 1 and j > 1
                and a[i - 1] == b[j - 2]
                and a[i - 2] == b[j - 1]
            ):
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)  # transposition

    return d[la][lb]


def _word_edit_budget(word: str) -> int:
    """Per-word edit budget, proportional to that word's own length, using
    the same 20% ceiling as the phrase-level budget."""
    return math.floor(_FUZZY_MAX_EDIT_RATIO * len(word))


def _covers_all_words_within_window(
    kw_words: list[str], text_tokens: list[str], _unused_max_edits: int = None,
) -> bool:
    """
    Rule 4 — all-word coverage. Slide an N-token window across text_tokens
    (N = len(kw_words)) and check whether, at ANY window position, every
    keyword word has some window token within its own per-word edit budget.

    Returns True on the first window position where all N words are covered.
    """
    n = len(kw_words)
    if n == 0 or len(text_tokens) < n:
        return False

    word_budgets = [_word_edit_budget(w) for w in kw_words]

    for start in range(0, len(text_tokens) - n + 1):
        window = text_tokens[start:start + n]
        if _all_words_covered_in_window(kw_words, word_budgets, window):
            return True
    return False


def _all_words_covered_in_window(
    kw_words: list[str], word_budgets: list[int], window: list[str],
) -> bool:
    """Every keyword word must be within its edit budget of SOME token in
    the window (not necessarily the token at the same index — handles
    word-order variance / minor insertions within the window)."""
    for kw_word, budget in zip(kw_words, word_budgets):
        if not any(
            damerau_levenshtein(kw_word, tok) <= budget
            for tok in window
        ):
            return False
    return True


def _collides_with_other_game_exact_keyword(text: str, focal_game_id) -> bool:
    """
    Rule 5 — cross-game precedence guard. Returns True if `text` contains an
    exact (Layer-1) keyword match belonging to a DIFFERENT active game in the
    catalogue, meaning that other game's exact hit should win and this
    Layer-2 fuzzy hit should be discarded.

    Queries the live DB for all other active games' keyword lists. Falls
    back to the static GAME_KEYWORD_FALLBACK registry if a DB session isn't
    available (e.g. in unit tests using plain mock Game objects) — best
    effort, never raises.
    """
    try:
        from database import SessionLocal  # local import to avoid any
        from models import Game            # circular-import risk at module load

        db = SessionLocal()
        try:
            other_games = (
                db.query(Game)
                .filter(Game.is_active == True)  # noqa: E712
                .all()
            )
            for other in other_games:
                if getattr(other, "id", None) == focal_game_id:
                    continue
                other_keywords = _get_keywords(other)
                if not other_keywords:
                    continue
                if _find_keyword_matches(text, other_keywords):
                    return True
            return False
        finally:
            db.close()
    except Exception as exc:
        logger.debug(
            "Cross-game collision guard: DB lookup unavailable (%s); "
            "falling back to static registry only.", exc,
        )
        for other_name, other_keywords in GAME_KEYWORD_FALLBACK.items():
            if not other_keywords:
                continue
            if _find_keyword_matches(text, other_keywords):
                return True
        return False


def _fuzzy_match_relevant(
    text: str,
    keywords: list[str],
    game_name_for_log: str,
    game_id_for_log,
    post_id_for_log=None,
) -> bool:
    """
    Layer 2 fallback. Only called when Layer 1 (exact substring match) found
    nothing. Tolerates typos on MULTI-WORD keywords only; never fuzzy-matches
    single-word keywords (those must hit Layer 1 exactly).

    v2 (2026-07-24): also matches CONCATENATED variants of multi-word keywords
    against single tokens. Users and URLs frequently drop the space between
    words in a game title — e.g. r/turokorigins in a subreddit slug, @turokorigins
    Twitter handle, x.com/turokorigins/... URL, discord.gg/spacemarine2, or
    simply typing 'BusBound' or 'JurassicParkSurvival'. Without this check,
    those posts are correctly identified as being about the game by a human
    but fail Layer 2's word-window rule (which requires N separate tokens for
    an N-word keyword). This check preserves the strict 20% edit budget so
    it still rejects unrelated tokens.
    """
    text_tokens = _tokenize(text)
    for kw in keywords:
        kw_stripped = kw.strip()
        if not kw_stripped:
            continue
        kw_words = kw_stripped.split()
        if len(kw_words) < 2:
            continue  # rule 1: single-word keywords are exact-only, never fuzzy
        if len(kw_stripped) < _FUZZY_MIN_KEYWORD_LEN:
            continue  # rule 2: length floor — short phrases are exact-only
        # rule 3 (2026-07-25): reject fuzzy match on keywords that contain
        # a word which is BOTH short (≤3 chars) AND a common English word.
        # Short collision-prone words (ILL, GO, PC, RE) admit false positives
        # because the sliding window matches whenever the short word AND
        # any other keyword word both appear anywhere in the text.
        # Ex: kw='ILL game' was admitting 'HELP ME I NEED A GAME... GIVE ME
        # A GAME ILL PLAY IT' (both 'ill' and 'game' present, distance=0).
        # These keywords are forced to Layer 1 (exact substring) only.
        #
        # Distinctive short proper nouns like 'Bus' in 'Bus Bound' are still
        # eligible for fuzzy match — they're not in the collision set.
        if any(
            w.strip(":;,.!?/-'\"").lower() in _SHORT_COLLISION_WORDS
            for w in kw_words
        ):
            continue

        matched_via = None

        # Layer 2a — sliding-window over separate tokens (original behavior).
        if _covers_all_words_within_window(kw_words, text_tokens):
            matched_via = "window"
        else:
            # Layer 2b (v2 2026-07-24) — concatenated single-token match.
            # Try the keyword with spaces removed ("turok origins" -> "turokorigins")
            # against every token in the post. Same 20% edit budget as the
            # sliding-window path. Only applies to keywords with 2+ words and
            # length >= 8 (same eligibility as the window path).
            concat = "".join(kw_words).lower()
            budget = math.floor(_FUZZY_MAX_EDIT_RATIO * len(concat))
            for tok in text_tokens:
                # Cheap early-exit: skip tokens whose length is way off.
                if abs(len(tok) - len(concat)) > budget:
                    continue
                if damerau_levenshtein(concat, tok) <= budget:
                    matched_via = f"concat({tok!r})"
                    break

        if matched_via:
            # rule 5 guard — a different game's exact Layer-1 hit takes precedence
            if _collides_with_other_game_exact_keyword(text, game_id_for_log):
                logger.debug(
                    "LAYER2_FUZZY_SKIP post_id=%s game_id=%s game=%r keyword=%r "
                    "— skipped: exact hit for a different game takes precedence.",
                    post_id_for_log, game_id_for_log, game_name_for_log, kw_stripped,
                )
                continue

            max_edits = math.floor(_FUZZY_MAX_EDIT_RATIO * len(kw_stripped))
            logger.info(
                "LAYER2_FUZZY_HIT post_id=%s game_id=%s game_name=%r keyword=%r "
                "edit_distance=%d via=%s matched_text=%r",
                post_id_for_log, game_id_for_log, game_name_for_log,
                kw_stripped, max_edits, matched_via, text[:160],
            )
            return True
    return False
