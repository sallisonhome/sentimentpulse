"""
Games router.

Routes (all under /api/games):
  GET  /games               — list all games
  GET  /games/latest        — most recently added game (default UI selection)
  GET  /games/{game_id}     — game detail + most recent daily summary
  PATCH /games/{game_id}    — update is_active flag or subreddit list

NOTE: /games/latest MUST be declared before /games/{game_id} so FastAPI
matches the literal "latest" before treating it as an integer path param.
"""
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from models import DailySummary, Game
from schemas import (
    DailySummaryResponse,
    GameDetailResponse,
    GameResponse,
    GameSettingsUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/games", tags=["games"])


@router.get("", response_model=List[GameResponse])
def list_games(
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    db: Session = Depends(get_db),
):
    """List all discovered games, newest first."""
    q = db.query(Game)
    if is_active is not None:
        q = q.filter(Game.is_active == is_active)
    return q.order_by(Game.id.desc()).all()


@router.get("/latest", response_model=GameResponse)
def get_latest_game(db: Session = Depends(get_db)):
    """
    Return the most recently added game (highest id).
    This is the default selected game in the frontend sidebar.
    """
    game = db.query(Game).filter(Game.is_active == True).order_by(Game.id.desc()).first()  # noqa: E712
    if not game:
        raise HTTPException(status_code=404, detail="No games found.")
    return game


@router.get("/{game_id}", response_model=GameDetailResponse)
def get_game(game_id: int, db: Session = Depends(get_db)):
    """Return a single game with its most recent daily summary attached."""
    game = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found.")

    latest = (
        db.query(DailySummary)
        .filter_by(game_id=game_id)
        .order_by(DailySummary.summary_date.desc())
        .first()
    )

    # Build response manually to embed the nested latest_summary
    game_data = GameResponse.model_validate(game).model_dump()
    return GameDetailResponse(
        **game_data,
        latest_summary=(
            DailySummaryResponse.model_validate(latest) if latest else None
        ),
    )


@router.patch("/{game_id}", response_model=GameResponse)
def update_game(
    game_id: int,
    data: GameSettingsUpdate,
    db: Session = Depends(get_db),
):
    """
    Partially update a game's settings.
    - is_active: enable / disable ingestion for this game
    - subreddits: override the auto-detected subreddit list
    """
    game = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found.")

    if data.is_active is not None:
        game.is_active = data.is_active
    if data.subreddits is not None:
        game.subreddits = data.subreddits

    try:
        db.commit()
        db.refresh(game)
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")

    return game
