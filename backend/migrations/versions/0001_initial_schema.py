"""Initial schema

Revision ID: 0001
Revises:
Create Date: 2024-01-01 00:00:00.000000 UTC

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Enum types (PostgreSQL only; SQLite stores as VARCHAR) ────────────────
    source_enum = sa.Enum(
        "steam_review", "steam_forum", "reddit",
        name="sourceenum",
    )
    sentiment_enum = sa.Enum(
        "positive", "negative", "neutral",
        name="sentimentenum",
    )
    trend_enum = sa.Enum(
        "rising", "falling", "stable",
        name="trenddirectionenum",
    )

    # ── publishers ────────────────────────────────────────────────────────────
    op.create_table(
        "publishers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index("ix_publishers_id", "publishers", ["id"])

    # ── games ─────────────────────────────────────────────────────────────────
    op.create_table(
        "games",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("publisher_id", sa.Integer(), nullable=False),
        sa.Column("steam_app_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("release_date", sa.String(50), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("subreddits", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["publisher_id"], ["publishers.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("steam_app_id"),
    )
    op.create_index("ix_games_id", "games", ["id"])
    op.create_index("ix_games_publisher_id", "games", ["publisher_id"])

    # ── raw_posts ─────────────────────────────────────────────────────────────
    op.create_table(
        "raw_posts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("source", source_enum, nullable=False),
        sa.Column("external_id", sa.String(255), nullable=False),
        sa.Column("author", sa.String(255), nullable=True),
        sa.Column("title", sa.String(500), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("url", sa.String(1000), nullable=True),
        sa.Column("upvotes", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column(
            "collected_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("post_date", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["game_id"], ["games.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "external_id", "source", name="uq_raw_posts_external_id_source"
        ),
    )
    op.create_index("ix_raw_posts_id", "raw_posts", ["id"])
    op.create_index("ix_raw_posts_game_id", "raw_posts", ["game_id"])

    # ── sentiment_records ─────────────────────────────────────────────────────
    op.create_table(
        "sentiment_records",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("raw_post_id", sa.Integer(), nullable=False),
        sa.Column("sentiment", sentiment_enum, nullable=False),
        sa.Column("sentiment_score", sa.Float(), nullable=False),
        sa.Column("topics", sa.JSON(), nullable=True),
        sa.Column(
            "processed_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["raw_post_id"], ["raw_posts.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("raw_post_id"),
    )
    op.create_index("ix_sentiment_records_id", "sentiment_records", ["id"])

    # ── daily_summaries ───────────────────────────────────────────────────────
    op.create_table(
        "daily_summaries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("summary_date", sa.Date(), nullable=False),
        sa.Column(
            "positive_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "negative_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "neutral_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("top_positive_topics", sa.JSON(), nullable=True),
        sa.Column("top_negative_topics", sa.JSON(), nullable=True),
        sa.Column("top_neutral_topics", sa.JSON(), nullable=True),
        sa.Column("sentiment_trend_delta", sa.Float(), nullable=True),
        sa.Column("executive_summary", sa.Text(), nullable=True),
        sa.Column("recommended_actions", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["game_id"], ["games.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "game_id", "summary_date", name="uq_daily_summaries_game_date"
        ),
    )
    op.create_index("ix_daily_summaries_id", "daily_summaries", ["id"])
    op.create_index("ix_daily_summaries_game_id", "daily_summaries", ["game_id"])

    # ── topic_trends ──────────────────────────────────────────────────────────
    # sentiment_enum reused here — on PostgreSQL the type already exists after
    # sentiment_records was created, so we pass create_constraint=False in the
    # model; Alembic handles it correctly via the shared sa.Enum object above.
    op.create_table(
        "topic_trends",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("topic_label", sa.String(255), nullable=False),
        sa.Column(
            "sentiment",
            sa.Enum(
                "positive", "negative", "neutral",
                name="sentimentenum",
                create_constraint=False,   # type already created above
            ),
            nullable=False,
        ),
        sa.Column("first_seen", sa.Date(), nullable=False),
        sa.Column("last_seen", sa.Date(), nullable=False),
        sa.Column(
            "mention_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("trend_direction", trend_enum, nullable=False,
                  server_default=sa.text("'stable'")),
        sa.Column(
            "velocity", sa.Float(), nullable=False, server_default=sa.text("0.0")
        ),
        sa.ForeignKeyConstraint(["game_id"], ["games.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "game_id", "topic_label", "sentiment",
            name="uq_topic_trends_game_label_sentiment",
        ),
    )
    op.create_index("ix_topic_trends_id", "topic_trends", ["id"])
    op.create_index("ix_topic_trends_game_id", "topic_trends", ["game_id"])


def downgrade() -> None:
    op.drop_table("topic_trends")
    op.drop_index("ix_daily_summaries_game_id", table_name="daily_summaries")
    op.drop_table("daily_summaries")
    op.drop_index("ix_sentiment_records_id", table_name="sentiment_records")
    op.drop_table("sentiment_records")
    op.drop_index("ix_raw_posts_game_id", table_name="raw_posts")
    op.drop_table("raw_posts")
    op.drop_index("ix_games_publisher_id", table_name="games")
    op.drop_table("games")
    op.drop_table("publishers")

    # Drop PostgreSQL enum types (no-op on SQLite)
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        sa.Enum(name="trenddirectionenum").drop(bind)
        sa.Enum(name="sentimentenum").drop(bind)
        sa.Enum(name="sourceenum").drop(bind)
