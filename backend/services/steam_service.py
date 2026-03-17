"""
Steam service — publisher game discovery, review fetching, forum scraping.

All external HTTP calls include a 1-second rate-limit delay and are wrapped
in try/except so a single failure never halts the ingestion pipeline.
"""
import html
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_REQUEST_DELAY = 1.0  # seconds between Steam API calls

STEAM_SEARCH_URL = "https://store.steampowered.com/search/results/"
STEAM_APP_DETAILS_URL = "https://store.steampowered.com/api/appdetails"
STEAM_REVIEWS_URL = "https://store.steampowered.com/appreviews/{appid}"
STEAM_FORUM_URL = "https://steamcommunity.com/app/{appid}/discussions/"

_HEADERS = {"User-Agent": "SentimentPulse/1.0"}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get(
    url: str,
    params: Optional[dict] = None,
    timeout: int = 15,
) -> Optional[requests.Response]:
    """HTTP GET with error handling and mandatory rate-limit delay."""
    try:
        resp = requests.get(url, params=params, headers=_HEADERS, timeout=timeout)
        resp.raise_for_status()
        return resp
    except requests.RequestException as exc:
        logger.error("Steam HTTP error fetching %s: %s", url, exc)
        return None
    finally:
        time.sleep(_REQUEST_DELAY)


def _extract_appid_from_item(item: dict) -> Optional[int]:
    """Extract a numeric appid from a Steam search result dict."""
    for field in ("logo", "store_url"):
        value = item.get(field, "")
        if "/apps/" in value:
            parts = value.split("/apps/")
            if len(parts) > 1:
                candidate = parts[1].split("/")[0]
                if candidate.isdigit():
                    return int(candidate)
    return None


# ── Publisher game discovery ──────────────────────────────────────────────────

def get_games_by_publisher(publisher_name: str) -> list[dict]:
    """
    Return all Steam games by a given publisher.

    Uses the Steam Store search endpoint with a publisher filter.
    Paginates until all results are fetched.

    Each returned dict has:
        steam_app_id (int), name (str), release_date (str | None)
    """
    games: dict[int, dict] = {}
    start = 0
    page_size = 100

    while True:
        resp = _get(
            STEAM_SEARCH_URL,
            params={
                "publisher": publisher_name,
                "json": "1",
                "count": page_size,
                "start": start,
                "sort_by": "_ASC",
            },
        )
        if resp is None:
            break

        try:
            data = resp.json()
        except Exception as exc:
            logger.error(
                "Non-JSON response from Steam search for publisher '%s': %s",
                publisher_name, exc,
            )
            break

        items = data.get("items", [])
        if not items:
            break

        for item in items:
            app_id = _extract_appid_from_item(item)
            if app_id and app_id not in games:
                games[app_id] = {
                    "steam_app_id": app_id,
                    "name": html.unescape(item.get("name", "Unknown")),
                    "release_date": None,
                }

        total = data.get("total_count", 0)
        start += page_size
        if start >= total:
            break

    logger.info(
        "Discovered %d game(s) for publisher '%s'", len(games), publisher_name
    )
    return list(games.values())


def get_games_by_developer(developer_name: str) -> list[dict]:
    """
    Return all Steam games by a given developer.

    Identical pagination logic to get_games_by_publisher but uses the
    ``developer`` filter parameter instead of ``publisher``.

    Each returned dict has:
        steam_app_id (int), name (str), release_date (str | None)
    """
    games: dict[int, dict] = {}
    start = 0
    page_size = 100

    while True:
        resp = _get(
            STEAM_SEARCH_URL,
            params={
                "developer": developer_name,
                "json": "1",
                "count": page_size,
                "start": start,
                "sort_by": "_ASC",
            },
        )
        if resp is None:
            break

        try:
            data = resp.json()
        except Exception as exc:
            logger.error(
                "Non-JSON response from Steam search for developer '%s': %s",
                developer_name, exc,
            )
            break

        items = data.get("items", [])
        if not items:
            break

        for item in items:
            app_id = _extract_appid_from_item(item)
            if app_id and app_id not in games:
                games[app_id] = {
                    "steam_app_id": app_id,
                    "name": html.unescape(item.get("name", "Unknown")),
                    "release_date": None,
                }

        total = data.get("total_count", 0)
        start += page_size
        if start >= total:
            break

    logger.info(
        "Discovered %d game(s) for developer '%s'", len(games), developer_name
    )
    return list(games.values())


def get_app_details(steam_app_id: int) -> Optional[dict]:
    """
    Fetch detailed metadata for a single Steam app (publisher, release date, etc.)
    Returns the raw 'data' dict from the Steam API, or None on failure.
    """
    resp = _get(
        STEAM_APP_DETAILS_URL,
        params={"appids": steam_app_id, "filters": "basic"},
    )
    if resp is None:
        return None

    try:
        data = resp.json()
        app_data = data.get(str(steam_app_id), {})
        if not app_data.get("success"):
            return None
        return app_data.get("data")
    except Exception as exc:
        logger.error("Error parsing app details for %d: %s", steam_app_id, exc)
        return None


# ── Reviews ───────────────────────────────────────────────────────────────────

def fetch_reviews(steam_app_id: int, count: int = 100) -> list[dict]:
    """
    Fetch up to `count` recent English reviews for a Steam app.

    Each returned dict has:
        external_id, author, title (None), body, url, upvotes, post_date
    """
    resp = _get(
        STEAM_REVIEWS_URL.format(appid=steam_app_id),
        params={
            "json": "1",
            "filter": "recent",
            "language": "english",
            "review_type": "all",
            "purchase_type": "all",
            "num_per_page": min(count, 100),
        },
    )
    if resp is None:
        return []

    try:
        data = resp.json()
    except Exception as exc:
        logger.error("Error parsing reviews for app %d: %s", steam_app_id, exc)
        return []

    reviews = []
    for review in data.get("reviews", []):
        try:
            post_date = datetime.fromtimestamp(
                review["timestamp_created"], tz=timezone.utc
            )
            reviews.append({
                "external_id": str(review["recommendationid"]),
                "author": review.get("author", {}).get("steamid", "unknown"),
                "title": None,
                "body": review.get("review", ""),
                "url": (
                    f"https://store.steampowered.com/app/{steam_app_id}"
                    f"#app_reviews_hash"
                ),
                "upvotes": int(review.get("votes_up", 0)),
                "post_date": post_date,
            })
        except (KeyError, ValueError, OSError) as exc:
            logger.warning("Skipping malformed review entry: %s", exc)

    logger.info("Fetched %d review(s) for Steam app %d", len(reviews), steam_app_id)
    return reviews


# ── Forum scraping ────────────────────────────────────────────────────────────

def scrape_forum_threads(steam_app_id: int, max_threads: int = 3) -> list[dict]:
    """
    Scrape the most active forum threads for a Steam app.
    Collects top-level posts and first-level replies (up to `max_threads`).

    Each returned dict has:
        external_id, author, title, body, url, upvotes, post_date
    """
    forum_url = STEAM_FORUM_URL.format(appid=steam_app_id)
    resp = _get(forum_url)
    if resp is None:
        return []

    try:
        soup = BeautifulSoup(resp.text, "lxml")
        thread_refs = _parse_thread_links(soup)
    except Exception as exc:
        logger.error("Error parsing forum listing for app %d: %s", steam_app_id, exc)
        return []

    if not thread_refs:
        logger.info("No forum threads found for app %d", steam_app_id)
        return []

    all_posts: list[dict] = []
    for thread_url, thread_id, thread_title in thread_refs[:max_threads]:
        posts = _scrape_single_thread(thread_url, thread_id, thread_title)
        all_posts.extend(posts)
        time.sleep(_REQUEST_DELAY)

    logger.info(
        "Scraped %d post(s) from %d forum thread(s) for app %d",
        len(all_posts),
        min(max_threads, len(thread_refs)),
        steam_app_id,
    )
    return all_posts


def _parse_thread_links(soup: BeautifulSoup) -> list[tuple[str, str, str]]:
    """
    Extract (url, thread_id, title) tuples from a forum listing page.
    Thread URL pattern: .../discussions/0/{thread_id}/
    """
    results = []
    for row in soup.select("div.forum_topic"):
        link_tag = row.select_one("a.forum_topic_name")
        if not link_tag:
            continue
        href = link_tag.get("href", "")
        title = link_tag.get_text(strip=True)
        # Last path segment (before trailing slash) is the thread ID
        parts = href.rstrip("/").split("/")
        thread_id = parts[-1] if parts else ""
        if href and thread_id:
            results.append((href, thread_id, title))
    return results


def _scrape_single_thread(
    thread_url: str,
    thread_id: str,
    thread_title: str,
) -> list[dict]:
    """Scrape top-level posts and first-level replies from one forum thread."""
    resp = _get(thread_url)
    if resp is None:
        return []

    posts = []
    try:
        soup = BeautifulSoup(resp.text, "lxml")
        # Steam forums use multiple possible CSS classes depending on page type
        post_elements = soup.select(
            "div.forum_op, div.commentthread_comment"
        )
        for idx, el in enumerate(post_elements):
            author_el = el.select_one(
                ".forum_op_username, .commentthread_author_link, .forum_topic_op a"
            )
            body_el = el.select_one(
                ".forum_op_text, .commentthread_comment_text"
            )
            date_el = el.select_one(
                ".forum_op_date, .commentthread_comment_timestamp, .date"
            )

            author = author_el.get_text(strip=True) if author_el else "unknown"
            body = body_el.get_text(separator=" ", strip=True) if body_el else ""
            post_date = _parse_steam_date(
                date_el.get_text(strip=True) if date_el else None
            )

            posts.append({
                "external_id": f"forum_{thread_id}_{idx}",
                "author": author,
                "title": thread_title if idx == 0 else None,
                "body": body,
                "url": thread_url,
                "upvotes": 0,
                "post_date": post_date,
            })
    except Exception as exc:
        logger.error("Error scraping thread %s: %s", thread_url, exc)

    return posts


def _parse_steam_date(date_str: Optional[str]) -> Optional[datetime]:
    """Best-effort parse of Steam forum date strings (several formats in use)."""
    if not date_str:
        return None
    for fmt in (
        "%d %b @ %I:%M%p",
        "%d %b, %Y @ %I:%M%p",
        "%b %d, %Y @ %I:%M%p",
        "%b %d @ %I:%M%p",
        "%b %d, %Y",
    ):
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None
