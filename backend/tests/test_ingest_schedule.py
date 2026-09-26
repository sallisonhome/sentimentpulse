from datetime import datetime, timezone
from unittest.mock import Mock

import pytest

from services.ingest_schedule import admission_reason


def admit(now, **status):
    return admission_reason(status, hour=5, minute=45,
                            now=datetime.fromisoformat(now), startup=True)


def test_exact_observed_early_start_is_refused():
    assert admit("2026-09-26T06:48:35+00:00",
                 last_run_at="2026-09-25T10:45:00+00:00",
                 last_run_status="success") == "before_daily_slot"


@pytest.mark.parametrize("date,utc_hour", [("2026-09-26", "09"), ("2026-12-26", "10")])
def test_startup_missed_slot_dst(date, utc_hour):
    assert admit(f"{date}T{utc_hour}:45:00+00:00",
                 last_run_at="2026-09-25T10:45:00+00:00",
                 last_run_status="success") is None


@pytest.mark.parametrize("status", ["success", "partial", "partial_failure"])
def test_restart_does_not_repeat_finished_run(status):
    assert admit("2026-09-26T16:00:00+00:00",
                 last_run_at="2026-09-26T09:45:00+00:00",
                 last_run_finished_at="2026-09-26T11:00:00+00:00",
                 last_run_status=status) == "daily_slot_already_completed"


def test_legacy_early_run_that_spanned_slot_is_not_duplicated():
    assert admit("2026-09-26T16:00:00+00:00",
                 last_run_at="2026-09-26T06:48:35+00:00",
                 last_run_finished_at="2026-09-26T10:12:59+00:00",
                 last_run_status="partial") == "daily_slot_already_completed"


def test_failed_or_interrupted_run_can_resume_after_slot():
    assert admit("2026-09-26T16:00:00+00:00",
                 last_run_at="2026-09-26T09:45:00+00:00",
                 last_run_status="error") is None
    assert admit("2026-09-26T16:00:00+00:00", is_running=True) == "already_running"
    assert admit("2026-09-26T16:00:00+00:00") == "no_prior_history"


@pytest.fixture
def automatic(monkeypatch, db):
    import scheduler
    from services import ingestor, cron_alerts, ingest_schedule, ingest_dependencies
    import database
    monkeypatch.setattr(database, "SessionLocal", lambda: db)
    monkeypatch.setattr(ingest_schedule, "admission_reason", lambda *a, **kw: None)
    monkeypatch.setattr(ingestor, "get_status", lambda: {"is_running": False})
    ingest = Mock(return_value={"status": "success"})
    guard = Mock()
    alert = Mock()
    monkeypatch.setattr(ingestor, "run_ingestion", ingest)
    monkeypatch.setattr(ingest_dependencies, "wait_for_dependencies", guard)
    monkeypatch.setattr(cron_alerts, "send_failure_alert", alert)
    monkeypatch.setattr(cron_alerts, "run_with_retry", lambda *, job, **kw: job(1))
    return scheduler, ingest, guard, alert


@pytest.mark.parametrize("trigger", ["scheduled", "startup"])
def test_actual_entrypoint_imports_enabled_check_and_guards_every_source(automatic, trigger):
    scheduler, ingest, guard, alert = automatic
    scheduler._ingest_job(trigger)
    guard.assert_called_once_with(check_youtube=False)
    ingest.assert_called_once_with()
    alert.assert_not_called()


def test_dependency_failure_never_starts_ingestion(automatic):
    scheduler, ingest, guard, alert = automatic
    guard.side_effect = RuntimeError("storefront busy")
    scheduler._ingest_job()
    ingest.assert_not_called()
    alert.assert_called_once()


def test_enabled_youtube_is_actually_dependency_gated(automatic, db):
    from models import AppSetting
    db.add(AppSetting(key="youtube_import_enabled", value="true"))
    db.commit()
    scheduler, ingest, guard, alert = automatic
    scheduler._ingest_job("startup")
    guard.assert_called_once_with(check_youtube=True)
    ingest.assert_called_once_with()


def test_concurrent_automatic_entry_is_not_queued(automatic):
    scheduler, ingest, guard, alert = automatic
    with scheduler._automatic_ingest_lock:
        scheduler._ingest_job()
    ingest.assert_not_called()
    guard.assert_not_called()


def test_live_state_rechecked_after_dependency_wait(automatic, monkeypatch):
    from services import ingest_schedule
    scheduler, ingest, guard, alert = automatic
    monkeypatch.setattr(ingest_schedule, "admission_reason",
                        Mock(side_effect=[None, "already_running"]))
    scheduler._ingest_job()
    guard.assert_called_once()
    ingest.assert_not_called()
