"""Add competitor_games join table

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-24 00:00:00.000000 UTC

Competitor-tracking feature (2026-07-24): a new `competitor_games` table
links a Saber (parent) title to up to 4 competitor titles it tracks for
comparative sentiment analysis. Both parent and competitor rows live in
the existing `games` table -- this migration only adds the join table
that records the parent/competitor relationship, plus its indexes and
unique constraints.

Idempotent (table-exists check), matching the pattern established by
migrations 0005, 0009, and 0010.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "competitor_games"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if _TABLE not in existing_tables:
        op.create_table(
            _TABLE,
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "parent_id", sa.Integer(),
                sa.ForeignKey("games.id"), nullable=False,
            ),
            sa.Column(
                "competitor_id", sa.Integer(),
                sa.ForeignKey("games.id"), nullable=False,
            ),
            sa.Column(
                "created_at", sa.DateTime(), nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint(
                "parent_id", "competitor_id",
                name="uq_competitor_games_parent_competitor",
            ),
        )
        op.create_index(
            "ix_competitor_games_parent_id", _TABLE, ["parent_id"],
        )
        op.create_index(
            "ix_competitor_games_competitor_id", _TABLE, ["competitor_id"],
            unique=True,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())
    if _TABLE in existing_tables:
        op.drop_table(_TABLE)
