"""DTF.ru service.

DTF is a Russian-language gaming and pop-culture publication platform run
by Komitet (formerly cmtt).  Structure:

  * "Entries" — long-form articles or short posts by users
  * "Subsites" — topical channels (like subreddits) that entries belong to
  * "Comments" — nested threaded comments on each entry

Every entry has a numeric ``id`` and a public read endpoint at
``https://api.dtf.ru/v3.0/entry/{id}``.  There is a public search endpoint
that returns entries matching a keyword query.

Why we're here (2026-07-26): our English-only Reddit + Steam pipeline was
systematically undercounting Russian-language discussion of Team Clout's
ILL (Russian-origin studio published by Mundfish).  DTF is the primary
Russian gaming forum where this discussion lives.  See lessons.md and the
SentimentPulse changelog for context.

Design mirrors ``reddit_service.py`` — we expose ``fetch_dtf_posts`` that
takes a search query + game_name and returns a list of standard post
dicts with the same shape as reddit posts, so the ingestor can call
``_bulk_save_posts`` with them unchanged.

No auth is required for the read endpoints we hit — DTF exposes its
public read API without a token.  We keep to <=1 request/sec (documented
courtesy limit; DTF has soft rate-limiting) with a small polite delay.
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
_SEARCH_URL = f"{_BASE}/v2.5/search/content"

# Courtesy delay between calls.  DTF doesn't publish a hard rate limit but
# has soft anti-abuse throttling — 1s is safe and matches what community
# API clients (Dtf-Client-API, LightVolk) do.
_REQUEST_DELAY_S = 1.0

# Standard headers — user agent identifies the bot for DTF ops if they
# ever look at their logs, no auth is required.
_HEADERS = {
    "User-Agent": (
        "SentimentPulse/1.0 (+https://sallisonhome.com; monitoring for "
        "video-game community sentiment analytics)"
    ),
    "Accept": "application/json",
}

# HTTP timeout — DTF's API is generally fast (< 500 ms) but we've seen
# occasional 3-5 s stalls under load; 15 s gives plenty of headroom
# without letting a single stuck request block the whole ingest for a
# minute+.
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
        # DTF returns HTML for some 500s; don't log the body at ERROR to
        # keep the log clean — INFO is enough for diagnostics.
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


# HTML text extraction — DTF entries can be either short "posts" with
# a text body or long-form articles with a "blocks" schema (paragraph,
# quote, image, embed, etc).  For sentiment we only care about the
# text of text/header/quote blocks; images, embeds, and code are ignored.
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(s: str) -> str:
    if not s:
        return ""
    return html.unescape(_HTML_TAG_RE.sub(" ", s)).strip()


def _extract_body_text(entry: dict) -> str:
    """Pull the human-readable text out of a DTF entry.

    DTF has multiple content schemas.  We try the modern ``blocks`` array
    first (used since ~2020) and fall back to ``intro`` / ``text``.  If
    none of those exist, we return "" and let the relevance gate decide
    from the title alone.
    """
    parts: list[str] = []

    # v2+ block schema — a list of {"type": "text"|"header"|"quote"|...,
    # "data": {"text": "…"}} objects.  We only surface text/header/quote.
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

    if not parts:
        # Older / short-post schema.
        intro = entry.get("intro") or entry.get("text") or ""
        if intro:
            parts.append(_strip_html(intro))

    return "\n\n".join(p for p in parts if p)


def _entry_to_dict(entry: dict) -> dict:
    """Normalize a DTF entry JSON blob into our standard post dict.

    Matches the shape produced by ``reddit_service._post_to_dict`` so the
    ingestor's ``_bulk_save_posts`` can accept it unchanged.
    """
    entry_id = entry.get("id")
    author = ((entry.get("author") or {}).get("name")) or "[unknown]"
    title = entry.get("title") or ""
    body = _extract_body_text(entry)

    # DTF URLs are ``https://dtf.ru/<subsite>/<id>-<slug>`` — the API
    # returns the full URL in ``url`` when present, otherwise we
    # reconstruct from subsite + id.
    url = entry.get("url") or ""
    if not url and entry_id:
        subsite = ((entry.get("subsite") or {}).get("url")) or ""
        if subsite:
            url = f"https://dtf.ru{subsite}/{entry_id}"
        else:
            url = f"https://dtf.ru/u/0-user/{entry_id}"

    # DTF stores dates as Unix seconds under ``date`` (creation) or
    # ``last_modification_date`` — we prefer creation.
    ts = entry.get("date") or entry.get("date_favorite") or 0
    try:
        post_date = datetime.fromtimestamp(float(ts), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        post_date = datetime.now(tz=timezone.utc)

    # Upvotes — DTF has a ``likes`` block with a ``summ`` counter that
    # can be negative (like Reddit score).  Clamp to non-negative for
    # consistency with reddit_service which also clamps.
    likes = 0
    likes_block = entry.get("likes") or {}
    if isinstance(likes_block, dict):
        try:
            likes = max(0, int(likes_block.get("summ", 0) or 0))
        except (TypeError, ValueError):
            likes = 0

    return {
        "external_id": f"dtf:{entry_id}" if entry_id is not None else "",
        "author": author,
        "title": title,
        "body": body,
        "url": url,
        "upvotes": likes,
        "post_date": post_date,
    }


def fetch_dtf_posts(
    query: str,
    game_name: str = "",
    limit: int = 25,
) -> list[dict]:
    """Search DTF for entries matching ``query`` and return normalized posts.

    Args:
        query:      A keyword phrase to search DTF for (e.g. "ILL Team Clout",
                    "хоррор ILL", "Halloween Illfonic").  Passed straight to
                    DTF's search endpoint; DTF handles Cyrillic + Latin
                    without transliteration.
        game_name:  Only used for logging + downstream keyword filtering;
                    doesn't affect the DTF request.
        limit:      Maximum number of entries to return.  DTF's search
                    endpoint returns 25 per page by default; we cap at
                    100 to be polite (roughly 4 pages).

    Returns:
        A list of post dicts matching the same shape as reddit posts —
        the ingestor's ``_bulk_save_posts`` accepts them directly.
        Empty list on any error (we NEVER raise from here so a DTF outage
        cannot break a full ingestion run).
    """
    limit = max(1, min(int(limit), 100))
    per_page = 25
    pages_needed = (limit + per_page - 1) // per_page

    all_entries: list[dict] = []
    for page in range(pages_needed):
        params = {
            "query": query,
            # subsites=all is DTF's way of asking for global search across
            # every subsite (not restricted to one channel).
            "subsites": "all",
            "sorting": "date",
            "offset": page * per_page,
            "count": per_page,
        }
        payload = _get(_SEARCH_URL, params=params)
        if not payload:
            # Break out: either an error or an empty page.  Don't keep
            # hammering — the ingestor will retry on the next cron.
            break
        # DTF search response shape (v2.5):
        #   {"result": {"items": [ {"id":…, "type": "entry", "data": {...entry...}}, … ] } }
        # or under some versions:
        #   {"result": [ {...entry...}, ... ]}
        # We defensively handle both.
        result = payload.get("result", payload)
        items = []
        if isinstance(result, dict):
            items = result.get("items") or result.get("entries") or []
        elif isinstance(result, list):
            items = result
        if not items:
            break

        for item in items:
            if not isinstance(item, dict):
                continue
            # Some search responses wrap the entry in {"type": "entry",
            # "data": {...}}; unwrap.
            entry = item.get("data") if item.get("type") in {"entry", "post"} else item
            if not isinstance(entry, dict):
                entry = item
            # Skip non-entry results (users, subsites, tags) — they show
            # up occasionally in mixed search results.
            if entry.get("id") is None:
                continue
            all_entries.append(_entry_to_dict(entry))

        if len(items) < per_page:
            # Last page reached.
            break

    logger.info(
        "DTF search q=%r game=%r returned %d entries",
        query, game_name, len(all_entries),
    )
    return all_entries


def fetch_dtf_posts_since(
    query: str,
    since_utc: datetime,
    game_name: str = "",
    hard_cap: int = 500,
) -> list[dict]:
    """Backfill helper: fetch all DTF posts matching ``query`` newer than
    ``since_utc`` — paging until we hit a post older than the cutoff or
    the hard cap.  Used by the ingest backfill job.

    We rely on DTF's ``sorting=date`` returning newest-first, so we can
    stop as soon as we see one post older than ``since_utc``.
    """
    per_page = 25
    out: list[dict] = []
    offset = 0
    while len(out) < hard_cap:
        params = {
            "query": query,
            "subsites": "all",
            "sorting": "date",
            "offset": offset,
            "count": per_page,
        }
        payload = _get(_SEARCH_URL, params=params)
        if not payload:
            break
        result = payload.get("result", payload)
        items = []
        if isinstance(result, dict):
            items = result.get("items") or result.get("entries") or []
        elif isinstance(result, list):
            items = result
        if not items:
            break

        page_hit_cutoff = False
        for item in items:
            if not isinstance(item, dict):
                continue
            entry = item.get("data") if item.get("type") in {"entry", "post"} else item
            if not isinstance(entry, dict) or entry.get("id") is None:
                continue
            normalized = _entry_to_dict(entry)
            if normalized["post_date"] < since_utc:
                page_hit_cutoff = True
                # Do NOT break here — DTF's date sort has occasional
                # anomalies where a slightly-older post sneaks in; we
                # still want to keep any newer ones on this page. We
                # only stop paginating after this page finishes.
                continue
            out.append(normalized)
            if len(out) >= hard_cap:
                break

        if page_hit_cutoff or len(items) < per_page:
            break
        offset += per_page

    logger.info(
        "DTF backfill q=%r since=%s game=%r returned %d entries",
        query, since_utc.isoformat(), game_name, len(out),
    )
    return out
