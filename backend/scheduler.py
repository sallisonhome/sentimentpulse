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
import threading
from datetime import datetime
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from tzlocal import get_localzone

logger = logging.getLogger(__name__)

_JOB_ID = "daily_ingestion"
_SMOKE_JOB_ID = "weekly_smoke_test"
_WEEKLY_DIGEST_JOB_ID = "weekly_executive_digest"
_WEEKLY_PREWARM_JOB_ID = "weekly_windowsummary_prewarm"
_MONTHLY_DIGEST_JOB_ID = "monthly_executive_digest"

# Module-level scheduler instance — created once in create_scheduler()
_scheduler: Optional[BackgroundScheduler] = None
_automatic_ingest_lock = threading.Lock()


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
    ingest_hour = settings.ingest_hour_et
    ingest_minute = settings.ingest_minute_et

    _scheduler.add_job(
        _ingest_job,
        trigger=CronTrigger(hour=ingest_hour, minute=ingest_minute,
                            timezone="America/New_York"),
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

    # v0032 (2026-09-21) — Weekly WindowSummary prewarm.
    #
    # WHY THIS EXISTS.
    # The weekly digest build (`build_weekly_digest` → `build_weekly_block`
    # per priority title) calls `generate_window_summary(end_date=Sunday)`
    # for each of the ~9 priority titles. On a cold cache each call fires
    # LLM synthesis for topic clusters and takes several seconds; nine of
    # them serially takes 3–5 minutes. That is fine inside APScheduler
    # (in-process, no HTTP timeout) but any HTTP call to /preview/weekly
    # or /send/weekly on a cold cache 504s through nginx's 120s
    # proxy_read_timeout.
    #
    # This prewarm cron generates and caches the WindowSummary rows for
    # the anchor Sunday BEFORE the Monday 07:00 ET digest fires, so both
    # the scheduled digest AND any operator /preview or /send during
    # Monday morning read from cache and return in <10s total.
    #
    # WHEN IT RUNS.
    # Monday 00:30 ET — 6.5h before the digest fire. Sunday is fully closed
    # by then (calendar-day boundary in ET has passed at midnight, and all
    # Sunday-timestamped posts already landed via the previous 10:45 ingest).
    # Anchor date = today.weekday() == 0 (Monday) → window_end = today - 1 day
    # = Sunday, matching digest_service._weekly_window_end().
    #
    # SEE ALSO.
    # - lessons.md 2026-07-01 (monthly digest cron ordering).
    # - services/digest_service._weekly_window_end (the shared anchor helper).
    # - PR #97 (the Mon–Sun window fix that made this prewarm valuable).
    _scheduler.add_job(
        _weekly_prewarm_job,
        trigger=CronTrigger(day_of_week="mon", hour=0, minute=30, timezone=et_zone),
        id=_WEEKLY_PREWARM_JOB_ID,
        name="Weekly WindowSummary prewarm (populates digest cache)",
        replace_existing=True,
    )

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
        f"Scheduler created — daily ingestion at {ingest_hour:02d}:{ingest_minute:02d} America/New_York, "
        f"weekly smoke test Sun 03:00 local, weekly prewarm Mon 00:30 ET, "
        f"weekly digest Mon 07:00 ET, monthly digest 1st 12:00 ET (after "
        f"Step 9 monthly-summary generation)."
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
    if job is None or getattr(job, "next_run_time", None) is None:
        return None
    return job.next_run_time.isoformat()


# ── Internal job ──────────────────────────────────────────────────────────────

def _ingest_job(trigger="scheduled") -> None:
    """Serialize automatic entry points, including their dependency wait."""
    if not _automatic_ingest_lock.acquire(blocking=False):
        logger.info("Automatic ingestion skipped: another automatic entry owns admission.")
        return
    try:
        _run_guarded_ingest(trigger)
    finally:
        _automatic_ingest_lock.release()


def _run_guarded_ingest(trigger) -> None:
    """
    APScheduler entry-point for the daily run.
    Imports are deferred to avoid circular-import issues at module load time.

    2026-09-13 cron hardening: wraps run_ingestion() in
    services.cron_alerts.run_with_retry. A transient failure (e.g. a
    Reddit rate-limit spike or a Bluesky auth blip in the middle of the
    run) triggers up to 3 retries at 5-, 15-, and 60-minute backoff
    (4 attempts total). On final failure the module emits a Resend
    alert to CRON_ALERT_TO. The APScheduler misfire_grace_time is 12h,
    so the up-to-80-minute retry envelope stays well inside the grace
    window.
    """
    # Deferred import — scheduler.py is imported by main.py before services
    from services.ingestor import run_ingestion, set_next_run, get_status  # noqa: PLC0415
    from services.cron_alerts import run_with_retry  # noqa: PLC0415
    from services.ingest_schedule import admission_reason
    from config import settings

    def reason():
        return admission_reason(get_status(), hour=settings.ingest_hour_et,
                                minute=settings.ingest_minute_et,
                                startup=trigger == "startup")

    blocked = reason()
    if blocked:
        logger.info("Automatic ingestion trigger=%s skipped: %s", trigger, blocked)
        return

    logger.info("Automatic daily ingestion admitted trigger=%s.", trigger)

    # Earlier start must not race the 04:30 ET YouTube producer or an
    # over-running 09:15 UTC storefront refresh. A failure is an explicit
    # alert, never an unsafe restart or silently successful skipped run.
    from services.ingest_dependencies import wait_for_dependencies
    from services.youtube_service import import_enabled
    from database import SessionLocal
    from services.cron_alerts import send_failure_alert
    db = SessionLocal()
    try:
        check_youtube = import_enabled(db)
    finally:
        db.close()
    try:
        wait_for_dependencies(check_youtube=check_youtube)
    except Exception as exc:
        logger.exception("Scheduled ingestion dependency deadline exceeded")
        send_failure_alert("daily_ingestion_dependencies", attempts=1,
                           last_error=str(exc))
        return

    def _do(attempt: int) -> None:
        blocked = reason()
        if blocked:
            logger.info("Automatic ingestion recheck skipped: %s", blocked)
            return
        logger.info("daily_ingestion attempt %d", attempt)
        result = run_ingestion()
        if result.get("status") == "error":
            raise RuntimeError("Ingestion returned error; inspect last_run_errors")
        logger.info("Automatic ingestion returned status=%s", result.get("status"))

    try:
        run_with_retry(job_name="daily_ingestion", job=_do, max_attempts=4)
    except Exception:
        # run_with_retry has already logged the exception and sent the
        # alert email. Swallow here so APScheduler's own error path
        # does NOT ALSO log/notify (we already told the operator).
        logger.error("daily_ingestion final failure after retries", exc_info=True)

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
_WEEKLY_PREWARM_SKIP_KEY = "weekly_prewarm_skip_until"
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


def _weekly_prewarm_job() -> None:
    """APScheduler entry-point for the Monday 00:30 ET WindowSummary prewarm.

    Populates the WindowSummary cache for every priority title at the
    anchor Sunday (yesterday when this fires) so the Monday 07:00 ET
    digest — and any operator /preview or /send during Monday morning —
    reads from cache instead of doing 3–5 minutes of on-demand LLM work.

    Honors AppSetting[weekly_prewarm_skip_until] the same way
    _weekly_digest_job honors its skip key.

    Per-title errors are logged and swallowed; a failure on one title
    must not skip prewarm for the rest. The digest itself will still fall
    back to on-demand generation for any title whose prewarm failed
    (correctness preserved, just slower on that title).
    """
    from database import SessionLocal  # noqa: PLC0415
    from services import period_summary_service as _pss  # noqa: PLC0415
    from services.digest_service import (  # noqa: PLC0415
        PRIORITY_TITLES,
        _weekly_window_end,
    )
    from datetime import date as _date, timedelta as _td  # noqa: PLC0415
    import time as _time  # noqa: PLC0415

    db = SessionLocal()
    try:
        if _is_skipped(db, _WEEKLY_PREWARM_SKIP_KEY):
            logger.info(
                "Weekly prewarm skipped by AppSetting %r.",
                _WEEKLY_PREWARM_SKIP_KEY,
            )
            return

        # Compute the anchor Sunday exactly the way build_weekly_block
        # will compute it 6.5h from now, so the cache key matches.
        today = _date.today()
        window_end = _weekly_window_end(today)
        logger.info(
            "Weekly prewarm starting for anchor Sunday %s (%d priority titles).",
            window_end.isoformat(),
            len(PRIORITY_TITLES),
        )

        succeeded = 0
        failed: list[tuple[int, str, str]] = []
        started_at = _time.monotonic()
        for game_id, name in PRIORITY_TITLES:
            title_started_at = _time.monotonic()
            try:
                _pss.generate_window_summary(
                    db, game_id=game_id, days=7, end_date=window_end,
                )
                dt = _time.monotonic() - title_started_at
                logger.info(
                    "Weekly prewarm ok: game_id=%d %r in %.1fs",
                    game_id, name, dt,
                )
                succeeded += 1
            except Exception as exc:  # noqa: BLE001
                # Log full trace but keep going. The digest can still
                # generate this title on-demand at 07:00 ET.
                logger.exception(
                    "Weekly prewarm FAILED for game_id=%d %r: %s",
                    game_id, name, exc,
                )
                failed.append((game_id, name, str(exc)))

        total = _time.monotonic() - started_at
        logger.info(
            "Weekly prewarm complete for anchor %s: %d/%d titles cached in %.1fs. "
            "Failed: %s",
            window_end.isoformat(),
            succeeded,
            len(PRIORITY_TITLES),
            total,
            failed or "none",
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("weekly prewarm job raised: %s", exc)
    finally:
        db.close()


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
