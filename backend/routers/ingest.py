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
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from sqlalchemy.orm import Session

from database import get_db
from scheduler import get_next_run_time
from schemas import IngestRunResponse, IngestStatusResponse
from services.ingestor import get_status, run_ingestion

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


# In-process guard so the same POST /backfill can't be double-triggered.
_BACKFILL_RUNNING: dict = {"running": False, "last_started_at": None, "last_result": None}

# Same log directory the ingestor itself writes to.
_LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


# ── DTF ingestion toggle (2026-07-26) ───────────────────────────────────
#
# Runtime flag stored in AppSetting['dtf_enabled'] so operators can flip
# DTF on/off through the API without SSHing to the droplet.  Value
# 'true'/'1'/'yes'/'on' enables; anything else (or missing row) disables.


from pydantic import BaseModel  # noqa: E402


class DTFToggleRequest(BaseModel):
    enabled: bool


class DTFToggleResponse(BaseModel):
    enabled: bool
    source: str  # 'appsetting' or 'env'


@router.get("/dtf/enabled", response_model=DTFToggleResponse)
def dtf_get_enabled(db: Session = Depends(get_db)):
    """Return current DTF ingestion flag state."""
    from models import AppSetting  # noqa: PLC0415
    row = db.query(AppSetting).filter_by(key="dtf_enabled").first()
    if row and row.value:
        return DTFToggleResponse(
            enabled=row.value.strip().lower() in {"1", "true", "yes", "on"},
            source="appsetting",
        )
    import os  # noqa: PLC0415
    return DTFToggleResponse(
        enabled=os.getenv("DTF_ENABLED", "false").lower() in {"1", "true", "yes"},
        source="env",
    )


@router.post("/dtf/enabled", response_model=DTFToggleResponse)
def dtf_set_enabled(payload: DTFToggleRequest, db: Session = Depends(get_db)):
    """Set the DTF ingestion flag in AppSetting (survives redeploys)."""
    from models import AppSetting  # noqa: PLC0415
    row = db.query(AppSetting).filter_by(key="dtf_enabled").first()
    if row is None:
        row = AppSetting(key="dtf_enabled", value="true" if payload.enabled else "false")
        db.add(row)
    else:
        row.value = "true" if payload.enabled else "false"
    db.commit()
    logger.info("DTF ingestion flag set to %s", payload.enabled)
    return DTFToggleResponse(enabled=payload.enabled, source="appsetting")


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
def trigger_ingestion(
    background_tasks: BackgroundTasks,
    skip_sources: Optional[str] = Query(
        None,
        description=(
            "Optional comma-separated list of sources to skip for this run "
            "only. Valid names: reddit, bluesky, steam_review, steam_forum, "
            "dtf. Does NOT affect the scheduled daily cron, which always runs "
            "every source."
        ),
    ),
):
    """
    Manually trigger the full ingestion pipeline in the background.

    Returns 202 Accepted immediately.  Poll GET /api/ingest/status to
    track progress.  Returns 'skipped' if a run is already in progress.

    The optional `skip_sources` query param lets you skip specific
    sources for THIS manual run only (e.g. after deploying a fix to
    one source, re-ingest just that source without redundant fetches).
    The scheduled daily cron is unaffected and always runs every source.
    """
    status = get_status()
    if status["is_running"]:
        logger.info("Manual trigger received but ingestion is already running.")
        return IngestRunResponse(
            status="skipped",
            errors=["An ingestion run is already in progress."],
        )

    skip_set: Optional[set[str]] = None
    if skip_sources:
        skip_set = {s.strip() for s in skip_sources.split(",") if s.strip()}

    background_tasks.add_task(run_ingestion, skip_sources=skip_set)
    logger.info(
        "Manual ingestion trigger accepted — queued as background task "
        "(skip_sources=%s).",
        sorted(skip_set) if skip_set else None,
    )
    return IngestRunResponse(status="started")


# ------------------------------------------------------------------ backfill

def _run_backfill(game_ids: list[int], start_date: str) -> None:
    """Background wrapper for historical_backfill.main()."""
    from datetime import datetime, timezone as _tz
    from database import SessionLocal
    from models import Game
    from services.ingestor import (
        _step5_classify_sentiment,
        _step6_extract_topics,
        _step7_daily_summary,
    )
    from scripts.historical_backfill import (
        backfill_reddit_for_game,
        backfill_steam_reviews_for_game,
        backfill_steam_forums_for_game,
        backfill_dtf_for_game,
    )
    from services.nlp_service import load_model

    try:
        _BACKFILL_RUNNING["running"] = True
        start_dt = datetime.fromisoformat(start_date).replace(tzinfo=_tz.utc)
        start_epoch = int(start_dt.timestamp())
        load_model()
        db = SessionLocal()
        result_lines: list[str] = []
        try:
            for gid in game_ids:
                game = db.query(Game).filter_by(id=gid).first()
                if not game:
                    result_lines.append(f"game {gid}: not found")
                    continue
                errors: list[str] = []
                r_saved = backfill_reddit_for_game(db, game, start_epoch, errors)
                db.commit()
                sr_saved = backfill_steam_reviews_for_game(db, game, start_dt, errors)
                db.commit()
                sf_saved = backfill_steam_forums_for_game(db, game, start_dt, errors)
                db.commit()
                # DTF backfill (2026-07-26). Skips at runtime when the
                # AppSetting['dtf_enabled'] flag is not set to true.
                d_saved = backfill_dtf_for_game(db, game, start_dt, errors)
                db.commit()

                log_lines: list[str] = []
                step_errors: list[str] = []
                _step5_classify_sentiment(db, game, log_lines, step_errors)
                _step6_extract_topics(db, game, log_lines, step_errors)
                _step7_daily_summary(db, game, log_lines, step_errors)
                db.commit()

                result_lines.append(
                    f"#{gid} {game.name}: reddit={r_saved} steam_reviews={sr_saved} "
                    f"steam_forums={sf_saved} dtf={d_saved} fetch_errors={len(errors)} "
                    f"step_errors={len(step_errors)}"
                )
        finally:
            db.close()
        _BACKFILL_RUNNING["last_result"] = result_lines
    except Exception as exc:
        logger.exception("Backfill crashed: %s", exc)
        _BACKFILL_RUNNING["last_result"] = [f"CRASHED: {exc}"]
    finally:
        _BACKFILL_RUNNING["running"] = False


def _run_bluesky_backfill(game_ids: list[int], start_date: str) -> None:
    """Background wrapper for Bluesky-only historical backfill (2026-07-28).

    Same as _run_backfill but only calls backfill_bluesky_for_game per game.
    Used to fill in past-N-day Bluesky coverage without re-running the
    other sources (which don't need it). After fetching, runs Steps 5-7
    so the newly-saved Bluesky posts get scored and rolled into
    per-day summaries.
    """
    from datetime import datetime, timezone as _tz
    from database import SessionLocal
    from models import Game
    from services.ingestor import (
        _step5_classify_sentiment,
        _step6_extract_topics,
        _step7_daily_summary,
    )
    from scripts.historical_backfill import backfill_bluesky_for_game
    from services.nlp_service import load_model

    try:
        _BACKFILL_RUNNING["running"] = True
        start_dt = datetime.fromisoformat(start_date).replace(tzinfo=_tz.utc)
        load_model()
        db = SessionLocal()
        result_lines: list[str] = []
        try:
            for gid in game_ids:
                game = db.query(Game).filter_by(id=gid).first()
                if not game:
                    result_lines.append(f"game {gid}: not found")
                    continue
                errors: list[str] = []
                b_saved = backfill_bluesky_for_game(db, game, start_dt, errors)
                db.commit()

                # Score + summarize the newly-saved posts. Steps 5-7
                # are idempotent on already-scored posts, so re-running
                # them for games with existing posts is a no-op.
                log_lines: list[str] = []
                step_errors: list[str] = []
                _step5_classify_sentiment(db, game, log_lines, step_errors)
                _step6_extract_topics(db, game, log_lines, step_errors)
                _step7_daily_summary(db, game, log_lines, step_errors)
                db.commit()

                result_lines.append(
                    f"#{gid} {game.name}: bluesky={b_saved} "
                    f"fetch_errors={len(errors)} step_errors={len(step_errors)}"
                )
            _BACKFILL_RUNNING["last_result"] = result_lines
        finally:
            db.close()
    except Exception as exc:
        logger.exception("bluesky-only backfill crashed: %s", exc)
        _BACKFILL_RUNNING["last_result"] = [f"CRASHED: {exc}"]
    finally:
        _BACKFILL_RUNNING["running"] = False


@router.post("/backfill/bluesky", status_code=202)
def trigger_bluesky_backfill(
    background_tasks: BackgroundTasks,
    game_ids: str = Query(
        ...,
        description="Comma-separated game IDs, or 'all' for every active game.",
    ),
    start_date: str = Query(
        ...,
        description="ISO date (YYYY-MM-DD). Bluesky's search index has good "
                    "coverage back ~30 days; older windows yield sparse results.",
    ),
):
    """Trigger a Bluesky-only historical backfill for the specified games.

    Complements POST /backfill (which handles Reddit + Steam Reviews +
    Steam Forums + DTF). Useful after deploying a change that affects
    Bluesky signal quality — e.g. the 2026-07-28 exact-phrase query
    rewrite + aggregator/promo filter — without wasting quota re-fetching
    unchanged sources.

    Idempotent: _bulk_save_posts dedupes on external_id, so overlap with
    existing Bluesky rows is free.
    """
    if _BACKFILL_RUNNING["running"]:
        return {"status": "skipped", "reason": "backfill_already_running"}

    # Resolve 'all' to the current active-game list.
    if game_ids.strip().lower() == "all":
        from database import SessionLocal
        from models import Game
        db = SessionLocal()
        try:
            resolved = [
                g.id for g in db.query(Game).filter(Game.is_active == True).order_by(Game.id).all()  # noqa: E712
            ]
        finally:
            db.close()
    else:
        try:
            resolved = [int(x.strip()) for x in game_ids.split(",") if x.strip()]
        except ValueError:
            return {"status": "error", "reason": "game_ids must be integers or 'all'"}

    if not resolved:
        return {"status": "error", "reason": "no games resolved"}

    _BACKFILL_RUNNING["last_started_at"] = start_date
    _BACKFILL_RUNNING["last_result"] = None
    background_tasks.add_task(_run_bluesky_backfill, resolved, start_date)
    return {
        "status": "started",
        "scope": "bluesky_only",
        "game_ids": resolved,
        "start_date": start_date,
    }


@router.post("/backfill", status_code=202)
def trigger_backfill(
    background_tasks: BackgroundTasks,
    game_ids: str = Query(..., description="Comma-separated game IDs, e.g. 138,139"),
    start_date: str = Query(..., description="ISO date, e.g. 2026-04-01"),
):
    """
    Historical backfill for one or more games. Pulls Reddit (via PullPush
    paged by `before=`) and Steam Reviews (cursor-paged) all the way back
    to `start_date`, then runs Step 5–7 (sentiment, topics, daily summary).

    Runs in the background. Poll GET /api/ingest/backfill/status.
    """
    from datetime import datetime
    try:
        parsed_ids = [int(x.strip()) for x in game_ids.split(",") if x.strip()]
        datetime.fromisoformat(start_date)  # validate
    except Exception as exc:
        return {"status": "error", "errors": [f"invalid input: {exc}"]}

    if _BACKFILL_RUNNING["running"]:
        return {"status": "skipped", "errors": ["backfill already running"]}

    _BACKFILL_RUNNING["last_started_at"] = start_date
    background_tasks.add_task(_run_backfill, parsed_ids, start_date)
    return {"status": "started", "game_ids": parsed_ids, "start_date": start_date}


@router.get("/backfill/status")
def backfill_status():
    return {
        "running": _BACKFILL_RUNNING["running"],
        "last_started_at": _BACKFILL_RUNNING["last_started_at"],
        "last_result": _BACKFILL_RUNNING["last_result"],
    }


# In-process guard for remediation runs.
_REMEDIATION_STATE: dict = {"running": False, "last_result": None}


def _run_ill_townfall_remediation() -> None:
    """Background wrapper for the one-time ILL/Townfall purge-and-rebuild."""
    try:
        _REMEDIATION_STATE["running"] = True
        # Import inside the function so an import error surfaces in
        # last_result rather than crashing the server on startup.
        from scripts.purge_and_rebuild_ill_townfall import main as _remed_main
        rc = _remed_main()
        _REMEDIATION_STATE["last_result"] = f"rc={rc}"
    except Exception as exc:
        logger.exception("Remediation crashed: %s", exc)
        _REMEDIATION_STATE["last_result"] = f"CRASHED: {exc}"
    finally:
        _REMEDIATION_STATE["running"] = False


@router.post("/remediate/ill_townfall", status_code=202)
def trigger_ill_townfall_remediation(background_tasks: BackgroundTasks):
    """
    One-time endpoint (safe to call multiple times — the underlying script
    is idempotent). Purges contaminated SentimentRecords + DailySummary
    + WindowSummary rows for ILL (#138) and SILENT HILL: Townfall (#139),
    rewrites their distinctive_keywords to stricter values, and re-runs
    Steps 5–7 against the RawPost rows already in the DB.
    """
    if _REMEDIATION_STATE["running"]:
        return {"status": "skipped", "errors": ["remediation already running"]}
    background_tasks.add_task(_run_ill_townfall_remediation)
    return {"status": "started"}


@router.get("/remediate/ill_townfall/status")
def remediation_status():
    return _REMEDIATION_STATE


# ── Steam Forum 90-day backfill (all active games) ────────────────────────
_STEAM_FORUM_BACKFILL_STATE: dict = {"running": False, "last_result": None}


def _run_steam_forum_backfill_all_active(days_back: int) -> None:
    """Background wrapper: 90-day Steam Forum backfill across every active game."""
    from datetime import datetime, timedelta, timezone as _tz
    from database import SessionLocal
    from models import Game
    from services.ingestor import (
        _step5_classify_sentiment,
        _step6_extract_topics,
        _step7_daily_summary,
    )
    from scripts.historical_backfill import backfill_steam_forums_for_game
    from scripts.reclassify_steam_source_posts import main as _reset_steam_relevance
    from services.nlp_service import load_model

    try:
        _STEAM_FORUM_BACKFILL_STATE["running"] = True
        _STEAM_FORUM_BACKFILL_STATE["last_result"] = None

        # Step 0: reset is_relevant on existing Steam Source rows so Step 5
        # will re-evaluate them under the new auto-admit rule.
        try:
            _reset_steam_relevance()
        except Exception as exc:
            logger.exception("steam_source relevance reset crashed: %s", exc)

        start_dt = datetime.now(tz=_tz.utc) - timedelta(days=days_back)
        load_model()
        db = SessionLocal()
        result_lines: list[str] = []
        try:
            games = db.query(Game).filter_by(is_active=True).all()
            logger.info(
                "Steam Forum backfill starting: %d active games, days_back=%d, start_dt=%s",
                len(games), days_back, start_dt.date(),
            )
            for game in games:
                if not game.steam_app_id:
                    result_lines.append(f"#{game.id} {game.name}: skipped (no steam_app_id)")
                    continue
                errors: list[str] = []
                try:
                    sf_saved = backfill_steam_forums_for_game(db, game, start_dt, errors)
                    db.commit()
                except Exception as exc:
                    db.rollback()
                    result_lines.append(f"#{game.id} {game.name}: FETCH_CRASHED {exc}")
                    continue

                # Rerun Steps 5-7 so newly-saved forum posts get SentimentRecords
                # + topic + daily summaries immediately (rather than waiting for
                # the nightly cron).
                log_lines: list[str] = []
                step_errors: list[str] = []
                try:
                    _step5_classify_sentiment(db, game, log_lines, step_errors)
                    _step6_extract_topics(db, game, log_lines, step_errors)
                    _step7_daily_summary(db, game, log_lines, step_errors)
                    db.commit()
                except Exception as exc:
                    db.rollback()
                    step_errors.append(str(exc))

                result_lines.append(
                    f"#{game.id} {game.name}: steam_forums_saved={sf_saved} "
                    f"fetch_errors={len(errors)} step_errors={len(step_errors)}"
                )
        finally:
            db.close()
        _STEAM_FORUM_BACKFILL_STATE["last_result"] = result_lines
    except Exception as exc:
        logger.exception("Steam Forum backfill crashed: %s", exc)
        _STEAM_FORUM_BACKFILL_STATE["last_result"] = [f"CRASHED: {exc}"]
    finally:
        _STEAM_FORUM_BACKFILL_STATE["running"] = False


@router.post("/backfill/steam_forums_all", status_code=202)
def trigger_steam_forum_backfill_all(
    background_tasks: BackgroundTasks,
    days_back: int = Query(90, ge=1, le=730),
):
    """
    Deep Steam Forum backfill for EVERY active game with a Steam AppID.
    Walks up to 15 pages of forum listings per game (~200 threads max)
    and saves every post newer than N days ago (default 90). Runs in the
    background — poll GET /api/ingest/backfill/steam_forums_all/status.

    Also resets is_relevant=NULL on existing Steam Review + Steam Forum
    RawPost rows so the new source-aware auto-admit rule (Step 5) can
    re-classify them into SentimentRecords — fixes the pre-2026-07-25
    gap where many Steam Source posts were rejected by the same
    distinctive_keyword filter used for Reddit + Bluesky.
    """
    if _STEAM_FORUM_BACKFILL_STATE["running"]:
        return {"status": "skipped", "errors": ["steam forum backfill already running"]}
    background_tasks.add_task(_run_steam_forum_backfill_all_active, days_back)
    return {"status": "started", "days_back": days_back}


@router.get("/backfill/steam_forums_all/status")
def steam_forum_backfill_status():
    return _STEAM_FORUM_BACKFILL_STATE


@router.post("/remediate/ill_reddit_reclassify", status_code=202)
def trigger_ill_reddit_reclassify(background_tasks: BackgroundTasks):
    """
    2026-07-25 afternoon fix: purge existing ILL Reddit SentimentRecords
    + reset is_relevant=NULL on all ILL RawPost.reddit rows, so the next
    Step 5 run re-evaluates them under the new short-collision-words
    fuzzy-match guard. Idempotent.
    """
    def _run():
        from scripts.reclassify_ill_2026_07_25 import main as _main
        try:
            _main()
            from database import SessionLocal
            from models import Game
            from services.ingestor import (
                _step5_classify_sentiment,
                _step6_extract_topics,
                _step7_daily_summary,
            )
            from services.nlp_service import load_model
            load_model()
            db = SessionLocal()
            try:
                game = db.query(Game).filter_by(id=138).first()
                if game:
                    log_lines: list[str] = []
                    errors: list[str] = []
                    _step5_classify_sentiment(db, game, log_lines, errors)
                    _step6_extract_topics(db, game, log_lines, errors)
                    _step7_daily_summary(db, game, log_lines, errors)
                    db.commit()
            finally:
                db.close()
        except Exception as exc:
            logger.exception("ILL reclassify crashed: %s", exc)
    background_tasks.add_task(_run)
    return {"status": "started"}


@router.post("/purge/by_source_and_game", status_code=202)
def purge_by_source_and_game(
    source: str = Query(..., description="Source enum name (reddit, bluesky, steam_review, steam_forum, dtf)"),
    game_ids: str = Query(..., description="Comma-separated game IDs, or 'all' for every active game"),
    date_from: Optional[str] = Query(None, description="Optional ISO date lower bound on collected_at (inclusive)"),
    date_to: Optional[str] = Query(None, description="Optional ISO date upper bound on collected_at (inclusive, end-of-day)"),
    confirm: str = Query(..., description="Must equal 'YES_DELETE' to run. Guard against accidental purges."),
    db: Session = Depends(get_db),
):
    """Scoped purge of RawPost + SentimentRecord rows by source + game_ids.

    Added 2026-07-28 for the Bluesky noise-cleanup workstream. Removes
    posts that shouldn't have been saved (e.g., pre-fix Bluesky noise
    for games with ambiguous titles).

    Safety:
      * Requires confirm='YES_DELETE' to actually run. Missing/wrong
        confirm returns 400 instead of deleting.
      * Deletes SentimentRecord first (FK safety), then RawPost.
      * Optional date_from / date_to bound the window on collected_at.
        Both use inclusive semantics; date_to is treated as end-of-day.
      * Idempotent — re-running returns zero counts once complete.

    Returns counts, no side effects other than the DB delete.
    """
    from datetime import date as _date, datetime as _dt, time as _time
    from models import Game, RawPost, SentimentRecord, SourceEnum

    if confirm != "YES_DELETE":
        return {
            "status": "refused",
            "reason": "confirm parameter must equal 'YES_DELETE' to run",
        }

    # Validate source
    valid_sources = {s.name for s in SourceEnum}
    if source not in valid_sources:
        return {
            "status": "error",
            "reason": f"unknown source {source!r}; valid: {sorted(valid_sources)}",
        }
    source_enum = SourceEnum[source]

    # Resolve game_ids
    if game_ids.strip().lower() == "all":
        resolved = [g.id for g in db.query(Game).filter(Game.is_active == True).all()]  # noqa: E712
    else:
        try:
            resolved = [int(x.strip()) for x in game_ids.split(",") if x.strip()]
        except ValueError:
            return {"status": "error", "reason": "game_ids must be integers or 'all'"}
    if not resolved:
        return {"status": "error", "reason": "no games resolved"}

    # Build the candidate query
    q = db.query(RawPost.id).filter(
        RawPost.source == source_enum,
        RawPost.game_id.in_(resolved),
    )
    if date_from:
        try:
            df = _date.fromisoformat(date_from)
            q = q.filter(RawPost.collected_at >= _dt.combine(df, _time.min))
        except ValueError:
            return {"status": "error", "reason": f"date_from={date_from!r} not ISO date"}
    if date_to:
        try:
            dt_ = _date.fromisoformat(date_to)
            q = q.filter(RawPost.collected_at <= _dt.combine(dt_, _time.max))
        except ValueError:
            return {"status": "error", "reason": f"date_to={date_to!r} not ISO date"}

    candidate_ids = [r[0] for r in q.all()]
    if not candidate_ids:
        return {
            "status": "noop",
            "source": source, "game_ids": resolved,
            "date_from": date_from, "date_to": date_to,
            "sr_deleted": 0, "raw_deleted": 0,
        }

    # Chunked delete (SentimentRecord first for FK safety)
    chunk = 1000
    sr_deleted = 0
    raw_deleted = 0
    for i in range(0, len(candidate_ids), chunk):
        batch = candidate_ids[i:i+chunk]
        sr_deleted += (
            db.query(SentimentRecord)
            .filter(SentimentRecord.raw_post_id.in_(batch))
            .delete(synchronize_session=False)
        )
        db.commit()
    for i in range(0, len(candidate_ids), chunk):
        batch = candidate_ids[i:i+chunk]
        raw_deleted += (
            db.query(RawPost)
            .filter(RawPost.id.in_(batch))
            .delete(synchronize_session=False)
        )
        db.commit()

    logger.info(
        "Scoped purge: source=%s games=%s window=%s..%s sr_deleted=%d raw_deleted=%d",
        source, resolved, date_from, date_to, sr_deleted, raw_deleted,
    )
    return {
        "status": "done",
        "source": source, "game_ids": resolved,
        "date_from": date_from, "date_to": date_to,
        "sr_deleted": sr_deleted,
        "raw_deleted": raw_deleted,
    }


@router.post("/purge/null_date_steamforum", status_code=202)
def purge_null_date_steamforum(db: Session = Depends(get_db)):
    """One-shot purge of legacy Steam Forum RawPost rows with NULL post_date
    (added 2026-07-27). These come from an older scraper version and can't
    be repaired — the post timestamps were never captured. Their
    SentimentRecords have been silenced on the dashboard via the
    effective_date_expr fix, but they still inflate lifetime totals and
    raw_post_total on Settings.

    Deletes SentimentRecords first (FK order), then RawPosts. Idempotent —
    re-run is safe and returns zero counts once complete.
    """
    from models import RawPost, SentimentRecord, SourceEnum  # noqa: PLC0415

    candidate_ids_q = db.query(RawPost.id).filter(
        RawPost.source == SourceEnum.steam_forum,
        RawPost.post_date.is_(None),
    )
    candidate_ids = [r[0] for r in candidate_ids_q.all()]
    if not candidate_ids:
        return {"status": "noop", "sr_deleted": 0, "raw_deleted": 0}

    chunk = 1000
    sr_deleted = 0
    raw_deleted = 0
    for i in range(0, len(candidate_ids), chunk):
        batch = candidate_ids[i:i+chunk]
        sr_deleted += (
            db.query(SentimentRecord)
            .filter(SentimentRecord.raw_post_id.in_(batch))
            .delete(synchronize_session=False)
        )
        db.commit()
    for i in range(0, len(candidate_ids), chunk):
        batch = candidate_ids[i:i+chunk]
        raw_deleted += (
            db.query(RawPost)
            .filter(RawPost.id.in_(batch))
            .delete(synchronize_session=False)
        )
        db.commit()

    logger.info(
        "NULL-date Steam Forum purge: sr_deleted=%d raw_deleted=%d",
        sr_deleted, raw_deleted,
    )
    return {
        "status": "done",
        "sr_deleted": sr_deleted,
        "raw_deleted": raw_deleted,
    }


@router.get("/diag/null_post_dates")
def diag_null_post_dates(
    game_id: int = Query(..., description="Game to inspect"),
    db: Session = Depends(get_db),
):
    """Diagnostic (2026-07-27): count RawPost rows with NULL post_date by
    source, per game. Suspicious single-day volume spikes in the timeseries
    are almost always caused by RawPost.post_date being NULL and the
    dashboard's ``COALESCE(post_date, collected_at)`` bucketing them into
    the ingest date instead of their true post date. This endpoint tells
    us HOW MANY rows are affected and their source distribution so we can
    prioritize fixing the scraper that's returning NULL dates.
    """
    from sqlalchemy import func  # noqa: PLC0415
    from models import RawPost, SentimentRecord  # noqa: PLC0415

    rows = (
        db.query(RawPost.source, func.count(RawPost.id))
        .filter(RawPost.game_id == game_id, RawPost.post_date.is_(None))
        .group_by(RawPost.source)
        .all()
    )
    null_by_source = {r[0].value if hasattr(r[0], 'value') else str(r[0]): r[1] for r in rows}

    # Also compute how many of those NULL-date raw posts have a
    # SentimentRecord attached (i.e. would show up in the dashboard).
    sr_rows = (
        db.query(RawPost.source, func.count(SentimentRecord.id))
        .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
        .filter(RawPost.game_id == game_id, RawPost.post_date.is_(None))
        .group_by(RawPost.source)
        .all()
    )
    sr_null_by_source = {r[0].value if hasattr(r[0], 'value') else str(r[0]): r[1] for r in sr_rows}

    total_raw = db.query(func.count(RawPost.id)).filter(RawPost.game_id == game_id).scalar()
    total_null = sum(null_by_source.values())
    # Sample of NULL-date rows with external_ids + urls so we can
    # distinguish OP posts (external_id = forum_{thread_id}) from
    # comment posts (external_id = forum_{thread_id}_c{comment_id}).
    samples = (
        db.query(RawPost.external_id, RawPost.url, RawPost.collected_at, RawPost.title)
        .filter(RawPost.game_id == game_id, RawPost.post_date.is_(None))
        .limit(10)
        .all()
    )
    null_samples = [
        {
            "external_id": s[0],
            "url": s[1],
            "collected_at": s[2].isoformat() if s[2] else None,
            "title": (s[3] or "")[:80],
            "is_op": s[0].startswith("forum_") and "_c" not in s[0],
        }
        for s in samples
    ]

    # How many NULL rows are OP vs comment?
    op_count = (
        db.query(func.count(RawPost.id))
        .filter(
            RawPost.game_id == game_id,
            RawPost.post_date.is_(None),
            RawPost.source == "steam_forum",
            ~RawPost.external_id.contains("_c"),
        )
        .scalar() or 0
    )
    comment_count = (
        db.query(func.count(RawPost.id))
        .filter(
            RawPost.game_id == game_id,
            RawPost.post_date.is_(None),
            RawPost.source == "steam_forum",
            RawPost.external_id.contains("_c"),
        )
        .scalar() or 0
    )

    # Distribution of NULL-date rows by collected_at date. This tells us
    # which day the dashboard is bucketing them into (COALESCE picks
    # collected_at when post_date is NULL). Concentration on today = a
    # recent bad ingest run; even spread over months = old legacy rows.
    collected_dist_rows = (
        db.query(func.date(RawPost.collected_at).label("d"), func.count(RawPost.id))
        .filter(
            RawPost.game_id == game_id,
            RawPost.post_date.is_(None),
            RawPost.source == "steam_forum",
        )
        .group_by(func.date(RawPost.collected_at))
        .order_by(func.date(RawPost.collected_at).desc())
        .limit(10)
        .all()
    )
    collected_dist = [
        {"collected_date": str(r[0]) if r[0] else None, "count": r[1]}
        for r in collected_dist_rows
    ]

    return {
        "game_id": game_id,
        "total_raw_posts": total_raw,
        "total_null_post_date": total_null,
        "null_pct": round(100 * total_null / total_raw, 2) if total_raw else 0,
        "null_raw_by_source": null_by_source,
        "null_with_sentiment_record_by_source": sr_null_by_source,
        "null_steam_forum_op_count": op_count,
        "null_steam_forum_comment_count": comment_count,
        "null_samples": null_samples,
        "null_by_collected_date_top10": collected_dist,
    }


@router.get("/diag/dtf_test")
def diag_dtf_test(db: Session = Depends(get_db)):
    """Diagnostic (2026-07-26): probe every step of the DTF ingestion path
    to find why the last backfill returned dtf=0 across all four games.

    Steps executed and reported:
      1. Read AppSetting['dtf_enabled'] to confirm the runtime flag.
      2. Import services.dtf_service and call fetch_dtf_posts with the
         same query the ingestor would use for game_id=138 (ILL) — the
         highest-signal case we researched (91 total DTF entries).
      3. Attempt to save one throwaway RawPost row with
         source=SourceEnum.dtf into a nested transaction (rolled back
         immediately) to catch a Postgres enum-value error without
         mutating live data.
      4. Return the full outcome + any exception messages so we can
         see exactly which stage is failing.

    Never touches production data. Read-only apart from the rolled-back
    savepoint in step 3.
    """
    from datetime import datetime, timezone  # noqa: PLC0415
    from models import AppSetting, RawPost, SourceEnum, Game  # noqa: PLC0415

    result: dict = {"stages": {}}

    # Stage 1: flag state.
    row = db.query(AppSetting).filter_by(key="dtf_enabled").first()
    result["stages"]["1_flag"] = {
        "value_in_db": row.value if row else None,
        "env_var": os.getenv("DTF_ENABLED", "(unset)"),
    }

    # Stage 2: service call. Import inside a try so a bad import surfaces here.
    try:
        from services.dtf_service import fetch_dtf_posts  # noqa: PLC0415
        posts = fetch_dtf_posts("ILL Team Clout", game_name="ILL", limit=10)
        result["stages"]["2_service_call"] = {
            "ok": True,
            "posts_returned": len(posts),
            "first_post_preview": (
                {
                    "external_id": posts[0]["external_id"],
                    "title": (posts[0].get("title") or "")[:120],
                    "post_date": posts[0]["post_date"].isoformat(),
                    "url": posts[0].get("url"),
                }
                if posts else None
            ),
        }
    except Exception as exc:
        result["stages"]["2_service_call"] = {"ok": False, "error": repr(exc)}
        return result

    # Stage 3: try inserting one throwaway RawPost. Do it in a nested
    # transaction (SAVEPOINT) so we can roll it back cleanly. This will
    # catch the enum-value error if migration 0013 didn't run.
    ill_game = db.query(Game).filter_by(id=138).first()
    if not ill_game:
        result["stages"]["3_db_insert"] = {"ok": False, "error": "ILL game (id=138) not found"}
        return result
    savepoint = db.begin_nested()
    try:
        test_row = RawPost(
            game_id=ill_game.id,
            source=SourceEnum.dtf,
            external_id=f"dtf:__diag__{datetime.now(tz=timezone.utc).timestamp()}",
            author="__diagnostic__",
            title="__diag__",
            body="",
            url="https://example.invalid/dtf-diag",
            upvotes=0,
            post_date=datetime.now(tz=timezone.utc),
        )
        db.add(test_row)
        db.flush()  # actually push to Postgres, catches enum errors here
        # Immediately roll back the savepoint so we don't pollute the DB.
        savepoint.rollback()
        result["stages"]["3_db_insert"] = {"ok": True, "note": "savepoint rolled back"}
    except Exception as exc:
        savepoint.rollback()
        result["stages"]["3_db_insert"] = {
            "ok": False,
            "error_type": type(exc).__name__,
            "error": repr(exc)[:500],
        }

    # Stage 4: peek at how many raw posts with source=dtf already exist
    # (should be 0 if enum is broken).
    try:
        n = db.query(RawPost).filter(RawPost.source == SourceEnum.dtf).count()
        result["stages"]["4_existing_dtf_rows"] = {"count": n}
    except Exception as exc:
        result["stages"]["4_existing_dtf_rows"] = {"error": repr(exc)[:200]}

    return result


@router.get("/diag/keyword_dryrun")
def diag_keyword_dryrun(
    game_id: int = Query(...),
    sample_size: int = Query(50, ge=10, le=500),
):
    """
    Dry-run the relevance gate against a random sample of the game's
    existing RawPost rows and return how many would be admitted vs
    rejected under the game's CURRENT distinctive_keywords.

    Use this BEFORE running a large backfill for a newly-added title
    to spot bad keyword lists (like a bare 'ILL' or 'SILENT HILL' that
    would let franchise noise through). If admission rate is unusually
    high (>25%) for a low-signal pre-launch title, that's a red flag —
    tighten the keywords first.
    """
    from database import SessionLocal
    from models import Game, RawPost
    from services.post_relevance import is_post_relevant_to_game
    from sqlalchemy.sql.expression import func as sfunc

    db = SessionLocal()
    try:
        game = db.query(Game).filter_by(id=game_id).first()
        if not game:
            return {"error": f"game {game_id} not found"}

        # Random sample of RawPost rows for this game.
        posts = (
            db.query(RawPost)
            .filter(RawPost.game_id == game_id)
            .order_by(sfunc.random())
            .limit(sample_size)
            .all()
        )
        if not posts:
            return {
                "game_id": game_id,
                "game_name": game.name,
                "distinctive_keywords": game.distinctive_keywords,
                "error": "no RawPost rows for this game",
            }

        admitted = []
        rejected = []
        errors_count = 0
        for p in posts:
            try:
                # is_post_relevant_to_game(title, body, game) — not (post, game).
                if is_post_relevant_to_game(p.title or "", p.body or "", game):
                    admitted.append(p)
                else:
                    rejected.append(p)
            except Exception as exc:
                errors_count += 1
                logger.warning("keyword_dryrun: gate exception on post %d: %s", p.id, exc)

        return {
            "game_id": game_id,
            "game_name": game.name,
            "distinctive_keywords": game.distinctive_keywords,
            "sample_size": len(posts),
            "admitted": len(admitted),
            "rejected": len(rejected),
            "errors": errors_count,
            "admission_rate_pct": round(len(admitted) / len(posts) * 100, 2),
            "admitted_samples": [
                {
                    "raw_post_id": p.id,
                    "source": str(p.source),
                    "title": (p.title or "")[:200],
                    "body_preview": (p.body or "")[:200],
                }
                for p in admitted[:15]
            ],
            "rejected_samples": [
                {
                    "raw_post_id": p.id,
                    "source": str(p.source),
                    "title": (p.title or "")[:200],
                }
                for p in rejected[:5]
            ],
        }
    finally:
        db.close()


@router.get("/diag/neutral_audit")
def diag_neutral_audit(
    game_id: Optional[int] = Query(None, description="Optional game filter"),
    source: Optional[str] = Query(None, description="Optional source filter (reddit|bluesky|steam_review|steam_forum|dtf)"),
    days: int = Query(30, ge=1, le=180),
    sample_n: int = Query(10, ge=0, le=50, description="Number of sample neutral posts to return per bucket"),
):
    """Read-only audit of neutral tagging (added 2026-07-29).

    Answers three questions:
      1. What % of tagged-neutral posts had an original_label of positive/negative
         BEFORE the 0.70 confidence floor demoted them?
      2. What's the distribution of signal_quality on tagged-neutral posts?
      3. Sample bodies of the largest bucket so we can eyeball whether the
         demotion was warranted.

    This is the data needed to decide whether the 0.70 floor is too aggressive.
    Nothing is written; safe to call anytime.
    """
    from datetime import date as _date, timedelta as _td
    from database import SessionLocal
    from models import Game, RawPost, SentimentRecord, SourceEnum
    from sqlalchemy import func as sfunc

    since = _date.today() - _td(days=days)
    db = SessionLocal()
    try:
        q = (
            db.query(SentimentRecord, RawPost)
            .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
            .filter(sfunc.date(SentimentRecord.created_at) >= since)
        )
        if game_id is not None:
            q = q.filter(RawPost.game_id == game_id)
        if source is not None:
            try:
                q = q.filter(RawPost.source == SourceEnum[source])
            except KeyError:
                return {"status": "error", "reason": f"unknown source {source!r}"}

        rows = q.limit(50000).all()  # cap to keep response bounded
        total = len(rows)
        if total == 0:
            return {"status": "empty", "window_days": days, "total": 0}

        # Overall label distribution
        label_counts = {"positive": 0, "negative": 0, "neutral": 0}
        # Neutral breakdown by original_label
        neutral_by_original = {"positive": 0, "negative": 0, "neutral": 0, "none": 0}
        # Signal quality distribution across ALL rows (for reference)
        signal_dist = {"low": 0, "medium": 0, "high": 0, "unknown": 0}
        # For neutrals only
        neutral_signal = {"low": 0, "medium": 0, "high": 0, "unknown": 0}
        # Language distribution on neutrals (non-English is a big neutral driver)
        neutral_lang = {}

        # Collect samples for the 3 biggest neutral buckets:
        #   bucket A: was originally positive, demoted
        #   bucket B: was originally negative, demoted
        #   bucket C: genuinely neutral (never had a non-neutral label)
        samples_orig_pos = []
        samples_orig_neg = []
        samples_true_neutral = []

        for sr, rp in rows:
            lbl = sr.label or "neutral"
            label_counts[lbl] = label_counts.get(lbl, 0) + 1
            sq = sr.signal_quality or "unknown"
            signal_dist[sq] = signal_dist.get(sq, 0) + 1

            if lbl == "neutral":
                neutral_signal[sq] = neutral_signal.get(sq, 0) + 1
                orig = sr.original_label
                if orig == "positive":
                    neutral_by_original["positive"] += 1
                    if len(samples_orig_pos) < sample_n:
                        samples_orig_pos.append({
                            "post_id": rp.id,
                            "source": str(rp.source).replace("SourceEnum.", ""),
                            "signal_quality": sq,
                            "title": (rp.title or "")[:200],
                            "body": (rp.body or "")[:400],
                        })
                elif orig == "negative":
                    neutral_by_original["negative"] += 1
                    if len(samples_orig_neg) < sample_n:
                        samples_orig_neg.append({
                            "post_id": rp.id,
                            "source": str(rp.source).replace("SourceEnum.", ""),
                            "signal_quality": sq,
                            "title": (rp.title or "")[:200],
                            "body": (rp.body or "")[:400],
                        })
                elif orig is None:
                    neutral_by_original["none"] += 1
                    if len(samples_true_neutral) < sample_n:
                        samples_true_neutral.append({
                            "post_id": rp.id,
                            "source": str(rp.source).replace("SourceEnum.", ""),
                            "signal_quality": sq,
                            "title": (rp.title or "")[:200],
                            "body": (rp.body or "")[:400],
                        })
                else:
                    neutral_by_original[orig] = neutral_by_original.get(orig, 0) + 1

                lang = sr.language or "unknown"
                neutral_lang[lang] = neutral_lang.get(lang, 0) + 1

        # Percentages for easy reading
        def pct(n, d): return round(100.0 * n / d, 1) if d else 0.0

        neutral_total = label_counts["neutral"]
        return {
            "status": "ok",
            "window_days": days,
            "game_id_filter": game_id,
            "source_filter": source,
            "total_records": total,
            "label_pct": {k: pct(v, total) for k, v in label_counts.items()},
            "label_counts": label_counts,
            "signal_quality_all_pct": {k: pct(v, total) for k, v in signal_dist.items()},
            "neutral_breakdown": {
                "total_neutral": neutral_total,
                "by_original_label_pct": {
                    k: pct(v, neutral_total) for k, v in neutral_by_original.items()
                },
                "by_original_label_counts": neutral_by_original,
                "signal_quality_pct": {
                    k: pct(v, neutral_total) for k, v in neutral_signal.items()
                },
                "language_top5": dict(
                    sorted(neutral_lang.items(), key=lambda x: -x[1])[:5]
                ),
            },
            "samples": {
                "was_originally_positive_but_demoted": samples_orig_pos,
                "was_originally_negative_but_demoted": samples_orig_neg,
                "genuinely_neutral_never_had_signal": samples_true_neutral,
            },
        }
    finally:
        db.close()


@router.get("/diag/game_records")
def diag_game_records(
    game_id: int = Query(...),
    limit: int = Query(20, ge=1, le=100),
):
    """
    Read-only diagnostic: for a given game, return counts and a sample of
    RawPost rows, SentimentRecord rows, and the game's distinctive_keywords.
    Used to audit whether the relevance gate is admitting/rejecting posts
    correctly.
    """
    from database import SessionLocal
    from models import Game, RawPost, SentimentRecord
    from sqlalchemy import func as sfunc

    db = SessionLocal()
    try:
        game = db.query(Game).filter_by(id=game_id).first()
        if not game:
            return {"error": f"game {game_id} not found"}

        raw_total = db.query(sfunc.count(RawPost.id)).filter(RawPost.game_id == game_id).scalar() or 0
        raw_by_source = dict(
            db.query(RawPost.source, sfunc.count(RawPost.id))
            .filter(RawPost.game_id == game_id)
            .group_by(RawPost.source)
            .all()
        )
        # SentimentRecord has no game_id column — join through RawPost.
        sr_total = (
            db.query(sfunc.count(SentimentRecord.id))
            .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
            .filter(RawPost.game_id == game_id)
            .scalar() or 0
        )

        sample_raw = (
            db.query(RawPost)
            .filter(RawPost.game_id == game_id)
            .order_by(RawPost.post_date.desc())
            .limit(limit)
            .all()
        )
        sample_sr = (
            db.query(SentimentRecord, RawPost)
            .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
            .filter(RawPost.game_id == game_id)
            .order_by(RawPost.post_date.desc())
            .limit(limit)
            .all()
        )

        return {
            "game_id": game.id,
            "game_name": game.name,
            "distinctive_keywords": game.distinctive_keywords,
            "raw_post_total": raw_total,
            "raw_by_source": {str(k): v for k, v in raw_by_source.items()},
            "sentiment_record_total": sr_total,
            "gate_admission_rate": round((sr_total / raw_total * 100) if raw_total else 0.0, 2),
            "sample_raw_posts": [
                {
                    "id": r.id,
                    "source": str(r.source),
                    "post_date": r.post_date.isoformat() if r.post_date else None,
                    "title": (r.title or "")[:200],
                    "body": (r.body or "")[:400],
                    "url": r.url,
                }
                for r in sample_raw
            ],
            "sample_sentiment_records": [
                {
                    "sr_id": sr.id,
                    "raw_post_id": rp.id,
                    "source": str(rp.source),
                    "post_date": rp.post_date.isoformat() if rp.post_date else None,
                    "sentiment": sr.sentiment,
                    "title": (rp.title or "")[:200],
                    "body": (rp.body or "")[:400],
                    "url": rp.url,
                }
                for sr, rp in sample_sr
            ],
        }
    finally:
        db.close()


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


# ── Sentiment record topics probe ────────────────────────────────

@router.get("/diag/sr_topics")
def diag_sr_topics(
    game_id: int = Query(..., description="Game id to inspect."),
    days: int = Query(7, ge=1, le=90, description="Look back N days."),
):
    """Report SentimentRecord.topics population for a game in the last N days.

    Diagnoses why the period-summary aggregator returns top_*_topics=[]
    when DailySummary.top_*_topics is populated.
    """
    from datetime import date, datetime as _dt, timedelta
    from sqlalchemy import func
    from models import RawPost, SentimentRecord, Game
    from database import SessionLocal

    db = SessionLocal()
    try:
        game = db.query(Game).filter(Game.id == game_id).first()
        if not game:
            return {"error": f"no game with id={game_id}"}

        window_end = date.today()
        window_start = window_end - timedelta(days=days - 1)
        start_dt = _dt.combine(window_start, _dt.min.time())
        end_dt = _dt.combine(window_end, _dt.max.time())
        effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)

        rows = (
            db.query(SentimentRecord.id, SentimentRecord.sentiment,
                     SentimentRecord.topics, RawPost.id,
                     effective_date.label("eff_date"))
            .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
            .filter(
                RawPost.game_id == game_id,
                effective_date >= start_dt,
                effective_date <= end_dt,
            )
            .all()
        )

        total = len(rows)
        with_topics = sum(1 for r in rows if r[2])
        empty_list = sum(1 for r in rows if r[2] == [])
        null_topics = sum(1 for r in rows if r[2] is None)

        # Sample some with topics + some without
        with_sample = [r for r in rows if r[2]][:5]
        without_sample = [r for r in rows if not r[2]][:5]

        return {
            "game_id": game_id,
            "game_name": game.name,
            "window_start": str(window_start),
            "window_end": str(window_end),
            "total_sentiment_records": total,
            "with_topics_populated": with_topics,
            "empty_list": empty_list,
            "null": null_topics,
            "sample_with_topics": [
                {"sr_id": r[0], "sentiment": r[1].value if r[1] else None,
                 "topics": r[2], "eff_date": str(r[4])}
                for r in with_sample
            ],
            "sample_without_topics": [
                {"sr_id": r[0], "sentiment": r[1].value if r[1] else None,
                 "topics_repr": repr(r[2]), "eff_date": str(r[4])}
                for r in without_sample
            ],
        }
    finally:
        db.close()


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


# ── Weekly smoke test diag (Gap 1) ────────────────────────────────────────────

@router.get("/diag/smoke_test")
def diag_smoke_test():
    """Return the most recent weekly source smoke test results.

    Reads `services.source_smoke_test._smoke_status` so the frontend can
    surface upstream-API regressions before they zero-out a cron run.
    """
    from services.source_smoke_test import get_smoke_status
    return get_smoke_status()


@router.post("/diag/smoke_test/run")
def diag_smoke_test_run():
    """Manually trigger the weekly smoke test (for ops / on-demand QA).

    Synchronous — the smoke test is fast (~10s) so we don't background it.
    """
    from services.source_smoke_test import run_smoke_test
    return run_smoke_test()
