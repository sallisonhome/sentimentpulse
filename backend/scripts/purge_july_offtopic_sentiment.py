"""
One-time backfill script — purges off-topic reddit SentimentRecord rows for
July 2026 (2026-07-01 through 2026-07-24 23:59:59 UTC) using the NEW
relevance gate (Layer 1 exact + Layer 2 fuzzy, keyword lists persisted by
apply_keyword_lists.py).

Scope, per the approved plan:
  - source == 'reddit' ONLY (never touches steam_review/steam_forum/bluesky).
  - post effective date (coalesce post_date, collected_at) in
    [2026-07-01 00:00:00, 2026-07-24 23:59:59] UTC.
  - Re-checks relevance with is_post_relevant_to_game() using each post's
    game's CURRENT distinctive_keywords (i.e. run this AFTER
    apply_keyword_lists.py so the keyword lists are already persisted).
  - If NOT relevant: DELETE the SentimentRecord row only. The RawPost row
    is always retained (for audit / re-processing) and its is_relevant flag
    is set to False so Step 5 does not try to reclassify it going forward.
  - If relevant: RawPost.is_relevant is set to True and the SentimentRecord
    is left alone.

Idempotent: a second run finds zero SentimentRecord rows left to purge for
posts already handled (either already deleted, or already re-confirmed
relevant), so it's safe to re-run.

Usage:
    cd backend
    python scripts/purge_july_offtopic_sentiment.py               # apply
    python scripts/purge_july_offtopic_sentiment.py --dry-run      # preview only

Do NOT run this against the live/production DB from a workspace/sandbox
context — the deploy workflow runs it against the droplet's DB, guarded by
the AppSetting row `sentiment_july_backfill_done_at` so it only runs once.
"""
import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import func  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import Game, RawPost, SentimentRecord, SourceEnum  # noqa: E402
from services.post_relevance import is_post_relevant_to_game  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

WINDOW_START = datetime(2026, 7, 1, 0, 0, 0)
WINDOW_END = datetime(2026, 7, 24, 23, 59, 59)


def purge_july_offtopic_sentiment(dry_run: bool = False) -> dict:
    """
    Returns a summary dict:
        {"games_processed": int, "deleted": int, "kept": int}
    """
    db = SessionLocal()
    games_processed = 0
    deleted = 0
    kept = 0

    try:
        effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)
        rows: list[tuple[RawPost, SentimentRecord]] = (
            db.query(RawPost, SentimentRecord)
            .join(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
            .filter(
                RawPost.source == SourceEnum.reddit,
                effective_date >= WINDOW_START,
                effective_date <= WINDOW_END,
            )
            .all()
        )

        if not rows:
            logger.info("No reddit SentimentRecord rows found in the July 2026 window. Nothing to purge.")
            return {"games_processed": 0, "deleted": 0, "kept": 0}

        # Group by game for clearer logging and to avoid re-fetching Game per row.
        game_cache: dict[int, Game] = {}
        games_seen: set[int] = set()

        for post, sr in rows:
            game = game_cache.get(post.game_id)
            if game is None:
                game = db.query(Game).filter(Game.id == post.game_id).first()
                if game is None:
                    logger.warning("RawPost id=%d has game_id=%d with no matching Game row — skipping.", post.id, post.game_id)
                    continue
                game_cache[post.game_id] = game
            games_seen.add(game.id)

            relevant = is_post_relevant_to_game(post.title or "", post.body or "", game)
            if relevant:
                kept += 1
                if not dry_run:
                    post.is_relevant = True
                continue

            deleted += 1
            logger.info(
                "PURGE post_id=%d game_id=%d game=%r title=%r%s",
                post.id, game.id, game.name, (post.title or "")[:80],
                " [DRY RUN]" if dry_run else "",
            )
            if not dry_run:
                post.is_relevant = False
                db.delete(sr)

        games_processed = len(games_seen)

        if not dry_run:
            db.commit()
        else:
            db.rollback()

    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    summary = {"games_processed": games_processed, "deleted": deleted, "kept": kept}
    logger.info(
        "purge_july_offtopic_sentiment complete: %d game(s) processed, %d deleted, %d kept.%s",
        games_processed, deleted, kept,
        " [DRY RUN — no changes committed]" if dry_run else "",
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without committing.")
    args = parser.parse_args()
    purge_july_offtopic_sentiment(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
