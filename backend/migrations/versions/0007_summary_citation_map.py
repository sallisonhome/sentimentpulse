"""Add citation_map JSON to window_summaries + monthly_summaries

Revision ID: 0007
Revises: 0006
Create Date: 2026-06-24 13:50:00.000000 UTC

CLAUDE.md §20 layers 3+4 (citation grounding + self-criticism) require
storing the [P-NNN] → post-id/url map alongside each summary so the
email renderer can resolve in-text citations to clickable links and the
recipient can audit every claim back to a source post.

Both columns are nullable; existing rows pre-date citation grounding and
will simply render without superscript links, which the renderer treats
as a no-op (legacy text shows through unchanged).

Schema (per row):
  {
    "P-001": {"id": 12345, "url": "https://reddit.com/...", "sentiment": "positive"},
    "P-002": {...},
    ...
  }
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLES = ("window_summaries", "monthly_summaries")
_COLUMN = "citation_map"


def upgrade() -> None:
    """Idempotent: skip tables that already have the column."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in _TABLES:
        existing = {col["name"] for col in inspector.get_columns(table)}
        if _COLUMN in existing:
            continue
        op.add_column(
            table,
            sa.Column(_COLUMN, sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    """Drop on PostgreSQL; no-op on SQLite (no DROP COLUMN before 3.35)."""
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        return
    for table in _TABLES:
        op.drop_column(table, _COLUMN)
