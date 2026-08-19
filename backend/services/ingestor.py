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
    """Return a snapshot of the current ingestion status.

    v0016.13 (2026-08-13): if the in-memory _status was reset by a process
    restart, hydrate the durable fields (last_run_at, last_run_status,
    games_processed, posts_collected) from AppSetting so the UI doesn't
    show 'Never' when the cron actually ran successfully yesterday.
    """
    snapshot = dict(_status)
    if snapshot.get("last_run_at") is None:
        try:
            # SessionLocal already imported at module level. Only new-to-this-scope
            # names imported inline (AppSetting, since it's a rarely-used model).
            from models import AppSetting
            db = SessionLocal()
            try:
                row = db.query(AppSetting).filter_by(key="ingest_last_run_snapshot").first()
                if row and row.value:
                    import json as _json
                    persisted = _json.loads(row.value)
                    # Only overlay durable fields; live-run fields (is_running,
                    # next_run_at) stay from in-memory.
                    for k in ("last_run_at", "last_run_status", "last_run_errors",
                             "games_processed", "posts_collected",
                             "reddit_health", "reddit_fetched_total", "reddit_retries",
                             "bluesky_health", "bluesky_fetched_total", "bluesky_retries",
                             "steam_review_health", "steam_review_fetched_total",
                             "steam_forum_health", "steam_forum_fetched_total"):
                        if k in persisted:
                            snapshot[k] = persisted[k]
            finally:
                db.close()
        except Exception as exc:
            logger.warning("get_status: failed to hydrate from AppSetting: %s", exc)
    return snapshot


def set_next_run(dt: Optional[datetime]) -> None:
    """Called by the scheduler after each run to record the next scheduled time."""
    _status["next_run_at"] = dt.isoformat() if dt else None


# ── Entry point ───────────────────────────────────────────────────────────────

# Maximum time a run is allowed to hold the is_running lock before the
# next scheduled trigger will treat it as stuck and forcibly reclaim.
# Set well above the expected wallclock (30-60 minutes for 32 games) so
# healthy long runs are never interrupted. See run_ingestion() below.
# v0016.15 (2026-08-14): reduced from 2h to 90m. A healthy full ingest
# takes 30-60 min so 90 min is a safe upper bound. False-negatives
# (waiting 2h+ to reclaim) blocked the whole morning of 2026-08-14 when
# a startup import bug caused every run to crash instantly on VADER-
# lightweight mode. The startup smoke test in main.py's lifespan now
# catches that class of bug before the scheduler even starts, so we no
# longer need the 2h grace period.
# 2026-08-19: bumped 90 -> 180 min in tandem with _RUN_WALLCLOCK_BUDGET_S
# below (75 -> 150 min). Invariant: STUCK_RUN_THRESHOLD must exceed the
# outer wallclock budget so a healthy long run is never treated as stuck
# by the next cron trigger. 180 = 150 + 30 min grace — the grace covers
# Phase C (sentiment + topics + daily summary) which runs AFTER Phase A's
# wallclock check and is not budgeted separately.
_STUCK_RUN_THRESHOLD_S = 180 * 60  # 180 minutes

# Maximum wallclock the entire run is allowed to take. Prevents a slow
# source (Steam Forum on a busy game, Reddit backoff cascade, etc.) from
# silently blowing past the daily scheduling boundary. Individual phases
# already have their own budgets; this is the outer safety net.
#
# 2026-08-19: bumped 75 -> 150 min after a 39-active-game run skipped the
# 10 highest-ID games at the 75-min deadline (per _status.last_run_errors:
# "Wallclock budget (4500s) exceeded after 29/39 games"). Portfolio has
# been growing (+3 new games in the last 48h: Aliens: Fireteam Elite 2,
# Twisted Tower, Hot Wheels Unleashed) and per-game fetch time is up
# because HOT WHEELS UNLEASHED has 5 years of Steam Reviews to page.
# The next-run boundary is 24h out (daily cron), so 150 min gives 6x
# headroom vs the last observed longest run (~50 min for 29 games) and
# still finishes 21+ hours before the next scheduled trigger. If we ever
# see a run genuinely near 150 min, that's the signal to switch to
# least-recently-ingested-first iteration (see ingestor todo doc).
# The _STUCK_RUN_THRESHOLD_S above (90m -> stays at 90m) is deliberately
# LOWER than this new budget so a genuinely-hung run still gets reclaimed
# by the next cron trigger even if the intended budget hasn't fired.
# Actually 90m < 150m creates a hazard: a healthy run that legitimately
# uses 100-120 minutes would be treated as stuck by the next trigger.
# Raise _STUCK_RUN_THRESHOLD_S in tandem below to keep the invariant
# STUCK > BUDGET so healthy long runs never get reclaimed mid-flight.
_RUN_WALLCLOCK_BUDGET_S = 150 * 60  # 150 minutes


def _reclaim_stuck_lock_if_needed() -> None:
    """Clear the is_running flag when the previous run is clearly dead.

    A previous run can leave is_running=True forever if the process was
    killed mid-run (SIGKILL / OOM) or hit a native crash the try/finally
    couldn't catch. Without this reclaim, every subsequent scheduled
    trigger bounces at the duplicate-trigger guard and daily ingest
    silently stops working. Signals we treat as "dead":

      * last_run_at is None (should never happen once is_running is
        True, but be defensive).
      * last_run_at is older than _STUCK_RUN_THRESHOLD_S.

    Called at the very top of run_ingestion() BEFORE the is_running guard.
    """
    if not _status["is_running"]:
        return
    last_run_iso = _status.get("last_run_at")
    if not last_run_iso:
        logger.warning(
            "Reclaiming is_running lock: no last_run_at recorded (defensive)."
        )
        _status["is_running"] = False
        return
    try:
        # datetime.fromisoformat handles the trailing +00:00 that we write.
        last_dt = datetime.fromisoformat(last_run_iso)
    except ValueError:
        logger.warning(
            "Reclaiming is_running lock: unparseable last_run_at=%s",
            last_run_iso,
        )
        _status["is_running"] = False
        return
    age_s = (datetime.now(timezone.utc) - last_dt).total_seconds()
    if age_s > _STUCK_RUN_THRESHOLD_S:
        logger.error(
            "Reclaiming is_running lock: previous run has been in-progress "
            "for %.0fs (threshold %ds). Marking prior run as 'error' and "
            "allowing new run to proceed.",
            age_s, _STUCK_RUN_THRESHOLD_S,
        )
        _status["is_running"] = False
        _status["last_run_status"] = "error"
        _status["last_run_errors"] = list(_status.get("last_run_errors") or []) + [
            f"Prior run stuck for {int(age_s)}s; lock forcibly reclaimed."
        ]


# Canonical names for the per-source skip switch. Keep as a frozenset
# so callers can validate input against a known-good set.
_VALID_SKIP_SOURCES = frozenset({"reddit", "bluesky", "steam_review", "steam_forum", "dtf"})


def run_ingestion(skip_sources: Optional[set[str]] = None) -> dict:
    """
    Execute the full ingestion pipeline for all active games.

    Thread-safe: returns immediately if a run is already in progress AND
    the prior run is younger than _STUCK_RUN_THRESHOLD_S. Older stuck
    locks are reclaimed automatically so daily ingest can survive a
    process crash without manual intervention.

    Args:
        skip_sources: Optional set of source names to skip for this run.
            Valid names: 'reddit', 'bluesky', 'steam_review',
            'steam_forum', 'dtf'. Unknown names are silently ignored
            (logged as a warning). Sentiment / topics / summary phases
            (Steps 5-7) always run on whatever was collected.

            Use case: after deploying a fix to a single source, trigger
            a fresh ingest of just that source without redundantly
            re-fetching the others. Dedup handles overlap for free, but
            skipping saves quota + wallclock.

    Returns a summary dict suitable for serialising as a JSON response.
    """
    skip_sources = set(skip_sources or [])
    unknown = skip_sources - _VALID_SKIP_SOURCES
    if unknown:
        logger.warning(
            "run_ingestion: ignoring unknown skip_sources=%s (valid: %s)",
            sorted(unknown), sorted(_VALID_SKIP_SOURCES),
        )
        skip_sources = skip_sources & _VALID_SKIP_SOURCES
    if skip_sources:
        logger.info("run_ingestion: skipping sources=%s this run", sorted(skip_sources))
    _reclaim_stuck_lock_if_needed()

    if _status["is_running"]:
        logger.warning("Ingestion already running — ignoring duplicate trigger.")
        return {"status": "skipped", "reason": "already_running"}

    _status["is_running"] = True
    _status["last_run_at"] = datetime.now(timezone.utc).isoformat()
    # Reset counters so mid-run observers see progress on THIS run, not
    # stale numbers from the prior finally-block write.
    _status["games_processed"] = 0
    _status["posts_collected"] = 0
    _run_started_at = time.monotonic()

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

            # steam_review
            sr_saved, sr_fetched = 0, 0
            if "steam_review" in skip_sources:
                log_lines.append(f"[Step 2] '{game.name}': steam_review skipped (skip_sources)")
            else:
                sr_saved, sr_fetched = _step2_steam_reviews(db, game, log_lines, errors)
                game_posts_local += sr_saved

            # steam_forum
            sf_saved, sf_fetched = 0, 0
            if "steam_forum" in skip_sources:
                log_lines.append(f"[Step 3] '{game.name}': steam_forum skipped (skip_sources)")
            else:
                sf_saved, sf_fetched = _step3_steam_forums(db, game, log_lines, errors)
                game_posts_local += sf_saved

            # reddit
            r_saved, r_fetched = 0, 0
            if "reddit" in skip_sources:
                log_lines.append(f"[Step 4] '{game.name}': reddit skipped (skip_sources)")
            else:
                r_saved, r_fetched = _step4_reddit(db, game, log_lines, errors)
                game_posts_local += r_saved

            # reddit comments (v0016, 2026-08-12): fetch top-N comments on
            # any newly-saved signal/dedicated Reddit submissions. Each
            # comment inherits the parent's tier via override_tier so a
            # comment on a keyword-verified thread is 'signal' even without
            # restating the game name. Scoped narrowly to avoid pulling
            # thousands of comments from noise threads.
            if "reddit_comments" in skip_sources or "reddit" in skip_sources:
                log_lines.append(
                    f"[Step 4a] '{game.name}': reddit_comments skipped (skip_sources)"
                )
            else:
                rc_saved, rc_fetched = _step4a_reddit_comments(
                    db, game, log_lines, errors,
                )
                game_posts_local += rc_saved

            # bluesky
            b_saved = 0
            b_fetched = 0
            if "bluesky" in skip_sources:
                log_lines.append(f"[Step 4b] '{game.name}': bluesky skipped (skip_sources)")
            elif bsky_kill_switch:
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

            # Step 4c: DTF.ru — Russian-language coverage. Only kicks in
            # when the runtime flag is truthy. Two sources of truth,
            # checked in order:
            #   1. AppSetting['dtf_enabled'] — lets operators flip DTF
            #      on/off via the API without SSHing to the droplet or
            #      redeploying, matching the digest-skip pattern.
            #   2. Env var DTF_ENABLED — fallback for local dev.
            # Disabled by default so existing pipelines aren't affected
            # until we're happy with the audit numbers (2026-07-26 launch).
            d_saved, d_fetched = 0, 0
            if "dtf" in skip_sources:
                log_lines.append(f"[Step 4c] '{game.name}': dtf skipped (skip_sources)")
            elif _dtf_enabled(db):
                d_saved, d_fetched = _step4c_dtf(db, game, log_lines, errors)
                game_posts_local += d_saved
            else:
                log_lines.append(
                    f"[Step 4c] '{game.name}': DTF disabled (dtf_enabled flag unset)"
                )

            return game_posts_local, r_fetched, b_fetched, sr_fetched, sf_fetched, d_fetched

        # ── Phase A: fetch sources (Steps 2 -> 4c) for every active game ────────
        dtf_fetched_total = 0
        for i, game in enumerate(active_games, start=1):
            # Outer wallclock safety net: if the run has already blown past
            # _RUN_WALLCLOCK_BUDGET_S, skip remaining games so we still get
            # to Phase C (sentiment/topics/summaries) on whatever data we
            # collected before the deadline. Better a partial success with
            # summaries computed than an indefinite hang.
            if time.monotonic() - _run_started_at > _RUN_WALLCLOCK_BUDGET_S:
                remaining = len(active_games) - (i - 1)
                msg = (
                    f"[Phase A] Wallclock budget "
                    f"({_RUN_WALLCLOCK_BUDGET_S}s) exceeded after "
                    f"{i - 1}/{len(active_games)} games; skipping remaining "
                    f"{remaining} game(s) and jumping to Phase C."
                )
                errors.append(msg)
                logger.error(msg)
                log_lines.append(msg)
                break

            try:
                (game_posts, r_f, b_f, sr_f, sf_f, d_f) = _safe_run_steps_2_to_4b(game)
                per_game_posts[game.id] = per_game_posts.get(game.id, 0) + game_posts
                reddit_fetched_total += r_f
                bluesky_fetched_total += b_f
                steam_review_fetched_total += sr_f
                steam_forum_fetched_total += sf_f
                dtf_fetched_total += d_f
            except Exception as exc:
                msg = f"Unhandled error processing game '{game.name}': {exc}"
                errors.append(msg)
                logger.exception(msg)
                # Continue with next game - never abort the whole pipeline

            # Heartbeat: update the live status counters after every game
            # so operators (and health probes) can see the run is making
            # progress. Prior to this write the counters only updated in
            # the finally block, so a mid-run stall looked identical to a
            # never-started run.
            _status["games_processed"] = i
            _status["posts_collected"] = sum(per_game_posts.values())
            _status["reddit_fetched_total"] = reddit_fetched_total
            _status["bluesky_fetched_total"] = bluesky_fetched_total
            _status["steam_review_fetched_total"] = steam_review_fetched_total
            _status["steam_forum_fetched_total"] = steam_forum_fetched_total

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
        # ── #2: surface Bluesky auth failures distinctly ──────────────────────
        # If we fetched 0 because our session couldn't authenticate, that's
        # operator-actionable (creds/account state) — not the same as the
        # upstream being temporarily quiet.  Read the singleton session's
        # auth_health and upgrade the verdict accordingly.  Auth health takes
        # precedence over fetched-count-based verdicts because a broken
        # session would also produce fetched=0.
        if bluesky_eligible:
            try:
                from services.bluesky_service import get_auth_health as _bsky_auth_health
                bsky_auth = _bsky_auth_health()
                if bsky_auth in ("refresh_failed", "create_failed"):
                    bluesky_health = "auth_broken"
                    log_lines.append(
                        f"[Step 4b] Bluesky auth_health={bsky_auth} — marking "
                        f"bluesky_health=auth_broken (operator action likely required: "
                        f"verify BLUESKY_APP_PASSWORD / account state)."
                    )
            except Exception as exc:
                # Never let an auth-health probe crash the run.
                logger.exception(f"Bluesky auth_health probe failed: {exc}")
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

        # ── #4: cron-end auto-recovery for Bluesky ─────────────────────────
        # If Bluesky landed in 'failed' (0 fetches after backoff retries) but
        # auth_health didn't explicitly say broken, do ONE more attempt with
        # a forced fresh createSession.  Same-day recovery beats waiting for
        # tomorrow's cron.  Skipped when:
        #   • health is already 'auth_broken'  (creds are bad, no point retrying)
        #   • health is 'ok'/'degraded'/'silent' (already recovered or not
        #     a fetch-zero situation)
        if (
            bluesky_eligible
            and bluesky_health == "failed"
            and active_games
        ):
            log_lines.append(
                "[Step 4b auto-recovery] bluesky_health=failed; forcing fresh "
                "createSession + one final retry across all eligible games."
            )
            try:
                from services.bluesky_service import force_session_recreate
                recreated = force_session_recreate()
                if not recreated:
                    log_lines.append(
                        "[Step 4b auto-recovery] force_session_recreate() "
                        "failed — marking bluesky_health=auth_broken."
                    )
                    bluesky_health = "auth_broken"
                else:
                    recovery_saved = 0
                    recovery_fetched = 0
                    for game in active_games:
                        try:
                            saved, fetched = _step4b_bluesky(
                                db, game, log_lines, errors
                            )
                            recovery_saved += saved
                            recovery_fetched += fetched
                        except Exception as exc:
                            logger.exception(
                                f"Bluesky auto-recovery for {game.name}: {exc}"
                            )
                    posts_collected += recovery_saved
                    bluesky_fetched_total += recovery_fetched
                    log_lines.append(
                        f"[Step 4b auto-recovery] recovered {recovery_saved} "
                        f"saved / {recovery_fetched} fetched."
                    )
                    # Re-evaluate health with the recovery pass counted.
                    bluesky_retries += 1
                    bluesky_health = _verdict(
                        bluesky_eligible, bluesky_fetched_total, bluesky_retries
                    )
            except Exception as exc:
                # Auto-recovery is best-effort; never let it crash the run.
                logger.exception(f"Bluesky auto-recovery failed: {exc}")
                log_lines.append(
                    f"[Step 4b auto-recovery] raised — {exc}"
                )

        # Phase C: per-game analysis (Steps 5 -> 7)
        # Runs AFTER any retries so today's summary includes all data that
        # landed today — not just the first-pass results.
        #
        # v0016.14 (2026-08-13): commit after EACH game's Step 5-7 completes
        # so a mid-run process kill (deploy, OOM, SIGKILL) doesn't lose the
        # classification work done for earlier games. Before this change,
        # if the process died at game #15/34, all 15 games' Step 5 work
        # was pending on the outer db.commit at run end and lost. Now each
        # game's classifications persist as soon as they're computed —
        # verified after Steve reported 5,000+ unclassified reddit_comments
        # across 10 priority games on 2026-08-13 following a burst of
        # concurrent deploys mid-cron.
        for game in active_games:
            try:
                _step5_classify_sentiment(db, game, log_lines, errors)
                _step6_extract_topics(db, game, log_lines, errors)
                _step7_daily_summary(db, game, log_lines, errors)
                db.commit()  # persist this game's work before moving to next
                games_processed += 1
                posts_collected += per_game_posts.get(game.id, 0)
            except Exception as exc:
                db.rollback()
                msg = f"Steps 5-7 error for '{game.name}': {exc}"
                errors.append(msg)
                logger.exception(msg)

        # v0016.14 safety net (2026-08-13): after all games finish, do ONE
        # more sweep across active_games for any RawPost that's still
        # is_relevant=NULL. This catches the case where a game's Step 5
        # was interrupted mid-batch by an exception in the classifier.
        # It's cheap — Step 5 exits early if unprocessed is empty.
        for game in active_games:
            try:
                _step5_classify_sentiment(db, game, log_lines, errors)
                db.commit()
            except Exception as exc:
                db.rollback()
                logger.warning(
                    "Step 5 sweep for '%s' raised — %s", game.name, exc,
                )

        # Step 9: Monthly summaries on 1st of month
        _step9_monthly_summaries(db, active_games, log_lines, errors)

        # Final status precedence:
        #   error  >  partial_failure  >  partial  >  success
        # partial_failure fires if ANY source is in a failure-class verdict.
        # auth_broken counts as failure-class because the operator must
        # intervene (rotate app password, re-auth account, etc.).
        FAILURE_VERDICTS = ("failed", "auth_broken")
        failed_sources = [
            f"{name} ({health})" for name, health in (
                ("Reddit", reddit_health),
                ("Bluesky", bluesky_health),
                ("Steam reviews", steam_review_health),
                ("Steam forums", steam_forum_health),
            ) if health in FAILURE_VERDICTS
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

        # v0016.13 (2026-08-13): persist the snapshot to AppSetting so it
        # survives process restarts. Without this, the UI shows 'Never /
        # Last run: Never' whenever the droplet restarts after the daily
        # cron completed — which happens frequently during deploys.
        try:
            # NOTE: SessionLocal already imported at module level (line 35).
            # Re-importing here caused UnboundLocalError on line 294 because
            # Python treats `from X import Y` inside a function as a local
            # binding for the ENTIRE function scope — shadowing the module-
            # level import even before this statement runs. Verified 2026-08-14.
            from models import AppSetting
            import json as _json
            snapshot_json = _json.dumps({
                "last_run_at": _status.get("last_run_at"),
                "last_run_status": _status.get("last_run_status"),
                "last_run_errors": _status.get("last_run_errors") or [],
                "games_processed": _status.get("games_processed"),
                "posts_collected": _status.get("posts_collected"),
                "reddit_health": _status.get("reddit_health"),
                "reddit_fetched_total": _status.get("reddit_fetched_total"),
                "reddit_retries": _status.get("reddit_retries"),
                "bluesky_health": _status.get("bluesky_health"),
                "bluesky_fetched_total": _status.get("bluesky_fetched_total"),
                "bluesky_retries": _status.get("bluesky_retries"),
                "steam_review_health": _status.get("steam_review_health"),
                "steam_review_fetched_total": _status.get("steam_review_fetched_total"),
                "steam_forum_health": _status.get("steam_forum_health"),
                "steam_forum_fetched_total": _status.get("steam_forum_fetched_total"),
            })
            db_snap = SessionLocal()
            try:
                row = db_snap.query(AppSetting).filter_by(key="ingest_last_run_snapshot").first()
                if row is None:
                    row = AppSetting(key="ingest_last_run_snapshot", value=snapshot_json)
                    db_snap.add(row)
                else:
                    row.value = snapshot_json
                db_snap.commit()
            finally:
                db_snap.close()
        except Exception as exc:
            logger.warning("failed to persist ingest status snapshot: %s", exc)

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
        # v5 (2026-07-28): daily ingest walks Steam forum listing pages
        # AND per-thread comment pagination (via since_epoch cutoff),
        # with a per-game wallclock budget so no single stale forum can
        # eat the whole daily run. See scrape_forum_threads v4 for the
        # listing short-circuit + skip-if-stale behavior that makes this
        # budget realistic.
        # since_epoch = 2 days ago — wide enough to cover overnight
        # ingest gaps and late replies without walking ancient history.
        # _bulk_save_posts dedupes on external_id so re-scraping is free.
        import time as _t
        _since_epoch = int(_t.time()) - 2 * 24 * 3600  # last 48h
        # Per-game budget: 90s covers a typical fresh forum (10-30 hot
        # threads at ~2-3s/each) with headroom, and hard-stops a runaway
        # walk before it starves the next game in the queue.
        posts = scrape_forum_threads(
            game.steam_app_id,
            max_threads=200,
            max_pages=15,
            since_epoch=_since_epoch,
            wallclock_budget_s=90,
        )
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
            # limit=100 is Arctic Shift's hard ceiling per request (verified
            # 2026-07-28 — 200+ returns 400 Bad Request). Was 25; bumped for
            # two reasons:
            #   1. Coverage. limit=25 on a busy general sub like r/pcgaming
            #      only reaches ~10 hours back — leaving a hole if a daily
            #      run is delayed. limit=100 covers ~38 hours on the same
            #      sub, and multi-day windows on quieter game-specific
            #      subs (SnowRunner ~3.7d, HalloweenTVG ~20d).
            #   2. Cost is effectively identical (0.98s vs 0.79s per
            #      request; parse+network dominates). _bulk_save_posts
            #      dedupes on external_id so overlap with yesterday's
            #      pull is free.
            submissions = fetch_subreddit_posts(sub_name, limit=100, game_name=game.name)
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


# ── Step 4a: Reddit Comments (v0016, 2026-08-12) ─────────────────────────
#
# Fetches top comments on any newly-ingested Reddit submissions that were
# tagged 'signal' or 'dedicated_sub'. Each comment inherits the parent
# thread's relevance_tier + matched_keywords — solving the case where
# comment sentiment on a game-relevant thread is invisible because the
# comment text doesn't restate the game name (e.g. 'the puzzle box is
# sick' on a Hellraiser Revival gameplay thread on r/PS5).
#
# Scoping decisions:
#   * Only fetch comments for signal + dedicated_sub parents. Noise threads
#     don't earn comment ingestion — keeps cost + noise low.
#   * Only fetch for parents from the LAST 3 DAYS. Older threads generally
#     have stable comment counts; we optimize for recency and compounding.
#   * Cap comments per parent at 100 (Arctic Shift's limit ceiling).

def _step4a_reddit_comments(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> tuple[int, int]:
    """Fetch and store Reddit comments for recent signal/dedicated parents.

    Returns:
        (saved, fetched) — saved is new comment rows inserted;
        fetched is total comments returned by Arctic Shift across all parents.
    """
    # datetime, timezone, timedelta already imported at module level.
    # DO NOT re-import inside a function — Python treats function-scoped
    # `from X import Y` as a local binding for the ENTIRE function, which
    # shadows the module-level import even before this line runs. See
    # 2026-08-14 bug report on SessionLocal shadowing in run_ingestion.
    from services.arctic_shift_service import fetch_arctic_shift_comments

    cutoff = datetime.now(timezone.utc) - timedelta(days=3)
    # v0016.1 (2026-08-12): order by post_date so recent Reddit discussion
    # ranks above recently-ingested-but-older archive imports. Fall back to
    # collected_at when a row is missing post_date.
    from sqlalchemy import func as _func, desc as _desc
    parents = (
        db.query(RawPost)
        .filter(
            RawPost.game_id == game.id,
            RawPost.source == SourceEnum.reddit,
            RawPost.relevance_tier.in_(("signal", "dedicated_sub")),
            RawPost.collected_at >= cutoff,
        )
        .order_by(_desc(_func.coalesce(RawPost.post_date, RawPost.collected_at)))
        .limit(50)
        .all()
    )

    if not parents:
        log_lines.append(
            f"[Step 4a] '{game.name}': no signal/dedicated parents in last 3 days — skipping."
        )
        return 0, 0

    total_saved = 0
    total_fetched = 0
    for parent in parents:
        permalink = None
        if parent.url and "reddit.com" in parent.url:
            try:
                permalink = "/" + parent.url.split("reddit.com/", 1)[1]
            except IndexError:
                permalink = None

        try:
            comments = fetch_arctic_shift_comments(
                parent_external_id=parent.external_id,
                parent_permalink=permalink,
                limit=100,
            )
        except Exception as exc:
            msg = f"[Step 4a] fetch failed for parent={parent.external_id}: {exc}"
            errors.append(msg)
            logger.warning(msg)
            continue

        if not comments:
            continue
        total_fetched += len(comments)

        for c in comments:
            c["parent_external_id"] = parent.external_id
            c["override_tier"] = parent.relevance_tier
            c["override_matched_keywords"] = parent.matched_keywords or []

        saved = _bulk_save_posts(
            db, game.id, SourceEnum.reddit_comment, comments, errors,
        )
        total_saved += saved

    log_lines.append(
        f"[Step 4a] '{game.name}': {total_saved} new comment(s) across "
        f"{len(parents)} parent thread(s) (fetched {total_fetched})."
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
        # Pass game.distinctive_keywords so Bluesky's query AND post-fetch
        # filter use game-specific terms. Critical for games whose title
        # is a common English word (Docked, Inversion, TimeShift) or a
        # common phrase ("A Quiet Place"). Fallback to title-based when
        # distinctive_keywords is empty/null.
        posts = fetch_bluesky_posts_for_game(
            game.name,
            limit=100,
            distinctive_keywords=game.distinctive_keywords,
        )
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


# ── Step 4c: DTF.ru (Russian-language gaming forum) ─────────────────────
def _dtf_enabled(db: Session) -> bool:
    """Return True iff the DTF ingestion path should be exercised.

    Checks AppSetting['dtf_enabled'] first (so operators can flip via the
    /api/dtf/toggle endpoint without SSH), then falls back to env var
    DTF_ENABLED for local development.
    """
    try:
        from models import AppSetting  # noqa: PLC0415
        row = db.query(AppSetting).filter_by(key="dtf_enabled").first()
        if row and row.value:
            return row.value.strip().lower() in {"1", "true", "yes", "on"}
    except Exception:
        # If the DB is unreachable / migration hasn't run, fall through
        # to env var without erroring out the whole ingestion.
        pass
    return os.getenv("DTF_ENABLED", "false").lower() in {"1", "true", "yes"}



def _step4c_dtf(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> tuple[int, int]:
    """Search DTF.ru for entries mentioning the game and save new ones.

    Added 2026-07-26: our English-only sub monitoring was systematically
    undercounting Russian-language ILL discussion (Team Clout is a
    Russian-origin studio, Mundfish is Russian/Cypriot). DTF.ru is the
    primary Russian-language gaming forum where this discussion lives.

    Search strategy:
      * We hit DTF's global search with the game name as the primary
        query. DTF's index picks up both Cyrillic and Latin references
        that mention the exact game name, which for Team Clout titles
        is usually written in Latin even in Russian-language articles
        ("ILL от Team Clout" → hit on "ILL").
      * For non-Latin-safe games we could add per-game Russian aliases
        later via game.distinctive_keywords — the relevance gate downstream
        does the final filtering, so it's safe to over-include here.

    Returns:
        (saved, fetched) tuple with the same semantics as Steps 4 / 4b.
    """
    # Import lazily so the module stays importable even if DTF service
    # ends up disabled behind a feature flag later.
    from services.dtf_service import fetch_dtf_posts  # noqa: PLC0415

    try:
        posts = fetch_dtf_posts(query=game.name, game_name=game.name, limit=100)
        total_saved = _bulk_save_posts(
            db, game.id, SourceEnum.dtf, posts, errors,
        )
    except Exception as exc:
        msg = f"[Step 4c] DTF error for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return 0, 0
    log_lines.append(
        f"[Step 4c] '{game.name}': {total_saved} new DTF post(s) "
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
    Batch-classify unprocessed posts for this game.
    Processes any backlog from previous failed runs, not just today's posts.

    v2 relevance gate (2026-07-24): the §14 relevance filter now runs HERE,
    BEFORE classification — not in Step 6 (topic extraction) as before. Off-
    topic posts never get a SentimentRecord created, so they can never count
    toward dashboard aggregates. See code_plan.md §1 for the full rationale.
    """
    unprocessed: list[RawPost] = (
        db.query(RawPost)
        .outerjoin(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
        .filter(
            RawPost.game_id == game.id,
            SentimentRecord.id.is_(None),
            RawPost.is_relevant.is_(None),   # not yet gated
        )
        .all()
    )

    if not unprocessed:
        log_lines.append(f"[Step 5] '{game.name}': no unclassified posts.")
        return

    # ── Relevance gate — runs BEFORE classification, not after ────────────────
    # Source-aware admission: Steam Reviews and Steam Forum posts live on
    # the game's own Steam store page, so their audience is definitionally
    # players and buyers of THIS game — no franchise/dictionary noise is
    # possible the way it is on cross-cutting Reddit + Bluesky feeds. They
    # bypass the relevance gate (2026-07-25 rule) and are auto-admitted.
    # Reddit and Bluesky still run through the full keyword + fast-path +
    # fuzzy layer.
    #
    # v0016.2 (2026-08-12): Reddit COMMENTS are also auto-admitted. Comments
    # on a keyword-verified parent thread are by construction on-topic — the
    # parent already matched game keywords, and comments discuss that same
    # thread. Applying the §14 title/body keyword gate to comments would
    # filter out 90%+ (comments say 'looks great' or 'RE vibes' without
    # restating the game name), which is the exact bug Steve flagged.
    _AUTO_ADMIT_SOURCES = {
        SourceEnum.steam_review,
        SourceEnum.steam_forum,
        SourceEnum.reddit_comment,
    }
    relevant_posts: list[RawPost] = []
    irrelevant_posts: list[RawPost] = []
    for post in unprocessed:
        if post.source in _AUTO_ADMIT_SOURCES:
            relevant_posts.append(post)
            continue
        # v0016.6 (2026-08-12, Steve backfill investigation): trust the v3
        # relevance tagger's per-row verdict. Any RawPost the tagger marked
        # 'signal' (bluesky/dtf query hit, reddit general-sub keyword match)
        # or 'dedicated_sub' (reddit post from a game-specific subreddit) is
        # already known to be on-topic — the tagger has full context Step 5's
        # is_post_relevant_to_game() gate can't see (subreddit identity,
        # parent thread linkage, source-search intent). Only 'noise' (broad
        # general-sub post that didn't match any keyword) still runs through
        # the keyword-gate as a second safety net.
        #
        # Before this fix, Step 5 was throwing out ~97% of SM2's Reddit
        # submissions from r/Spacemarine because the body text didn't
        # restate 'space marine 2' — defeating the tier system.
        if post.relevance_tier in ("signal", "dedicated_sub"):
            relevant_posts.append(post)
            continue
        if is_post_relevant_to_game(post.title or "", post.body or "", game):
            relevant_posts.append(post)
        else:
            irrelevant_posts.append(post)
            logger.debug(
                "[Step5-Filter] post_id=%s game=%s title=%s",
                post.id, game.name, (post.title or "")[:60],
            )

    relevant_count = len(relevant_posts)
    irrelevant_count = len(irrelevant_posts)
    log_lines.append(
        f"[Step 5] '{game.name}': {relevant_count} relevant, "
        f"{irrelevant_count} filtered as off-topic"
    )

    # Mark filtered posts so they're never re-evaluated on subsequent runs and
    # never picked up by Step 6 either. No SentimentRecord is created for them.
    for post in irrelevant_posts:
        post.is_relevant = False

    if not relevant_posts:
        try:
            db.commit()  # persist the is_relevant=False marks even if nothing passed
        except Exception as exc:
            db.rollback()
            msg = f"[Step 5] Error saving relevance marks for '{game.name}': {exc}"
            errors.append(msg)
            logger.error(msg)
            return
        log_lines.append(f"[Step 5] '{game.name}': all posts filtered; nothing to classify.")
        return

    items = [{'title': p.title or '', 'body': p.body or ''} for p in relevant_posts]
    try:
        results = classify_batch_with_gate_v2(items)
    except Exception as exc:
        msg = f"[Step 5] Batch classification failed for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return

    # 2026-07-29: Steam Review hard rule (settings.sentiment_steam_use_voted_up).
    # When a RawPost is a Steam Review AND has a non-null voted_up flag,
    # its sentiment is set from the vote (positive/negative, never neutral)
    # — the reviewer's own thumbs is ground truth, model output ignored.
    # This dramatically improves Steam Review signal (audit showed 87.7%
    # of reviews were mistakenly tagged neutral because they're
    # short/medium-signal). We keep the audit fields to record what the
    # model would have said, tagged with an applied_rule for traceability.
    from config import settings as _settings  # noqa: PLC0415
    for post, result in zip(relevant_posts, results):
        # Hard-rule override for Steam Reviews with known vote
        if (
            _settings.sentiment_steam_use_voted_up
            and post.source == SourceEnum.steam_review
            and post.voted_up is not None
        ):
            label = "positive" if post.voted_up else "negative"
            # Confidence 1.0 — this is ground truth from the reviewer.
            score = 1.0
            # Preserve the model output in the audit columns so we can
            # review agreement/disagreement rates later.
            original_label = result["label"]
            original_score = result["score"]
            applied_rules = list(result.get("applied_rules") or [])
            applied_rules.append("STEAM_REVIEW_VOTED_UP_HARD_RULE")
        else:
            label = result["label"]
            score = result["score"]
            original_label = result.get("original_label")
            original_score = result.get("original_score")
            applied_rules = result.get("applied_rules", [])

        # 2026-08-18 (Steve's feedback on Turok / SM2 contamination):
        # Reddit comments on a verified-parent thread are auto-admitted
        # so short reactions don't get lost ("yep", "same here", "fixed
        # it for me"). But long off-topic drift comments on the same
        # thread — hardware complaints about the Steam Deck itself,
        # cross-game essays, generic-gaming philosophy — were landing
        # as positive/negative sentiment and moving the pos/neg needle
        # for the wrong reasons.
        #
        # Fix: keep the comment in the corpus (no volume loss for
        # engagement/thread completeness), but if it fails the
        # "focused on this game" check, override the final sentiment
        # to `neutral` so it doesn't skew feedback signal. The model's
        # original verdict is preserved in original_label / original_score
        # and the override is tagged with an applied_rule for audit.
        #
        # See services/post_relevance.py::is_comment_focused_on_game
        # for the decision tree (keyword match / short reply / game-aspect
        # + opinion). Only runs for source=reddit_comment.
        if post.source == SourceEnum.reddit_comment:
            from services.post_relevance import is_comment_focused_on_game  # noqa: PLC0415
            if not is_comment_focused_on_game(post.body or "", game):
                # Preserve the model's verdict for audit before overriding.
                if original_label is None:
                    original_label = label
                if original_score is None:
                    original_score = score
                label = "neutral"
                # Confidence unchanged: this is a policy override, not
                # a re-classification. Downstream tooling can spot the
                # rule tag if it needs to distinguish model-neutral from
                # override-neutral.
                applied_rules = list(applied_rules) if applied_rules else []
                applied_rules.append(
                    "FORCED_NEUTRAL_OFFTOPIC_COMMENT_ON_VERIFIED_PARENT"
                )
                # v0017 (2026-08-18): mark the RawPost itself as
                # off-topic drift. This is the primary flag every
                # sentiment-metric read path filters on (KPI cards,
                # net-sentiment trend, top topics, feedback synth,
                # period summary). The forced-neutral sentiment above
                # is belt-and-suspenders — the boolean is what the
                # dashboard actually reads.
                post.is_off_topic_drift = True

        post.is_relevant = True
        db.add(SentimentRecord(
            raw_post_id=post.id,
            sentiment=SentimentEnum(label),
            sentiment_score=score,
            topics=[],
            # §18 audit columns — all populated by PR #10
            signal_quality=result["signal_quality"],
            language=result["language"],
            original_label=original_label,
            original_score=original_score,
            sentiment_conflict=result.get("sentiment_conflict", False),
            applied_rules=applied_rules,
        ))

    try:
        db.commit()
        log_lines.append(
            f"[Step 5] '{game.name}': classified {len(relevant_posts)} post(s) "
            f"({irrelevant_count} filtered as irrelevant)."
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
# _CM_MIN_DAYS is intentionally 1 for Step 6, not 2.
#
# Step 6 extracts topic clusters from ONLY today's posts (see the
# day_start/day_end filter above). Every cluster produced here can, by
# construction, appear on at most one distinct day — today. If we set
# this to 2, the gate is mathematically unsatisfiable and NO topics
# ever get written back to SentimentRecord.topics or DailySummary. That
# was the 2026-08-05 top-topics-blank regression: every dashboard
# showed empty topic lists because Step 6 was silently rejecting every
# cluster it produced.
#
# The "topic must persist across multiple days to matter" semantic
# still holds, but it's enforced at the ranking layer, not extraction.
# The dashboard's _weighted_daily_top aggregates DailySummary rows
# across the selected period and weights topics by rank-and-day
# appearances — so a one-off single-day flash-in-the-pan cluster
# naturally ranks below a topic that appears in the top-5 across many
# consecutive days. The Summary page uses the same aggregation. Both
# are period-scoped and multi-day by construction.
_CM_MIN_DAYS = 1


def _step6_extract_topics(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
    target_day: Optional[date] = None,
) -> None:
    """
    Cluster today's posts per sentiment group.

    `target_day` defaults to today (normal daily-ingest behavior). The
    topic-backfill script passes an explicit historical date so we can
    rebuild topics for days that had the `_CM_MIN_DAYS=2` bug-suppressed.

    Now implements:
      §15 — Critical-mass gate: only surface clusters with ≥3 posts, ≥3 distinct
              authors, and presence on ≥2 distinct days.

    v2 relevance gate (2026-07-24): the §14 relevance filter no longer runs
    here. It runs once, in Step 5 (_step5_classify_sentiment), BEFORE
    classification. Every RawPost joined to a SentimentRecord here is
    ALREADY relevant by construction — irrelevant posts never get a
    SentimentRecord created for them.

    Upserts results into topic_trends and back-fills SentimentRecord.topics.
    """
    # `target_day` defaults to today (normal daily-ingest behavior). The
    # topic-backfill endpoint passes an explicit historical date so we can
    # rebuild topics for days that had `_CM_MIN_DAYS=2` bug-suppressed.
    today = target_day if target_day is not None else date.today()
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

    # ── Group text + metadata by sentiment ───────────────────────────────────
    # For each sentiment group, collect parallel lists:
    #   texts, author_ids, day_ids
    # so that extract_topics_with_metadata can compute per-cluster metadata.
    grouped_texts: dict[str, list[str]] = {"positive": [], "negative": [], "neutral": []}
    grouped_authors: dict[str, list[str]] = {"positive": [], "negative": [], "neutral": []}
    grouped_days: dict[str, list[str]] = {"positive": [], "negative": [], "neutral": []}

    for post, sr in rows:
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
    for _, sr in rows:
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
        f"({len(rows)} post(s), already relevance-gated in Step 5)."
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
            # v0017 (2026-08-18): DailySummary counts feed the dashboard
            # KPI cards (via period_summary_service) — exclude drift so
            # daily counts stay consistent with the KPI + trend + topic
            # queries in routers/dashboard.py.
            RawPost.is_off_topic_drift.is_(False),
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

    v3 relevance tagging (2026-08-12): every row is tagged with
    relevance_tier + matched_keywords via services.relevance_tagger. Posts
    from broad-genre subs that don't mention the game's keywords are saved
    as relevance_tier='noise' so analytics can exclude them while auditors
    can still inspect the full stream.

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

    # Load the game once so we can build the keyword list a single time
    # per batch (not per-post). Safe to defer import to keep module
    # top-level lightweight.
    from services.relevance_tagger import build_keywords_for_game, tag_post
    game = db.query(Game).filter(Game.id == game_id).first()
    keywords = build_keywords_for_game(game) if game else []

    saved = 0
    skipped_due_to_error = 0
    first_error_logged = False
    for pd in post_data_list:
        if pd["external_id"] in known:
            continue
        # v0016 (2026-08-12): callers can pre-compute relevance for a row and
        # pass it via 'override_tier' + 'override_matched_keywords'. Used by
        # the reddit_comment step to inherit the parent thread's tier so a
        # comment on a signal Hellraiser thread is signal even if the comment
        # text doesn't repeat the game name. Falls back to tag_post() when
        # not overridden.
        if "override_tier" in pd:
            relevance_tier = pd["override_tier"]
            matched_keywords = pd.get("override_matched_keywords") or []
        else:
            relevance_tier, matched_keywords = tag_post(
                source=source,
                url=pd.get("url"),
                title=pd.get("title"),
                body=pd.get("body"),
                keywords=keywords,
            )
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
            # Steam Reviews ground-truth vote (2026-07-29, migration 0014).
            # None for all non-Steam-Review sources.
            voted_up=pd.get("voted_up"),
            # v3 relevance tagging (2026-08-12, migration 0015).
            relevance_tier=relevance_tier,
            matched_keywords=matched_keywords,
            # v0016 (2026-08-12): parent thread linkage for reddit_comment.
            parent_external_id=pd.get("parent_external_id"),
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
