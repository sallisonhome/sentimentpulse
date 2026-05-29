"""Add 'bluesky' to SourceEnum

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-30 00:00:00.000000 UTC

Adds 'bluesky' as the fourth value of SourceEnum.

SQLite stores enum values as VARCHAR with a CHECK constraint, but SQLAlchemy's
Enum on SQLite does NOT emit a CHECK constraint by default (create_constraint
is False on SQLite).  The enum validation is handled entirely by Python / the
ORM layer, so there is no database-level constraint to migrate on SQLite.

On PostgreSQL, the native ENUM type *does* exist and requires an
  ALTER TYPE sourceenum ADD VALUE 'bluesky'
statement.  Downgrade is a no-op on PostgreSQL because ENUM values cannot be
removed without recreating the type (which would require dropping all columns
that reference it — far too destructive for a downgrade).  Operators wishing
to roll back should deploy the prior application code, which will simply never
write 'bluesky' rows.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add 'bluesky' to the sourceenum type (PostgreSQL only; no-op on SQLite)."""
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        # PostgreSQL native ENUM: add the new value.
        # IF NOT EXISTS is available in PostgreSQL 9.6+ and is safe to use here.
        bind.execute(
            sa.text("ALTER TYPE sourceenum ADD VALUE IF NOT EXISTS 'bluesky'")
        )

    # SQLite: SourceEnum is stored as VARCHAR — no DDL change required.
    # The Python SourceEnum class already has bluesky = "bluesky" (models.py),
    # so the ORM will accept and write the new value without any migration DDL.


def downgrade() -> None:
    """Downgrade is a no-op on all dialects.

    PostgreSQL does not support removing ENUM values without recreating the
    type.  Operators rolling back to the previous application version will
    simply have no code paths that write 'bluesky' rows — any existing rows
    with source='bluesky' will remain in the database but be unreachable via
    the application.

    SQLite: no DDL was changed in upgrade(), so there is nothing to undo.
    """
    pass
