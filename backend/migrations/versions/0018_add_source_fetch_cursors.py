"""Add source_fetch_cursors table for incremental daily ingest

Revision ID: 0018
Revises: 0017
Create Date: 2026-08-19 12:35:00.000000 UTC

Steve's report 2026-08-19: portfolio grew to 39 active games and daily
ingest hit its 75-min budget after 29 games, silently skipping the 10
highest-ID titles. Root cause: every daily run passes limit=100 to
Arctic Shift per subreddit per game WITHOUT an `after=` epoch cutoff,
so we re-fetch the same 100 newest posts every day. Save-time dedup on
external_id catches the duplicates, but the wasted API time (~1s per
HTTP call × ~85% duplicate rate) dominates the wallclock budget. From
last observed run:
  reddit_fetched_total = 33,300 raw returned across 29 games
  posts_collected      = 5,208 actually new
  keep rate            = 15.6%

This migration adds a per-(game_id, source, scope_key) cursor table so
the daily-ingest read path can pass `after=<cursor - 48h buffer>` to
Arctic Shift / Bluesky / DTF. Backfills bypass the cursor entirely
(they're start_date-driven and MUST NOT move the cursor forward past
dates the daily cron hasn't caught up to yet).

Table shape:
  source_fetch_cursors (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id           INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    source            VARCHAR(32) NOT NULL,   -- reddit / bluesky / steam_review / steam_forum / dtf / reddit_comment
    scope_key         VARCHAR(64) NOT NULL,   -- subreddit name for reddit/reddit_comment; "" for source-scoped
    last_seen_epoch   INTEGER NOT NULL,       -- UTC epoch seconds of the newest post fetched so far
    last_updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (game_id, source, scope_key)
  )

Backward compatibility: the cursor table is additive — the first daily
run after this deploys will see empty cursors and fall back to
`now - 48h` as the after= filter (a safe compromise between catching
overnight posts and re-fetching all history). Steady-state runs will
carry cursors forward with a 48h safety overlap so late-arriving posts
still land.

Downgrade: drops the table cleanly. No data migration required.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0018"
down_revision: Union[str, None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create source_fetch_cursors."""
    op.create_table(
        "source_fetch_cursors",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "game_id",
            sa.Integer(),
            sa.ForeignKey("games.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("scope_key", sa.String(length=64), nullable=False),
        sa.Column("last_seen_epoch", sa.Integer(), nullable=False),
        sa.Column(
            "last_updated_at",
            sa.DateTime(),
            server_default=sa.func.current_timestamp(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "game_id", "source", "scope_key",
            name="uq_source_fetch_cursors_game_source_scope",
        ),
    )


def downgrade() -> None:
    op.drop_table("source_fetch_cursors")
