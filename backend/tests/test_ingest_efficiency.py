from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

import pytest

from services import reddit_transport as rt
from services import ingest_dependencies as guard


@pytest.fixture
def transport(monkeypatch):
    rt.end_run()
    rt._next_request.clear()
    monkeypatch.setattr(rt.time, "sleep", lambda _: None)
    client = Mock()
    monkeypatch.setattr(rt.requests, "Session", lambda: client)
    rt.begin_run()
    yield client
    rt.end_run()
    rt._next_request.clear()


def response(status=200, data=None, headers=None):
    return SimpleNamespace(status_code=status, headers=headers or {},
                           json=lambda: {"data": data if data is not None else []})


def fetch(params=None):
    return rt.fetch_json("https://example.test/api", params or {"x": 1},
                         headers={}, timeout=5, provider="test", interval=1.8)


def test_success_empty_is_cached_and_connection_reused(transport):
    transport.get.return_value = response()
    assert fetch() == {"data": []}
    assert fetch() == {"data": []}
    assert transport.get.call_count == 1


def test_cached_payload_cannot_leak_per_game_relevance(transport):
    transport.get.return_value = response(data=[{"id": "a"}])
    first = fetch()
    first["data"][0]["override_tier"] = "noise"
    assert fetch() == {"data": [{"id": "a"}]}


def test_cache_key_includes_full_query(transport):
    transport.get.return_value = response()
    fetch({"after": 1})
    fetch({"after": 2})
    assert transport.get.call_count == 2


def test_failure_not_cached_and_retry_bounded(transport):
    transport.get.return_value = response(429)
    with pytest.raises(rt.UpstreamFailure):
        fetch()
    assert transport.get.call_count == 2
    assert not rt._local.cache
    transport.get.return_value = response()
    fetch()
    assert transport.get.call_count == 3


def test_cache_is_bounded(transport):
    transport.get.return_value = response(data=[{"text": "x" * 20000}])
    for i in range(300):
        # Test memory bound without accumulating mocked clock reservations.
        rt._next_request.clear()
        fetch({"x": i})
    assert len(rt._local.cache) <= 256
    assert rt._local.cache_bytes <= 8 * 1024 * 1024


def test_retry_after_long_cooldown_fails_visibly(transport):
    transport.get.return_value = response(429, headers={"Retry-After": "1800"})
    with pytest.raises(rt.UpstreamFailure):
        fetch()
    with pytest.raises(rt.UpstreamFailure, match="cooldown"):
        fetch({"x": 2})
    assert transport.get.call_count == 1


def test_successful_empty_does_not_trigger_fallback():
    from services.reddit_service import fetch_subreddit_posts
    with patch("services.arctic_shift_service.fetch_arctic_shift_subreddit_posts",
               return_value=rt.FetchRows()), \
         patch("services.reddit_service._load_gist_data") as gist, \
         patch("services.reddit_service._fetch_pullpush") as fallback:
        rows = fetch_subreddit_posts("gaming", game_name="Test Game")
    assert rows == [] and rows.complete
    gist.assert_not_called()
    fallback.assert_not_called()


def test_partial_primary_keeps_both_available_sets():
    from services.reddit_service import fetch_subreddit_posts
    with patch("services.arctic_shift_service.fetch_arctic_shift_subreddit_posts",
               return_value=rt.FetchRows([{"external_id": "a"}], complete=False)), \
         patch("services.reddit_service._load_gist_data", return_value={}), \
         patch("services.reddit_service._fetch_pullpush",
               return_value=[{"external_id": "b"}]):
        rows = fetch_subreddit_posts("gaming", game_name="Test Game")
    assert {r["external_id"] for r in rows} == {"a", "b"}
    assert not rows.complete


def test_no_db_or_unknown_service_blocks(monkeypatch):
    monkeypatch.setattr(guard, "_systemctl", lambda *a: "")
    assert guard.dependency_blockers(check_youtube=False)
    monkeypatch.setattr(guard, "_systemctl", Mock(side_effect=OSError("not found")))
    assert guard.dependency_blockers(check_youtube=False)


@pytest.mark.parametrize("state,blocked", [
    ("active", True), ("activating", True), ("deactivating", True),
    ("inactive", False), ("failed", False),
])
def test_storefront_state(monkeypatch, state, blocked):
    monkeypatch.setattr(guard, "_systemctl", lambda *a: state)
    assert bool(guard.dependency_blockers(check_youtube=False)) == blocked


def test_youtube_readonly_guard(tmp_path, monkeypatch):
    import sqlite3
    db = sqlite3.connect(tmp_path / "youtube.db")
    db.execute("CREATE TABLE yt_ingest_runs (id INTEGER, trigger TEXT, started_at TEXT, status TEXT)")
    db.execute("INSERT INTO yt_ingest_runs VALUES (1,'scheduled','2026-09-25T08:30:00Z','running')")
    db.commit()
    monkeypatch.setattr(guard, "_systemctl",
                        lambda *a: str(tmp_path) if "signalpulse.service" in a else "inactive")
    now = datetime(2026, 9, 25, 9, 45, tzinfo=timezone.utc)
    assert guard.dependency_blockers(now=now)
    db.execute("UPDATE yt_ingest_runs SET status='partial'")
    db.commit()
    assert guard.dependency_blockers(now=now) == []
    assert guard.dependency_blockers(now=now.replace(day=26))
    db.close()


def test_guard_timeout_never_starts_ingestion(monkeypatch):
    monkeypatch.setattr(guard, "dependency_blockers", lambda **kw: ["busy"])
    with pytest.raises(RuntimeError, match="deadline"):
        guard.wait_for_dependencies(timeout=0)


@pytest.mark.parametrize("month,utc_hour", [(9, 9), (12, 10)])
def test_545_schedule_is_dst_safe(month, utc_hour):
    from scheduler import create_scheduler
    from config import settings
    settings.ingest_hour_et = 5
    settings.ingest_minute_et = 45
    scheduler = create_scheduler()
    trigger = scheduler.get_job("daily_ingestion").trigger
    now = datetime(2026, month, 2, tzinfo=timezone.utc)
    fire = trigger.get_next_fire_time(None, now)
    assert (fire.hour, fire.minute) == (5, 45)
    assert fire.astimezone(timezone.utc).hour == utc_hour
    assert str(trigger.timezone) == "America/New_York"
