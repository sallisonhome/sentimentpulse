import logging
from typing import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, Session, DeclarativeBase

from config import settings

logger = logging.getLogger(__name__)

_ALLOWED_JOURNAL_MODES = {"wal", "delete", "truncate", "persist"}


def _configure_sqlite_connection(dbapi_conn, journal_mode: str, busy_timeout_ms: int) -> None:
    """Per-connection SQLite settings (2026-10-06).

    busy_timeout: a writer blocked by another connection waits up to this
    long instead of raising "database is locked" after pysqlite's 5s default.
    journal_mode: WAL is persistent in the database file; setting it on every
    connect is a cheap no-op once applied. A failure to switch (e.g. another
    process holds the file) is logged and never prevents the connection.
    """
    cur = dbapi_conn.cursor()
    try:
        cur.execute(f"PRAGMA busy_timeout = {int(busy_timeout_ms)}")
        mode = (journal_mode or "").strip().lower()
        if mode in _ALLOWED_JOURNAL_MODES:
            try:
                cur.execute(f"PRAGMA journal_mode = {mode}")
                row = cur.fetchone()
                actual = (row[0] if row else "").lower()
                if actual not in (mode, "memory"):
                    logger.warning("sqlite journal_mode requested=%s actual=%s", mode, actual)
            except Exception as exc:  # noqa: BLE001
                logger.warning("sqlite journal_mode=%s not applied: %s", mode, exc)
        elif mode:
            logger.warning("sqlite journal_mode=%r ignored (allowed: %s)",
                           journal_mode, sorted(_ALLOWED_JOURNAL_MODES))
    finally:
        cur.close()


def _build_engine(url: str = None, journal_mode: str = None, busy_timeout_ms: int = None):
    url = url or settings.database_url
    connect_args = {}
    is_sqlite = url.startswith("sqlite")
    if is_sqlite:
        # SQLite requires check_same_thread=False when used with FastAPI.
        # timeout (seconds) is pysqlite's own busy wait; keep it aligned.
        timeout_ms = settings.sqlite_busy_timeout_ms if busy_timeout_ms is None else busy_timeout_ms
        connect_args = {"check_same_thread": False, "timeout": timeout_ms / 1000}
    eng = create_engine(
        url,
        connect_args=connect_args,
        # Pool settings suitable for both SQLite and PostgreSQL
        pool_pre_ping=True,
    )
    if is_sqlite:
        mode = settings.sqlite_journal_mode if journal_mode is None else journal_mode
        timeout_ms = settings.sqlite_busy_timeout_ms if busy_timeout_ms is None else busy_timeout_ms

        @event.listens_for(eng, "connect")
        def _on_connect(dbapi_conn, _record):  # noqa: ANN001
            _configure_sqlite_connection(dbapi_conn, mode, timeout_ms)
    return eng


engine = _build_engine()

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency — yields a DB session and ensures it is closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
