"""
Source fetch cursor service (v0018, 2026-08-19).

Per-(game_id, source, scope_key) cursors track the newest epoch we've
already fetched from each source, so the daily ingest can pass an
`after=` timestamp to Arctic Shift / Bluesky / DTF instead of blindly
re-pulling the 100 newest posts every day.

Public API:
    read_cursor(db, game_id, source, scope_key) -> Optional[int]
    write_cursor(db, game_id, source, scope_key, epoch) -> None
    compute_after_epoch(cursor_epoch, fallback_days) -> int
    backfill_suppress_cursor_updates() -> context manager

Backfill safety:
    A backfill covering historical dates MUST NOT move the daily cursor
    forward past dates the daily cron hasn't caught up to yet. Otherwise
    the next daily run would skip fresh posts younger than the
    backfill's newest hit. Backfills wrap their fetches in
    `backfill_suppress_cursor_updates()` which sets a thread-local flag
    that write_cursor() checks and skips. This is thread-local (not
    process-global) so a concurrent daily-cron thread on the same
    process can still update cursors normally \u2014 though today the
    _BACKFILL_RUNNING mutex in routers/ingest.py already prevents that
    concurrent case; the thread-local is defense-in-depth.
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from typing import Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session

from models import SourceFetchCursor

logger = logging.getLogger(__name__)


# ─── Backfill suppression flag (thread-local) ──────────────────────────

_state = threading.local()


def _is_backfill_active() -> bool:
    return getattr(_state, "backfill_active", False)


@contextmanager
def backfill_suppress_cursor_updates():
    """Wrap a backfill run so cursor writes are silently skipped.

    Usage:
        with backfill_suppress_cursor_updates():
            _backfill_reddit_for_game(...)  # cursor writes no-op inside

    Nesting is safe: the flag is boolean, so re-entering just re-sets True.
    We only clear it when the OUTERMOST context exits, tracked via a
    depth counter.
    """
    prev = getattr(_state, "depth", 0)
    _state.depth = prev + 1
    _state.backfill_active = True
    try:
        yield
    finally:
        _state.depth -= 1
        if _state.depth <= 0:
            _state.backfill_active = False
            _state.depth = 0


# ─── Cursor CRUD ───────────────────────────────────────────────────────

# Constants
DEFAULT_FALLBACK_DAYS = 2          # 48h — when no cursor exists yet
CURSOR_OVERLAP_BUFFER_S = 48 * 3600  # 48h subtracted from cursor when passing to after=


def _normalize_scope(source: str, scope_key: str) -> str:
    """Canonicalize scope_key so 'r/Gaming' and 'gaming' hash to the
    same cursor row.  Subreddit names are case-insensitive on Reddit but
    Arctic Shift echoes back the exact casing sent; we lower-case them
    to stay collision-safe.
    """
    if source in ("reddit", "reddit_comment"):
        # Strip r/ prefix, trailing slash, whitespace, lowercase.
        s = scope_key.strip().rstrip("/")
        if s.lower().startswith("r/"):
            s = s[2:]
        return s.lower()
    return (scope_key or "").strip()


def read_cursor(
    db: Session,
    game_id: int,
    source: str,
    scope_key: str = "",
) -> Optional[int]:
    """Return the latest last_seen_epoch for this (game, source, scope),
    or None if no cursor exists yet (first-ever fetch)."""
    normalized = _normalize_scope(source, scope_key)
    row = db.query(SourceFetchCursor).filter(
        and_(
            SourceFetchCursor.game_id == game_id,
            SourceFetchCursor.source == source,
            SourceFetchCursor.scope_key == normalized,
        )
    ).first()
    return row.last_seen_epoch if row else None


def write_cursor(
    db: Session,
    game_id: int,
    source: str,
    scope_key: str,
    epoch: int,
) -> None:
    """Upsert a cursor to MAX(new_epoch, existing_cursor).

    Skipped entirely when a backfill context is active (see
    backfill_suppress_cursor_updates() above).  Failures are logged and
    swallowed \u2014 a cursor-write bug must never break the ingest run.

    MAX semantics: a slow clock, a stale API response, or a bug that
    returned an old post as \"newest\" cannot rewind the cursor.  The
    worst case for a MAX write is a spurious no-op.
    """
    if _is_backfill_active():
        logger.debug(
            "cursor: skipping write (backfill active) game_id=%d source=%s scope=%r epoch=%d",
            game_id, source, scope_key, epoch,
        )
        return
    if epoch <= 0:
        # Reject obvious garbage.  Real epochs are ~1.7e9 as of 2026.
        logger.warning(
            "cursor: refusing to write non-positive epoch=%d for game_id=%d source=%s",
            epoch, game_id, source,
        )
        return

    normalized = _normalize_scope(source, scope_key)
    try:
        existing = db.query(SourceFetchCursor).filter(
            and_(
                SourceFetchCursor.game_id == game_id,
                SourceFetchCursor.source == source,
                SourceFetchCursor.scope_key == normalized,
            )
        ).first()
        if existing is None:
            row = SourceFetchCursor(
                game_id=game_id,
                source=source,
                scope_key=normalized,
                last_seen_epoch=epoch,
            )
            db.add(row)
            db.flush()  # surface UNIQUE violations here rather than at commit
        elif epoch > existing.last_seen_epoch:
            existing.last_seen_epoch = epoch
            # last_updated_at auto-refreshes via server_default at row rewrite
            # would require an explicit assignment; do it here for correctness.
            from datetime import datetime, timezone
            existing.last_updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        else:
            # No-op: existing cursor is already >= new epoch.
            logger.debug(
                "cursor: no-op (existing=%d >= new=%d) game_id=%d source=%s scope=%r",
                existing.last_seen_epoch, epoch, game_id, source, normalized,
            )
    except Exception as exc:
        # NEVER let a cursor error abort ingest.  Roll back the cursor
        # write only; the caller's overall session isn't affected because
        # we only did a flush(), and if flush() failed the caller's next
        # commit will surface it as an integrity error anyway.
        logger.exception(
            "cursor: write failed for game_id=%d source=%s scope=%r: %s",
            game_id, source, scope_key, exc,
        )
        db.rollback()


# ─── Read-path helper: compute the after= epoch to pass upstream ──────

def compute_after_epoch(
    cursor_epoch: Optional[int],
    fallback_days: int = DEFAULT_FALLBACK_DAYS,
) -> int:
    """Return the epoch to pass as `after=` to the upstream API.

    Rules:
      * If cursor_epoch is set: return cursor_epoch - CURSOR_OVERLAP_BUFFER_S
        (48h overlap so late-arriving posts still land).
      * If no cursor yet (first fetch for this subreddit/game): return
        now - fallback_days*86400.  For a game freshly added to
        SentimentPulse, this bounds the first daily run to 48h of history
        instead of the source's full backlog \u2014 backfill is the proper
        tool for grabbing history, not daily cron.
      * If cursor - overlap would land before Unix epoch (nonsense), clamp
        at 0.
    """
    if cursor_epoch is not None:
        return max(0, cursor_epoch - CURSOR_OVERLAP_BUFFER_S)
    return max(0, int(time.time()) - fallback_days * 86400)


# ─── Helpers used by ingest step functions ────────────────────────────

def epoch_from_post_dict(post: dict) -> Optional[int]:
    """Return a UTC epoch second from a post dict as normalized by
    services/arctic_shift_service._convert_post etc.  Handles both
    integer epoch fields and datetime objects on the `post_date` key.
    """
    pd = post.get("post_date")
    if pd is None:
        return None
    # Datetime instance (most common shape from _convert_post et al.)
    try:
        if hasattr(pd, "timestamp"):
            return int(pd.timestamp())
    except Exception:
        pass
    # Raw int epoch (Arctic Shift raw dicts sometimes)
    if isinstance(pd, (int, float)):
        return int(pd)
    return None


def newest_epoch_from_posts(posts: list) -> Optional[int]:
    """Return the max epoch across `posts`, or None if the list is empty
    or nothing has a parseable post_date."""
    if not posts:
        return None
    epochs = [e for e in (epoch_from_post_dict(p) for p in posts) if e is not None and e > 0]
    if not epochs:
        return None
    return max(epochs)
