"""Add raw_posts.is_off_topic_drift boolean flag

Revision ID: 0017
Revises: 0016
Create Date: 2026-08-18 14:10:00.000000 UTC

Steve's request 2026-08-18: today the drift override (see
services/ingestor.py Step 5, commit 335c1ed) forces off-topic comments
on verified-parent Reddit threads to `neutral` so they don't move the
pos/neg needle. But that pollutes the neutral bucket with content that
isn't really about the game at all — a dashboard reader can't tell
"player said something neutral about SM2" from "someone posted a
Cyberpunk essay in an SM2 thread reply".

This migration introduces a first-class orthogonal dimension:

    is_off_topic_drift  BOOLEAN NOT NULL DEFAULT FALSE

with an index for filter performance. Every read-side sentiment query
(KPI cards, trend chart, top topics, feedback synth, period summary,
digest emails, portfolio scan) now filters on
`is_off_topic_drift = FALSE` so pos/neg/neutral totals reflect only
content genuinely about the game. Volume-by-source and engagement
metrics keep counting everything — a busy thread is a busy thread.

Backward compatibility:
  * Default FALSE — every existing row remains in the "about-the-game"
    universe until the retroactive backfill flips the ~114k drift rows.
  * The column is orthogonal to SentimentEnum, so any tooling that
    groups by sentiment continues to work; it just now over-reports
    pos/neg/neutral by the drift count until the backfill runs.

Retroactive fill happens in scripts/backfill_off_topic_drift_flag.py,
which sets is_off_topic_drift=True for every RawPost whose
SentimentRecord.applied_rules contains
'FORCED_NEUTRAL_OFFTOPIC_COMMENT_ON_VERIFIED_PARENT'. Idempotent.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0017"
down_revision: Union[str, None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add is_off_topic_drift to raw_posts."""
    # SQLite requires batch_alter_table for adding a NOT NULL column with a
    # server_default. The batch context handles the recreate-table dance.
    with op.batch_alter_table("raw_posts") as batch_op:
        batch_op.add_column(
            sa.Column(
                "is_off_topic_drift",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            ),
        )
        batch_op.create_index(
            "ix_raw_posts_is_off_topic_drift",
            ["is_off_topic_drift"],
            unique=False,
        )


def downgrade() -> None:
    """Drop is_off_topic_drift + its index."""
    with op.batch_alter_table("raw_posts") as batch_op:
        batch_op.drop_index("ix_raw_posts_is_off_topic_drift")
        batch_op.drop_column("is_off_topic_drift")
