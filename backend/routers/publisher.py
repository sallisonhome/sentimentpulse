"""
Publisher router — GET /api/publisher  and  POST /api/publisher.

POST triggers background game discovery so the HTTP response returns
immediately rather than waiting up to 30+ seconds for Steam to respond.
"""
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Game, Publisher
from schemas import PublisherCreate, PublisherResponse
from config import settings
from services.reddit_service import discover_subreddits
from services.steam_service import get_games_by_developer, get_games_by_publisher

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/publisher", tags=["publisher"])


@router.get("", response_model=PublisherResponse)
def get_publisher(db: Session = Depends(get_db)):
    """Return the currently configured publisher, or 404 if none is set."""
    pub = db.query(Publisher).first()
    if not pub:
        raise HTTPException(
            status_code=404,
            detail="No publisher configured. POST /api/publisher to set one.",
        )
    return pub


@router.post("", response_model=PublisherResponse, status_code=201)
def set_publisher(
    data: PublisherCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Create or replace the publisher name.
    Immediately triggers a background game-discovery job against Steam.
    """
    name = data.name.strip()

    pub = db.query(Publisher).first()
    if pub:
        pub.name = name
    else:
        pub = Publisher(name=name)
        db.add(pub)

    try:
        db.commit()
        db.refresh(pub)
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")

    background_tasks.add_task(_discover_games_bg, pub.id, name)
    logger.info("Publisher set to '%s'. Game discovery queued.", name)
    return pub


# ── Background task ───────────────────────────────────────────────────────────

def _discover_games_bg(publisher_id: int, publisher_name: str) -> None:
    """
    Discover Steam games for the publisher and upsert them into the DB.
    Runs in a background thread (FastAPI BackgroundTasks).
    """
    from database import SessionLocal  # deferred to avoid circular import

    db = SessionLocal()
    try:
        # Search by publisher
        steam_games_pub = get_games_by_publisher(publisher_name)
        # Also search by developer if configured
        steam_games_dev: list[dict] = []
        if settings.developer_name:
            steam_games_dev = get_games_by_developer(settings.developer_name)
        # Merge, deduplicating by steam_app_id
        seen: dict[int, dict] = {g["steam_app_id"]: g for g in steam_games_pub}
        for g in steam_games_dev:
            seen.setdefault(g["steam_app_id"], g)
        steam_games = list(seen.values())
        new_count = 0
        for gd in steam_games:
            if db.query(Game).filter_by(steam_app_id=gd["steam_app_id"]).first():
                continue
            subreddits = discover_subreddits(gd["name"])
            db.add(Game(
                publisher_id=publisher_id,
                steam_app_id=gd["steam_app_id"],
                name=gd["name"],
                release_date=gd.get("release_date"),
                is_active=True,
                subreddits=subreddits,
            ))
            new_count += 1

        if new_count:
            db.commit()
            logger.info(
                "Background discovery: %d new game(s) added for publisher_id=%d.",
                new_count, publisher_id,
            )
        else:
            logger.info(
                "Background discovery: no new games found for publisher_id=%d.",
                publisher_id,
            )
    except Exception as exc:
        db.rollback()
        logger.error("Background game discovery failed: %s", exc)
    finally:
        db.close()
