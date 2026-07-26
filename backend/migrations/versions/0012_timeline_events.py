"""Add timeline_events table

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-26 00:00:00.000000 UTC

Timeline events feature (2026-07-26): user-authored events overlaid on
the Post Volume by Title chart on a parent's dashboard. Modeled after
SignalPulse's PLS milestones. One row per (game_id, event_date, name).
Only rendered when a game is part of a parent/competitor group (either
side of the competitor_games join).

Idempotent — matches the pattern from migrations 0005-0011.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "timeline_events"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if _TABLE not in existing_tables:
        op.create_table(
            _TABLE,
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "game_id", sa.Integer(),
                sa.ForeignKey("games.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("event_date", sa.Date(), nullable=False),
            sa.Column("name", sa.String(length=120), nullable=False),
            sa.Column(
                "created_at", sa.DateTime(), nullable=False,
                server_default=sa.func.now(),
            ),
        )
        op.create_index(
            "ix_timeline_events_game_id", _TABLE, ["game_id"],
        )
        op.create_index(
            "ix_timeline_events_event_date", _TABLE, ["event_date"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())
    if _TABLE in existing_tables:
        op.drop_table(_TABLE)
