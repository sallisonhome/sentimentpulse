"""
One-shot script to rebuild SentimentRecord.topics + topic_trends for a single
game, applying the §14 relevance filter and §15 critical-mass gate to all of
its historical posts.

Usage:
    cd /opt/sentimentpulse/backend
    source .venv/bin/activate
    python rebuild_topics_for_game.py "Untitled John Wick Game"

The script:
  1. Loads the game by exact name.
  2. Fetches every (RawPost, SentimentRecord) pair for that game.
  3. Buckets posts by post_date day, applies §14 relevance filter per post.
  4. Groups by (day, sentiment), extracts topics with metadata, applies §15
     critical-mass gate.
  5. Writes per-post topics back to SentimentRecord.topics (overwriting).
  6. Upserts daily topic_trends rows (overwriting any previous label list).

Idempotent — re-running on the same game produces the same result.
"""
import sys
from collections import defaultdict
from datetime import date, datetime
from sqlalchemy.orm import Session
from sqlalchemy import func

from database import SessionLocal
from models import (
    Game,
    RawPost,
    SentimentRecord,
    SentimentEnum,
    TopicTrend,
    TrendDirectionEnum,
)
from services.post_relevance import is_post_relevant_to_game
from services.topic_service import extract_topics_with_metadata

_CM_MIN_POSTS = 3
_CM_MIN_AUTHORS = 3
_CM_MIN_DAYS = 2


def _post_text(post: RawPost) -> str:
    title = (post.title or "").strip()
    body = (post.body or "").strip()
    return f"{title}\n{body}".strip()


def rebuild_for_game(game_name: str) -> None:
    db: Session = SessionLocal()
    try:
        game = db.query(Game).filter(Game.name == game_name).first()
        if not game:
            print(f"ERROR: game '{game_name}' not found")
            sys.exit(1)
        print(f"=== Rebuilding topics for '{game.name}' (id={game.id}) ===")
        kws = game.distinctive_keywords or []
        print(f"§14 keywords: {kws}")

        # Fetch all (post, sentiment) pairs
        effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)
        rows = (
            db.query(RawPost, SentimentRecord)
            .join(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
            .filter(RawPost.game_id == game.id)
            .all()
        )
        print(f"Loaded {len(rows)} (post, sentiment) pairs")

        # §14 relevance filter
        relevant_rows = []
        excluded = 0
        for post, sr in rows:
            if is_post_relevant_to_game(post.title or "", post.body or "", game):
                relevant_rows.append((post, sr))
            else:
                excluded += 1
        print(f"§14 filter: {excluded}/{len(rows)} posts excluded as irrelevant")
        print(f"§14 filter: {len(relevant_rows)} posts retained")

        # Reset all SentimentRecord.topics for irrelevant posts to []
        irrelevant_ids = {sr.id for post, sr in rows} - {sr.id for post, sr in relevant_rows}
        if irrelevant_ids:
            db.query(SentimentRecord).filter(
                SentimentRecord.id.in_(irrelevant_ids)
            ).update({"topics": []}, synchronize_session=False)
            print(f"Cleared topics on {len(irrelevant_ids)} irrelevant SentimentRecord rows")

        # Group by (day, sentiment)
        by_day_sent = defaultdict(lambda: {"posts": [], "texts": [], "authors": [], "days": []})
        for post, sr in relevant_rows:
            eff_dt = post.post_date or post.collected_at
            if not eff_dt:
                continue
            day = eff_dt.date()
            sent = sr.sentiment.value
            key = (day, sent)
            txt = _post_text(post)
            if not txt:
                continue
            by_day_sent[key]["posts"].append((post, sr))
            by_day_sent[key]["texts"].append(txt)
            by_day_sent[key]["authors"].append(post.author or "anonymous")
            by_day_sent[key]["days"].append(day.isoformat())

        print(f"Day×sentiment buckets: {len(by_day_sent)}")

        # Track topic_trends to upsert: dict[(date, sentiment)] -> list[label]
        trends_to_upsert = {}
        # Track per-post topics: dict[sr_id] -> list[label]
        sr_topics: dict[int, list[str]] = {}

        for (day, sent), bucket in by_day_sent.items():
            if not bucket["texts"]:
                continue
            try:
                clusters = extract_topics_with_metadata(
                    bucket["texts"], bucket["authors"], bucket["days"]
                )
            except Exception as e:
                print(f"  WARN: extract failed for {day} {sent}: {e}")
                continue

            # §15 critical-mass gate
            passed_labels = []
            for c in clusters:
                pc = c["post_count"]
                ac = len(c["author_ids"])
                dc = len(c["day_set"])
                if pc >= _CM_MIN_POSTS and ac >= _CM_MIN_AUTHORS and dc >= _CM_MIN_DAYS:
                    passed_labels.append(c["label"])

            trends_to_upsert[(day, sent)] = passed_labels
            # Assign these labels to every SentimentRecord in this bucket
            for _post, sr in bucket["posts"]:
                sr_topics[sr.id] = passed_labels

        # Apply per-post topic updates
        for sr_id, labels in sr_topics.items():
            db.query(SentimentRecord).filter(SentimentRecord.id == sr_id).update(
                {"topics": labels}, synchronize_session=False
            )
        print(f"Updated topics on {len(sr_topics)} relevant SentimentRecord rows")

        # Delete then re-insert topic_trends for this game
        deleted = (
            db.query(TopicTrend)
            .filter(TopicTrend.game_id == game.id)
            .delete(synchronize_session=False)
        )
        print(f"Deleted {deleted} old topic_trends rows")

        # Aggregate per-(label, sentiment) trend rows: first_seen, last_seen, mention_count.
        # Schema enforces UNIQUE(game_id, topic_label, sentiment), so we collapse across days.
        agg: dict[tuple[str, str], dict] = {}
        for (day, sent), labels in trends_to_upsert.items():
            if not labels:
                continue
            mention_count_day = len(by_day_sent[(day, sent)]["posts"])
            for label in labels:
                key = (label, sent)
                if key not in agg:
                    agg[key] = {
                        "first_seen": day,
                        "last_seen": day,
                        "mention_count": mention_count_day,
                    }
                else:
                    a = agg[key]
                    if day < a["first_seen"]:
                        a["first_seen"] = day
                    if day > a["last_seen"]:
                        a["last_seen"] = day
                    a["mention_count"] += mention_count_day

        inserted = 0
        for (label, sent), a in agg.items():
            tt = TopicTrend(
                game_id=game.id,
                topic_label=label,
                sentiment=SentimentEnum(sent),
                first_seen=a["first_seen"],
                last_seen=a["last_seen"],
                mention_count=a["mention_count"],
                trend_direction=TrendDirectionEnum.stable,
                velocity=0.0,
            )
            db.add(tt)
            inserted += 1
        print(f"Inserted {inserted} new topic_trends rows")

        db.commit()
        print("=== Commit OK ===")
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python rebuild_topics_for_game.py <game name>")
        sys.exit(1)
    rebuild_for_game(sys.argv[1])
