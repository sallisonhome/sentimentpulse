"""
Reddit service — subreddit post and comment fetching via Reddit's public
JSON endpoint (no API credentials required).

Endpoints used:
  GET https://www.reddit.com/r/{sub}/new.json?limit=100
  GET https://www.reddit.com/r/{sub}/hot.json?limit=100
  GET https://www.reddit.com/comments/{post_id}.json?limit=50&depth=1
  GET https://www.reddit.com/subreddits/search.json?q={query}&limit=5

Reddit requires a descriptive User-Agent; requests without one are rate-
limited aggressively.  All calls are wrapped in try/except so failures are
logged, not raised.
"""
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import httpx

from config import settings

logger = logging.getLogger(__name__)

_BASE = "https://www.reddit.com"
_HEADERS = {
    "User-Agent": settings.reddit_user_agent or "SentimentPulse/1.0",
    "Accept": "application/json",
}
_TIMEOUT = 15.0          # seconds per request
_REQUEST_DELAY = 1.0     # seconds between requests to stay within rate limits
_RETRY_DELAYS = (5, 15)  # seconds to wait on 429 before retrying (2 attempts)


def _get(url: str, params: Optional[dict] = None) -> Optional[dict]:
    """
    GET a Reddit JSON URL.  Returns parsed JSON dict or None on error.
    Retries up to twice on HTTP 429 with increasing back-off delays.
    """
    for attempt, backoff in enumerate([0] + list(_RETRY_DELAYS)):
        if backoff:
            logger.info("Reddit rate-limited (429) — waiting %ds before retry %d", backoff, attempt)
            time.sleep(backoff)
        try:
            resp = httpx.get(url, params=params, headers=_HEADERS, timeout=_TIMEOUT, follow_redirects=True)
            time.sleep(_REQUEST_DELAY)
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 429:
                continue   # retry with next backoff
            logger.warning("Reddit JSON %s returned HTTP %d", url, resp.status_code)
            return None
        except Exception as exc:
            logger.error("Reddit JSON request failed for %s: %s", url, exc)
            return None
    logger.warning("Reddit JSON %s: all retries exhausted after 429s", url)
    return None


# ── Subreddit discovery ───────────────────────────────────────────────────────

def discover_subreddits(game_name: str, max_results: int = 3) -> list[str]:
    """
    Search Reddit for subreddits related to `game_name`.
    Returns a list of subreddit display names (without r/).
    """
    data = _get(
        f"{_BASE}/subreddits/search.json",
        params={"q": f"{game_name} game", "limit": max_results, "include_over_18": "off"},
    )
    if not data:
        return []

    found = []
    for child in data.get("data", {}).get("children", []):
        sub = child.get("data", {})
        name = sub.get("display_name")
        if name:
            found.append(name)

    logger.info("Discovered %d subreddit(s) for '%s': %s", len(found), game_name, found)
    return found[:max_results]


# ── Post fetching ─────────────────────────────────────────────────────────────

def fetch_subreddit_posts(
    subreddit_name: str,
    limit: int = 25,
    game_name: str = "",
) -> list[dict]:
    """
    Fetch posts from a subreddit that mention `game_name`.

    When game_name is provided (always recommended) Reddit's own search is used
    with restrict_sr=1 so only posts within that subreddit are returned and they
    must mention the game name.  This prevents pulling in unrelated posts from
    large general subreddits like r/gaming.

    Falls back to new+hot feeds only when game_name is empty.

    Each returned dict has:
        external_id, author, title, body, url, upvotes, post_date
    """
    seen: dict[str, dict] = {}

    if game_name:
        search_query = _game_search_query(game_name)
        # Use subreddit search so only game-relevant posts are returned
        for sort in ("new", "relevance"):
            data = _get(
                f"{_BASE}/r/{subreddit_name}/search.json",
                params={
                    "q": search_query,
                    "sort": sort,
                    "limit": limit,
                    "restrict_sr": 1,
                    "raw_json": 1,
                },
            )
            if not data:
                continue
            for child in data.get("data", {}).get("children", []):
                post = child.get("data", {})
                pid = post.get("id")
                if pid and pid not in seen:
                    post_dict = _post_to_dict(post)
                    # Secondary filter: post must actually mention the game
                    if _post_mentions_game(post_dict, search_query):
                        seen[pid] = post_dict
    else:
        # Fallback: no game filter — fetch new and hot feeds unfiltered
        for feed in ("new", "hot"):
            data = _get(
                f"{_BASE}/r/{subreddit_name}/{feed}.json",
                params={"limit": limit, "raw_json": 1},
            )
            if not data:
                continue
            for child in data.get("data", {}).get("children", []):
                post = child.get("data", {})
                pid = post.get("id")
                if pid and pid not in seen:
                    seen[pid] = _post_to_dict(post)

    posts = list(seen.values())
    logger.info(
        "Fetched %d post(s) from r/%s%s",
        len(posts), subreddit_name,
        f" (search: '{game_name}')" if game_name else "",
    )
    return posts


# ── Comment fetching ──────────────────────────────────────────────────────────

def fetch_post_comments(
    submission_id: str,
    limit: int = 50,
) -> list[dict]:
    """
    Fetch top-level comments from a Reddit post.

    Each returned dict has:
        external_id, author, title (None), body, url, upvotes, post_date
    """
    data = _get(
        f"{_BASE}/comments/{submission_id}.json",
        params={"limit": limit, "depth": 1, "raw_json": 1},
    )
    if not data or not isinstance(data, list) or len(data) < 2:
        return []

    comments = []
    for child in data[1].get("data", {}).get("children", []):
        c = child.get("data", {})
        body = c.get("body", "")
        # Skip deleted/removed comments and non-text nodes
        if not body or body in ("[deleted]", "[removed]"):
            continue
        cid = c.get("id")
        if not cid:
            continue
        comments.append({
            "external_id": f"comment_{cid}",
            "author": c.get("author", "[deleted]"),
            "title": None,
            "body": body,
            "url": f"{_BASE}{c.get('permalink', '')}",
            "upvotes": max(0, int(c.get("score", 0))),
            "post_date": datetime.fromtimestamp(
                float(c.get("created_utc", 0)), tz=timezone.utc
            ),
        })

    return comments[:limit]


# ── Private helpers ───────────────────────────────────────────────────────────

def _game_search_query(game_name: str) -> str:
    """
    Extract the most distinctive search term from a game name.

    Strips possessive studio/director prefixes (e.g. "John Carpenter's Toxic
    Commando" → "Toxic Commando") so searches target the actual game title
    rather than the studio/creator's name.
    """
    # Strip "Studio's " / "Director's " possessive prefix
    if "'s " in game_name:
        game_name = game_name.split("'s ", 1)[1]
    return game_name.strip()


def _post_mentions_game(post: dict, search_query: str) -> bool:
    """
    Return True if the post title or body contains at least one distinctive
    keyword from the search query (case-insensitive, min 4 chars, ignoring
    common English stop-words).
    """
    _STOP = {
        "the", "and", "for", "with", "from", "this", "that", "have",
        "game", "games", "just", "your", "more", "about", "like",
    }
    text = (
        (post.get("title") or "") + " " + (post.get("body") or "")
    ).lower()

    for word in search_query.lower().split():
        # Strip punctuation from word edges
        word = word.strip("':,-.")
        if len(word) >= 4 and word not in _STOP:
            if word in text:
                return True
    return False


def _post_to_dict(post: dict) -> dict:
    """Convert a Reddit JSON post data dict to our standard post dict."""
    return {
        "external_id": post.get("id", ""),
        "author": post.get("author", "[deleted]"),
        "title": post.get("title", ""),
        "body": post.get("selftext", "") or "",
        "url": f"{_BASE}{post.get('permalink', '')}",
        "upvotes": max(0, int(post.get("score", 0))),
        "post_date": datetime.fromtimestamp(
            float(post.get("created_utc", 0)), tz=timezone.utc
        ),
    }
