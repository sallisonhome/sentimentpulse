"""
Purge legacy Steam Forum RawPost rows with NULL post_date (2026-07-27).

Root cause: an older version of the Steam Forum scraper (pre mid-2026)
saved OP posts with external_ids like 'forum_{thread_id}_{page_num}'
(numeric suffix) and no `post_date`. The current scraper writes
'forum_{thread_id}_op' + '..._c{comment_id}' with real timestamps.

Impact of leaving them in place:
  * dashboard period-window queries now (post 2026-07-27 fix) ignore
    them because they no longer coalesce to collected_at. But:
    - lifetime KPI totals still include them
    - raw_post_total on Settings still reports them
    - keyword_dryrun samples can include them
  * They can't be repaired — the timestamps were never captured by the
    old scraper and the underlying Steam threads may not exist anymore
    or would require full re-scrape to recover dates.

What this script does (per game):
  1. Enumerate RawPost rows where post_date IS NULL and source='steam_forum'.
  2. Delete their SentimentRecord (and any dependent rows) first.
  3. Delete the RawPost rows.
  4. Log counts.

Idempotent: safe to re-run. Guarded by AppSetting so it only runs once
per deploy. Manually re-run in a shell if needed.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

# Ensure backend/ is importable when run as a script.
BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from sqlalchemy import func
from database import SessionLocal
from models import Game, RawPost, SentimentRecord, SourceEnum

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("purge_null_date_steamforum")


def main() -> int:
    db = SessionLocal()
    try:
        # Identify candidate RawPost ids across ALL games in one query.
        candidate_ids_q = db.query(RawPost.id).filter(
            RawPost.source == SourceEnum.steam_forum,
            RawPost.post_date.is_(None),
        )
        candidate_ids = [r[0] for r in candidate_ids_q.all()]
        logger.info("Found %d candidate NULL-date Steam Forum RawPost rows to purge", len(candidate_ids))
        if not candidate_ids:
            logger.info("Nothing to purge — exiting cleanly")
            return 0

        # Delete SentimentRecords keyed to these RawPosts first so foreign
        # keys don't complain. Use IN chunks to avoid huge single statements.
        chunk = 1000
        sr_deleted = 0
        for i in range(0, len(candidate_ids), chunk):
            batch = candidate_ids[i:i+chunk]
            n = (
                db.query(SentimentRecord)
                .filter(SentimentRecord.raw_post_id.in_(batch))
                .delete(synchronize_session=False)
            )
            sr_deleted += n
            db.commit()
        logger.info("Deleted %d SentimentRecord rows", sr_deleted)

        # Now delete the RawPost rows.
        raw_deleted = 0
        for i in range(0, len(candidate_ids), chunk):
            batch = candidate_ids[i:i+chunk]
            n = (
                db.query(RawPost)
                .filter(RawPost.id.in_(batch))
                .delete(synchronize_session=False)
            )
            raw_deleted += n
            db.commit()
        logger.info("Deleted %d RawPost rows", raw_deleted)

        # Per-game breakdown for logs (post-delete verification).
        remaining_q = (
            db.query(RawPost.game_id, func.count(RawPost.id))
            .filter(
                RawPost.source == SourceEnum.steam_forum,
                RawPost.post_date.is_(None),
            )
            .group_by(RawPost.game_id)
            .all()
        )
        if remaining_q:
            logger.warning("Post-purge remaining NULL-date rows: %s", dict(remaining_q))
        else:
            logger.info("Post-purge: zero NULL-date Steam Forum rows remaining across all games")

        return 0
    except Exception as exc:
        logger.exception("Purge failed: %s", exc)
        db.rollback()
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
