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

    _scheduler.add_job(
        _ingest_job,
        trigger=CronTrigger(hour=2, minute=0),
        id=_JOB_ID,
        name="Daily sentiment ingestion",
        replace_existing=True,
    )

    logger.info(
        "Scheduler created — daily ingestion job registered at 02:00 local time."
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
