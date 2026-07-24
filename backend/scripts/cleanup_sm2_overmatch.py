"""
One-time cleanup (2026-07-24) — fixes over-matches from the initial recovery.

During the first successful recovery (commit fd740e4), the Layer 2 fuzzy
gate had four keyword variants with a numeric-suffix collapse that made
them fuzzy-match to bare common English/lore terms:

  - Space Marine 2 (#24)      : 'Space Marine2' → bare 'Space Marine'
                                (Warhammer lore posts got classified)
  - Crysis 3 Remastered (#37) : 'Crysis3 Remastered' → 'Crysis Remastered'
  - Crysis 2 Remastered (#39) : 'Crysis2 Remastered' → 'Crysis Remastered'
  - Halo 3 (#105)             : 'Halo3 MCC' → 'Halo MCC'
                                (also cross-game with Halo: MCC #26)

Those variants are now removed from backend/data/proposed_keywords.json.
This script re-runs the pipeline for the four affected games:

  1. Delete every SentimentRecord for a July-2026 RawPost tagged to these
     games where the RawPost.is_relevant is currently True. These are
     records that were created during recovery under the too-lenient
     fuzzy layer.
  2. Reset RawPost.is_relevant = None for those posts.
  3. Run _step5_classify_sentiment against each of the four games so the
     tightened keyword list re-evaluates every unclassified RawPost.

Idempotent: safe to re-run. If the guard AppSetting is already set, the
deploy wrapper will skip; the script itself is safe either way.
"""
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from database import SessionLocal  # noqa: E402
from models import Game, RawPost, SentimentRecord  # noqa: E402
from services.ingestor import _step5_classify_sentiment  # noqa: E402
from services.nlp_service import load_model  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

# Games affected by the removed numeric-collapse keyword variants.
AFFECTED_GAME_IDS = [24, 37, 39, 105]

JULY_START = datetime(2026, 7, 1, tzinfo=timezone.utc)
JULY_END = datetime(2026, 7, 31, 23, 59, 59, tzinfo=timezone.utc)


def main() -> int:
    load_model()

    db = SessionLocal()
    try:
        # Step 1: identify SentimentRecords to invalidate. Scope: linked RawPost
        # belongs to one of the affected games, was ingested in the July 2026
        # window, source is reddit, and is_relevant is currently True (i.e.
        # was classified as relevant under the too-lenient gate). Collect IDs
        # first, then delete + reset, so we don't fight SA 2.x's join+update
        # restriction.
        rows = (
            db.query(RawPost.id, SentimentRecord.id)
            .join(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
            .filter(
                RawPost.game_id.in_(AFFECTED_GAME_IDS),
                RawPost.source == "reddit",
                RawPost.post_date >= JULY_START,
                RawPost.post_date <= JULY_END,
                RawPost.is_relevant.is_(True),
            )
            .all()
        )

        raw_ids = [r[0] for r in rows]
        sr_ids = [r[1] for r in rows]
        logger.info(
            "Cleanup scope: %d SentimentRecord(s) to delete + %d RawPost.is_relevant to reset "
            "across games %s",
            len(sr_ids), len(raw_ids), AFFECTED_GAME_IDS,
        )

        if sr_ids:
            sr_deleted = (
                db.query(SentimentRecord)
                .filter(SentimentRecord.id.in_(sr_ids))
                .delete(synchronize_session=False)
            )
            logger.info("Deleted %d SentimentRecord row(s)", sr_deleted)

        if raw_ids:
            rp_reset = (
                db.query(RawPost)
                .filter(RawPost.id.in_(raw_ids))
                .update({RawPost.is_relevant: None}, synchronize_session=False)
            )
            logger.info("Reset is_relevant=None on %d RawPost row(s)", rp_reset)

        db.commit()

        # Step 2: run _step5 on each affected game so the tightened gate
        # re-evaluates. Real posts get re-classified with a fresh
        # SentimentRecord; false-positive over-matches now get
        # is_relevant=False and no record.
        active_affected = (
            db.query(Game)
            .filter(Game.id.in_(AFFECTED_GAME_IDS), Game.is_active == True)  # noqa: E712
            .all()
        )
        for game in active_affected:
            log_lines: list[str] = []
            errors: list[str] = []
            try:
                _step5_classify_sentiment(db, game, log_lines, errors)
            except Exception:
                logger.exception("  #%s '%s': FAILED to re-classify", game.id, game.name)
                continue
            for line in log_lines:
                logger.info("  %s", line)
            for err in errors:
                logger.error("  %s", err)

        logger.info("cleanup_sm2_overmatch complete for games %s", AFFECTED_GAME_IDS)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
