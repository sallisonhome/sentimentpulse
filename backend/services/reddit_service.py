"""
Reddit service — subreddit post and comment fetching.

Uses multiple strategies to avoid 403 blocks from datacenter IPs:
  1. old.reddit.com with browser-like User-Agent (primary)
  2. Reddit RSS/Atom feeds as fallback (never blocked)
  3. www.reddit.com JSON as last resort

All calls are wrapped in try/except so failures are logged, not raised.
"""
import logging
import re
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


# Large general-gaming subs where posts must be pre-filtered by game name
# because they contain content about many different games. For these,
# we search the sub for a distinctive game-name term BEFORE saving. The
# downstream Step 5 relevance gate then re-checks against distinctive
# keywords for final relevance.
#
# Dedicated game/IP/franchise subs (r/hellraiser, r/JurassicPark,
# r/snowrunner, r/halo, r/Ghostbusters, etc.) are NOT in this list —
# every post in those subs is about that game/IP by definition, and
# the relevance-gate downstream handles finer filtering.
#
# v2 (2026-07-24): removed 'halo', 'ghostbusters', 'JurassicPark',
# 'hellraiser', 'JohnWick' from this list. They are dedicated IP subs —
# every post is on-topic to the IP by definition, and pre-filtering
# them via a search query (which PullPush treats as AND) was the
# reason r/hellraiser was returning 1 post from 2021 for the search
# 'Hellraiser Revival' instead of the ~25 recent Hellraiser-franchise
# posts actually available. Fixing this shifts filtering responsibility
# to the relevance gate at Step 5, which is where game-vs-IP
# disambiguation belongs (see is_post_relevant_to_game).
_GENERAL_SUBREDDITS = {
    # Console/platform subs
    "gaming", "games", "pcgaming", "ps5", "playstation", "xbox",
    "xboxseriesx", "steam", "steamdeck", "nintendoswitch",
    # Meta / discovery subs
    "patientgamers", "shouldibuythisgame", "gamingsuggestions",
    "truegaming", "gamedeals", "gamingleaksandrumours",
    "gamingnews", "gamingnews", "gamedev", "retrogaming",
    "cozygamers", "gamecollecting",
    # Genre subs (broad enough to need filtering)
    "fps", "shootergames", "thirdpersonshooter", "coopgaming",
    "simracing", "tycoon", "movies",
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

# ── GitHub Gist data source ──────────────────────────────────────────────────
# A GitHub Action fetches Reddit data daily from GitHub's servers (not blocked)
# and uploads it to a Gist. The droplet reads from the Gist.

_GIST_CACHE: dict = {}  # Populated once per ingestion run
_GIST_LOADED: bool = False


def _reset_gist_cache() -> None:
    """Reset the Gist cache so the next call to _load_gist_data() fetches fresh data."""
    global _GIST_CACHE, _GIST_LOADED
    _GIST_CACHE = {}
    _GIST_LOADED = False


def _load_gist_data() -> dict:
    """Load Reddit data from the GitHub Gist (cached per process lifetime)."""
    global _GIST_CACHE, _GIST_LOADED
    if _GIST_LOADED:
        return _GIST_CACHE

    from config import settings as _s  # noqa
    gist_url = getattr(_s, 'reddit_gist_url', '') or ''
    if not gist_url:
        logger.warning("REDDIT_GIST_URL not configured — no Reddit data available")
        _GIST_LOADED = True
        return _GIST_CACHE

    try:
        resp = httpx.get(gist_url, timeout=30, follow_redirects=True)
        if resp.status_code == 200:
            # Handle UTF-8 BOM from PowerShell-generated JSON
            text = resp.text.lstrip('\ufeff')
            import json as _json
            _GIST_CACHE = _json.loads(text)
            total = sum(len(v.get("posts", [])) for v in _GIST_CACHE.values())
            logger.info("Loaded Reddit Gist data: %d games, %d total posts", len(_GIST_CACHE), total)
        else:
            logger.warning("Reddit Gist returned HTTP %d", resp.status_code)
    except Exception as exc:
        logger.error("Failed to load Reddit Gist: %s", exc)

    _GIST_LOADED = True
    return _GIST_CACHE


def fetch_subreddit_posts(
    subreddit_name: str,
    limit: int = 25,
    game_name: str = "",
    game=None,
) -> list[dict]:
    """
    Fetch posts from a subreddit, trying Arctic Shift first.

    Strategy (in order):
      1. Arctic Shift — free public Reddit archive, confirmed reachable from
         the droplet as of May 2026. Returns Reddit-format JSON.
      2. GitHub Gist — pre-fetched data uploaded by the PowerShell fetcher
         or a GitHub Action.  Still useful as a fast cache or manual override.
      3. PullPush API — last-resort archive fallback.

    The existing Gist and PullPush paths are kept intact and remain dormant
    unless Arctic Shift returns no results, ensuring backward compatibility.
    """
    # ── 1. Try Arctic Shift first ─────────────────────────────────────────────
    try:
        from services.arctic_shift_service import (
            fetch_arctic_shift_subreddit_posts,
            ARCTIC_SHIFT_GENERAL_SUBS,
        )
        is_general = subreddit_name.lower() in {
            s.lower() for s in ARCTIC_SHIFT_GENERAL_SUBS
        }
        posts = fetch_arctic_shift_subreddit_posts(
            subreddit_name,
            limit=limit,
            game_name=game_name,
            is_general_sub=is_general,
            game=game,
        )
        if posts:
            logger.info(
                "arctic_shift: r/%s → %d posts (game='%s')",
                subreddit_name, len(posts), game_name,
            )
            return posts
        logger.info(
            "arctic_shift: r/%s returned 0 posts (game='%s') — falling back",
            subreddit_name, game_name,
        )
    except Exception as exc:
        logger.warning("arctic_shift failed for r/%s: %s", subreddit_name, exc)

    # ── 2. Gist fallback — pre-fetched data from PowerShell fetcher ───────────
    # This function is called per-subreddit, but the Gist data is per-game.
    # We return the full game's posts on the first subreddit call, and
    # empty for subsequent subs to avoid duplicates.
    gist = _load_gist_data()

    # Find the game_id that uses this subreddit
    for game_id_str, game_data in gist.items():
        posts = game_data.get("posts", [])
        if not posts:
            continue
        # Check if any post URL contains this subreddit name
        # Or match by game_name
        if game_name and game_data.get("game_name", "").lower() == game_name.lower():
            # Convert ISO date strings back to datetime objects
            for p in posts:
                if p.get("post_date") and isinstance(p["post_date"], str):
                    try:
                        from datetime import datetime as _dt
                        p["post_date"] = _dt.fromisoformat(p["post_date"])
                    except Exception:
                        p["post_date"] = None
            logger.info("Loaded %d post(s) for '%s' from Reddit Gist", len(posts), game_name)
            return posts

    # ── 3. PullPush fallback — last-resort Reddit archive ─────────────────────
    logger.info("No Gist data for '%s' / r/%s — trying PullPush", game_name, subreddit_name)
    return _fetch_pullpush(subreddit_name, game_name=game_name, limit=100)


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

def _game_search_query(game_name: str, game=None) -> str:
    """
    Extract the most distinctive search term from a game name.

    Strips possessive studio/director prefixes (e.g. "John Carpenter's Toxic
    Commando" → "Toxic Commando") so searches target the actual game title
    rather than the studio/creator's name.

    v2 (2026-07-24): returns a SINGLE distinctive word rather than a
    multi-word phrase. PullPush's `q=` parameter and Reddit's own search
    both AND-match multiple words (so `q=Hellraiser Revival` only
    matches posts with BOTH words, missing every post that only says
    "Hellraiser"). The single most-distinctive word finds substantially
    more relevant posts. The downstream Step 5 relevance gate then
    disambiguates game-vs-IP (see is_post_relevant_to_game).

    v3 (2026-08-12): if the single-word fallback would return a common
    English word (e.g. Rideshare 'Stimulator' → 'Rideshare' which matches
    thousands of ride-share industry posts), prefer a two-word phrase
    from distinctive_keywords instead. Two-word AND-match on Reddit is
    stricter than a single generic term. The AND-match trade-off is
    reversed for these titles: strict is BETTER because the generic
    word is worse than useless.

    Heuristic for picking the distinctive word: strip stopwords /
    generic gaming vocab / short words, prefer the longest remaining
    proper-noun-looking token.
    """
    # v3 (2026-08-12): games whose fallback keyword collides with a common
    # English word (Rideshare 'Stimulator' → 'Rideshare' matching ride-share
    # industry posts, not the game) can opt into a multi-word AND-matched
    # phrase from distinctive_keywords. Applied ONLY when the single-word
    # fallback would be a generic-English collision — games with clean proper
    # nouns (Hellraiser, Turok, SnowRunner) keep their current permissive
    # single-word behavior.
    _AMBIGUOUS_FALLBACKS = {"rideshare", "docked", "gloomhaven", "halloween"}
    if game is not None:
        keywords = getattr(game, "distinctive_keywords", None) or []
        # Only try to override if the name's single-word fallback is a known
        # collision. We check by re-running the algorithm below — for now, do
        # a coarse check on the raw name tokens.
        _lower_tokens = {t.lower() for t in game_name.split()}
        if _lower_tokens & _AMBIGUOUS_FALLBACKS:
            for k in keywords:
                if isinstance(k, str) and " " in k and len(k) >= 8:
                    # First multi-word keyword — use it as the phrase query.
                    # Strip quote chars (the config might have '"Stimulator"'
                    # in the keyword; Reddit search doesn't want literal quotes).
                    return k.replace('"', '').strip()
    # Strip "Studio's " / "Director's " possessive prefix
    if "'s " in game_name:
        game_name = game_name.split("'s ", 1)[1]

    # Drop trademark symbols and punctuation
    stripped = re.sub(r"[™®©:\-–—.,!?/\\()]", " ", game_name)
    tokens = [t for t in stripped.split() if t]

    # Common generic words we don't want to search on — they'd match
    # thousands of unrelated posts.
    _GENERIC = {
        "the", "a", "an", "of", "and", "in", "on", "to", "for", "with",
        "game", "games", "edition", "remastered", "remaster", "remake",
        "deluxe", "complete", "anniversary", "collection", "trilogy",
        "legendary", "ultimate", "gold", "platinum", "season", "origins",
        "revival", "survival", "combat", "evolved", "mod", "mods", "tools",
        "expansion", "pack", "dlc", "soundtrack", "official", "vinyl",
        "wrap", "pack", "livery", "tour", "tank", "truck", "pack",
        "pt", "volume", "vol", "chapter", "episode", "part",
        "iii", "iv", "vi", "vii", "viii", "ix", "xi", "xii",
        # v2b (2026-07-24): additional generic words that would produce
        # low-signal search matches. 'bound' matches every 'homeward bound',
        # 'untitled' matches every placeholder title, 'master' + 'chief'
        # are common english + military terms, 'quiet' + 'place' + 'road'
        # + 'ahead' are all everyday english.
        "bound", "untitled", "master", "chief", "quiet", "place", "road",
        "ahead", "video", "team", "boss", "deep", "waters", "docked",
        "reap", "sow", "expedition", "expeditions", "map", "editor",
        "veti", "wrath", "crawler", "salvage", "reclaim", "anniversary",
        "aftermath", "prologue", "world", "land", "live", "action",
        "first", "person", "third", "story", "episode", "prequel",
        "sequel", "launch", "early", "access", "free", "pass", "battle",
        "pass", "stakes", "final", "return", "reborn", "reboot",
        "unleashed", "assault", "strike", "force",
    }

    # Filter to tokens that look distinctive: proper-noun-like
    # (starts with uppercase in the original), ≥ 4 chars, not generic.
    # Fall back to any ≥4-char non-generic token if nothing looks like a
    # proper noun (rare, but e.g. lowercased sequel numbers).
    distinctive = [
        t for t in tokens
        if len(t) >= 4
        and t.lower() not in _GENERIC
    ]

    if not distinctive:
        # Nothing distinctive left — fall back to the longest token overall.
        distinctive = sorted(tokens, key=len, reverse=True)

    if not distinctive:
        # Truly empty (e.g. game_name was all punctuation) — return
        # original stripped name as last resort.
        return game_name.strip()

    # Prefer the FIRST distinctive word among those ≥ 6 chars — game
    # titles almost always lead with their proper-noun identifier
    # ('Hellraiser', 'Turok', 'Jurassic', 'Crysis', 'Ghostbusters',
    # 'SnowRunner'). Falls back to the longest distinctive word if none
    # reach 6 chars (rare, mostly short 2-word titles).
    long_enough = [t for t in distinctive if len(t) >= 6]
    if long_enough:
        return long_enough[0]
    return max(distinctive, key=len)


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
