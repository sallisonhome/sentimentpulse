"""Add distinctive_keywords column to games table (§14 Context-Aware Attribution)

Revision ID: 0003
Revises: 0002
Create Date: 2025-01-01 00:00:00.000000 UTC

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


# ── Seed: distinctive keywords per game name ──────────────────────────────────
# Keys are exact game.name values as stored in the DB.
# Values are JSON lists of strings — keywords or keyphrases, checked as
# case-insensitive whole-word / whole-phrase matches in post_relevance.py.
#
# Design rules for single-word or IP-adjacent titles (per CLAUDE.md §14):
#   • Require ≥1 multi-word phrase so the filter can't match on a common word.
#   • Include the community shorthand (e.g. "MCC") only if it's genuinely
#     unambiguous within gaming discussion.
#   • Never use the raw IP name alone as a keyword — always qualify it with
#     "game", a subtitle, or a community-specific term.
_SEED_KEYWORDS: dict[str, list[str]] = {
    # ── Spec-provided examples (used verbatim) ─────────────────────────────
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

    # ── Other common ambiguous-title games ─────────────────────────────────
    "Inversion": [
        "Inversion game",
        "Inversion shooter",
        "Inversion gravity",
        "Inversion Sabre",
    ],

    # ── Halo franchise titles (disambiguate from each other) ───────────────
    "Halo Infinite": [
        "Halo Infinite",
        "Infinite campaign",
        "Halo BR",
    ],
    "Halo 5: Guardians": [
        "Halo 5",
        "Halo 5 Guardians",
        "H5",
    ],
    "Halo Wars 2": [
        "Halo Wars 2",
        "HW2",
        "Halo Wars sequel",
    ],
    "Halo Wars: Definitive Edition": [
        "Halo Wars Definitive",
        "HW1",
        "Halo Wars remaster",
    ],

    # ── Other potential titles (fill based on publisher's actual catalog) ───
    "Gears 5": [
        "Gears 5",
        "Gears of War 5",
        "G5",
    ],
    "Gears Tactics": [
        "Gears Tactics",
        "Gears strategy game",
        "Gears turn-based",
    ],
    "Gears of War: Ultimate Edition": [
        "Gears Ultimate",
        "Gears of War Ultimate",
        "GoW UE",
    ],
    "The Outer Worlds": [
        "Outer Worlds game",
        "TOW game",
        "Halcyon colony",
    ],
    "The Outer Worlds 2": [
        "Outer Worlds 2",
        "TOW2",
        "Obsidian sequel Outer",
    ],
    "Avowed": [
        "Avowed game",
        "Avowed Eora",
        "Obsidian RPG Avowed",
    ],
    "Pentiment": [
        "Pentiment game",
        "Pentiment Obsidian",
        "Bavarian narrative game",
    ],
    "Grounded": [
        "Grounded game",
        "Grounded survival shrunk",
        "backyard survival game",
    ],
    "As Dusk Falls": [
        "As Dusk Falls",
        "Dusk Falls game",
        "INTERIOR NIGHT game",
    ],
    "Contraband": [
        "Contraband game",
        "Avalanche Contraband",
        "smuggler game Contraband",
    ],
    "Everwild": [
        "Everwild game",
        "Rare Everwild",
        "nature spirits game",
    ],
    "Fable": [
        "Fable game 2024",
        "Fable reboot",
        "Playground Fable",
    ],
    "Perfect Dark": [
        "Perfect Dark game",
        "Perfect Dark reboot",
        "Joanna Dark game",
        "Initiative Perfect Dark",
    ],
    "State of Decay 3": [
        "State of Decay 3",
        "SoD3",
        "Undead Labs sequel",
    ],
    "Age of Empires IV": [
        "Age of Empires IV",
        "AoE4",
        "AoE IV",
    ],
    "Age of Empires II: Definitive Edition": [
        "AoE2 DE",
        "Age of Empires 2 Definitive",
        "AoE2DE",
    ],
    "Microsoft Flight Simulator": [
        "MSFS",
        "Flight Simulator 2020",
        "FS2020",
        "MSFS2024",
        "Flight Sim Microsoft",
    ],
    "Minecraft Dungeons": [
        "Minecraft Dungeons",
        "MC Dungeons",
        "Dungeons Mojang",
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
