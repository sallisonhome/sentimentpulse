"""Add 'dtf' to SourceEnum

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-26 23:53:00.000000 UTC

Adds 'dtf' as the fifth value of SourceEnum (DTF.ru — Russian-language
gaming forum). Same PostgreSQL/SQLite handling as migration 0006 which
added 'bluesky' — see that file's docstring for the rationale.

DTF is a subsite-based publication platform. We hit its public read API
(api.dtf.ru, v2.31 / v3.0) to search for game keywords and fetch entries.
No auth is required for reads. Content includes long-form articles and
their comment threads, all in Russian.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add 'dtf' to the sourceenum type (PostgreSQL only; no-op on SQLite)."""
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        bind.execute(
            sa.text("ALTER TYPE sourceenum ADD VALUE IF NOT EXISTS 'dtf'")
        )
    # SQLite: no DDL required. SourceEnum is VARCHAR; the Python enum accepts
    # the new value directly (see models.py SourceEnum.dtf).


def downgrade() -> None:
    """No-op — PostgreSQL doesn't support removing ENUM values non-destructively.

    Operators rolling back the app should simply stop the code path that
    writes 'dtf' rows; existing rows remain in the DB but become unreachable
    from the application. See 0006's docstring for full rationale.
    """
    pass
