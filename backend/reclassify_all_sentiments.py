"""
§18 Reclassification Script — reclassify_all_sentiments.py

Re-runs the full §18 trust chain (Layers 1-3 as of PR #10) over every
SentimentRecord in the database and updates the stored label, score, and all
audit columns (signal_quality, language, original_label, sentiment_conflict).

This script is idempotent: running it multiple times produces the same result
because it always re-derives classification from the source RawPost text.

CLI
---
  python reclassify_all_sentiments.py              # full DB
  python reclassify_all_sentiments.py --game-id 5  # one game only
  python reclassify_all_sentiments.py --dry-run    # compute but don't write

Progress output
---------------
  Prints "Reclassified N/M posts" every 500 posts (configurable via PROGRESS_EVERY).
  At the end prints a summary: label counts before vs after, % moved to neutral.
"""
import argparse
import sys
from pathlib import Path

# Ensure the backend directory is on the Python path when run directly
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from collections import Counter

from sqlalchemy.orm import Session

from database import SessionLocal
from models import RawPost, SentimentEnum, SentimentRecord
from services.nlp_service import classify_batch_with_gate_v2, load_model

CHUNK_SIZE = 200
PROGRESS_EVERY = 500


def _build_query(db: Session, game_id: int | None):
    """Return a query yielding (RawPost, SentimentRecord) pairs."""
    q = (
        db.query(RawPost, SentimentRecord)
        .join(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
    )
    if game_id is not None:
        q = q.filter(RawPost.game_id == game_id)
    return q


def reclassify(game_id: int | None = None, dry_run: bool = False) -> None:
    """
    Main reclassification routine.

    Parameters
    ----------
    game_id : restrict to one game when provided; None means all games.
    dry_run : if True, compute classifications but do not write to the DB.
    """
    load_model()

    db: Session = SessionLocal()
    try:
        total = _build_query(db, game_id).count()
        if total == 0:
            print("No posts found — nothing to reclassify.")
            return

        print(
            f"Reclassifying {total} posts"
            + (f" for game_id={game_id}" if game_id else "")
            + (" [DRY RUN — no writes]" if dry_run else "")
        )

        # ── Collect before-counts ─────────────────────────────────────────────
        before_counts: Counter = Counter()
        for _, sr in _build_query(db, game_id):
            before_counts[sr.sentiment.value] += 1

        # ── Stream in chunks and reclassify ───────────────────────────────────
        processed = 0
        after_counts: Counter = Counter()

        offset = 0
        while offset < total:
            chunk = _build_query(db, game_id).offset(offset).limit(CHUNK_SIZE).all()
            if not chunk:
                break

            items = [
                {"title": post.title or "", "body": post.body or ""}
                for post, _ in chunk
            ]
            results = classify_batch_with_gate_v2(items)

            for (post, sr), result in zip(chunk, results):
                new_label = result["label"]
                after_counts[new_label] += 1

                if not dry_run:
                    sr.sentiment = SentimentEnum(new_label)
                    sr.sentiment_score = result["score"]
                    sr.signal_quality = result["signal_quality"]
                    sr.language = result["language"]
                    sr.original_label = result.get("original_label")
                    sr.sentiment_conflict = result.get("sentiment_conflict", False)
                    # applied_rules stays [] until PR #11 lexicon overlay

            if not dry_run:
                try:
                    db.commit()
                except Exception as exc:
                    db.rollback()
                    print(f"[ERROR] Commit failed at offset {offset}: {exc}")

            processed += len(chunk)
            offset += CHUNK_SIZE

            if processed % PROGRESS_EVERY < CHUNK_SIZE or processed >= total:
                print(f"Reclassified {min(processed, total)}/{total} posts")

        # ── Print summary ─────────────────────────────────────────────────────
        print("\n── Summary ──────────────────────────────────────────────────")
        print(f"{'Label':<12} {'Before':>8} {'After':>8} {'Change':>8}")
        print("-" * 42)
        all_labels = sorted(before_counts.keys() | after_counts.keys())
        for label in all_labels:
            b = before_counts.get(label, 0)
            a = after_counts.get(label, 0)
            print(f"{label:<12} {b:>8} {a:>8} {a - b:>+8}")

        # % moved to neutral
        before_non_neutral = sum(
            v for k, v in before_counts.items() if k != "neutral"
        )
        after_non_neutral = sum(
            v for k, v in after_counts.items() if k != "neutral"
        )
        moved_to_neutral = before_non_neutral - after_non_neutral
        if total > 0:
            pct = moved_to_neutral / total * 100
            print(f"\nMoved to neutral: {moved_to_neutral} posts ({pct:.1f}% of total)")

        if dry_run:
            print("\n[DRY RUN] No changes were written to the database.")

    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="§18 reclassification: re-run the full trust chain over all SentimentRecords."
    )
    parser.add_argument(
        "--game-id",
        type=int,
        default=None,
        metavar="ID",
        help="Restrict reclassification to one game (by database ID).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute classifications but do not write changes to the database.",
    )
    args = parser.parse_args()
    reclassify(game_id=args.game_id, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
