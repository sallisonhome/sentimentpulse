"""Add tiktok_comment source (no new table or destructive rewrite).

Revision ID: 0022
Revises: 0021
"""
from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute("ALTER TYPE sourceenum ADD VALUE IF NOT EXISTS 'tiktok_comment'")


def downgrade():
    # PostgreSQL enum removal requires a table rewrite; retain the harmless
    # value. SQLite already uses VARCHAR and needs no DDL.
    pass
