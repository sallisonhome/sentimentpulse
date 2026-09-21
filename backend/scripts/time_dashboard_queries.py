"""Time each dashboard aggregation query individually.

One-shot diagnostic: reads sentimentpulse.db (same file the API uses),
times each of the ~8 queries that _compute_dashboard fires for a single
(game, period) request, prints per-query elapsed and EXPLAIN QUERY PLAN
for the ones most likely to still be slow after migration 0020.

Read-only; safe to run in production. Delete after use.
"""
import sys
import time
from datetime import date, timedelta

sys.path.insert(0, "/opt/sentimentpulse/backend")

from sqlalchemy import create_engine, func, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from models import (  # noqa: E402
    DailySummary,
    Game,
    RawPost,
    SentimentRecord,
)


GAME_ID = 21  # Hellraiser: Revival

_NOT_DRIFT = RawPost.is_off_topic_drift.is_(False)

engine = create_engine("sqlite:///sentimentpulse.db")
db = Session(engine)


def t(name, fn):
    start = time.monotonic()
    result = fn()
    elapsed = time.monotonic() - start
    if isinstance(result, list):
        rows = f"{len(result)} rows"
    elif result is None:
        rows = "None"
    else:
        rows = str(result)
    print(f"  {name}: {elapsed:.2f}s ({rows})")
    return elapsed


print("=" * 60)
print(f"  Per-query timing on Hellraiser (game_id={GAME_ID}), lifetime")
print("=" * 60)

t("1. Game lookup",
  lambda: db.query(Game).filter_by(id=GAME_ID).first())

t("2. KPI (sentiment counts, no date filter)", lambda: (
    db.query(SentimentRecord.sentiment, func.count(SentimentRecord.id))
    .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
    .filter(RawPost.game_id == GAME_ID)
    .filter(RawPost.post_date.isnot(None))
    .filter(_NOT_DRIFT)
    .group_by(SentimentRecord.sentiment).all()
))

trend_day_expr = func.date(RawPost.post_date).label("day")
t("3. Trend (per-day sentiment, no date filter)", lambda: (
    db.query(trend_day_expr, SentimentRecord.sentiment, func.count(SentimentRecord.id))
    .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
    .filter(RawPost.game_id == GAME_ID)
    .filter(RawPost.post_date.isnot(None))
    .filter(_NOT_DRIFT)
    .group_by(trend_day_expr, SentimentRecord.sentiment)
    .order_by(trend_day_expr).all()
))

t("4. DailySummary rows",
  lambda: db.query(DailySummary)
            .filter(DailySummary.game_id == GAME_ID)
            .filter(DailySummary.summary_date <= date.today()).all())

t("5. SentimentRecord.topics (topics fallback)", lambda: (
    db.query(SentimentRecord.topics)
    .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
    .filter(RawPost.game_id == GAME_ID)
    .filter(RawPost.post_date.isnot(None))
    .filter(_NOT_DRIFT).all()
))

day_expr = func.date(RawPost.post_date).label("day")
t("6. Volume by (day, source)", lambda: (
    db.query(day_expr, RawPost.source, func.count(RawPost.id).label("cnt"))
    .filter(RawPost.game_id == GAME_ID)
    .filter(RawPost.post_date.isnot(None))
    .group_by(day_expr, RawPost.source).all()
))

t("7. Volume total by day", lambda: (
    db.query(day_expr, func.count(RawPost.id).label("cnt"))
    .filter(RawPost.game_id == GAME_ID)
    .filter(RawPost.post_date.isnot(None))
    .group_by(day_expr).all()
))

today = date.today()
recent_start = today - timedelta(days=7)
t("8. Velocity recent 7d (with date filter)", lambda: (
    db.query(SentimentRecord.sentiment, func.count(SentimentRecord.id))
    .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
    .filter(RawPost.game_id == GAME_ID)
    .filter(RawPost.post_date.isnot(None))
    .filter(_NOT_DRIFT)
    .filter(func.date(RawPost.post_date) >= str(recent_start))
    .group_by(SentimentRecord.sentiment).all()
))

print()
print("=" * 60)
print("  EXPLAIN QUERY PLAN for the slowest three")
print("=" * 60)

QUERIES = [
    ("Q2 KPI (no date filter, lifetime shape)",
     "SELECT sr.sentiment, COUNT(sr.id) "
     "FROM sentiment_records sr JOIN raw_posts rp ON sr.raw_post_id=rp.id "
     "WHERE rp.game_id=21 AND rp.post_date IS NOT NULL AND rp.is_off_topic_drift=0 "
     "GROUP BY sr.sentiment"),
    ("Q3 Trend group by day",
     "SELECT DATE(rp.post_date), sr.sentiment, COUNT(sr.id) "
     "FROM sentiment_records sr JOIN raw_posts rp ON sr.raw_post_id=rp.id "
     "WHERE rp.game_id=21 AND rp.post_date IS NOT NULL AND rp.is_off_topic_drift=0 "
     "GROUP BY DATE(rp.post_date), sr.sentiment"),
    ("Q5 Topics fallback",
     "SELECT sr.topics FROM sentiment_records sr JOIN raw_posts rp ON sr.raw_post_id=rp.id "
     "WHERE rp.game_id=21 AND rp.post_date IS NOT NULL AND rp.is_off_topic_drift=0"),
    ("Q6 Volume by source",
     "SELECT DATE(rp.post_date), rp.source, COUNT(rp.id) FROM raw_posts rp "
     "WHERE rp.game_id=21 AND rp.post_date IS NOT NULL "
     "GROUP BY DATE(rp.post_date), rp.source"),
    ("Q8 Velocity 7d (with date filter)",
     "SELECT sr.sentiment, COUNT(sr.id) "
     "FROM sentiment_records sr JOIN raw_posts rp ON sr.raw_post_id=rp.id "
     "WHERE rp.game_id=21 AND rp.post_date IS NOT NULL AND rp.is_off_topic_drift=0 "
     "AND DATE(rp.post_date) >= '" + str(recent_start) + "' "
     "GROUP BY sr.sentiment"),
]

with engine.connect() as conn:
    for label, sql in QUERIES:
        print()
        print(f"-- {label}")
        for row in conn.execute(text("EXPLAIN QUERY PLAN " + sql)).fetchall():
            print(f"  {row}")

print()
print("done.")
