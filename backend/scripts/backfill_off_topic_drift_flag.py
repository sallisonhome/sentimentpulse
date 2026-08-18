"""Backfill: set raw_posts.is_off_topic_drift=True for every existing
SentimentRecord tagged with the FORCED_NEUTRAL_OFFTOPIC_COMMENT_ON_
VERIFIED_PARENT audit rule.

Companion to migration 0017. The migration adds the column with
default=False, but every existing drift row already has the audit rule
in sentiment_records.applied_rules from the earlier reclassify
(commit 4fcd227 / apply run 32145419875 this morning). This script
propagates that signal onto the RawPost row so the read-side drift
filter in the dashboard / feedback synth / period summary sees them.

Idempotent: SQL is a straight UPDATE with a WHERE that already excludes
rows where is_off_topic_drift is TRUE. Safe to re-run.

Usage on the droplet:
    cd /opt/sentimentpulse/backend
    .venv/bin/python -m scripts.backfill_off_topic_drift_flag --dry-run
    .venv/bin/python -m scripts.backfill_off_topic_drift_flag --apply

The script counts affected rows in dry-run mode and prints a per-game
breakdown. Apply mode runs a single UPDATE ... FROM ... in one commit;
the WHERE clause is indexed on both sides so it should complete in a
few seconds on 114k rows.
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

from sqlalchemy import text
from sqlalchemy.orm import Session

from database import SessionLocal
from models import RawPost, SentimentEnum, SentimentRecord


logger = logging.getLogger(__name__)

FORCED_RULE = "FORCED_NEUTRAL_OFFTOPIC_COMMENT_ON_VERIFIED_PARENT"


def count_target_rows(db: Session) -> tuple[int, dict[int, int]]:
    """Count how many RawPost rows would be flipped, breakdown per game.

    Returns (total_count, {game_id: count}).
    """
    # Match rows whose SentimentRecord.applied_rules JSON contains the rule
    # AND is_off_topic_drift is currently FALSE (idempotency guard).
    rows = db.execute(text(f"""
        SELECT rp.game_id, COUNT(*) AS n
          FROM raw_posts rp
          JOIN sentiment_records sr ON sr.raw_post_id = rp.id
         WHERE sr.applied_rules LIKE '%{FORCED_RULE}%'
           AND rp.is_off_topic_drift = 0
      GROUP BY rp.game_id
      ORDER BY n DESC
    """)).all()
    per_game = {row.game_id: row.n for row in rows}
    return sum(per_game.values()), per_game


def apply_backfill(db: Session) -> int:
    """UPDATE the flag in a single transaction. Returns affected row count."""
    # SQLite supports UPDATE ... FROM as of 3.33 (2020). Use a subquery
    # for portability: the equivalent expression is more verbose but
    # correct across all SQLite versions the app supports.
    result = db.execute(text(f"""
        UPDATE raw_posts
           SET is_off_topic_drift = 1
         WHERE id IN (
             SELECT rp.id
               FROM raw_posts rp
               JOIN sentiment_records sr ON sr.raw_post_id = rp.id
              WHERE sr.applied_rules LIKE '%{FORCED_RULE}%'
                AND rp.is_off_topic_drift = 0
         )
    """))
    db.commit()
    return result.rowcount


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="Count only, no writes.")
    ap.add_argument("--apply", action="store_true",
                    help="Perform the UPDATE.")
    args = ap.parse_args()

    if args.dry_run == args.apply:
        print("Exactly one of --dry-run or --apply is required.", file=sys.stderr)
        return 2

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s  %(message)s",
    )

    db = SessionLocal()
    try:
        started = time.time()
        total, per_game = count_target_rows(db)
        logger.info("Target rows: %d across %d games", total, len(per_game))
        for gid, n in sorted(per_game.items(), key=lambda x: -x[1]):
            # Look up name for readability
            name_row = db.execute(text(
                "SELECT name FROM games WHERE id = :gid"
            ), {"gid": gid}).first()
            name = name_row.name if name_row else "(deleted)"
            logger.info("  game_id=%-4d  %-40s  %d rows", gid, name[:40], n)

        if args.dry_run:
            elapsed = time.time() - started
            logger.info("DRY-RUN complete. Elapsed: %.1fs. Would flip %d rows.",
                        elapsed, total)
            return 0

        # Apply mode.
        logger.info("APPLYING \u2014 running UPDATE ...")
        affected = apply_backfill(db)
        elapsed = time.time() - started
        logger.info("APPLY complete. Elapsed: %.1fs. Rows flipped: %d.",
                    elapsed, affected)

        # Post-apply sanity check: no target rows should remain.
        remaining, _ = count_target_rows(db)
        if remaining != 0:
            logger.error("Post-apply sanity check failed: %d rows still "
                         "match the target criteria. Idempotency guard "
                         "may be broken.", remaining)
            return 1
        logger.info("Post-apply sanity check OK (0 remaining target rows).")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
