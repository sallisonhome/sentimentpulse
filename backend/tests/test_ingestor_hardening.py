"""Tests for ingest daily-reliability hardening (2026-07-28).

Covers:
  * _reclaim_stuck_lock_if_needed() clears is_running when the prior run
    is older than _STUCK_RUN_THRESHOLD_S, or when last_run_at is missing
    or unparseable.
  * A healthy in-progress run (fresh last_run_at) is NOT reclaimed.
  * run_ingestion() honors the reclaim path \u2014 a stuck lock does not
    permanently block subsequent daily triggers.

These tests avoid actually running ingestion (which needs DB, NLP model,
network) by unit-testing the reclaim helper directly.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from services import ingestor


def _set_status(**kwargs):
    """Reset the module-level _status dict for isolation between tests."""
    ingestor._status["is_running"] = False
    ingestor._status["last_run_at"] = None
    ingestor._status["last_run_status"] = "never"
    ingestor._status["last_run_errors"] = []
    for k, v in kwargs.items():
        ingestor._status[k] = v


def test_reclaim_noop_when_not_running():
    _set_status(is_running=False, last_run_at="2020-01-01T00:00:00+00:00")
    ingestor._reclaim_stuck_lock_if_needed()
    assert ingestor._status["is_running"] is False


def test_reclaim_noop_when_lock_is_fresh():
    """A run that started 10 minutes ago must NOT be reclaimed \u2014 healthy
    long runs (32 games can take 30-60 minutes) must be allowed to finish."""
    fresh_iso = (
        datetime.now(timezone.utc) - timedelta(minutes=10)
    ).isoformat()
    _set_status(is_running=True, last_run_at=fresh_iso)
    ingestor._reclaim_stuck_lock_if_needed()
    assert ingestor._status["is_running"] is True, (
        "Fresh in-progress run must not be reclaimed"
    )


def test_reclaim_clears_when_lock_is_stale():
    """A run whose last_run_at is older than the stuck threshold must be
    forcibly reclaimed. This is the actual today-morning failure mode."""
    stale_iso = (
        datetime.now(timezone.utc)
        - timedelta(seconds=ingestor._STUCK_RUN_THRESHOLD_S + 60)
    ).isoformat()
    _set_status(is_running=True, last_run_at=stale_iso)
    ingestor._reclaim_stuck_lock_if_needed()
    assert ingestor._status["is_running"] is False
    assert ingestor._status["last_run_status"] == "error"
    # A reclaim reason must be recorded in errors so we can diagnose later.
    errs = ingestor._status["last_run_errors"]
    assert any("stuck" in e.lower() for e in errs), (
        f"Expected a 'stuck' reason in last_run_errors, got: {errs}"
    )


def test_reclaim_clears_when_last_run_at_missing():
    """is_running=True with no last_run_at is broken state; must reclaim."""
    _set_status(is_running=True, last_run_at=None)
    ingestor._reclaim_stuck_lock_if_needed()
    assert ingestor._status["is_running"] is False


def test_reclaim_clears_when_last_run_at_unparseable():
    """Corrupted last_run_at must not permanently block ingestion."""
    _set_status(is_running=True, last_run_at="not-a-timestamp")
    ingestor._reclaim_stuck_lock_if_needed()
    assert ingestor._status["is_running"] is False


def test_run_ingestion_default_skips_nothing():
    """CRITICAL: the daily scheduled cron calls run_ingestion() with no
    args — that path MUST run every source. If anyone ever changes the
    default value of skip_sources from None to something non-empty,
    this test catches it.

    We prove it by inspecting the function signature rather than
    executing (which needs DB / NLP / network).
    """
    import inspect
    sig = inspect.signature(ingestor.run_ingestion)
    param = sig.parameters.get("skip_sources")
    assert param is not None, "skip_sources parameter must exist"
    assert param.default is None, (
        f"run_ingestion(skip_sources=...) default must be None so the daily "
        f"cron runs every source. Current default: {param.default!r}"
    )


def test_scheduler_daily_job_passes_no_args():
    """CRITICAL: verify the APScheduler daily entry point in scheduler.py
    calls run_ingestion() with no arguments. If someone ever adds
    skip_sources=... to that call site by accident, this test flags it.

    We inspect the source of _ingest_job rather than executing it —
    executing needs a full app context. Reading the source is
    sufficient because the call signature IS the contract here.
    """
    import inspect
    import scheduler  # will fail if module can't import
    src = inspect.getsource(scheduler._ingest_job)
    # Must contain a bare 'run_ingestion()' call — no args at all.
    assert "run_ingestion()" in src, (
        "Daily scheduler entry-point must call run_ingestion() with no "
        "arguments so every source runs. Current source:\n" + src
    )


def test_stuck_threshold_is_greater_than_wallclock_budget():
    """Sanity: the stuck-lock threshold must exceed the run's own wallclock
    budget, or a healthy long run could accidentally trip the reclaim
    while it's still doing legitimate work."""
    assert (
        ingestor._STUCK_RUN_THRESHOLD_S >= ingestor._RUN_WALLCLOCK_BUDGET_S
    ), (
        f"stuck threshold ({ingestor._STUCK_RUN_THRESHOLD_S}s) must be >= "
        f"run budget ({ingestor._RUN_WALLCLOCK_BUDGET_S}s) to avoid "
        "reclaiming healthy in-progress runs."
    )


def test_wallclock_budget_scales_with_portfolio_size():
    """Regression guard for 2026-08-19: the 75-min budget was insufficient
    when the portfolio hit 39 active games and skipped the 10 highest-ID
    tail. Budget MUST leave enough headroom for portfolio growth.

    Rule of thumb: at ~2 min/game amortized (fetch + step 2→4b) the
    budget should support >=60 active games. 60 games × 120s = 7200s = 2h.
    Assert budget >= 7200 s.

    Also assert budget < 24h (86400) since the daily cron re-fires every
    24h and a run longer than the cadence would collide with the next one.
    """
    assert ingestor._RUN_WALLCLOCK_BUDGET_S >= 7200, (
        f"Wallclock budget ({ingestor._RUN_WALLCLOCK_BUDGET_S}s) below the "
        f"7200s (2h) floor that supports 60 active games at 2 min/game. "
        "Raise the budget before adding more titles to the active roster."
    )
    assert ingestor._RUN_WALLCLOCK_BUDGET_S < 86400, (
        f"Wallclock budget ({ingestor._RUN_WALLCLOCK_BUDGET_S}s) exceeds "
        "the daily cron cadence (86400s / 24h) — a run at this length would "
        "collide with the next scheduled trigger."
    )
