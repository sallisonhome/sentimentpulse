#!/usr/bin/env python3
"""Hard-delete decks that have been in trash > 30 days.

Run nightly via cron at 03:00 UTC.
"""

from __future__ import annotations

import datetime as dt
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import get_conn, init_db  # noqa: E402


def main():
    init_db()
    storage_root = Path(os.getenv("GTM_STORAGE_ROOT", "/var/lib/gtm"))
    cutoff = (dt.datetime.utcnow() - dt.timedelta(days=30)).isoformat()

    purged = 0
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id FROM gtm_decks WHERE deleted_at IS NOT NULL AND deleted_at < ?",
            [cutoff],
        ).fetchall()
        for row in rows:
            deck_id = row["id"]
            # Remove trash dir if present
            trash_dir = storage_root / "trash" / deck_id
            if trash_dir.exists():
                shutil.rmtree(trash_dir, ignore_errors=True)
            # Remove library dir if somehow still present
            lib_dir = storage_root / "library" / deck_id
            if lib_dir.exists():
                shutil.rmtree(lib_dir, ignore_errors=True)
            conn.execute("DELETE FROM gtm_decks WHERE id = ?", [deck_id])
            purged += 1

    print(f"[purge-trash] {purged} deck(s) purged (older than 30 days)")


if __name__ == "__main__":
    main()
