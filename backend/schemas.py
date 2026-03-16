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
    created_at: datetime


class GameDetailResponse(GameResponse):
    """Game with its most recent daily summary attached."""
    latest_summary: Optional[DailySummaryResponse] = None


class GameSettingsUpdate(BaseModel):
    """PATCH body for toggling active flag or overriding subreddits."""
    is_active: Optional[bool] = None
    subreddits: Optional[List[str]] = None


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


class VolumePoint(BaseModel):
    day: date
    steam_review: int
    steam_forum: int
    reddit: int
    total: int


class SentimentVelocity(BaseModel):
    direction: str              # "improving" | "stable" | "declining"
    delta_avg: Optional[float] = None   # average daily net-sentiment change


class DashboardResponse(BaseModel):
    game_id: int
    period: str
    sentiment_today: SentimentCounts
    net_sentiment_trend: List[NetSentimentPoint]
    top_positive_topics: List[TopicItem]
    top_negative_topics: List[TopicItem]
    top_neutral_topics: List[TopicItem]
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
    last_run_status: str
    last_run_errors: List[str] = Field(default_factory=list)
    games_processed: int = 0
    posts_collected: int = 0
    next_run_at: Optional[str] = None


class IngestRunResponse(BaseModel):
    status: str
    games_processed: int = 0
    posts_collected: int = 0
    errors: List[str] = Field(default_factory=list)


# ── Forward reference resolution ─────────────────────────────────────────────
# GameDetailResponse references DailySummaryResponse which is defined below it;
# model_rebuild() resolves the forward ref after both classes exist.
GameDetailResponse.model_rebuild()
