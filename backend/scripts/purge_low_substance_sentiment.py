"""
One-time cleanup (2026-07-24) — deletes SentimentRecord rows for posts
that fail the tightened Rule 1 content-substance gate (raised from
30 chars to ≥60 chars + ≥8 words + at least one 40-char component).

Scope: every SentimentRecord across every game and every source. Not
scoped to July because low-substance posts should never have been
tagged regardless of when they were ingested. RawPost rows are LEFT
INTACT (they may still be useful for volume-by-source metrics and
audit); only the SentimentRecord rows are deleted, and each affected
RawPost gets its is_relevant reset to NULL so Step 5 re-evaluates on
the next tick.

Idempotent: safe to re-run. Guarded by AppSetting
low_substance_purge_done_at.
"""
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from database import SessionLocal  # noqa: E402
from models import RawPost, SentimentRecord  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

# Must match Rule 1 in services/post_relevance.py exactly.
WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9\-']*")


def is_low_substance(title: str | None, body: str | None) -> bool:
    """
    Return True if the post fails the tightened content-substance gate.
    Mirrors Rule 1 in is_post_relevant_to_game().
    """
    t = (title or "").strip()
    b = (body or "").strip()
    combined = f"{t} {b}".strip()

    if len(combined) < 60:
        return True

    words = [w for w in WORD_RE.findall(combined) if len(w) >= 2]
    if len(words) < 8:
        return True

    if len(t) < 40 and len(b) < 40:
        return True

    return False


def main() -> int:
    db = SessionLocal()
    try:
        # Iterate SentimentRecord + RawPost pairs in chunks to keep memory
        # sensible (there are ~15k+ rows to check).
        page_size = 500
        page = 0
        total_checked = 0
        low_substance_sr_ids: list[int] = []
        low_substance_rp_ids: list[int] = []

        while True:
            batch = (
                db.query(RawPost, SentimentRecord)
                .join(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
                .order_by(SentimentRecord.id.asc())
                .offset(page * page_size)
                .limit(page_size)
                .all()
            )
            if not batch:
                break

            for rp, sr in batch:
                total_checked += 1
                if is_low_substance(rp.title, rp.body):
                    low_substance_sr_ids.append(sr.id)
                    low_substance_rp_ids.append(rp.id)

            page += 1
            if page % 10 == 0:
                logger.info(
                    "  progress: checked %d records so far (%d flagged low-substance)",
                    total_checked, len(low_substance_sr_ids),
                )

        logger.info(
            "Scan complete: %d SentimentRecords checked, %d fail the tightened content gate",
            total_checked, len(low_substance_sr_ids),
        )

        if not low_substance_sr_ids:
            logger.info("Nothing to purge.")
            return 0

        # Delete the flagged SentimentRecord rows.
        sr_deleted = (
            db.query(SentimentRecord)
            .filter(SentimentRecord.id.in_(low_substance_sr_ids))
            .delete(synchronize_session=False)
        )
        logger.info("Deleted %d low-substance SentimentRecord row(s)", sr_deleted)

        # Reset is_relevant=None on the associated RawPosts. Some of them
        # might be legitimately marked True/False under the OLD relevance
        # gate; setting to None ensures Step 5 re-evaluates against the
        # NEW gate (which will now reject them under Rule 1).
        rp_reset = (
            db.query(RawPost)
            .filter(RawPost.id.in_(low_substance_rp_ids))
            .update({RawPost.is_relevant: None}, synchronize_session=False)
        )
        logger.info("Reset is_relevant=None on %d RawPost row(s)", rp_reset)

        db.commit()
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
