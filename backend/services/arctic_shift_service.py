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

# Large general subreddits where posts must be filtered by game name at
# fetch time (title/selftext search + _post_mentions_game post-filter).
#
# 2026-08-12 revert: audit-first workflow now applied downstream via
# raw_posts.relevance_tier tagging. Only include subs where the search-
# path is genuinely necessary because unfiltered fetches would exceed
# Arctic Shift's per-request post cap. Everything else uses full fetch
# and gets tagged (never dropped) at ingest.
# v0019 (2026-08-19): ARCTIC_SHIFT_GENERAL_SUBS previously duplicated
# reddit_service._GENERAL_SUBREDDITS and drifted — the two lists were
# out of sync, so subs like r/pcmasterrace, r/playstation, r/XboxSeriesX,
# r/GamingLeaksAndRumours (which _ARE_ general in reddit_service.py) were
# being treated as DEDICATED here. That skipped the title/selftext search
# + _post_mentions_game filter, so daily ingest was silently saving 100
# random r/pcmasterrace posts per day per affected game as if they were
# about the game (17 games affected, incl Twisted Tower, Toxic Commando,
# Hellraiser Revival, SM2, Turok Origins, Jurassic Park Survival, John
# Wick, Rideshare, Bus Bound, Stuntman, Aliens FE2, Gears E-Day, Silent
# Hill Townfall, Halloween The Game, ILL, WWZ, Insurgency).
#
# Fix: single source of truth. arctic_shift_service imports the reddit_service
# list. The name is kept as an alias for backward compat with call sites.
from services.reddit_service import _GENERAL_SUBREDDITS as _RS_GENERAL_SUBS  # noqa: E402
ARCTIC_SHIFT_GENERAL_SUBS: frozenset[str] = frozenset(s.lower() for s in _RS_GENERAL_SUBS)


# ── Private helpers ───────────────────────────────────────────────────────────

# _game_search_query has grown a `game=` kwarg in reddit_service.py (v3
# 2026-08-12 rideshare-collision fix; v3.1 disabled the branch but kept
# the signature). The local copy in this file previously did NOT accept
# the kwarg, so every call at ~line 237 below — which passes `game=game`
# — raised TypeError silently killing arctic_shift's general-sub fetch
# for every game whose subreddit list included r/gaming, r/Games, r/PS5,
# r/xbox, r/pcgaming, r/patientgamers, r/ShouldIbuythisgame, r/SteamDeck,
# etc. Observed 2026-08-18 in journal after Halloween: The Game and
# Rideshare Stimulator emitted a wall of "unexpected keyword argument
# 'game'" errors during a Phase-A run that then exceeded its wallclock
# budget and skipped 4 tail-of-list games.
#
# Fix (2026-08-18): import from reddit_service so the two never drift.
# No circular-import risk — reddit_service does not import anything
# from arctic_shift_service.
from services.reddit_service import (  # noqa: E402
    _game_search_query as _game_search_query,
)


# v0019 (2026-08-19): the two _post_mentions_game copies drifted between
# reddit_service.py and arctic_shift_service.py, causing enforcement gaps.
# Single source of truth now lives in reddit_service; import it here.
from services.reddit_service import _post_mentions_game as _post_mentions_game  # noqa: E402, F401


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
    game=None,
    after: int = 0,
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
            # v0016.8 (2026-08-12): pass game through so ambiguous-fallback
            # games like Rideshare Stimulator use their multi-word phrase
            # query from distinctive_keywords instead of the generic single
            # word (which would match unrelated ride-share industry posts).
            query = _game_search_query(game_name, game=game)
            seen: dict[str, dict] = {}

            for field in ("title", "selftext"):
                params = {
                    "subreddit": subreddit_name,
                    field: query,
                    "limit": limit,
                    "sort": "desc",
                }
                # v0018 (2026-08-19): incremental fetch — pass after=<epoch>
                # so Arctic Shift only returns posts newer than the last
                # ones we've saved.  Zero (default) means "no filter", i.e.
                # full fresh fetch (used by backfill).
                if after > 0:
                    params["after"] = after
                for post in _fetch_one(params):
                    pid = post["external_id"]
                    if pid not in seen:
                        seen[pid] = post

            # Post-filter: keep only posts that actually mention the game.
            # v0019: pass game.distinctive_keywords so games with common-
            # English primary words (Rideshare, Docked) get the strict
            # two-token gate instead of the permissive any-word match.
            _dk = None
            if game is not None:
                _dk = getattr(game, "distinctive_keywords", None) or None
            merged = [
                p for p in seen.values()
                if _post_mentions_game(p, query, distinctive_keywords=_dk)
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
            # v0018: incremental fetch (see title/selftext branch above).
            if after > 0:
                params["after"] = after
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


# ─── Comment fetching (v0016, 2026-08-12) ───────────────────────────────────
#
# Arctic Shift exposes /api/comments/search with a link_id filter that returns
# comments attached to a specific submission. Reddit's own JSON endpoint is
# blocked from datacenter IPs, so this is our only path to comment content.
# Response shape mirrors /api/posts/search: {"data": [ {...}, ... ]}.
#
# Rate limiting: same _REQUEST_DELAY applies. One comment fetch per parent
# submission per ingestion run — total additional load per game is bounded
# by the number of new "signal" or "dedicated_sub" reddit rows added that
# run (usually well under 30).

ARCTIC_SHIFT_COMMENTS_BASE = "https://arctic-shift.photon-reddit.com/api/comments/search"


def _convert_comment(raw: dict, parent_permalink: Optional[str]) -> Optional[dict]:
    """
    Convert an Arctic Shift comment dict to the shape _bulk_save_posts expects.

    - Skips deleted/removed comments (body == '[deleted]' or '[removed]')
      to avoid ingesting empty rows with no analyzable text.
    - Skips comments with no id or empty body.
    - Uses the parent's permalink + comment id to synthesise a stable url.
    """
    external_id = raw.get("id", "")
    body = (raw.get("body") or "").strip()
    if not external_id or not body:
        return None
    if body in ("[deleted]", "[removed]"):
        return None

    post_date: Optional[datetime] = None
    created = raw.get("created_utc")
    if created is not None:
        try:
            post_date = datetime.fromtimestamp(
                float(created), tz=timezone.utc
            )
        except (ValueError, TypeError, OSError):
            post_date = None

    # Reddit permalinks look like /r/PS5/comments/1vknbt9/.../k9xxx/
    # Arctic Shift usually returns a `permalink` field on comments too.
    permalink = raw.get("permalink") or ""
    if permalink:
        url = f"https://www.reddit.com{permalink}"
    elif parent_permalink:
        url = f"https://www.reddit.com{parent_permalink.rstrip('/')}/{external_id}/"
    else:
        url = ""

    return {
        "external_id": external_id,
        "author": raw.get("author") or "[deleted]",
        "title": "",  # comments have no title; keep empty so tagger looks at body
        "body": body[:4000],  # cap for DB storage; most Reddit comments are <1000 chars
        "url": url,
        "upvotes": max(0, int(raw.get("score", 0) or 0)),
        "post_date": post_date,
    }


def fetch_arctic_shift_comments(
    parent_external_id: str,
    parent_permalink: Optional[str] = None,
    limit: int = 100,
) -> list[dict]:
    """
    Fetch comments attached to a Reddit submission via Arctic Shift.

    Args:
        parent_external_id: Reddit submission id (e.g. '1vknbt9') — the fragment
                            between '/comments/' and the slug in the URL.
        parent_permalink:   Submission permalink so we can build absolute urls
                            for comments when the API omits per-comment permalink.
                            Optional; when None the comment's own permalink field
                            is used, and comments without one get an empty url.
        limit:              Max comments to return per submission. Cap at 100
                            since Arctic Shift enforces that ceiling and comment
                            volume beyond top-100 is usually low-signal.

    Returns:
        List of comment dicts ready to hand to _bulk_save_posts. Empty list on
        any error, network failure, or when the parent has no comments.
    """
    params = {
        "link_id": f"t3_{parent_external_id}",
        "limit": min(int(limit), 100),
        "sort": "desc",
    }
    try:
        resp = requests.get(
            ARCTIC_SHIFT_COMMENTS_BASE,
            params=params,
            timeout=_TIMEOUT,
            headers=_HEADERS,
        )
    except requests.RequestException as exc:
        logger.warning(
            "arctic_shift comments: request failed parent=%s — %s",
            parent_external_id, exc,
        )
        return []

    if resp.status_code != 200:
        logger.warning(
            "arctic_shift comments: HTTP %d parent=%s",
            resp.status_code, parent_external_id,
        )
        return []

    try:
        data = resp.json()
    except Exception as exc:
        logger.warning(
            "arctic_shift comments: bad JSON parent=%s — %s",
            parent_external_id, exc,
        )
        return []

    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []

    converted: list[dict] = []
    for raw in items:
        c = _convert_comment(raw, parent_permalink)
        if c is not None:
            converted.append(c)

    time.sleep(_REQUEST_DELAY)
    return converted
