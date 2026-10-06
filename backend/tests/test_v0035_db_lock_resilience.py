"""2026-10-06 regression tests: "database is locked" aborted the daily ingest.

Production evidence (Oct 6): SQLite in rollback-journal mode with the 5s
pysqlite busy wait; a concurrent portfolio scan and a dashboard topics
synthesis held locks; a per-game error handler formatted `game.name` on an
expired instance, re-queried a locked DB from inside `except`, and the run
died as "Fatal ingestion error". The scheduled retry then cleared the resume
marker and redid every game, while /api/ingest/status showed the previous
attempt's "error" next to is_running=true.

Covers the four fixes:
  1. WAL + busy timeout on file engines (contended writes wait; readers do
     not block the writer), with an explicit rollback switch.
  2. Per-game handlers never query the DB; a lock error in one game cannot
     abort the run; lock-skipped inserts are surfaced as errors and not
     marked known.
  3. A fatal attempt keeps the resume marker so the retry skips finished
     games; a clean run still clears it.
  4. Status during a retry reports attempt N of M and the prior failure,
     and never shows the previous run's status/errors as the current run's.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from models import AppSetting, Base, Game, Publisher, RawPost, SourceEnum


# ── 1. Engine configuration ───────────────────────────────────────────────

def _file_engine(tmp_path, **kw):
    from database import _build_engine
    eng = _build_engine(f"sqlite:///{tmp_path / 'sp.db'}", **kw)
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)"))
    return eng


def _hold_write_lock(path, seconds, started):
    conn = sqlite3.connect(path, timeout=0.1, isolation_level=None)
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("INSERT INTO t (v) VALUES ('holder')")
    started.set()
    time.sleep(seconds)
    conn.execute("COMMIT")
    conn.close()


def test_file_engine_uses_wal_and_busy_timeout(tmp_path):
    eng = _file_engine(tmp_path, journal_mode="wal", busy_timeout_ms=30000)
    with eng.connect() as conn:
        assert conn.execute(text("PRAGMA journal_mode")).scalar().lower() == "wal"
        assert conn.execute(text("PRAGMA busy_timeout")).scalar() == 30000


def test_default_settings_are_wal_30s():
    from config import settings
    assert settings.sqlite_journal_mode == "wal"
    assert settings.sqlite_busy_timeout_ms == 30000


def test_contended_write_waits_for_the_lock_instead_of_failing(tmp_path):
    eng = _file_engine(tmp_path, journal_mode="wal", busy_timeout_ms=5000)
    started = threading.Event()
    holder = threading.Thread(target=_hold_write_lock,
                              args=(str(tmp_path / "sp.db"), 1.0, started))
    holder.start()
    started.wait(5)
    t0 = time.monotonic()
    with eng.begin() as conn:
        conn.execute(text("INSERT INTO t (v) VALUES ('waiter')"))
    waited = time.monotonic() - t0
    holder.join()
    assert waited >= 0.5          # it genuinely waited for the holder
    with eng.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM t")).scalar() == 2


def test_short_timeout_reproduces_the_production_failure(tmp_path):
    """Control: with a short busy wait the same contention raises exactly the
    Oct 6 error, so the test above is meaningful."""
    eng = _file_engine(tmp_path, journal_mode="delete", busy_timeout_ms=100)
    started = threading.Event()
    holder = threading.Thread(target=_hold_write_lock,
                              args=(str(tmp_path / "sp.db"), 1.0, started))
    holder.start()
    started.wait(5)
    with pytest.raises(OperationalError, match="database is locked"):
        with eng.begin() as conn:
            conn.execute(text("INSERT INTO t (v) VALUES ('waiter')"))
    holder.join()


@pytest.mark.parametrize("mode,blocked", [("wal", False), ("delete", True)])
def test_long_reader_blocks_writer_only_in_rollback_mode(tmp_path, mode, blocked):
    eng = _file_engine(tmp_path, journal_mode=mode, busy_timeout_ms=200)
    reader = sqlite3.connect(str(tmp_path / "sp.db"), timeout=0.1, isolation_level=None)
    reader.execute("BEGIN")
    reader.execute("SELECT COUNT(*) FROM t").fetchone()   # hold a read snapshot
    try:
        if blocked:
            with pytest.raises(OperationalError, match="database is locked"):
                with eng.begin() as conn:
                    conn.execute(text("INSERT INTO t (v) VALUES ('w')"))
        else:
            with eng.begin() as conn:
                conn.execute(text("INSERT INTO t (v) VALUES ('w')"))
    finally:
        reader.execute("COMMIT")
        reader.close()


def test_rollback_switch_and_invalid_mode(tmp_path, caplog):
    eng = _file_engine(tmp_path, journal_mode="delete", busy_timeout_ms=1000)
    with eng.connect() as conn:
        assert conn.execute(text("PRAGMA journal_mode")).scalar().lower() == "delete"
    eng2 = _file_engine(tmp_path, journal_mode="bogus; DROP TABLE t", busy_timeout_ms=1000)
    with eng2.connect() as conn:
        assert conn.execute(text("PRAGMA journal_mode")).scalar().lower() == "delete"
        assert conn.execute(text("SELECT COUNT(*) FROM t")).scalar() == 0
    assert any("ignored" in r.message for r in caplog.records)


def test_memory_engine_still_works():
    from database import _build_engine
    eng = _build_engine("sqlite:///:memory:", journal_mode="wal", busy_timeout_ms=1000)
    with eng.connect() as conn:
        assert conn.execute(text("SELECT 1")).scalar() == 1


# ── Shared ingest harness ─────────────────────────────────────────────────

@pytest.fixture
def ingest_db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    pub = Publisher(name="TestPub")
    session.add(pub)
    session.commit()
    for i, name in enumerate(("GameA", "GameB", "GameC"), start=1):
        session.add(Game(publisher_id=pub.id, steam_app_id=i, name=name,
                         is_active=True, subreddits=[f"{name}Sub"]))
    session.commit()
    lock = {"on": False}

    @event.listens_for(engine, "before_cursor_execute")
    def _locked(conn, cursor, statement, params, context, executemany):  # noqa: ANN001
        if lock["on"]:
            raise sqlite3.OperationalError("database is locked")

    yield session, lock
    session.close()


def _run(session, *, step4=None, step9=None, attempt=1, max_attempts=1, step2=None):
    from services import ingestor
    patches = [
        patch("services.ingestor.SessionLocal", return_value=session),
        patch("services.ingestor.load_model", lambda: None),
        patch("services.ingestor.time.sleep", lambda _: None),
        patch("services.ingestor._step1_discover_games",
              side_effect=lambda db, *a: db.query(Game).order_by(Game.id).all()),
        patch("services.ingestor._step2_steam_reviews", side_effect=step2 or (lambda *a: (1, 10))),
        patch("services.ingestor._step3_steam_forums", return_value=(1, 10)),
        patch("services.ingestor._step4_reddit", side_effect=step4 or (lambda *a: (1, 10))),
        patch("services.ingestor._step4a_reddit_comments", return_value=(0, 0)),
        patch("services.ingestor._step4b_bluesky", return_value=(1, 10)),
        patch("services.ingestor._step5_classify_sentiment"),
        patch("services.ingestor._step6_extract_topics"),
        patch("services.ingestor._step7_daily_summary"),
        patch("services.ingestor._step9_monthly_summaries", side_effect=step9),
        patch("services.ingestor._step8_write_log"),
        patch("services.ingestor._run_health_drop_check"),
        patch("services.ingestor.youtube_import_enabled", return_value=False),
        patch("routers.dashboard.warmup_dashboard_cache", lambda **k: None),
        patch("routers.dashboard.start_topics_warmup_background", lambda **k: None),
    ]
    for p in patches:
        p.start()
    try:
        ingestor._status["is_running"] = False
        return ingestor.run_ingestion(attempt=attempt, max_attempts=max_attempts)
    finally:
        for p in patches:
            p.stop()


# ── 2. Per-game containment ───────────────────────────────────────────────

def test_labels_never_query_an_expired_instance(ingest_db):
    from services import ingestor
    session, lock = ingest_db
    game = session.query(Game).filter_by(name="GameA").one()
    gid = game.id
    ingestor._remember_games([game])
    session.expire_all()
    lock["on"] = True
    try:
        assert ingestor._game_label(game) == "GameA"
        assert ingestor._game_id(game) == gid
        ingestor._GAME_LABELS.clear()
        assert ingestor._game_id(game) == gid                     # identity fallback
        assert ingestor._game_label(game) == f"game_id={gid}"
        with pytest.raises(Exception, match="database is locked"):
            _ = game.name                                         # the old handler's path
    finally:
        lock["on"] = False


def test_lock_error_in_one_game_does_not_abort_the_run(ingest_db):
    """Reproduces Oct 6: the step raises a lock error, every instance is
    expired, and the database stays locked while the handler runs. The old
    handler formatted game.name, re-queried, and escaped as a fatal error."""
    from services import ingestor
    session, lock = ingest_db
    seen = []

    def step2(db, game, *a):
        lock["on"] = False        # the lock clears before the next game starts
        return (1, 10)

    def step4(db, game, log_lines, errors):
        name = game.name
        seen.append(name)
        if name == "GameA":
            db.expire_all()
            lock["on"] = True
            raise OperationalError("SELECT games", {}, sqlite3.OperationalError("database is locked"))
        return (1, 10)

    result = _run(session, step4=step4, step2=step2)
    errs = ingestor._status["last_run_errors"]
    assert result["status"] != "error", errs
    assert seen == ["GameA", "GameB", "GameC"]
    assert any("GameA" in e and "database busy" in e for e in errs)
    assert not any(e.startswith("Fatal ingestion error") for e in errs)
    state = session.query(AppSetting).filter_by(key="ingest_run_state").first()
    assert state is None      # clean finish (partial) clears the marker


def test_lock_skipped_insert_is_an_error_and_retryable(ingest_db):
    from services.ingestor import _bulk_save_posts
    session, _ = ingest_db
    gid = session.query(Game).filter_by(name="GameA").one().id
    post = {"external_id": "c1", "author": "a", "title": "", "body": "GameA rocks",
            "url": "https://reddit.com/x", "upvotes": 0,
            "post_date": datetime.now(timezone.utc)}
    real_commit = session.commit
    calls = {"n": 0}

    def flaky_commit():
        calls["n"] += 1
        if calls["n"] == 1:
            raise OperationalError("INSERT", {}, sqlite3.OperationalError("database is locked"))
        return real_commit()

    errors: list = []
    with patch.object(session, "commit", side_effect=flaky_commit):
        assert _bulk_save_posts(session, gid, SourceEnum.reddit_comment, [post], errors) == 0
    assert errors and "not saved because the database was busy" in errors[0]
    # The next attempt saves it: the id was not marked known.
    assert _bulk_save_posts(session, gid, SourceEnum.reddit_comment, [post], []) == 1
    assert session.query(RawPost).filter_by(external_id="c1").count() == 1


def test_non_lock_insert_errors_keep_previous_behaviour(ingest_db):
    from services.ingestor import _bulk_save_posts
    session, _ = ingest_db
    gid = session.query(Game).filter_by(name="GameA").one().id
    post = {"external_id": "c2", "author": "a", "title": "", "body": "x",
            "url": "https://reddit.com/x", "upvotes": 0,
            "post_date": datetime.now(timezone.utc)}
    errors: list = []
    with patch.object(session, "commit", side_effect=ValueError("bad type")):
        assert _bulk_save_posts(session, gid, SourceEnum.reddit_comment, [post], errors) == 0
    assert errors == []


# ── 3. Resume after a fatal attempt ───────────────────────────────────────

def _state(session):
    import json
    row = session.query(AppSetting).filter_by(key="ingest_run_state").first()
    return json.loads(row.value) if row and row.value else None


def test_fatal_attempt_keeps_marker_and_retry_resumes(ingest_db):
    from services import ingestor
    session, _ = ingest_db

    def boom(*a, **k):
        raise RuntimeError("database is locked")

    first = _run(session, step9=boom, attempt=1, max_attempts=4)
    assert first["status"] == "error"
    state = _state(session)
    assert state and len(state["games_completed_ids"]) == 3

    processed = []

    def step2(db, game, *a):
        processed.append(game.name)
        return (1, 10)

    second = _run(session, step2=step2, attempt=2, max_attempts=4)
    assert second["status"] != "error"
    assert processed == []                       # all three resumed, none redone
    assert ingestor._status["resumed"] is True
    assert _state(session) is None               # clean finish clears it


def test_clean_run_clears_marker(ingest_db):
    session, _ = ingest_db
    assert _run(session)["status"] != "error"
    assert _state(session) is None


# ── 4. Status during a retry ──────────────────────────────────────────────

def test_status_reports_attempt_and_prior_failure_during_retry(ingest_db):
    from services import ingestor
    session, _ = ingest_db
    ingestor._status["last_run_status"] = "error"
    ingestor._status["last_run_errors"] = [
        "[Step 4a] 'X' parent=1: upstream incomplete; retry on next run",
        "Fatal ingestion error: (sqlite3.OperationalError) database is locked\n[SQL: SELECT ...]",
    ]
    snap = {}

    def step2(db, game, *a):
        if not snap:
            snap.update(ingestor.get_status())
        return (1, 10)

    _run(session, step2=step2, attempt=2, max_attempts=4)
    assert snap["is_running"] is True
    assert snap["attempt"] == 2 and snap["max_attempts"] == 4
    assert snap["last_run_status"] == "running" and snap["last_run_errors"] == []
    assert snap["prior_attempt_status"] == "error"
    assert snap["prior_attempt_error"] == (
        "Fatal ingestion error: (sqlite3.OperationalError) database is locked")


def test_first_attempt_has_no_prior_failure(ingest_db):
    from services import ingestor
    session, _ = ingest_db
    ingestor._status["prior_attempt_status"] = "error"
    _run(session, attempt=1, max_attempts=4)
    assert ingestor._status["attempt"] == 1
    assert ingestor._status["prior_attempt_status"] is None


def test_status_response_schema_exposes_retry_fields(client):
    from services import ingestor
    ingestor._status.update(is_running=True, attempt=2, max_attempts=4,
                            prior_attempt_status="error",
                            prior_attempt_error="Fatal ingestion error: database is locked")
    try:
        body = client.get("/api/ingest/status").json()
        assert body["attempt"] == 2 and body["max_attempts"] == 4
        assert body["prior_attempt_error"].startswith("Fatal ingestion error")
    finally:
        ingestor._status.update(is_running=False, attempt=1, max_attempts=1,
                                prior_attempt_status=None, prior_attempt_error=None)


def test_scheduler_passes_attempt_numbers():
    import inspect
    import scheduler
    src = inspect.getsource(scheduler._run_guarded_ingest)
    assert "run_ingestion(attempt=attempt, max_attempts=_INGEST_MAX_ATTEMPTS)" in src
    assert scheduler._INGEST_MAX_ATTEMPTS == 4
