"""Non-writing scheduler checks and paced Reddit transport equivalence probe.

Run from backend on the deployment host. Never calls run_ingestion or writes
application data. Reads twelve recent parent IDs and checks both pacing settings
against identical provider requests. No comment contents are printed.
"""
import json
import sqlite3
import time
from datetime import datetime, timezone

from config import settings
from scheduler import create_scheduler
from services.ingest_dependencies import dependency_blockers
from services.ingest_schedule import admission_reason
from services import reddit_transport as rt
from services.arctic_shift_service import ARCTIC_SHIFT_COMMENTS_BASE, _HEADERS


def main():
    from services.ingestor import get_status
    status = get_status()
    print("ADMISSION", admission_reason(
        status, hour=settings.ingest_hour_et, minute=settings.ingest_minute_et,
        startup=True))
    scheduler = create_scheduler()
    fire = scheduler.get_job("daily_ingestion").trigger.get_next_fire_time(
        None, datetime.now(timezone.utc))
    print("NEXT_FIRE", fire.isoformat())
    print("DEPENDENCY_BLOCKERS", json.dumps(dependency_blockers()))
    with sqlite3.connect("file:sentimentpulse.db?mode=ro", uri=True) as db:
        parents = [row[0] for row in db.execute("""
            SELECT external_id FROM raw_posts WHERE source='reddit'
              AND relevance_tier IN ('signal','dedicated_sub')
              AND post_date >= datetime('now','-7 days')
            ORDER BY post_date DESC LIMIT 12
        """)]
    results = {}
    for interval in (1.8, 1.0):
        rt.begin_run()
        start = time.monotonic()
        ids = {}
        try:
            for parent in parents:
                data = rt.fetch_json(
                    ARCTIC_SHIFT_COMMENTS_BASE,
                    {"link_id": f"t3_{parent}", "limit": 100, "sort": "desc"},
                    headers=_HEADERS, timeout=15, provider="arctic_shift",
                    interval=interval)
                ids[parent] = sorted(p["id"] for p in data["data"])
            metrics = dict(rt._local.metrics)
            results[interval] = ids
            print("READ_PROBE", json.dumps({
                "interval": interval, "parents": len(ids),
                "comments": sum(len(v) for v in ids.values()),
                "elapsed_s": round(time.monotonic()-start, 3),
                "metrics": metrics,
            }))
        finally:
            rt.end_run()
    print("SAME_PARENT_COMMENT_IDS", results[1.8] == results[1.0])
    if results[1.8] != results[1.0]:
        # Live threads may legitimately gain comments between reads.
        for parent in parents:
            print("ID_DELTA", parent,
                  len(set(results[1.8][parent])-set(results[1.0][parent])),
                  len(set(results[1.0][parent])-set(results[1.8][parent])))


if __name__ == "__main__":
    main()
