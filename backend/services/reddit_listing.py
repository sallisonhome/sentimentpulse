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


def valid_resume(resume, *, after, upper):
    """Return a sanitized resume window or None.

    A resume record means every post in [before, upper) was already scanned
    and its matches saved, for exactly this `after` boundary. It is never a
    completeness claim; only an exhausted window earns checked_through.
    """
    if not isinstance(resume, dict):
        return None
    try:
        r_after = int(resume["after"])
        r_before = int(resume["before"])
        r_upper = int(resume["upper"])
    except (KeyError, TypeError, ValueError):
        return None
    if r_after != int(after) or not (after < r_before <= r_upper <= upper):
        return None
    return {"after": r_after, "before": r_before, "upper": r_upper}


def fetch_candidates(subreddit, query, *, after, limit=100,
                     max_pages=MAX_PAGES, max_seconds=MAX_SECONDS, resume=None):
    """Return raw candidates with FetchRows completeness metadata.

    Query is the existing single keyword, not an invented taxonomy. Provider
    full-text syntax/multi-token queries remain on the legacy path.
    The timestamp boundary overlaps one second; same-second saturation is
    explicitly incomplete rather than skipping unseen IDs.

    2026-10-02: a window too deep for one run's time budget used to restart
    from the top every day and never finish (sparse games whose cursor is
    their last match, months old). When `resume` describes the interval a
    previous run already scanned for this same `after`, scan only the new
    top segment [resume.upper, upper) and then continue below resume.before.
    A time-budget stop returns `result.resume` for the caller to persist
    after a safe save. Completion and checked_through rules are unchanged.
    """
    if not transport.run_active() or not after or len(query.split()) != 1:
        raise ValueError("Listing scans require an active run and bounded single-keyword window")
    cache = _cache()
    subreddit = subreddit.lower()
    resume = valid_resume(resume, after=after, upper=cache.upper)
    started = time.monotonic()
    candidates = {}
    title_hits, body_hits = set(), set()
    keyword = query.casefold()
    state = {"pages": 0}

    def scan(before, lower):
        """Page newest-first from `before` down to exclusive `lower`.

        Returns (reason, next_before). reason 'window_exhausted' means the
        whole segment was read.
        """
        reason = "page_budget"
        while state["pages"] < max_pages:
            if time.monotonic() - started >= max_seconds:
                return "time_budget", before
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
                state["pages"] += 1
                rows = sorted(rows, key=lambda p: p["created_utc"], reverse=True)
                for post in rows:
                    if post["created_utc"] <= lower:
                        continue
                    pid = post["id"]
                    if len(title_hits) < limit and keyword in (post.get("title") or "").casefold():
                        title_hits.add(pid)
                        candidates[pid] = post
                    if len(body_hits) < limit and keyword in (post.get("selftext") or "").casefold():
                        body_hits.add(pid)
                        candidates[pid] = post
                oldest = min((int(p["created_utc"]) for p in rows), default=before)
                if len(rows) < PAGE_SIZE or oldest <= lower:
                    return "window_exhausted", before
                if len(title_hits) >= limit and len(body_hits) >= limit:
                    # Same per-field cap as existing keyword requests. This does
                    # NOT establish an exhausted window, so no checked-through.
                    return "existing_query_limits_satisfied", before
                next_before = oldest + 1
                if next_before >= before:
                    return "timestamp_boundary_saturated", before
                before = next_before
            except Exception as exc:
                log.warning("Reddit listing r/%s incomplete: %s", subreddit, exc)
                return f"upstream_error:{type(exc).__name__}", before
        return reason, before

    complete = False
    checked_through = None
    next_resume = None
    if resume is None:
        reason, stopped_at = scan(cache.upper, after)
        if reason == "time_budget" and stopped_at < cache.upper:
            next_resume = {"after": int(after), "before": int(stopped_at),
                           "upper": int(cache.upper)}
    else:
        # New top segment first: one-second overlap below the old upper.
        reason, _ = scan(cache.upper, resume["upper"] - 1)
        if reason == "window_exhausted":
            reason, stopped_at = scan(resume["before"], after)
            if reason == "time_budget":
                next_resume = {"after": int(after), "before": int(stopped_at),
                               "upper": int(cache.upper)}
        elif reason == "time_budget":
            # Top segment unfinished: the earlier record stays authoritative.
            next_resume = dict(resume)
    if reason == "window_exhausted":
        complete = True
        checked_through = cache.upper
    elif reason == "existing_query_limits_satisfied":
        complete = True
    result = transport.FetchRows(candidates.values(), complete=complete,
                                 checked_through=checked_through, stop_reason=reason,
                                 resume=next_resume)
    log.info("reddit_listing subreddit=%s query=%s after=%s upper=%s pages=%d "
             "candidates=%d complete=%s stop=%s resumed=%s elapsed_s=%.3f",
             subreddit, query, after, cache.upper, state["pages"], len(result),
             complete, reason, resume is not None, time.monotonic()-started)
    return result
