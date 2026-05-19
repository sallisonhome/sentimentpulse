"""Fix name mismatches in 0003 seed — patches 5 base games missed due to exact-name mismatch.

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-19 21:10:00.000000 UTC

The 0003 seed used canonical-looking names ("Warhammer 40K: Space Marine 2",
"Inversion", "TimeShift", "Ghostbusters Remastered") but the production DB uses
the Steam-canonical names which include commas, trademark symbols, or different
suffixes:

  - "Warhammer 40,000: Space Marine 2"          (comma)
  - "Inversion™"                                 (TM)
  - "TimeShift™"                                 (TM)
  - "Ghostbusters: The Video Game Remastered"   (full Steam title)
  - "Halo: Combat Evolved Anniversary"          (was not in 0003 seed)

This migration UPDATEs those rows with the correct keywords so the §14 filter
applies to them.  No-op for any name not present.
"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PATCHES: dict[str, list[str]] = {
    "Warhammer 40,000: Space Marine 2": [
        "Space Marine 2",
        "SM2",
        "Warhammer Space Marine 2",
        "WH40K Space Marine 2",
        "Space Marine II",
    ],
    "Inversion™": [
        "Inversion game",
        "Inversion shooter",
        "Inversion gravity",
        "Inversion Saber",
    ],
    "TimeShift™": [
        "TimeShift game",
        "TimeShift Saber",
        "TimeShift FPS",
    ],
    "Ghostbusters: The Video Game Remastered": [
        "Ghostbusters Remastered",
        "Ghostbusters Video Game Remastered",
        "Ghostbusters 2009 remaster",
    ],
    "Halo: Combat Evolved Anniversary": [
        "Halo CE Anniversary",
        "Halo CEA",
        "Combat Evolved Anniversary",
        "Halo: CE Anniversary",
    ],
}


def upgrade() -> None:
    bind = op.get_bind()
    for game_name, keywords in _PATCHES.items():
        bind.execute(
            sa.text("UPDATE games SET distinctive_keywords = :kw WHERE name = :name"),
            {"kw": json.dumps(keywords), "name": game_name},
        )


def downgrade() -> None:
    # Idempotent rollback: clear keywords on the patched rows.
    bind = op.get_bind()
    for game_name in _PATCHES.keys():
        bind.execute(
            sa.text("UPDATE games SET distinctive_keywords = '[]' WHERE name = :name"),
            {"name": game_name},
        )
