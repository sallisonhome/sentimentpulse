"""
Portfolio scan endpoint (2026-07-25) — used by the weekday-morning
scheduled task to:

  1. Discover NEW titles published by the configured publishers (default
     Saber Interactive) and auto-onboard them (creates Game row + kicks
     off the standard 90-day Steam Forum backfill via
     services.new_game_onboarding.schedule_onboarding_backfill).

  2. Scan the past 24h of Steam Forum + Reddit + Bluesky activity across
     every active game (parents + competitors), compute each game's
     7-day rolling baseline, and flag "hot" threads that either:
       a. crossed 50 posts in the past 24 hours, OR
       b. crossed 3x the game's 7-day rolling daily average
             (whichever bar the thread trips first — the OR makes this
              sensitive to both big-day activity AND unusual spikes on
              normally-quiet titles).

  3. Return the top 3 threads sorted by post volume so the cron can
     format them into a Slack/in-app digest.

Everything is a single blocking HTTP call so the scheduled task doesn't
have to hold connections or state — it just reads the JSON and drafts
its notification.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from models import Game, RawPost, Publisher, SourceEnum

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/portfolio", tags=["portfolio"])


# ── 1. New-title discovery ────────────────────────────────────────────────────

def _discover_new_titles_for_publisher(db: Session, publisher_name: str) -> list[dict]:
    """
    Query Steam's publisher facet for `publisher_name`, diff against
    the existing set of Game.steam_app_id values, and return the
    discovered-but-not-yet-tracked titles.

    Does NOT create Game rows here — the caller decides whether to
    onboard them (typically yes, but keeping the discovery pure makes
    the endpoint safer to poll for previews).
    """
    from services.steam_service import get_games_by_publisher  # lazy import

    try:
        discovered = get_games_by_publisher(publisher_name)
    except Exception as exc:
        logger.warning("Publisher scan failed for %r: %s", publisher_name, exc)
        return []

    known_appids: set[int] = {
        aid for (aid,) in db.query(Game.steam_app_id).filter(Game.steam_app_id.is_not(None)).all()
    }
    new_titles = [
        {
            "steam_app_id": g["appid"],
            "name": g.get("name", f"AppID {g['appid']}"),
        }
        for g in discovered
        if g.get("appid") and g["appid"] not in known_appids
    ]
    return new_titles


def _onboard_new_title(
    db: Session,
    steam_app_id: int,
    fallback_name: str,
    publisher_id: int,
) -> Optional[Game]:
    """
    Create a Game row for a newly-discovered Steam AppID and kick off
    the standard 90-day onboarding backfill in the background.

    Mirrors the routers/games.create_game path (keywords, subreddits,
    fire-and-forget onboarding) but does not depend on the request
    schema, so it's callable from this cron endpoint too.
    """
    from services.steam_service import get_app_details
    from services.keyword_generator import generate_default_keywords
    from services.reddit_service import discover_subreddits
    from services.new_game_onboarding import schedule_onboarding_backfill

    details = get_app_details(steam_app_id) or {}
    name = details.get("name") or fallback_name
    rd = details.get("release_date") or {}
    release_date = rd.get("date") if isinstance(rd, dict) else None

    try:
        subreddits = discover_subreddits(name) or []
    except Exception as exc:
        logger.warning("Subreddit auto-discovery failed for %r: %s", name, exc)
        subreddits = []

    try:
        keywords = generate_default_keywords(name)
    except Exception as exc:
        logger.warning("Keyword generation failed for %r: %s", name, exc)
        keywords = []

    game = Game(
        publisher_id=publisher_id,
        steam_app_id=steam_app_id,
        name=name,
        release_date=release_date,
        is_active=True,
        subreddits=subreddits,
        distinctive_keywords=keywords,
    )
    db.add(game)
    try:
        db.commit()
        db.refresh(game)
    except Exception as exc:
        db.rollback()
        logger.error("Failed to create discovered game %r: %s", name, exc)
        return None

    try:
        schedule_onboarding_backfill(game.id)
    except Exception as exc:
        logger.warning("schedule_onboarding_backfill failed for new game id=%d: %s", game.id, exc)

    logger.info(
        "Discovered + onboarded new game id=%d name=%r steam_app_id=%d",
        game.id, name, steam_app_id,
    )
    return game


# ── 2. Spike detection ────────────────────────────────────────────────────────

def _detect_hot_threads(
    db: Session,
    absolute_threshold: int,
    baseline_multiplier: float,
    top_n: int,
) -> list[dict]:
    """
    Find the top-N most-active Steam Forum threads in the past 24h
    across all active games where the game's overall 24h post count
    either:
      - crossed `absolute_threshold` posts, OR
      - exceeded `baseline_multiplier` × the game's own 7-day rolling
        daily average.

    Groups by (game_id, forum_thread_id) so multi-post threads
    aggregate correctly. Returns a list ordered by 24h post count desc.
    """
    now = datetime.now(tz=timezone.utc)
    since_24h = now - timedelta(days=1)
    since_7d = now - timedelta(days=7)

    # v3 (2026-08-12): counts filter to signal-only. Noise from broad-genre
    # subs is excluded so it doesn't inflate the numbers or drown the
    # baseline. Untagged rows ('unclassified') are permissively included —
    # avoids blackout during the retroactive-tagging window.
    #
    # v0017 (2026-08-18): also exclude off-topic drift. A Turok thread
    # that becomes 200 comments of Helldivers cross-posting would
    # inherit 'dedicated_sub' tier and look like a spike but isn't about
    # the tracked game. Hot-thread detection is a game-specific signal
    # — apply the drift filter so surfaced spikes are real.
    from sqlalchemy import or_
    _relevance_ok = or_(
        RawPost.relevance_tier.in_(("dedicated_sub", "signal")),
        RawPost.relevance_tier.is_(None),
    )
    _not_drift = RawPost.is_off_topic_drift.is_(False)

    # 24h post counts per game (across all sources — Steam Forum,
    # Reddit, Bluesky, Steam Review — since a spike anywhere counts).
    per_game_24h = dict(
        db.query(RawPost.game_id, func.count(RawPost.id))
        .filter(RawPost.collected_at >= since_24h)
        .filter(_relevance_ok)
        .filter(_not_drift)
        .group_by(RawPost.game_id)
        .all()
    )

    # 7-day rolling average per game (posts/day).
    per_game_7d_total = dict(
        db.query(RawPost.game_id, func.count(RawPost.id))
        .filter(RawPost.collected_at >= since_7d)
        .filter(_relevance_ok)
        .filter(_not_drift)
        .group_by(RawPost.game_id)
        .all()
    )
    per_game_daily_avg = {
        gid: (total / 7.0) for gid, total in per_game_7d_total.items()
    }

    active_games = {g.id: g for g in db.query(Game).filter_by(is_active=True).all()}

    # Which games are "hot"?
    hot_game_ids: set[int] = set()
    for gid, count_24h in per_game_24h.items():
        if gid not in active_games:
            continue
        baseline = per_game_daily_avg.get(gid, 0)
        if count_24h >= absolute_threshold:
            hot_game_ids.add(gid)
        elif baseline > 0 and count_24h >= baseline * baseline_multiplier:
            hot_game_ids.add(gid)

    if not hot_game_ids:
        return []

    # For hot games, pull top forum threads. Steam Forum posts store the
    # thread id in the external_id prefix "forum_{thread_id}_{idx}".
    # We can group by the first two segments to get thread-level counts.
    from sqlalchemy import case, cast, String

    # For portability across SQLite (dev) and Postgres (prod), do the
    # grouping in Python rather than SQL string functions.
    forum_posts = (
        db.query(RawPost)
        .filter(RawPost.game_id.in_(hot_game_ids))
        .filter(RawPost.source == SourceEnum.steam_forum)
        .filter(RawPost.collected_at >= since_24h)
        .all()
    )

    # (game_id, thread_id) -> {count, title, sample_url, latest_post_at}
    thread_agg: dict[tuple[int, str], dict] = {}
    for p in forum_posts:
        ext = (p.external_id or "").strip()
        if not ext.startswith("forum_"):
            continue
        parts = ext.split("_", 2)  # ["forum", "{thread_id}", "{idx}"]
        if len(parts) < 3:
            continue
        thread_id = parts[1]
        key = (p.game_id, thread_id)
        entry = thread_agg.setdefault(key, {
            "game_id": p.game_id,
            "thread_id": thread_id,
            "post_count_24h": 0,
            "title": None,
            "url": None,
            "latest_post_at": None,
        })
        entry["post_count_24h"] += 1
        # First post's title is the thread title; keep the first non-empty title we see.
        if not entry["title"] and p.title:
            entry["title"] = p.title
        if not entry["url"] and p.url:
            entry["url"] = p.url
        if entry["latest_post_at"] is None or (p.post_date and p.post_date > entry["latest_post_at"]):
            entry["latest_post_at"] = p.post_date

    threads_sorted = sorted(
        thread_agg.values(), key=lambda t: t["post_count_24h"], reverse=True,
    )

    # Attach game name + spike-reason context.
    out: list[dict] = []
    for t in threads_sorted[:top_n]:
        g = active_games.get(t["game_id"])
        game_24h = per_game_24h.get(t["game_id"], 0)
        game_baseline = per_game_daily_avg.get(t["game_id"], 0)
        spike_reason: str
        if game_24h >= absolute_threshold and (
            game_baseline == 0 or game_24h < game_baseline * baseline_multiplier
        ):
            spike_reason = f"{game_24h} posts in past 24h (absolute threshold {absolute_threshold})"
        elif game_baseline > 0 and game_24h >= game_baseline * baseline_multiplier:
            spike_reason = (
                f"{game_24h} posts in past 24h — {game_24h / game_baseline:.1f}x "
                f"the {game_baseline:.1f}/day 7-day baseline"
            )
        else:
            spike_reason = f"{game_24h} posts in past 24h"
        out.append({
            "game_id": t["game_id"],
            "game_name": g.name if g else f"game {t['game_id']}",
            "thread_id": t["thread_id"],
            "thread_title": t["title"] or "(untitled thread)",
            "thread_url": t["url"],
            "post_count_24h": t["post_count_24h"],
            "latest_post_at": t["latest_post_at"].isoformat() if t["latest_post_at"] else None,
            "spike_reason": spike_reason,
        })
    return out


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/scan")
def portfolio_scan(
    discover_publishers: str = Query(
        "Saber Interactive",
        description=(
            "Comma-separated list of publishers to scan for new titles. "
            "Default: 'Saber Interactive'. Set to '' to skip discovery."
        ),
    ),
    auto_onboard: bool = Query(
        True,
        description=(
            "If true, immediately create Game rows for discovered titles "
            "and schedule their 90-day backfill. If false, only report them."
        ),
    ),
    absolute_threshold: int = Query(50, ge=1, description="Posts/day floor for a game to be 'hot'."),
    baseline_multiplier: float = Query(3.0, ge=1.0, description="Multiplier vs 7d avg."),
    top_n: int = Query(3, ge=1, le=10),
    db: Session = Depends(get_db),
) -> dict:
    """
    Weekday-morning portfolio scan.

    Returns:
      {
        "run_at": ISO datetime,
        "new_titles_discovered": [...],
        "new_titles_onboarded": [...],
        "hot_threads": [
           {game_id, game_name, thread_id, thread_title, thread_url,
            post_count_24h, latest_post_at, spike_reason}
        ],
        "games_scanned": int,
      }
    """
    run_at = datetime.now(tz=timezone.utc)

    # 1. Publisher discovery
    publishers = [p.strip() for p in discover_publishers.split(",") if p.strip()]
    new_titles_discovered: list[dict] = []
    new_titles_onboarded: list[dict] = []

    for publisher_name in publishers:
        found = _discover_new_titles_for_publisher(db, publisher_name)
        for t in found:
            new_titles_discovered.append({**t, "publisher": publisher_name})

    if auto_onboard and new_titles_discovered:
        # Use the first Publisher row in the DB as the default fk owner (mirrors
        # routers/games.create_game). If publisher table is empty, skip onboarding.
        pub = db.query(Publisher).first()
        if pub is None:
            logger.warning("Skipping auto-onboard: no Publisher row in DB.")
        else:
            for t in new_titles_discovered:
                game = _onboard_new_title(db, t["steam_app_id"], t["name"], pub.id)
                if game is not None:
                    new_titles_onboarded.append({
                        "steam_app_id": game.steam_app_id,
                        "game_id": game.id,
                        "name": game.name,
                        "publisher": t["publisher"],
                    })

    # 2. Spike detection
    hot_threads = _detect_hot_threads(
        db,
        absolute_threshold=absolute_threshold,
        baseline_multiplier=baseline_multiplier,
        top_n=top_n,
    )

    active_count = db.query(Game).filter_by(is_active=True).count()

    return {
        "run_at": run_at.isoformat(),
        "games_scanned": active_count,
        "new_titles_discovered": new_titles_discovered,
        "new_titles_onboarded": new_titles_onboarded,
        "hot_threads": hot_threads,
        "config": {
            "absolute_threshold": absolute_threshold,
            "baseline_multiplier": baseline_multiplier,
            "top_n": top_n,
            "publishers_scanned": publishers,
        },
    }
