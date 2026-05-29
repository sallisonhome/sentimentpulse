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
from routers import dashboard, games, ingest, posts, publisher, reddit_upload, summaries, topics
from scheduler import create_scheduler
from services.bluesky_log_buffer import install_buffer as install_bluesky_log_buffer
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

    # Pre-load NLP model (synchronous; happens once at startup)
    load_model()

    # Start background scheduler
    scheduler = create_scheduler()
    scheduler.start()
    logger.info("APScheduler started — daily ingestion at 02:00 local time.")

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
app.include_router(dashboard.router, prefix=_API_PREFIX)
app.include_router(summaries.router, prefix=_API_PREFIX)
app.include_router(topics.router,    prefix=_API_PREFIX)
app.include_router(posts.router,     prefix=_API_PREFIX)
app.include_router(ingest.router,    prefix=_API_PREFIX)
app.include_router(reddit_upload.router, prefix=_API_PREFIX)


# ── Utility endpoints ─────────────────────────────────────────────────────────

@app.get("/health", tags=["meta"])
def health_check():
    """Liveness probe — returns 200 while the server is running."""
    return {"status": "ok", "version": "1.0.0"}
