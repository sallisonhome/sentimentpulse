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
from services.arctic_shift_service import (  # noqa: E402
    ARCTIC_SHIFT_BASE,
    ARCTIC_SHIFT_USER_AGENT,
    _convert_post,
    _post_mentions_game,
)
from services.steam_service import (  # noqa: E402
    scrape_forum_threads,
)
import requests  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

STEAM_REVIEWS_BASE = "https://store.steampowered.com/appreviews/{app_id}"
REQUEST_DELAY = 1.5
TIMEOUT = 30.0


def _to_epoch(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp())


def _arctic_shift_page(
    subreddit: str,
    before_epoch: int,
    after_epoch: int,
    limit: int = 100,
    title_query: str | None = None,
    selftext_query: str | None = None,
) -> list[dict]:
    """
    Fetch one Arctic Shift page (raw items, not yet converted). Supports
    before= to page backward. Empty list = end of history for this window.
    """
    params: dict = {
        "subreddit": subreddit,
        "limit": limit,
        "sort": "desc",
        "before": before_epoch,
        "after": after_epoch,
    }
    if title_query:
        params["title"] = title_query
    if selftext_query:
        params["selftext"] = selftext_query
    # v0016.10 (2026-08-12): retry-with-backoff on Arctic Shift's transient
    # 'Timeout. Maybe slow down a bit' error. Prior behavior returned []
    # on the first timeout, which the caller interprets as end-of-history
    # and stops walking the sub entirely — missing all subsequent posts.
    # Rideshare backfill demonstrated: 5 of 6 subs hit exactly this,
    # dropping 10 known threads to 1 saved post.
    # v0016.11 (2026-08-12): Arctic Shift's rate limiter is per-sub sticky
    # — once GamingLeaksAndRumours-style subs time out, they need a longer
    # cool-down. Bumped 3s to 8s to give the first retry a real chance.
    _TIMEOUT_RETRY_DELAYS = [8, 20, 40]  # seconds between attempts
    _RETRY_ERROR_SIGNATURES = ("timeout", "slow down", "too many", "rate")

    for attempt, backoff in enumerate([0] + _TIMEOUT_RETRY_DELAYS):
        if backoff:
            time.sleep(backoff)
        try:
            r = requests.get(
                ARCTIC_SHIFT_BASE,
                params=params,
                headers={"User-Agent": ARCTIC_SHIFT_USER_AGENT, "Accept": "application/json"},
                timeout=TIMEOUT,
            )
            time.sleep(REQUEST_DELAY)
            if r.status_code != 200:
                logger.warning(
                    "arctic_shift HTTP %d for r/%s (before=%d, attempt=%d)",
                    r.status_code, subreddit, before_epoch, attempt,
                )
                if r.status_code in (429, 502, 503, 504) and attempt < len(_TIMEOUT_RETRY_DELAYS):
                    continue
                return []
            data = r.json()
            if not isinstance(data, dict):
                logger.warning("arctic_shift bad JSON for r/%s: %s", subreddit, type(data).__name__)
                return []
            if "error" in data:
                err_msg = str(data.get("error") or "").lower()
                is_retryable = any(sig in err_msg for sig in _RETRY_ERROR_SIGNATURES)
                if is_retryable and attempt < len(_TIMEOUT_RETRY_DELAYS):
                    logger.info(
                        "arctic_shift transient error for r/%s (%s) — retrying in %ds",
                        subreddit, data.get("error"), _TIMEOUT_RETRY_DELAYS[attempt],
                    )
                    continue
                logger.warning("arctic_shift error for r/%s: %s", subreddit, data.get("error"))
                return []
            return data.get("data") or []
        except Exception as exc:
            logger.error("arctic_shift request failed for r/%s (attempt=%d): %s", subreddit, attempt, exc)
            if attempt < len(_TIMEOUT_RETRY_DELAYS):
                continue
            return []
    return []


def backfill_dtf_for_game(
    db, game: Game, start_dt: datetime, errors: list[str],
) -> int:
    """
    DTF.ru backfill — walk the search endpoint backwards in date until we
    cross the start_dt boundary.  Uses the DTF service's paginated
    ``fetch_dtf_posts_since`` helper so the paging + cutoff logic lives
    in one place.

    Only enabled when the DTF flag is truthy (checked via the same
    ``_dtf_enabled`` helper that the incremental ingestor uses —
    AppSetting['dtf_enabled'] first, DTF_ENABLED env var fallback).
    Lets operators disable DTF backfills without a deploy. Added 2026-07-26.
    """
    from services.ingestor import _dtf_enabled  # noqa: PLC0415
    if not _dtf_enabled(db):
        logger.info("DTF backfill skipped for %s (dtf_enabled flag unset)", game.name)
        return 0

    from services.dtf_service import fetch_dtf_posts_since  # noqa: PLC0415

    try:
        # Use the exact game name as the search query — same rationale
        # as _step4c_dtf.  For non-Latin-safe games we can add per-game
        # Russian aliases later.
        posts = fetch_dtf_posts_since(
            query=game.name,
            since_utc=start_dt.astimezone(timezone.utc),
            game_name=game.name,
            hard_cap=2000,  # Generous cap; DTF's ILL result set is ~200-500
        )
    except Exception as exc:
        errors.append(f"DTF backfill fetch failed for {game.name}: {exc}")
        logger.error("DTF backfill fetch failed for %s: %s", game.name, exc)
        return 0

    if not posts:
        logger.info("DTF backfill: 0 posts found for %s", game.name)
        return 0

    saved = _bulk_save_posts(db, game.id, SourceEnum.dtf, posts, errors)
    logger.info(
        "DTF backfill for %s: fetched=%d saved=%d",
        game.name, len(posts), saved,
    )
    return saved


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
    # arctic_shift_service behavior). Dedicated subs get all posts.
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
        query = _game_search_query(game.name, game=game) if is_general else None

        # For general subs, we need to make TWO parallel walks (title +
        # selftext) exactly like arctic_shift_service does, then merge.
        # For dedicated subs, one walk.
        query_variants: list[tuple[str | None, str | None]]
        if is_general and query:
            query_variants = [(query, None), (None, query)]
        else:
            query_variants = [(None, None)]

        seen_ids: set[str] = set()
        sub_saved = 0
        pages_total = 0

        for title_q, selftext_q in query_variants:
            before = int(datetime.now(tz=timezone.utc).timestamp())
            pages_fetched = 0
            while True:
                data = _arctic_shift_page(
                    sub_name, before, start_epoch,
                    limit=100,
                    title_query=title_q, selftext_query=selftext_q,
                )
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
                    if not external_id or external_id in seen_ids:
                        continue
                    seen_ids.add(external_id)
                    converted = _convert_post(item)
                    if converted is None:
                        continue
                    # For general subs, post-filter (matches arctic_shift_service).
                    # v0019: pass distinctive_keywords for the strict two-token gate.
                    if is_general and query and not _post_mentions_game(
                        converted, query,
                        distinctive_keywords=(game.distinctive_keywords or None),
                    ):
                        continue
                    posts.append(converted)

                if posts:
                    saved = _bulk_save_posts(db, game.id, SourceEnum.reddit, posts, errors)
                    sub_saved += saved
                    total_saved += saved

                pages_fetched += 1
                pages_total += 1
                if oldest_epoch < start_epoch:
                    break
                if oldest_epoch >= before:
                    break
                before = oldest_epoch
                if pages_fetched >= 20:
                    logger.warning(
                        "20-page cap hit for r/%s (%s) title=%s selftext=%s",
                        sub_name, game.name, title_q, selftext_q,
                    )
                    break

        logger.info(
            "  r/%s (%s): %d pages total across %d variants, %d new posts",
            sub_name, game.name, pages_total, len(query_variants), sub_saved,
        )

    return total_saved


def backfill_steam_forums_for_game(
    db, game: Game, start_dt: datetime, errors: list[str],
) -> int:
    """
    Steam Forum historical backfill.

    The daily ingestion (via services.steam_service.scrape_forum_threads)
    now paginates by default, but caps at max_threads=30 across ~3 pages
    for daily-cron cost containment. For a one-time historical fill on a
    newly-added game, we want much broader coverage — up to 200 threads
    across up to 15 listing pages — so we call the same function with
    generous caps.

    Each returned post has a post_date; we filter to posts newer than
    start_dt before saving (deduplicated by external_id in _bulk_save_posts).
    """
    if not game.steam_app_id:
        return 0

    try:
        # v2 (2026-07-28): pass the same since_epoch to scrape_forum_threads
        # so the listing-walk short-circuit and per-thread skip-if-stale
        # kick in during backfill too. Historical mode still needs a
        # wallclock ceiling so a broken forum can't hang the whole backfill
        # job — 15 minutes per game is enough for a from-scratch fill on
        # even the heaviest active forums.
        posts = scrape_forum_threads(
            game.steam_app_id,
            max_threads=500,       # allow all 264 ILL threads through
            max_pages=25,          # 25 x 15 = up to 375 threads visible per game
            since_epoch=int(start_dt.timestamp()),
            wallclock_budget_s=15 * 60,
        )
    except Exception as exc:
        logger.error("Steam forum backfill fetch failed for %s: %s", game.name, exc)
        errors.append(f"steam_forum backfill {game.name}: {exc}")
        return 0

    start_naive = start_dt.replace(tzinfo=None)
    in_window = [
        p for p in posts
        if p.get("post_date") and p["post_date"] >= start_naive
    ]
    dropped_old = len(posts) - len(in_window)

    if not in_window:
        logger.info(
            "  Steam Forum (%s): scraped %d posts total, none newer than %s",
            game.name, len(posts), start_dt.date(),
        )
        return 0

    saved = _bulk_save_posts(
        db, game.id, SourceEnum.steam_forum, in_window, errors,
    )
    logger.info(
        "  Steam Forum (%s): scraped %d posts (%d in window since %s, %d older), saved %d new",
        game.name, len(posts), len(in_window), start_dt.date(), dropped_old, saved,
    )
    return saved


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


def backfill_bluesky_for_game(
    db, game: Game, start_dt: datetime, errors: list[str],
) -> int:
    """Bluesky historical backfill (added 2026-07-28).

    Bluesky's app.bsky.feed.searchPosts supports RFC3339 since/until
    filters, so we can bound the search window to the backfill range
    and paginate deep into results. The service already handles auth,
    401 retries, exact-phrase quoting, and the aggregator/promo filter
    — we just call it with a much larger max_pages and the date
    bounds, then bulk-save the results.

    Bluesky's search index has spotty coverage beyond ~30 days; for
    the requested "as far back as you can up to 30 days" window this
    is expected to return good data but yield naturally trails off as
    we get closer to the 30-day edge.

    Idempotent — _bulk_save_posts dedupes on external_id.
    """
    from services.bluesky_service import fetch_bluesky_posts_for_game

    # Convert start_dt to RFC3339 UTC. Bluesky requires the 'Z' suffix.
    since_iso = start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    # until = now, so we cover "since start_dt through the present".
    until_dt = datetime.now(tz=timezone.utc)
    until_iso = until_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    # 30 pages * 100 posts/page = 3000 posts max per game, which comfortably
    # covers even the highest-volume portfolio games (Halloween: The Game
    # averaged ~50 Bluesky posts/day in the 7d window, so 30 days ~= 1500
    # posts). Well above expected yield, keeping cap as a runaway guard.
    try:
        posts = fetch_bluesky_posts_for_game(
            game.name,
            limit=5000,
            since=since_iso,
            until=until_iso,
            max_pages=30,
            distinctive_keywords=game.distinctive_keywords,
        )
    except Exception as exc:
        msg = f"Bluesky backfill fetch failed for {game.name}: {exc}"
        logger.error(msg)
        errors.append(msg)
        return 0

    if not posts:
        logger.info("  Bluesky (%s): 0 posts in window", game.name)
        return 0

    saved = _bulk_save_posts(db, game.id, SourceEnum.bluesky, posts, errors)
    logger.info(
        "  Bluesky (%s): fetched %d, saved %d (window %s -> %s)",
        game.name, len(posts), saved, since_iso, until_iso,
    )
    return saved


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
            sf_saved = backfill_steam_forums_for_game(db, game, start_dt, errors)
            db.commit()
            d_saved = backfill_dtf_for_game(db, game, start_dt, errors)
            db.commit()

            logger.info(
                "Fetch complete for %s: reddit=%d steam_reviews=%d steam_forums=%d dtf=%d",
                game.name, r_saved, sr_saved, sf_saved, d_saved,
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
