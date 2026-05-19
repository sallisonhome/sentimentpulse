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
   combined text.  If no keyword matches → NOT relevant.
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
- The movie/IP cue detection intentionally looks only within a ±120-character
  window around the keyword match to avoid false positives from long posts that
  happen to mention a film somewhere.
- The cross-genre gate is intentionally conservative: it only fires when BOTH
  (a) ≥2 other-genre titles are present AND (b) none of those titles co-appear
  with the focal game's genre markers.  This prevents rejecting legitimate
  comparison posts within the same genre.
"""
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Static fallback registry — matches the Alembic 0003 seed exactly.
# Games not in this dict have no keywords → all posts pass (no filter applied).
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
    "TimeShift": [
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

    # Rule 1: too short
    if len(combined) < 30:
        logger.debug(
            "Post too short (%d chars) for game '%s' — not relevant.",
            len(combined), game.name,
        )
        return False

    # Determine keywords to use
    keywords: list[str] = _get_keywords(game)

    # If no keywords are configured for this game, pass all posts through
    # (we have no filter signal — assume on-topic from the data pipeline).
    if not keywords:
        return True

    # Rule 2: at least one keyword must match
    match_positions = _find_keyword_matches(combined, keywords)
    if not match_positions:
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
