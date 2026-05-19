"""
Backfill script — generates MonthlySummary rows for historical months that
actually contain posts.

Usage:
    cd backend
    python backfill_monthly_summaries.py                 # default: last 24 months
    python backfill_monthly_summaries.py --max-months-back 36
    python backfill_monthly_summaries.py --dry-run

For each active game the script:
  1. Determines the earliest post date and the most recent FULL completed month.
  2. Floors the start month to `today - max_months_back` to avoid runaway loops
     when raw_posts contains bogus epoch/NULL-coerced dates (e.g. 1900-01).
  3. For each (year, month) in that range it counts posts whose effective date
     (coalesce post_date, collected_at) falls inside the month. Months with
     zero posts are SKIPPED — no Claude API calls are made.
  4. Skips months that already have a MonthlySummary row.
  5. Generates and saves a summary via period_summary_service.

A "completed" month is any calendar month whose last day has already passed
(i.e. the current month in progress is skipped).
"""
import argparse
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


def _floor_start(earliest: date, today: date, max_months_back: int) -> date:
    """Clamp earliest to at most `max_months_back` months before today.

    Guards against runaway loops from bogus epoch/NULL-coerced post dates
    (e.g. 1900-01-01 in raw_posts). The floor is computed as the first day
    of the month that is `max_months_back` months before today's month.
    """
    # Compute floor year/month
    total_months = today.year * 12 + (today.month - 1) - max_months_back
    floor_year, floor_month = divmod(total_months, 12)
    floor_month += 1  # divmod gives 0-indexed month
    floor_date = date(floor_year, floor_month, 1)
    return max(earliest, floor_date)


def backfill(dry_run: bool = False, max_months_back: int = 24) -> None:
    db = SessionLocal()
    try:
        active_games = db.query(Game).filter_by(is_active=True).all()
        if not active_games:
            logger.info("No active games found — nothing to backfill.")
            return

        logger.info(
            "Backfill starting for %d active game(s). max_months_back=%d",
            len(active_games), max_months_back
        )

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
        total_skipped_existing = 0
        total_skipped_empty    = 0
        total_errors    = 0

        effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)

        for game in active_games:
            logger.info("Processing game: %s (id=%d)", game.name, game.id)

            # Find earliest post date for this game
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

            # Floor earliest to protect against bogus historical dates
            floored = _floor_start(earliest, today, max_months_back)
            if floored != earliest:
                logger.info(
                    "  Earliest post date (%s) floored to %s (max_months_back=%d).",
                    earliest, floored, max_months_back
                )
            earliest = floored

            game_generated       = 0
            game_skipped_existing = 0
            game_skipped_empty    = 0
            game_errors          = 0

            for year, month in _month_range(earliest, last_full_end):
                # Check if already exists
                existing = (
                    db.query(MonthlySummary)
                    .filter_by(game_id=game.id, period_year=year, period_month=month)
                    .first()
                )
                if existing:
                    game_skipped_existing += 1
                    continue

                # Count posts that actually fall inside this month — if zero,
                # skip without making any Claude calls.
                month_start = date(year, month, 1)
                month_end   = _last_day_of_month(year, month)
                post_count = (
                    db.query(func.count(RawPost.id))
                    .filter(
                        RawPost.game_id == game.id,
                        effective_date >= month_start,
                        effective_date <= datetime.combine(month_end, datetime.max.time()),
                    )
                    .scalar()
                ) or 0

                if post_count == 0:
                    game_skipped_empty += 1
                    continue

                if dry_run:
                    logger.info(
                        "  [DRY RUN] Would generate: %04d-%02d (%d posts)",
                        year, month, post_count
                    )
                    game_generated += 1
                    continue

                try:
                    _pss.generate_monthly_summary(db, game.id, year, month)
                    logger.info("  Generated: %04d-%02d (%d posts)", year, month, post_count)
                    game_generated += 1
                except Exception as exc:
                    logger.error(
                        "  ERROR generating %04d-%02d for %s: %s",
                        year, month, game.name, exc
                    )
                    game_errors += 1

            logger.info(
                "  %s: generated=%d  skipped_existing=%d  skipped_empty=%d  errors=%d",
                game.name, game_generated, game_skipped_existing,
                game_skipped_empty, game_errors
            )
            total_generated        += game_generated
            total_skipped_existing += game_skipped_existing
            total_skipped_empty    += game_skipped_empty
            total_errors           += game_errors

        logger.info(
            "Backfill complete — generated=%d  skipped_existing=%d  skipped_empty=%d  errors=%d",
            total_generated, total_skipped_existing, total_skipped_empty, total_errors
        )

    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill MonthlySummary rows.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log what would be generated without calling Claude or writing rows.",
    )
    parser.add_argument(
        "--max-months-back",
        type=int,
        default=24,
        help="Cap how far back to look from today (default: 24 months). Guards "
             "against bogus epoch/NULL-coerced post dates.",
    )
    args = parser.parse_args()

    if args.dry_run:
        logger.info("=== DRY RUN mode — no data will be written ===")
    backfill(dry_run=args.dry_run, max_months_back=args.max_months_back)
