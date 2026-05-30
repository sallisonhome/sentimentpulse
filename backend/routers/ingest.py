"""
Ingest router.

  GET  /api/ingest/status         — last run details + next scheduled run time
  POST /api/ingest/run            — manually trigger the full ingestion pipeline
  GET  /api/ingest/diag/bluesky   — diagnostic: env presence + recent [Step 4b]
                                    log lines + optional live fetch probe.
                                    Read-only.  Never returns secret values.
"""
import logging
import os
from datetime import date, timedelta
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Query

from scheduler import get_next_run_time
from schemas import IngestRunResponse, IngestStatusResponse
from services.ingestor import get_status, run_ingestion

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])

# Same log directory the ingestor itself writes to.
_LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


@router.get("/status", response_model=IngestStatusResponse)
def get_ingest_status():
    """
    Return current ingestion status: whether a run is in progress, last-run
    results, error list, and the next scheduled run time.
    """
    status = get_status()
    # Enrich with live next-run-time from the scheduler
    status["next_run_at"] = get_next_run_time()
    return IngestStatusResponse(**status)


@router.post("/run", response_model=IngestRunResponse, status_code=202)
def trigger_ingestion(background_tasks: BackgroundTasks):
    """
    Manually trigger the full ingestion pipeline in the background.

    Returns 202 Accepted immediately.  Poll GET /api/ingest/status to
    track progress.  Returns 'skipped' if a run is already in progress.
    """
    status = get_status()
    if status["is_running"]:
        logger.info("Manual trigger received but ingestion is already running.")
        return IngestRunResponse(
            status="skipped",
            errors=["An ingestion run is already in progress."],
        )

    background_tasks.add_task(run_ingestion)
    logger.info("Manual ingestion trigger accepted — queued as background task.")
    return IngestRunResponse(status="started")


# ── Bluesky diagnostic ──────────────────────────────────────────────────────

def _bluesky_log_lines(max_lines: int = 60) -> list[str]:
    """Return recent Step 4b / Bluesky lines from today's (then yesterday's)
    ingest log file.  Empty list if neither log file exists."""
    return _ingest_log_lines(
        substrings=("Step 4b", "Bluesky", "bluesky"),
        max_lines=max_lines,
    )


def _ingest_log_lines(
    substrings: tuple[str, ...],
    max_lines: int = 200,
    lookback_days: int = 2,
) -> list[str]:
    """Generic ingest-log tail.  Returns lines from today's (then earlier)
    ingest log file that contain ANY of `substrings`.  Empty list if no
    relevant log file exists.
    """
    matches: list[str] = []
    for offset in range(lookback_days):
        d = date.today() - timedelta(days=offset)
        path = _LOG_DIR / f"ingest_{d.isoformat()}.log"
        if not path.exists():
            continue
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh.readlines():
                    s = line.rstrip("\n")
                    if any(needle in s for needle in substrings):
                        matches.append(f"{d.isoformat()}: {s.strip()}")
        except Exception as exc:  # noqa: BLE001
            matches.append(f"{d.isoformat()}: <error reading log: {exc}>")
        if matches:
            break
    return matches[-max_lines:]


@router.get("/diag/bluesky")
def diag_bluesky(
    probe: bool = Query(
        False,
        description=(
            "If true, run a live fetch_bluesky_posts_for_game probe for a "
            "single test game and return the count/error.  Off by default."
        ),
    ),
    probe_game: str = Query(
        "Warhammer 40,000: Space Marine 2",
        description="Game name to use when probe=true.",
    ),
    probe_limit: int = Query(
        5,
        ge=1,
        le=100,
        description="Limit passed to fetch_bluesky_posts_for_game when probe=true.",
    ),
    warnings_level: str = Query(
        "INFO",
        pattern="^(DEBUG|INFO|WARNING|ERROR|CRITICAL)$",
        description="Minimum log level to include in recent_warnings.",
    ),
    warnings_max: int = Query(
        100,
        ge=1,
        le=400,
        description="Max number of log lines to include in recent_warnings.",
    ),
    clear_warnings: bool = Query(
        False,
        description=(
            "If true (and probe=true), drop all buffered log lines BEFORE "
            "running the probe so the response shows only probe-emitted "
            "log records.  Has no effect when probe=false."
        ),
    ),
):
    """Diagnostic endpoint for Bluesky ingestion (read-only).

    Returns:
      env.BLUESKY_HANDLE_present, env.BLUESKY_HANDLE_length
      env.BLUESKY_APP_PASSWORD_present, env.BLUESKY_APP_PASSWORD_length
      env.BLUESKY_ENABLED                  (raw lower-cased; not a secret)
      recent_log_lines                     (last 60 Step 4b / Bluesky lines)
      probe.attempted, probe.count, probe.error

    NEVER returns secret values.
    """
    handle = os.environ.get("BLUESKY_HANDLE", "")
    pw = os.environ.get("BLUESKY_APP_PASSWORD", "")
    enabled = os.environ.get("BLUESKY_ENABLED", "")

    # Read ring buffer up-front so the response always carries it.
    from services.bluesky_log_buffer import get_recent as get_recent_logs
    from services.bluesky_log_buffer import clear as clear_log_buffer

    out: dict = {
        "env": {
            "BLUESKY_HANDLE_present": bool(handle.strip()),
            "BLUESKY_HANDLE_length": len(handle),
            "BLUESKY_APP_PASSWORD_present": bool(pw.strip()),
            "BLUESKY_APP_PASSWORD_length": len(pw),
            "BLUESKY_ENABLED": enabled,
            "BLUESKY_ENABLED_kill_switch_active": enabled.lower() == "false",
        },
        "log_path_today": str(_LOG_DIR / f"ingest_{date.today().isoformat()}.log"),
        "recent_log_lines": _bluesky_log_lines(),
        "recent_warnings": [],   # populated below
        "probe": {"attempted": False, "count": None, "error": None,
                  "sample_titles": []},
    }

    if probe:
        # Optionally clear the buffer so the response shows only probe records.
        if clear_warnings:
            dropped = clear_log_buffer()
            out["probe"]["cleared_buffer_lines"] = dropped

        out["probe"]["attempted"] = True
        out["probe"]["limit_used"] = probe_limit
        try:
            # Import lazily so a missing module never breaks the rest of the
            # diagnostic response.
            from services.bluesky_service import (
                fetch_bluesky_posts_for_game,
                _build_search_query,
                _fetch_page,
                _get_session,
                _post_mentions_game,
            )
            from services.reddit_service import _game_search_query

            # ── Full pipeline output (what the ingestor sees) ───────────────
            posts = fetch_bluesky_posts_for_game(probe_game, limit=probe_limit)
            out["probe"]["count"] = len(posts)
            out["probe"]["sample_titles"] = [
                (p.get("title") or p.get("body") or "")[:80]
                for p in posts[:3]
            ]

            # ── Unfiltered page-1 output (before relevance filter) ──────────
            # Lets us see how many raw posts Bluesky returns for this query
            # and how many pass _post_mentions_game.
            sess = _get_session()
            if sess is None:
                out["probe"]["raw_page1"] = {"error": "no session"}
            else:
                jwt = sess.get_access_jwt()
                if not jwt:
                    out["probe"]["raw_page1"] = {"error": "no jwt"}
                else:
                    search_q = _build_search_query(probe_game)
                    filter_q = _game_search_query(probe_game)
                    raw_posts, next_cursor, http_status = _fetch_page(
                        search_q, min(probe_limit, 100), None, jwt
                    )
                    mention_pass = [
                        p for p in raw_posts if _post_mentions_game(p, filter_q)
                    ]
                    out["probe"]["raw_page1"] = {
                        "http_status": http_status,
                        "search_query": search_q,
                        "filter_query": filter_q,
                        "raw_count": len(raw_posts),
                        "after_relevance_filter": len(mention_pass),
                        "next_cursor_present": bool(next_cursor),
                        "first_3_raw_bodies": [
                            (p.get("body") or "")[:120] for p in raw_posts[:3]
                        ],
                    }
        except Exception as exc:  # noqa: BLE001
            out["probe"]["error"] = f"{type(exc).__name__}: {exc}"

    # Always populate recent_warnings at the end so probe-emitted lines are
    # included.
    out["recent_warnings"] = get_recent_logs(
        max_lines=warnings_max, level_min=warnings_level
    )
    return out


# ── General ingest log tail (any source / any keyword) ──────────────────

@router.get("/diag/log")
def diag_log(
    needle: str = Query(
        ...,
        min_length=1,
        max_length=200,
        description=(
            "Substring(s) to search for in the ingest log.  Comma-separated "
            "values are OR'd together (e.g. 'Step 3,Step 4,error')."
        ),
    ),
    max_lines: int = Query(
        200,
        ge=1,
        le=2000,
        description="Max number of matching lines to return.",
    ),
    lookback_days: int = Query(
        2,
        ge=1,
        le=14,
        description="How many days of log files to walk back if today is empty.",
    ),
):
    """Read-only tail of the ingest log, filtered by substring.  Useful for
    diagnosing Reddit / Steam / Bluesky / Discord ingestion runs without
    SSH access to the droplet.
    """
    substrings = tuple(s.strip() for s in needle.split(",") if s.strip())
    if not substrings:
        return {"lines": [], "needle": needle, "count": 0}
    lines = _ingest_log_lines(
        substrings=substrings,
        max_lines=max_lines,
        lookback_days=lookback_days,
    )
    return {
        "needle": needle,
        "substrings": list(substrings),
        "lookback_days": lookback_days,
        "count": len(lines),
        "lines": lines,
    }
