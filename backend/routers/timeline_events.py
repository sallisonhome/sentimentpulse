"""
Timeline events endpoints (2026-07-26).

CRUD for user-authored events overlaid on the Post Volume by Title
chart on a parent dashboard. Events belong to a specific Game (parent
or competitor), but the whole feature is only available on games that
are part of a parent/competitor relationship — enforced here in the
router so the UI's hide-when-standalone rule is backed up server-side.

Endpoints:
  GET    /api/games/{game_id}/timeline-events        — list events for a game
  POST   /api/games/{game_id}/timeline-events        — create
  DELETE /api/games/{game_id}/timeline-events/{id}   — delete
"""
from __future__ import annotations

from datetime import date, datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from database import get_db
from models import CompetitorGame, Game, TimelineEvent

router = APIRouter(prefix="/games", tags=["timeline-events"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class TimelineEventCreate(BaseModel):
    event_date: date = Field(..., description="Calendar date of the event (YYYY-MM-DD).")
    name: str = Field(..., min_length=1, max_length=120,
                       description="Concise description shown in the chart tooltip.")

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        stripped = (v or "").strip()
        if not stripped:
            raise ValueError("name must not be empty or whitespace")
        return stripped


class TimelineEventOut(BaseModel):
    id: int
    game_id: int
    event_date: date
    name: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Scope guard ───────────────────────────────────────────────────────────────

def _game_is_in_competitor_group(db: Session, game_id: int) -> bool:
    """
    True iff `game_id` is either a parent (has any competitor rows) OR a
    competitor (has a row where competitor_id == game_id). Standalone
    games with no parent/competitor relationship must NOT have events —
    the whole feature is scoped to comparison groups.
    """
    is_parent = (
        db.query(CompetitorGame.id)
        .filter(CompetitorGame.parent_id == game_id)
        .first()
        is not None
    )
    if is_parent:
        return True
    is_competitor = (
        db.query(CompetitorGame.id)
        .filter(CompetitorGame.competitor_id == game_id)
        .first()
        is not None
    )
    return is_competitor


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{game_id}/timeline-events", response_model=List[TimelineEventOut])
def list_timeline_events(game_id: int, db: Session = Depends(get_db)):
    """List timeline events for a game, oldest → newest by event_date."""
    if db.query(Game).filter_by(id=game_id).first() is None:
        raise HTTPException(status_code=404, detail=f"game {game_id} not found")
    events = (
        db.query(TimelineEvent)
        .filter(TimelineEvent.game_id == game_id)
        .order_by(TimelineEvent.event_date.asc(), TimelineEvent.id.asc())
        .all()
    )
    return events


@router.post(
    "/{game_id}/timeline-events",
    response_model=TimelineEventOut,
    status_code=status.HTTP_201_CREATED,
)
def create_timeline_event(
    game_id: int,
    payload: TimelineEventCreate,
    db: Session = Depends(get_db),
):
    """
    Create a timeline event on a game. Requires the game to be part of a
    parent/competitor relationship — returns 409 if the game is standalone.
    """
    if db.query(Game).filter_by(id=game_id).first() is None:
        raise HTTPException(status_code=404, detail=f"game {game_id} not found")
    if not _game_is_in_competitor_group(db, game_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Timeline events are only available for games in a "
                "parent/competitor group. Add competitors to this title "
                "first, or add this title as a competitor under a parent."
            ),
        )
    ev = TimelineEvent(
        game_id=game_id,
        event_date=payload.event_date,
        name=payload.name,
    )
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return ev


@router.delete(
    "/{game_id}/timeline-events/{event_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_timeline_event(
    game_id: int,
    event_id: int,
    db: Session = Depends(get_db),
):
    ev = (
        db.query(TimelineEvent)
        .filter(TimelineEvent.id == event_id, TimelineEvent.game_id == game_id)
        .first()
    )
    if ev is None:
        raise HTTPException(status_code=404, detail="event not found")
    db.delete(ev)
    db.commit()
    return None
