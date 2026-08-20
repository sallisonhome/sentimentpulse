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
            # v0023 (2026-08-20): bumped from 3600 (1h) to 43200 (12h).
            # The 1h grace kept dropping fires whenever a deploy window
            # spanned the 10:45 UTC ingest time.  On 2026-08-19 we shipped
            # four separate deploys in the afternoon and the next-day
            # 10:45 UTC fire was silently skipped, leaving 39 games
            # un-ingested until manual trigger.  12h is generous but
            # bounded: if the process is down that long we still want a
            # catch-up run; if longer, the operator can hit
            # /api/ingest/run manually.  See lessons.md v0023 entry.
            "misfire_grace_time": 43200,
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
    # Monthly digest fires at 12:00 ET on the 1st of each month.
    #
    # Why 12:00 and not 07:00: the daily ingestion cron runs at 10:45 local
    # time (America/New_York), and its Step 9 generates monthly summaries
    # for the just-ended month.  If the digest fires before Step 9 completes,
    # the MonthlySummary rows don't exist yet and the digest renders "No
    # qualifying monthly summaries."  This is exactly the failure mode that
    # bit the June 2026 monthly digest send on 2026-07-01 at 07:00 ET.
    #
    # 12:00 ET gives Step 9 a comfortable window to finish (ingestion of a
    # full day of posts across 8 titles + monthly summary generation runs
    # in ~30-60 minutes on a normal day).  If ingestion ever runs longer
    # than ~1h 15m, this window will need to grow.
    _scheduler.add_job(
        _monthly_digest_job,
        trigger=CronTrigger(day=1, hour=12, minute=0, timezone=et_zone),
        id=_MONTHLY_DIGEST_JOB_ID,
        name="Monthly executive digest email",
        replace_existing=True,
    )

    logger.info(
        f"Scheduler created — daily ingestion at {ingest_hour:02d}:{ingest_minute:02d}, "
        f"weekly smoke test Sun 03:00 local, weekly digest Mon 07:00 ET, "
        f"monthly digest 1st 12:00 ET (after Step 9 monthly-summary generation)."
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


# One-time skip mechanism for the weekly/monthly digest jobs (2026-07-26).
# Set AppSetting rows with these keys and an ISO-8601 UTC "skip until"
# timestamp; the digest job will no-op (with an info log) as long as
# now < that timestamp. Cleaner than manually pausing the APScheduler job
# because it survives redeploys and requires zero SSH access.
_WEEKLY_DIGEST_SKIP_KEY = "weekly_digest_skip_until"
_MONTHLY_DIGEST_SKIP_KEY = "monthly_digest_skip_until"


def _is_skipped(db, key: str) -> bool:
    """Return True iff AppSetting[key] holds a future UTC ISO timestamp."""
    from models import AppSetting  # noqa: PLC0415
    from datetime import datetime, timezone  # noqa: PLC0415
    row = db.query(AppSetting).filter_by(key=key).first()
    if not row or not row.value:
        return False
    try:
        # Accept both '2026-07-27T00:00:00' and full ISO with tz.
        raw = row.value.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        skip_until = datetime.fromisoformat(raw)
        if skip_until.tzinfo is None:
            skip_until = skip_until.replace(tzinfo=timezone.utc)
    except Exception:
        logger.warning(
            "AppSetting %r has unparseable value %r; ignoring skip.",
            key, row.value,
        )
        return False
    now = datetime.now(tz=timezone.utc)
    return now < skip_until


def _weekly_digest_job() -> None:
    """APScheduler entry-point for the Monday 07:00 ET weekly digest.

    Honors AppSetting[weekly_digest_skip_until] so operators can defer a
    single run without touching APScheduler internals.
    """
    from database import SessionLocal  # noqa: PLC0415
    from services.digest_service import send_weekly_digest  # noqa: PLC0415

    db = SessionLocal()
    try:
        if _is_skipped(db, _WEEKLY_DIGEST_SKIP_KEY):
            logger.info(
                "Weekly digest skipped by AppSetting %r.",
                _WEEKLY_DIGEST_SKIP_KEY,
            )
            return
        logger.info("Scheduled weekly digest starting.")
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
    """APScheduler entry-point for the 1st-of-month 12:00 ET monthly digest.
    Runs after the 10:45 local ingestion cron completes so Step 9 has already
    generated the current MonthlySummary rows.  See scheduler comment above.

    Honors AppSetting[monthly_digest_skip_until] the same way the weekly
    job honors its skip key."""
    from database import SessionLocal  # noqa: PLC0415
    from services.digest_service import send_monthly_digest  # noqa: PLC0415

    db = SessionLocal()
    try:
        if _is_skipped(db, _MONTHLY_DIGEST_SKIP_KEY):
            logger.info(
                "Monthly digest skipped by AppSetting %r.",
                _MONTHLY_DIGEST_SKIP_KEY,
            )
            return
        logger.info("Scheduled monthly digest starting.")
        result = send_monthly_digest(db)
        logger.info("Scheduled monthly digest complete: %s", result)
    except Exception as exc:
        logger.exception("monthly digest job raised: %s", exc)
    finally:
        db.close()
