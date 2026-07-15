"""SQLite database for GTM Slide Pack Studio."""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

def _db_path() -> Path:
    """Resolve DB path from env at call time (allows tests to override)."""
    return Path(os.getenv("GTM_DB_PATH", "/var/lib/gtm/db.sqlite"))


# Module-level for legacy callers that reference db.DB_PATH directly.
DB_PATH = _db_path()

# NOTE on `language` / `translated_from_deck_id` (Phase 4 -- Russian
# localization, see gtm_revisions_summary.md "Phase 4" section):
# These two columns + the UNIQUE index below are declared here so that a
# brand-new DB (fresh `init_db()` call, e.g. in tests) gets them for free.
# Any EXISTING on-disk DB predating this change needs
# scripts/migrate_add_language_columns.py run once against it, since
# `CREATE TABLE IF NOT EXISTS` does not retroactively add columns to an
# already-existing table. The migration script is idempotent and safe to
# run against a DB that already has these columns (e.g. one created fresh
# via this SCHEMA after this change shipped).
SCHEMA = """
CREATE TABLE IF NOT EXISTS gtm_decks (
    id                      TEXT PRIMARY KEY,
    title                   TEXT NOT NULL,
    genre                   TEXT NOT NULL,
    theme                   TEXT NOT NULL CHECK (theme IN ('dark','light')),
    release_date            TEXT NOT NULL,
    inputs_json             TEXT NOT NULL,
    is_private              INTEGER NOT NULL DEFAULT 0,
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    pptx_path               TEXT NOT NULL,
    pdf_path                TEXT,
    pptx_size_bytes         INTEGER,
    status                  TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('rendering','ready','failed')),
    deleted_at              TIMESTAMP,
    language                TEXT NOT NULL DEFAULT 'en',
    translated_from_deck_id TEXT REFERENCES gtm_decks(id)
);
CREATE INDEX IF NOT EXISTS idx_decks_active ON gtm_decks(deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decks_title  ON gtm_decks(title);
CREATE INDEX IF NOT EXISTS idx_decks_theme  ON gtm_decks(theme);
CREATE INDEX IF NOT EXISTS idx_decks_language ON gtm_decks(language);
-- One translation per (source deck, target language). SQLite treats NULL
-- as distinct from any other NULL for UNIQUE-index purposes, so this does
-- NOT collapse all untranslated (translated_from_deck_id IS NULL) rows
-- into a single slot -- it only enforces uniqueness among actual
-- translation rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_translation_unique
    ON gtm_decks(translated_from_deck_id, language);

CREATE TABLE IF NOT EXISTS gtm_admin_actions (
    id              TEXT PRIMARY KEY,
    action          TEXT NOT NULL,
    target_deck_id  TEXT,
    ip_address      TEXT,
    timestamp       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON gtm_admin_actions(timestamp DESC);
"""


def init_db():
    """Create the DB file and apply schema."""
    p = _db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(p) as conn:
        conn.executescript(SCHEMA)
        conn.commit()


@contextmanager
def get_conn():
    """Yield a connection with row_factory=dict-like and foreign keys on."""
    conn = sqlite3.connect(_db_path(), detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def dict_from_row(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row else None
