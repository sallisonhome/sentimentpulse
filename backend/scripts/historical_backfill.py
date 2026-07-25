"""
One-time historical backfill script (2026-07-24).

Fetches Reddit, Steam Reviews, Steam Forums, and Bluesky posts for the
specified game(s) covering a date range far larger than the default
incremental-ingestion window (which only pulls the most recent ~100
posts per subreddit / most recent reviews).

Design:
  * Reddit (PullPush): pages backward by `before=<epoch>` using the
    oldest post in each page as the next `before`, until we cross the
    start-date boundary or PullPush returns an empty page.
  * Steam Reviews: uses `?filter=recent&language=all&day_range=<N>&cursor=`
    with cursor paging.
  * Steam Forums: the existing fetcher already walks thread history via
    the "next-page" scrape \u2014 call it as-is; if there's a gap in coverage
    we can extend later.
  * Bluesky: no historical API is exposed. We rely on the current-session
    search to catch what it can. Bluesky's search doesn't reach beyond a
    ~30-day rolling window in most cases anyway, so historical Bluesky
    backfill is essentially not possible.

After collecting raw posts, run through the same Step 5 relevance gate
and sentiment classifier as normal ingestion, then Step 6 topic
extraction + Step 7 daily summaries per day.

Usage:
    python scripts/historical_backfill.py \\
        --game-ids 138 139 \\
        --start-date 2026-04-01

Idempotent: safe to re-run. Deduplicates on RawPost.external_id + source,
so re-fetching the same posts is a no-op.
"""
import argparse
import logging
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent.parent))

from database import SessionLocal  # noqa: E402
from models import Game, SourceEnum  # noqa: E402
from services.ingestor import (  # noqa: E402
    _bulk_save_posts,
    _step5_classify_sentiment,
    _step6_extract_topics,
    _step7_daily_summary,
)
from services.nlp_service import load_model  # noqa: E402
from services.reddit_service import (  # noqa: E402
    _GENERAL_SUBREDDITS,
    _game_search_query,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

PULLPUSH_BASE = "https://api.pullpush.io/reddit/search/submission/"
STEAM_REVIEWS_BASE = "https://store.steampowered.com/appreviews/{app_id}"
REQUEST_DELAY = 2.0
TIMEOUT = 30.0


def _to_epoch(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp())


def _pullpush_page(
    subreddit: str,
    before_epoch: int,
    size: int = 100,
    q: str | None = None,
) -> list[dict]:
    """Fetch one PullPush page. Empty list = end of history."""
    params: dict = {
        "subreddit": subreddit,
        "size": size,
        "sort": "desc",
        "sort_type": "created_utc",
        "before": before_epoch,
    }
    if q:
        params["q"] = q
    try:
        r = httpx.get(
            PULLPUSH_BASE,
            params=params,
            headers={"User-Agent": "SentimentPulse-Backfill/1.0"},
            timeout=TIMEOUT,
        )
        time.sleep(REQUEST_DELAY)
        if r.status_code != 200:
            logger.warning(
                "PullPush HTTP %d for r/%s (before=%d)", r.status_code, subreddit, before_epoch,
            )
            return []
        return r.json().get("data", []) or []
    except Exception as exc:
        logger.error("PullPush request failed for r/%s: %s", subreddit, exc)
        return []


def backfill_reddit_for_game(
    db, game: Game, start_epoch: int, errors: list[str],
) -> int:
    """
    Iterate every configured subreddit for `game`. For each sub, page
    backward from `now` toward `start_epoch` using PullPush's `before=`
    parameter. Save every fetched post via _bulk_save_posts.
    Returns total NEW posts saved (deduplicated).
    """
    if not game.subreddits:
        logger.info("Game %s has no subreddits configured — skipping Reddit backfill", game.name)
        return 0

    total_saved = 0

    # Only apply game-name search filter for general subs (matches
    # reddit_service behavior). Dedicated subs get all posts.
    general_lower = {s.lower() for s in _GENERAL_SUBREDDITS}

    for raw_sub in game.subreddits:
        sub_name = raw_sub.strip().rstrip("/")
        if "/r/" in sub_name:
            sub_name = sub_name.split("/r/")[-1].split("/")[0]
        elif sub_name.startswith("r/"):
            sub_name = sub_name[2:]
        if not sub_name:
            continue

        is_general = sub_name.lower() in general_lower
        q_arg = _game_search_query(game.name) if is_general else None

        before = int(datetime.now(tz=timezone.utc).timestamp())
        pages_fetched = 0
        sub_saved = 0
        while True:
            data = _pullpush_page(sub_name, before, size=100, q=q_arg)
            if not data:
                break

            posts = []
            oldest_epoch = before
            for item in data:
                created_utc = item.get("created_utc", 0)
                try:
                    created_utc = int(float(created_utc))
                except Exception:
                    continue
                oldest_epoch = min(oldest_epoch, created_utc)
                if created_utc < start_epoch:
                    continue

                external_id = item.get("id", "")
                if not external_id:
                    continue

                permalink = item.get("permalink", "")
                url = f"https://www.reddit.com{permalink}" if permalink else ""
                posts.append({
                    "external_id": external_id,
                    "author": item.get("author", "[deleted]"),
                    "title": item.get("title", ""),
                    "body": (item.get("selftext", "") or "")[:2000],
                    "url": url,
                    "upvotes": max(0, int(item.get("score", 0))),
                    "post_date": datetime.fromtimestamp(created_utc, tz=timezone.utc),
                })

            if posts:
                saved = _bulk_save_posts(db, game.id, SourceEnum.reddit, posts, errors)
                sub_saved += saved
                total_saved += saved

            pages_fetched += 1
            # If the whole page was before the start date, we're done.
            if oldest_epoch < start_epoch:
                break
            # Prevent infinite loop if page returns same or newer timestamps.
            if oldest_epoch >= before:
                break
            before = oldest_epoch

            # Safety cap: never more than 20 pages per sub (2000 posts each).
            if pages_fetched >= 20:
                logger.warning(
                    "Hit 20-page cap for r/%s (%s) — stopping to avoid runaway",
                    sub_name, game.name,
                )
                break

        logger.info(
            "  r/%s (%s): %d pages, %d new posts",
            sub_name, game.name, pages_fetched, sub_saved,
        )

    return total_saved


def backfill_steam_reviews_for_game(
    db, game: Game, start_dt: datetime, errors: list[str],
) -> int:
    """
    Steam Reviews API supports cursor-based paging. Walk the history
    until we cross the start-date boundary.
    """
    if not game.steam_app_id:
        return 0

    total_saved = 0
    cursor = "*"
    pages_fetched = 0
    start_ts = int(start_dt.timestamp())

    while True:
        try:
            r = httpx.get(
                STEAM_REVIEWS_BASE.format(app_id=game.steam_app_id),
                params={
                    "json": "1",
                    "filter": "recent",
                    "language": "all",
                    "cursor": cursor,
                    "num_per_page": "100",
                    "purchase_type": "all",
                    "review_type": "all",
                },
                timeout=TIMEOUT,
            )
            time.sleep(1.0)
            if r.status_code != 200:
                logger.warning("Steam Reviews HTTP %d for app %d", r.status_code, game.steam_app_id)
                break
            data = r.json()
        except Exception as exc:
            logger.error("Steam Reviews request failed for %s: %s", game.name, exc)
            break

        reviews = data.get("reviews", []) or []
        if not reviews:
            break

        oldest_ts = int(datetime.now(tz=timezone.utc).timestamp())
        posts = []
        for rev in reviews:
            ts = int(rev.get("timestamp_created", 0))
            if ts == 0:
                continue
            oldest_ts = min(oldest_ts, ts)
            if ts < start_ts:
                continue
            rid = rev.get("recommendationid", "")
            if not rid:
                continue
            author = (rev.get("author") or {}).get("steamid", "[unknown]")
            posts.append({
                "external_id": str(rid),
                "author": str(author),
                "title": "",
                "body": (rev.get("review", "") or "")[:2000],
                "url": f"https://steamcommunity.com/profiles/{author}/recommended/{game.steam_app_id}/",
                "upvotes": int(rev.get("votes_up", 0) or 0),
                "post_date": datetime.fromtimestamp(ts, tz=timezone.utc),
            })

        if posts:
            saved = _bulk_save_posts(db, game.id, SourceEnum.steam_review, posts, errors)
            total_saved += saved

        pages_fetched += 1
        next_cursor = data.get("cursor", "")
        if not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor

        # If page's oldest review is already before our start_date, stop.
        if oldest_ts < start_ts:
            break

        if pages_fetched >= 20:
            logger.warning("Steam Reviews 20-page cap hit for %s", game.name)
            break

    logger.info("  Steam Reviews (%s): %d pages, %d new posts", game.name, pages_fetched, total_saved)
    return total_saved


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-ids", type=int, nargs="+", required=True)
    ap.add_argument("--start-date", type=str, required=True, help="ISO date, e.g. 2026-04-01")
    args = ap.parse_args()

    start_dt = datetime.fromisoformat(args.start_date).replace(tzinfo=timezone.utc)
    start_epoch = int(start_dt.timestamp())

    load_model()  # warm sentiment model once

    db = SessionLocal()
    try:
        for gid in args.game_ids:
            game = db.query(Game).filter_by(id=gid).first()
            if not game:
                logger.warning("Game %d not found — skipping", gid)
                continue
            logger.info("=" * 60)
            logger.info("Backfilling game #%d %r from %s", game.id, game.name, start_dt.date())
            logger.info("=" * 60)

            errors: list[str] = []
            r_saved = backfill_reddit_for_game(db, game, start_epoch, errors)
            db.commit()
            sr_saved = backfill_steam_reviews_for_game(db, game, start_dt, errors)
            db.commit()

            logger.info(
                "Fetch complete for %s: reddit=%d steam_reviews=%d",
                game.name, r_saved, sr_saved,
            )

            # Now run Step 5 (relevance + sentiment) on all the newly-inserted
            # rows for this game, then Step 6 and Step 7 for topic
            # extraction and daily summaries.
            log_lines: list[str] = []
            step5_errors: list[str] = []
            _step5_classify_sentiment(db, game, log_lines, step5_errors)
            for line in log_lines:
                logger.info("  %s", line)
            for e in step5_errors:
                logger.error("  %s", e)

            log_lines = []
            step6_errors: list[str] = []
            _step6_extract_topics(db, game, log_lines, step6_errors)
            _step7_daily_summary(db, game, log_lines, step6_errors)
            db.commit()

            for e in errors:
                logger.error("  raw-fetch error: %s", e)

            logger.info("Backfill complete for #%d %r", game.id, game.name)

        logger.info("All backfills complete.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
