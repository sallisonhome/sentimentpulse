"""Weekly source smoke test — Gap 1 hardening.

Hits each source's *real* fetch function with a known-good query and
asserts that at least one post is returned.  Designed to catch upstream
API regressions BEFORE they silently zero out a daily ingestion run
(2026-05-30 Reddit post_date bug, 2026-06-06 Bluesky atproto-proxy bug).

Runs weekly via APScheduler (`scheduler.py`).  Results are written to
the module-level `_smoke_status` dict and exposed via
`GET /api/ingest/diag/smoke_test`.

Probe choices intentionally hit stable, high-traffic targets so a 0
result reliably indicates a source-side regression — not a quiet probe.

CLAUDE.md §19: smoke tests don't replace the silent-source detector —
they're complementary.  The detector watches daily row counts; the smoke
test pokes the upstream API directly.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Module-level status — read by /api/ingest/diag/smoke_test.
_smoke_status: dict = {
    "last_run_at": None,        # ISO-8601 string
    "overall_status": "never",  # "never" | "ok" | "degraded"
    "results": {},              # source_key -> {"status", "count", "error", "probe"}
}


# ── Probe definitions ────────────────────────────────────────────────────────
# Each probe is a (key, label, callable) tuple.  Callable must return the
# number of posts/items returned by the real upstream API (raise on error).
# Probe targets are intentionally stable & high-volume so 0 ⇒ regression.

_REDDIT_PROBE_SUBREDDIT = "snowrunner"
_REDDIT_PROBE_GAME = "SnowRunner"
_BLUESKY_PROBE_QUERY = "SnowRunner"
_STEAM_PROBE_APP_ID = 1465360  # SnowRunner

# Saber Interactive games used as Steam-side probes — kept small so the
# weekly smoke test is cheap and finishes in seconds.


def _probe_reddit() -> int:
    """Fetch one page of /r/snowrunner via the real Reddit pipeline."""
    from services.reddit_service import fetch_subreddit_posts
    posts = fetch_subreddit_posts(
        subreddit_name=_REDDIT_PROBE_SUBREDDIT,
        limit=5,
        game_name=_REDDIT_PROBE_GAME,
    )
    return len(posts or [])


def _probe_bluesky() -> int:
    """Search Bluesky for a known-popular game name via the real client."""
    # Bluesky requires creds; without them, the probe is 'skipped' upstream.
    if not (os.getenv("BLUESKY_HANDLE") and os.getenv("BLUESKY_APP_PASSWORD")):
        # Surface as a structured 'skipped' rather than an error.
        raise RuntimeError("BLUESKY_HANDLE / BLUESKY_APP_PASSWORD not set")
    from services.bluesky_service import fetch_bluesky_posts_for_game
    posts = fetch_bluesky_posts_for_game(_BLUESKY_PROBE_QUERY, limit=5)
    return len(posts or [])


def _probe_steam_reviews() -> int:
    """Fetch a small slice of SnowRunner reviews via the real Steam endpoint."""
    from services.steam_service import fetch_reviews
    reviews = fetch_reviews(_STEAM_PROBE_APP_ID, known_ids=None, max_pages=1)
    return len(reviews or [])


def _probe_steam_forums() -> int:
    """Scrape the top forum threads on SnowRunner's discussion page."""
    from services.steam_service import scrape_forum_threads
    threads = scrape_forum_threads(_STEAM_PROBE_APP_ID, max_threads=2)
    return len(threads or [])


def _probe_bluesky_auth() -> int:
    """Hardening #3: exercise Bluesky's refreshSession to catch auth-token
    expiry / app-password revocation BEFORE a daily cron silently fetches 0.

    Strategy:
      1. Ensure a session exists (creates one if not).
      2. Call session.refresh() and assert it returns True.
    A passing probe means BOTH refreshSession and (on fallback) createSession
    are working with the current credentials.  Returns 1 on success so the
    'count > 0 → ok' contract of the smoke test holds.
    """
    if not (os.getenv("BLUESKY_HANDLE") and os.getenv("BLUESKY_APP_PASSWORD")):
        raise RuntimeError("BLUESKY_HANDLE / BLUESKY_APP_PASSWORD not set")
    from services.bluesky_service import _get_session
    sess = _get_session()
    if sess is None:
        raise RuntimeError("Bluesky session singleton unavailable")
    # Touch get_access_jwt to ensure a session is created on first run.
    jwt = sess.get_access_jwt()
    if not jwt:
        raise RuntimeError("createSession failed (no access JWT)")
    ok = sess.refresh()
    if not ok:
        raise RuntimeError(
            f"refresh() returned False (auth_health={sess.auth_health})"
        )
    return 1


# Probes are looked up by attribute name at call time (not captured by
# reference) so tests can monkeypatch individual probes via patch.object.
_PROBES = [
    ("reddit", "Reddit", "_probe_reddit"),
    ("bluesky", "Bluesky", "_probe_bluesky"),
    ("bluesky_auth", "Bluesky auth", "_probe_bluesky_auth"),
    ("steam_review", "Steam reviews", "_probe_steam_reviews"),
    ("steam_forum", "Steam forums", "_probe_steam_forums"),
]


# ── Public API ───────────────────────────────────────────────────────────────

def run_smoke_test() -> dict:
    """
    Hit each source's real API once and assert ≥1 result.

    Returns a result dict and updates the module-level status snapshot.
    Never raises — individual probe failures are captured per source so
    the weekly job always completes and any source-side regression is
    visible in the status endpoint.
    """
    started_at = datetime.now(timezone.utc).isoformat()
    results: dict[str, dict] = {}

    import sys
    this_mod = sys.modules[__name__]
    for key, label, probe_name in _PROBES:
        probe = getattr(this_mod, probe_name)
        probe_info = {
            "source": key,
            "label": label,
            "status": "unknown",
            "count": 0,
            "error": None,
            "probe": probe_name,
        }
        try:
            count = probe()
            probe_info["count"] = count
            probe_info["status"] = "ok" if count > 0 else "degraded"
            logger.info(
                f"[Smoke] {label}: {count} results "
                f"({'ok' if count > 0 else 'DEGRADED — 0 results'})"
            )
        except Exception as exc:
            probe_info["status"] = "degraded"
            probe_info["error"] = str(exc)
            logger.exception(f"[Smoke] {label} probe raised: {exc}")
        results[key] = probe_info

    degraded = [r["label"] for r in results.values() if r["status"] != "ok"]
    overall_status = "degraded" if degraded else "ok"

    _smoke_status["last_run_at"] = started_at
    _smoke_status["overall_status"] = overall_status
    _smoke_status["results"] = results
    if degraded:
        logger.warning(
            f"[Smoke] Weekly smoke test DEGRADED — sources flagged: "
            f"{', '.join(degraded)}"
        )
    return {
        "started_at": started_at,
        "overall_status": overall_status,
        "results": results,
    }


def get_smoke_status() -> dict:
    """Snapshot the most recent smoke-test results for the diag endpoint."""
    return dict(_smoke_status)
