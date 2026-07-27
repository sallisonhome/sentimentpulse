"""DTF.ru service.

DTF is a Russian-language gaming and pop-culture publication platform run
by Komitet (formerly cmtt).  Structure:

  * "Entries" — long-form articles or short posts by users
  * "Subsites" — topical channels (like subreddits) that entries belong to
  * "Comments" — nested threaded comments on each entry

We hit DTF's public search endpoint at ``api.dtf.ru/v2.1/search`` — no
auth required.  Response shape:

    {
      "result": {
        "contents": [
          {"type": "entry", "data": {...entry fields...}, "meta": {...}},
          ...
        ],
        "lastId": 2   # 1-indexed page counter; pass +1 for the next page
      }
    }

Entry data schema captured 2026-07-26:
  id, subsiteId, date (unix seconds), title, blocks (array), url,
  author {id,name,nickname,uri,...},
  subsite {id,name,uri,...},
  likes {counterLikes, counterDislikes, ...},
  hitsCount, commentsCount, isNews, isEditorial, etc.

Why we're here: our English-only Reddit + Steam pipeline was
systematically undercounting Russian-language discussion of Team Clout's
ILL (Russian-origin studio published by Mundfish).  DTF is the primary
Russian gaming forum where that discussion lives.  See lessons.md and
the SentimentPulse changelog for context.

We keep to ~1 request/sec (documented courtesy limit; DTF has soft
rate-limiting) with a small polite delay.
"""
from __future__ import annotations

import html
import logging
import re
import time
from datetime import datetime, timezone
from typing import Optional

import requests

logger = logging.getLogger(__name__)

_BASE = "https://api.dtf.ru"
# Confirmed 2026-07-26 as the working search endpoint. Earlier versions
# (v2.3, v2.4, v2.5, v3.0/search) all return 404 on this host — DTF's
# public API surface has been consolidating over the years and v2.1 is
# the one that actually resolves for search.
_SEARCH_URL = f"{_BASE}/v2.1/search"

# Courtesy delay between calls.  DTF doesn't publish a hard rate limit
# but has soft anti-abuse throttling — 1s is safe.
_REQUEST_DELAY_S = 1.0

_HEADERS = {
    "User-Agent": (
        "SentimentPulse/1.0 (+https://sallisonhome.com; monitoring for "
        "video-game community sentiment analytics)"
    ),
    "Accept": "application/json",
}

_HTTP_TIMEOUT_S = 15


def _get(url: str, params: Optional[dict] = None) -> Optional[dict]:
    """Wrap requests.get with our headers, timeout, and courtesy delay.

    Returns the parsed JSON dict on 2xx, None on error / non-JSON.  Never
    raises — callers should treat None as "no results, move on".
    """
    try:
        resp = requests.get(url, params=params, headers=_HEADERS, timeout=_HTTP_TIMEOUT_S)
    except requests.RequestException as exc:
        logger.warning("DTF request failed for %s: %s", url, exc)
        return None
    finally:
        # Always sleep AFTER the call so bursts of failures don't hammer
        # the API even harder than successes would.
        time.sleep(_REQUEST_DELAY_S)

    if resp.status_code >= 400:
        logger.info(
            "DTF non-2xx %s for %s params=%s body=%s",
            resp.status_code, url, params, resp.text[:200],
        )
        return None
    try:
        return resp.json()
    except ValueError:
        logger.warning("DTF non-JSON response for %s: %s", url, resp.text[:200])
        return None


# HTML text extraction.  DTF entries use a "blocks" array — each block has
# a type ("text","header","quote","incut","media","tweet",...) and a
# "data" object.  For sentiment we only care about text/header/quote —
# the rest are images, embeds, code fences, ads, etc.
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(s: str) -> str:
    if not s:
        return ""
    return html.unescape(_HTML_TAG_RE.sub(" ", s)).strip()


def _extract_body_text(entry: dict) -> str:
    """Pull the human-readable text out of a DTF entry."""
    parts: list[str] = []
    blocks = entry.get("blocks") or []
    if isinstance(blocks, list):
        for block in blocks:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype not in {"text", "header", "quote"}:
                continue
            text = ((block.get("data") or {}).get("text") or "").strip()
            if text:
                parts.append(_strip_html(text))
    return "\n\n".join(p for p in parts if p)


def _entry_to_dict(entry: dict) -> dict:
    """Normalize a DTF entry JSON blob into our standard post dict.

    Matches the shape produced by ``reddit_service._post_to_dict`` so the
    ingestor's ``_bulk_save_posts`` can accept it unchanged.
    """
    entry_id = entry.get("id")
    author_block = entry.get("author") or {}
    author = author_block.get("name") or author_block.get("nickname") or "[unknown]"
    title = entry.get("title") or ""
    body = _extract_body_text(entry)

    # Prefer the API-provided full URL; fall back to reconstruction.
    url = entry.get("url") or ""
    if not url and entry_id:
        subsite = ((entry.get("subsite") or {}).get("uri")) or ""
        if subsite:
            # subsite.uri is already "/games" or similar
            url = f"https://dtf.ru{subsite}/{entry_id}"
        else:
            url = f"https://dtf.ru/{entry_id}"

    # Unix seconds; DTF stores creation date under 'date'.
    ts = entry.get("date") or 0
    try:
        post_date = datetime.fromtimestamp(float(ts), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        post_date = datetime.now(tz=timezone.utc)

    # Likes: counterLikes is unsigned; a post's karma is
    # counterLikes - counterDislikes (both non-negative). We store
    # net positive likes (clamped to 0) to match reddit_service.
    likes_block = entry.get("likes") or {}
    try:
        cl = int(likes_block.get("counterLikes") or 0)
        cd = int(likes_block.get("counterDislikes") or 0)
        upvotes = max(0, cl - cd)
    except (TypeError, ValueError):
        upvotes = 0

    return {
        "external_id": f"dtf:{entry_id}" if entry_id is not None else "",
        "author": author,
        "title": title,
        "body": body,
        "url": url,
        "upvotes": upvotes,
        "post_date": post_date,
    }


def _search_page(query: str, page: int = 1) -> tuple[list[dict], Optional[int]]:
    """Fetch a single page of DTF search results.

    Returns:
        (items, next_page) — items is the list of normalized post dicts;
        next_page is the ``lastId`` to pass on the next call, or None if
        there is no next page.
    """
    params = {"query": query}
    if page > 1:
        params["lastId"] = page
    payload = _get(_SEARCH_URL, params=params)
    if not payload:
        return [], None
    result = payload.get("result") or {}
    raw_items = result.get("contents") or []
    normalized: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        # DTF returns mixed types in search results (entry, subsite, user,
        # comment). Only "entry" gets ingested.
        if item.get("type") != "entry":
            continue
        entry = item.get("data") or {}
        if not entry.get("id"):
            continue
        normalized.append(_entry_to_dict(entry))
    next_page = result.get("lastId")
    # DTF returns lastId even when it's the same as the current page;
    # detect the end by empty results.
    if not raw_items:
        next_page = None
    return normalized, next_page


def fetch_dtf_posts(
    query: str,
    game_name: str = "",
    limit: int = 100,
) -> list[dict]:
    """Search DTF for entries matching ``query`` and return normalized posts.

    Args:
        query:      A keyword phrase to search DTF for (e.g. "ILL Team Clout",
                    "Halloween Illfonic", "Silent Hill Townfall").  DTF's
                    search index handles Cyrillic and Latin equally.
        game_name:  Only used for logging + downstream filtering.
        limit:      Cap on total returned entries.  DTF returns ~30 per
                    page so ``limit=100`` = up to 4 pages of results.

    Returns:
        A list of post dicts matching the reddit_service shape.  Empty
        list on any error (we NEVER raise from here — DTF outage cannot
        break a full ingestion run).
    """
    limit = max(1, min(int(limit), 500))
    out: list[dict] = []
    page = 1
    while len(out) < limit:
        items, next_page = _search_page(query, page=page)
        if not items:
            break
        out.extend(items)
        if not next_page or next_page == page:
            break
        # DTF's next_page is 1-indexed and increments by 1 per page. We
        # bump ourselves rather than trusting the returned value because
        # DTF has been observed to echo lastId=2 on page 1 even when
        # there IS a page 2 — meaning next_page is the value we pass
        # on our next request, which happens to be page+1.
        page += 1
        # Sanity: DTF search caps at ~4 pages (~90 results) for niche
        # queries; hard-cap the outer loop to prevent runaway.
        if page > 20:
            break

    if len(out) > limit:
        out = out[:limit]

    logger.info(
        "DTF search q=%r game=%r returned %d entries (page cap=%d)",
        query, game_name, len(out), page,
    )
    return out


def fetch_dtf_posts_since(
    query: str,
    since_utc: datetime,
    game_name: str = "",
    hard_cap: int = 500,
) -> list[dict]:
    """Fetch DTF posts matching ``query`` newer than ``since_utc``.

    Walks the search results page by page until either every post on a
    page is older than the cutoff, we hit ``hard_cap`` accepted posts,
    or the search is exhausted.  Used by the ingest backfill job.

    Note: DTF's search doesn't return in strict date-sorted order — it
    weights by relevance and recency together.  We can't rely on
    "first post older than cutoff means we're done"; instead we scan
    every page and filter, stopping only when a whole page yielded
    zero in-window posts or when we exhaust the search.
    """
    if since_utc.tzinfo is None:
        since_utc = since_utc.replace(tzinfo=timezone.utc)
    out: list[dict] = []
    page = 1
    zero_streak = 0  # consecutive pages with 0 in-window posts
    while len(out) < hard_cap and zero_streak < 2 and page <= 20:
        items, next_page = _search_page(query, page=page)
        if not items:
            break
        in_window = [p for p in items if p["post_date"] >= since_utc]
        out.extend(in_window)
        if not in_window:
            zero_streak += 1
        else:
            zero_streak = 0
        if not next_page or next_page == page:
            break
        page += 1

    if len(out) > hard_cap:
        out = out[:hard_cap]

    logger.info(
        "DTF backfill q=%r since=%s game=%r returned %d entries "
        "(scanned %d pages)",
        query, since_utc.isoformat(), game_name, len(out), page,
    )
    return out
