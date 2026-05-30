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


# ── Reddit save-path probe ───────────────────────────────────────────

@router.get("/diag/reddit_save")
def diag_reddit_save(
    game_id: int = Query(..., description="Game id to use for the probe."),
    subreddit: str = Query(..., description="Subreddit name to fetch from (e.g. 'Spacemarine')."),
    limit: int = Query(10, ge=1, le=50),
    dry_run: bool = Query(
        True,
        description=(
            "If true (default) NO rows are written.  We still walk the same "
            "code path as a real ingest and report what WOULD happen."
        ),
    ),
):
    """Trace one fetch_subreddit_posts → _bulk_save_posts call end-to-end and
    report per-step counts so we can see EXACTLY where posts disappear.

    Returns:
      fetch:
        count                  — len(posts) returned by fetch_subreddit_posts
        first_3_external_ids   — the IDs we tried to save (first 3 only)
        first_post_keys        — keys present on the first dict (to spot
                                  shape mismatches: missing fields, etc.)
        first_post_types       — type of each value on the first dict
                                  (this is what catches str vs datetime
                                  bugs like the Bluesky one)
      dedup:
        already_in_db          — count of fetched IDs that match an
                                  existing (external_id, source=reddit) row
        new_ids                — count of fetched IDs that are NEW
      save:
        attempted (dry_run=true) or actual_inserts (dry_run=false)
        per_post_outcomes      — list of {external_id, outcome,
                                  error_class, error_message} for the
                                  first 10 posts.

    Read-only when dry_run=true.  Writes real rows when dry_run=false.
    """
    from services.reddit_service import fetch_subreddit_posts
    from models import RawPost, SourceEnum, Game
    from database import SessionLocal

    out: dict = {
        "game_id": game_id,
        "subreddit": subreddit,
        "limit": limit,
        "dry_run": dry_run,
        "fetch": {},
        "dedup": {},
        "save": {},
    }

    db = SessionLocal()
    try:
        game = db.query(Game).filter(Game.id == game_id).first()
        if not game:
            return {"error": f"no game with id={game_id}"}
        out["game_name"] = game.name

        # ── Step 1: fetch ────────────────────────────────────────────
        posts = fetch_subreddit_posts(subreddit, limit=limit, game_name=game.name)
        out["fetch"]["count"] = len(posts)
        out["fetch"]["first_3_external_ids"] = [
            p.get("external_id") for p in posts[:3]
        ]
        if posts:
            first = posts[0]
            out["fetch"]["first_post_keys"] = sorted(first.keys())
            out["fetch"]["first_post_types"] = {
                k: type(v).__name__ for k, v in first.items()
            }
            # Surface the actual value of post_date so we can confirm if it's
            # a string (the Bluesky-style bug) or a datetime.
            out["fetch"]["first_post_post_date_repr"] = repr(first.get("post_date"))

        if not posts:
            return out

        # ── Step 2: dedup check (same query _bulk_save_posts runs) ──────────
        external_ids = [p["external_id"] for p in posts]
        known: set[str] = {
            row[0]
            for row in db.query(RawPost.external_id).filter(
                RawPost.external_id.in_(external_ids),
                RawPost.source == SourceEnum.reddit,
            )
        }
        out["dedup"]["already_in_db"] = len(known)
        out["dedup"]["new_ids"] = len(external_ids) - len(known)
        out["dedup"]["sample_already_in_db"] = list(known)[:5]

        # ── Step 3: per-post save trace ─────────────────────────────────
        outcomes: list[dict] = []
        actual_inserts = 0
        for pd in posts[:10]:
            ext = pd.get("external_id", "")
            if ext in known:
                outcomes.append({
                    "external_id": ext,
                    "outcome": "skipped_duplicate",
                    "error_class": None,
                    "error_message": None,
                })
                continue

            row = RawPost(
                game_id=game.id,
                source=SourceEnum.reddit,
                external_id=ext,
                author=pd.get("author"),
                title=pd.get("title"),
                body=pd.get("body"),
                url=pd.get("url"),
                upvotes=pd.get("upvotes", 0),
                post_date=pd.get("post_date"),
            )
            db.add(row)
            try:
                if dry_run:
                    # Force the SQL to be emitted so we see any conversion
                    # errors, then roll back.
                    db.flush()
                    db.rollback()
                    outcomes.append({
                        "external_id": ext,
                        "outcome": "would_insert",
                        "error_class": None,
                        "error_message": None,
                    })
                else:
                    db.commit()
                    actual_inserts += 1
                    outcomes.append({
                        "external_id": ext,
                        "outcome": "inserted",
                        "error_class": None,
                        "error_message": None,
                    })
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                outcomes.append({
                    "external_id": ext,
                    "outcome": "insert_failed",
                    "error_class": type(exc).__name__,
                    "error_message": str(exc)[:400],
                })

        out["save"]["per_post_outcomes"] = outcomes
        if dry_run:
            out["save"]["actual_inserts"] = 0
            out["save"]["note"] = "dry_run=true — nothing was written"
        else:
            out["save"]["actual_inserts"] = actual_inserts
    finally:
        db.close()

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
