"""
SentimentPulse — FastAPI application entry point.

Startup sequence (lifespan):
  1. Ensure all DB tables exist (Alembic handles structured migrations;
     create_all is a safety net for first-run without running alembic upgrade)
  2. Seed publisher from PUBLISHER_NAME env var if not yet configured
  3. Pre-load the NLP sentiment model
  4. Start the APScheduler background scheduler (daily 02:00 ingestion)
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from database import SessionLocal, engine
from models import Base, Publisher
from routers import competitors, dashboard, digest, games, ingest, portfolio_scan, posts, publisher, reddit_upload, sonar_diag, summaries, timeline_events, topics
from scheduler import create_scheduler
from services.bluesky_log_buffer import install_buffer as install_bluesky_log_buffer
from services.keyword_health_check import check_missing_keywords
from services.nlp_service import load_model

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

_API_PREFIX = "/api"


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ───────────────────────────────────────────────────────────────
    logger.info("SentimentPulse starting up…")

    # Safety-net table creation (idempotent; Alembic migrations take precedence)
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables verified.")

    # Seed publisher from env var on first launch
    if settings.publisher_name:
        db = SessionLocal()
        try:
            if not db.query(Publisher).first():
                db.add(Publisher(name=settings.publisher_name))
                db.commit()
                logger.info(
                    "Seeded publisher '%s' from PUBLISHER_NAME env var.",
                    settings.publisher_name,
                )
        except Exception as exc:
            db.rollback()
            logger.error("Failed to seed publisher: %s", exc)
        finally:
            db.close()

    # Mirror bluesky_service log records into an in-memory ring buffer so the
    # diagnostic endpoint can surface them without journalctl access.
    if install_bluesky_log_buffer():
        logger.info("Bluesky log ring buffer installed.")

    # Startup validation (2026-07-24): warn about active games with no
    # distinctive_keywords configured — those games are gated out of
    # sentiment classification entirely by the relevance gate.
    db = SessionLocal()
    try:
        check_missing_keywords(db)
    except Exception as exc:
        logger.error("Startup keyword check failed: %s", exc)
    finally:
        db.close()

    # Pre-load NLP model (synchronous; happens once at startup)
    load_model()

    # v0016.15 (2026-08-14): startup smoke test for the ingest pipeline.
    # Verify that run_ingestion and its per-step helpers can at least be
    # IMPORTED without an UnboundLocalError / ImportError. Doesn't execute
    # them — just proves the module is loadable. Catches the class of bug
    # where an in-function `from X import Y` shadows a module-level import
    # (which triggered the daily-cron wedge on 2026-08-14).
    try:
        from services.ingestor import (
            run_ingestion,
            _step1_discover_games,
            _step4a_reddit_comments,
            _step5_classify_sentiment,
            get_status,
        )
        # dis.get_instructions would be even stronger but this is enough
        # to surface UnboundLocalError-causing shadow imports at compile time.
        import dis as _dis
        for _fn in (run_ingestion, _step1_discover_games, _step4a_reddit_comments,
                    _step5_classify_sentiment, get_status):
            list(_dis.get_instructions(_fn))  # forces bytecode compilation
        logger.info("Ingest pipeline smoke test: all helpers importable + compileable.")
    except Exception as exc:
        logger.error(
            "STARTUP SMOKE TEST FAILED for ingest pipeline: %s. "
            "Daily cron will not work until this is fixed.", exc, exc_info=True,
        )

    # Start background scheduler
    scheduler = create_scheduler()
    scheduler.start()
    logger.info("APScheduler started — daily ingestion at 02:00 local time.")

    # 2026-09-23: Top Topics lives in an in-memory cache, so every deploy or
    # restart blanked the card until the next ingest. Warm today+weekly in
    # the background 90s after boot (after the app is serving) so the card
    # repopulates on its own. Single-flight: an ingest-triggered warmup that
    # is already running makes this a no-op.
    try:
        import threading as _threading
        from routers.dashboard import start_topics_warmup_background

        _t = _threading.Timer(90.0, start_topics_warmup_background)
        _t.daemon = True
        _t.start()
        logger.info("Top Topics startup warmup scheduled in 90s.")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Top Topics startup warmup not scheduled: %s", exc)

    # Recover a missed daily slot, never an arbitrary "20h since start".
    # Both automatic paths share schedule admission, dependency checks and
    # one lock. Manual source-scoped recovery remains operator-controlled.
    from threading import Thread  # noqa: PLC0415
    def _startup_catchup():
        try:
            from scheduler import _ingest_job
            _ingest_job(trigger="startup")
        except Exception as exc:
            logger.exception("Startup catch-up crashed: %s", exc)
    Thread(target=_startup_catchup, daemon=True, name="startup_catchup").start()

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    scheduler.shutdown(wait=False)
    logger.info("SentimentPulse shut down.")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="SentimentPulse API",
    description=(
        "Game publisher sentiment tracking — "
        "Steam reviews, Steam forums, and Reddit community analysis."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


# ── CORS ──────────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],           # Allow all origins (password-gated app)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(publisher.router, prefix=_API_PREFIX)
app.include_router(games.router,     prefix=_API_PREFIX)
app.include_router(competitors.router, prefix=_API_PREFIX)
app.include_router(dashboard.router, prefix=_API_PREFIX)
app.include_router(summaries.router, prefix=_API_PREFIX)
app.include_router(summaries._diag_router, prefix=_API_PREFIX)
app.include_router(sonar_diag.router, prefix=_API_PREFIX)
app.include_router(topics.router,    prefix=_API_PREFIX)
app.include_router(posts.router,     prefix=_API_PREFIX)
app.include_router(ingest.router,    prefix=_API_PREFIX)
app.include_router(reddit_upload.router, prefix=_API_PREFIX)
app.include_router(portfolio_scan.router, prefix=_API_PREFIX)
app.include_router(timeline_events.router, prefix=_API_PREFIX)
app.include_router(digest.router,        prefix=_API_PREFIX)


# ── Utility endpoints ─────────────────────────────────────────────────────────

@app.get("/health", tags=["meta"])
def health_check():
    """Liveness probe — returns 200 while the server is running."""
    return {"status": "ok", "version": "1.0.0"}
