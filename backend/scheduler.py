"""
APScheduler integration — registers the daily 02:00 AM ingestion job.

Uses BackgroundScheduler (thread-pool based) so the synchronous ingestion
pipeline never blocks FastAPI's async event loop.

Usage (in main.py lifespan):

    from scheduler import create_scheduler

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        scheduler = create_scheduler()
        scheduler.start()
        yield
        scheduler.shutdown(wait=False)
"""
import logging
from datetime import datetime
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from tzlocal import get_localzone

logger = logging.getLogger(__name__)

_JOB_ID = "daily_ingestion"
_SMOKE_JOB_ID = "weekly_smoke_test"
_WEEKLY_DIGEST_JOB_ID = "weekly_executive_digest"
_MONTHLY_DIGEST_JOB_ID = "monthly_executive_digest"

# Module-level scheduler instance — created once in create_scheduler()
_scheduler: Optional[BackgroundScheduler] = None


def create_scheduler() -> BackgroundScheduler:
    """
    Build and return a BackgroundScheduler with the daily ingestion job.
    Does NOT call .start() — the caller (main.py lifespan) does that.
    """
    global _scheduler

    _scheduler = BackgroundScheduler(
        timezone=get_localzone(),
        job_defaults={
            "coalesce": True,         # If multiple misfires queued, run once
            "misfire_grace_time": 3600,  # Allow up to 1 h late before skipping
            "max_instances": 1,          # Never run two ingestions simultaneously
        },
    )

    from config import settings  # noqa: PLC0415
    ingest_hour = int(getattr(settings, 'ingest_hour', 2))
    ingest_minute = int(getattr(settings, 'ingest_minute', 0))

    _scheduler.add_job(
        _ingest_job,
        trigger=CronTrigger(hour=ingest_hour, minute=ingest_minute),
        id=_JOB_ID,
        name="Daily sentiment ingestion",
        replace_existing=True,
    )

    # Weekly source smoke test — Gap 1 hardening.  Runs Sunday 03:00 local,
    # one hour after the daily ingest, so the smoke test never collides with
    # an ongoing ingestion and we get an early-week health signal.
    _scheduler.add_job(
        _smoke_test_job,
        trigger=CronTrigger(day_of_week="sun", hour=3, minute=0),
        id=_SMOKE_JOB_ID,
        name="Weekly source smoke test",
        replace_existing=True,
    )

    # Executive digest jobs — pinned to America/New_York so DST is handled
    # automatically regardless of droplet timezone.
    #   Weekly:  every Monday 07:00 ET (after Sunday's smoke test + the
    #            daily ingest, so we have fresh data for the 7-day window).
    #   Monthly: 1st of every month, 07:00 ET — summarizes the PRIOR month.
    et_zone = "America/New_York"
    _scheduler.add_job(
        _weekly_digest_job,
        trigger=CronTrigger(day_of_week="mon", hour=7, minute=0, timezone=et_zone),
        id=_WEEKLY_DIGEST_JOB_ID,
        name="Weekly executive digest email",
        replace_existing=True,
    )
    _scheduler.add_job(
        _monthly_digest_job,
        trigger=CronTrigger(day=1, hour=7, minute=0, timezone=et_zone),
        id=_MONTHLY_DIGEST_JOB_ID,
        name="Monthly executive digest email",
        replace_existing=True,
    )

    logger.info(
        f"Scheduler created — daily ingestion at {ingest_hour:02d}:{ingest_minute:02d}, "
        f"weekly smoke test Sun 03:00 local, weekly digest Mon 07:00 ET, "
        f"monthly digest 1st 07:00 ET."
    )
    return _scheduler


def get_next_run_time() -> Optional[str]:
    """
    Return the next scheduled run as an ISO-8601 string.
    Returns None if the scheduler has not been started yet.
    """
    if _scheduler is None:
        return None
    job = _scheduler.get_job(_JOB_ID)
    if job is None or job.next_run_time is None:
        return None
    return job.next_run_time.isoformat()


# ── Internal job ──────────────────────────────────────────────────────────────

def _ingest_job() -> None:
    """
    APScheduler entry-point for the daily run.
    Imports are deferred to avoid circular-import issues at module load time.
    """
    # Deferred import — scheduler.py is imported by main.py before services
    from services.ingestor import run_ingestion, set_next_run  # noqa: PLC0415

    logger.info("Scheduled daily ingestion starting.")
    run_ingestion()

    # Sync the next_run_at field in the ingestor status dict
    next_iso = get_next_run_time()
    if next_iso:
        set_next_run(datetime.fromisoformat(next_iso))

    logger.info("Scheduled daily ingestion complete. Next run: %s", next_iso)


def _smoke_test_job() -> None:
    """APScheduler entry-point for the weekly source smoke test."""
    from services.source_smoke_test import run_smoke_test  # noqa: PLC0415

    logger.info("Scheduled weekly smoke test starting.")
    result = run_smoke_test()
    logger.info(
        "Scheduled weekly smoke test complete. overall_status=%s",
        result.get("overall_status"),
    )


def _weekly_digest_job() -> None:
    """APScheduler entry-point for the Monday 07:00 ET weekly digest."""
    from database import SessionLocal  # noqa: PLC0415
    from services.digest_service import send_weekly_digest  # noqa: PLC0415

    logger.info("Scheduled weekly digest starting.")
    db = SessionLocal()
    try:
        result = send_weekly_digest(db)
        logger.info("Scheduled weekly digest complete: %s", result)
    except Exception as exc:
        # Never let a digest failure crash the scheduler.  The scheduler
        # process is shared with the daily ingestion cron — losing it
        # would be a much bigger problem than a missed digest.
        logger.exception("weekly digest job raised: %s", exc)
    finally:
        db.close()


def _monthly_digest_job() -> None:
    """APScheduler entry-point for the 1st-of-month 07:00 ET monthly digest."""
    from database import SessionLocal  # noqa: PLC0415
    from services.digest_service import send_monthly_digest  # noqa: PLC0415

    logger.info("Scheduled monthly digest starting.")
    db = SessionLocal()
    try:
        result = send_monthly_digest(db)
        logger.info("Scheduled monthly digest complete: %s", result)
    except Exception as exc:
        logger.exception("monthly digest job raised: %s", exc)
    finally:
        db.close()
