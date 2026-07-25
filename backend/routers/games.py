"""
Games router.

Routes (all under /api/games):
  GET   /games              — list all games
  POST  /games              — manually add a game by Steam app id (used when
                              Steam's publisher facet excludes a title that
                              IS legitimately published by the configured
                              publisher, e.g. Bus Bound on 2026-06-22)
  GET   /games/latest       — most recently added game (default UI selection)
  GET   /games/{game_id}    — game detail + most recent daily summary
  PATCH /games/{game_id}    — update is_active flag or subreddit list

NOTE: /games/latest MUST be declared before /games/{game_id} so FastAPI
matches the literal "latest" before treating it as an integer path param.
"""
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from models import CompetitorGame, DailySummary, Game, Publisher
from schemas import (
    DailySummaryResponse,
    GameCreate,
    GameDetailResponse,
    GameResponse,
    GameSettingsUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/games", tags=["games"])


@router.get("", response_model=List[GameResponse])
def list_games(
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    exclude_competitors: bool = Query(
        False,
        description=(
            "If true, exclude games that are tracked as a competitor under "
            "some parent Saber title (default false for backwards compat)."
        ),
    ),
    db: Session = Depends(get_db),
):
    """List all discovered games, newest first."""
    q = db.query(Game)
    if is_active is not None:
        q = q.filter(Game.is_active == is_active)
    if exclude_competitors:
        competitor_ids = db.query(CompetitorGame.competitor_id)
        q = q.filter(~Game.id.in_(competitor_ids))
    return q.order_by(Game.id.desc()).all()


@router.post("", response_model=GameResponse, status_code=201)
def create_game(data: GameCreate, db: Session = Depends(get_db)):
    """
    Manually add a single game by its Steam app id.

    Required when Steam's publisher search facet excludes a legitimately-
    published title (e.g. Bus Bound app 2095420 published by Saber
    Interactive Inc.).  The standard /api/publisher discovery flow won't
    pick those up because it relies on Steam's facet returning the appid.

    Behavior:
      • 422 if a publisher is not yet configured (set one first).
      • 409 if the steam_app_id already exists.
      • If `name` is omitted, fetched from Steam's appdetails API.
      • If `subreddits` is omitted, auto-discovered via Reddit search.
      • Sentiment ingest will pick this game up on the very next cron run
        because /api/ingest always reads active games from the DB.
    """
    pub = db.query(Publisher).first()
    if pub is None:
        raise HTTPException(
            status_code=422,
            detail="No publisher configured.  POST /api/publisher first.",
        )

    existing = db.query(Game).filter_by(steam_app_id=data.steam_app_id).first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"steam_app_id={data.steam_app_id} already exists "
                f"(game id={existing.id}, name={existing.name!r}).  Use "
                f"PATCH /api/games/{existing.id} to modify it."
            ),
        )

    # Resolve name + release date.
    # Imported lazily so test patches at services.steam_service.get_app_details
    # work without the import being captured at module load time.
    name = (data.name or "").strip()
    release_date: Optional[str] = None
    if not name:
        from services.steam_service import get_app_details  # noqa: PLC0415
        details = get_app_details(data.steam_app_id)
        if not details or not details.get("name"):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Could not resolve name for steam_app_id={data.steam_app_id} "
                    "via Steam appdetails.  Pass `name` explicitly."
                ),
            )
        name = details["name"]
        rd = details.get("release_date") or {}
        release_date = rd.get("date") if isinstance(rd, dict) else None

    # Resolve subreddits.  Auto-discovery is best-effort: even if it returns
    # [] we still create the game (operator can PATCH later).  Bluesky and
    # Steam sources don't need subreddits.
    subreddits = data.subreddits
    if subreddits is None:
        try:
            from services.reddit_service import discover_subreddits  # noqa: PLC0415
            subreddits = discover_subreddits(name) or []
        except Exception as exc:
            logger.warning(
                "Subreddit auto-discovery failed for %r: %s. Inserting with [].",
                name, exc,
            )
            subreddits = []

    # Resolve distinctive_keywords. Auto-generate a heuristic default list
    # when omitted so the game is never created with an empty keyword list
    # (2026-07-24 relevance gate: games without keywords are gated OUT of
    # sentiment classification entirely — see services/post_relevance.py).
    keywords = data.distinctive_keywords
    if keywords is None:
        from services.keyword_generator import generate_default_keywords  # noqa: PLC0415
        try:
            keywords = generate_default_keywords(name)
        except Exception as exc:
            logger.warning(
                "Keyword generation failed for %r: %s. Inserting with [].",
                name, exc,
            )
            keywords = []
        if len(keywords) < 3:
            logger.warning(
                "Auto-generated only %d keyword(s) for new game %r — below "
                "the 3-keyword floor. Review distinctive_keywords manually "
                "via PATCH /api/games/{id} before this game starts ingesting Reddit.",
                len(keywords), name,
            )

    game = Game(
        publisher_id=pub.id,
        steam_app_id=data.steam_app_id,
        name=name,
        release_date=release_date,
        is_active=data.is_active,
        subreddits=subreddits,
        distinctive_keywords=keywords,
    )
    db.add(game)
    try:
        db.commit()
        db.refresh(game)
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")

    logger.info(
        "Manually added game id=%d name=%r steam_app_id=%d subreddits=%s",
        game.id, game.name, game.steam_app_id, game.subreddits,
    )

    # 2026-07-25 rule: every newly-added game triggers a 90-day Steam
    # Forum backfill in the background so the dashboard starts populated
    # instead of waiting for the daily cron. Same treatment competitor
    # titles get in routers/competitors.py. Fire-and-forget.
    try:
        from services.new_game_onboarding import schedule_onboarding_backfill  # noqa: PLC0415
        schedule_onboarding_backfill(game.id)
    except Exception as exc:
        logger.warning(
            "Failed to schedule onboarding backfill for new game id=%d: %s",
            game.id, exc,
        )

    return game


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
    - commercial_context: per-title positioning brief (CLAUDE.md §21)
    """
    game = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found.")

    if data.is_active is not None:
        game.is_active = data.is_active
    if data.subreddits is not None:
        game.subreddits = data.subreddits
    if data.commercial_context is not None:
        # Empty string → NULL so prompts fall back to heuristic default.
        game.commercial_context = data.commercial_context.strip() or None
    if data.demographic_context is not None:
        # §24: empty string → NULL so bold-ideas prompt skips the
        # demographic clause.
        game.demographic_context = data.demographic_context.strip() or None

    try:
        db.commit()
        db.refresh(game)
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")

    return game


@router.post("/seed-commercial-context")
def seed_commercial_context_endpoint(
    overwrite: bool = False,
    db: Session = Depends(get_db),
):
    """Apply CLAUDE.md §21 default per-title commercial-strategic context
    briefs to any of the 8 priority titles missing one.  Idempotent: by
    default skips titles that already have a brief (pass overwrite=true
    to force replacement).
    """
    # Lazy import so the seed file's heredoc doesn't slow boot when unused.
    from seed_commercial_context import seed_default_commercial_context
    result = seed_default_commercial_context(db, overwrite=overwrite)
    return {"result": result, "overwrite": overwrite}


@router.post("/seed-demographic-context")
def seed_demographic_context_endpoint(
    overwrite: bool = False,
    db: Session = Depends(get_db),
):
    """§24: Apply default per-title demographic + IP-awareness briefs to
    any of the 8 priority titles missing one.  Idempotent: by default
    skips titles that already have a brief (pass overwrite=true to
    force replacement).
    """
    from seed_demographic_context import seed_default_demographic_context
    result = seed_default_demographic_context(db, overwrite=overwrite)
    return {"result": result, "overwrite": overwrite}
