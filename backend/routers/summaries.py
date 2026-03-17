"""
Summaries router — GET /api/games/{game_id}/summaries

Returns the list of daily summaries for a game filtered by time period.
Each summary includes AI-generated executive text and recommended actions.
"""
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from models import DailySummary, Game
from schemas import DailySummaryResponse, PeriodEnum

router = APIRouter(prefix="/games", tags=["summaries"])


def _period_start(period: PeriodEnum) -> Optional[date]:
    today = date.today()
    return {
        PeriodEnum.today:     today,
        PeriodEnum.weekly:    today - timedelta(days=7),
        PeriodEnum.monthly:   today - timedelta(days=30),
        PeriodEnum.quarterly: today - timedelta(days=90),
        PeriodEnum.lifetime:  None,
    }[period]


@router.get("/{game_id}/summaries", response_model=List[DailySummaryResponse])
def get_summaries(
    game_id: int,
    period: PeriodEnum = Query(PeriodEnum.weekly),
    db: Session = Depends(get_db),
):
    """
    Return daily summaries for a game, newest first.
    Use ?period=weekly|monthly|quarterly|lifetime to limit the date window.
    """
    if not db.query(Game).filter_by(id=game_id).first():
        raise HTTPException(status_code=404, detail="Game not found.")

    q = db.query(DailySummary).filter(DailySummary.game_id == game_id)

    start = _period_start(period)
    if start:
        q = q.filter(DailySummary.summary_date >= start)

    return q.order_by(DailySummary.summary_date.desc()).all()
