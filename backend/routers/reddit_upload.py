"""
Reddit upload router.

  POST /api/reddit/upload — Accept Reddit data directly from the PC fetcher script.
                            Saves posts to the database and triggers sentiment analysis.

This eliminates the GitHub Gist middleman. The PowerShell script on the user's
PC POSTs data directly to this endpoint.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from sqlalchemy.orm import Session

from database import get_db
from models import Game, RawPost, SourceEnum

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/reddit", tags=["reddit"])


@router.post("/upload")
async def upload_reddit_data(request: Request, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Accept Reddit data POSTed directly from the home PC fetcher script.
    Saves new posts to the database, then triggers a full ingestion in the background.

    Expected JSON format:
    {
      "game_id": { "game_name": "...", "posts": [...], "fetched_at": "..." },
      ...
    }
    """
    try:
        data = await request.json()
    except Exception as exc:
        logger.error("Failed to parse Reddit upload JSON: %s", exc)
        return {"status": "error", "message": f"Invalid JSON: {exc}"}

    total_saved = 0
    total_skipped = 0

    for game_id_str, game_data in data.items():
        game_name = game_data.get("game_name", "")
        posts = game_data.get("posts", [])
        if not posts:
            continue

        # Find the game by name (more reliable than ID since IDs may differ)
        game = db.query(Game).filter(Game.name == game_name).first()
        if not game:
            logger.warning("Reddit upload: game '%s' not found in DB, skipping", game_name)
            continue

        # Get existing external_ids for this game + reddit source
        external_ids = [p.get("external_id", "") for p in posts if p.get("external_id")]
        known = set()
        if external_ids:
            known = {
                row[0] for row in
                db.query(RawPost.external_id).filter(
                    RawPost.external_id.in_(external_ids),
                    RawPost.source == SourceEnum.reddit,
                ).all()
            }

        for p in posts:
            eid = p.get("external_id", "")
            if not eid or eid in known:
                total_skipped += 1
                continue

            post_date = None
            pd_str = p.get("post_date")
            if pd_str:
                try:
                    post_date = datetime.fromisoformat(pd_str)
                except Exception:
                    pass

            row = RawPost(
                game_id=game.id,
                source=SourceEnum.reddit,
                external_id=eid,
                author=p.get("author"),
                title=p.get("title"),
                body=(p.get("body") or "")[:2000],
                url=p.get("url"),
                upvotes=p.get("upvotes", 0),
                post_date=post_date,
            )
            db.add(row)
            try:
                db.commit()
                known.add(eid)
                total_saved += 1
            except Exception:
                db.rollback()
                known.add(eid)
                total_skipped += 1

    logger.info("Reddit upload: saved %d new, skipped %d duplicates", total_saved, total_skipped)

    # Trigger full ingestion in background to process sentiment + summaries
    if total_saved > 0:
        from services.ingestor import run_ingestion, get_status
        status = get_status()
        if not status["is_running"]:
            background_tasks.add_task(run_ingestion)
            logger.info("Reddit upload triggered background ingestion")

    return {
        "status": "ok",
        "new_posts": total_saved,
        "skipped": total_skipped,
        "message": f"Saved {total_saved} new Reddit posts. {'Ingestion triggered.' if total_saved > 0 else 'No new posts to process.'}",
    }
