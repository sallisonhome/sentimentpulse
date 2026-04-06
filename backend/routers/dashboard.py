"""
Dashboard router — GET /api/games/{game_id}/dashboard

Returns all KPI data for a single game over the requested time period:
  - Today's sentiment counts (donut chart)
  - Net sentiment trend (line chart)
  - Top 3 topics per sentiment (cards)
  - Post volume by source per day (stacked bar)
  - Sentiment velocity (momentum gauge)
"""
import logging
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from models import (
    DailySummary,
    Game,
    RawPost,
    SentimentEnum,
    SentimentRecord,
    TopicTrend,
)
from schemas import (
    DashboardResponse,
    NetSentimentPoint,
    PeriodEnum,
    SentimentCounts,
    SentimentVelocity,
    TopicItem,
    VolumePoint,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/games", tags=["dashboard"])


# ── Helper ────────────────────────────────────────────────────────────────────

def _period_start(period: PeriodEnum) -> Optional[date]:
    today = date.today()
    return {
        PeriodEnum.today:     today,
        PeriodEnum.weekly:    today - timedelta(days=7),
        PeriodEnum.monthly:   today - timedelta(days=30),
        PeriodEnum.quarterly: today - timedelta(days=90),
        PeriodEnum.lifetime:  None,
    }[period]


def _to_date(val) -> date:
    """Normalise SQLite date strings or Python date objects to date."""
    if isinstance(val, date):
        return val
    return date.fromisoformat(str(val)[:10])


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/{game_id}/dashboard", response_model=DashboardResponse)
def get_dashboard(
    game_id: int,
    period: PeriodEnum = Query(PeriodEnum.weekly),
    db: Session = Depends(get_db),
):
    game = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found.")

    p_start = _period_start(period)
    today = date.today()

    # ── 1. Period-aggregated sentiment counts ─────────────────────────────────
    # Sum daily summary counts across all days in the selected period so that
    # KPI cards reflect the correct totals for the chosen time range.
    agg_q = db.query(
        func.sum(DailySummary.positive_count),
        func.sum(DailySummary.negative_count),
        func.sum(DailySummary.neutral_count),
    ).filter(DailySummary.game_id == game_id)

    if p_start is not None:
        agg_q = agg_q.filter(DailySummary.summary_date >= p_start)

    agg_row = agg_q.first()
    pos = int(agg_row[0] or 0)
    neg = int(agg_row[1] or 0)
    neu = int(agg_row[2] or 0)
    total_today = pos + neg + neu
    # Positive/Negative Ratio (excludes neutral posts)
    pos_neg_ratio = round(pos / neg, 2) if neg > 0 else (float(pos) if pos > 0 else None)

    sentiment_today = SentimentCounts(
        positive=pos,
        negative=neg,
        neutral=neu,
        total=total_today,
        positive_pct=round(pos / total_today * 100, 1) if total_today else 0.0,
        negative_pct=round(neg / total_today * 100, 1) if total_today else 0.0,
        neutral_pct=round(neu / total_today * 100, 1) if total_today else 0.0,
        pos_neg_ratio=pos_neg_ratio,
    )

    # ── 2. Net sentiment trend (from daily_summaries) ─────────────────────────
    sum_q = db.query(DailySummary).filter(DailySummary.game_id == game_id)
    if p_start:
        sum_q = sum_q.filter(DailySummary.summary_date >= p_start)
    summaries = sum_q.order_by(DailySummary.summary_date.asc()).all()

    trend = []
    for s in summaries:
        s_total = s.positive_count + s.negative_count + s.neutral_count
        net = (s.positive_count - s.negative_count) / s_total if s_total else 0.0
        trend.append(NetSentimentPoint(
            summary_date=s.summary_date,
            net_sentiment=round(net, 4),
            positive_count=s.positive_count,
            negative_count=s.negative_count,
            neutral_count=s.neutral_count,
            total=s_total,
        ))

    # ── 3. Top 3 topics per sentiment ─────────────────────────────────────────
    def _top_topics(sentiment: SentimentEnum, limit: int = 3) -> list[TopicItem]:
        rows = (
            db.query(TopicTrend)
            .filter_by(game_id=game_id, sentiment=sentiment)
            .order_by(TopicTrend.mention_count.desc())
            .limit(limit)
            .all()
        )
        return [
            TopicItem(
                topic_label=t.topic_label,
                mention_count=t.mention_count,
                trend_direction=t.trend_direction.value,
                velocity=round(t.velocity, 4),
            )
            for t in rows
        ]

    # ── 4. Volume by source per day ───────────────────────────────────────────
    # Use func.date() instead of cast(..., Date) — SQLite's CAST doesn't truncate
    # datetime strings to dates and confuses SQLAlchemy's type processors.
    day_expr = func.date(RawPost.collected_at).label("day")
    vol_q = (
        db.query(
            day_expr,
            RawPost.source,
            func.count(RawPost.id).label("cnt"),
        )
        .filter(RawPost.game_id == game_id)
        .filter(RawPost.collected_at.isnot(None))
    )
    if p_start:
        vol_q = vol_q.filter(func.date(RawPost.collected_at) >= str(p_start))

    vol_rows = (
        vol_q
        .group_by(func.date(RawPost.collected_at), RawPost.source)
        .order_by(func.date(RawPost.collected_at))
        .all()
    )

    vol_map: dict[date, dict[str, int]] = {}
    for row in vol_rows:
        d = _to_date(row.day)
        vol_map.setdefault(d, {"steam_review": 0, "steam_forum": 0, "reddit": 0})
        vol_map[d][row.source.value] = row.cnt

    volume_points = [
        VolumePoint(
            day=d,
            steam_review=counts.get("steam_review", 0),
            steam_forum=counts.get("steam_forum", 0),
            reddit=counts.get("reddit", 0),
            total=sum(counts.values()),
        )
        for d, counts in sorted(vol_map.items())
    ]

    # ── 5. Sentiment velocity (based on Positive/Negative Ratio trend) ────────
    # Calculate daily pos/neg ratios for the last 7 summary days, then measure
    # whether the ratio is improving, declining, or stable.
    recent_summaries = (
        db.query(
            DailySummary.positive_count,
            DailySummary.negative_count,
        )
        .filter(
            DailySummary.game_id == game_id,
        )
        .order_by(DailySummary.summary_date.desc())
        .limit(7)
        .all()
    )

    daily_pcts = []  # pos/(pos+neg) as a 0-1 fraction per day
    for row in recent_summaries:
        p, n = int(row[0] or 0), int(row[1] or 0)
        pn_total = p + n
        if pn_total > 0:
            daily_pcts.append(p / pn_total)

    if len(daily_pcts) >= 2:
        # Compute average day-over-day change in pos/neg percentage
        # Ratios are in desc order (newest first), so reverse for chronological
        daily_pcts.reverse()
        changes = [daily_pcts[i+1] - daily_pcts[i] for i in range(len(daily_pcts)-1)]
        avg_delta = sum(changes) / len(changes)
        direction = (
            "improving" if avg_delta > 0.01
            else "declining" if avg_delta < -0.01
            else "stable"
        )
    else:
        avg_delta = None
        direction = "stable"

    velocity = SentimentVelocity(
        direction=direction,
        delta_avg=round(avg_delta, 4) if avg_delta is not None else None,
    )

    return DashboardResponse(
        game_id=game_id,
        period=period.value,
        sentiment_today=sentiment_today,
        net_sentiment_trend=trend,
        top_positive_topics=_top_topics(SentimentEnum.positive),
        top_negative_topics=_top_topics(SentimentEnum.negative),
        top_neutral_topics=_top_topics(SentimentEnum.neutral),
        volume_by_source=volume_points,
        sentiment_velocity=velocity,
    )
