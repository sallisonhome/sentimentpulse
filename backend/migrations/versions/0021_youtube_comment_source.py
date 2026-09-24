"""Add youtube_comment source (no new table or destructive rewrite).

Revision ID: 0021
Revises: 0020
"""
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute("ALTER TYPE sourceenum ADD VALUE IF NOT EXISTS 'youtube_comment'")


def downgrade():
    # PostgreSQL enum removal requires a table rewrite; retain the harmless
    # value. SQLite already uses VARCHAR and needs no DDL.
    pass
