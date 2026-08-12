"""Relevance tier + matched-keywords audit columns

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-12 13:45:00.000000 UTC

Adds two nullable columns to raw_posts that let analytics and spike-detection
distinguish signal from noise WITHOUT dropping any posts at ingest.

  * raw_posts.relevance_tier (String, nullable)
      One of the following values:
        'dedicated_sub'   Post came from a subreddit/source that is dedicated
                          to this specific game or IP (e.g. r/hellraiserthegame
                          for Hellraiser). Not filtered — kept as signal.
        'signal'          Post came from a broader source (r/horror, Bluesky,
                          Steam forum) AND at least one game keyword appeared
                          in the title/body. Kept as signal.
        'noise'           Post came from a broader source and NO game keyword
                          matched. Retained for audit, excluded from analytics.
        'unclassified'    Not yet evaluated (older rows before this feature
                          shipped, or new rows during a transient tagger
                          outage). Analytics may treat as signal (permissive)
                          or exclude — see routers/dashboard.py for policy.

  * raw_posts.matched_keywords (JSON, nullable)
      List of the actual keywords that matched, e.g. ["hellraiser","cenobite"].
      Empty list when relevance_tier is 'dedicated_sub' (no matching needed)
      or 'noise' (nothing matched). Null when unclassified.

Both columns are nullable and default to None so this migration is fully
additive. A separate one-off retroactive tagger populates existing rows.

The existing is_relevant column (migration 0010) is a DIFFERENT feature —
it's the v2 relevance gate for sentiment classification. Kept untouched.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add relevance_tier (String) + matched_keywords (JSON) to raw_posts."""
    op.add_column(
        "raw_posts",
        sa.Column("relevance_tier", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "raw_posts",
        sa.Column("matched_keywords", sa.JSON(), nullable=True),
    )
    # Index for the common "give me only signal posts" query pattern.
    # Partial index would be better on Postgres, but SQLAlchemy/alembic
    # portability wins here — a plain btree over the small string domain
    # is still fast.
    op.create_index(
        "ix_raw_posts_relevance_tier",
        "raw_posts",
        ["relevance_tier"],
    )


def downgrade() -> None:
    """Drop both columns. Data in those columns is lost."""
    op.drop_index("ix_raw_posts_relevance_tier", table_name="raw_posts")
    op.drop_column("raw_posts", "matched_keywords")
    op.drop_column("raw_posts", "relevance_tier")
