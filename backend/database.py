from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session, DeclarativeBase

from config import settings


def _build_engine():
    connect_args = {}
    if settings.database_url.startswith("sqlite"):
        # SQLite requires check_same_thread=False when used with FastAPI
        connect_args = {"check_same_thread": False}
    return create_engine(
        settings.database_url,
        connect_args=connect_args,
        # Pool settings suitable for both SQLite and PostgreSQL
        pool_pre_ping=True,
    )


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
