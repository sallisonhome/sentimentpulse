"""Add editorial_articles table + Game.demographic_context column

Revision ID: 0009
Revises: 0008
Create Date: 2026-06-29 16:50:00.000000 UTC

CLAUDE.md §24 (Editorial-Research Hybrid Bold Ideas).

Two changes:

1. `editorial_articles` table caches per-title editorial research per
   cycle.  Each row stores one article's URL, headline, lead paragraph
   or full body, an LLM-generated single-paragraph evidence summary,
   and the [E-NNN] citation tag assigned for that cycle.  The cache
   key is (game_id, scope, cycle_start, url) so re-running a digest
   reuses the existing batch.

2. `games.demographic_context` TEXT column holds a per-title brief
   describing the target demographic and IP-awareness gap.  Used by
   the bold-ideas prompt to ground speculative reasoning about
   cohorts (e.g. Hellraiser → <40 IP-awareness gap; Turok → N64-
   nostalgia 35-45 cohort).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_GAMES_TABLE = "games"
_DEMOGRAPHIC_COLUMN = "demographic_context"
_EDITORIAL_TABLE = "editorial_articles"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 1. Add games.demographic_context if not already present.
    existing_game_cols = {col["name"] for col in inspector.get_columns(_GAMES_TABLE)}
    if _DEMOGRAPHIC_COLUMN not in existing_game_cols:
        op.add_column(
            _GAMES_TABLE,
            sa.Column(_DEMOGRAPHIC_COLUMN, sa.Text(), nullable=True),
        )

    # 2. Create editorial_articles table if not already present.
    existing_tables = set(inspector.get_table_names())
    if _EDITORIAL_TABLE not in existing_tables:
        op.create_table(
            _EDITORIAL_TABLE,
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "game_id",
                sa.Integer(),
                sa.ForeignKey("games.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column(
                "scope",
                sa.String(length=16),
                nullable=False,
                comment="'weekly' or 'monthly' — which digest cycle this batch is for",
            ),
            sa.Column(
                "cycle_start",
                sa.Date(),
                nullable=False,
                comment="Start of the digest window this batch was fetched for",
            ),
            sa.Column("cycle_end", sa.Date(), nullable=False),
            sa.Column("url", sa.Text(), nullable=False),
            sa.Column("title", sa.Text(), nullable=True),
            sa.Column(
                "publication",
                sa.String(length=255),
                nullable=True,
                comment="Domain name (e.g. ign.com, polygon.com)",
            ),
            sa.Column(
                "published_at",
                sa.DateTime(timezone=True),
                nullable=True,
                comment="Article's own publish date if discoverable",
            ),
            sa.Column(
                "fetched_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "body",
                sa.Text(),
                nullable=True,
                comment="Full-text or lead 3 paragraphs of the article",
            ),
            sa.Column(
                "summary",
                sa.Text(),
                nullable=True,
                comment="LLM-generated single-paragraph evidence summary",
            ),
            sa.Column(
                "cite",
                sa.String(length=8),
                nullable=False,
                comment="'E-001', 'E-002' — citation tag assigned per cycle",
            ),
            sa.UniqueConstraint(
                "game_id", "scope", "cycle_start", "url",
                name="uq_editorial_articles_game_scope_cycle_url",
            ),
        )
        op.create_index(
            "idx_editorial_articles_game_scope_cycle",
            _EDITORIAL_TABLE,
            ["game_id", "scope", "cycle_start"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        return
    inspector = sa.inspect(bind)
    if _EDITORIAL_TABLE in set(inspector.get_table_names()):
        op.drop_index(
            "idx_editorial_articles_game_scope_cycle",
            table_name=_EDITORIAL_TABLE,
        )
        op.drop_table(_EDITORIAL_TABLE)
    existing_game_cols = {col["name"] for col in inspector.get_columns(_GAMES_TABLE)}
    if _DEMOGRAPHIC_COLUMN in existing_game_cols:
        op.drop_column(_GAMES_TABLE, _DEMOGRAPHIC_COLUMN)
