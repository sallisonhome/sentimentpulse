"""Sentiment sharpening columns

Revision ID: 0014
Revises: 0013
Create Date: 2026-07-29 14:30:00.000000 UTC

Adds two nullable columns needed for the 2026-07-29 sentiment sharpening pass:

  * raw_posts.voted_up (Boolean, nullable)
      Steam Reviews API returns an explicit voted_up flag (thumbs up/down)
      which is ground truth for review sentiment. We now persist it on
      RawPost so the classifier can use it as a hard rule for Steam reviews
      (positive when True, negative when False, never neutral). Prior to
      this migration the field was dropped on ingest.

      Nullable so non-Steam-Review rows remain None. Backfill of historic
      Steam Review rows via a follow-up script is optional \u2014 the reclassify
      endpoint will treat missing values as \"model output only\".

  * sentiment_records.original_score (Float, nullable)
      Companion to the existing original_label column. When the confidence
      floor demotes a non-neutral label to neutral, we now record both the
      pre-demotion label AND its pre-demotion score. Enables retroactive
      threshold changes without re-classifying every post: a future audit
      can compare original_score against a lower threshold and \"undemote\"
      posts that would now qualify.

Both columns are nullable to keep the migration additive and safe. No data
is modified for existing rows.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add raw_posts.voted_up (Boolean) and sentiment_records.original_score (Float)."""
    # raw_posts.voted_up \u2014 nullable so we don't have to backfill non-Steam rows
    op.add_column(
        "raw_posts",
        sa.Column("voted_up", sa.Boolean(), nullable=True),
    )
    # sentiment_records.original_score \u2014 nullable; only populated when demotion fires
    op.add_column(
        "sentiment_records",
        sa.Column("original_score", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    """Drop both columns. Data in those columns is lost."""
    op.drop_column("sentiment_records", "original_score")
    op.drop_column("raw_posts", "voted_up")
