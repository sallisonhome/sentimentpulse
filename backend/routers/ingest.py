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
    matches: list[str] = []
    for offset in (0, 1):  # today, then yesterday
        d = date.today() - timedelta(days=offset)
        path = _LOG_DIR / f"ingest_{d.isoformat()}.log"
        if not path.exists():
            continue
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                # Read the file once; for our log sizes this is cheap.
                for line in fh.readlines():
                    s = line.rstrip("\n")
                    if ("Step 4b" in s) or ("Bluesky" in s) or ("bluesky" in s):
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
        "probe": {"attempted": False, "count": None, "error": None,
                  "sample_titles": []},
    }

    if probe:
        out["probe"]["attempted"] = True
        try:
            # Import lazily so a missing module never breaks the rest of the
            # diagnostic response.
            from services.bluesky_service import fetch_bluesky_posts_for_game
            posts = fetch_bluesky_posts_for_game(probe_game, limit=5)
            out["probe"]["count"] = len(posts)
            # Each post is the dict shape that _bulk_save_posts expects;
            # surface just enough to confirm shape & filtering without
            # leaking author handles or full text.
            out["probe"]["sample_titles"] = [
                (p.get("title") or p.get("body") or "")[:80]
                for p in posts[:3]
            ]
        except Exception as exc:  # noqa: BLE001
            out["probe"]["error"] = f"{type(exc).__name__}: {exc}"

    return out
