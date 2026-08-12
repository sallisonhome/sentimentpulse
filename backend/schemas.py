"""
Pydantic request / response models for all FastAPI endpoints.

All ORM-backed models use ConfigDict(from_attributes=True).
Enum fields are declared as str so SQLAlchemy str-enums serialise cleanly.
"""
from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


# ── Shared enums ──────────────────────────────────────────────────────────────

class PeriodEnum(str, Enum):
    today = "today"
    weekly = "weekly"
    monthly = "monthly"
    quarterly = "quarterly"
    lifetime = "lifetime"


# ── Publisher ─────────────────────────────────────────────────────────────────

class PublisherCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


class PublisherResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    created_at: datetime


# ── Games ─────────────────────────────────────────────────────────────────────

class GameResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    publisher_id: int
    steam_app_id: int
    name: str
    release_date: Optional[str] = None
    is_active: bool
    subreddits: Optional[list] = None
    # CLAUDE.md §21 commercial strategic context (per-title positioning brief)
    commercial_context: Optional[str] = None
    # CLAUDE.md §24 demographic + IP-awareness brief (per-title)
    demographic_context: Optional[str] = None
    created_at: datetime


class GameDetailResponse(GameResponse):
    """Game with its most recent daily summary attached."""
    latest_summary: Optional[DailySummaryResponse] = None


class GameSettingsUpdate(BaseModel):
    """PATCH body for toggling active flag, overriding subreddits, or
    editing the per-title commercial-strategic / demographic context briefs."""
    is_active: Optional[bool] = None
    subreddits: Optional[List[str]] = None
    # CLAUDE.md §21: pass an empty string to clear; omit to leave unchanged.
    commercial_context: Optional[str] = None
    # CLAUDE.md §24: same semantics — empty string clears, omit to leave.
    demographic_context: Optional[str] = None
    # lessons.md 2026-07-24 (evening) rule 3: operators MUST be able to tighten
    # bad auto-generated keywords BEFORE running a backfill. This field lets
    # a PATCH replace the full keyword list. Passing an empty list is
    # rejected server-side because a game without keywords cannot get
    # sentiment records (per the user's non-negotiable rule).
    distinctive_keywords: Optional[List[str]] = None


class GameCreate(BaseModel):
    """POST body for manually adding a Steam-published game.

    Use this when Steam's publisher facet excludes a legitimately-published
    title (e.g. Bus Bound app 2095420 — published by Saber Interactive Inc.
    per SteamDB but missing from the Saber Interactive facet results, so
    auto-discovery in /api/publisher won't pick it up).

    Only steam_app_id is required.  If `name` is omitted the endpoint will
    fetch it from Steam's appdetails API.  If `subreddits` is omitted the
    endpoint will run auto-discovery against Reddit.

    If `distinctive_keywords` is omitted (None), the endpoint auto-generates
    a heuristic default list via services.keyword_generator so the game is
    never created with an empty keyword list (2026-07-24 relevance gate:
    games without keywords are gated OUT of sentiment classification
    entirely). Pass an explicit list (including []) to opt out of
    auto-generation.
    """
    steam_app_id: int
    name: Optional[str] = None
    subreddits: Optional[List[str]] = None
    is_active: bool = True
    distinctive_keywords: Optional[List[str]] = None


# ── Daily Summaries ───────────────────────────────────────────────────────────

class DailySummaryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    game_id: int
    summary_date: date
    positive_count: int
    negative_count: int
    neutral_count: int
    top_positive_topics: Optional[list] = None
    top_negative_topics: Optional[list] = None
    top_neutral_topics: Optional[list] = None
    sentiment_trend_delta: Optional[float] = None
    executive_summary: Optional[str] = None
    recommended_actions: Optional[str] = None
    created_at: datetime


# ── Dashboard KPI models ──────────────────────────────────────────────────────

class SentimentCounts(BaseModel):
    positive: int
    negative: int
    neutral: int
    total: int
    positive_pct: float
    negative_pct: float
    neutral_pct: float
    pos_neg_ratio: Optional[float] = None  # positive / negative (excludes neutral)


class NetSentimentPoint(BaseModel):
    summary_date: date
    net_sentiment: float      # (positive - negative) / total  ∈ [-1, 1]
    positive_count: int
    negative_count: int
    neutral_count: int
    total: int


class TopicItem(BaseModel):
    topic_label: str
    mention_count: int
    trend_direction: str      # "rising" | "falling" | "stable"
    velocity: float


# 2026-08-05 — Concise text-summary shape for the dashboard's Top Topics
# widget. Replaces the metadata-badge TopicItem list on the dashboard
# only; Summary page keeps the fuller TopicItem shape.
class TopicSummary(BaseModel):
    label: str
    # One or two sentence supporting line. Keep it short (≤ ~140 chars).
    detail: str
    # Raw post volume for this topic across the selected period, used
    # only for ordering and for the "expand to 2" heuristic. Not shown
    # to end users.
    volume: int


class TopTopicsSummary(BaseModel):
    """Top topics for the dashboard's selected period, ranked by raw
    post-volume across the period.

    Each sentiment returns 1 topic by default. The runner-up is included
    only when its volume is ≥ 70% of the leader's — that heuristic keeps
    the widget concise while still showing a genuinely close second.

    Ordering: highest volume first."""
    positive: List[TopicSummary]
    negative: List[TopicSummary]
    neutral: List[TopicSummary]


class VolumePoint(BaseModel):
    day: date
    steam_review: int
    steam_forum: int
    reddit: int
    # v0016.2 (2026-08-12): reddit_comment as a separate axis. Comments
    # inherit their parent thread's relevance_tier via arctic-shift comment
    # ingestion. Default 0 so old rows and JSON payloads from before this
    # field existed deserialize cleanly.
    reddit_comment: int = 0
    bluesky: int = 0
    # DTF.ru (Russian-language gaming forum) — added 2026-07-27 after the
    # source itself was wired into the ingestor a day earlier. Default 0
    # so old rows and JSON payloads from before this field existed
    # deserialize cleanly.
    dtf: int = 0
    total: int


class SentimentVelocity(BaseModel):
    direction: str              # "improving" | "stable" | "declining"
    delta_avg: Optional[float] = None   # average daily pos/neg ratio change


class DashboardResponse(BaseModel):
    game_id: int
    period: str
    sentiment_today: SentimentCounts
    net_sentiment_trend: List[NetSentimentPoint]
    # 2026-08-05: kept for schema back-compat with older callers but
    # emptied — the dashboard widget was rebuilt around a concise text
    # summary (top_topics_summary below) instead of the metadata-badge
    # TopicItem list.
    top_positive_topics: List[TopicItem]
    top_negative_topics: List[TopicItem]
    top_neutral_topics: List[TopicItem]
    # New concise topic summary for the dashboard widget.
    top_topics_summary: TopTopicsSummary
    volume_by_source: List[VolumePoint]
    sentiment_velocity: SentimentVelocity


# ── Topic Trends ──────────────────────────────────────────────────────────────

class TopicTrendResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    game_id: int
    topic_label: str
    sentiment: str            # "positive" | "negative" | "neutral"
    first_seen: date
    last_seen: date
    mention_count: int
    trend_direction: str      # "rising" | "falling" | "stable"
    velocity: float


# ── Raw Posts ─────────────────────────────────────────────────────────────────

class PostSentimentInfo(BaseModel):
    sentiment: str
    sentiment_score: float
    topics: Optional[list] = None


class RawPostResponse(BaseModel):
    id: int
    game_id: int
    source: str
    external_id: str
    author: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    url: Optional[str] = None
    upvotes: int
    collected_at: datetime
    post_date: Optional[datetime] = None
    sentiment_info: Optional[PostSentimentInfo] = None
    # v3 relevance audit (2026-08-12).
    relevance_tier: Optional[str] = None
    matched_keywords: Optional[list] = None


class PostsPageResponse(BaseModel):
    items: List[RawPostResponse]
    total: int
    page: int
    page_size: int
    total_pages: int


# ── Ingestion ─────────────────────────────────────────────────────────────────

class IngestStatusResponse(BaseModel):
    is_running: bool
    last_run_at: Optional[str] = None
    # "never" | "success" | "partial" | "partial_failure" | "error"
    last_run_status: str
    last_run_errors: List[str] = Field(default_factory=list)
    games_processed: int = 0
    posts_collected: int = 0
    next_run_at: Optional[str] = None
    # Per-source health from the most recent run.
    # "unknown" | "skipped" | "ok" | "degraded" | "failed" | "silent"
    reddit_health: str = "unknown"
    reddit_fetched_total: int = 0
    reddit_retries: int = 0
    bluesky_health: str = "unknown"
    bluesky_fetched_total: int = 0
    bluesky_retries: int = 0
    steam_review_health: str = "unknown"
    steam_review_fetched_total: int = 0
    steam_forum_health: str = "unknown"
    steam_forum_fetched_total: int = 0


class IngestRunResponse(BaseModel):
    status: str
    games_processed: int = 0
    posts_collected: int = 0
    errors: List[str] = Field(default_factory=list)


# ── Monthly Summaries ─────────────────────────────────────────────────────────

IMONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


class MonthlySummaryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    game_id: int
    period_year: int
    period_month: int
    positive_count: int
    negative_count: int
    neutral_count: int
    total_posts: int
    top_positive_topics: Optional[list] = None
    top_negative_topics: Optional[list] = None
    top_neutral_topics: Optional[list] = None
    executive_summary: Optional[str] = None
    recommended_actions: Optional[str] = None
    bold_ideas: Optional[list] = None
    # CLAUDE.md §20 layer 3: see WindowSummaryResponse.citation_map.
    citation_map: Optional[dict] = None
    generated_at: datetime
    # Computed label, e.g. "April 2026" — populated in from_orm_with_label
    month_label: str = ""


class MonthlySummaryResponseWithLabel(MonthlySummaryResponse):
    """Adds month_label as a proper serialisable field."""

    @classmethod
    def from_orm_with_label(cls, obj) -> "MonthlySummaryResponseWithLabel":
        base = cls.model_validate(obj)
        month_name = IMONTH_NAMES[base.period_month] if 1 <= base.period_month <= 12 else str(base.period_month)
        base.month_label = f"{month_name} {base.period_year}"
        return base


# ── Window Summaries ──────────────────────────────────────────────────────────

class WindowSummaryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    game_id: int
    window_days: int
    ingest_date: date
    positive_count: int
    negative_count: int
    neutral_count: int
    total_posts: int
    top_positive_topics: Optional[list] = None
    top_negative_topics: Optional[list] = None
    top_neutral_topics: Optional[list] = None
    executive_summary: Optional[str] = None
    recommended_actions: Optional[str] = None
    bold_ideas: Optional[list] = None
    # CLAUDE.md §20 layer 3: maps [P-NNN] tokens in summary text to source
    # posts so the frontend can render citations as clickable superscripts.
    citation_map: Optional[dict] = None
    generated_at: datetime


class WindowSummaryRequest(BaseModel):
    days: int = Field(default=7, ge=1, le=90)


# ── Forward reference resolution ─────────────────────────────────────────────
# GameDetailResponse references DailySummaryResponse which is defined below it;
# model_rebuild() resolves the forward ref after both classes exist.
GameDetailResponse.model_rebuild()


# ── Competitor Games ──────────────────────────────────────────────────────────

MAX_COMPETITORS_PER_PARENT = 4


class CompetitorGameResponse(BaseModel):
    """A competitor Game as returned by GET/POST /api/games/{parent_id}/competitors.

    Deliberately a subset of GameResponse's fields -- the ones the Settings
    UI and timeseries chart need -- rather than the full GameResponse, so
    the competitor list endpoint has a stable, purpose-built shape.
    """
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    steam_app_id: int
    subreddits: Optional[list] = None
    distinctive_keywords: Optional[list] = None
    release_date: Optional[str] = None


class CompetitorCreate(BaseModel):
    """POST body for adding a competitor title under a parent Saber game."""
    steam_app_id: int


# ── Competitor Timeseries (dashboard cross-title chart) ─────────────────────

class CompetitorTimeseriesGame(BaseModel):
    game_id: int
    name: str
    is_parent: bool
    # Period-over-period post-volume totals (2026-07-26). Populated for
    # 7d/30d/90d (`weekly`/`monthly`/`quarterly`) views only — for
    # `today` and `lifetime` these are None because there is no directly
    # comparable prior window of the same length.
    #
    #   current_total = post count over [today - (N-1), today]
    #   prev_total    = post count over the immediately preceding same-length window
    #                   e.g. weekly → [today-13, today-7]
    #
    # pct_change is `current_total` vs `prev_total` expressed as a signed
    # percentage; None when prev_total == 0 (no meaningful ratio).
    current_total: Optional[int] = None
    prev_total: Optional[int] = None
    pct_change: Optional[float] = None


class CompetitorTimeseriesDay(BaseModel):
    day: date
    # Keyed by game_id (as a string, since JSON object keys are always
    # strings) -> post count for that game on that day.
    counts: dict


class CompetitorTimeseriesEvent(BaseModel):
    """Timeline event overlay on the Post Volume by Title chart."""
    id: int
    game_id: int
    event_date: date
    name: str


class CompetitorTimeseriesResponse(BaseModel):
    games: List[CompetitorTimeseriesGame]
    timeseries: List[CompetitorTimeseriesDay]
    events: List[CompetitorTimeseriesEvent] = []


# ── Digest Recipients ─────────────────────────────────────────────────────────

class DigestRecipientResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    is_active: bool
    created_at: datetime


class DigestRecipientCreate(BaseModel):
    email: str
