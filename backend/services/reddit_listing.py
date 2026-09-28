"""Run-shared subreddit listing pages, with local keyword selection.

Avoid provider-side title/selftext queries which repeatedly time out. Scan the
same requested publication window; select the newest N title hits and N body
hits before the existing game relevance gate. Never call a bounded partial scan
complete. Only an exhausted window earns a checked-through watermark.
"""
import json
import logging
import sqlite3
import tempfile
import time
import zlib
from pathlib import Path

from services import reddit_transport as transport

log = logging.getLogger(__name__)
PAGE_SIZE = 100
MAX_PAGES = 1000
MAX_SECONDS = 600
CACHE_BYTES = 64 * 1024 * 1024
FIELDS = "id,title,selftext,author,score,created_utc,subreddit"
URL = "https://arctic-shift.photon-reddit.com/api/posts/search"


class ListingCache:
    """Compressed temporary disk cache; never persist unrelated posts in app DB."""

    def __init__(self, upper):
        self.upper = upper
        self.directory = tempfile.TemporaryDirectory(prefix="sp-reddit-pages-")
        self.db = sqlite3.connect(str(Path(self.directory.name) / "pages.db"))
        self.db.execute("CREATE TABLE pages (id INTEGER PRIMARY KEY, subreddit TEXT, "
                        "before_epoch INTEGER, payload BLOB, UNIQUE(subreddit,before_epoch))")
        self.size = 0

    def get(self, subreddit, before):
        row = self.db.execute(
            "SELECT payload FROM pages WHERE subreddit=? AND before_epoch=?",
            (subreddit, before)).fetchone()
        if row is None:
            return None
        transport._local.metrics["listing_cache_hits"] += 1
        return json.loads(zlib.decompress(row[0]))

    def put(self, subreddit, before, rows):
        payload = zlib.compress(json.dumps(rows).encode())
        if len(payload) > CACHE_BYTES:
            return
        while self.size + len(payload) > CACHE_BYTES:
            old = self.db.execute("SELECT id,length(payload) FROM pages ORDER BY id LIMIT 1").fetchone()
            if not old:
                break
            self.db.execute("DELETE FROM pages WHERE id=?", (old[0],))
            self.size -= old[1]
        self.db.execute("INSERT INTO pages(subreddit,before_epoch,payload) VALUES(?,?,?)",
                        (subreddit, before, payload))
        self.db.commit()
        self.size += len(payload)

    def close(self):
        self.db.close()
        self.directory.cleanup()


def _cache():
    cache = getattr(transport._local, "listing_cache", None)
    if cache is None:
        cache = ListingCache(transport._local.started_epoch)
        transport._local.listing_cache = cache
    return cache


def fetch_candidates(subreddit, query, *, after, limit=100,
                     max_pages=MAX_PAGES, max_seconds=MAX_SECONDS):
    """Return raw candidates with FetchRows completeness metadata.

    Query is the existing single keyword, not an invented taxonomy. Provider
    full-text syntax/multi-token queries remain on the legacy path.
    The timestamp boundary overlaps one second; same-second saturation is
    explicitly incomplete rather than skipping unseen IDs.
    """
    if not transport.run_active() or not after or len(query.split()) != 1:
        raise ValueError("Listing scans require an active run and bounded single-keyword window")
    cache = _cache()
    subreddit = subreddit.lower()
    before = cache.upper
    started = time.monotonic()
    candidates = {}
    title_hits, body_hits = set(), set()
    complete = False
    checked_through = None
    reason = "page_budget"
    keyword = query.casefold()
    pages = 0
    for _ in range(max_pages):
        if time.monotonic() - started >= max_seconds:
            reason = "time_budget"
            break
        try:
            rows = cache.get(subreddit, before)
            if rows is None:
                payload = transport.fetch_json(
                    URL, {"subreddit": subreddit, "before": before, "limit": PAGE_SIZE,
                          "sort": "desc", "fields": FIELDS},
                    headers={"User-Agent": "SentimentPulse/1.0", "Accept": "application/json"},
                    timeout=15, provider="arctic_shift", interval=1.0)
                rows = payload["data"]
                # Validate before caching or claiming a timestamp interval was read.
                if any(not p.get("id") or not isinstance(p.get("created_utc"), (int, float))
                       or p["created_utc"] >= before
                       or not isinstance(p.get("title", ""), (str, type(None)))
                       or not isinstance(p.get("selftext", ""), (str, type(None)))
                       for p in rows):
                    raise ValueError("Invalid listing ID, date, text or boundary")
                cache.put(subreddit, before, rows)
            pages += 1
            rows = sorted(rows, key=lambda p: p["created_utc"], reverse=True)
            for post in rows:
                if post["created_utc"] <= after:
                    continue
                pid = post["id"]
                if len(title_hits) < limit and keyword in (post.get("title") or "").casefold():
                    title_hits.add(pid)
                    candidates[pid] = post
                if len(body_hits) < limit and keyword in (post.get("selftext") or "").casefold():
                    body_hits.add(pid)
                    candidates[pid] = post
            oldest = min((int(p["created_utc"]) for p in rows), default=before)
            if len(rows) < PAGE_SIZE or oldest <= after:
                complete = True
                checked_through = cache.upper
                reason = "window_exhausted"
                break
            if len(title_hits) >= limit and len(body_hits) >= limit:
                # Same per-field cap as existing keyword requests. This does
                # NOT establish an exhausted window, so no checked-through.
                complete = True
                reason = "existing_query_limits_satisfied"
                break
            next_before = oldest + 1
            if next_before >= before:
                reason = "timestamp_boundary_saturated"
                break
            before = next_before
        except Exception as exc:
            log.warning("Reddit listing r/%s incomplete: %s", subreddit, exc)
            reason = f"upstream_error:{type(exc).__name__}"
            break
    result = transport.FetchRows(candidates.values(), complete=complete,
                                 checked_through=checked_through, stop_reason=reason)
    log.info("reddit_listing subreddit=%s query=%s after=%s upper=%s pages=%d "
             "candidates=%d complete=%s stop=%s elapsed_s=%.3f",
             subreddit, query, after, cache.upper, pages, len(result),
             complete, reason, time.monotonic()-started)
    return result
