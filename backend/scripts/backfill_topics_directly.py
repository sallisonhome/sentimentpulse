"""2026-08-05 direct topic backfill — runs against the droplet's local DB
using a FRESH Python import (no stale uvicorn worker cache).

Why this exists: the deployed FastAPI process has a stale import of
`_step6_extract_topics` that predates the `target_day` kwarg, so calling
the /api/ingest/backfill/topics endpoint throws TypeError on every call.
Rather than diagnose the running-process import issue tonight, run the
work inline via `python /opt/sentimentpulse/backend/scripts/backfill_topics_directly.py`
which does a clean import.

Acceptance:
  - After running with DAYS=30, `SELECT COUNT(*) FROM sentiment_records
    WHERE topics != '[]'` in the same window returns > 0.
  - Dashboard's top_topics_summary returns non-empty positive/negative
    lists for real games (SM2, Hellraiser).

Idempotent: Step 6 upserts sr.topics + DailySummary.top_*_topics in place.
Re-running is safe.
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta

sys.path.insert(0, "/opt/sentimentpulse/backend")

# Force a fresh module load so any stale bytecode cache doesn't win.
import importlib
import services.ingestor as _ingestor_mod
importlib.reload(_ingestor_mod)
from services.ingestor import _step6_extract_topics  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import Game            # noqa: E402


def main() -> int:
    # Verify the fresh signature actually has target_day.
    import inspect
    sig = inspect.signature(_step6_extract_topics)
    print(f"live _step6 signature: {sig}", flush=True)
    if "target_day" not in sig.parameters:
        print("FATAL: target_day param not present — abort", flush=True)
        return 2

    days = int(os.environ.get("DAYS", "30"))
    end_day = date.today()
    start_day = end_day - timedelta(days=days - 1)
    print(f"window: {start_day} -> {end_day} (last {days} days)", flush=True)

    db = SessionLocal()
    try:
        games = (
            db.query(Game)
            .filter(Game.is_active.is_(True))
            .order_by(Game.id)
            .all()
        )
        print(f"games: {len(games)}", flush=True)

        totals = {
            "games": 0,
            "days_processed": 0,
            "days_with_topics": 0,
            "errors": 0,
        }
        err_samples: list[str] = []

        for g in games:
            cursor = start_day
            per_game_days = 0
            per_game_with = 0
            while cursor <= end_day:
                log_lines: list = []
                errors: list = []
                try:
                    _step6_extract_topics(
                        db, g, log_lines, errors, target_day=cursor,
                    )
                    totals["days_processed"] += 1
                    per_game_days += 1
                    passed = True
                    for ln in log_lines:
                        if "no clusters passed" in ln or "no posts" in ln:
                            passed = False
                            break
                    if passed and not errors:
                        totals["days_with_topics"] += 1
                        per_game_with += 1
                    db.commit()
                except Exception as exc:
                    db.rollback()
                    totals["errors"] += 1
                    if len(err_samples) < 3:
                        err_samples.append(
                            f"gid={g.id} day={cursor}: {type(exc).__name__}: {exc}"
                        )
                cursor += timedelta(days=1)
            totals["games"] += 1
            print(
                f"  gid={g.id:3d} {g.name[:45]:45s} "
                f"days={per_game_days:3d} with_topics={per_game_with:3d}",
                flush=True,
            )

        print("", flush=True)
        print("=== TOTALS ===", flush=True)
        print(f"games processed:        {totals['games']}", flush=True)
        print(f"days_processed total:   {totals['days_processed']}", flush=True)
        print(f"days_with_topics total: {totals['days_with_topics']}", flush=True)
        print(f"errors:                 {totals['errors']}", flush=True)
        for e in err_samples:
            print(f"  err sample: {e}", flush=True)

        return 0 if totals["errors"] == 0 else 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
