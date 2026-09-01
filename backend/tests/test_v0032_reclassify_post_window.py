"""
v0032 (2026-09-01) — tests for the post-date window mode on the reclassify
endpoint.

Motivation: the legacy `days=N` mode filtered by `SentimentRecord.processed_at`,
which meant running reclass twice re-processed the same rows (the first run
reset processed_at to now, so the second run's window contained them). The
new `post_days_ago_start` + `post_days_ago_end` params filter by RawPost's
`COALESCE(post_date, collected_at)` so ops can backfill a specific
authored-date range without redoing prior work.
"""
import os
import sys
from datetime import date, datetime, timedelta, timezone

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)


def test_endpoint_rejects_partial_window(client):
    """Both post_days_ago_start and post_days_ago_end must be provided
    together. Setting only one is a validation error."""
    r = client.post(
        "/api/ingest/reclassify_sentiments"
        "?post_days_ago_start=8&confirm=YES_RECLASSIFY"
    )
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "refused", body
    assert "must be set together" in body["reason"], body


def test_endpoint_rejects_inverted_window(client):
    """end must be >= start."""
    r = client.post(
        "/api/ingest/reclassify_sentiments"
        "?post_days_ago_start=30&post_days_ago_end=8&confirm=YES_RECLASSIFY"
    )
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "refused", body
    assert "must be >=" in body["reason"], body


def test_endpoint_accepts_valid_window(client):
    """Valid post-window params report the window in the response."""
    r = client.post(
        "/api/ingest/reclassify_sentiments"
        "?post_days_ago_start=8&post_days_ago_end=30&confirm=YES_RECLASSIFY"
    )
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "started", body
    assert body["post_days_ago_start"] == 8
    assert body["post_days_ago_end"] == 30
    # `days` legacy is None in post-window mode
    assert body["days"] is None


def test_run_reclassify_post_window_only_touches_in_window_rows(db, monkeypatch):
    """The worker's query must include ONLY rows whose parent RawPost's
    COALESCE(post_date, collected_at) falls between (today-end) and
    (today-start) inclusive.

    Setup:
      - Row A: post_date = today-2 (INSIDE 8-30 window? No, too recent)
      - Row B: post_date = today-15 (INSIDE 8-30 window)
      - Row C: post_date = today-40 (INSIDE 8-30? No, too old)
      - Row D: post_date=None, collected_at=today-10 (INSIDE via COALESCE)
    Expect only B and D to be re-processed.
    """
    from datetime import date as _date, timedelta as _td, datetime as _dt
    from models import (
        Publisher, Game, RawPost, SentimentRecord, SentimentEnum, SourceEnum,
    )
    from routers.ingest import _run_reclassify, _RECLASSIFY_STATE

    pub = Publisher(name="Test Pub")
    db.add(pub); db.commit()
    game = Game(publisher_id=pub.id, steam_app_id=1, name="TG", is_active=True)
    db.add(game); db.commit()

    today = _date.today()

    def make_row(pd_offset, coll_offset, label="neutral"):
        rp = RawPost(
            game_id=game.id,
            source=SourceEnum.reddit_comment,
            external_id=f"eid-{pd_offset}-{coll_offset}",
            title=None, body="some content",
            post_date=_dt.combine(today - _td(days=pd_offset), _dt.min.time())
                if pd_offset is not None else None,
            collected_at=_dt.combine(today - _td(days=coll_offset), _dt.min.time()),
        )
        db.add(rp); db.commit()
        sr = SentimentRecord(
            raw_post_id=rp.id,
            sentiment=SentimentEnum(label),
            sentiment_score=0.5,
            processed_at=_dt.combine(today - _td(days=coll_offset), _dt.min.time()),
        )
        db.add(sr); db.commit()
        return rp, sr

    # Row A: too recent for 8-30 window
    rp_a, sr_a = make_row(pd_offset=2, coll_offset=2)
    # Row B: inside 8-30 (via post_date=today-15)
    rp_b, sr_b = make_row(pd_offset=15, coll_offset=15)
    # Row C: too old for 8-30 window
    rp_c, sr_c = make_row(pd_offset=40, coll_offset=40)
    # Row D: post_date=None; collected_at=today-10 falls inside via COALESCE
    rp_d, sr_d = make_row(pd_offset=None, coll_offset=10)

    # Patch database.SessionLocal directly — the worker does
    # `from database import SessionLocal` inline, so patching a name on
    # routers.ingest doesn't intercept anything.
    import database
    monkeypatch.setattr(database, "SessionLocal", lambda: db)

    # Patch load_model to no-op (we don't need the RoBERTa model in tests)
    from services import nlp_service as nlp
    monkeypatch.setattr(nlp, "load_model", lambda: None)

    # Track which raw_post_ids are actually sent to the classifier
    seen_post_ids: list[int] = []

    def fake_classify_batch(items):
        # Return a shape mimicking classify_batch_with_gate_v2 output
        return [
            {
                "label": "neutral", "score": 0.5,
                "signal_quality": "high", "language": "en",
                "original_label": None, "original_score": None,
                "sentiment_conflict": False, "applied_rules": [],
            }
            for _ in items
        ]

    # Worker does `from services.nlp_service import classify_batch_with_gate_v2`
    # inline — patch on the source module.
    monkeypatch.setattr(nlp, "classify_batch_with_gate_v2", fake_classify_batch)

    # Reset state before run
    for k in _RECLASSIFY_STATE["label_flips"]:
        _RECLASSIFY_STATE["label_flips"][k] = 0
    _RECLASSIFY_STATE["running"] = False
    _RECLASSIFY_STATE["errors"] = []
    _RECLASSIFY_STATE["processed"] = 0
    _RECLASSIFY_STATE["total_records"] = 0

    # Run the worker with post_days_ago_start=8, post_days_ago_end=30
    _run_reclassify(
        game_id=None, source="reddit_comment", days=30,
        post_days_ago_start=8, post_days_ago_end=30,
    )

    # Expect only rows B and D to have been processed = 2 rows
    assert _RECLASSIFY_STATE["total_records"] == 2, (
        f"expected 2 rows in the 8-30d window, got "
        f"{_RECLASSIFY_STATE['total_records']}"
    )
    assert _RECLASSIFY_STATE["processed"] == 2
    # No errors expected
    assert _RECLASSIFY_STATE["errors"] == [], _RECLASSIFY_STATE["errors"]


def test_run_reclassify_legacy_days_still_works(db, monkeypatch):
    """Legacy days=N mode still filters on processed_at, unchanged behavior."""
    from datetime import date as _date, timedelta as _td, datetime as _dt
    from models import (
        Publisher, Game, RawPost, SentimentRecord, SentimentEnum, SourceEnum,
    )
    from routers.ingest import _run_reclassify, _RECLASSIFY_STATE

    pub = Publisher(name="Test Pub"); db.add(pub); db.commit()
    game = Game(publisher_id=pub.id, steam_app_id=1, name="TG", is_active=True)
    db.add(game); db.commit()

    today = _date.today()

    def make_row(processed_days_ago, ext_id):
        rp = RawPost(
            game_id=game.id, source=SourceEnum.reddit_comment,
            external_id=ext_id, body="content",
            post_date=_dt.combine(today - _td(days=processed_days_ago), _dt.min.time()),
            collected_at=_dt.combine(today - _td(days=processed_days_ago), _dt.min.time()),
        )
        db.add(rp); db.commit()
        sr = SentimentRecord(
            raw_post_id=rp.id,
            sentiment=SentimentEnum.neutral,
            sentiment_score=0.5,
            processed_at=_dt.combine(today - _td(days=processed_days_ago), _dt.min.time()),
        )
        db.add(sr); db.commit()
        return rp, sr

    make_row(3, "recent")
    make_row(20, "old")

    import database
    monkeypatch.setattr(database, "SessionLocal", lambda: db)
    from services import nlp_service as nlp
    monkeypatch.setattr(nlp, "load_model", lambda: None)

    def fake_classify(items):
        return [{
            "label": "neutral", "score": 0.5, "signal_quality": "high",
            "language": "en", "original_label": None, "original_score": None,
            "sentiment_conflict": False, "applied_rules": [],
        } for _ in items]

    monkeypatch.setattr(nlp, "classify_batch_with_gate_v2", fake_classify)

    for k in _RECLASSIFY_STATE["label_flips"]:
        _RECLASSIFY_STATE["label_flips"][k] = 0
    _RECLASSIFY_STATE["running"] = False
    _RECLASSIFY_STATE["errors"] = []
    _RECLASSIFY_STATE["processed"] = 0
    _RECLASSIFY_STATE["total_records"] = 0

    _run_reclassify(game_id=None, source="reddit_comment", days=7)

    # Only the 3-day-old row is inside days=7 window
    assert _RECLASSIFY_STATE["total_records"] == 1
