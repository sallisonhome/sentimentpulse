"""
Posts router — GET /api/games/{game_id}/posts

Paginated raw-post browser with filters for sentiment, source, and date range.
Sentiment records are loaded via an outer join so unclassified posts are still
returned (sentiment_info will be null for them).
"""
import math
import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, contains_eager

from database import get_db
from models import Game, RawPost, SentimentEnum, SentimentRecord, SourceEnum
from schemas import PostSentimentInfo, PostsPageResponse, RawPostResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/games", tags=["posts"])


@router.get("/{game_id}/posts", response_model=PostsPageResponse)
def get_posts(
    game_id: int,
    # Filters
    sentiment: Optional[str] = Query(
        None, description="positive | negative | neutral"
    ),
    source: Optional[str] = Query(
        None, description="steam_review | steam_forum | reddit"
    ),
    date_from: Optional[str] = Query(
        None, description="ISO date string, e.g. 2024-01-15"
    ),
    date_to: Optional[str] = Query(
        None, description="ISO date string, e.g. 2024-01-22"
    ),
    # Pagination
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """
    Browse raw posts with optional filtering and pagination.

    Returns 50 posts per page by default (configurable up to 200).
    Posts are ordered newest-collected first.
    """
    if not db.query(Game).filter_by(id=game_id).first():
        raise HTTPException(status_code=404, detail="Game not found.")

    # Base query — outer-join SentimentRecord so unclassified posts are included
    q = (
        db.query(RawPost)
        .outerjoin(RawPost.sentiment_record)
        .options(contains_eager(RawPost.sentiment_record))
        .filter(RawPost.game_id == game_id)
    )

    # ── Filters ───────────────────────────────────────────────────────────────

    if sentiment:
        try:
            se = SentimentEnum(sentiment)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid sentiment '{sentiment}'. "
                       f"Valid values: positive, negative, neutral",
            )
        # Filtering by sentiment implicitly excludes unclassified posts
        q = q.filter(SentimentRecord.sentiment == se)

    if source:
        try:
            src = SourceEnum(source)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid source '{source}'. "
                       f"Valid values: steam_review, steam_forum, reddit",
            )
        q = q.filter(RawPost.source == src)

    if date_from:
        try:
            q = q.filter(RawPost.collected_at >= datetime.fromisoformat(date_from))
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid date_from '{date_from}'. Use ISO format YYYY-MM-DD.",
            )

    if date_to:
        try:
            q = q.filter(RawPost.collected_at <= datetime.fromisoformat(date_to))
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid date_to '{date_to}'. Use ISO format YYYY-MM-DD.",
            )

    # ── Pagination ────────────────────────────────────────────────────────────

    total: int = q.count()
    total_pages = math.ceil(total / page_size) if total else 1

    posts: List[RawPost] = (
        q.order_by(RawPost.collected_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # ── Serialise ─────────────────────────────────────────────────────────────

    items = []
    for post in posts:
        sr: Optional[SentimentRecord] = post.sentiment_record
        sentiment_info = (
            PostSentimentInfo(
                sentiment=sr.sentiment.value,
                sentiment_score=sr.sentiment_score,
                topics=sr.topics,
            )
            if sr else None
        )
        items.append(RawPostResponse(
            id=post.id,
            game_id=post.game_id,
            source=post.source.value,
            external_id=post.external_id,
            author=post.author,
            title=post.title,
            body=post.body,
            url=post.url,
            upvotes=post.upvotes,
            collected_at=post.collected_at,
            post_date=post.post_date,
            sentiment_info=sentiment_info,
        ))

    return PostsPageResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )
