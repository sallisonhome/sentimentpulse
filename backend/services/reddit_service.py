"""
Reddit service — subreddit post and comment fetching.

Uses multiple strategies to avoid 403 blocks from datacenter IPs:
  1. old.reddit.com with browser-like User-Agent (primary)
  2. Reddit RSS/Atom feeds as fallback (never blocked)
  3. www.reddit.com JSON as last resort

All calls are wrapped in try/except so failures are logged, not raised.
"""
import logging
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

import httpx

from config import settings

logger = logging.getLogger(__name__)

# Try old.reddit.com first — less aggressive blocking than www
_BASES = ["https://old.reddit.com", "https://www.reddit.com"]
_BASE = _BASES[0]
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
}
_JSON_HEADERS = {
    "User-Agent": _HEADERS["User-Agent"],
    "Accept": "application/json",
}
_TIMEOUT = 20.0          # seconds per request
_REQUEST_DELAY = 2.0     # seconds between requests to stay within rate limits
_RETRY_DELAYS = (5, 15)  # seconds to wait on 429 before retrying (2 attempts)


def _get(url: str, params: Optional[dict] = None) -> Optional[dict]:
    """
    GET a Reddit JSON URL.  Tries old.reddit.com first, then www.
    Retries up to twice on HTTP 429 with increasing back-off delays.
    Falls back between base URLs on 403.
    """
    # Try each base URL
    for base in _BASES:
        # Replace the base URL if the caller used a different one
        actual_url = url
        for b in _BASES:
            if actual_url.startswith(b):
                actual_url = actual_url.replace(b, base, 1)
                break

        for attempt, backoff in enumerate([0] + list(_RETRY_DELAYS)):
            if backoff:
                logger.info("Reddit rate-limited (429) — waiting %ds before retry %d", backoff, attempt)
                time.sleep(backoff)
            try:
                resp = httpx.get(
                    actual_url, params=params, headers=_JSON_HEADERS,
                    timeout=_TIMEOUT, follow_redirects=True,
                )
                time.sleep(_REQUEST_DELAY)
                if resp.status_code == 200:
                    return resp.json()
                if resp.status_code == 429:
                    continue   # retry with next backoff
                if resp.status_code == 403:
                    logger.warning("Reddit 403 on %s — trying next base URL", base)
                    break  # try next base URL
                logger.warning("Reddit JSON %s returned HTTP %d", actual_url, resp.status_code)
                return None
            except Exception as exc:
                logger.error("Reddit JSON request failed for %s: %s", actual_url, exc)
                return None

    # All base URLs returned 403 — try RSS fallback
    logger.warning("Reddit JSON blocked on all endpoints for %s — will use RSS fallback if available", url)
    return None


# Large general subreddits where posts must be filtered by game name.
# Dedicated game subs (e.g. r/snowrunner) don't need filtering since
# every post is already about the game.
_GENERAL_SUBREDDITS = {
    "gaming", "games", "pcgaming", "ps5", "xbox", "steam",
    "halo", "ghostbusters", "JurassicPark", "hellraiser", "JohnWick",
    "patientgamers", "ShouldIbuythisgame",
}


def _fetch_rss(subreddit_name: str, game_name: str = "", force_filter: bool = False) -> list[dict]:
    """
    Fetch posts from a subreddit via RSS feed (never blocked by Reddit).
    Returns posts in the same dict format as fetch_subreddit_posts.
    RSS feeds return ~25 most recent posts with no search filtering.
    Game name filtering is only applied for general subreddits, not
    dedicated game subs where every post is relevant.
    """
    rss_url = f"https://www.reddit.com/r/{subreddit_name}/new.rss?limit=50"
    try:
        resp = httpx.get(rss_url, headers=_HEADERS, timeout=_TIMEOUT, follow_redirects=True)
        time.sleep(_REQUEST_DELAY)
        if resp.status_code != 200:
            logger.warning("Reddit RSS for r/%s returned HTTP %d", subreddit_name, resp.status_code)
            return []
    except Exception as exc:
        logger.error("Reddit RSS request failed for r/%s: %s", subreddit_name, exc)
        return []

    posts = []
    try:
        root = ET.fromstring(resp.text)
        # Atom feed namespace
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        for entry in root.findall("atom:entry", ns):
            title = (entry.findtext("atom:title", "", ns) or "").strip()
            # Extract body from content (HTML — strip tags roughly)
            content_el = entry.find("atom:content", ns)
            body = ""
            if content_el is not None and content_el.text:
                # Rough HTML tag stripping
                import re
                body = re.sub(r"<[^>]+>", " ", content_el.text).strip()
                body = re.sub(r"\s+", " ", body)

            link_el = entry.find('atom:link[@rel="alternate"]', ns)
            url = link_el.get("href", "") if link_el is not None else ""

            # Extract post ID from URL: /r/sub/comments/POST_ID/...
            external_id = ""
            if "/comments/" in url:
                parts = url.split("/comments/")
                if len(parts) > 1:
                    external_id = parts[1].split("/")[0]

            author_el = entry.find("atom:author/atom:name", ns)
            author = author_el.text if author_el is not None else "[unknown]"

            updated = entry.findtext("atom:updated", "", ns)
            post_date = None
            if updated:
                try:
                    post_date = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                except Exception:
                    pass

            if not external_id:
                continue

            post_dict = {
                "external_id": external_id,
                "author": author.replace("/u/", ""),
                "title": title,
                "body": body[:2000],
                "url": url,
                "upvotes": 0,  # RSS doesn't include scores
                "post_date": post_date,
            }
            posts.append(post_dict)
    except ET.ParseError as exc:
        logger.error("Failed to parse RSS for r/%s: %s", subreddit_name, exc)
        return []

    # Only filter by game name for general subreddits.
    # Dedicated game subs (r/snowrunner, r/Spacemarine, etc.) don't need
    # filtering — every post is already about the game.
    is_general = subreddit_name.lower() in {s.lower() for s in _GENERAL_SUBREDDITS}
    if game_name and (is_general or force_filter):
        search_query = _game_search_query(game_name)
        filtered = [p for p in posts if _post_mentions_game(p, search_query)]
        logger.info("Fetched %d post(s) from r/%s via RSS (filtered %d→%d for '%s')",
                    len(posts), subreddit_name, len(posts), len(filtered), game_name)
        return filtered

    logger.info("Fetched %d post(s) from r/%s via RSS (dedicated sub, no filter)",
                len(posts), subreddit_name)
    return posts


# ── PullPush API fallback ─────────────────────────────────────────────────────

_PULLPUSH_BASE = "https://api.pullpush.io"


def _fetch_pullpush(
    subreddit_name: str,
    game_name: str = "",
    limit: int = 25,
) -> list[dict]:
    """
    Fetch recent posts from a subreddit via the PullPush API (free Reddit
    archive). Works from any IP — no authentication required.

    For dedicated game subs, fetches all recent posts.
    For general subs, searches by game name.
    """
    is_general = subreddit_name.lower() in {s.lower() for s in _GENERAL_SUBREDDITS}

    params: dict = {
        "subreddit": subreddit_name,
        "size": limit,
        "sort": "desc",
        "sort_type": "created_utc",
    }

    # Only add search query for general subs
    if game_name and is_general:
        params["q"] = _game_search_query(game_name)

    try:
        resp = httpx.get(
            f"{_PULLPUSH_BASE}/reddit/search/submission/",
            params=params,
            headers={"User-Agent": "SentimentPulse/1.0"},
            timeout=_TIMEOUT,
        )
        time.sleep(_REQUEST_DELAY)
        if resp.status_code != 200:
            logger.warning("PullPush API returned HTTP %d for r/%s", resp.status_code, subreddit_name)
            return []
        data = resp.json()
    except Exception as exc:
        logger.error("PullPush API request failed for r/%s: %s", subreddit_name, exc)
        return []

    posts = []
    for item in data.get("data", []):
        external_id = item.get("id", "")
        if not external_id:
            continue

        post_date = None
        created = item.get("created_utc")
        if created:
            try:
                post_date = datetime.fromtimestamp(float(created), tz=timezone.utc)
            except Exception:
                pass

        permalink = item.get("permalink", "")
        url = f"https://www.reddit.com{permalink}" if permalink else ""

        post_dict = {
            "external_id": external_id,
            "author": item.get("author", "[deleted]"),
            "title": item.get("title", ""),
            "body": (item.get("selftext", "") or "")[:2000],
            "url": url,
            "upvotes": max(0, int(item.get("score", 0))),
            "post_date": post_date,
        }
        posts.append(post_dict)

    logger.info(
        "Fetched %d post(s) from r/%s via PullPush%s",
        len(posts), subreddit_name,
        f" (search: '{game_name}')" if (game_name and is_general) else " (dedicated sub, all posts)",
    )
    return posts


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

    # If JSON endpoints returned nothing (likely 403 blocked), try PullPush
    if not posts:
        logger.info("No posts via JSON for r/%s — trying PullPush API", subreddit_name)
        posts = _fetch_pullpush(subreddit_name, game_name=game_name, limit=100)
    else:
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
