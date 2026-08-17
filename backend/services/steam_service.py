"""
Steam service — publisher game discovery, review fetching, forum scraping.

All external HTTP calls include a 1-second rate-limit delay and are wrapped
in try/except so a single failure never halts the ingestion pipeline.
"""
import html
import logging
import re
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

# v2 (2026-08-17): use a real browser User-Agent + age-gate bypass cookies
# on every Steam request. Steam gates the DISCUSSION HTML for adult /
# mature-rated titles behind an age check. When we hit that page without
# the age cookies, Steam silently returns a 200-OK stub page with zero
# thread rows. Our scraper interpreted this as "forum is empty" and
# stored nothing.
#
# This exact failure hid ALL 130+ threads on SILENT HILL: Townfall's very
# active pre-launch forum. Verified 2026-08-17 by comparing our scraper's
# fetch (0 threads returned) against the same request with the cookies
# below (130 threads returned).
#
# Cookies are the standard Steam age-gate bypass used by many public
# tools: birthtime is Unix epoch for a birth date in 1988 (well over 21);
# the mature_content flags tell Steam we've opted in to viewing mature
# content; lastagecheckage keeps the check from re-triggering. These are
# NOT secrets or auth tokens; they're the same cookies a browser sets
# after clicking "I'm over 21".
#
# Applies to the FORUM HTML fetches only. The Steam Reviews JSON API
# (store.steampowered.com/appreviews/) is not age-gated, so it's fine on
# the existing _HEADERS.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
}
_STEAM_AGE_GATE_COOKIES = {
    "birthtime":            "568022401",       # 1988-01-01 UTC
    "mature_content":       "1",
    "wants_mature_content": "1",
    "lastagecheckage":      "1-January-1988",
    "Steam_Language":       "english",
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get(
    url: str,
    params: Optional[dict] = None,
    timeout: int = 15,
) -> Optional[requests.Response]:
    """HTTP GET with error handling and mandatory rate-limit delay.

    v2 (2026-08-17): sends the Steam age-gate bypass cookies on every
    request. Harmless for non-gated titles; essential for mature-gated
    forums (Townfall, Hellraiser, Halloween, any horror / M-rated title).
    Without these, Steam returns a 200-OK age-check stub with no threads
    and the scraper silently records 0 posts.
    """
    try:
        resp = requests.get(
            url,
            params=params,
            headers=_HEADERS,
            cookies=_STEAM_AGE_GATE_COOKIES,
            timeout=timeout,
        )
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

def fetch_reviews(
    steam_app_id: int,
    known_ids: Optional[set] = None,
    max_pages: int = 5,
) -> list[dict]:
    """
    Fetch recent English reviews using cursor-based pagination.

    Fetches up to max_pages * 100 reviews per run, stopping early when a
    page has >50% overlap with known_ids (already collected reviews).

    Each returned dict has:
        external_id, author, title (None), body, url, upvotes, post_date
    """
    known_ids = known_ids or set()
    all_reviews: list[dict] = []
    cursor = "*"

    for page_num in range(max_pages):
        resp = _get(
            STEAM_REVIEWS_URL.format(appid=steam_app_id),
            params={
                "json": "1",
                "filter": "recent",
                "language": "english",
                "review_type": "all",
                "purchase_type": "all",
                "num_per_page": 100,
                "cursor": cursor,
            },
        )
        if resp is None:
            break

        try:
            data = resp.json()
        except Exception as exc:
            logger.error("Error parsing reviews for app %d (page %d): %s",
                         steam_app_id, page_num + 1, exc)
            break

        batch = data.get("reviews", [])
        if not batch:
            break

        for review in batch:
            try:
                post_date = datetime.fromtimestamp(
                    review["timestamp_created"], tz=timezone.utc
                )
                all_reviews.append({
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
                    # 2026-07-29: preserve the ground-truth vote from Steam.
                    # voted_up is present on every real review; guard with
                    # get() to be safe against schema drift. Persisted via
                    # RawPost.voted_up (migration 0014) so the sentiment
                    # classifier can use it as a hard rule.
                    "voted_up": bool(review.get("voted_up", True))
                                 if "voted_up" in review else None,
                })
            except (KeyError, ValueError, OSError) as exc:
                logger.warning("Skipping malformed review entry: %s", exc)

        # Stop early if most of this page is already known — we've caught up
        if known_ids:
            batch_ids = {str(r["recommendationid"]) for r in batch}
            if len(batch_ids & known_ids) >= len(batch_ids) * 0.5:
                break

        next_cursor = data.get("cursor", "")
        if not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor

    logger.info("Fetched %d review(s) (%d page(s)) for Steam app %d",
                len(all_reviews), page_num + 1, steam_app_id)
    return all_reviews


# ── Forum scraping ────────────────────────────────────────────────────────────

def scrape_forum_threads(
    steam_app_id: int,
    max_threads: int = 3,
    max_pages: int = 3,
    since_epoch: Optional[int] = None,
    wallclock_budget_s: Optional[float] = None,
) -> list[dict]:
    """
    Scrape forum threads for a Steam app across paginated listing pages.
    Collects top-level posts and first-level replies for each thread.

    v4 (2026-07-28) — correctness + performance overhaul. Previous versions
    walked every listing page and every listed thread regardless of
    since_epoch, so a stale forum burned 3-4s per dead thread. This
    version:
      * Reads the per-row last-post epoch from the listing DOM.
      * Short-circuits the listing walk once we've seen K consecutive
        non-sticky threads whose lastpost is older than since_epoch
        (Steam sorts non-sticky threads last-post-desc, so once we're
        past the boundary, later rows and later pages are all older).
        Sticky/pinned threads are excluded from the short-circuit count
        because they float above the sort.
      * Skips visiting individual threads whose lastpost is older than
        since_epoch — no HTTP call needed, we already know they're out
        of window. Sticky threads are always visited because their pin
        state hides their true position in the sort.
      * Optional wallclock_budget_s caps the total time spent in this
        function; the caller uses this to keep a single game from
        blocking the whole daily ingest.

    Args:
        steam_app_id: The Steam AppID.
        max_threads: Cap on the TOTAL number of unique threads visited
            (across all pages). Prevents runaway on very active games.
            The listing walk may collect more refs than this, but only
            the first max_threads within the cutoff are actually fetched.
        max_pages: Hard cap on how many listing pages (?fp=1..N) to walk
            even when since_epoch is None or short-circuit doesn't fire.
        since_epoch: Unix epoch cutoff. When provided, drives both the
            listing-walk short-circuit and the per-thread skip-if-stale.
            When None, walks up to max_pages listing pages and visits up
            to max_threads threads regardless of age (historical mode).
        wallclock_budget_s: Optional soft budget (seconds). Checked
            between listing pages and between thread visits. When the
            budget is exceeded the function returns whatever it has
            collected so far. `None` means unlimited.

    Each returned dict has:
        external_id, author, title, body, url, upvotes, post_date
    """
    # Number of consecutive out-of-window non-sticky threads that
    # triggers a listing-walk short-circuit. Set > 1 so a single
    # necro-bumped thread that happens to slip into a stale zone
    # doesn't accidentally end the walk.
    _OUT_OF_WINDOW_STREAK_FOR_STOP = 5

    base_url = STEAM_FORUM_URL.format(appid=steam_app_id)
    started_at = time.monotonic()

    def _budget_exhausted() -> bool:
        if wallclock_budget_s is None:
            return False
        return (time.monotonic() - started_at) >= wallclock_budget_s

    thread_refs: list[dict] = []
    seen_ids: set[str] = set()
    pages_walked = 0
    listing_short_circuited = False
    consecutive_stale_nonsticky = 0

    for page_num in range(1, max_pages + 1):
        if _budget_exhausted():
            logger.info(
                "scrape_forum_threads app=%d listing budget hit at page %d",
                steam_app_id, page_num,
            )
            break

        page_url = base_url if page_num == 1 else f"{base_url}?fp={page_num}"
        resp = _get(page_url)
        if resp is None:
            logger.warning("Steam forum p%d fetch returned None for app %d", page_num, steam_app_id)
            break
        try:
            soup = BeautifulSoup(resp.text, "lxml")
            page_refs = _parse_thread_links(soup)
        except Exception as exc:
            logger.error("Error parsing forum p%d for app %d: %s", page_num, steam_app_id, exc)
            break

        if not page_refs:
            # No more threads — end of forum reached.
            break

        # Dedupe (Steam repeats pinned threads across pages).
        new_refs = [r for r in page_refs if r["thread_id"] not in seen_ids]
        for r in new_refs:
            seen_ids.add(r["thread_id"])
        thread_refs.extend(new_refs)
        pages_walked += 1

        # ---- Listing-walk short-circuit --------------------------------
        # Walk the rows in DOM order (which is Steam's last-post-desc
        # sort for non-sticky threads). Track the current streak of
        # non-sticky threads whose lastpost < since_epoch. Sticky rows
        # never advance or reset the streak because their pin position
        # is orthogonal to the sort. Once the streak crosses the
        # threshold, later rows on this page (and every subsequent page)
        # are all older — stop.
        if since_epoch is not None:
            for r in new_refs:
                if r["is_sticky"]:
                    continue
                lp = r["lastpost_ts"]
                if lp is None:
                    # Unknown age — don't change the streak. Better to
                    # visit than to bail incorrectly.
                    consecutive_stale_nonsticky = 0
                    continue
                if lp < since_epoch:
                    consecutive_stale_nonsticky += 1
                    if consecutive_stale_nonsticky >= _OUT_OF_WINDOW_STREAK_FOR_STOP:
                        listing_short_circuited = True
                        logger.info(
                            "scrape_forum_threads app=%d listing short-circuit at "
                            "page %d after %d consecutive stale non-sticky threads",
                            steam_app_id, page_num, consecutive_stale_nonsticky,
                        )
                        break
                else:
                    consecutive_stale_nonsticky = 0

        if listing_short_circuited:
            break

        # Also stop if we already have enough refs to hit max_threads even
        # after filtering (rough heuristic — the actual filter happens
        # below).
        if len(thread_refs) >= max_threads * 2:
            break

        # Small courtesy delay between listing pages.
        time.sleep(_REQUEST_DELAY)

    if not thread_refs:
        logger.info("No forum threads found for app %d", steam_app_id)
        return []

    # ---- Per-thread skip-if-stale ---------------------------------------
    # For non-sticky threads with a known lastpost_ts older than the
    # cutoff, skip the HTTP fetch entirely — we already know they have
    # no in-window content. Sticky threads are always visited because
    # their pin state hides real activity; they're usually cheap anyway.
    visitable: list[dict] = []
    skipped_stale = 0
    for r in thread_refs:
        if (
            since_epoch is not None
            and not r["is_sticky"]
            and r["lastpost_ts"] is not None
            and r["lastpost_ts"] < since_epoch
        ):
            skipped_stale += 1
            continue
        visitable.append(r)
        if len(visitable) >= max_threads:
            break

    all_posts: list[dict] = []
    threads_visited = 0
    for r in visitable:
        if _budget_exhausted():
            logger.info(
                "scrape_forum_threads app=%d thread-visit budget hit after "
                "%d/%d threads",
                steam_app_id, threads_visited, len(visitable),
            )
            break

        posts = _scrape_single_thread(
            r["url"], r["thread_id"], r["title"],
            since_epoch=since_epoch,
        )
        all_posts.extend(posts)
        threads_visited += 1
        time.sleep(_REQUEST_DELAY)

    logger.info(
        "scrape_forum_threads app=%d pages=%d refs=%d visited=%d "
        "skipped_stale=%d short_circuited=%s posts=%d",
        steam_app_id, pages_walked, len(thread_refs), threads_visited,
        skipped_stale, listing_short_circuited, len(all_posts),
    )
    return all_posts


def _parse_thread_links(soup: BeautifulSoup) -> list[dict]:
    """
    Extract per-thread metadata from a forum listing page. Returns a list
    of dicts, one per thread row visible on the page.

    Each dict has:
        url          - canonical thread URL
        thread_id    - gidforumtopic (used in RawPost.external_id)
        title        - visible thread title
        lastpost_ts  - Unix epoch of the most recent post in the thread,
                       parsed from forum_topic_lastpost[data-timestamp].
                       None when Steam omits the attr (very rare; empty
                       or corrupted threads).
        is_sticky    - True when the outer div carries the `sticky` class
                       (i.e., moderator-pinned thread). Sticky threads
                       jump above regular threads on the listing so their
                       lastpost_ts must be excluded from any
                       "is-this-page-out-of-window" short-circuit or the
                       walk would either bail too early (stale pin at top)
                       or too late (fresh pin masking a stale page below).

    v2 (2026-07-28): previously returned bare (url, thread_id, title)
    tuples. Callers that only need the trio can still map(...) it out;
    the new fields power the listing-walk short-circuit and per-thread
    skip-if-stale in scrape_forum_threads.
    """
    results: list[dict] = []
    for row in soup.select("div.forum_topic"):
        link_tag = row.select_one("a.forum_topic_overlay")
        if not link_tag:
            continue
        href = link_tag.get("href", "")
        # Title lives in a sibling div, not on the link itself
        title_el = row.select_one("div.forum_topic_name")
        title = title_el.get_text(strip=True) if title_el else ""
        # Last path segment (before trailing slash) is the thread ID
        parts = href.rstrip("/").split("/")
        thread_id = parts[-1] if parts else ""
        if not (href and thread_id):
            continue

        # Steam renders the last-post epoch as a data-timestamp attribute
        # on div.forum_topic_lastpost inside the row. Verified live against
        # https://steamcommunity.com/app/1486920/discussions/ on 2026-07-28.
        lastpost_ts: Optional[int] = None
        lastpost_el = row.select_one("div.forum_topic_lastpost")
        if lastpost_el is not None:
            ts_raw = lastpost_el.get("data-timestamp")
            if ts_raw:
                try:
                    lastpost_ts = int(ts_raw)
                except (TypeError, ValueError):
                    lastpost_ts = None

        # Sticky/pinned threads sit above the last-post-desc sort. We tag
        # them so the caller can exclude them from the out-of-window
        # short-circuit — a pinned FAQ from 6 months ago must not cause
        # us to bail on a listing page that still has fresh regular
        # threads below it.
        row_classes = row.get("class") or []
        is_sticky = "sticky" in row_classes

        results.append({
            "url": href,
            "thread_id": thread_id,
            "title": title,
            "lastpost_ts": lastpost_ts,
            "is_sticky": is_sticky,
        })
    return results


# Regex to pull the InitializeCommentThread bootstrap JSON from a thread page.
# Steam embeds this inline so we can read total_count / pagesize / oldestfirst
# without hitting a rate-limited AJAX endpoint. See lessons.md 2026-07-25.
_INIT_COMMENT_THREAD_RE = re.compile(
    r"InitializeCommentThread\(\s*\"[^\"]+\"\s*,\s*\"[^\"]+\"\s*,\s*(\{.*?\})\s*,\s*'https://",
    re.DOTALL,
)


def _extract_thread_metadata(html: str) -> Optional[dict]:
    """
    Pull total_count, pagesize, and oldestfirst from the InitializeCommentThread
    bootstrap JSON that Steam inlines on every thread page. Returns None if
    the pattern isn't found (e.g., pinned FAQ threads or empty threads).
    """
    m = _INIT_COMMENT_THREAD_RE.search(html)
    if not m:
        return None
    import json as _json
    try:
        data = _json.loads(m.group(1))
        return {
            "total_count": int(data.get("total_count", 0)),
            "pagesize": int(data.get("pagesize", 15)) or 15,
            "oldestfirst": bool(data.get("oldestfirst", False)),
        }
    except Exception:
        return None


def _scrape_comment_page(soup: BeautifulSoup) -> list[dict]:
    """
    Extract every comment on a thread page as a list of raw dicts:
        {external_id, author, body, ts_epoch (int|None), permalink_hash}

    Steam gives us a data-timestamp Unix epoch on every comment which is
    100% reliable, so we skip _parse_steam_date entirely for comments.
    Comment DOM: <div class="commentthread_comment" id="comment_{id}">
    with .commentthread_author_link, .commentthread_comment_text, and
    .commentthread_comment_timestamp[data-timestamp=\"<epoch>\"].
    """
    out = []
    for el in soup.select("div.commentthread_comment"):
        comment_id = (el.get("id") or "").replace("comment_", "")
        author_el = el.select_one(".commentthread_author_link")
        body_el = el.select_one(".commentthread_comment_text")
        # Steam has TWO .commentthread_comment_timestamp divs per comment —
        # the first is an empty placeholder above the awards row, the second
        # carries the real data-timestamp attr. Pick the one with the attr.
        ts_el = None
        for candidate in el.select(".commentthread_comment_timestamp"):
            if candidate.get("data-timestamp"):
                ts_el = candidate
                break

        author = author_el.get_text(strip=True) if author_el else "[unknown]"
        body = body_el.get_text(separator=" ", strip=True) if body_el else ""
        ts_epoch: Optional[int] = None
        if ts_el is not None:
            ts_raw = ts_el.get("data-timestamp")
            if ts_raw:
                try:
                    ts_epoch = int(ts_raw)
                except Exception:
                    ts_epoch = None

        if not comment_id or not body:
            continue
        out.append({
            "comment_id": comment_id,
            "author": author,
            "body": body,
            "ts_epoch": ts_epoch,
        })
    return out


def _scrape_thread_op(soup: BeautifulSoup) -> Optional[dict]:
    """
    Extract the OP (thread starter) post. Steam wraps it in div.forum_op with
    .forum_op_username, .forum_op_text, and .forum_op_date. Returns a dict
    similar to _scrape_comment_page items (with ts_epoch when possible).
    """
    op = soup.select_one("div.forum_op")
    if op is None:
        return None
    author_el = op.select_one(".forum_op_username, .forum_topic_op a")
    body_el = op.select_one(".forum_op_text")
    date_el = op.select_one(".forum_op_date")

    author = author_el.get_text(strip=True) if author_el else "[unknown]"
    body = body_el.get_text(separator=" ", strip=True) if body_el else ""

    ts_epoch: Optional[int] = None
    # OP date element may carry a data-timestamp attr (newer Steam DOM); if not,
    # fall back to parsing the visible text via _parse_steam_date.
    if date_el is not None:
        ts_raw = date_el.get("data-timestamp")
        if ts_raw:
            try:
                ts_epoch = int(ts_raw)
            except Exception:
                ts_epoch = None
        if ts_epoch is None:
            parsed = _parse_steam_date(date_el.get_text(strip=True))
            if parsed is not None:
                ts_epoch = int(parsed.timestamp())
    return {"author": author, "body": body, "ts_epoch": ts_epoch}


def _scrape_single_thread(
    thread_url: str,
    thread_id: str,
    thread_title: str,
    since_epoch: Optional[int] = None,
) -> list[dict]:
    """
    Scrape every comment in a Steam Forum thread within the last `since_epoch`
    seconds. Walks Steam's ?ctp=N comment pagination and stops once we've
    walked past the since_epoch boundary.

    v2 (2026-07-25): now paginates comments (was: only page 1 = ~15 posts).
    Reads Steam's InitializeCommentThread bootstrap JSON to learn total_count,
    pagesize, and oldestfirst so we can jump straight to the LAST page when
    Steam serves oldest-first (which it does for ILL and most forums), and
    walk backward without wasting requests on ancient comments.

    Args:
        thread_url: canonical thread URL (no ?ctp=).
        thread_id: gidforumtopic used in the RawPost.external_id.
        thread_title: shown on the OP row.
        since_epoch: Unix epoch cutoff; comments older than this are dropped
            AND the walk stops early (safe because oldestfirst means later
            pages are always newer than earlier ones).

    Returns list of RawPost-shaped dicts (external_id, author, title, body,
    url, upvotes, post_date).
    """
    from datetime import datetime as _dt, timezone as _tz

    resp = _get(thread_url)
    if resp is None:
        return []
    html = resp.text

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception as exc:
        logger.error("Error parsing thread HTML for %s: %s", thread_url, exc)
        return []

    posts: list[dict] = []

    # ── OP (always page 1, always present).
    op = _scrape_thread_op(soup)
    if op is not None:
        op_ts = op["ts_epoch"]
        if since_epoch is None or op_ts is None or op_ts >= since_epoch:
            posts.append({
                "external_id": f"forum_{thread_id}_op",
                "author": op["author"],
                "title": thread_title,
                "body": op["body"],
                "url": thread_url,
                "upvotes": 0,
                "post_date": (
                    _dt.fromtimestamp(op_ts, tz=_tz.utc).replace(tzinfo=None)
                    if op_ts else None
                ),
            })

    # ── Comment walk. Read Steam's bootstrap to know how many pages exist.
    meta = _extract_thread_metadata(html)
    if not meta or meta["total_count"] == 0:
        return posts

    pagesize = meta["pagesize"]
    total = meta["total_count"]
    oldestfirst = meta["oldestfirst"]
    total_pages = max(1, (total + pagesize - 1) // pagesize)

    # When oldestfirst=True, the newest comments live on the LAST page, so
    # we walk from total_pages down to 1 and stop early once we cross
    # since_epoch. When oldestfirst=False (Steam's older default), page 1
    # already has the newest; walk 1..total_pages until we cross the cutoff.
    if oldestfirst:
        page_order = list(range(total_pages, 0, -1))
    else:
        page_order = list(range(1, total_pages + 1))

    for page_num in page_order:
        if page_num == 1:
            page_soup = soup  # already fetched
        else:
            page_url = f"{thread_url}?ctp={page_num}"
            page_resp = _get(page_url)
            if page_resp is None:
                logger.warning("Comment page fetch None for %s ctp=%d", thread_url, page_num)
                break
            time.sleep(_REQUEST_DELAY)
            try:
                page_soup = BeautifulSoup(page_resp.text, "lxml")
            except Exception as exc:
                logger.warning("Comment page parse err %s ctp=%d: %s", thread_url, page_num, exc)
                break

        page_comments = _scrape_comment_page(page_soup)
        if not page_comments:
            # Steam sometimes serves an empty comment page as the last-page-of-
            # -exactly-N-comments edge case; stop cleanly.
            continue

        page_had_in_window = False
        page_all_out_of_window = True
        for c in page_comments:
            ts = c["ts_epoch"]
            if since_epoch is not None and ts is not None and ts < since_epoch:
                # Out of window (too old); skip. When oldestfirst=True and
                # walking last→first this triggers page-early-exit below.
                continue
            page_had_in_window = True
            page_all_out_of_window = False
            posts.append({
                "external_id": f"forum_{thread_id}_c{c['comment_id']}",
                "author": c["author"],
                "title": None,
                "body": c["body"],
                "url": f"{thread_url}#c{c['comment_id']}",
                "upvotes": 0,
                "post_date": (
                    _dt.fromtimestamp(ts, tz=_tz.utc).replace(tzinfo=None)
                    if ts else None
                ),
            })

        # Early-exit: if the WHOLE page was outside the window, later pages
        # (in either walk direction) will be even further out — bail.
        if since_epoch is not None and page_all_out_of_window and not page_had_in_window:
            logger.debug(
                "Thread %s: page %d all out-of-window, stopping walk",
                thread_id, page_num,
            )
            break

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
