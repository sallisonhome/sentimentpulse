"""
One-time repair (2026-07-25): reset is_relevant=NULL on all existing
Steam Review + Steam Forum RawPost rows so the next Step 5 pass admits
them under the new source-aware auto-admit rule.

Rationale: prior to this rule, Steam Forum posts for sparse titles like
ILL and Townfall went through the same distinctive_keyword gate as
Reddit/Bluesky, and many were rejected because their titles didn't
contain the exact keyword phrase. Now those posts should all admit —
they live on the game's own Steam store page so their audience is by
construction the game's audience.

Idempotent — safe to re-run. Only touches Steam sources; leaves Reddit
and Bluesky rows untouched.
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

_STEAM_SOURCES = (SourceEnum.steam_review, SourceEnum.steam_forum)


def main() -> int:
    db = SessionLocal()
    try:
        # Count what we'd affect before mutating.
        rp_total = db.query(RawPost).filter(RawPost.source.in_(_STEAM_SOURCES)).count()
        rp_missing = (
            db.query(RawPost)
            .outerjoin(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
            .filter(RawPost.source.in_(_STEAM_SOURCES))
            .filter(SentimentRecord.id.is_(None))
            .count()
        )
        rp_rejected = (
            db.query(RawPost)
            .filter(RawPost.source.in_(_STEAM_SOURCES))
            .filter(RawPost.is_relevant.is_(False))
            .count()
        )
        logger.info(
            "Steam Source posts: total=%d, missing_sentiment_record=%d, is_relevant=False=%d",
            rp_total, rp_missing, rp_rejected,
        )

        # Reset is_relevant on posts that either got rejected OR have no
        # SentimentRecord (both mean Step 5 will re-evaluate them).
        rp_reset = db.execute(
            update(RawPost)
            .where(RawPost.source.in_(_STEAM_SOURCES))
            .where(RawPost.is_relevant.is_not(None))
            .values(is_relevant=None)
        ).rowcount
        db.commit()

        logger.info(
            "Reset is_relevant=NULL on %d Steam Source RawPost rows. "
            "Next daily ingest (or manual /api/ingest/run) will re-run "
            "Step 5 with auto-admit and create SentimentRecords for them.",
            rp_reset,
        )
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
