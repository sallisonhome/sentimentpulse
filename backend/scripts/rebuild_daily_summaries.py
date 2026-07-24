"""
One-time cleanup (2026-07-24) — rebuilds DailySummary rows for every
active game across the July 2026 window, straight from current
SentimentRecord state.

Background: the dashboard reads sentiment KPIs by summing DailySummary
rows. The Summary page's window-summary reads directly from
SentimentRecord. Because the July purge + recovery + overmatch cleanup
never regenerated DailySummary for most games, the dashboard's 7d KPI
is showing pre-purge inflated numbers (e.g. SM2 dashboard=1,185 total
vs. Summary page=778 total for the same 7d window).

This script:
  For each of the 29 active games, for each day in [2026-07-01 .. today]:
    1. Aggregate SentimentRecord counts by sentiment (pos/neg/neu) from
       the CURRENT state of the table
    2. UPSERT a DailySummary row for that (game, date) with those counts
    3. Zero-post days get a DailySummary row with 0/0/0 counts (so the
       'zero-new-records path' in Step 7 has a base to build from,
       instead of carrying forward stale ghost topics)

Topic fields (top_positive_topics, top_negative_topics, top_neutral_topics,
executive_summary, recommended_actions) are LEFT EMPTY on backfilled
rows — they'll get populated by the next Step 6/7 run for today. This
is a deliberate trade: correct counts today, correct AI narrative
tomorrow after the next ingestion tick populates topics against clean
data.

Idempotent: safe to re-run. Guarded by AppSetting
sentiment_july_daily_rebuild_done_at.
"""
import logging
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlalchemy import func

sys.path.insert(0, str(Path(__file__).parent.parent))

from database import SessionLocal  # noqa: E402
from models import (  # noqa: E402
    Game,
    DailySummary,
    RawPost,
    SentimentRecord,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

JULY_START = date(2026, 7, 1)


def rebuild_for_game(db, game: Game, start_date: date, end_date: date) -> tuple[int, int]:
    """
    Rebuild DailySummary rows for one game across [start_date .. end_date].
    Returns (rows_written, days_with_posts).
    """
    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)
    day_expr = func.date(effective_date).label("d")

    # Aggregate current SentimentRecord counts per day per sentiment for this game.
    rows = (
        db.query(
            day_expr,
            SentimentRecord.sentiment,
            func.count(SentimentRecord.id),
        )
        .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
        .filter(
            RawPost.game_id == game.id,
            effective_date >= datetime.combine(start_date, datetime.min.time()),
            effective_date <= datetime.combine(end_date, datetime.max.time()),
        )
        .group_by(day_expr, SentimentRecord.sentiment)
        .all()
    )

    # Build a {date: {sentiment: count}} map.
    per_day: dict[date, dict[str, int]] = {}
    for day_str, sentiment_enum, cnt in rows:
        # SQLAlchemy returns the date() function output as a string in SQLite.
        d = day_str if isinstance(day_str, date) else datetime.strptime(day_str, "%Y-%m-%d").date()
        per_day.setdefault(d, {})[sentiment_enum.value] = int(cnt)

    # Delete existing DailySummary rows in the window for this game — we're
    # rebuilding from scratch. Otherwise the UPSERT logic would need to
    # merge, and we prefer a clean rebuild here.
    db.query(DailySummary).filter(
        DailySummary.game_id == game.id,
        DailySummary.summary_date >= start_date,
        DailySummary.summary_date <= end_date,
    ).delete(synchronize_session=False)

    # Iterate every day in the window (including zero-post days) and
    # INSERT a fresh row. Zero-post days still get a row with 0/0/0
    # counts so the Step 7 "zero-new-records path" has a base to
    # build from instead of carrying forward stale ghost topics.
    rows_written = 0
    days_with_posts = 0
    cur = start_date
    while cur <= end_date:
        counts = per_day.get(cur, {})
        pos = counts.get("positive", 0)
        neg = counts.get("negative", 0)
        neu = counts.get("neutral", 0)
        total = pos + neg + neu

        db.add(DailySummary(
            game_id=game.id,
            summary_date=cur,
            positive_count=pos,
            negative_count=neg,
            neutral_count=neu,
            top_positive_topics=[],
            top_negative_topics=[],
            top_neutral_topics=[],
            sentiment_trend_delta=None,
            executive_summary="",
            recommended_actions="",
        ))
        rows_written += 1
        if total > 0:
            days_with_posts += 1
        cur += timedelta(days=1)

    return rows_written, days_with_posts


def main() -> int:
    db = SessionLocal()
    try:
        today = date.today()
        active_games = db.query(Game).filter(Game.is_active == True).all()  # noqa: E712
        logger.info(
            "rebuild_daily_summaries: %d active games across [%s .. %s]",
            len(active_games), JULY_START, today,
        )

        total_rows = 0
        for game in active_games:
            try:
                rows, days = rebuild_for_game(db, game, JULY_START, today)
                logger.info(
                    "  #%s '%s': %d DailySummary rows rebuilt (%d days had posts)",
                    game.id, game.name, rows, days,
                )
                total_rows += rows
                db.commit()
            except Exception:
                logger.exception("  #%s '%s': FAILED", game.id, game.name)
                db.rollback()

        logger.info("rebuild_daily_summaries complete: %d rows total", total_rows)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
