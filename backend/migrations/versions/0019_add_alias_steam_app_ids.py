"""Add games.alias_steam_app_ids for parent/child appid grouping

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-18 12:30:00.000000 UTC

Motivating case (Hellraiser Revival demo, 2026-09-18): Steve released a
playable demo on Steam (appid 5184670) whose parent app is Hellraiser
Revival main (appid 1551980). Steam's own store metadata records the
parent relationship, but SentimentPulse's ingest pipeline never reads
it — Step 2 (Steam reviews) and Step 3 (Steam forums) call
`fetch_reviews(game.steam_app_id, ...)` and `scrape_forum_threads(
game.steam_app_id, ...)` respectively, so each game.id can only cover
ONE appid. The demo ended up as its own separate games row (id=155),
splitting Hellraiser Revival's sentiment corpus in two.

This migration adds a `alias_steam_app_ids` JSON column that holds
additional appids to fetch under the same game.id. NULL / empty list =
unchanged behavior; the ingest change in the same landing loops over
`[primary + aliases]` when the column is populated.

Backward compatibility:
- All existing rows get NULL by default. Step 2 / Step 3 treat NULL and
  [] identically as "no aliases".
- Existing SQLite deployments accept the ALTER cleanly.
- The alias column is NOT globally unique — the primary steam_app_id
  keeps its UNIQUE constraint. Alias appids are informally expected to
  be unique across games too, but enforcement is deferred to the admin
  endpoint that writes them (it rejects an alias that appears as any
  other game's primary steam_app_id).

Downgrade drops the column.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0019"
down_revision: Union[str, None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add nullable JSON column for alias Steam appids."""
    with op.batch_alter_table("games") as batch_op:
        batch_op.add_column(
            sa.Column(
                "alias_steam_app_ids",
                sa.JSON(),
                nullable=True,
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("games") as batch_op:
        batch_op.drop_column("alias_steam_app_ids")
