"""
Arctic Shift service — Reddit post fetching via Arctic Shift API.

Arctic Shift (https://arctic-shift.photon-reddit.com) is the working
Pushshift-style Reddit archive that succeeded Pushshift after Reddit's 2023 API
policy changes. Reddit itself has globally hard-blocked anonymous JSON requests
since late May 2026 (HTTP 403 on all .json endpoints). Arctic Shift is confirmed
reachable from the droplet (104.236.239.46) with HTTP 200 and real post data.

Usage:
    from services.arctic_shift_service import fetch_arctic_shift_subreddit_posts

This module is intentionally small and focused. All exceptions are caught and
logged; the caller never receives a raised exception, only an empty list.
"""
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

ARCTIC_SHIFT_BASE = "https://arctic-shift.photon-reddit.com/api/posts/search"

# Descriptive User-Agent is courteous to Arctic Shift's free public API.
ARCTIC_SHIFT_USER_AGENT = "SentimentPulse/1.0 (Saber Interactive game intel)"

_HEADERS = {
    "User-Agent": ARCTIC_SHIFT_USER_AGENT,
    "Accept": "application/json",
}

_TIMEOUT = 15  # seconds per request

# Courtesy delay between requests to respect Arctic Shift's rate limit
# (2 000 requests/hour is visible in response headers).
_REQUEST_DELAY = 1.0  # seconds

# Large general subreddits where posts must be filtered by game name.
# Mirrors the _GENERAL_SUBREDDITS constant in reddit_service.py.
# Kept as a standalone copy here so callers only need to import one module.
#
# 2026-08-12: Expanded to include horror-genre and console-generic subs that
# were being pulled wholesale for the Hellraiser: Revival game. Audit of 3-day
# posts showed 1,058 out of 1,082 noise posts came from r/horror (449), r/
# residentevil (344), r/playstation (101), r/HorrorGaming (91), r/HorrorGames
# (50), r/survivalhorror (22). These are all genre/console subs where a title
# is a small fraction of daily traffic — must be filtered by game name.
#
# Match is case-insensitive (via sub_lower in fetch_arctic_shift_subreddit_posts),
# so keep the canonical case used in subreddit URLs where possible.
ARCTIC_SHIFT_GENERAL_SUBS: frozenset[str] = frozenset({
    # Console + PC platform subs (always general — any game gets a small share)
    "gaming", "games", "pcgaming", "ps5", "playstation", "xbox", "XboxSeriesX",
    "steam", "SteamDeck",
    # Broad discovery / discussion subs
    "patientgamers", "ShouldIbuythisgame", "truegaming",
    "GamingLeaksAndRumors", "gamingleaksandrumors", "GamingNews",
    "ShooterGames", "thirdpersonshooter", "FPS", "CoopGaming",
    # IP / genre subs — include the ones we've observed producing noise
    "halo", "ghostbusters", "JurassicPark", "hellraiser", "JohnWick",
    "horror", "HorrorGaming", "HorrorGames", "survivalhorror", "SurvivalHorror",
    "residentevil", "ResidentEvil",
    "Spacemarine", "Saberinteractive", "BossTeamGames",
    # Publisher / dev subs where posts span the studio's full catalog
    "GearsOfWar", "XboxGamePass",
})


# ── Private helpers ───────────────────────────────────────────────────────────

def _game_search_query(game_name: str) -> str:
    """
    Extract the most distinctive search term from a game name.

    Strips possessive studio/director prefixes (e.g. "John Carpenter's Toxic
    Commando" → "Toxic Commando") so searches target the actual game title
    rather than the studio/creator's name.  Mirrors the same helper in
    reddit_service.py.
    """
    if "'s " in game_name:
        game_name = game_name.split("'s ", 1)[1]
    return game_name.strip()


def _post_mentions_game(post: dict, search_query: str) -> bool:
    """
    Return True if the post title or body contains at least one distinctive
    keyword from the search_query (case-insensitive, ≥4 chars, ignoring common
    English stop-words).  Mirrors the same helper in reddit_service.py.
    """
    _STOP = {
        "the", "and", "for", "with", "from", "this", "that", "have",
        "game", "games", "just", "your", "more", "about", "like",
    }
    text = (
        (post.get("title") or "") + " " + (post.get("body") or "")
    ).lower()

    for word in search_query.lower().split():
        word = word.strip("':,-.")
        if len(word) >= 4 and word not in _STOP:
            if word in text:
                return True
    return False


def _convert_post(raw: dict) -> Optional[dict]:
    """
    Convert a single Arctic Shift / Reddit-format post dict to the standard
    shape expected by the rest of the SentimentPulse pipeline.

    Returns None if the post has no usable id (silently skipped by caller).
    """
    external_id = raw.get("id", "")
    if not external_id:
        return None

    # Parse created_utc (unix timestamp) into a Python datetime so SQLAlchemy's
    # DateTime column can store it.  Previous versions used .isoformat() which
    # returned a string; SQLite rejects string inputs to DateTime columns with
    # StatementError(TypeError), and _bulk_save_posts caught those silently,
    # resulting in 0 Reddit rows saved despite Arctic Shift returning posts.
    # See CLAUDE.md §19 (ground truth) and lessons.md 2026-05-30.
    post_date: Optional[datetime] = None
    created = raw.get("created_utc")
    if created is not None:
        try:
            post_date = datetime.fromtimestamp(
                float(created), tz=timezone.utc
            )
        except (ValueError, TypeError, OSError):
            post_date = None

    permalink = raw.get("permalink", "") or ""
    url = f"https://www.reddit.com{permalink}" if permalink else ""

    selftext = raw.get("selftext") or ""
    body = selftext[:2000]  # truncate to match _post_to_dict in reddit_service

    return {
        "external_id": external_id,
        "author": raw.get("author") or "[deleted]",
        "title": raw.get("title") or "",
        "body": body,
        "url": url,
        "upvotes": max(0, int(raw.get("score", 0) or 0)),
        "post_date": post_date,
    }


def _fetch_one(params: dict) -> list[dict]:
    """
    Issue one HTTP GET to Arctic Shift and return converted post dicts.

    Returns an empty list on any error (HTTP error, timeout, bad JSON).
    Sleeps _REQUEST_DELAY seconds after the request regardless of outcome.
    """
    try:
        resp = requests.get(
            ARCTIC_SHIFT_BASE,
            params=params,
            headers=_HEADERS,
            timeout=_TIMEOUT,
        )
    except Exception as exc:
        logger.warning("arctic_shift: request failed — %s", exc)
        time.sleep(_REQUEST_DELAY)
        return []
    finally:
        pass  # sleep happens below so it also fires on the happy path

    time.sleep(_REQUEST_DELAY)

    if resp.status_code != 200:
        logger.warning(
            "arctic_shift: HTTP %d for params=%s", resp.status_code, params
        )
        return []

    try:
        data = resp.json()
    except Exception as exc:
        logger.warning("arctic_shift: failed to parse JSON — %s", exc)
        return []

    if not isinstance(data, dict):
        logger.warning("arctic_shift: unexpected response type %s", type(data))
        return []

    if "error" in data:
        logger.warning("arctic_shift: API returned error field — %s", data["error"])
        return []

    raw_posts = data.get("data")
    if not raw_posts:
        return []

    results: list[dict] = []
    for raw in raw_posts:
        converted = _convert_post(raw)
        if converted is not None:
            results.append(converted)

    return results


# ── Public API ────────────────────────────────────────────────────────────────

def fetch_arctic_shift_subreddit_posts(
    subreddit_name: str,
    limit: int = 100,
    game_name: str = "",
    is_general_sub: bool = False,
) -> list[dict]:
    """
    Fetch posts from a single subreddit via Arctic Shift.

    For game-specific subs (e.g. r/Spacemarine, is_general_sub=False):
        ONE request: ?subreddit=<sub>&limit=<n>&sort=desc

    For general subs (e.g. r/gaming, r/pcgaming) with a game_name:
        TWO requests: ?subreddit=<sub>&title=<q>&limit=<n>&sort=desc
                      ?subreddit=<sub>&selftext=<q>&limit=<n>&sort=desc
        Arctic Shift has no single 'q' param; title+selftext is the workaround.
        Results are merged by id and post-filtered via _post_mentions_game().

    If is_general_sub=True but game_name is empty, falls back to the
    game-specific-sub path (single request, no filtering needed).

    Returns a list of dicts with keys:
        external_id, author, title, body (≤2000 chars), url, upvotes, post_date

    NEVER raises — all exceptions are caught and logged; returns [] on failure.
    """
    status = "ok"
    posts_returned = 0
    try:
        sub_lower = subreddit_name.lower()
        use_search = is_general_sub and bool(game_name)

        if use_search:
            # Two-request path: search title then selftext, then merge + filter
            query = _game_search_query(game_name)
            seen: dict[str, dict] = {}

            for field in ("title", "selftext"):
                params = {
                    "subreddit": subreddit_name,
                    field: query,
                    "limit": limit,
                    "sort": "desc",
                }
                for post in _fetch_one(params):
                    pid = post["external_id"]
                    if pid not in seen:
                        seen[pid] = post

            # Post-filter: keep only posts that actually mention the game
            merged = [
                p for p in seen.values()
                if _post_mentions_game(p, query)
            ]
            posts_returned = len(merged)
            return merged

        else:
            # Single-request path: all recent posts from the subreddit
            params = {
                "subreddit": subreddit_name,
                "limit": limit,
                "sort": "desc",
            }
            results = _fetch_one(params)
            posts_returned = len(results)
            return results

    except Exception as exc:
        status = "error"
        logger.error(
            "arctic_shift: unexpected error for r/%s game='%s': %s",
            subreddit_name, game_name, exc,
        )
        return []

    finally:
        # Structured metric line — grep for this in logs to track daily yields
        logger.info(
            "arctic_shift_metric subreddit=%s game=%s general=%s posts=%d status=%s",
            subreddit_name,
            game_name or "(none)",
            is_general_sub,
            posts_returned,
            status,
        )
