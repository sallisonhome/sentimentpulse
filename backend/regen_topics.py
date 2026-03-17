"""
One-shot script: re-humanize all topic_trends labels that look like raw
keyword clusters (contain " + "), replacing them with plain-English labels
via the Claude API.

When multiple raw labels map to the same human label, the rows are merged
(mention counts summed, earliest first_seen and latest last_seen kept).

Run from the backend/ directory:
    python regen_topics.py
"""
from database import SessionLocal
from models import Game, TopicTrend, SentimentEnum, TrendDirectionEnum
from services.topic_service import _call_claude_humanize
from datetime import date


def main() -> None:
    db = SessionLocal()

    games = db.query(Game).all()
    total_updated = 0
    total_merged = 0
    total_skipped = 0

    for game in games:
        trends = db.query(TopicTrend).filter_by(game_id=game.id).all()
        raw_trends = [t for t in trends if " + " in t.topic_label]

        if not raw_trends:
            continue

        raw_labels = list({t.topic_label for t in raw_trends})
        print(f"'{game.name}': {len(raw_labels)} raw label(s) to humanize...")

        try:
            mapping = _call_claude_humanize(game.name, raw_labels)
        except Exception as exc:
            print(f"  ERROR: {exc}")
            total_skipped += len(raw_labels)
            continue

        # Group raw trends by their new human label + sentiment
        # key: (new_label, sentiment) → list of TopicTrend rows
        groups: dict[tuple[str, SentimentEnum], list[TopicTrend]] = {}
        for trend in raw_trends:
            new_label = mapping.get(trend.topic_label, trend.topic_label)
            key = (new_label, trend.sentiment)
            groups.setdefault(key, []).append(trend)

        for (new_label, sentiment), group_rows in groups.items():
            # Check if a row with this human label already exists (from a prior run)
            existing = db.query(TopicTrend).filter_by(
                game_id=game.id,
                topic_label=new_label,
                sentiment=sentiment,
            ).first()

            if existing and existing not in group_rows:
                # Merge all group rows into existing, then delete group rows
                existing.mention_count += sum(r.mention_count for r in group_rows)
                existing.first_seen = min(r.first_seen for r in [existing] + group_rows)
                existing.last_seen = max(r.last_seen for r in [existing] + group_rows)
                for r in group_rows:
                    db.delete(r)
                total_merged += len(group_rows)
            elif len(group_rows) == 1:
                # Simple rename
                group_rows[0].topic_label = new_label
                total_updated += 1
            else:
                # Multiple raw rows → merge into the first, delete the rest
                primary = group_rows[0]
                primary.topic_label = new_label
                primary.mention_count = sum(r.mention_count for r in group_rows)
                primary.first_seen = min(r.first_seen for r in group_rows)
                primary.last_seen = max(r.last_seen for r in group_rows)
                for r in group_rows[1:]:
                    db.delete(r)
                total_updated += 1
                total_merged += len(group_rows) - 1

        try:
            db.commit()
            print(f"  Done.")
        except Exception as exc:
            db.rollback()
            print(f"  COMMIT ERROR: {exc}")

    db.close()
    print(f"\nDone. {total_updated} label(s) renamed, {total_merged} duplicate(s) merged, {total_skipped} skipped.")


if __name__ == "__main__":
    main()
