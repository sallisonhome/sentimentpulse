"""
One-shot script: regenerate AI executive summaries and recommended actions for
every game that has a DailySummary row for today, using the currently-configured
Anthropic API key.

Run from the backend/ directory:
    python regen_summaries.py

This is useful after fixing ANTHROPIC_API_KEY env-var issues to overwrite the
placeholder text without re-running the full 15-minute ingestion pipeline.
"""
import sys
from datetime import date, datetime, timedelta

from database import SessionLocal
from models import DailySummary, Game, RawPost, SentimentEnum, SentimentRecord, TopicTrend
from services.summary_service import generate_summaries
from sqlalchemy import func


def main() -> None:
    db = SessionLocal()
    today = date.today()
    day_start = datetime.combine(today, datetime.min.time())
    day_end = day_start + timedelta(days=1)

    # Target all placeholder summaries regardless of date, plus any real
    # summaries from today that may need refreshing.
    summaries = (
        db.query(DailySummary)
        .filter(
            DailySummary.executive_summary.like("[AI summary unavailable%")
        )
        .all()
    )

    if not summaries:
        print("No placeholder summaries found — all summaries already have AI content.")
        db.close()
        return

    print(f"Found {len(summaries)} placeholder summary row(s). Regenerating AI text...")

    ok = 0
    skipped = 0
    for ds in summaries:
        game: Game = db.query(Game).filter_by(id=ds.game_id).first()
        if game is None:
            continue

        total = ds.positive_count + ds.negative_count + ds.neutral_count
        if total == 0:
            skipped += 1
            continue

        # Re-fetch topic trend data for enriched prompt
        def _top_with_trend(sentiment, limit=5):
            return [
                (t.topic_label, t.trend_direction.value)
                for t in (
                    db.query(TopicTrend)
                    .filter_by(game_id=game.id, sentiment=sentiment)
                    .order_by(TopicTrend.mention_count.desc())
                    .limit(limit)
                    .all()
                )
            ]

        pos_with_trend = _top_with_trend(SentimentEnum.positive)
        neg_with_trend = _top_with_trend(SentimentEnum.negative)
        neu_with_trend = _top_with_trend(SentimentEnum.neutral)

        top_pos = [l for l, _ in pos_with_trend]
        top_neg = [l for l, _ in neg_with_trend]
        top_neu = [l for l, _ in neu_with_trend]

        print(f"  Generating for '{game.name}' (pos={ds.positive_count}, neg={ds.negative_count}, neu={ds.neutral_count})...")
        try:
            exec_summary, rec_actions = generate_summaries(
                game_name=game.name,
                top_positive_topics=top_pos,
                top_negative_topics=top_neg,
                top_neutral_topics=top_neu,
                trend_delta=ds.sentiment_trend_delta,
                total_posts=total,
                positive_with_trend=pos_with_trend,
                negative_with_trend=neg_with_trend,
                neutral_with_trend=neu_with_trend,
            )

            if exec_summary.startswith("[AI summary unavailable"):
                print(f"    WARNING: still got placeholder — API key not resolving")
                skipped += 1
                continue

            ds.executive_summary = exec_summary
            ds.recommended_actions = rec_actions
            db.commit()
            print(f"    OK ({len(exec_summary)} chars summary)")
            ok += 1
        except Exception as exc:
            print(f"    ERROR: {exc}")
            db.rollback()

    db.close()
    print(f"\nDone. {ok} updated, {skipped} skipped.")


if __name__ == "__main__":
    main()
