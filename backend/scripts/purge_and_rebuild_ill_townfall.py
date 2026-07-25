"""
One-time remediation script (2026-07-24 evening).

Purges ALL SentimentRecord + DailySummary + WindowSummary rows for
ILL (#138) and SILENT HILL: Townfall (#139), rewrites their
distinctive_keywords to stricter, false-positive-safe values, and
re-runs Step 5-7 (relevance gate + sentiment + topics + daily summary)
against the existing 14,805 RawPost rows already collected for these
two games.

Root cause it fixes:
  1. ILL auto-generated `['ILL', 'ILL game']` — matched every "ill",
     "I'll", "illness" occurrence in Reddit posts across 22 subs.
  2. Townfall auto-generated `['SILENT HILL: Townfall', 'SILENT HILL:
     Townfall game', 'SILENT HILL', 'SILENT HILL Townfall']` — the
     bare "SILENT HILL" token matched every Silent Hill franchise
     post across 25 subs (SH2, SH3, SH4, Silent Hill F, movie,
     remakes), producing 819 SentimentRecords with 0/20 actually
     about Townfall in a random sample.

  Post-remediation contamination target: <5% false-positive rate in a
  20-record sample. Idempotent — safe to re-run.
"""
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from database import SessionLocal  # noqa: E402
from models import (  # noqa: E402
    Game,
    RawPost,
    SentimentRecord,
    DailySummary,
    WindowSummary,
)
from services.ingestor import (  # noqa: E402
    _step5_classify_sentiment,
    _step6_extract_topics,
    _step7_daily_summary,
)
from services.nlp_service import load_model  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

# Stricter keywords engineered manually to eliminate the false-positive
# vectors we observed in the diag/game_records audit. Rules applied:
#   - No bare short-word tokens (ILL, ill).
#   - No bare franchise names (SILENT HILL alone) for spin-offs.
#   - Every keyword must contain the spin-off's unique word (Townfall)
#     OR a studio/publisher/context qualifier that disambiguates.
#   - Include community shorthand forms known from the trailer/press
#     coverage research (Team Clout, Mundfish, Screen Burn, No Code).
NEW_KEYWORDS = {
    138: [  # ILL
        # Every keyword pins to a disambiguator that "ill" as a
        # contraction/adjective/prefix cannot satisfy.
        "Team Clout ILL",
        "Mundfish ILL",
        "ILL game",           # kept — but relevance-gate substance rule
                              # still requires \\b matches + 60-char body
        "ILLgame",            # dedicated hashtag/community handle
        "ILL horror game",
        "ILL Team Clout",
        "ILL Mundfish",
    ],
    139: [  # SILENT HILL: Townfall
        # Every keyword includes "Townfall". Bare "SILENT HILL" is
        # DELIBERATELY OMITTED — that's the token that contaminated
        # the entire admission set.
        "Silent Hill Townfall",
        "Silent Hill: Townfall",
        "SH Townfall",
        "Townfall Silent Hill",
        "Screen Burn Townfall",
        "No Code Townfall",
        "Townfall game",
    ],
}


def main() -> int:
    load_model()  # warm sentiment model once (~10s first hit)

    db = SessionLocal()
    total_purged_sr = 0
    total_purged_ds = 0
    total_purged_ws = 0
    total_new_sr = 0

    try:
        for game_id, new_kws in NEW_KEYWORDS.items():
            game = db.query(Game).filter_by(id=game_id).first()
            if not game:
                logger.error("Game %d not found — skipping", game_id)
                continue

            logger.info("=" * 70)
            logger.info(
                "REMEDIATE #%d %r (was: %s)",
                game.id, game.name, game.distinctive_keywords,
            )
            logger.info("=" * 70)

            # ── Step 1: purge every SentimentRecord attached to this game's
            # RawPost rows. SentimentRecord has no game_id column; join via
            # raw_post_id → RawPost.game_id.
            sr_ids = [
                sr_id for (sr_id,) in db.query(SentimentRecord.id)
                .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
                .filter(RawPost.game_id == game_id)
                .all()
            ]
            if sr_ids:
                db.query(SentimentRecord).filter(SentimentRecord.id.in_(sr_ids)).delete(
                    synchronize_session=False
                )
                logger.info("Purged %d SentimentRecord rows.", len(sr_ids))
                total_purged_sr += len(sr_ids)

            # ── Step 2: purge DailySummary + WindowSummary caches for this game.
            ds_deleted = db.query(DailySummary).filter(DailySummary.game_id == game_id).delete(
                synchronize_session=False
            )
            ws_deleted = db.query(WindowSummary).filter(WindowSummary.game_id == game_id).delete(
                synchronize_session=False
            )
            logger.info(
                "Purged %d DailySummary + %d WindowSummary rows.",
                ds_deleted, ws_deleted,
            )
            total_purged_ds += ds_deleted
            total_purged_ws += ws_deleted

            # ── Step 3: write the new stricter keywords onto the Game row.
            game.distinctive_keywords = list(new_kws)
            db.commit()
            db.refresh(game)
            logger.info("New distinctive_keywords: %s", game.distinctive_keywords)

            # ── Step 4: rerun Step 5 (relevance + sentiment) against the
            # 9,751 / 5,054 RawPost rows already collected. This is the
            # rebuild pass — the gate will admit ONLY posts that pass the
            # new stricter keyword set.
            log_lines: list[str] = []
            errors: list[str] = []
            _step5_classify_sentiment(db, game, log_lines, errors)
            for line in log_lines[-10:]:
                logger.info("  %s", line)
            for e in errors[-5:]:
                logger.error("  %s", e)

            # ── Step 5: rebuild topics + daily summaries.
            log_lines = []
            errors = []
            _step6_extract_topics(db, game, log_lines, errors)
            _step7_daily_summary(db, game, log_lines, errors)
            db.commit()
            for line in log_lines[-5:]:
                logger.info("  %s", line)

            # ── Step 6: count fresh SentimentRecords for this game.
            new_sr_count = (
                db.query(SentimentRecord)
                .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
                .filter(RawPost.game_id == game_id)
                .count()
            )
            raw_count = db.query(RawPost).filter(RawPost.game_id == game_id).count()
            logger.info(
                "Rebuild complete: %d raw → %d admitted (%.2f%% gate rate)",
                raw_count, new_sr_count,
                (new_sr_count / raw_count * 100) if raw_count else 0.0,
            )
            total_new_sr += new_sr_count

        logger.info("=" * 70)
        logger.info(
            "TOTAL: purged %d SR + %d DS + %d WS, rebuilt to %d SR.",
            total_purged_sr, total_purged_ds, total_purged_ws, total_new_sr,
        )
        logger.info("=" * 70)
        return 0

    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
