"""
One-time repair (2026-07-25 afternoon): reset is_relevant=NULL on ILL's
Reddit RawPost rows so Step 5 re-evaluates them under the new fuzzy-match
guard (see services/post_relevance.py _SHORT_COLLISION_WORDS).

Root cause of the contamination: keyword 'ILL game' matched via Layer 2
fuzzy sliding-window on any post that contained both 'ill' (as I'll
contraction) AND 'game' — e.g. 'GIVE ME A GAME ILL PLAY IT'. About 2 of
19 admitted ILL SentimentRecords were confirmed false positives.

Idempotent — safe to re-run. Only touches ILL (game #138).
"""
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import update  # noqa: E402
from database import SessionLocal  # noqa: E402
from models import RawPost, SentimentRecord, SourceEnum  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

ILL_GAME_ID = 138


def main() -> int:
    db = SessionLocal()
    try:
        # 1. Purge existing SentimentRecords for ILL — some may be false
        # positives that Step 5 won't naturally re-evaluate.
        sr_ids = [
            sr_id for (sr_id,) in db.query(SentimentRecord.id)
            .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
            .filter(RawPost.game_id == ILL_GAME_ID)
            .filter(RawPost.source == SourceEnum.reddit)
            .all()
        ]
        if sr_ids:
            db.query(SentimentRecord).filter(SentimentRecord.id.in_(sr_ids)).delete(
                synchronize_session=False
            )
            logger.info("Purged %d Reddit SentimentRecords for ILL", len(sr_ids))

        # 2. Reset is_relevant on all Reddit RawPosts so Step 5 re-evaluates.
        reset = db.execute(
            update(RawPost)
            .where(RawPost.game_id == ILL_GAME_ID)
            .where(RawPost.source == SourceEnum.reddit)
            .values(is_relevant=None)
        ).rowcount
        db.commit()
        logger.info(
            "Reset is_relevant=NULL on %d ILL Reddit RawPosts. Next Step 5 "
            "run will re-evaluate under the new short-collision-words guard.",
            reset,
        )
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
