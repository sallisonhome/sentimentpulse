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
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from database import get_db
from models import (
    CompetitorGame,
    DailySummary,
    Game,
    RawPost,
    SentimentEnum,
    SentimentRecord,
)
from schemas import (
    CompetitorTimeseriesDay,
    CompetitorTimeseriesEvent,
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
    # 2026-07-27 fix: previously we fell back to collected_at when post_date
    # was NULL. That silently bucketed legacy-scraper NULL-date Steam Forum
    # rows (from an older scraper version whose external_ids were
    # 'forum_{thread_id}_{page_num}' instead of the current
    # 'forum_{thread_id}_op' + '..._c{comment_id}' scheme) into the day
    # they were RE-SCRAPED, producing phantom 100-200 post spikes every
    # time the incremental cron ran (Hellraiser 7/26=187, ILL 7/27=202,
    # Halloween 7/27=208, and thousands more across SM2/SnowRunner/Halo MCC).
    # Now we use only post_date and skip rows without a real timestamp.
    # The corrupted RawPost rows stay in the DB for audit, but their
    # SentimentRecords no longer produce fake daily activity.
    effective_date_expr = RawPost.post_date
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

    # Zero-fill every day in the window so a sparse title still renders a
    # continuous line (matches Post Volume by Title behavior on the parent
    # dashboard). Without this, a title with only a couple of active days
    # renders as disconnected points and the chart looks broken — the fix
    # asked for on 2026-07-25 for the ILL child dashboard's 7d/30d/90d/All
    # views. Lifetime (p_start is None) still uses observed days only
    # (zero-filling from the first-ever post to today can be years).
    if p_start is not None:
        cursor = p_start
        today_local = date.today()
        while cursor <= today_local:
            trend_map.setdefault(cursor, {"positive": 0, "negative": 0, "neutral": 0})
            cursor += timedelta(days=1)

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
    # v4 (2026-07-28): the previous implementation read the game-wide
    # TopicTrend table which is not scoped to the selected period AND was
    # returning empty across every game, leaving the dashboard "Top Topics"
    # widget blank. Rebuilt to mirror the Summary page's proven
    # DailySummary-aggregation path (see period_summary_service._weighted_top),
    # scoped independently to the dashboard's currently-selected period
    # window. Each day's rank-ordered top-N contributes weighted votes
    # (rank 1=5, 2=4, 3=3, 4=2, 5=1) so a topic that ranks #1 for multiple
    # days outranks one that ranks low on many days — this is "dynamically
    # weighted by volume of conversation" over the filtered range. Falls
    # back to per-post SentimentRecord.topics when the window has no
    # DailySummary rows yet (cold-start / same-day-first-ingest case).

    ds_q = db.query(DailySummary).filter(DailySummary.game_id == game_id)
    if p_start is not None:
        ds_q = ds_q.filter(DailySummary.summary_date >= p_start)
    # Cap the window at today so future-dated rows (if any) never leak in.
    ds_q = ds_q.filter(DailySummary.summary_date <= today)
    _ds_rows = ds_q.all()

    _sentiment_to_attr = {
        SentimentEnum.positive: "top_positive_topics",
        SentimentEnum.negative: "top_negative_topics",
        SentimentEnum.neutral:  "top_neutral_topics",
    }

    def _weighted_daily_top(sentiment: SentimentEnum) -> list[tuple[str, float, int]]:
        """Return [(label, weight, day_appearances), ...] for the window."""
        attr = _sentiment_to_attr[sentiment]
        freq: dict[str, float] = {}
        days: dict[str, int] = {}
        for row in _ds_rows:
            topics = getattr(row, attr, None) or []
            seen_this_row: set[str] = set()
            for rank, topic in enumerate(topics[:5]):
                if not topic or not isinstance(topic, str):
                    continue
                # Rank weight: 5,4,3,2,1 — #1 gets 5 votes, #5 gets 1.
                freq[topic] = freq.get(topic, 0.0) + (5 - rank)
                if topic not in seen_this_row:
                    days[topic] = days.get(topic, 0) + 1
                    seen_this_row.add(topic)
        return sorted(
            [(label, w, days.get(label, 0)) for label, w in freq.items()],
            key=lambda x: -x[1],
        )

    def _record_top(sentiment: SentimentEnum) -> list[tuple[str, float, int]]:
        """Cold-start fallback: aggregate per-post SentimentRecord.topics
        directly across the window. Each mention is worth 1 vote."""
        q = (
            db.query(SentimentRecord.topics)
            .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
            .filter(
                RawPost.game_id == game_id,
                SentimentRecord.sentiment == sentiment,
            )
        )
        if p_start is not None:
            q = q.filter(func.date(effective_date_expr) >= str(p_start))
        freq: dict[str, int] = {}
        for (topics,) in q.all():
            for topic in (topics or []):
                if not topic or not isinstance(topic, str):
                    continue
                freq[topic] = freq.get(topic, 0) + 1
        return sorted(
            [(label, float(cnt), 0) for label, cnt in freq.items()],
            key=lambda x: -x[1],
        )

    def _top_topics(sentiment: SentimentEnum, limit: int = 3) -> list[TopicItem]:
        ranked = _weighted_daily_top(sentiment)
        if not ranked:
            ranked = _record_top(sentiment)
        return [
            TopicItem(
                topic_label=label,
                # Weight rounded to int so the widget's bar chart and the
                # numeric badge ("324") both render as whole counts of
                # "conversation weight" over the window.
                mention_count=int(round(weight)),
                # Trend arrow is per-widget cosmetic — we don't have
                # rank-over-rank history here, so mark stable. The
                # ordering already reflects dynamic volume weighting.
                trend_direction="stable",
                velocity=0.0,
            )
            for label, weight, _days in ranked[:limit]
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
        vol_map.setdefault(d, {"steam_review": 0, "steam_forum": 0, "reddit": 0, "bluesky": 0, "dtf": 0})
        vol_map[d][row.source.value] = row.cnt

    # Same zero-fill treatment as the trend chart above — sparse titles
    # otherwise render a handful of disconnected bars across a wide
    # window, hiding the "nothing collected on this day" signal.
    if p_start is not None:
        cursor = p_start
        today_local = date.today()
        while cursor <= today_local:
            vol_map.setdefault(cursor, {"steam_review": 0, "steam_forum": 0, "reddit": 0, "bluesky": 0, "dtf": 0})
            cursor += timedelta(days=1)

    volume_points = [
        VolumePoint(
            day=d,
            steam_review=counts.get("steam_review", 0),
            steam_forum=counts.get("steam_forum", 0),
            reddit=counts.get("reddit", 0),
            bluesky=counts.get("bluesky", 0),
            dtf=counts.get("dtf", 0),
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
    # 2026-07-27 fix: previously we fell back to collected_at when post_date
    # was NULL. That silently bucketed legacy-scraper NULL-date Steam Forum
    # rows (from an older scraper version whose external_ids were
    # 'forum_{thread_id}_{page_num}' instead of the current
    # 'forum_{thread_id}_op' + '..._c{comment_id}' scheme) into the day
    # they were RE-SCRAPED, producing phantom 100-200 post spikes every
    # time the incremental cron ran (Hellraiser 7/26=187, ILL 7/27=202,
    # Halloween 7/27=208, and thousands more across SM2/SnowRunner/Halo MCC).
    # Now we use only post_date and skip rows without a real timestamp.
    # The corrupted RawPost rows stay in the DB for audit, but their
    # SentimentRecords no longer produce fake daily activity.
    effective_date_expr = RawPost.post_date
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

    # Period-over-period totals (2026-07-26).
    # For 7d / 30d / 90d views, compute total posts per game over both
    # the current window and the immediately preceding same-length
    # window, then surface a signed pct_change so the chart legend can
    # show a ▲/▼ chip next to each title's name. Skipped for `today`
    # (single day, comparing to yesterday is misleading given the
    # in-progress day) and `lifetime` (no comparable prior window).
    pct_window_days = {
        PeriodEnum.weekly: 7,
        PeriodEnum.monthly: 30,
        PeriodEnum.quarterly: 90,
    }.get(period)

    current_totals: dict[int, int] = {gid: 0 for gid in game_ids}
    prev_totals: dict[int, int] = {gid: 0 for gid in game_ids}

    if pct_window_days is not None:
        today_d = date.today()
        curr_start = today_d - timedelta(days=pct_window_days - 1)
        curr_end = today_d
        prev_end = curr_start - timedelta(days=1)
        prev_start = prev_end - timedelta(days=pct_window_days - 1)

        # Query both windows in a single pass by grouping on a CASE that
        # tags each row as 'curr' or 'prev'. Rows outside both windows
        # are filtered out by the outer date range. Same INNER JOIN on
        # SentimentRecord as the main timeseries query so the totals are
        # apples-to-apples with what the chart lines add up to.
        window_case = case(
            (func.date(effective_date_expr) >= str(curr_start), "curr"),
            else_="prev",
        ).label("win")
        pop_q = (
            db.query(
                RawPost.game_id,
                window_case,
                func.count(RawPost.id).label("cnt"),
            )
            .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
            .filter(RawPost.game_id.in_(game_ids))
            .filter(func.date(effective_date_expr) >= str(prev_start))
            .filter(func.date(effective_date_expr) <= str(curr_end))
            .group_by(RawPost.game_id, window_case)
        )
        for row in pop_q.all():
            if row.win == "curr":
                current_totals[row.game_id] = row.cnt
            else:
                prev_totals[row.game_id] = row.cnt

        # Data-coverage guard (2026-07-26): the prior window must have at
        # least ~half the days worth of any ingestion activity for the
        # comparison to be meaningful. Otherwise (typically because
        # historical backfill hasn't reached that far back yet), a full
        # current window compared against a nearly-empty prior window
        # produces absurd % values (e.g. +61,000%). When coverage is
        # insufficient we clear prev_totals so pct_change collapses to
        # None (rendered as '(new)' in the chart legend, which is honest
        # about the missing baseline).
        coverage_q = (
            db.query(func.count(func.distinct(func.date(effective_date_expr))))
            .select_from(RawPost)
            .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
            .filter(RawPost.game_id.in_(game_ids))
            .filter(func.date(effective_date_expr) >= str(prev_start))
            .filter(func.date(effective_date_expr) <= str(prev_end))
        )
        prev_days_with_data = coverage_q.scalar() or 0
        min_days_required = max(3, pct_window_days // 2)
        if prev_days_with_data < min_days_required:
            # Zero out prev_totals — pct_change will resolve to None below.
            prev_totals = {gid: 0 for gid in game_ids}

    def _pct(curr: int, prev: int) -> Optional[float]:
        """Signed % change; None when prev is 0 (division undefined)."""
        if prev <= 0:
            return None
        return round(((curr - prev) / prev) * 100.0, 1)

    games_out = [
        CompetitorTimeseriesGame(
            game_id=g.id,
            name=g.name,
            is_parent=(g.id == parent_id),
            current_total=(current_totals[g.id] if pct_window_days is not None else None),
            prev_total=(prev_totals[g.id] if pct_window_days is not None else None),
            pct_change=(_pct(current_totals[g.id], prev_totals[g.id])
                        if pct_window_days is not None else None),
        )
        for g in games_in_group
    ]

    # Timeline events overlay (2026-07-26). Pull events for every game in
    # the group, filtered to the same window as the timeseries. Events
    # OUTSIDE the window are silently omitted — the settings UI still
    # shows them so the user can see they're stored, but they won't
    # render on this chart until the period widens to include them.
    from models import TimelineEvent  # local import: avoids cycles
    ev_q = db.query(TimelineEvent).filter(TimelineEvent.game_id.in_(game_ids))
    if p_start:
        ev_q = ev_q.filter(TimelineEvent.event_date >= p_start)
    events_out = [
        CompetitorTimeseriesEvent(
            id=e.id, game_id=e.game_id, event_date=e.event_date, name=e.name,
        )
        for e in ev_q.order_by(TimelineEvent.event_date.asc()).all()
    ]

    return CompetitorTimeseriesResponse(
        games=games_out, timeseries=timeseries, events=events_out,
    )
