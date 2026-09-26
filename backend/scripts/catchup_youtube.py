"""Operator-scoped YouTube feed catch-up. No Reddit/Steam/Bluesky fetching.

Uses normal cursor/deduplication code and checkpoints each page. Run through
the guarded workflow; arguments explicitly name the active titles to repair.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import requests
from sqlalchemy import func
from database import SessionLocal
from models import Game, RawPost, SentimentRecord, SourceEnum
from services.youtube_service import import_enabled, import_game_comments
from services.ingestor import (
    _step5_classify_sentiment, _step6_extract_topics, _step7_daily_summary,
)


def require_idle(http):
    r = http.get("http://127.0.0.1:8000/api/ingest/status", timeout=20)
    r.raise_for_status()
    if r.json().get("is_running") is not False:
        raise RuntimeError("Daily ingestion active or unknown; no catch-up started")


def run(game_ids, *, max_pages=200, max_seconds=180):
    results = []
    with requests.Session() as http:
        require_idle(http)
        db = SessionLocal()
        try:
            if not import_enabled(db):
                raise RuntimeError("YouTube import is disabled")
            games = db.query(Game).filter(Game.id.in_(game_ids), Game.is_active.is_(True)).all()
            if {g.id for g in games} != set(game_ids):
                raise ValueError("Every requested game must exist and be active")
            for game in games:
                require_idle(http)
                errors, lines = [], []
                imported = import_game_comments(
                    db, game, get=http.get, max_pages=max_pages, max_seconds=max_seconds)
                _step5_classify_sentiment(db, game, lines, errors,
                                         source_filter=SourceEnum.youtube_comment)
                _step6_extract_topics(db, game, lines, errors)
                _step7_daily_summary(db, game, lines, errors)
                db.commit()
                today = datetime.now(timezone.utc).date().isoformat()
                total = db.query(func.count(RawPost.id)).filter(
                    RawPost.game_id == game.id, RawPost.source == SourceEnum.youtube_comment,
                    func.date(RawPost.post_date) == today).scalar()
                classified = db.query(func.count(SentimentRecord.id)).join(
                    RawPost, RawPost.id == SentimentRecord.raw_post_id).filter(
                    RawPost.game_id == game.id, RawPost.source == SourceEnum.youtube_comment,
                    func.date(RawPost.post_date) == today).scalar()
                row = dict(game_id=game.id, title=game.name, imported=imported,
                           today_raw=total, today_classified=classified, errors=errors)
                results.append(row)
                print(json.dumps(row), flush=True)
        finally:
            db.close()
        # Run cache work inside the serving process, not this short-lived CLI.
        r = http.post("http://127.0.0.1:8000/api/dashboard/warmup", timeout=20)
        r.raise_for_status()
        r = http.post("http://127.0.0.1:8000/api/dashboard/topics-warmup",
                      params={"game_ids": ",".join(map(str, game_ids))}, timeout=20)
        r.raise_for_status()
        print("CACHE_REFRESH_QUEUED", r.text, flush=True)
    if any(not r["imported"]["complete"] or r["errors"] for r in results):
        raise RuntimeError("Catch-up is partial; committed checkpoints retained, inspect results")
    print("YOUTUBE_TARGETED_CATCHUP_COMPLETE", flush=True)
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-ids", required=True)
    parser.add_argument("--max-pages", type=int, default=200)
    parser.add_argument("--max-seconds", type=float, default=180)
    args = parser.parse_args()
    ids = sorted({int(v) for v in args.game_ids.split(",")})
    if not ids or any(i <= 0 for i in ids):
        parser.error("game-ids must be positive integers")
    run(ids, max_pages=args.max_pages, max_seconds=args.max_seconds)
