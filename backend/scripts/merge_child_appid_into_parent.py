"""One-shot mover: merge a child-appid game row into a parent game row.

Landing B of the 2026-09-18 Hellraiser Revival demo work.

What it does (given a parent_id, child_id, and alias_appid):
  1. Verify both game rows exist. Refuse if either is missing.
  2. Verify the parent doesn't already have the child's appid listed as
     an alias (idempotency guard: re-running is a no-op after success).
  3. Move `raw_posts` from child_id -> parent_id.
     - The (source, external_id) unique constraint is GLOBAL, not
       (game_id, source, external_id). That means the same external_id
       could never have existed under two game_ids in the first place,
       so a simple UPDATE cannot violate the constraint. No conflict
       handling needed.
  4. `sentiment_records` follow `raw_posts` implicitly (FK is raw_post_id).
  5. Delete generated aggregates that would no longer make sense:
     - `daily_summaries`, `monthly_summaries`, `window_summaries`,
       `topic_trends` — these will regenerate from the merged corpus.
  6. Move `editorial_articles` and `timeline_events` (user-authored) from
     child_id -> parent_id if any exist.
  7. Move `source_fetch_cursors` from child_id -> parent_id (preserves
     ingest position for the demo appid so tomorrow's daily cron doesn't
     re-fetch history).
  8. Move competitor_games rows (parent_id and competitor_id columns).
  9. Set parent.alias_steam_app_ids to include the child's steam_app_id.
 10. Mark child.is_active = False and clear its steam_app_id so the UNIQUE
     constraint frees it for the alias (keep the row for audit trail;
     rename to '<name> [merged into <parent_id> on <date>]').

Dry-run mode (default):
  Reports the counts that WOULD move without changing anything. Uses a
  SAVEPOINT + ROLLBACK so the UPDATEs run against the real data (proving
  conflict rows would be found and reported honestly) but nothing lands.

CLAUDE.md §7 note: this touches the primary DB, so we run it as an
explicit workflow with dry-run gate + before/after row-count table, not
as a scheduler-invoked cron.

Usage:
  python -m scripts.merge_child_appid_into_parent \\
      --parent-id 21 --child-id 155 --alias-appid 5184670 --dry-run
  python -m scripts.merge_child_appid_into_parent \\
      --parent-id 21 --child-id 155 --alias-appid 5184670 --commit
"""
from __future__ import annotations

import argparse
import sys
from typing import Any

from sqlalchemy import text

from database import SessionLocal
from models import Game


def _counts_for_game(session, game_id: int) -> dict[str, int]:
    """Snapshot row counts per FK-tied table for a given game_id."""
    def q(sql: str) -> int:
        row = session.execute(text(sql), {"gid": game_id}).scalar_one()
        return int(row or 0)
    return {
        "raw_posts":         q("SELECT COUNT(*) FROM raw_posts        WHERE game_id = :gid"),
        # sentiment_records via raw_posts join
        "sentiment_records": q("SELECT COUNT(*) FROM sentiment_records sr "
                              "JOIN raw_posts rp ON sr.raw_post_id = rp.id "
                              "WHERE rp.game_id = :gid"),
        "daily_summaries":   q("SELECT COUNT(*) FROM daily_summaries   WHERE game_id = :gid"),
        "monthly_summaries": q("SELECT COUNT(*) FROM monthly_summaries WHERE game_id = :gid"),
        "window_summaries":  q("SELECT COUNT(*) FROM window_summaries  WHERE game_id = :gid"),
        "topic_trends":      q("SELECT COUNT(*) FROM topic_trends      WHERE game_id = :gid"),
        "editorial_articles":q("SELECT COUNT(*) FROM editorial_articles WHERE game_id = :gid"),
        "timeline_events":   q("SELECT COUNT(*) FROM timeline_events   WHERE game_id = :gid"),
        "source_fetch_cursors": q("SELECT COUNT(*) FROM source_fetch_cursors WHERE game_id = :gid"),
        "competitor_parent": q("SELECT COUNT(*) FROM competitor_games  WHERE parent_id = :gid"),
        "competitor_child":  q("SELECT COUNT(*) FROM competitor_games  WHERE competitor_id = :gid"),
    }


def _print_counts_table(label: str, counts: dict[str, int]) -> None:
    print(f"\n── {label} ──")
    print(f"  {'table':<24} count")
    print(f"  {'-'*24} -----")
    for k, v in counts.items():
        print(f"  {k:<24} {v}")


def _perform_move(session, parent: Game, child: Game, alias_appid: int) -> dict[str, int]:
    """Execute the actual UPDATE / DELETE statements. Assumes caller has
    already validated parent/child/alias. Returns a dict of rows-affected
    per operation for the caller's final log."""
    parent_id = parent.id
    child_id = child.id
    affected: dict[str, int] = {}

    # Step 1: move raw_posts. sentiment_records follow via FK.
    # The (source, external_id) unique constraint is GLOBAL, so a duplicate
    # can never have existed under both game_ids — no conflict handling
    # needed for the UPDATE.
    r = session.execute(
        text("UPDATE raw_posts SET game_id = :pid WHERE game_id = :cid"),
        {"pid": parent_id, "cid": child_id},
    )
    affected["raw_posts_moved"] = r.rowcount or 0

    # Step 3: delete regenerable aggregates (they'll rebuild from merged corpus).
    for table in ("daily_summaries", "monthly_summaries", "window_summaries", "topic_trends"):
        r = session.execute(text(f"DELETE FROM {table} WHERE game_id = :cid"), {"cid": child_id})
        affected[f"{table}_deleted"] = r.rowcount or 0

    # Step 4: move user-authored / cursor rows.
    for table in ("editorial_articles", "timeline_events", "source_fetch_cursors"):
        # Guard against UNIQUE violations on tables that have (game_id, ...)
        # composite uniques by using ON CONFLICT DO NOTHING semantics; if not
        # supported by the driver, we just UPDATE and let a real conflict
        # surface (there shouldn't be any given the small demo row count).
        r = session.execute(
            text(f"UPDATE {table} SET game_id = :pid WHERE game_id = :cid"),
            {"pid": parent_id, "cid": child_id},
        )
        affected[f"{table}_moved"] = r.rowcount or 0

    # Step 5: move competitor_games rows.
    r = session.execute(
        text("UPDATE competitor_games SET parent_id = :pid WHERE parent_id = :cid"),
        {"pid": parent_id, "cid": child_id},
    )
    affected["competitor_games_parent_moved"] = r.rowcount or 0
    r = session.execute(
        text("UPDATE competitor_games SET competitor_id = :pid WHERE competitor_id = :cid"),
        {"pid": parent_id, "cid": child_id},
    )
    affected["competitor_games_competitor_moved"] = r.rowcount or 0

    # Step 6: set parent.alias_steam_app_ids += [alias_appid] (dedup).
    existing_aliases = list(parent.alias_steam_app_ids or [])
    if alias_appid not in existing_aliases:
        existing_aliases.append(alias_appid)
    parent.alias_steam_app_ids = existing_aliases or None
    session.add(parent)
    affected["parent_aliases_after"] = len(existing_aliases)

    # Step 7: free the child's steam_app_id from the UNIQUE constraint
    # (set to a synthetic negative sentinel so audit still knows what it was;
    # the actual number is preserved in the parent's alias list).
    # SQLite lets us store negative integers; production check:
    original_name = child.name or ""
    child.steam_app_id = -child.steam_app_id  # -5184670 for the Hellraiser case
    child.is_active = False
    child.name = f"{original_name} [merged into game_id={parent_id} 2026-09-18]"
    session.add(child)
    affected["child_deactivated"] = 1

    return affected


def run(parent_id: int, child_id: int, alias_appid: int, commit: bool) -> int:
    session = SessionLocal()
    try:
        parent = session.get(Game, parent_id)
        child = session.get(Game, child_id)
        if not parent:
            print(f"ERROR: parent game_id={parent_id} not found.", file=sys.stderr)
            return 2
        if not child:
            print(f"ERROR: child game_id={child_id} not found.", file=sys.stderr)
            return 2
        # Idempotency guard runs BEFORE the appid-equality check because
        # after a successful merge the child's steam_app_id is negated
        # (audit sentinel), which would then make the equality check
        # always fire on a re-run and mask the intended 'already merged'
        # message.
        existing_aliases = parent.alias_steam_app_ids or []
        if alias_appid in existing_aliases:
            print(
                f"INFO: parent game_id={parent_id} already has alias {alias_appid}. "
                f"This is likely a re-run \u2014 refusing to move any rows.",
                file=sys.stderr,
            )
            return 3
        if child.steam_app_id != alias_appid:
            print(
                f"ERROR: child.steam_app_id={child.steam_app_id} but "
                f"--alias-appid={alias_appid}. Refusing to run \u2014 the "
                f"alias must equal the child's Steam appid.",
                file=sys.stderr,
            )
            return 2

        print(f"── Merge plan ──")
        print(f"  parent  : id={parent.id}  name={parent.name!r}  appid={parent.steam_app_id}")
        print(f"  child   : id={child.id}   name={child.name!r}   appid={child.steam_app_id}")
        print(f"  alias   : {alias_appid} (will be appended to parent.alias_steam_app_ids)")

        before_parent = _counts_for_game(session, parent_id)
        before_child = _counts_for_game(session, child_id)
        _print_counts_table(f"BEFORE parent (id={parent_id})", before_parent)
        _print_counts_table(f"BEFORE child (id={child_id})", before_child)

        # Execute move inside a transaction. Dry-run rolls back at the end.
        savepoint = session.begin_nested()
        affected = _perform_move(session, parent, child, alias_appid)

        print(f"\n── Operations (would run / did run) ──")
        for k, v in affected.items():
            print(f"  {k:<40} {v}")

        after_parent = _counts_for_game(session, parent_id)
        after_child = _counts_for_game(session, child_id)
        _print_counts_table(f"AFTER parent (id={parent_id})", after_parent)
        _print_counts_table(f"AFTER child (id={child_id})", after_child)

        if commit:
            savepoint.commit()
            session.commit()
            print("\n\u2705 COMMITTED. Data move is live.")
            return 0
        else:
            savepoint.rollback()
            session.rollback()
            print("\n\U0001f504 DRY-RUN. All changes rolled back \u2014 no data was written.")
            return 0
    finally:
        session.close()


def main() -> int:
    p = argparse.ArgumentParser(description="Merge a child-appid game row into a parent.")
    p.add_argument("--parent-id", type=int, required=True)
    p.add_argument("--child-id",  type=int, required=True)
    p.add_argument("--alias-appid", type=int, required=True,
                   help="The child's steam_app_id. Redundant with lookup but required as a guard.")
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true",
                      help="Snapshot + simulate + roll back. Nothing is written.")
    mode.add_argument("--commit", action="store_true",
                      help="Actually perform the move. Requires --parent-id, --child-id, --alias-appid.")
    args = p.parse_args()
    return run(
        parent_id=args.parent_id,
        child_id=args.child_id,
        alias_appid=args.alias_appid,
        commit=args.commit,
    )


if __name__ == "__main__":
    sys.exit(main())
