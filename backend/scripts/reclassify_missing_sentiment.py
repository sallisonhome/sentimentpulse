"""
One-time recovery script (2026-07-24) — re-classifies sentiment for every
RawPost that no longer has a SentimentRecord for its game.

Background: the first prod deploy of the relevance-gate fix (commit c66f777)
ran `purge_july_offtopic_sentiment.py` BEFORE `apply_keyword_lists.py` was
able to persist the 29 keyword lists (the apply script hit FileNotFoundError
because it defaulted to a workspace-only path). With no keywords loaded,
the new `if not keywords: return False` gate rejected almost every post
as off-topic. Net effect from that deploy: 21 games processed, 7,594
sentiment records deleted, only 265 kept. Many of the 7,594 were legitimate
posts about the game — they only got purged because keywords weren't yet
applied.

RawPost rows were untouched by the purge (by design), so we can recover
by re-running Step 5 (classification) against every RawPost that no longer
has a SentimentRecord. With the correct keyword lists now persisted, the
relevance gate will correctly retain real posts and only skip actually
off-topic ones. Net result: the true off-topic posts stay purged; the
false-positive purges are restored with fresh classification.

Idempotent: safe to re-run. Only re-classifies RawPosts that are missing
a SentimentRecord for their game — anything that already got re-classified
by the natural ingestion cron will be skipped.

Guarded by AppSetting row `sentiment_july_recovery_done_at` in deploy.yml.
"""
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import and_, or_

# Add backend directory to sys.path so absolute imports work when run
# directly as `python scripts/reclassify_missing_sentiment.py` from within backend/.
sys.path.insert(0, str(Path(__file__).parent.parent))

from database import SessionLocal  # noqa: E402
from models import Game, RawPost, SentimentRecord  # noqa: E402
from services.ingestor import _step5_classify_sentiment  # noqa: E402
from services.nlp_service import load_model  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)


def main() -> int:
    # Warm the sentiment model once (Step 5 assumes it's loaded).
    load_model()

    db = SessionLocal()
    try:
        # ── Step 0: Un-gate wrongly-purged posts ──────────────────────────────
        # purge_july_offtopic_sentiment.py set RawPost.is_relevant = False on
        # every post it purged. When it ran WITHOUT keywords loaded, that
        # marked ~7,594 legitimate posts as is_relevant=False. Reset those
        # so _step5_classify_sentiment picks them up again.
        #
        # Signal that a RawPost was wrongly purged: it has
        #   is_relevant = False   (purge script marked it)
        #   AND no SentimentRecord (purge script deleted it)
        # Legitimately-purged posts also fit this profile — but that's OK.
        # After we reset them to None, the gate re-checks with keywords
        # loaded. Truly off-topic posts get is_relevant=False set AGAIN by
        # _step5_classify_sentiment. Real posts get classified. Net-net,
        # legit purges are re-purged (no data change) and false-positive
        # purges are recovered.
        # SQLAlchemy 2.x forbids Query.update() when the query has a JOIN.
        # Materialize IDs first, then update by primary key (also cheaper
        # than a joined bulk update for SQLite).
        ids_to_reset = [
            rid for (rid,) in (
                db.query(RawPost.id)
                .outerjoin(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
                .filter(
                    RawPost.is_relevant.is_(False),
                    SentimentRecord.id.is_(None),
                )
                .all()
            )
        ]
        reset_count = 0
        if ids_to_reset:
            reset_count = (
                db.query(RawPost)
                .filter(RawPost.id.in_(ids_to_reset))
                .update({RawPost.is_relevant: None}, synchronize_session=False)
            )
            db.commit()
        logger.info(
            "Reset is_relevant=None on %d wrongly-purged RawPost(s) so they "
            "can be re-evaluated by _step5_classify_sentiment below.",
            reset_count,
        )

        active_games = db.query(Game).filter(Game.is_active == True).all()  # noqa: E712
        logger.info("Reclassify: %d active games to process", len(active_games))

        for game in active_games:
            log_lines: list[str] = []
            errors: list[str] = []
            # _step5_classify_sentiment is the same function ingestor.py runs
            # on every scheduled tick — it picks up every RawPost joined to
            # this game that has no SentimentRecord yet AND
            # is_relevant IS NULL (i.e. not yet gated). Runs the (now-correct)
            # relevance gate, classifies the relevant ones, marks the
            # irrelevant ones as is_relevant=False. That's exactly what we
            # need to restore false-positive-purged records without re-purging
            # real off-topic posts.
            #
            # Signature: (db, game, log_lines, errors) -> None. Progress is
            # reported through log_lines; failures through errors.
            try:
                _step5_classify_sentiment(db, game, log_lines, errors)
            except Exception:
                logger.exception("  #%s '%s': FAILED to re-classify", game.id, game.name)
                continue

            for line in log_lines:
                logger.info("  %s", line)
            for err in errors:
                logger.error("  %s", err)

        logger.info("Reclassify complete for %d active games", len(active_games))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
