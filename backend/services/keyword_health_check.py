"""
Startup validation — warns about active games with no distinctive_keywords
configured.

Added 2026-07-24 alongside the relevance-gate hard-block change: a game
with an empty (or null) `distinctive_keywords` list is now gated OUT of
sentiment classification entirely (see services/post_relevance.py). Silently
shipping zero sentiment for such a game would be confusing without an
operator-visible signal, so this check runs once at app boot and logs a
WARNING per affected game.
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from models import Game

logger = logging.getLogger(__name__)


def check_missing_keywords(db: Session) -> list[tuple[int, str]]:
    """
    Query active games with no distinctive_keywords configured (NULL or
    empty list) and log a WARNING for each. Returns the list of
    (game_id, game_name) tuples found, mainly for testability.
    """
    games = (
        db.query(Game)
        .filter(Game.is_active == True)  # noqa: E712
        .all()
    )

    missing: list[tuple[int, str]] = []
    for game in games:
        kw = game.distinctive_keywords
        if not kw:  # covers None and []
            missing.append((game.id, game.name))

    for game_id, name in missing:
        logger.warning(
            "Active game id=%d name=%r has no distinctive_keywords configured. "
            "Its posts will be filtered out by the relevance gate and it will "
            "show zero sentiment. Configure keywords via PATCH /api/games/%d.",
            game_id, name, game_id,
        )

    if missing:
        logger.warning(
            "%d active game(s) missing distinctive_keywords at startup: %s",
            len(missing),
            ", ".join(f"{gid}:{name!r}" for gid, name in missing),
        )
    else:
        logger.info("Startup keyword check: all active games have distinctive_keywords configured.")

    return missing
