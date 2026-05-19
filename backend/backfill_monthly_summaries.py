"""
Backfill script — generates MonthlySummary rows for all historical months.

Usage:
    cd backend
    python backfill_monthly_summaries.py

For each active game the script:
  1. Finds the earliest post date and the most recent FULL completed month.
  2. Iterates every (year, month) in that range.
  3. Skips months that already have a MonthlySummary row.
  4. Generates and saves a summary via period_summary_service.

A "completed" month is any calendar month whose last day has already passed
(i.e. the current month in progress is skipped).
"""
import logging
import sys
from calendar import monthrange
from datetime import date, datetime
from pathlib import Path

# Add backend directory to sys.path so absolute imports work when run directly
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy import func

from database import SessionLocal
from models import Game, MonthlySummary, RawPost
from services import period_summary_service as _pss

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


def _month_range(start_date: date, end_date: date):
    """Yield (year, month) tuples from start_date's month through end_date's month."""
    year, month = start_date.year, start_date.month
    while (year, month) <= (end_date.year, end_date.month):
        yield year, month
        month += 1
        if month > 12:
            month = 1
            year += 1


def _last_day_of_month(year: int, month: int) -> date:
    _, last = monthrange(year, month)
    return date(year, month, last)


def backfill(dry_run: bool = False) -> None:
    db = SessionLocal()
    try:
        active_games = db.query(Game).filter_by(is_active=True).all()
        if not active_games:
            logger.info("No active games found — nothing to backfill.")
            return

        logger.info("Backfill starting for %d active game(s).", len(active_games))

        today = date.today()
        # The most recent completed month is last month relative to today
        if today.month == 1:
            last_full_year  = today.year - 1
            last_full_month = 12
        else:
            last_full_year  = today.year
            last_full_month = today.month - 1

        last_full_end = _last_day_of_month(last_full_year, last_full_month)

        total_generated = 0
        total_skipped   = 0
        total_errors    = 0

        for game in active_games:
            logger.info("Processing game: %s (id=%d)", game.name, game.id)

            # Find earliest post date for this game
            effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)
            earliest_dt = (
                db.query(func.min(effective_date))
                .filter(RawPost.game_id == game.id)
                .scalar()
            )

            if earliest_dt is None:
                logger.info("  No posts found for %s — skipping.", game.name)
                continue

            if isinstance(earliest_dt, datetime):
                earliest = earliest_dt.date()
            elif isinstance(earliest_dt, date):
                earliest = earliest_dt
            else:
                logger.warning("  Unexpected type for earliest date: %s", type(earliest_dt))
                continue

            if earliest > last_full_end:
                logger.info(
                    "  Earliest post (%s) is after last full month end (%s) — skipping.",
                    earliest, last_full_end
                )
                continue

            game_generated = 0
            game_skipped   = 0
            game_errors    = 0

            for year, month in _month_range(earliest, last_full_end):
                # Check if already exists
                existing = (
                    db.query(MonthlySummary)
                    .filter_by(game_id=game.id, period_year=year, period_month=month)
                    .first()
                )
                if existing:
                    game_skipped += 1
                    continue

                if dry_run:
                    logger.info("  [DRY RUN] Would generate: %04d-%02d", year, month)
                    game_generated += 1
                    continue

                try:
                    _pss.generate_monthly_summary(db, game.id, year, month)
                    logger.info("  Generated: %04d-%02d", year, month)
                    game_generated += 1
                except Exception as exc:
                    logger.error(
                        "  ERROR generating %04d-%02d for %s: %s",
                        year, month, game.name, exc
                    )
                    game_errors += 1

            logger.info(
                "  %s: generated=%d  skipped=%d  errors=%d",
                game.name, game_generated, game_skipped, game_errors
            )
            total_generated += game_generated
            total_skipped   += game_skipped
            total_errors    += game_errors

        logger.info(
            "Backfill complete — total generated=%d  skipped=%d  errors=%d",
            total_generated, total_skipped, total_errors
        )

    finally:
        db.close()


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    if dry:
        logger.info("=== DRY RUN mode — no data will be written ===")
    backfill(dry_run=dry)
