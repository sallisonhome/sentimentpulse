"""
Audit + optionally purge Reddit posts that don't actually mention the
game they're tagged to.

Written 2026-08-19 for the v0019 bug fix.

Background:
  * Before v0019, arctic_shift_service.ARCTIC_SHIFT_GENERAL_SUBS had
    diverged from reddit_service._GENERAL_SUBREDDITS. Popular subs like
    r/pcmasterrace, r/playstation, r/XboxSeriesX, r/GamingLeaksAndRumours,
    r/truegaming, r/ShouldIbuythisgame were treated as DEDICATED by
    arctic_shift, so daily ingest saved 100 random posts per day per
    affected game as if they were about the game.
  * 17 games affected.

This script:
  1. Iterates every Reddit RawPost row.
  2. For each post, applies the fixed _post_mentions_game(post, query,
     distinctive_keywords=game.distinctive_keywords) filter using the
     game's current settings.
  3. If a post fails the filter AND the source-subreddit is in
     _GENERAL_SUBREDDITS, it's a candidate for deletion.
  4. Dry-run mode (default): prints summary only.
  5. --purge mode: deletes candidate rows + cascades to sentiment_records
     and reddit_comments via existing FKs.

Usage:
  python -m scripts.audit_polluted_reddit_posts               # dry-run
  python -m scripts.audit_polluted_reddit_posts --purge       # actually delete
  python -m scripts.audit_polluted_reddit_posts --game-ids 144,145  # scope

Safety:
  * Never deletes posts from dedicated subs \u2014 those bypass the mention
    filter by design.
  * Never deletes posts that pass the filter under the game's CURRENT
    distinctive_keywords config. If the operator adds keywords later,
    they can re-run this script.
  * Prints a per-game before/after count and a global summary before
    any DELETE runs, so operators can eyeball it.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import defaultdict
from typing import Optional

from database import SessionLocal
from models import Game, RawPost, SourceEnum
from services.reddit_service import _GENERAL_SUBREDDITS, _post_mentions_game, _game_search_query


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)


def _subreddit_from_url(url: str) -> Optional[str]:
    """Extract normalized (lowercased) subreddit name from a Reddit URL."""
    if not url or "reddit.com/r/" not in url:
        return None
    try:
        return url.split("/r/", 1)[1].split("/", 1)[0].lower()
    except IndexError:
        return None


def audit_game(db, game: Game) -> tuple[int, int, list[int]]:
    """Return (total_reddit_posts, polluted_candidates, list_of_polluted_ids)."""
    posts = (
        db.query(RawPost)
        .filter(RawPost.game_id == game.id, RawPost.source == SourceEnum.reddit)
        .all()
    )
    if not posts:
        return 0, 0, []

    query = _game_search_query(game.name, game=game)
    dk = game.distinctive_keywords or None
    general_lower = {s.lower() for s in _GENERAL_SUBREDDITS}

    polluted_ids: list[int] = []
    for p in posts:
        sub = _subreddit_from_url(p.url or "")
        if sub is None or sub not in general_lower:
            # Dedicated sub \u2014 posts bypass the mention filter by design.
            continue
        # Reconstruct a post dict that _post_mentions_game understands.
        as_dict = {"title": p.title or "", "body": p.body or ""}
        if not _post_mentions_game(as_dict, query, distinctive_keywords=dk):
            polluted_ids.append(p.id)

    return len(posts), len(polluted_ids), polluted_ids


def purge_ids(db, ids: list[int]) -> int:
    """Delete raw_posts rows by id.  Cascades via FK to sentiment_records
    (RawPost.sentiment_record) and reddit_comment children (parent_external_id
    is a soft link, not FK-cascaded; we handle it here explicitly)."""
    if not ids:
        return 0
    # Chunk deletes for large batches
    total = 0
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        n = db.query(RawPost).filter(RawPost.id.in_(chunk)).delete(
            synchronize_session=False,
        )
        total += n
    db.commit()
    return total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--purge", action="store_true", help="Delete polluted rows.")
    parser.add_argument("--game-ids", type=str, default="", help="Comma-sep list of game ids to scope to.")
    parser.add_argument("--sample-titles", type=int, default=3, help="How many sample titles to print per game (0=none).")
    args = parser.parse_args()

    scope_ids: Optional[set[int]] = None
    if args.game_ids:
        scope_ids = {int(x) for x in args.game_ids.split(",") if x.strip()}

    db = SessionLocal()
    try:
        q = db.query(Game).filter(Game.is_active == True)  # noqa: E712
        if scope_ids:
            q = q.filter(Game.id.in_(scope_ids))
        games = q.order_by(Game.id).all()

        global_totals = {"total": 0, "polluted": 0, "affected_games": 0}
        by_game_polluted_ids: dict[int, list[int]] = defaultdict(list)

        print(f"{'ID':<5}{'Name':<40}{'Total':<8}{'Polluted':<10}{'%':<6}{'Distinctive keywords set':<10}")
        print("-" * 90)
        for game in games:
            total, polluted, ids = audit_game(db, game)
            if polluted > 0:
                global_totals["affected_games"] += 1
            global_totals["total"] += total
            global_totals["polluted"] += polluted
            by_game_polluted_ids[game.id] = ids
            has_dk = "yes" if game.distinctive_keywords else "no"
            pct = f"{(polluted/total*100):.1f}%" if total > 0 else "-"
            print(f"{game.id:<5}{(game.name or '')[:39]:<40}{total:<8}{polluted:<10}{pct:<6}{has_dk:<10}")

            if args.sample_titles > 0 and ids:
                sample = db.query(RawPost.title).filter(RawPost.id.in_(ids[: args.sample_titles])).all()
                for (title,) in sample:
                    print(f"       - {(title or '')[:80]}")

        print("-" * 90)
        print(f"GLOBAL: {global_totals['polluted']:,} polluted / {global_totals['total']:,} total Reddit posts "
              f"across {global_totals['affected_games']} games")

        if args.purge:
            print(f"\n=== PURGING {global_totals['polluted']:,} polluted rows ===")
            n_deleted = 0
            for gid, ids in by_game_polluted_ids.items():
                n = purge_ids(db, ids)
                n_deleted += n
                if n:
                    logger.info("game_id=%d deleted %d polluted posts", gid, n)
            print(f"Deleted {n_deleted:,} raw_posts rows total.")
        else:
            print("\n(dry-run \u2014 no rows deleted; pass --purge to actually delete)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
