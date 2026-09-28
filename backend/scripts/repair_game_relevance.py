"""Explicit game-scoped, audit-backed broad-community cleanup.

Default is read-only. --apply requires the exact reviewed plan hash.
Does not send email or fetch any sources. Raw posts and classifications survive.
"""
import argparse
import gzip
import json
import os
import sys
import subprocess
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import requests
from sqlalchemy import text
from database import SessionLocal
from models import DailySummary, MonthlySummary, WindowSummary, TopicTrend
from services.relevance_repair import plan_repair, apply_plan
from services.topic_snapshots import invalidate_games

CACHE_MODELS = (DailySummary, MonthlySummary, WindowSummary, TopicTrend)


def require_idle(http=requests):
    response = http.get("http://127.0.0.1:8000/api/ingest/status", timeout=20)
    response.raise_for_status()
    if response.json().get("is_running") is not False:
        raise RuntimeError("Ingestion active or unknown; no relevance repair performed")


def audit_payload(db, plan):
    caches = {}
    for model in CACHE_MODELS:
        caches[model.__tablename__] = [
            {column.name:getattr(row,column.name) for column in model.__table__.columns}
            for row in db.query(model).filter(model.game_id==plan["game_id"]).all()
        ]
    return {"schema":1, "recorded_at":datetime.now(timezone.utc).isoformat(),
            "plan":plan, "derived_caches_before":caches}


def save_audit(payload, directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    filename = f"game-{payload['plan']['game_id']}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json.gz"
    path = directory / filename
    # Restrict before writing. Even prior summary text stays server-local.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb") as compressed:
            compressed.write(json.dumps(payload, ensure_ascii=False, default=str).encode())
        raw.flush()
        os.fsync(raw.fileno())
    return path


def run(game_id, *, apply=False, expected_sha256=None, audit_directory=None, http=requests,
        session_factory=SessionLocal, offline_maintenance=False):
    if offline_maintenance:
        state = subprocess.check_output(
            ["systemctl", "show", "sentimentpulse.service", "--property=ActiveState", "--value"],
            text=True, timeout=10).strip()
        if state != "inactive":
            raise RuntimeError("Offline maintenance requires a stopped SentimentPulse service")
    else:
        require_idle(http)
    db = session_factory()
    try:
        if not apply:
            db.execute(text("PRAGMA query_only=ON"))
        else:
            if not expected_sha256:
                raise ValueError("--apply requires --expected-plan-sha256")
            # Hold the SQLite write reservation across validation + audited
            # mutation so another writer cannot silently change the plan.
            db.execute(text("BEGIN IMMEDIATE"))
        plan = plan_repair(db, game_id)
        report = {k:v for k,v in plan.items() if k!="patches"}
        report["derived_caches"] = {m.__tablename__:db.query(m).filter(m.game_id==game_id).count()
                                    for m in CACHE_MODELS}
        if not apply:
            report["applied"] = False
            return report
        if plan["plan_sha256"] != expected_sha256:
            raise ValueError("Plan differs from approved hash; no repair performed")
        audit = save_audit(audit_payload(db, plan),
                           audit_directory or Path("data/relevance-audits"))
        apply_plan(db, plan, expected_sha256=expected_sha256)
        for model in CACHE_MODELS:
            db.query(model).filter(model.game_id==game_id).delete(synchronize_session=False)
        invalidate_games(db, [game_id])
        db.commit()
        report.update(applied=True, audit_file=str(audit))
        return report
    except Exception:
        db.rollback()
        raise
    finally:
        if not apply:
            db.execute(text("PRAGMA query_only=OFF"))
        db.close()


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-id",type=int,required=True)
    parser.add_argument("--apply",action="store_true")
    parser.add_argument("--expected-plan-sha256")
    parser.add_argument("--offline-maintenance",action="store_true",
                        help="Require the service to be stopped, preventing stale synthesis workers")
    args=parser.parse_args()
    print(json.dumps(run(args.game_id,apply=args.apply,expected_sha256=args.expected_plan_sha256,
                         offline_maintenance=args.offline_maintenance)))
