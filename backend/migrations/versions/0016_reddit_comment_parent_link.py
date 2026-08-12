"""Reddit comment ingestion — parent_external_id column + reddit_comment source

Revision ID: 0016
Revises: 0015
Create Date: 2026-08-12 15:50:00.000000 UTC

Enables Reddit comment ingestion. Previously the Reddit step only stored
submission-level rows, losing all the on-topic discussion in comments
(the exact gap Steve flagged 2026-08-12: a Hellraiser gameplay video on
r/PS5 had 14 relevant comments — none in SentimentPulse).

Changes:
  * raw_posts.parent_external_id (String, nullable) — for reddit_comment
    rows, stores the parent submission's external_id (Reddit thread id like
    '1vknbt9'). Lets us inherit the parent's relevance_tier and
    matched_keywords when tagging comments, so a comment on a keyword-
    verified thread inherits 'signal' automatically without requiring its
    own body to repeat the game name.

  * Enum value 'reddit_comment' added to sourceenum. Kept distinct from
    'reddit' so we can query submissions vs comments separately and so
    the ingestor's fetch step is clearly scoped.

Both changes are additive. No data migration needed — existing 'reddit'
rows stay untouched. New comment rows will have parent_external_id set.

Note on Postgres enum ALTER: alembic can't drop enum values, so downgrade
only removes the column and leaves 'reddit_comment' in the enum. This is
harmless — future migrations can reuse the value or ignore it.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add parent_external_id to raw_posts + reddit_comment to sourceenum."""
    # 1. Add the column.
    op.add_column(
        "raw_posts",
        sa.Column(
            "parent_external_id", sa.String(length=255), nullable=True,
        ),
    )
    # Index so "fetch all comments for parent X" is O(log n).
    op.create_index(
        "ix_raw_posts_parent_external_id",
        "raw_posts",
        ["parent_external_id"],
    )

    # 2. Add the new enum value. Postgres requires a raw SQL ALTER since
    #    alembic's Enum type is created via CREATE TYPE and lacks helpers
    #    for ADD VALUE. SQLite has no enum, so the operation is a no-op
    #    (the Enum is enforced application-side via SQLAlchemy).
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE sourceenum ADD VALUE IF NOT EXISTS 'reddit_comment'")


def downgrade() -> None:
    """Drop parent_external_id column. Enum value cannot be safely removed."""
    op.drop_index("ix_raw_posts_parent_external_id", table_name="raw_posts")
    op.drop_column("raw_posts", "parent_external_id")
    # Enum value 'reddit_comment' is left in place. Removing an enum value
    # in Postgres requires recreating the type and rewriting every column
    # that uses it — not worth the operational risk for a downgrade path
    # nobody will run in production.
