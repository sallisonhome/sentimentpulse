"""Durable per-sentiment results for supported dashboard periods.

Uses the existing AppSetting table. Empty successful results are data; model
failures are errors with a retry deadline, never permanent empty successes.
"""
import json
import time
import uuid
from datetime import datetime, timezone

from models import AppSetting

PERIODS = ("today", "weekly", "monthly")
SENTIMENTS = ("positive", "negative", "neutral")
UNSUPPORTED_MESSAGE = "Top Topics are only available for Today, 7 Day and 30 Day time periods."
GEN_KEY = "dashboard_topics_generation_v1"


def generation(db):
    row = db.get(AppSetting, GEN_KEY, populate_existing=True)
    return row.value if row else "initial"


def invalidate(db):
    value = uuid.uuid4().hex
    row = db.get(AppSetting, GEN_KEY)
    if row is None:
        db.add(AppSetting(key=GEN_KEY, value=value))
    else:
        row.value = value
    db.commit()
    return value


def key(game_id, period, sentiment):
    return f"dashboard_topic_v1:{game_id}:{period}:{sentiment}"


def read(db, game_id, period, sentiment, period_start):
    row = db.get(AppSetting, key(game_id, period, sentiment), populate_existing=True)
    if not row:
        return None
    try:
        data = json.loads(row.value)
        # Never display yesterday's Today or another rolling window as current.
        if data.get("period_start") != str(period_start):
            return None
        if data.get("payload") is not None and not isinstance(data["payload"], list):
            return None
        return data
    except (ValueError, TypeError):
        return None


def fresh(data, gen):
    return data is not None and data.get("generation") == gen and not data.get("error") \
        and data.get("payload") is not None


def retry_due(data, gen):
    if fresh(data, gen):
        return False
    if data and data.get("attempt_generation") == gen:
        return data.get("retry_after", 0) <= time.time()
    return True


def write(db, game_id, period, sentiment, period_start, gen, payload, error=None):
    # A worker from an older ingest must not overwrite a newer generation.
    if generation(db) != gen:
        return
    old = read(db, game_id, period, sentiment, period_start)
    data = {
        "period_start": str(period_start),
        "generation": gen if not error else (old or {}).get("generation"),
        "attempt_generation": gen,
        "payload": payload if not error else (old or {}).get("payload"),
        "updated_at": datetime.now(timezone.utc).isoformat() if not error
                      else (old or {}).get("updated_at"),
        "error": error,
        "retry_after": time.time() + 300 if error else 0,
    }
    row_key = key(game_id, period, sentiment)
    row = db.get(AppSetting, row_key)
    if row is None:
        db.add(AppSetting(key=row_key, value=json.dumps(data)))
    else:
        row.value = json.dumps(data)
    db.commit()
