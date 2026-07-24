"""Add raw_posts.is_relevant column + app_settings KV table

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-24 00:00:00.000000 UTC

Relevance-gate fix (2026-07-24). Two additive, backward-compatible changes:

1. `raw_posts.is_relevant` (nullable Boolean) — tri-state audit column so
   Step 5 can distinguish "not yet evaluated" (None) from "evaluated and
   passed" (True) from "evaluated and filtered out" (False), without
   touching the sentiment_records table.

2. `app_settings` — generic key/value table used for one-time-operation
   idempotency markers:
     - 'keyword_lists_applied_at'        (apply_keyword_lists.py)
     - 'sentiment_july_backfill_done_at' (purge_july_offtopic_sentiment.py)

Both changes are idempotent (column-exists / table-exists checks), matching
the pattern established by migrations 0005 and 0009.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_RAW_POSTS_TABLE = "raw_posts"
_IS_RELEVANT_COLUMN = "is_relevant"
_APP_SETTINGS_TABLE = "app_settings"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 1. raw_posts.is_relevant
    existing_cols = {col["name"] for col in inspector.get_columns(_RAW_POSTS_TABLE)}
    if _IS_RELEVANT_COLUMN not in existing_cols:
        op.add_column(
            _RAW_POSTS_TABLE,
            sa.Column(_IS_RELEVANT_COLUMN, sa.Boolean(), nullable=True),
        )

    # 2. app_settings KV table
    existing_tables = set(inspector.get_table_names())
    if _APP_SETTINGS_TABLE not in existing_tables:
        op.create_table(
            _APP_SETTINGS_TABLE,
            sa.Column("key", sa.String(length=128), primary_key=True),
            sa.Column("value", sa.Text(), nullable=True),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())
    if _APP_SETTINGS_TABLE in existing_tables:
        op.drop_table(_APP_SETTINGS_TABLE)

    if bind.dialect.name == "sqlite":
        # SQLite: no reliable DROP COLUMN — no-op, matching 0003/0004/0005 pattern.
        return

    existing_cols = {col["name"] for col in inspector.get_columns(_RAW_POSTS_TABLE)}
    if _IS_RELEVANT_COLUMN in existing_cols:
        op.drop_column(_RAW_POSTS_TABLE, _IS_RELEVANT_COLUMN)
