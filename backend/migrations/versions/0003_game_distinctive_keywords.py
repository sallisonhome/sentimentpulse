"""Add distinctive_keywords column to games table (§14 Context-Aware Attribution)

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-19 20:00:00.000000 UTC

Adds Game.distinctive_keywords — a JSON list of strings (keywords / keyphrases)
that uniquely identify a specific game title vs the broader IP, movie, or brand
it shares a name with.  Used by the §14 post-relevance filter to determine
whether a general-community post is actually *about* this game vs merely
mentioning the underlying IP.

Rules for keyword selection
----------------------------
- Single-word games that collide with well-known IPs/brands MUST use multi-word
  phrases (e.g. "Docked" → ["Docked game", "Docked TV", "TV gaming setup"]).
- IP-sharing games need IP-distinguishing phrases (e.g. John Wick game → phrasing
  that disambiguates from the film franchise).
- Prefer community-used abbreviations and common shorthand over marketing copy.
"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ── Seed: distinctive keywords per Saber Interactive game ─────────────────────
# Keys are exact game.name values as stored in the production DB
# (see backend/fix_subreddits.py for the canonical catalogue).
# Values are JSON lists of strings — keywords or keyphrases, checked as
# case-insensitive whole-word / whole-phrase matches in post_relevance.py.
#
# Design rules per CLAUDE.md §14:
#   • Single-word or IP-adjacent titles require ≥1 multi-word phrase so the
#     filter can't match on a common word (e.g. "Docked", "Inversion", "Fable").
#   • Include the community shorthand (e.g. "MCC", "SM2") when unambiguous.
#   • Never use the raw IP/movie name alone as a keyword — always qualify it
#     with "game", a subtitle, a studio name, or a community-specific term.
_SEED_KEYWORDS: dict[str, list[str]] = {
    # ── Spec-provided examples ─────────────────────────────────────────────
    "Untitled John Wick Game": [
        "John Wick game",
        "Wick assassin game",
        "Continental game",
        "Bithell John Wick",
    ],
    "Halo: The Master Chief Collection": [
        "MCC",
        "Master Chief Collection",
        "Halo MCC",
        "Halo collection",
    ],
    "Docked": [
        "Docked game",
        "Docked TV game",
        "TV gaming setup game",
        "Docked steam game",
    ],

    # ── Other Saber-published / Saber-developed titles ─────────────────────
    "Tempest Rising": [
        "Tempest Rising",
        "Tempest RTS",
        "Slipgate Tempest",
    ],
    "A Quiet Place: The Road Ahead": [
        "Quiet Place game",
        "Road Ahead game",
        "Quiet Place Road Ahead",
        "Saber Quiet Place",
    ],
    "The Knightling": [
        "Knightling",
        "Knightling game",
        "Twirlbound Knightling",
    ],
    "Dakar Desert Rally": [
        "Dakar Desert Rally",
        "Dakar rally game",
        "Dakar DDR",
    ],
    "Clive Barker's Hellraiser: Revival": [
        "Hellraiser Revival",
        "Hellraiser game",
        "Boss Team Hellraiser",
        "Clive Barker Hellraiser game",
    ],
    "Jurassic Park: Survival": [
        "Jurassic Park Survival",
        "JP Survival",
        "Jurassic Survival game",
        "Saber Jurassic",
    ],
    "Turok: Origins": [
        "Turok Origins",
        "Turok game",
        "Saber Turok",
    ],
    "Warhammer 40K: Space Marine 2": [
        "Space Marine 2",
        "SM2",
        "Warhammer Space Marine 2",
        "WH40K Space Marine 2",
        "Space Marine II",
    ],
    "John Carpenter's Toxic Commando": [
        "Toxic Commando",
        "Carpenter Toxic Commando",
        "Saber Toxic Commando",
    ],
    "SnowRunner": [
        "SnowRunner",
        "Snow Runner game",
        "SnowRunner truck",
    ],
    "RoadCraft": [
        "RoadCraft",
        "Road Craft game",
        "Saber RoadCraft",
    ],
    "Gloomhaven": [
        "Gloomhaven",
        "Gloomhaven digital",
        "Gloomhaven video game",
    ],
    "Expeditions: A MudRunner Game": [
        "Expeditions MudRunner",
        "MudRunner Expeditions",
        "Expeditions A MudRunner Game",
    ],
    "MudRunner": [
        "MudRunner",
        "Mud Runner game",
        "MudRunner truck",
    ],
    "Crysis 3 Remastered": [
        "Crysis 3 Remastered",
        "Crysis 3 remaster",
        "C3R",
    ],
    "Crysis 2 Remastered": [
        "Crysis 2 Remastered",
        "Crysis 2 remaster",
        "C2R",
    ],
    "Ghostbusters Remastered": [
        "Ghostbusters Remastered",
        "Ghostbusters Video Game Remastered",
        "Ghostbusters 2009 remaster",
    ],
    "TimeShift": [
        "TimeShift game",
        "TimeShift Saber",
        "TimeShift FPS",
    ],
    "MX Nitro": [
        "MX Nitro",
        "MX Nitro game",
    ],
    "Inversion": [
        "Inversion game",
        "Inversion shooter",
        "Inversion gravity",
        "Inversion Saber",
    ],
    "Halo 2: Anniversary": [
        "Halo 2 Anniversary",
        "H2A",
        "Halo 2A",
    ],
    "Halo 3": [
        "Halo 3 campaign",
        "H3 MCC",
        "Halo 3 multiplayer",
    ],
    "MudRunner Old-timers DLC": [
        "Old-timers DLC",
        "MudRunner Old-timers",
        "Old timers DLC",
    ],
    "RoadCraft Reclaim Expansion": [
        "Reclaim Expansion",
        "RoadCraft Reclaim",
        "RoadCraft expansion",
    ],
}


def upgrade() -> None:
    # ── 1. Add the column (nullable, default empty list) ──────────────────────
    op.add_column(
        "games",
        sa.Column("distinctive_keywords", sa.JSON(), nullable=True, server_default=sa.text("'[]'")),
    )

    # ── 2. Seed known games ───────────────────────────────────────────────────
    # Use a raw UPDATE per game name so we don't depend on game IDs (which vary
    # across dev / staging / production databases).
    bind = op.get_bind()
    for game_name, keywords in _SEED_KEYWORDS.items():
        bind.execute(
            sa.text("UPDATE games SET distinctive_keywords = :kw WHERE name = :name"),
            {"kw": json.dumps(keywords), "name": game_name},
        )


def downgrade() -> None:
    # SQLite doesn't support DROP COLUMN directly — use a workaround only if
    # needed. For PostgreSQL this is straightforward.
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.drop_column("games", "distinctive_keywords")
    # On SQLite: leave the column in place (acceptable for dev/test teardown).
