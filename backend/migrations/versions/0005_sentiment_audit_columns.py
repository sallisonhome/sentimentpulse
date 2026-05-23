"""Add sentiment audit columns to sentiment_records (§18 Sentiment Trust Chain)

Revision ID: 0005
Revises: 0004
Create Date: 2026-06-01 00:00:00.000000 UTC

Adds five audit columns to sentiment_records that support the §18
Sentiment Trust Chain gates:

  signal_quality     — 'low' | 'medium' | 'high' (from signal-volume gate)
  language           — ISO 639-1 code, e.g. 'en', 'ru', or 'und' (undetectable)
  original_label     — model's pre-floor label when demoted (set by PR #10)
  sentiment_conflict — True when title and body labels disagreed (set by PR #11)
  applied_rules      — JSON list of lexicon rule IDs that fired (set by PR #11)

All columns are nullable so existing rows are unaffected.
The downgrade() drops the columns on PostgreSQL and is a no-op on SQLite,
matching the pattern established by migrations 0003 and 0004.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Columns to add — (name, type, kwargs passed to Column constructor)
_NEW_COLUMNS = [
    ("signal_quality",     sa.String(8),      {"nullable": True}),
    ("language",           sa.String(8),      {"nullable": True}),
    ("original_label",     sa.String(32),     {"nullable": True}),
    ("sentiment_conflict", sa.Boolean(),      {"nullable": True, "server_default": sa.text("0")}),
    ("applied_rules",      sa.JSON(),         {"nullable": True, "server_default": sa.text("'[]'")}),
]


def upgrade() -> None:
    """Add audit columns — idempotent: skips columns that already exist."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_cols = {
        col["name"]
        for col in inspector.get_columns("sentiment_records")
    }

    for col_name, col_type, col_kwargs in _NEW_COLUMNS:
        if col_name in existing_cols:
            continue  # Already present — skip (idempotent)
        op.add_column(
            "sentiment_records",
            sa.Column(col_name, col_type, **col_kwargs),
        )


def downgrade() -> None:
    """
    Drop audit columns on PostgreSQL.
    SQLite does not support DROP COLUMN reliably — skip on SQLite (no-op).
    This matches the pattern used in migrations 0003 / 0004.
    """
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "sqlite":
        # SQLite: no-op — column removal is unsupported without table recreation
        return

    # PostgreSQL (and other ANSI-SQL dialects): drop columns if present
    inspector = sa.inspect(bind)
    existing_cols = {
        col["name"]
        for col in inspector.get_columns("sentiment_records")
    }

    for col_name, _, _ in reversed(_NEW_COLUMNS):
        if col_name in existing_cols:
            op.drop_column("sentiment_records", col_name)
