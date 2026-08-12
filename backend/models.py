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
    bluesky = "bluesky"
    # DTF.ru — Russian-language gaming forum. Added 2026-07-26 to capture
    # Russian-language discussion of Team Clout's ILL (developer is Russian
    # in origin, Mundfish publisher is Russian/Cypriot), which our English-
    # only sub/keyword monitoring was systematically undercounting. Content
    # comes from api.dtf.ru's public read endpoints — no auth needed.
    dtf = "dtf"


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
    # JSON list of distinctive keywords/keyphrases that uniquely identify this
    # game vs the broader IP, movie, or brand it shares a name with.
    # Used by §14 post-relevance filter (post_relevance.py).
    distinctive_keywords: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)
    # CLAUDE.md §21 (Commercial Strategic Context, 2026-06-29): a per-title
    # positioning brief that tells the LLM what comparisons are commercial
    # assets, what genre tailwinds to ride, what competitors to differentiate
    # from, and what NOT to advise away from.  Without this, the LLM treats
    # every community signal as a thing to 'address' or 'counter-position'
    # — even when the signal is a commercial gift (e.g. Hellraiser community
    # comparing the game to Resident Evil, the #1 commercial horror of 2026).
    # The right play in that case is 'lean into the comparison + add what
    # makes us authentically the IP', NOT 'distance from RE'.
    commercial_context: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # CLAUDE.md §24 (Editorial-Research Hybrid Bold Ideas, 2026-06-29):
    # Per-title demographic + IP-awareness brief used by the bold-ideas
    # prompt to ground speculative cohort-reach reasoning.  E.g.
    # Hellraiser → "<40 cohort doesn't know the IP outside of Pinhead
    # imagery; awareness gap is the marketing barrier".  Turok → "35-45
    # cohort with N64 nostalgia, exotic-weapons memory (Cerebral Bore,
    # bow weapons) is the loyalty anchor".
    demographic_context: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    publisher: Mapped["Publisher"] = relationship("Publisher", back_populates="games")
    # cascade="all, delete-orphan" (added 2026-07-24 for competitor removal,
    # DELETE /api/games/{parent_id}/competitors/{competitor_id}): deleting a
    # Game row must cascade to ALL of its dependent rows so a removed
    # competitor doesn't leave orphaned raw_posts / sentiment_records /
    # summaries behind.  Safe for existing Saber-title deletes too (there
    # was previously no supported way to delete a Game at all).
    raw_posts: Mapped[List["RawPost"]] = relationship(
        "RawPost", back_populates="game", cascade="all, delete-orphan",
    )
    daily_summaries: Mapped[List["DailySummary"]] = relationship(
        "DailySummary", back_populates="game", cascade="all, delete-orphan",
    )
    topic_trends: Mapped[List["TopicTrend"]] = relationship(
        "TopicTrend", back_populates="game", cascade="all, delete-orphan",
    )
    monthly_summaries: Mapped[List["MonthlySummary"]] = relationship(
        "MonthlySummary", back_populates="game", cascade="all, delete-orphan",
    )
    window_summaries: Mapped[List["WindowSummary"]] = relationship(
        "WindowSummary", back_populates="game", cascade="all, delete-orphan",
    )
    editorial_articles: Mapped[List["EditorialArticle"]] = relationship(
        "EditorialArticle", back_populates="game", cascade="all, delete-orphan",
    )
    # Competitor-tracking (2026-07-24): rows in competitor_games where this
    # game is the PARENT (Saber title) — one per tracked competitor, max 4
    # enforced at the API layer (routers/competitors.py), not the DB layer.
    competitor_links: Mapped[List["CompetitorGame"]] = relationship(
        "CompetitorGame",
        foreign_keys="CompetitorGame.parent_id",
        back_populates="parent",
        cascade="all, delete-orphan",
    )
    # Reverse side: the row in competitor_games where this game IS the
    # competitor being tracked under some parent.  A game can only be a
    # competitor under one parent at a time (unique constraint), so this is
    # at most one row — exposed as a list for relationship symmetry.
    parent_links: Mapped[List["CompetitorGame"]] = relationship(
        "CompetitorGame",
        foreign_keys="CompetitorGame.competitor_id",
        back_populates="competitor",
        cascade="all, delete-orphan",
    )

    @property
    def is_competitor(self) -> bool:
        """
        True if this Game is tracked as a competitor under some parent
        (i.e. it has a row in competitor_games where it is the competitor_id).

        Saber titles and competitors are kept as separate concepts in query
        semantics even though both live in the `games` table — this property
        is the single source of truth other code should use to distinguish
        them (e.g. GET /api/games?exclude_competitors=true).
        """
        return len(self.parent_links) > 0


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
    # v2 relevance gate (2026-07-24, migration 0010): tri-state audit column.
    #   None  = not yet evaluated by the relevance gate
    #   True  = passed the gate; a SentimentRecord was/will be created
    #   False = failed the gate; RawPost retained for audit, no SentimentRecord
    is_relevant: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True, default=None)
    # Steam Reviews ground-truth vote (added 2026-07-29, migration 0014).
    # True  = reviewer clicked thumbs-up (recommended)
    # False = reviewer clicked thumbs-down (not recommended)
    # None  = not a Steam Review, OR ingested before migration 0014
    # The classifier uses this as a HARD rule for Steam Reviews: positive
    # when True, negative when False, never neutral (voted_up isn't
    # ambiguous). See _classify_steam_review_from_vote() in nlp_service.
    voted_up: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True, default=None)

    # v3 relevance audit (2026-08-12, migration 0015). Post-ingest tagging
    # that lets analytics/spike detection separate signal from noise without
    # dropping any posts. See migration 0015 for the value taxonomy.
    #   'dedicated_sub' | 'signal' | 'noise' | 'unclassified'
    relevance_tier: Mapped[Optional[str]] = mapped_column(
        String(32), nullable=True, default=None, index=True,
    )
    # Actual keywords that matched (JSON list). Empty list for dedicated_sub /
    # noise, populated for signal, null when unclassified.
    matched_keywords: Mapped[Optional[list]] = mapped_column(
        JSON, nullable=True, default=None,
    )

    game: Mapped["Game"] = relationship("Game", back_populates="raw_posts")
    # cascade="all, delete-orphan" (2026-07-24, competitor removal): deleting
    # a RawPost (e.g. via a cascaded Game delete) must also delete its
    # SentimentRecord so no orphaned sentiment rows are left behind.
    sentiment_record: Mapped[Optional["SentimentRecord"]] = relationship(
        "SentimentRecord", back_populates="raw_post", uselist=False,
        cascade="all, delete-orphan",
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

    # ── §18 Sentiment Trust Chain audit columns (added by migration 0005) ──────
    # signal_quality: 'low' (0-2 tokens) | 'medium' (3-6) | 'high' (7+)
    signal_quality: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    # language: ISO 639-1 code e.g. 'en', 'ru', 'es', or 'und' for undetectable
    language: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    # original_label: model's pre-floor label when demoted (set by PR #10)
    original_label: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    # original_score: model's pre-floor score when demoted (added 2026-07-29
    # by migration 0014). Companion to original_label so retroactive
    # threshold changes can be applied without re-classifying every post.
    original_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # sentiment_conflict: True when title and body labels disagreed (set by PR #11)
    sentiment_conflict: Mapped[Optional[bool]] = mapped_column(
        Boolean, nullable=True, default=False
    )
    # applied_rules: JSON list of lexicon rule IDs that fired (set by PR #11)
    applied_rules: Mapped[Optional[list]] = mapped_column(
        JSON, nullable=True, default=list
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


class MonthlySummary(Base):
    __tablename__ = "monthly_summaries"
    __table_args__ = (
        UniqueConstraint(
            "game_id", "period_year", "period_month",
            name="uq_monthly_summaries_game_year_month",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    game_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("games.id"), nullable=False, index=True
    )
    period_year: Mapped[int] = mapped_column(Integer, nullable=False)
    period_month: Mapped[int] = mapped_column(Integer, nullable=False)
    positive_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    negative_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    neutral_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_posts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    top_positive_topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    top_negative_topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    top_neutral_topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    executive_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    recommended_actions: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    bold_ideas: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    # CLAUDE.md §20 layer 3: maps each [P-NNN] token in the summary text
    # back to its source post (id, url, sentiment) so the email renderer
    # can resolve citations to clickable superscript links.  Nullable;
    # rows pre-dating layers 3+4 simply render without citations.
    citation_map: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    generated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    game: Mapped["Game"] = relationship("Game", back_populates="monthly_summaries")


class WindowSummary(Base):
    __tablename__ = "window_summaries"
    __table_args__ = (
        UniqueConstraint(
            "game_id", "window_days", "ingest_date",
            name="uq_window_summaries_game_days_date",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    game_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("games.id"), nullable=False, index=True
    )
    window_days: Mapped[int] = mapped_column(Integer, nullable=False)
    ingest_date: Mapped[date] = mapped_column(Date, nullable=False)
    positive_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    negative_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    neutral_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_posts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    top_positive_topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    top_negative_topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    top_neutral_topics: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    executive_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    recommended_actions: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    bold_ideas: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    # CLAUDE.md §20 layer 3: see MonthlySummary.citation_map.
    citation_map: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    generated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    game: Mapped["Game"] = relationship("Game", back_populates="window_summaries")


class DigestRecipient(Base):
    """
    Email address that receives the weekly + monthly executive digests.

    Managed via /api/digest/recipients (GET/POST/DELETE) and the Settings
    page in the frontend.  No UI-side editing of the games list — that's
    intentionally fixed in code to the 8 active titles the operator
    specified on 2026-06-24 so the digest's value proposition stays
    consistent and doesn't accidentally pick up DLC variants.
    """
    __tablename__ = "digest_recipients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(254), nullable=False, unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class EditorialArticle(Base):
    """
    CLAUDE.md §24 — per-title editorial research cache.

    One row per article fetched for a given (game_id, scope, cycle_start)
    batch.  The bold-ideas LLM call reads the LATEST batch for a
    (game_id, scope, cycle_start) tuple and surfaces each article as a
    [E-NNN] citable evidence item alongside the in-window [P-NNN] post
    citations.

    Cache key (uniqueness): (game_id, scope, cycle_start, url) — re-running
    a digest cycle reuses the existing batch rather than re-fetching.
    Different cycle_start values (e.g. weekly vs monthly) get separate
    batches per §24's "separate caches" decision.
    """
    __tablename__ = "editorial_articles"
    __table_args__ = (
        UniqueConstraint(
            "game_id", "scope", "cycle_start", "url",
            name="uq_editorial_articles_game_scope_cycle_url",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    game_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("games.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    scope: Mapped[str] = mapped_column(String(16), nullable=False)
    cycle_start: Mapped[date] = mapped_column(Date, nullable=False)
    cycle_end: Mapped[date] = mapped_column(Date, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    publication: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    published_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True,
    )
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False,
    )
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    cite: Mapped[str] = mapped_column(String(8), nullable=False)

    game: Mapped["Game"] = relationship("Game", back_populates="editorial_articles")


class CompetitorGame(Base):
    """
    Join table linking a Saber (parent) title to a competitor title it
    tracks for comparative sentiment analysis.

    Both parent and competitor are rows in the `games` table — a competitor
    is a fully-fledged Game (own subreddits, sentiment pipeline, topics,
    daily/weekly/monthly summaries) that happens to also be linked here for
    dashboard grouping and the cross-title timeseries chart.  See
    CLAUDE.md and lessons.md 2026-07-24 entries for the rationale on why
    parenthood is a UI/query concept layered on top of the existing Game
    table rather than a new games-shaped table.

    A game may be a competitor under at most ONE parent (unique on
    competitor_id).  A parent may have up to 4 competitors — that cap is
    enforced in routers/competitors.py, not at the DB layer, so it can
    produce a friendly 409 error instead of an IntegrityError.
    """
    __tablename__ = "competitor_games"
    __table_args__ = (
        UniqueConstraint(
            "parent_id", "competitor_id", name="uq_competitor_games_parent_competitor"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    parent_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("games.id"), nullable=False, index=True
    )
    competitor_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("games.id"), nullable=False, index=True, unique=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    parent: Mapped["Game"] = relationship(
        "Game", foreign_keys=[parent_id], back_populates="competitor_links"
    )
    competitor: Mapped["Game"] = relationship(
        "Game", foreign_keys=[competitor_id], back_populates="parent_links"
    )


class AppSetting(Base):
    """
    Generic single-row key/value settings store, used for one-time-operation
    idempotency markers (migration 0010, 2026-07-24).

    Examples:
      key='keyword_lists_applied_at'          — set once apply_keyword_lists.py
                                                 has persisted the 29-game
                                                 keyword table to games.distinctive_keywords.
      key='sentiment_july_backfill_done_at'   — set once
                                                 purge_july_offtopic_sentiment.py
                                                 has run against the live DB.

    value stores an ISO-8601 UTC timestamp string (informational only — the
    presence of the row is what gates re-runs, not its content).
    """
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False,
    )


class TimelineEvent(Base):
    """
    User-authored timeline events overlaid on the Post Volume by Title
    chart on a parent's dashboard.

    Feature added 2026-07-26. Modeled after SignalPulse's PLS milestone
    pattern (client/src/components/pls-section.tsx) — one event per
    (game_id, event_date, name) tuple, freely edited/deleted by the user.
    Rendered as a vertical ReferenceLine on the Post Volume by Title
    chart, colored to match the game's line.

    Scope rule (enforced in routers/timeline_events.py):
      * A game must EITHER be a parent (has ≥1 competitor row where
        parent_id == this.id) OR a competitor (has a row where
        competitor_id == this.id) for events to be creatable on it.
        Standalone Saber titles with no competitors have no events UI —
        the whole widget is hidden client-side too.

    No cap on events per game. Events with event_date outside the
    dashboard's selected period are silently omitted from the chart
    payload but remain in the DB.
    """
    __tablename__ = "timeline_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    game_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("games.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    event_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # Concise description shown in the tooltip and in the settings list.
    # ≤120 chars enforced at the schema layer (Pydantic).
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False,
    )

    game: Mapped["Game"] = relationship("Game")
