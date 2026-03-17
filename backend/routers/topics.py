"""
Topics router — GET /api/games/{game_id}/topics

Returns topic trend records for a game with optional filters for
time period, sentiment category, and trend direction.
"""
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from models import Game, SentimentEnum, TopicTrend, TrendDirectionEnum
from schemas import PeriodEnum, TopicTrendResponse

router = APIRouter(prefix="/games", tags=["topics"])


@router.get("/{game_id}/topics", response_model=List[TopicTrendResponse])
def get_topics(
    game_id: int,
    period: PeriodEnum = Query(
        PeriodEnum.weekly,
        description="Filter topics whose last_seen falls within the window.",
    ),
    direction: Optional[str] = Query(
        None,
        description="Filter by trend direction: rising | falling | stable",
    ),
    sentiment: Optional[str] = Query(
        None,
        description="Filter by sentiment: positive | negative | neutral",
    ),
    db: Session = Depends(get_db),
):
    """
    Return topic trends for a game.

    - `period` limits results to topics last seen within the window.
    - `direction` filters by trend_direction enum value.
    - `sentiment` filters by sentiment enum value.
    - Results are ordered by mention_count descending.
    """
    if not db.query(Game).filter_by(id=game_id).first():
        raise HTTPException(status_code=404, detail="Game not found.")

    q = db.query(TopicTrend).filter(TopicTrend.game_id == game_id)

    # Period filter — restrict to topics seen within the window
    today = date.today()
    period_starts = {
        PeriodEnum.today:     today,
        PeriodEnum.weekly:    today - timedelta(days=7),
        PeriodEnum.monthly:   today - timedelta(days=30),
        PeriodEnum.quarterly: today - timedelta(days=90),
        PeriodEnum.lifetime:  None,
    }
    p_start = period_starts[period]
    if p_start:
        q = q.filter(TopicTrend.last_seen >= p_start)

    # Direction filter
    if direction:
        try:
            q = q.filter(TopicTrend.trend_direction == TrendDirectionEnum(direction))
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid direction '{direction}'. "
                       f"Valid values: rising, falling, stable",
            )

    # Sentiment filter
    if sentiment:
        try:
            q = q.filter(TopicTrend.sentiment == SentimentEnum(sentiment))
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid sentiment '{sentiment}'. "
                       f"Valid values: positive, negative, neutral",
            )

    return q.order_by(TopicTrend.mention_count.desc()).all()
