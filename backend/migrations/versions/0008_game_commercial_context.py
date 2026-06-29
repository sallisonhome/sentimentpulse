"""Add commercial_context TEXT to games

Revision ID: 0008
Revises: 0007
Create Date: 2026-06-29 14:50:00.000000 UTC

CLAUDE.md §21 (Commercial Strategic Context).  Per-title positioning brief
read by the summary LLM to bias recommendations toward smart commercial
framing — leaning INTO positive commercial comparisons (e.g. "you remind
me of Resident Evil") instead of advising the team to counter-position
away from them.

Nullable; existing rows get NULL and fall back to the heuristic prompt
fragment that the parser computes from genre / release-status signals.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "games"
_COLUMN = "commercial_context"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {col["name"] for col in inspector.get_columns(_TABLE)}
    if _COLUMN in existing:
        return
    op.add_column(_TABLE, sa.Column(_COLUMN, sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        return
    op.drop_column(_TABLE, _COLUMN)
