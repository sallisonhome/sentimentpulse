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
    CompetitorGame,
    DailySummary,
    Game,
    RawPost,
    SentimentEnum,
    SentimentRecord,
    TopicTrend,
)
from schemas import (
    CompetitorTimeseriesDay,
    CompetitorTimeseriesGame,
    CompetitorTimeseriesResponse,
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
    # v2 (2026-07-24): windows are inclusive of both endpoints, so an
    # N-day window covers [today - (N-1), today]. The old formulation
    # (today - N days) was OFF-BY-ONE and rolled up 8 days for 'weekly',
    # 31 for 'monthly', 91 for 'quarterly'. This diverged from the
    # window-summary service which correctly uses days-1 offsets, causing
    # the dashboard 7d KPI to sum 551 posts while the Summary page 7d
    # showed 455. Now both aggregate the same 7/30/90 days.
    today = date.today()
    return {
        PeriodEnum.today:     today,
        PeriodEnum.weekly:    today - timedelta(days=6),
        PeriodEnum.monthly:   today - timedelta(days=29),
        PeriodEnum.quarterly: today - timedelta(days=89),
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
    # v3 (2026-07-24): count sentiment directly from SentimentRecord instead
    # of aggregating DailySummary rows. Historically the KPI read from
    # DailySummary and the volume chart read from RawPost, and after any
    # data-quality operation (relevance purge, low-substance purge,
    # keyword tightening) that mutated SentimentRecord without regenerating
    # DailySummary the two would silently disagree. Now the KPI, trend,
    # volume chart, and Summary-page window-summary all count exactly the
    # same rows: the current live set of SentimentRecords for the game
    # in the period window, joined through RawPost.post_date/collected_at
    # for period scoping.
    effective_date_expr = func.coalesce(RawPost.post_date, RawPost.collected_at)
    kpi_q = (
        db.query(SentimentRecord.sentiment, func.count(SentimentRecord.id))
        .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
        .filter(RawPost.game_id == game_id)
    )
    if p_start is not None:
        kpi_q = kpi_q.filter(func.date(effective_date_expr) >= str(p_start))
    kpi_rows = kpi_q.group_by(SentimentRecord.sentiment).all()

    pos = neg = neu = 0
    for sentiment_enum, cnt in kpi_rows:
        v = sentiment_enum.value if hasattr(sentiment_enum, "value") else sentiment_enum
        if v == "positive":
            pos = int(cnt)
        elif v == "negative":
            neg = int(cnt)
        elif v == "neutral":
            neu = int(cnt)
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
    # v3 (2026-07-24): compute trend directly from SentimentRecord (per-day
    # rollup) instead of reading pre-aggregated DailySummary rows. Keeps
    # trend consistent with the KPI/volume numbers on the same page even
    # when DailySummary is stale.
    trend_day_expr = func.date(effective_date_expr).label("day")
    trend_rows_q = (
        db.query(trend_day_expr, SentimentRecord.sentiment, func.count(SentimentRecord.id))
        .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
        .filter(RawPost.game_id == game_id)
    )
    if p_start:
        trend_rows_q = trend_rows_q.filter(func.date(effective_date_expr) >= str(p_start))
    trend_rows = trend_rows_q.group_by(trend_day_expr, SentimentRecord.sentiment).order_by(trend_day_expr).all()

    trend_map: dict[date, dict[str, int]] = {}
    for day_val, sentiment_enum, cnt in trend_rows:
        d = _to_date(day_val)
        entry = trend_map.setdefault(d, {"positive": 0, "negative": 0, "neutral": 0})
        v = sentiment_enum.value if hasattr(sentiment_enum, "value") else sentiment_enum
        entry[v] = int(cnt)

    trend = []
    for d in sorted(trend_map.keys()):
        counts = trend_map[d]
        s_total = counts["positive"] + counts["negative"] + counts["neutral"]
        net = (counts["positive"] - counts["negative"]) / s_total if s_total else 0.0
        trend.append(NetSentimentPoint(
            summary_date=d,
            net_sentiment=round(net, 4),
            positive_count=counts["positive"],
            negative_count=counts["negative"],
            neutral_count=counts["neutral"],
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
    # Use post_date (when the post was actually made) where available,
    # falling back to collected_at for sources without post_date.
    # Posts always appear on the day they were originally posted.
    # (effective_date_expr is defined above in the KPI block — reuse it.)
    day_expr = func.date(effective_date_expr).label("day")
    # v2 (2026-07-24): INNER JOIN against SentimentRecord so this chart
    # counts ONLY posts that survived the relevance gate. Previous behavior
    # counted all RawPost rows for the game, which meant the chart showed
    # 260 raw posts for Hellraiser today while the KPI card correctly
    # showed 1 sentiment-classified post. That mismatch is the entire
    # class of bug the user called out: 'the numbers MUST MATCH'.
    # By construction, a RawPost has a SentimentRecord iff it passed the
    # relevance gate at Step 5. Joining here makes the chart consistent
    # with the KPI/trend/topics data on the same dashboard.
    vol_q = (
        db.query(
            day_expr,
            RawPost.source,
            func.count(RawPost.id).label("cnt"),
        )
        .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
        .filter(RawPost.game_id == game_id)
    )
    if p_start:
        vol_q = vol_q.filter(func.date(effective_date_expr) >= str(p_start))

    vol_rows = (
        vol_q
        .group_by(day_expr, RawPost.source)
        .order_by(day_expr)
        .all()
    )

    vol_map: dict[date, dict[str, int]] = {}
    for row in vol_rows:
        d = _to_date(row.day)
        vol_map.setdefault(d, {"steam_review": 0, "steam_forum": 0, "reddit": 0, "bluesky": 0})
        vol_map[d][row.source.value] = row.cnt

    volume_points = [
        VolumePoint(
            day=d,
            steam_review=counts.get("steam_review", 0),
            steam_forum=counts.get("steam_forum", 0),
            reddit=counts.get("reddit", 0),
            bluesky=counts.get("bluesky", 0),
            total=sum(counts.values()),
        )
        for d, counts in sorted(vol_map.items())
    ]

    # ── 5. Sentiment velocity (based on Positive/Negative Ratio trend) ────────
    # For "Today": compare today's ratio vs yesterday's.
    # For longer periods: compare first half vs second half of the period.
    # v3 (2026-07-24): reuse the trend_map already built from SentimentRecord
    # (section 2 above) so velocity, KPI, and volume are all consistent.
    # For period=today we need today + yesterday specifically; that
    # information is in trend_map if the trend query's window covered it,
    # but trend_map for period=today only includes today. Re-query for
    # yesterday when needed.
    if period == PeriodEnum.today:
        yesterday = today - timedelta(days=1)
        y_rows = (
            db.query(SentimentRecord.sentiment, func.count(SentimentRecord.id))
            .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
            .filter(
                RawPost.game_id == game_id,
                func.date(effective_date_expr) == str(yesterday),
            )
            .group_by(SentimentRecord.sentiment)
            .all()
        )
        y_counts = {"positive": 0, "negative": 0}
        for sentiment_enum, cnt in y_rows:
            v = sentiment_enum.value if hasattr(sentiment_enum, "value") else sentiment_enum
            if v in y_counts:
                y_counts[v] = int(cnt)

        daily_pcts = []
        # Yesterday
        y_total = y_counts["positive"] + y_counts["negative"]
        if y_total > 0:
            daily_pcts.append(y_counts["positive"] / y_total)
        # Today (from trend_map or from KPI counts if not in trend_map)
        t_total = pos + neg
        if t_total > 0:
            daily_pcts.append(pos / t_total)
    else:
        # Longer periods: derive daily pos/neg percentages from trend_map.
        daily_pcts = []
        for d in sorted(trend_map.keys()):
            counts = trend_map[d]
            pn = counts["positive"] + counts["negative"]
            if pn > 0:
                daily_pcts.append(counts["positive"] / pn)

    if len(daily_pcts) >= 2:
        # Split into first half and second half, compare averages
        mid = len(daily_pcts) // 2
        first_half_avg = sum(daily_pcts[:mid]) / mid if mid > 0 else 0
        second_half_avg = sum(daily_pcts[mid:]) / len(daily_pcts[mid:]) if len(daily_pcts[mid:]) > 0 else 0
        avg_delta = second_half_avg - first_half_avg
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



# ── Competitor timeseries (cross-title comparison chart) ──────────────────────

@router.get(
    "/{parent_id}/competitor-timeseries",
    response_model=CompetitorTimeseriesResponse,
)
def get_competitor_timeseries(
    parent_id: int,
    period: PeriodEnum = Query(PeriodEnum.weekly),
    db: Session = Depends(get_db),
):
    """
    Daily post-volume comparison across a parent Saber title and its
    tracked competitors, for the "Post Volume by Title" chart on the
    parent's dashboard.

    Uses the exact same aggregation pattern as the Post Volume by Source
    chart above (INNER JOIN SentimentRecord, so only relevance-gate-passing
    posts are counted; effective_date = COALESCE(post_date, collected_at);
    same _period_start() windowing) but groups by game_id instead of
    source, across the parent + all of its competitors.

    Always returns HTTP 200, including when the parent has zero
    competitors — in that case `games` contains only the parent and
    `timeseries` reflects the parent's own daily counts. The frontend
    treats `games.length > 1` as the "show this chart" signal.
    """
    parent = db.query(Game).filter_by(id=parent_id).first()
    if not parent:
        raise HTTPException(status_code=404, detail=f"Game {parent_id} not found.")

    competitor_rows = (
        db.query(Game)
        .join(CompetitorGame, CompetitorGame.competitor_id == Game.id)
        .filter(CompetitorGame.parent_id == parent_id)
        .order_by(CompetitorGame.id.asc())
        .all()
    )

    games_in_group = [parent] + list(competitor_rows)
    game_ids = [g.id for g in games_in_group]

    p_start = _period_start(period)
    effective_date_expr = func.coalesce(RawPost.post_date, RawPost.collected_at)
    day_expr = func.date(effective_date_expr).label("day")

    ts_q = (
        db.query(
            day_expr,
            RawPost.game_id,
            func.count(RawPost.id).label("cnt"),
        )
        .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
        .filter(RawPost.game_id.in_(game_ids))
    )
    if p_start:
        ts_q = ts_q.filter(func.date(effective_date_expr) >= str(p_start))

    ts_rows = ts_q.group_by(day_expr, RawPost.game_id).order_by(day_expr).all()

    # Fill zero-count days: every day that appears for ANY game in the
    # group gets an entry for EVERY game in the group (default 0).
    day_map: dict[date, dict[int, int]] = {}
    for row in ts_rows:
        d = _to_date(row.day)
        day_map.setdefault(d, {gid: 0 for gid in game_ids})
        day_map[d][row.game_id] = row.cnt

    timeseries = [
        CompetitorTimeseriesDay(
            day=d,
            counts={str(gid): counts.get(gid, 0) for gid in game_ids},
        )
        for d, counts in sorted(day_map.items())
    ]

    games_out = [
        CompetitorTimeseriesGame(game_id=g.id, name=g.name, is_parent=(g.id == parent_id))
        for g in games_in_group
    ]

    return CompetitorTimeseriesResponse(games=games_out, timeseries=timeseries)
