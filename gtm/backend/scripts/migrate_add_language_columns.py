#!/usr/bin/env python3
"""Idempotent migration: add `language` / `translated_from_deck_id` columns
to gtm_decks, backfill existing rows, and create the translation-uniqueness
index.

Part of Phase 4 (Russian localization) — see gtm_revisions_summary.md.

Safe to run multiple times and safe to run against a DB that was created
fresh from the current db.py SCHEMA (which already declares these columns)
— the column-existence and index-existence checks make every step a no-op
in that case.

Usage:
    python3 scripts/migrate_add_language_columns.py [--db-path PATH]

If --db-path is omitted, uses the GTM_DB_PATH env var (same resolution
logic as db.py), falling back to /var/lib/gtm/db.sqlite.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path


def _existing_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {r[1] for r in rows}  # r[1] = column name


def _existing_indexes(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA index_list({table})").fetchall()
    return {r[1] for r in rows}  # r[1] = index name


def migrate(db_path: Path) -> None:
    if not db_path.exists():
        print(f"[migrate] DB file does not exist yet at {db_path} — nothing to migrate "
              f"(init_db() will create it with the columns already present).")
        return

    conn = sqlite3.connect(db_path)
    try:
        # Does gtm_decks even exist yet? (fresh/empty DB file case)
        table_exists = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='gtm_decks'"
        ).fetchone()
        if not table_exists:
            print("[migrate] gtm_decks table does not exist yet — nothing to migrate.")
            return

        cols = _existing_columns(conn, "gtm_decks")

        if "language" not in cols:
            print("[migrate] Adding column: language TEXT NOT NULL DEFAULT 'en'")
            # SQLite requires a constant default for ALTER TABLE ADD COLUMN
            # with NOT NULL; 'en' satisfies that.
            conn.execute(
                "ALTER TABLE gtm_decks ADD COLUMN language TEXT NOT NULL DEFAULT 'en'"
            )
        else:
            print("[migrate] Column 'language' already exists — skipping.")

        cols = _existing_columns(conn, "gtm_decks")  # re-read after possible ALTER
        if "translated_from_deck_id" not in cols:
            print("[migrate] Adding column: translated_from_deck_id TEXT")
            conn.execute(
                "ALTER TABLE gtm_decks ADD COLUMN translated_from_deck_id TEXT"
            )
        else:
            print("[migrate] Column 'translated_from_deck_id' already exists — skipping.")

        # Backfill: any row where language is NULL/empty (shouldn't happen given
        # the NOT NULL DEFAULT above, but be defensive for rows that existed
        # before the ALTER ran in some edge case) gets 'en'. Rows without a
        # translated_from_deck_id already default to NULL via ALTER TABLE.
        updated = conn.execute(
            "UPDATE gtm_decks SET language = 'en' WHERE language IS NULL OR language = ''"
        ).rowcount
        if updated:
            print(f"[migrate] Backfilled language='en' on {updated} row(s).")
        else:
            print("[migrate] No rows needed language backfill.")

        indexes = _existing_indexes(conn, "gtm_decks")
        if "idx_decks_language" not in indexes:
            print("[migrate] Creating index: idx_decks_language")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_decks_language ON gtm_decks(language)")
        else:
            print("[migrate] Index 'idx_decks_language' already exists — skipping.")

        if "idx_decks_translation_unique" not in indexes:
            print("[migrate] Creating UNIQUE index: idx_decks_translation_unique "
                  "on (translated_from_deck_id, language)")
            try:
                conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_translation_unique "
                    "ON gtm_decks(translated_from_deck_id, language)"
                )
            except sqlite3.IntegrityError as e:
                print(
                    "[migrate] ERROR: could not create UNIQUE index — existing data "
                    f"violates uniqueness (duplicate translations already present): {e}",
                    file=sys.stderr,
                )
                raise
        else:
            print("[migrate] Index 'idx_decks_translation_unique' already exists — skipping.")

        conn.commit()
        print("[migrate] Done.")
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db-path",
        default=os.getenv("GTM_DB_PATH", "/var/lib/gtm/db.sqlite"),
        help="Path to the SQLite DB file (default: $GTM_DB_PATH or /var/lib/gtm/db.sqlite)",
    )
    args = parser.parse_args()
    migrate(Path(args.db_path))


if __name__ == "__main__":
    main()
