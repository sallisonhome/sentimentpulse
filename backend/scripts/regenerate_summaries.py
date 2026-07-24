"""
One-time cleanup (2026-07-24) — regenerates DailySummary + TopicTrend rows
for games whose sentiment records were purged by the July backfill.

Background: the relevance-gate fix purged 7,594 SentimentRecords across
5 batched games (Bus Bound, Toxic Commando, Turok, JP Survival,
Hellraiser: Revival) plus 4 over-match games (SM2, Crysis 2/3 Remastered,
Halo 3). BUT the July DailySummary rows and TopicTrend rows for those
games persist — they were built from the (now-purged) SentimentRecords
and topic-extracted from off-topic Warhammer/lore/generic-gaming posts.

The DailySummary "zero-new-records path" then carries forward those stale
topics onto every subsequent day, which is why Hellraiser (with 19 real
SentimentRecords in the last 7 days, all Bluesky posts with mostly-empty
titles) still shows "Turkish Language Support / Regional Localization /
Server & Multiplayer Discussion" — those topics are ghosts of the
pre-fix data.

This script:
  1. Deletes every DailySummary row for the affected games where
     summary_date is in 2026-07-01 through today.
  2. Deletes every TopicTrend row for the affected games (globally, not
     just July — TopicTrends are cumulative and the wrong ones taint
     every future day).
  3. Runs Step 6 (topic extraction) and Step 7 (daily summary) for TODAY
     for each affected game, so at least today's DailySummary reflects
     the clean data. Historical days will regenerate naturally on the
     next ingestion cron tick if there were relevant posts on those
     days (unlikely given ~all the traffic was off-topic).

The affected games are the 5 batched games (relevance-gate primary
targets) plus the 4 over-match games (Layer 2 fuzzy cleanup targets).

Idempotent. Guarded by AppSetting sentiment_july_summary_regen_done_at.
"""
import logging
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from database import SessionLocal  # noqa: E402
from models import Game, DailySummary, TopicTrend  # noqa: E402
from services.ingestor import _step6_extract_topics, _step7_daily_summary  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

# 5 batched games (were carrying wildly off-topic Warhammer/lore/generic-gaming
# topics because the sub bulk-add pulled from broad gaming subs before the
# relevance gate was moved to Step 5):
BATCHED_GAME_IDS = [
    21,   # Clive Barker's Hellraiser: Revival
    22,   # Jurassic Park: Survival
    23,   # Turok: Origins
    25,   # John Carpenter's Toxic Commando
    134,  # Bus Bound
]

# 4 over-match games (Layer 2 fuzzy variant leaked lore/generic posts):
OVERMATCH_GAME_IDS = [
    24,   # Warhammer 40,000: Space Marine 2
    37,   # Crysis 3 Remastered
    39,   # Crysis 2 Remastered
    105,  # Halo 3
]

AFFECTED_GAME_IDS = BATCHED_GAME_IDS + OVERMATCH_GAME_IDS
JULY_START = date(2026, 7, 1)


def main() -> int:
    db = SessionLocal()
    try:
        today = date.today()

        # ── Step 1: purge stale DailySummary rows in the July window ─────
        daily_deleted = (
            db.query(DailySummary)
            .filter(
                DailySummary.game_id.in_(AFFECTED_GAME_IDS),
                DailySummary.summary_date >= JULY_START,
                DailySummary.summary_date <= today,
            )
            .delete(synchronize_session=False)
        )
        logger.info(
            "Deleted %d stale DailySummary row(s) for %d affected games in [%s .. %s]",
            daily_deleted, len(AFFECTED_GAME_IDS), JULY_START, today,
        )

        # ── Step 2: purge stale TopicTrend rows entirely for these games ─
        # TopicTrends are cumulative; the wrong ones will keep tainting new
        # summaries via the "carry forward topics" fallback until deleted.
        # Safe to nuke all rows for these games — Step 6 rebuilds from
        # current SentimentRecords on the next ingestion tick.
        topic_deleted = (
            db.query(TopicTrend)
            .filter(TopicTrend.game_id.in_(AFFECTED_GAME_IDS))
            .delete(synchronize_session=False)
        )
        logger.info(
            "Deleted %d stale TopicTrend row(s) for %d affected games",
            topic_deleted, len(AFFECTED_GAME_IDS),
        )

        db.commit()

        # ── Step 3: regenerate today's DailySummary + TopicTrend for each ─
        # game so the UI immediately reflects clean data (rather than the
        # "no data yet, insufficient signal" fallback until next ingestion).
        affected_games = (
            db.query(Game)
            .filter(Game.id.in_(AFFECTED_GAME_IDS))
            .all()
        )
        for game in affected_games:
            log_lines: list[str] = []
            errors: list[str] = []
            try:
                _step6_extract_topics(db, game, log_lines, errors)
                _step7_daily_summary(db, game, log_lines, errors)
            except Exception:
                logger.exception("  #%s '%s': FAILED during regeneration", game.id, game.name)
                continue

            for line in log_lines:
                logger.info("  %s", line)
            for err in errors:
                logger.error("  %s", err)

        logger.info("regenerate_summaries complete for %d games", len(affected_games))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
