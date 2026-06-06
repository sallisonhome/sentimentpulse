"""
Daily ingestion pipeline — orchestrates all 8 steps for every active game.

Steps
-----
1. Game Discovery    — Steam API publisher search + Reddit subreddit auto-detection
2. Steam Reviews     — fetch 100 most-recent reviews per game
3. Steam Forums      — scrape 10 most-active discussion threads per game
4. Reddit            — fetch new/hot posts + top-50 comments per subreddit
5. NLP Sentiment     — batch-classify all unprocessed raw_posts
6. Topic Extraction  — BERTopic / LDA per sentiment group → topic_trends upsert
7. Daily Summary     — aggregate counts + AI summary via Claude API
8. Log Results       — write logs/ingest_YYYY-MM-DD.log

Design principles
-----------------
- Every step is wrapped in try/except so a failure in one game never stops
  the others.
- Deduplication is enforced at the DB level (unique constraint on
  external_id + source) AND via a pre-flight set-check in _bulk_save_posts.
- The module-level `_status` dict is read by GET /api/ingest/status.
"""
import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from config import settings
from database import SessionLocal
from models import (
    DailySummary,
    Game,
    Publisher,
    RawPost,
    SentimentEnum,
    SentimentRecord,
    SourceEnum,
    TopicTrend,
)
from services.nlp_service import classify_batch, classify_batch_with_gate, classify_batch_with_gate_v2, load_model
from services.reddit_service import (
    discover_subreddits,
    fetch_post_comments,
    fetch_subreddit_posts,
    _game_search_query,
    _post_mentions_game,
)
from services.bluesky_service import fetch_bluesky_posts_for_game
from services.steam_service import (
    fetch_reviews,
    get_games_by_developer,
    get_games_by_publisher,
    scrape_forum_threads,
)
from services.summary_service import generate_summaries
from services import period_summary_service as _pss
from services.topic_service import (
    extract_topics,
    extract_topics_with_metadata,
    humanize_topic_labels,
    upsert_topic_trends,
)
from services.post_relevance import is_post_relevant_to_game

logger = logging.getLogger(__name__)

_LOG_DIR = Path(__file__).parent.parent / "logs"

# ── Module-level status — read by GET /api/ingest/status ─────────────────────
_status: dict = {
    "is_running": False,
    "last_run_at": None,          # ISO-8601 string
    # last_run_status values:
    #   "never"            — first boot, no run yet
    #   "success"          — all sources fetched data
    #   "partial"          — some games errored mid-run, but overall ok
    #   "partial_failure"  — ANY source returned 0 fetches across every
    #                        eligible game (even after retries where applicable).
    #                        Currently triggered by Reddit, Bluesky, and Steam.
    #   "error"            — a fatal exception aborted the run
    "last_run_status": "never",
    "last_run_errors": [],
    "games_processed": 0,
    "posts_collected": 0,
    "next_run_at": None,          # ISO-8601 string — set by scheduler
    # Per-source health snapshot from the most recent run.  Each value:
    #   "ok"        — fetched > 0 on first attempt
    #   "degraded"  — first attempt fetched 0 but a retry recovered
    #   "failed"    — fetched 0 even after all retries
    #   "skipped"   — no eligible games (no subreddits, no creds, etc.)
    #   "silent"    — fetched > 0 today but ≥90% drop vs prior-7d baseline
    #                 (set by silent-source detector after the run)
    #   "unknown"   — no run has happened yet
    "reddit_health": "unknown",
    "reddit_fetched_total": 0,
    "reddit_retries": 0,          # number of full-Step-4 retries actually run
    "bluesky_health": "unknown",
    "bluesky_fetched_total": 0,
    "bluesky_retries": 0,
    "steam_review_health": "unknown",
    "steam_review_fetched_total": 0,
    "steam_forum_health": "unknown",
    "steam_forum_fetched_total": 0,
}


def get_status() -> dict:
    """Return a snapshot of the current ingestion status."""
    return dict(_status)


def set_next_run(dt: Optional[datetime]) -> None:
    """Called by the scheduler after each run to record the next scheduled time."""
    _status["next_run_at"] = dt.isoformat() if dt else None


# ── Entry point ───────────────────────────────────────────────────────────────

def run_ingestion() -> dict:
    """
    Execute the full ingestion pipeline for all active games.

    Thread-safe: returns immediately if a run is already in progress.
    Returns a summary dict suitable for serialising as a JSON response.
    """
    if _status["is_running"]:
        logger.warning("Ingestion already running — ignoring duplicate trigger.")
        return {"status": "skipped", "reason": "already_running"}

    _status["is_running"] = True
    _status["last_run_at"] = datetime.now(timezone.utc).isoformat()

    log_lines: list[str] = []
    errors: list[str] = []
    games_processed = 0
    posts_collected = 0
    # Pre-declare with safe defaults so the `finally` block can always read
    # them, even if a fatal exception fires before the per-source phase.
    reddit_health = "unknown"
    reddit_fetched_total = 0
    reddit_retries = 0
    bluesky_health = "unknown"
    bluesky_fetched_total = 0
    bluesky_retries = 0
    steam_review_health = "unknown"
    steam_review_fetched_total = 0
    steam_forum_health = "unknown"
    steam_forum_fetched_total = 0

    # Ensure the NLP model is loaded before processing any posts
    load_model()

    # Reset Reddit Gist cache so fresh data is fetched each run
    from services.reddit_service import _reset_gist_cache  # noqa
    _reset_gist_cache()

    db = SessionLocal()
    try:
        # ── Step 1: game discovery ────────────────────────────────────────────
        active_games = _step1_discover_games(db, log_lines, errors)
        log_lines.append(
            f"[Step 1] {len(active_games)} active game(s) queued."
        )

        # Per-run aggregates that drive run-level health verdicts at the end.
        # Captured per source so we can detect silent-failure regressions on
        # ANY source independently — not just Reddit.  CLAUDE.md §19.
        reddit_fetched_total = 0
        reddit_retries = 0
        bluesky_fetched_total = 0
        bluesky_retries = 0
        steam_review_fetched_total = 0
        steam_forum_fetched_total = 0
        per_game_posts: dict[int, int] = {}

        # Bluesky eligibility: both creds set and kill-switch off.
        # Resolved once per run so per-game function can be pure.
        bsky_kill_switch = os.environ.get("BLUESKY_ENABLED", "").lower() == "false"
        bsky_handle = os.environ.get("BLUESKY_HANDLE", "").strip()
        bsky_pw = os.environ.get("BLUESKY_APP_PASSWORD", "").strip()
        bluesky_eligible = bool(bsky_handle and bsky_pw and not bsky_kill_switch)

        def _safe_run_steps_2_to_4b(game: Game) -> tuple[int, int, int, int, int]:
            """Run the fetching steps (2, 3, 4, 4b) for one game.

            Returns 5-tuple:
                (game_posts,
                 reddit_fetched, bluesky_fetched,
                 steam_review_fetched, steam_forum_fetched)

            Sentiment/topics/summary (Steps 5-7) are deferred to a second
            pass so they always run AFTER any retries land their data.
            """
            game_posts_local = 0

            sr_saved, sr_fetched = _step2_steam_reviews(db, game, log_lines, errors)
            game_posts_local += sr_saved

            sf_saved, sf_fetched = _step3_steam_forums(db, game, log_lines, errors)
            game_posts_local += sf_saved

            r_saved, r_fetched = _step4_reddit(db, game, log_lines, errors)
            game_posts_local += r_saved

            b_saved = 0
            b_fetched = 0
            if bsky_kill_switch:
                log_lines.append(
                    f"[Step 4b] '{game.name}': Bluesky disabled (BLUESKY_ENABLED=false)"
                )
            elif not bsky_handle or not bsky_pw:
                log_lines.append(
                    f"[Step 4b] '{game.name}': Bluesky skipped (no credentials)"
                )
            else:
                b_saved, b_fetched = _step4b_bluesky(db, game, log_lines, errors)
                game_posts_local += b_saved

            return game_posts_local, r_fetched, b_fetched, sr_fetched, sf_fetched

        # ── Phase A: fetch sources (Steps 2 -> 4b) for every active game ────────
        for game in active_games:
            try:
                (game_posts, r_f, b_f, sr_f, sf_f) = _safe_run_steps_2_to_4b(game)
                per_game_posts[game.id] = per_game_posts.get(game.id, 0) + game_posts
                reddit_fetched_total += r_f
                bluesky_fetched_total += b_f
                steam_review_fetched_total += sr_f
                steam_forum_fetched_total += sf_f
            except Exception as exc:
                msg = f"Unhandled error processing game '{game.name}': {exc}"
                errors.append(msg)
                logger.exception(msg)
                # Continue with next game - never abort the whole pipeline

        # ── Phase B.1: Reddit retry-with-backoff ─────────────────────────────
        # If EVERY active game returned 0 Reddit posts fetched despite having
        # subreddits configured, Arctic Shift was down, rate-limiting, or
        # transiently misbehaving.  Try again with exponential backoff.
        eligible_reddit_games = [g for g in active_games if g.subreddits]
        reddit_backoffs = [60, 300]  # 1 min, then 5 min

        while (
            reddit_fetched_total == 0
            and eligible_reddit_games
            and reddit_retries < len(reddit_backoffs)
        ):
            delay = reddit_backoffs[reddit_retries]
            reddit_retries += 1
            msg = (
                f"[Step 4] Reddit returned 0 fetches across all "
                f"{len(eligible_reddit_games)} eligible game(s).  Sleeping {delay}s "
                f"before retry #{reddit_retries}/{len(reddit_backoffs)}..."
            )
            log_lines.append(msg)
            logger.warning(msg)
            time.sleep(delay)

            retry_fetched = 0
            for game in eligible_reddit_games:
                try:
                    saved, fetched = _step4_reddit(db, game, log_lines, errors)
                    per_game_posts[game.id] = (
                        per_game_posts.get(game.id, 0) + saved
                    )
                    retry_fetched += fetched
                except Exception as exc:
                    err = (
                        f"[Step 4 retry #{reddit_retries}] Unhandled error "
                        f"for '{game.name}': {exc}"
                    )
                    errors.append(err)
                    logger.exception(err)

            reddit_fetched_total += retry_fetched
            log_lines.append(
                f"[Step 4 retry #{reddit_retries}] fetched {retry_fetched} "
                f"posts across {len(eligible_reddit_games)} eligible game(s)."
            )

        # ── Phase B.2: Bluesky retry-with-backoff (symmetric to Reddit) ─────────
        bluesky_backoffs = [60, 300]
        while (
            bluesky_eligible
            and bluesky_fetched_total == 0
            and active_games
            and bluesky_retries < len(bluesky_backoffs)
        ):
            delay = bluesky_backoffs[bluesky_retries]
            bluesky_retries += 1
            msg = (
                f"[Step 4b] Bluesky returned 0 fetches across all "
                f"{len(active_games)} game(s).  Sleeping {delay}s before "
                f"retry #{bluesky_retries}/{len(bluesky_backoffs)}..."
            )
            log_lines.append(msg)
            logger.warning(msg)
            time.sleep(delay)

            retry_fetched = 0
            for game in active_games:
                try:
                    saved, fetched = _step4b_bluesky(db, game, log_lines, errors)
                    per_game_posts[game.id] = (
                        per_game_posts.get(game.id, 0) + saved
                    )
                    retry_fetched += fetched
                except Exception as exc:
                    err = (
                        f"[Step 4b retry #{bluesky_retries}] Unhandled error "
                        f"for '{game.name}': {exc}"
                    )
                    errors.append(err)
                    logger.exception(err)

            bluesky_fetched_total += retry_fetched
            log_lines.append(
                f"[Step 4b retry #{bluesky_retries}] fetched {retry_fetched} "
                f"posts across {len(active_games)} game(s)."
            )

        # ── Compute per-source health verdicts ───────────────────────────────
        def _verdict(eligible: bool, fetched_total: int, retries: int) -> str:
            if not eligible:
                return "skipped"
            if fetched_total == 0:
                return "failed"
            if retries > 0:
                return "degraded"
            return "ok"

        reddit_health = _verdict(
            bool(eligible_reddit_games), reddit_fetched_total, reddit_retries
        )
        bluesky_health = _verdict(
            bluesky_eligible, bluesky_fetched_total, bluesky_retries
        )
        # Steam doesn't have retry semantics yet (Steam outages are usually
        # short and the next-day cron recovers).  We still compute health so
        # partial_failure surfaces if Steam goes 0 across every active game.
        steam_review_health = _verdict(
            bool(active_games), steam_review_fetched_total, 0
        )
        steam_forum_health = _verdict(
            bool(active_games), steam_forum_fetched_total, 0
        )

        # ── Silent-source detection (Gap 3) ──────────────────────────────────
        # For each source whose fresh verdict is 'ok', compare last-24h DB
        # rows against the prior-7d daily average.  If today is ≥90% below
        # the baseline AND the baseline is non-trivial, override the verdict
        # to 'silent' — fetches succeeded but persistence collapsed (the
        # exact pattern of the 2026-05-30 Reddit and 2026-06-06 Bluesky
        # regressions).  CLAUDE.md §19: log lines and counters are not
        # ground truth; the user-facing row count is.
        silent_results = _detect_silent_sources(db, log_lines)
        if silent_results.get("reddit") and reddit_health == "ok":
            reddit_health = "silent"
        if silent_results.get("bluesky") and bluesky_health == "ok":
            bluesky_health = "silent"
        if silent_results.get("steam_review") and steam_review_health == "ok":
            steam_review_health = "silent"
        if silent_results.get("steam_forum") and steam_forum_health == "ok":
            steam_forum_health = "silent"

        # Phase C: per-game analysis (Steps 5 -> 7)
        # Runs AFTER any retries so today's summary includes all data that
        # landed today — not just the first-pass results.
        for game in active_games:
            try:
                _step5_classify_sentiment(db, game, log_lines, errors)
                _step6_extract_topics(db, game, log_lines, errors)
                _step7_daily_summary(db, game, log_lines, errors)
                games_processed += 1
                posts_collected += per_game_posts.get(game.id, 0)
            except Exception as exc:
                msg = f"Steps 5-7 error for '{game.name}': {exc}"
                errors.append(msg)
                logger.exception(msg)

        # Step 9: Monthly summaries on 1st of month
        _step9_monthly_summaries(db, active_games, log_lines, errors)

        # Final status precedence:
        #   error  >  partial_failure  >  partial  >  success
        # partial_failure fires if ANY source is in 'failed' state.
        failed_sources = [
            name for name, health in (
                ("Reddit", reddit_health),
                ("Bluesky", bluesky_health),
                ("Steam reviews", steam_review_health),
                ("Steam forums", steam_forum_health),
            ) if health == "failed"
        ]
        silent_sources = [
            name for name, health in (
                ("Reddit", reddit_health),
                ("Bluesky", bluesky_health),
                ("Steam reviews", steam_review_health),
                ("Steam forums", steam_forum_health),
            ) if health == "silent"
        ]
        if failed_sources:
            final_status = "partial_failure"
            log_lines.append(
                "[Run] WARNING: the following source(s) fetched 0 posts "
                f"across all eligible games: {', '.join(failed_sources)}.  "
                "Marking run as partial_failure."
            )
        elif silent_sources:
            # Silent sources are also treated as partial_failure so the
            # status endpoint + frontend banner can alert immediately —
            # row counts collapsing by ≥90% is just as bad as fetched=0.
            final_status = "partial_failure"
            log_lines.append(
                "[Run] WARNING: the following source(s) are silent — "
                "≥90% drop in last-24h row count vs prior-7d baseline: "
                f"{', '.join(silent_sources)}.  Marking run as partial_failure."
            )
        elif errors:
            final_status = "partial"
        else:
            final_status = "success"

    except Exception as exc:
        msg = f"Fatal ingestion error: {exc}"
        errors.append(msg)
        logger.exception(msg)
        final_status = "error"

    finally:
        # ── Step 8: write log ─────────────────────────────────────────────────
        _step8_write_log(log_lines, errors)

        db.close()
        _status["is_running"] = False
        _status["last_run_status"] = final_status
        _status["last_run_errors"] = errors
        _status["games_processed"] = games_processed
        _status["posts_collected"] = posts_collected
        _status["reddit_health"] = reddit_health
        _status["reddit_fetched_total"] = reddit_fetched_total
        _status["reddit_retries"] = reddit_retries
        _status["bluesky_health"] = bluesky_health
        _status["bluesky_fetched_total"] = bluesky_fetched_total
        _status["bluesky_retries"] = bluesky_retries
        _status["steam_review_health"] = steam_review_health
        _status["steam_review_fetched_total"] = steam_review_fetched_total
        _status["steam_forum_health"] = steam_forum_health
        _status["steam_forum_fetched_total"] = steam_forum_fetched_total

    return {
        "status": final_status,
        "games_processed": games_processed,
        "posts_collected": posts_collected,
        "errors": errors,
        "reddit_health": reddit_health,
        "reddit_fetched_total": reddit_fetched_total,
        "reddit_retries": reddit_retries,
        "bluesky_health": bluesky_health,
        "bluesky_fetched_total": bluesky_fetched_total,
        "bluesky_retries": bluesky_retries,
        "steam_review_health": steam_review_health,
        "steam_review_fetched_total": steam_review_fetched_total,
        "steam_forum_health": steam_forum_health,
        "steam_forum_fetched_total": steam_forum_fetched_total,
    }


# ── Silent-source detector ────────────────────────────────────────────────────
# Threshold constants are module-level so tests can monkeypatch them without
# threading parameters through every call site.
_SILENT_DROP_RATIO = 0.10       # today < 10% of prior-7d avg ⇒ silent
_SILENT_MIN_BASELINE = 5.0       # prior-7d daily average must be ≥ this to
                                 # flag silent (avoids noise on quiet sources)


def _detect_silent_sources(db: Session, log_lines: list) -> dict[str, bool]:
    """
    Return {source_name: True} for any source whose last-24h RawPost row
    count has dropped ≥ (1 - _SILENT_DROP_RATIO) below the prior-7d daily
    average AND whose baseline is ≥ _SILENT_MIN_BASELINE rows/day.

    This is the ground-truth check that catches silent regressions where
    fetched > 0 (fetch counters are green) but persistence collapses —
    the exact failure mode of the 2026-05-30 Reddit and 2026-06-06
    Bluesky bugs.  CLAUDE.md §19.

    The detector reads `raw_posts.collected_at` — the persisted, user-
    facing column — not any in-memory counter.
    """
    results: dict[str, bool] = {}
    now = datetime.now(timezone.utc)
    last_24h_start = now - timedelta(hours=24)
    prior_7d_start = now - timedelta(days=8)
    prior_7d_end = last_24h_start  # exclusive upper bound = last_24h_start

    sources = [
        ("reddit", SourceEnum.reddit),
        ("bluesky", SourceEnum.bluesky),
        ("steam_review", SourceEnum.steam_review),
        ("steam_forum", SourceEnum.steam_forum),
    ]
    for key, source_enum in sources:
        try:
            today_count = (
                db.query(func.count(RawPost.id))
                .filter(RawPost.source == source_enum)
                .filter(RawPost.collected_at >= last_24h_start)
                .scalar()
                or 0
            )
            prior_count = (
                db.query(func.count(RawPost.id))
                .filter(RawPost.source == source_enum)
                .filter(RawPost.collected_at >= prior_7d_start)
                .filter(RawPost.collected_at < prior_7d_end)
                .scalar()
                or 0
            )
            prior_daily_avg = prior_count / 7.0

            # Need a meaningful baseline; otherwise a quiet/new source
            # would always look 'silent'.
            if prior_daily_avg < _SILENT_MIN_BASELINE:
                results[key] = False
                log_lines.append(
                    f"[Silent-check] {key}: baseline {prior_daily_avg:.1f}/day "
                    f"below threshold {_SILENT_MIN_BASELINE}/day — skipped."
                )
                continue

            ratio = today_count / prior_daily_avg if prior_daily_avg else 0
            is_silent = ratio < _SILENT_DROP_RATIO
            results[key] = is_silent
            log_lines.append(
                f"[Silent-check] {key}: today={today_count}, "
                f"prior_7d_avg={prior_daily_avg:.1f}/day, ratio={ratio:.2%} "
                f"({'SILENT' if is_silent else 'ok'})."
            )
        except Exception as exc:
            # Never let detector errors break a successful run.
            logger.exception(
                f"Silent-source detector failed for {key}: {exc}"
            )
            results[key] = False
            log_lines.append(
                f"[Silent-check] {key}: detector error ({exc}); skipped."
            )
    return results


# ── Step 1: Game Discovery ────────────────────────────────────────────────────

def _step1_discover_games(
    db: Session,
    log_lines: list,
    errors: list,
) -> list[Game]:
    """
    Fetch all Steam games for the configured publisher.
    Upserts new games and auto-discovers their subreddits.
    Returns the full list of active games for this publisher.
    """
    publisher: Optional[Publisher] = db.query(Publisher).first()
    if not publisher:
        log_lines.append("[Step 1] No publisher configured — nothing to ingest.")
        return []

    # Attempt Steam discovery by publisher; fall back to existing DB on failure
    try:
        steam_games_pub = get_games_by_publisher(publisher.name)
    except Exception as exc:
        msg = f"[Step 1] Steam publisher discovery failed: {exc}"
        errors.append(msg)
        logger.error(msg)
        steam_games_pub = []

    # Also search by developer name if configured (catches games published by
    # third parties such as Focus Home Interactive)
    steam_games_dev: list[dict] = []
    if settings.developer_name:
        try:
            steam_games_dev = get_games_by_developer(settings.developer_name)
        except Exception as exc:
            msg = f"[Step 1] Steam developer discovery failed: {exc}"
            errors.append(msg)
            logger.error(msg)

    # Merge, deduplicating by steam_app_id
    seen: dict[int, dict] = {g["steam_app_id"]: g for g in steam_games_pub}
    for g in steam_games_dev:
        seen.setdefault(g["steam_app_id"], g)
    steam_games = list(seen.values())

    new_count = 0
    for gd in steam_games:
        if db.query(Game).filter_by(steam_app_id=gd["steam_app_id"]).first():
            continue  # Already known
        subreddits = discover_subreddits(gd["name"])
        db.add(Game(
            publisher_id=publisher.id,
            steam_app_id=gd["steam_app_id"],
            name=gd["name"],
            release_date=gd.get("release_date"),
            is_active=True,
            subreddits=subreddits,
        ))
        new_count += 1

    if new_count:
        try:
            db.commit()
            log_lines.append(f"[Step 1] {new_count} new game(s) added.")
        except Exception as exc:
            db.rollback()
            errors.append(f"[Step 1] Error saving new games: {exc}")

    return (
        db.query(Game)
        .filter_by(publisher_id=publisher.id, is_active=True)
        .all()
    )


# ── Step 2: Steam Reviews ─────────────────────────────────────────────────────

def _step2_steam_reviews(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> tuple[int, int]:
    """Fetch Steam reviews.

    Returns:
        (saved, fetched).  Fetched counts the reviews returned by the Steam
        API (duplicates included); the run loop uses per-source fetched
        totals to detect silent-failure regressions.
    """
    try:
        known_ids: set[str] = {
            row[0]
            for row in db.query(RawPost.external_id).filter(
                RawPost.game_id == game.id,
                RawPost.source == SourceEnum.steam_review,
            )
        }
        reviews = fetch_reviews(game.steam_app_id, known_ids=known_ids)
    except Exception as exc:
        msg = f"[Step 2] Steam reviews failed for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return 0, 0

    saved = _bulk_save_posts(db, game.id, SourceEnum.steam_review, reviews, errors)
    log_lines.append(
        f"[Step 2] '{game.name}': {saved} new review(s) (fetched {len(reviews)})."
    )
    return saved, len(reviews)


# ── Step 3: Steam Forums ──────────────────────────────────────────────────────

def _step3_steam_forums(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> tuple[int, int]:
    """Scrape Steam forum threads.  Returns (saved, fetched)."""
    try:
        posts = scrape_forum_threads(game.steam_app_id, max_threads=10)
    except Exception as exc:
        msg = f"[Step 3] Steam forums failed for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return 0, 0

    saved = _bulk_save_posts(db, game.id, SourceEnum.steam_forum, posts, errors)
    log_lines.append(
        f"[Step 3] '{game.name}': {saved} new forum post(s) (fetched {len(posts)})."
    )
    return saved, len(posts)


# ── Step 4: Reddit ────────────────────────────────────────────────────────────

def _step4_reddit(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> tuple[int, int]:
    """Fetch Reddit posts from configured subreddits.

    Returns:
        (saved, fetched) tuple.
            saved   — count of NEW rows inserted into raw_posts
            fetched — count of submissions Arctic Shift actually returned
                      across all subreddits for this game (duplicates included).
                      Used by run_ingestion to detect when the whole Reddit
                      phase silently fetched nothing.
    """
    subreddits: list[str] = game.subreddits or []
    if not subreddits:
        log_lines.append(
            f"[Step 4] '{game.name}': no subreddits configured — skipping Reddit."
        )
        return 0, 0

    total_saved = 0
    total_fetched = 0
    for raw_sub in subreddits:
        # Normalise: accept full URLs like https://www.reddit.com/r/gaming/,
        # "r/gaming", or plain names like "gaming"
        sub_name = raw_sub.strip().rstrip("/")
        if "/r/" in sub_name:
            sub_name = sub_name.split("/r/")[-1].split("/")[0]
        elif sub_name.startswith("r/"):
            sub_name = sub_name[2:]
        if not sub_name:
            continue
        try:
            submissions = fetch_subreddit_posts(sub_name, limit=25, game_name=game.name)
            total_fetched += len(submissions)
            total_saved += _bulk_save_posts(
                db, game.id, SourceEnum.reddit, submissions, errors
            )
            # NOTE: Comment fetching is disabled because Reddit blocks all
            # JSON API requests from datacenter IPs (403 Blocked). Each
            # blocked comment fetch adds ~4s of wasted retry time, which
            # made full ingestion take hours. Posts alone provide sufficient
            # sentiment signal. Re-enable if Reddit API access is restored.
        except Exception as exc:
            msg = f"[Step 4] Reddit error for r/{sub_name}: {exc}"
            errors.append(msg)
            logger.error(msg)

    log_lines.append(
        f"[Step 4] '{game.name}': {total_saved} new Reddit post(s) "
        f"(fetched {total_fetched})."
    )
    return total_saved, total_fetched


# ── Step 4b: Bluesky ────────────────────────────────────────────────────────

def _step4b_bluesky(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> tuple[int, int]:
    """Fetch Bluesky posts mentioning the game.  Returns (saved, fetched).

    Fetched counts posts Bluesky returned for this game (duplicates included);
    the run loop uses the per-source total to detect silent-failure regressions
    and to trigger retry-with-backoff (parallel to Reddit) when the total is 0.
    """
    try:
        posts = fetch_bluesky_posts_for_game(game.name, limit=100)
        total_saved = _bulk_save_posts(
            db, game.id, SourceEnum.bluesky, posts, errors,
        )
    except Exception as exc:
        msg = f"[Step 4b] Bluesky error for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return 0, 0
    log_lines.append(
        f"[Step 4b] '{game.name}': {total_saved} new Bluesky post(s) "
        f"(fetched {len(posts)})."
    )
    return total_saved, len(posts)


# ── Step 5: Sentiment Classification ─────────────────────────────────────────

def _step5_classify_sentiment(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> None:
    """
    Batch-classify ALL unprocessed posts for this game.
    Processes any backlog from previous failed runs, not just today's posts.
    """
    unprocessed: list[RawPost] = (
        db.query(RawPost)
        .outerjoin(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
        .filter(
            RawPost.game_id == game.id,
            SentimentRecord.id.is_(None),
        )
        .all()
    )

    if not unprocessed:
        log_lines.append(f"[Step 5] '{game.name}': no unclassified posts.")
        return

    items = [{'title': p.title or '', 'body': p.body or ''} for p in unprocessed]
    try:
        results = classify_batch_with_gate_v2(items)
    except Exception as exc:
        msg = f"[Step 5] Batch classification failed for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return

    for post, result in zip(unprocessed, results):
        label = result["label"]
        score = result["score"]
        db.add(SentimentRecord(
            raw_post_id=post.id,
            sentiment=SentimentEnum(label),
            sentiment_score=score,
            topics=[],
            # §18 audit columns — all populated by PR #10
            signal_quality=result["signal_quality"],
            language=result["language"],
            original_label=result.get("original_label"),
            sentiment_conflict=result.get("sentiment_conflict", False),
            applied_rules=result.get("applied_rules", []),   # §18 Layer 4 lexicon
        ))

    try:
        db.commit()
        log_lines.append(
            f"[Step 5] '{game.name}': classified {len(unprocessed)} post(s)."
        )
    except Exception as exc:
        db.rollback()
        msg = f"[Step 5] Error saving sentiment records for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)


# ── Step 6: Topic Extraction ──────────────────────────────────────────────────

# Critical-mass thresholds (§15)
_CM_MIN_POSTS = 3
_CM_MIN_AUTHORS = 3
_CM_MIN_DAYS = 2


def _step6_extract_topics(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> None:
    """
    Cluster today's posts per sentiment group.

    Now implements:
      §14 — Relevance filter: skip posts that are not substantively about the
              focal game (off-topic, IP/movie references, cross-genre contamination).
      §15 — Critical-mass gate: only surface clusters with ≥3 posts, ≥3 distinct
              authors, and presence on ≥2 distinct days.

    Upserts results into topic_trends and back-fills SentimentRecord.topics.
    """
    today = date.today()
    day_start = datetime.combine(today, datetime.min.time())
    day_end = day_start + timedelta(days=1)

    # Use post_date where available so posts count toward the day they were posted
    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)
    rows: list[tuple[RawPost, SentimentRecord]] = (
        db.query(RawPost, SentimentRecord)
        .join(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
        .filter(
            RawPost.game_id == game.id,
            effective_date >= day_start,
            effective_date < day_end,
        )
        .all()
    )

    if not rows:
        log_lines.append(f"[Step 6] '{game.name}': no posts today (range {day_start} - {day_end}).")
        return

    # ── §14: Relevance filter ────────────────────────────────────────────────
    relevant_rows: list[tuple[RawPost, SentimentRecord]] = []
    filtered_count = 0
    for post, sr in rows:
        if is_post_relevant_to_game(post.title or "", post.body or "", game):
            relevant_rows.append((post, sr))
        else:
            filtered_count += 1

    if filtered_count:
        log_lines.append(
            f"[Step 6] '§14 filter' '{game.name}': "
            f"{filtered_count}/{len(rows)} post(s) excluded as irrelevant today."
        )

    if not relevant_rows:
        log_lines.append(f"[Step 6] '{game.name}': all posts filtered as irrelevant today.")
        return

    # ── Group text + metadata by sentiment ───────────────────────────────────
    # For each sentiment group, collect parallel lists:
    #   texts, author_ids, day_ids
    # so that extract_topics_with_metadata can compute per-cluster metadata.
    grouped_texts: dict[str, list[str]] = {"positive": [], "negative": [], "neutral": []}
    grouped_authors: dict[str, list[str]] = {"positive": [], "negative": [], "neutral": []}
    grouped_days: dict[str, list[str]] = {"positive": [], "negative": [], "neutral": []}

    for post, sr in relevant_rows:
        text = _post_text(post)
        if not text:
            continue
        sentiment_key = sr.sentiment.value
        grouped_texts[sentiment_key].append(text)
        grouped_authors[sentiment_key].append(post.author or "anonymous")
        # Use post_date if available, else collected_at
        effective_dt = post.post_date or post.collected_at
        day_str = effective_dt.date().isoformat() if effective_dt else today.isoformat()
        grouped_days[sentiment_key].append(day_str)

    # ── §15: Extract topics with metadata + critical-mass gate ───────────────
    topics_by_sentiment: dict[str, list[str]] = {}
    for sentiment_label in ("positive", "negative", "neutral"):
        texts = grouped_texts[sentiment_label]
        authors = grouped_authors[sentiment_label]
        days = grouped_days[sentiment_label]
        if not texts:
            continue
        try:
            clusters = extract_topics_with_metadata(texts, authors, days)
        except Exception as exc:
            msg = (
                f"[Step 6] Topic extraction error ({sentiment_label}) "
                f"for '{game.name}': {exc}"
            )
            errors.append(msg)
            logger.error(msg)
            continue

        # Apply critical-mass gate: keep only clusters that pass ALL thresholds
        passed: list[str] = []
        for cluster in clusters:
            pc = cluster["post_count"]
            ac = len(cluster["author_ids"])
            dc = len(cluster["day_set"])
            if pc >= _CM_MIN_POSTS and ac >= _CM_MIN_AUTHORS and dc >= _CM_MIN_DAYS:
                passed.append(cluster["label"])
            else:
                logger.debug(
                    "[Step 6] §15 gate: cluster '%s' (%s) rejected: "
                    "posts=%d authors=%d days=%d",
                    cluster["label"], sentiment_label, pc, ac, dc,
                )

        if passed:
            topics_by_sentiment[sentiment_label] = passed
        else:
            logger.info(
                "[Step 6] §15 gate: no clusters passed for '%s' (%s) today.",
                game.name, sentiment_label,
            )

    if not topics_by_sentiment:
        log_lines.append(
            f"[Step 6] '{game.name}': no clusters passed §15 critical-mass gate today."
        )
        return

    # ── Humanise labels ──────────────────────────────────────────────────────
    try:
        topics_by_sentiment = humanize_topic_labels(game.name, topics_by_sentiment)
    except Exception as exc:
        logger.warning("[Step 6] Topic humanization failed for '%s': %s", game.name, exc)

    # Back-fill top topics onto each SentimentRecord for this game/day
    top_map = {k: v[:5] for k, v in topics_by_sentiment.items()}
    for _, sr in relevant_rows:
        sr.topics = top_map.get(sr.sentiment.value, [])

    # Upsert into topic_trends (includes its own commit)
    try:
        upsert_topic_trends(db, game.id, today, topics_by_sentiment)
    except Exception as exc:
        msg = f"[Step 6] Topic trend upsert failed for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return

    total = sum(len(v) for v in topics_by_sentiment.values())
    log_lines.append(
        f"[Step 6] '{game.name}': {total} topic(s) extracted/updated "
        f"({len(relevant_rows)} relevant posts, {filtered_count} filtered)."
    )

# ── Step 7: Daily Summary ─────────────────────────────────────────────────────

def _step7_daily_summary(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> None:
    """
    Aggregate today's sentiment counts, compute trend delta, and generate the
    AI executive summary + recommended actions.  Upserts one DailySummary row.
    """
    today = date.today()
    day_start = datetime.combine(today, datetime.min.time())
    day_end = day_start + timedelta(days=1)

    # Aggregate counts for today using the post's actual date (post_date for
    # Reddit/forums, collected_at for Steam which has no post_date).
    # Posts always count toward the day they were originally posted.
    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)
    count_rows = (
        db.query(SentimentRecord.sentiment, func.count(SentimentRecord.id))
        .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
        .filter(
            RawPost.game_id == game.id,
            effective_date >= day_start,
            effective_date < day_end,
        )
        .group_by(SentimentRecord.sentiment)
        .all()
    )

    count_map: dict[str, int] = {s.value: c for s, c in count_rows}
    pos = count_map.get("positive", 0)
    neg = count_map.get("negative", 0)
    neu = count_map.get("neutral", 0)
    total = pos + neg + neu

    # ── Zero-new-records path ─────────────────────────────────────────────────
    # Even when no new posts were collected today, write a DailySummary row so
    # the dashboard and summary pages remain visible and don't lose persistence.
    # Carry forward topics from the most recent prior summary so the topic
    # panels are not blank.
    if total == 0:
        prior: Optional[DailySummary] = (
            db.query(DailySummary)
            .filter(
                DailySummary.game_id == game.id,
                DailySummary.summary_date < today,
            )
            .order_by(DailySummary.summary_date.desc())
            .first()
        )
        top_pos_zero = prior.top_positive_topics if prior else []
        top_neg_zero = prior.top_negative_topics if prior else []
        top_neu_zero = prior.top_neutral_topics if prior else []
        prior_date_str = str(prior.summary_date) if prior else "unknown"

        no_data_summary = (
            f"[No new posts collected] No new community posts were ingested for "
            f"{game.name} during today's run. All sentiment metrics and topics "
            f"reflect historical data. Most recent active collection: {prior_date_str}."
        )
        no_data_actions = (
            "[No new posts collected] No new data was available today. "
            "Previous recommended actions remain applicable until new posts are ingested."
        )

        existing_zero: Optional[DailySummary] = (
            db.query(DailySummary)
            .filter_by(game_id=game.id, summary_date=today)
            .first()
        )
        if existing_zero:
            existing_zero.executive_summary = no_data_summary
            existing_zero.recommended_actions = no_data_actions
            existing_zero.top_positive_topics = top_pos_zero
            existing_zero.top_negative_topics = top_neg_zero
            existing_zero.top_neutral_topics = top_neu_zero
        else:
            db.add(DailySummary(
                game_id=game.id,
                summary_date=today,
                positive_count=0,
                negative_count=0,
                neutral_count=0,
                top_positive_topics=top_pos_zero,
                top_negative_topics=top_neg_zero,
                top_neutral_topics=top_neu_zero,
                sentiment_trend_delta=None,
                executive_summary=no_data_summary,
                recommended_actions=no_data_actions,
            ))

        try:
            db.commit()
            log_lines.append(
                f"[Step 7] '{game.name}': no new posts today — "
                f"zero-count summary written (topics carried from {prior_date_str})."
            )
        except Exception as exc:
            db.rollback()
            msg = f"[Step 7] Error saving zero-count summary for '{game.name}': {exc}"
            errors.append(msg)
            logger.error(msg)
        return

    # ── Normal path: new posts were collected today ───────────────────────────

    # Top-5 topics per sentiment — returns (label, trend_direction) tuples so
    # the Claude actions prompt can reference trend context per topic.
    def _top_topics_with_trend(
        sentiment: SentimentEnum, limit: int = 5
    ) -> list[tuple[str, str]]:
        return [
            (t.topic_label, t.trend_direction.value)
            for t in (
                db.query(TopicTrend)
                .filter_by(game_id=game.id, sentiment=sentiment)
                .order_by(TopicTrend.mention_count.desc())
                .limit(limit)
                .all()
            )
        ]

    pos_with_trend = _top_topics_with_trend(SentimentEnum.positive)
    neg_with_trend = _top_topics_with_trend(SentimentEnum.negative)
    neu_with_trend = _top_topics_with_trend(SentimentEnum.neutral)

    # Plain label lists for the executive summary prompt and DB storage
    top_pos = [label for label, _ in pos_with_trend]
    top_neg = [label for label, _ in neg_with_trend]
    top_neu = [label for label, _ in neu_with_trend]

    trend_delta = _compute_trend_delta(db, game.id, today, pos, neg, total)

    # Generate AI text via Claude API (summary_service.py)
    try:
        exec_summary, rec_actions = generate_summaries(
            game_name=game.name,
            top_positive_topics=top_pos,
            top_negative_topics=top_neg,
            top_neutral_topics=top_neu,
            trend_delta=trend_delta,
            total_posts=total,
            positive_with_trend=pos_with_trend,
            negative_with_trend=neg_with_trend,
            neutral_with_trend=neu_with_trend,
        )
    except Exception as exc:
        errors.append(
            f"[Step 7] Summary generation failed for '{game.name}': {exc}"
        )
        exec_summary = ""
        rec_actions = ""

    # Upsert — one row per game per date
    existing: Optional[DailySummary] = (
        db.query(DailySummary)
        .filter_by(game_id=game.id, summary_date=today)
        .first()
    )
    if existing:
        existing.positive_count = pos
        existing.negative_count = neg
        existing.neutral_count = neu
        existing.top_positive_topics = top_pos
        existing.top_negative_topics = top_neg
        existing.top_neutral_topics = top_neu
        existing.sentiment_trend_delta = trend_delta
        existing.executive_summary = exec_summary
        existing.recommended_actions = rec_actions
    else:
        db.add(DailySummary(
            game_id=game.id,
            summary_date=today,
            positive_count=pos,
            negative_count=neg,
            neutral_count=neu,
            top_positive_topics=top_pos,
            top_negative_topics=top_neg,
            top_neutral_topics=top_neu,
            sentiment_trend_delta=trend_delta,
            executive_summary=exec_summary,
            recommended_actions=rec_actions,
        ))

    try:
        db.commit()
        log_lines.append(
            f"[Step 7] '{game.name}': summary saved "
            f"(pos={pos}, neg={neg}, neu={neu}, total={total}, "
            f"delta={f'{trend_delta:+.1%}' if trend_delta is not None else 'N/A'})."
        )
    except Exception as exc:
        db.rollback()
        msg = f"[Step 7] Error saving daily summary for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)


# ── Step 9: Monthly Summaries ────────────────────────────────────────────────

def _step9_monthly_summaries(
    db,
    active_games: list,
    log_lines: list,
    errors: list,
) -> None:
    """
    If today is the 1st of the month, generate monthly summaries for the
    preceding calendar month for all active games. Idempotent due to the
    UNIQUE constraint on (game_id, period_year, period_month).
    """
    today = date.today()
    if today.day != 1:
        return

    # The month that just ended
    first_of_this_month = today
    last_month_end = first_of_this_month - timedelta(days=1)
    year  = last_month_end.year
    month = last_month_end.month

    log_lines.append(
        f"[Step 9] 1st of month — generating monthly summaries for {year}-{month:02d} "        f"across {len(active_games)} game(s)."
    )

    for game in active_games:
        try:
            _pss.generate_monthly_summary(db, game.id, year, month)
            log_lines.append(
                f"[Step 9] Monthly summary generated for '{game.name}' {year}-{month:02d}."
            )
        except Exception as exc:
            msg = (
                f"[Step 9] Monthly summary failed for '{game.name}' "                f"{year}-{month:02d}: {exc}"
            )
            errors.append(msg)
            logger.error(msg)


# ── Step 8: Write Log ─────────────────────────────────────────────────────────

def _step8_write_log(log_lines: list, errors: list) -> None:
    """Append a structured run record to logs/ingest_YYYY-MM-DD.log."""
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = _LOG_DIR / f"ingest_{date.today()}.log"
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    sep = "-" * 60

    with log_file.open("a", encoding="utf-8") as fh:
        fh.write(f"\n{sep}\n")
        fh.write(f"Ingestion run completed: {timestamp}\n")
        fh.write(f"{sep}\n")
        for line in log_lines:
            fh.write(f"  {line}\n")
        if errors:
            fh.write(f"\nERRORS ({len(errors)}):\n")
            for err in errors:
                fh.write(f"  [ERROR] {err}\n")
        fh.write(f"{sep}\n")

    logger.info("Ingestion log written → %s", log_file)


# ── Private helpers ───────────────────────────────────────────────────────────

def _bulk_save_posts(
    db: Session,
    game_id: int,
    source: SourceEnum,
    post_data_list: list[dict],
    errors: list,
) -> int:
    """
    Persist a list of raw-post dicts, skipping any that are already stored.

    Deduplication checks (external_id, source) globally AND per game_id to
    handle Reddit posts shared across multiple games' subreddits.
    Inserts one-by-one to avoid a single duplicate killing the whole batch.

    Returns the count of newly inserted rows.
    """
    if not post_data_list:
        return 0

    external_ids = [p["external_id"] for p in post_data_list]
    # Check for posts already stored globally (any game) with same external_id+source
    known: set[str] = {
        row[0]
        for row in db.query(RawPost.external_id).filter(
            RawPost.external_id.in_(external_ids),
            RawPost.source == source,
        )
    }

    saved = 0
    skipped_due_to_error = 0
    first_error_logged = False
    for pd in post_data_list:
        if pd["external_id"] in known:
            continue
        row = RawPost(
            game_id=game_id,
            source=source,
            external_id=pd["external_id"],
            author=pd.get("author"),
            title=pd.get("title"),
            body=pd.get("body"),
            url=pd.get("url"),
            upvotes=pd.get("upvotes", 0),
            post_date=pd.get("post_date"),
        )
        db.add(row)
        try:
            db.commit()
            known.add(pd["external_id"])  # Track so next game skips it
            saved += 1
        except IntegrityError:
            # Duplicate / unique-constraint hit — expected, swallow silently.
            db.rollback()
            known.add(pd["external_id"])
        except Exception as exc:  # noqa: BLE001
            # Anything else (type mismatch, length overflow, etc.) is a real
            # data quality issue.  Log the FIRST one per call so we don't
            # spam, but make sure it's surfaced — silently swallowing every
            # exception masks bugs like the Bluesky post_date type bug
            # (string vs datetime) that caused PR #17 to land 0 posts.
            db.rollback()
            known.add(pd["external_id"])
            skipped_due_to_error += 1
            if not first_error_logged:
                first_error_logged = True
                logger.warning(
                    "_bulk_save_posts: insert failed for source=%s game_id=%d "
                    "external_id=%s — %s: %s",
                    source.value if hasattr(source, "value") else source,
                    game_id,
                    pd.get("external_id", "")[:80],
                    type(exc).__name__,
                    str(exc)[:300],
                )

    if skipped_due_to_error > 0:
        logger.warning(
            "_bulk_save_posts: %d post(s) skipped due to insert errors "
            "(source=%s game_id=%d). See earlier WARNING for the first cause.",
            skipped_due_to_error,
            source.value if hasattr(source, "value") else source,
            game_id,
        )

    return saved


def _post_text(post: RawPost) -> str:
    """Concatenate title and body into a single NLP input string."""
    return " ".join(
        part for part in (post.title or "", post.body or "") if part
    ).strip()


def _compute_trend_delta(
    db: Session,
    game_id: int,
    today: date,
    pos: int,
    neg: int,
    total: int,
) -> Optional[float]:
    """
    Compute the change in net sentiment score vs the most recent prior summary.

    Net sentiment = (positive_count - negative_count) / total_count.
    Returns None if no prior summary exists or prior total is zero.
    """
    if total == 0:
        return None

    today_net = (pos - neg) / total

    prior: Optional[DailySummary] = (
        db.query(DailySummary)
        .filter(
            DailySummary.game_id == game_id,
            DailySummary.summary_date < today,
        )
        .order_by(DailySummary.summary_date.desc())
        .first()
    )

    if prior is None:
        return None

    prior_total = prior.positive_count + prior.negative_count + prior.neutral_count
    if prior_total == 0:
        return None

    prior_net = (prior.positive_count - prior.negative_count) / prior_total
    return round(today_net - prior_net, 4)
