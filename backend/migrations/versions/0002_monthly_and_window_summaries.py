"""Monthly and window summaries

Revision ID: 0002
Revises: 0001
Create Date: 2025-01-01 00:00:00.000000 UTC

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── monthly_summaries ─────────────────────────────────────────────────────
    op.create_table(
        "monthly_summaries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("period_year", sa.Integer(), nullable=False),
        sa.Column("period_month", sa.Integer(), nullable=False),
        sa.Column(
            "positive_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "negative_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "neutral_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "total_posts", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("top_positive_topics", sa.JSON(), nullable=True),
        sa.Column("top_negative_topics", sa.JSON(), nullable=True),
        sa.Column("top_neutral_topics", sa.JSON(), nullable=True),
        sa.Column("executive_summary", sa.Text(), nullable=True),
        sa.Column("recommended_actions", sa.Text(), nullable=True),
        sa.Column("bold_ideas", sa.JSON(), nullable=True),
        sa.Column(
            "generated_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["game_id"], ["games.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "game_id", "period_year", "period_month",
            name="uq_monthly_summaries_game_year_month",
        ),
    )
    op.create_index("ix_monthly_summaries_id", "monthly_summaries", ["id"])
    op.create_index("ix_monthly_summaries_game_id", "monthly_summaries", ["game_id"])

    # ── window_summaries ──────────────────────────────────────────────────────
    op.create_table(
        "window_summaries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("window_days", sa.Integer(), nullable=False),
        sa.Column("ingest_date", sa.Date(), nullable=False),
        sa.Column(
            "positive_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "negative_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "neutral_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "total_posts", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("top_positive_topics", sa.JSON(), nullable=True),
        sa.Column("top_negative_topics", sa.JSON(), nullable=True),
        sa.Column("top_neutral_topics", sa.JSON(), nullable=True),
        sa.Column("executive_summary", sa.Text(), nullable=True),
        sa.Column("recommended_actions", sa.Text(), nullable=True),
        sa.Column("bold_ideas", sa.JSON(), nullable=True),
        sa.Column(
            "generated_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["game_id"], ["games.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "game_id", "window_days", "ingest_date",
            name="uq_window_summaries_game_days_date",
        ),
    )
    op.create_index("ix_window_summaries_id", "window_summaries", ["id"])
    op.create_index("ix_window_summaries_game_id", "window_summaries", ["game_id"])


def downgrade() -> None:
    op.drop_index("ix_window_summaries_game_id", table_name="window_summaries")
    op.drop_index("ix_window_summaries_id", table_name="window_summaries")
    op.drop_table("window_summaries")

    op.drop_index("ix_monthly_summaries_game_id", table_name="monthly_summaries")
    op.drop_index("ix_monthly_summaries_id", table_name="monthly_summaries")
    op.drop_table("monthly_summaries")
