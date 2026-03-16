import enum
from datetime import datetime, date
from typing import Optional, List

from sqlalchemy import (
    Integer, String, Float, Boolean, Text, Date, DateTime,
    ForeignKey, Enum, JSON, UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


# ── Enums ─────────────────────────────────────────────────────────────────────

class SourceEnum(str, enum.Enum):
    steam_review = "steam_review"
    steam_forum = "steam_forum"
    reddit = "reddit"


class SentimentEnum(str, enum.Enum):
    positive = "positive"
    negative = "negative"
    neutral = "neutral"


class TrendDirectionEnum(str, enum.Enum):
    rising = "rising"
    falling = "falling"
    stable = "stable"


# ── Models ────────────────────────────────────────────────────────────────────

class Publisher(Base):
    __tablename__ = "publishers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    games: Mapped[List["Game"]] = relationship("Game", back_populates="publisher")


class Game(Base):
    __tablename__ = "games"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    publisher_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("publishers.id"), nullable=False, index=True
    )
    steam_app_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    release_date: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # JSON list of subreddit names, e.g. ["GameNameOfficial", "GameName"]
    subreddits: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    publisher: Mapped["Publisher"] = relationship("Publisher", back_populates="games")
    raw_posts: Mapped[List["RawPost"]] = relationship("RawPost", back_populates="game")
    daily_summaries: Mapped[List["DailySummary"]] = relationship(
        "DailySummary", back_populates="game"
    )
    topic_trends: Mapped[List["TopicTrend"]] = relationship(
        "TopicTrend", back_populates="game"
    )


class RawPost(Base):
    __tablename__ = "raw_posts"
    __table_args__ = (
        UniqueConstraint(
            "external_id", "source", name="uq_raw_posts_external_id_source"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    game_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("games.id"), nullable=False, index=True
    )
    source: Mapped[SourceEnum] = mapped_column(
        Enum(SourceEnum, name="sourceenum"), nullable=False
    )
    external_id: Mapped[str] = mapped_column(String(255), nullable=False)
    author: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    title: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    upvotes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    collected_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    post_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    game: Mapped["Game"] = relationship("Game", back_populates="raw_posts")
    sentiment_record: Mapped[Optional["SentimentRecord"]] = relationship(
        "SentimentRecord", back_populates="raw_post", uselist=False
    )


class SentimentRecord(Base):
    __tablename__ = "sentiment_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    raw_post_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("raw_posts.id"), unique=True, nullable=False
    )
    sentiment: Mapped[SentimentEnum] = mapped_column(
        Enum(SentimentEnum, name="sentimentenum"), nullable=False
    )
    sentiment_score: Mapped[float] = mapped_column(Float, nullable=False)
    # JSON list of topic strings extracted from this post
    topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)
    processed_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    raw_post: Mapped["RawPost"] = relationship("RawPost", back_populates="sentiment_record")


class DailySummary(Base):
    __tablename__ = "daily_summaries"
    __table_args__ = (
        UniqueConstraint(
            "game_id", "summary_date", name="uq_daily_summaries_game_date"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    game_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("games.id"), nullable=False, index=True
    )
    summary_date: Mapped[date] = mapped_column(Date, nullable=False)
    positive_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    negative_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    neutral_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # JSON list of top topic strings per sentiment category
    top_positive_topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    top_negative_topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    top_neutral_topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    # daily change in net sentiment (positive% - negative%); None if no prior day
    sentiment_trend_delta: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    executive_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    recommended_actions: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    game: Mapped["Game"] = relationship("Game", back_populates="daily_summaries")


class TopicTrend(Base):
    __tablename__ = "topic_trends"
    __table_args__ = (
        UniqueConstraint(
            "game_id", "topic_label", "sentiment",
            name="uq_topic_trends_game_label_sentiment",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    game_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("games.id"), nullable=False, index=True
    )
    topic_label: Mapped[str] = mapped_column(String(255), nullable=False)
    sentiment: Mapped[SentimentEnum] = mapped_column(
        # reuse existing type on PostgreSQL — create_constraint=False avoids
        # a duplicate CREATE TYPE on the second table that references this enum
        Enum(SentimentEnum, name="sentimentenum", create_constraint=False),
        nullable=False,
    )
    first_seen: Mapped[date] = mapped_column(Date, nullable=False)
    last_seen: Mapped[date] = mapped_column(Date, nullable=False)
    mention_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    trend_direction: Mapped[TrendDirectionEnum] = mapped_column(
        Enum(TrendDirectionEnum, name="trenddirectionenum"),
        default=TrendDirectionEnum.stable,
        nullable=False,
    )
    # rate of change in mention_count per day over the trailing 7-day window
    velocity: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    game: Mapped["Game"] = relationship("Game", back_populates="topic_trends")
