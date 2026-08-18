"""Backfill: force-neutral off-topic drift comments on verified-parent
Reddit threads.

2026-08-18. Companion to the write-path fix in services/ingestor.py Step 5
(commit 335c1ed). The write-path fix applies going forward but does NOT
retroactively touch the ~277k reddit_comment SentimentRecords already in
the DB. This script does that retroactive pass.

For every RawPost with source='reddit_comment' that has a SentimentRecord:
  - Run services.post_relevance.is_comment_focused_on_game(body, game).
  - If it returns True → leave the record alone (model verdict stays).
  - If it returns False AND the current sentiment != 'neutral' →
    override to 'neutral'. Preserve the original verdict in
    original_label / original_score if those columns are NULL, and
    append 'FORCED_NEUTRAL_OFFTOPIC_COMMENT_ON_VERIFIED_PARENT' to
    applied_rules. Idempotent: if the rule tag is already present,
    skip the row (safe to re-run).

Runs directly on the droplet against the SQLite DB. NOT a FastAPI
endpoint — this is a one-off backfill, not something to expose over HTTP.

Usage on the droplet:
    cd /opt/sentimentpulse/backend
    .venv/bin/python -m scripts.reclassify_comment_drift_neutral --dry-run
    .venv/bin/python -m scripts.reclassify_comment_drift_neutral --apply

--dry-run    : count what would change, don't write.
--apply      : perform the update.
--game-id N  : restrict to a single game (for smoke-testing).
--batch-size : how many rows per commit (default 500).
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from collections import defaultdict
from typing import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session

# When run as `python -m scripts.reclassify_comment_drift_neutral` from
# /opt/sentimentpulse/backend, these imports resolve against the standard
# backend layout.
from database import SessionLocal
from models import Game, RawPost, SentimentEnum, SentimentRecord, SourceEnum
from services.post_relevance import is_comment_focused_on_game


logger = logging.getLogger(__name__)

FORCED_RULE = "FORCED_NEUTRAL_OFFTOPIC_COMMENT_ON_VERIFIED_PARENT"


def iter_comment_batches(
    db: Session,
    game_id: int | None,
    batch_size: int,
) -> Iterable[list[tuple[RawPost, SentimentRecord]]]:
    """Yield (raw_post, sentiment_record) tuples in batches for streaming.

    We paginate by SentimentRecord.id ascending so a mid-run interruption
    can be resumed by filtering `SentimentRecord.id > last_seen`. In this
    one-off we just run to completion.
    """
    last_id = 0
    while True:
        q = (
            db.query(RawPost, SentimentRecord)
            .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
            .filter(RawPost.source == SourceEnum.reddit_comment)
            .filter(SentimentRecord.id > last_id)
        )
        if game_id is not None:
            q = q.filter(RawPost.game_id == game_id)
        q = q.order_by(SentimentRecord.id.asc()).limit(batch_size)
        rows = q.all()
        if not rows:
            return
        yield rows
        last_id = rows[-1][1].id


def process(db: Session, game_id: int | None, batch_size: int, apply: bool) -> None:
    """Walk every reddit_comment SentimentRecord and apply the drift override.

    Progress is logged every batch. A final per-game summary is printed.
    """
    # Cache Game objects so we don't re-query for every row.
    games_cache: dict[int, Game] = {}

    def _get_game(gid: int) -> Game:
        g = games_cache.get(gid)
        if g is None:
            g = db.query(Game).filter(Game.id == gid).first()
            games_cache[gid] = g
        return g

    total_scanned = 0
    total_would_flip = 0
    total_flipped = 0
    total_already_tagged = 0
    total_already_neutral = 0
    total_kept = 0  # focus check passed → left alone

    per_game_scan: dict[int, int] = defaultdict(int)
    per_game_flip: dict[int, int] = defaultdict(int)
    per_game_kept: dict[int, int] = defaultdict(int)

    started = time.time()
    last_log = started

    for batch in iter_comment_batches(db, game_id, batch_size):
        for rp, sr in batch:
            total_scanned += 1
            per_game_scan[rp.game_id] += 1

            game = _get_game(rp.game_id)
            if game is None:
                # RawPost pointing at a deleted game — extremely rare; leave
                # the SentimentRecord alone.
                total_kept += 1
                per_game_kept[rp.game_id] += 1
                continue

            # Idempotency guard: if we already tagged this row, skip.
            rules = list(sr.applied_rules) if sr.applied_rules else []
            if FORCED_RULE in rules:
                total_already_tagged += 1
                continue

            # Focus check.
            focused = is_comment_focused_on_game(rp.body or "", game)
            if focused:
                total_kept += 1
                per_game_kept[rp.game_id] += 1
                continue

            # Off-topic drift. If already neutral, we just add the rule tag
            # for audit consistency but don't touch the sentiment value.
            if sr.sentiment == SentimentEnum.neutral:
                total_already_neutral += 1
                if apply:
                    rules.append(FORCED_RULE)
                    sr.applied_rules = rules
                continue

            # Non-neutral drift: this is the one we're actually fixing.
            total_would_flip += 1
            per_game_flip[rp.game_id] += 1
            if apply:
                if sr.original_label is None:
                    sr.original_label = sr.sentiment.value
                if sr.original_score is None:
                    sr.original_score = sr.sentiment_score
                sr.sentiment = SentimentEnum.neutral
                # Preserve original score; the override is a policy call,
                # not a re-classification, so leaving the confidence
                # unchanged matches how the write-path handles it.
                rules.append(FORCED_RULE)
                sr.applied_rules = rules
                total_flipped += 1

        # Commit at batch boundary in apply mode.
        if apply:
            try:
                db.commit()
            except Exception as exc:
                db.rollback()
                logger.error("Batch commit failed at scanned=%d: %s", total_scanned, exc)
                raise

        # Progress log every 5 seconds
        now = time.time()
        if now - last_log >= 5.0:
            rate = total_scanned / max(now - started, 0.001)
            logger.info(
                "progress: scanned=%d flipped=%d would_flip=%d already_neutral=%d "
                "already_tagged=%d kept=%d (%.0f rows/s)",
                total_scanned, total_flipped, total_would_flip,
                total_already_neutral, total_already_tagged, total_kept, rate,
            )
            last_log = now

    elapsed = time.time() - started
    logger.info("=" * 70)
    logger.info("DONE. %s mode. Elapsed: %.1fs. Scanned: %d",
                "APPLY" if apply else "DRY-RUN", elapsed, total_scanned)
    logger.info("  focus-check kept as-is         : %d", total_kept)
    logger.info("  already tagged (idempotent skip): %d", total_already_tagged)
    logger.info("  already neutral (rule-tagged)  : %d", total_already_neutral)
    if apply:
        logger.info("  FLIPPED to neutral             : %d", total_flipped)
    else:
        logger.info("  WOULD FLIP to neutral          : %d", total_would_flip)
    logger.info("")
    logger.info("Per-game breakdown (games with any flip candidate):")
    logger.info("  %-4s  %-40s  %8s  %8s  %8s", "id", "name", "scanned", "kept", "flip")
    logger.info("  " + "-" * 76)
    # Sort by flip count desc
    game_ids_with_flips = sorted(
        {gid for gid, n in per_game_flip.items() if n > 0},
        key=lambda gid: -per_game_flip[gid],
    )
    for gid in game_ids_with_flips:
        g = _get_game(gid)
        name = g.name if g else "(deleted)"
        logger.info("  %-4d  %-40s  %8d  %8d  %8d",
                    gid, name[:40], per_game_scan[gid], per_game_kept[gid],
                    per_game_flip[gid])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="Count what would change, don't write.")
    ap.add_argument("--apply", action="store_true",
                    help="Perform the sentiment override + audit tag.")
    ap.add_argument("--game-id", type=int, default=None,
                    help="Restrict to a single game (for smoke-testing).")
    ap.add_argument("--batch-size", type=int, default=500)
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
        process(db, args.game_id, args.batch_size, apply=args.apply)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
