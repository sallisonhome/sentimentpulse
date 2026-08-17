"""
Shared post-add onboarding for newly-created games (both Saber titles
created via POST /api/games and competitor titles created via
POST /api/games/{parent_id}/competitors, plus auto-onboarded games
from the portfolio scanner).

v1 (2026-07-25): every newly-added game with a Steam AppID gets a
90-day Steam FORUM backfill so the dashboards for that title start
populated instead of showing 90 days of empty bars.

v2 (2026-08-17): fixed a silent completeness bug and hardened the
orchestrator against permanent stuck-in-flight state.
  • Steam REVIEWS now backfill alongside Forums (previously omitted,
    which meant every child/competitor title ever added has zero Steam
    review data — verified against WWZ 148 and Insurgency 147 which
    were onboarded 2026-08-17 and had 0 forum + 0 review rows despite
    live scrapes returning 84 forum posts and 500 reviews each).
  • The in-flight guard now uses a bounded timeout: if a game has been
    in the set for longer than the max onboarding budget, a fresh call
    is allowed through. Previously a crashed thread (from a deploy, OOM,
    or uncaught exception) would leave the game permanently 'stuck' in
    the set and every future onboarding attempt was silently a no-op.

Runs in a background daemon thread so the caller's POST returns
immediately.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

# In-process guard: don't spawn a second backfill for the same game while
# one is still running. Cheap best-effort, not persisted; if the process
# restarts, worst case is a redundant scrape (still idempotent because
# _bulk_save_posts dedupes on external_id).
#
# v2 (2026-08-17): stores a timestamp instead of a bare int. A crashed
# thread that never runs its `finally` clause used to leave the game
# stuck forever. Now we time-bound the guard to MAX_ONBOARDING_SECS —
# after that, a new call is allowed even if the entry is still there.
_ONBOARDING_INFLIGHT: dict[int, float] = {}
_LOCK = threading.Lock()

DEFAULT_DAYS_BACK = 90

# Onboarding across Forums + Reviews takes ~5-15 min per game (the
# 15-minute forum wallclock budget dominates). Set the guard TTL to
# 30 minutes so we allow a retry after that even if the previous
# attempt vanished silently.
MAX_ONBOARDING_SECS = 30 * 60


def _run_onboarding_backfill(game_id: int, days_back: int) -> None:
    """Body of the background thread; imports inside for module-load speed."""
    # Everything that could fail is caught so a bad onboarding never
    # crashes the process. Recorded as WARN so it shows in the standard
    # log stream without pretending nothing happened.
    try:
        from database import SessionLocal
        from models import Game
        from scripts.historical_backfill import (
            backfill_steam_forums_for_game,
            backfill_steam_reviews_for_game,
        )
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

            # Steam Forum backfill (v1, 2026-07-25).
            forum_saved = backfill_steam_forums_for_game(db, game, start_dt, errors)
            db.commit()

            # Steam Reviews backfill (v2, 2026-08-17). Same window and
            # error accumulator as Forums so Sentiment/Topics/Summary
            # steps below classify everything at once. Prior versions of
            # this function omitted Reviews entirely — every newly-added
            # game since v1 shipped has been missing all Steam review
            # data until either the daily cron picked it up (which does
            # NOT backfill history — it only fetches "recent" reviews on
            # each run) or an admin manually kicked the all-active
            # backfill job. See router /api/games/{id}/reonboard for
            # the on-demand recovery path.
            review_saved = backfill_steam_reviews_for_game(db, game, start_dt, errors)
            db.commit()

            # Reclassify + resummarize the newly-arrived posts so the
            # dashboard doesn't render "0 sentiment classified" bars over
            # populated raw-post rows.
            log_lines: list[str] = []
            step_errors: list[str] = []
            _step5_classify_sentiment(db, game, log_lines, step_errors)
            _step6_extract_topics(db, game, log_lines, step_errors)
            _step7_daily_summary(db, game, log_lines, step_errors)
            db.commit()

            logger.info(
                "Onboarding backfill DONE for game_id=%d %r: "
                "steam_forums_saved=%d steam_reviews_saved=%d "
                "fetch_errors=%d step_errors=%d",
                game_id, game.name, forum_saved, review_saved,
                len(errors), len(step_errors),
            )
        finally:
            db.close()
    except Exception as exc:
        logger.exception("Onboarding backfill CRASHED for game_id=%d: %s", game_id, exc)
    finally:
        with _LOCK:
            _ONBOARDING_INFLIGHT.pop(game_id, None)


def schedule_onboarding_backfill(game_id: int, days_back: int = DEFAULT_DAYS_BACK) -> bool:
    """
    Kick off a background 90-day Steam Forum + Steam Reviews backfill for
    the given game. Returns True if scheduled, False if a run is already
    in flight for this game_id.

    Runs in a plain daemon thread rather than FastAPI's BackgroundTasks
    so the caller doesn't need to inject BackgroundTasks — competitors
    router, games router, and portfolio-scan router all call this from
    within their POST handlers and can just fire-and-forget.

    v2 (2026-08-17): guard entries are time-bounded — after
    MAX_ONBOARDING_SECS a stale entry is treated as absent and a new
    thread is spawned. Prevents a permanently-stuck game when a previous
    thread died without hitting its finally clause (e.g. deploy killed
    the process mid-scrape).
    """
    now = time.time()
    with _LOCK:
        existing_started_at = _ONBOARDING_INFLIGHT.get(game_id)
        if existing_started_at is not None:
            age = now - existing_started_at
            if age < MAX_ONBOARDING_SECS:
                logger.info(
                    "Onboarding backfill for game_id=%d already in flight "
                    "(started %.0fs ago); skipping",
                    game_id, age,
                )
                return False
            # Stale entry: previous thread likely died. Reclaim.
            logger.warning(
                "Onboarding backfill for game_id=%d had a stale in-flight entry "
                "(started %.0fs ago, > %ds budget) — assuming previous thread died "
                "and re-scheduling.",
                game_id, age, MAX_ONBOARDING_SECS,
            )
        _ONBOARDING_INFLIGHT[game_id] = now

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
