"""Add composite index on raw_posts(game_id, post_date) for dashboard aggregation

Revision ID: 0020
Revises: 0019
Create Date: 2026-09-21 03:20:00.000000 UTC

Motivating case (2026-09-20/21 dashboard 504 incident): the /dashboard
endpoint's KPI, trend, and volume-by-source queries all filter on
`raw_posts.game_id = ? AND raw_posts.post_date >= ?` (or scan lifetime
for a game), then JOIN sentiment_records via raw_post_id. Live EXPLAIN
QUERY PLAN against the droplet showed the planner leading with
`ix_raw_posts_is_off_topic_drift` — a boolean-column index with ~50%
selectivity — which forces a scan of ~500k of 1,067,993 raw_posts rows,
then a nested-loop join per row into sentiment_records. Heavy titles
(Hellraiser: Revival, game_id=21, ~35k posts) times out through nginx's
120s proxy_read_timeout on the monthly / quarterly / lifetime dashboard
periods.

With a composite index (game_id, post_date), the planner leads on
`game_id=?` — jumping straight to the target title's 35k rows — and
uses the second key to seek to `post_date >= ?` directly. Estimated
speedup: 10-100x for filtered queries, no impact on the lifetime
(no-date-filter) case beyond what the existing `ix_raw_posts_game_id`
already provides.

Additive: no data change, no column change, no existing index removed.
Safe to run online against a live DB — CREATE INDEX takes a brief
table lock while building (~seconds on 1M rows). Deploy workflow runs
`alembic upgrade head` before service restart, so the index exists by
the time the API takes traffic again.

Downgrade drops the index.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "0020"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create the composite index that unblocks dashboard aggregation.

    The single-column ix_raw_posts_game_id already exists (created in
    0001); this index is more specific and will win the planner
    tie-break for the exact predicate the dashboard endpoint issues.
    """
    op.create_index(
        "ix_raw_posts_game_id_post_date",
        "raw_posts",
        ["game_id", "post_date"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_raw_posts_game_id_post_date", table_name="raw_posts")
