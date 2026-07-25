"""
Shared post-add onboarding for newly-created games (both Saber titles
created via POST /api/games and competitor titles created via
POST /api/games/{parent_id}/competitors).

The 2026-07-25 rule: EVERY newly-added game with a Steam AppID should
automatically get a 90-day Steam Forum backfill so the dashboards for
that title start populated instead of showing 90 days of empty bars
until the daily cron slowly fills in.

Runs in the background so the POST returns immediately.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

# In-process guard: don't spawn a second backfill for the same game while
# one is still running. Cheap best-effort, not persisted; if the process
# restarts, worst case is a redundant scrape (still idempotent).
_ONBOARDING_INFLIGHT: set[int] = set()
_LOCK = threading.Lock()

DEFAULT_DAYS_BACK = 90


def _run_onboarding_backfill(game_id: int, days_back: int) -> None:
    """Body of the background thread; imports inside for module-load speed."""
    # Everything that could fail is caught so a bad onboarding never
    # crashes the process. Recorded as WARN so it shows in the standard
    # log stream without pretending nothing happened.
    try:
        from database import SessionLocal
        from models import Game
        from scripts.historical_backfill import backfill_steam_forums_for_game
        from services.ingestor import (
            _step5_classify_sentiment,
            _step6_extract_topics,
            _step7_daily_summary,
        )
        from services.nlp_service import load_model

        load_model()
        db = SessionLocal()
        try:
            game = db.query(Game).filter_by(id=game_id).first()
            if not game:
                logger.warning("Onboarding backfill: game_id=%d not found", game_id)
                return
            if not game.steam_app_id:
                logger.info(
                    "Onboarding backfill: game_id=%d %r has no steam_app_id; skipping",
                    game_id, game.name,
                )
                return

            start_dt = datetime.now(tz=timezone.utc) - timedelta(days=days_back)
            errors: list[str] = []
            saved = backfill_steam_forums_for_game(db, game, start_dt, errors)
            db.commit()

            log_lines: list[str] = []
            step_errors: list[str] = []
            _step5_classify_sentiment(db, game, log_lines, step_errors)
            _step6_extract_topics(db, game, log_lines, step_errors)
            _step7_daily_summary(db, game, log_lines, step_errors)
            db.commit()

            logger.info(
                "Onboarding backfill DONE for game_id=%d %r: "
                "steam_forums_saved=%d fetch_errors=%d step_errors=%d",
                game_id, game.name, saved, len(errors), len(step_errors),
            )
        finally:
            db.close()
    except Exception as exc:
        logger.exception("Onboarding backfill CRASHED for game_id=%d: %s", game_id, exc)
    finally:
        with _LOCK:
            _ONBOARDING_INFLIGHT.discard(game_id)


def schedule_onboarding_backfill(game_id: int, days_back: int = DEFAULT_DAYS_BACK) -> bool:
    """
    Kick off a background 90-day Steam Forum backfill for the given game.
    Returns True if scheduled, False if a run is already in flight for
    this game_id.

    Runs in a plain daemon thread rather than FastAPI's BackgroundTasks
    so the caller doesn't need to inject BackgroundTasks — competitors
    router and games router both call this from within their POST
    handlers and can just fire-and-forget.
    """
    with _LOCK:
        if game_id in _ONBOARDING_INFLIGHT:
            logger.info(
                "Onboarding backfill for game_id=%d already in flight; skipping",
                game_id,
            )
            return False
        _ONBOARDING_INFLIGHT.add(game_id)

    t = threading.Thread(
        target=_run_onboarding_backfill,
        args=(game_id, days_back),
        name=f"onboarding-backfill-{game_id}",
        daemon=True,
    )
    t.start()
    logger.info(
        "Scheduled onboarding backfill for game_id=%d (days_back=%d) in background thread",
        game_id, days_back,
    )
    return True
