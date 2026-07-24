"""
Competitor-tracking router.

Routes (all under /api/games/{parent_id}/competitors):
  GET    /games/{parent_id}/competitors                    — list competitors
  POST   /games/{parent_id}/competitors                    — add a competitor by Steam app id
  DELETE /games/{parent_id}/competitors/{competitor_id}     — remove a competitor (destructive)

A competitor is a fully-fledged Game row — same table, same ingestion
pipeline (Steam reviews, Steam forums, Reddit, Bluesky), same sentiment /
topic / daily-summary / weekly-summary / monthly-summary pipeline as any
Saber title.  The ONLY thing that distinguishes it is a row in the
competitor_games join table linking it to a parent.  Parenthood is a
UI/query concept layered on top of the existing games table — Step 1..9
of the ingestion pipeline (services/ingestor.py) and the period-summary
generators (services/period_summary_service.py) require zero special-
casing because they already loop over every `is_active` Game.
"""
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import CompetitorGame, Game
from schemas import MAX_COMPETITORS_PER_PARENT, CompetitorCreate, CompetitorGameResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/games", tags=["competitors"])


@router.get("/{parent_id}/competitors", response_model=List[CompetitorGameResponse])
def list_competitors(parent_id: int, db: Session = Depends(get_db)):
    """List the competitor titles tracked under a parent Saber game."""
    parent = db.query(Game).filter_by(id=parent_id).first()
    if not parent:
        raise HTTPException(status_code=404, detail=f"Game {parent_id} not found.")

    competitors = (
        db.query(Game)
        .join(CompetitorGame, CompetitorGame.competitor_id == Game.id)
        .filter(CompetitorGame.parent_id == parent_id)
        .order_by(CompetitorGame.id.asc())
        .all()
    )
    return competitors


@router.post("/{parent_id}/competitors", response_model=CompetitorGameResponse, status_code=201)
def add_competitor(parent_id: int, data: CompetitorCreate, db: Session = Depends(get_db)):
    """
    Look up a Steam AppID, create a new Game for it, and link it to the
    parent as a competitor.

    Steam AppID resolution:
      1. Call Steam's public appdetails API (services.steam_service.get_app_details).
      2. If the AppID doesn't resolve -> 404 with a descriptive error.
      3. Create a new Game row: same publisher_id as parent, is_active=True,
         empty subreddits (operator adds these next via the Settings UI).
      4. Insert a CompetitorGame row linking parent -> new game.
      5. Auto-populate distinctive_keywords via services.keyword_generator
         (same generator used for Saber titles on POST /games) so the new
         competitor is never gated OUT of the relevance filter with an
         empty keyword list.
    """
    parent = db.query(Game).filter_by(id=parent_id).first()
    if not parent:
        raise HTTPException(status_code=404, detail=f"Game {parent_id} not found.")

    existing_count = db.query(CompetitorGame).filter_by(parent_id=parent_id).count()
    if existing_count >= MAX_COMPETITORS_PER_PARENT:
        raise HTTPException(
            status_code=409,
            detail=(
                "This game already has the maximum of 4 competitors. "
                "Remove one before adding another."
            ),
        )

    # Reject if the target Steam AppID is already a Saber title (any Game
    # row not itself a competitor) or already a competitor under THIS parent.
    same_appid_game = (
        db.query(Game).filter_by(steam_app_id=data.steam_app_id).first()
    )
    if same_appid_game is not None:
        already_competitor_here = (
            db.query(CompetitorGame)
            .filter_by(parent_id=parent_id, competitor_id=same_appid_game.id)
            .first()
        )
        if already_competitor_here is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{same_appid_game.name!r} (Steam AppID {data.steam_app_id}) "
                    "is already tracked as a competitor for this title."
                ),
            )
        raise HTTPException(
            status_code=409,
            detail=(
                f"Steam AppID {data.steam_app_id} is already tracked in "
                f"SentimentPulse as {same_appid_game.name!r} (game id="
                f"{same_appid_game.id}). It cannot also be added as a "
                "competitor."
            ),
        )

    # Lazy import so test mocking via unittest.mock.patch on the service
    # module works correctly (mirrors the convention in routers/games.py).
    from services.steam_service import get_app_details  # noqa: PLC0415

    details = get_app_details(data.steam_app_id)
    if not details or not details.get("name"):
        raise HTTPException(
            status_code=404,
            detail=f"Steam AppID {data.steam_app_id} not found",
        )

    name = details["name"]
    rd = details.get("release_date") or {}
    release_date = rd.get("date") if isinstance(rd, dict) else None

    # Auto-populate distinctive_keywords (same generator used for Saber
    # titles on POST /games) so the new competitor isn't gated OUT of the
    # relevance filter with an empty keyword list. Best-effort: never let
    # a keyword-generation failure block competitor creation.
    from services.keyword_generator import generate_default_keywords  # noqa: PLC0415
    try:
        keywords = generate_default_keywords(name)
    except Exception as exc:
        logger.warning(
            "Keyword generation failed for competitor %r: %s. Inserting with [].",
            name, exc,
        )
        keywords = []
    if len(keywords) < 3:
        logger.warning(
            "Auto-generated only %d keyword(s) for new competitor %r — below "
            "the 3-keyword floor. Review distinctive_keywords manually via "
            "PATCH /api/games/{id} before this title starts ingesting Reddit.",
            len(keywords), name,
        )

    competitor_game = Game(
        publisher_id=parent.publisher_id,
        steam_app_id=data.steam_app_id,
        name=name,
        release_date=release_date,
        is_active=True,
        subreddits=[],
        distinctive_keywords=keywords,
    )
    db.add(competitor_game)
    try:
        db.flush()  # assign competitor_game.id without committing yet
        db.add(CompetitorGame(parent_id=parent_id, competitor_id=competitor_game.id))
        db.commit()
        db.refresh(competitor_game)
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")

    logger.info(
        "Added competitor game id=%d name=%r steam_app_id=%d under parent_id=%d",
        competitor_game.id, competitor_game.name, competitor_game.steam_app_id, parent_id,
    )
    return competitor_game


@router.delete("/{parent_id}/competitors/{competitor_id}", status_code=204)
def remove_competitor(parent_id: int, competitor_id: int, db: Session = Depends(get_db)):
    """
    Remove a competitor from a parent's tracking list.

    Destructive and intentional: deletes the underlying Game row entirely,
    which cascades (via ORM relationship cascades / FK ON DELETE where
    configured) to its raw_posts, sentiment_records, daily_summaries,
    topic_trends, monthly_summaries, window_summaries, and
    editorial_articles. This mirrors the fact that a competitor with its
    link removed has no other reason to exist in SentimentPulse.
    """
    link = (
        db.query(CompetitorGame)
        .filter_by(parent_id=parent_id, competitor_id=competitor_id)
        .first()
    )
    if not link:
        raise HTTPException(
            status_code=404,
            detail=f"Game {competitor_id} is not a tracked competitor of {parent_id}.",
        )

    competitor_game = db.query(Game).filter_by(id=competitor_id).first()

    try:
        db.delete(link)
        if competitor_game is not None:
            db.delete(competitor_game)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")

    logger.info(
        "Removed competitor game id=%d from parent_id=%d (Game row + all posts deleted)",
        competitor_id, parent_id,
    )
    return None
