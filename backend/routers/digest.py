"""
Digest router (all under /api/digest):

  GET    /api/digest/recipients         — list configured email recipients
  POST   /api/digest/recipients         — add a new recipient
  DELETE /api/digest/recipients/{id}    — remove a recipient
  PATCH  /api/digest/recipients/{id}    — toggle is_active

  GET    /api/digest/preview/weekly     — render the weekly digest HTML (cache-first, non-blocking)
  GET    /api/digest/preview/monthly    — render the monthly digest HTML (no send)
  GET    /api/digest/preview/weekly/status — JSON status for cache-first preview
  POST   /api/digest/send/weekly        — send the weekly digest NOW (operator action)
  POST   /api/digest/send/monthly       — send the monthly digest NOW (operator action)
  POST   /api/digest/prewarm/weekly     — prewarm WindowSummary cache for current anchor Sun

  GET    /api/digest/skip                — read current skip-until timestamps
  POST   /api/digest/skip                — defer next weekly/monthly digest
  DELETE /api/digest/skip                — clear a skip-until flag
"""
import logging
import re
import threading
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import AppSetting, DigestRecipient
from schemas import DigestRecipientCreate, DigestRecipientResponse
from services import digest_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/digest", tags=["digest"])

# Minimal RFC-5322-ish email validation.  Don't over-engineer — Yahoo,
# Gmail, and corporate workplaces all accept very different oddities;
# this catches the obvious typos without rejecting valid edge cases.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ── Recipients CRUD ──────────────────────────────────────────────────────────

@router.get("/recipients", response_model=List[DigestRecipientResponse])
def list_recipients(db: Session = Depends(get_db)):
    return db.query(DigestRecipient).order_by(DigestRecipient.id.asc()).all()


@router.post("/recipients", response_model=DigestRecipientResponse, status_code=201)
def add_recipient(data: DigestRecipientCreate, db: Session = Depends(get_db)):
    email = (data.email or "").strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail=f"Invalid email: {email!r}")

    existing = db.query(DigestRecipient).filter_by(email=email).first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"Recipient {email!r} already exists (id={existing.id}).",
        )
    row = DigestRecipient(email=email, is_active=True)
    db.add(row)
    db.commit()
    db.refresh(row)
    logger.info("digest recipient added: %s", email)
    return row


@router.patch("/recipients/{recipient_id}", response_model=DigestRecipientResponse)
def patch_recipient(
    recipient_id: int, data: dict, db: Session = Depends(get_db),
):
    row = db.query(DigestRecipient).filter_by(id=recipient_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Recipient not found.")
    if "is_active" in data:
        row.is_active = bool(data["is_active"])
    db.commit()
    db.refresh(row)
    return row


@router.delete("/recipients/{recipient_id}", status_code=204)
def delete_recipient(recipient_id: int, db: Session = Depends(get_db)):
    row = db.query(DigestRecipient).filter_by(id=recipient_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Recipient not found.")
    db.delete(row)
    db.commit()
    logger.info("digest recipient removed: %s", row.email)
    return None


# ── Preview + manual send ────────────────────────────────────────────────────
#
# v0032 (2026-09-21) — /preview/weekly cache-first, non-blocking
# ───────────────────────────────────────────────────────────────
#
# The weekly-preview build takes 3–5 min on a cold cache (see the
# comment above the SEND path). Even after PR #100 added the Monday
# 00:30 ET prewarm cron, an operator peeking at the preview at an
# unusual moment (mid-week, right after a redeploy that dropped the
# WindowSummary cache, first Monday after the Mon–Sun window fix) can
# still hit a cold build. Making /preview stay synchronous with a
# route-specific nginx timeout was tried (PR #99, closed) and rejected
# as a hack — the right fix is to remove the slow build from the
# request path entirely.
#
# Contract:
#   GET /api/digest/preview/weekly
#     — cache hit → HTMLResponse 200 (the full digest, <100ms)
#     — cache miss + build not running → spawn background build, return
#       a tiny HTML placeholder with meta-refresh=15s. The browser will
#       reload and pick up the HTML from cache once the build finishes.
#     — cache miss + build already running → same placeholder.
#   GET /api/digest/preview/weekly/status
#     — JSON: {status: 'ready' | 'pending' | 'error', window_end,
#       built_at?, error?}. For programmatic polling (health checks,
#       CI QA scripts) instead of the meta-refresh page.
#
# The cache is in-memory (a dict keyed by (kind, window_end)) with a
# soft ceiling of 4 entries — enough for the current + last few
# anchors, doesn't grow unbounded. Restarting the service clears the
# cache, which is fine: the prewarm cron repopulates on the next Monday
# 00:30 ET, or an operator can hit /prewarm/weekly on-demand.

_PREVIEW_CACHE_LOCK = threading.Lock()
_PREVIEW_CACHE: dict[tuple[str, str], dict] = {}
# Structure: _PREVIEW_CACHE[("weekly", "2026-09-20")] = {
#   "html": "<html>...</html>",
#   "subject": "SentimentPulse Weekly Executive Digest — Sep 14 – Sep 20, 2026",
#   "built_at": "2026-09-21T14:30:00+00:00",
# }
_PREVIEW_BUILD_INFLIGHT: set[tuple[str, str]] = set()
# Rolling error state for /status — cleared on the next successful build.
_PREVIEW_LAST_ERROR: dict[tuple[str, str], str] = {}
_PREVIEW_CACHE_MAX_ENTRIES = 4


def _preview_placeholder_html(kind: str, window_end: str) -> str:
    """Small placeholder page with meta-refresh so browsers reload once
    the background build finishes. Deliberately minimal — do NOT wire in
    real design tokens here; the whole point is that this page never
    ships as the actual preview.
    """
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Building {kind} digest preview…</title>
  <meta http-equiv="refresh" content="15">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            max-width: 40rem; margin: 4rem auto; padding: 0 1rem;
            color: #333; line-height: 1.5; }}
    code {{ background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; }}
  </style>
</head>
<body>
  <h1>Building the {kind} digest…</h1>
  <p>The preview isn't cached yet for anchor Sunday <code>{window_end}</code>. The build has been started in the background and typically takes 3–5 minutes on a cold cache.</p>
  <p>This page auto-reloads every 15 seconds; you can also poll <code>/api/digest/preview/{kind}/status</code> for a JSON status.</p>
</body>
</html>"""


def _cache_evict_if_needed():
    """Keep at most _PREVIEW_CACHE_MAX_ENTRIES. Oldest built_at goes first.
    Called with _PREVIEW_CACHE_LOCK held."""
    if len(_PREVIEW_CACHE) <= _PREVIEW_CACHE_MAX_ENTRIES:
        return
    # Sort keys by built_at ascending, evict the oldest.
    keys_by_age = sorted(
        _PREVIEW_CACHE.keys(),
        key=lambda k: _PREVIEW_CACHE[k].get("built_at", ""),
    )
    for k in keys_by_age[: len(_PREVIEW_CACHE) - _PREVIEW_CACHE_MAX_ENTRIES]:
        logger.info("digest preview cache: evicting %s", k)
        _PREVIEW_CACHE.pop(k, None)


def _build_weekly_preview_background(window_end_iso: str) -> None:
    """Build the weekly digest HTML and stash it in _PREVIEW_CACHE. Uses
    its own SessionLocal (background thread must not reuse a request
    session)."""
    from database import SessionLocal  # noqa: PLC0415
    from datetime import datetime as _dt, timezone as _tz  # noqa: PLC0415

    key = ("weekly", window_end_iso)
    session = SessionLocal()
    try:
        logger.info("preview/weekly background build starting for anchor %s", window_end_iso)
        built = digest_service.build_weekly_digest(session)
        entry = {
            "html": built["html"],
            "subject": built.get("subject", ""),
            "built_at": _dt.now(tz=_tz.utc).isoformat(),
        }
        with _PREVIEW_CACHE_LOCK:
            _PREVIEW_CACHE[key] = entry
            _PREVIEW_LAST_ERROR.pop(key, None)
            _cache_evict_if_needed()
        logger.info(
            "preview/weekly background build complete for anchor %s: subject=%r bytes=%d",
            window_end_iso, entry["subject"], len(entry["html"]),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("preview/weekly background build FAILED for anchor %s", window_end_iso)
        with _PREVIEW_CACHE_LOCK:
            _PREVIEW_LAST_ERROR[key] = f"{type(exc).__name__}: {exc}"
    finally:
        session.close()
        with _PREVIEW_CACHE_LOCK:
            _PREVIEW_BUILD_INFLIGHT.discard(key)


@router.get("/preview/weekly", response_class=HTMLResponse)
def preview_weekly(db: Session = Depends(get_db)):
    """Render the weekly digest HTML — cache-first, non-blocking.

    v0032 (2026-09-21): rewritten from synchronous build to cache-first
    with background build fallback. See the block comment above.
    """
    from datetime import date as _date  # noqa: PLC0415

    window_end = digest_service._weekly_window_end(_date.today())
    window_end_iso = window_end.isoformat()
    key = ("weekly", window_end_iso)

    # Cache hit — return the built HTML immediately.
    with _PREVIEW_CACHE_LOCK:
        cached = _PREVIEW_CACHE.get(key)
    if cached is not None:
        return HTMLResponse(content=cached["html"])

    # Cache miss. Kick off a background build if one isn't already running,
    # then return the placeholder so the browser can retry.
    with _PREVIEW_CACHE_LOCK:
        if key not in _PREVIEW_BUILD_INFLIGHT:
            _PREVIEW_BUILD_INFLIGHT.add(key)
            spawn = True
        else:
            spawn = False

    if spawn:
        threading.Thread(
            target=_build_weekly_preview_background,
            args=(window_end_iso,),
            name=f"preview-weekly-{window_end_iso}",
            daemon=True,
        ).start()
        logger.info("preview/weekly background build spawned for anchor %s", window_end_iso)

    # 202 Accepted signals to programmatic clients that the resource is
    # being prepared; browsers still render the meta-refresh HTML.
    return HTMLResponse(
        content=_preview_placeholder_html("weekly", window_end_iso),
        status_code=202,
    )


@router.get("/preview/weekly/status")
def preview_weekly_status(db: Session = Depends(get_db)):
    """JSON status for the cache-first weekly preview.

    Useful for programmatic polling (CI QA scripts, monitoring probes)
    that don't want to parse the meta-refresh HTML. Statuses:

      - 'ready'   — cache hit, HTML available at /preview/weekly.
                    Includes 'built_at' ISO timestamp and 'subject'.
      - 'pending' — build in progress; retry in a few seconds.
      - 'error'   — last build for this anchor raised; details in 'error'.
                    Clears on next successful build.
      - 'idle'    — no build has run for this anchor and none is queued.
                    Hit GET /preview/weekly (or /prewarm/weekly) to
                    trigger one.
    """
    from datetime import date as _date  # noqa: PLC0415

    window_end = digest_service._weekly_window_end(_date.today())
    window_end_iso = window_end.isoformat()
    key = ("weekly", window_end_iso)

    with _PREVIEW_CACHE_LOCK:
        if key in _PREVIEW_CACHE:
            entry = _PREVIEW_CACHE[key]
            return {
                "status": "ready",
                "window_end": window_end_iso,
                "built_at": entry.get("built_at"),
                "subject": entry.get("subject"),
            }
        if key in _PREVIEW_BUILD_INFLIGHT:
            return {"status": "pending", "window_end": window_end_iso}
        err = _PREVIEW_LAST_ERROR.get(key)
        if err is not None:
            return {
                "status": "error",
                "window_end": window_end_iso,
                "error": err,
            }
        return {"status": "idle", "window_end": window_end_iso}


@router.get("/preview/monthly", response_class=HTMLResponse)
def preview_monthly(db: Session = Depends(get_db)):
    built = digest_service.build_monthly_digest(db)
    return HTMLResponse(content=built["html"])


# v0032 (2026-09-21): building the digest can take several minutes on
# cold cache (all 9 priority titles × WindowSummary regeneration × LLM
# synthesis per topic cluster). The old synchronous send endpoint 504'd
# through nginx's 120s proxy_read_timeout on every cold operator send.
# _SEND_INFLIGHT dedupes overlapping fire-and-forget invocations.
_SEND_INFLIGHT_LOCK = threading.Lock()
_SEND_INFLIGHT: set[str] = set()

# Same dedupe pattern for the manual /prewarm/weekly trigger. Independent
# of _SEND_INFLIGHT because a prewarm can safely run WHILE a send is
# in progress (they both use SessionLocal and the WindowSummary cache is
# unique-constrained).
_PREWARM_INFLIGHT_LOCK = threading.Lock()
_PREWARM_INFLIGHT: set[str] = set()


def _send_digest_background(kind: str, banner_html: str | None = None) -> None:
    """Run send_weekly_digest / send_monthly_digest on a daemon thread
    with its own DB session (background threads must not reuse the
    request-scoped session). Logs the outcome so operators can trace it
    in journalctl -u sentimentpulse.

    `banner_html` is the optional one-shot correction banner — forwarded
    to send_weekly_digest so it lands right after <body> in the sent
    HTML. Never persisted; only affects THIS one send.
    """
    from database import SessionLocal  # noqa: PLC0415

    session = SessionLocal()
    try:
        if kind == "weekly":
            result = digest_service.send_weekly_digest(
                session, banner_html=banner_html,
            )
        else:
            # Monthly banner support can be added the same way when needed.
            result = digest_service.send_monthly_digest(session)
        logger.info(
            "digest send/%s background complete: sent=%s reason=%s subject=%r "
            "banner=%s provider_id=%s inline_images=%s",
            kind, result.get("sent"), result.get("reason"), result.get("subject"),
            bool(banner_html), result.get("provider_id"), result.get("inline_images"),
        )
    except Exception:  # noqa: BLE001 — background thread, log + swallow
        logger.exception("digest send/%s background failed", kind)
    finally:
        session.close()
        with _SEND_INFLIGHT_LOCK:
            _SEND_INFLIGHT.discard(kind)


def _start_send_background(kind: str, banner_html: str | None = None) -> dict:
    """Idempotent fire-and-forget: spawn the background sender if not
    already running for this digest kind. Returns immediately.
    """
    with _SEND_INFLIGHT_LOCK:
        if kind in _SEND_INFLIGHT:
            return {"status": "already_running", "kind": kind}
        _SEND_INFLIGHT.add(kind)

    thread = threading.Thread(
        target=_send_digest_background,
        args=(kind, banner_html),
        name=f"digest-send-{kind}",
        daemon=True,
    )
    thread.start()
    logger.info("digest send/%s background started (banner=%s)", kind, bool(banner_html))
    return {
        "status": "started",
        "kind": kind,
        "banner_injected": bool(banner_html),
    }


class _WeeklySendBody(BaseModel):
    """Body for POST /api/digest/send/weekly.

    `banner_html` is optional; when provided it's injected right after
    <body> in the sent HTML. Used for operator resends that need to
    explain a correction (e.g. the Sep 14–20 v0032 resend that had to
    note the date-window fix vs the buggy Tue–Mon window). Never
    persisted; only affects THIS one send.
    """
    banner_html: Optional[str] = None


@router.post("/send/weekly")
def send_weekly_now(
    body: Optional[_WeeklySendBody] = None,
    db: Session = Depends(get_db),
):
    """Trigger an immediate weekly digest send to all active recipients.

    v0032 (2026-09-21): NON-BLOCKING. The build step is slow on cold
    cache (all 9 priority titles × WindowSummary regeneration × LLM
    synthesis) and the old sync endpoint 504'd through nginx's 120s
    proxy_read_timeout. This now returns {status: 'started' | 'already_running'}
    in <100ms and runs the actual build + Resend send on a background
    thread. Follow-up in journalctl -u sentimentpulse for the outcome.

    Optional JSON body: {"banner_html": "<div>…</div>"} injects a
    one-shot correction banner right after <body> in the sent HTML.
    """
    banner_html = body.banner_html if body else None
    return _start_send_background("weekly", banner_html=banner_html)


@router.post("/send/monthly")
def send_monthly_now(db: Session = Depends(get_db)):
    """Trigger an immediate monthly digest send to all active recipients.

    v0032 (2026-09-21): NON-BLOCKING for the same reason as send/weekly.
    See the docstring on send_weekly_now.
    """
    return _start_send_background("monthly")


# ── Manual prewarm trigger ───────────────────────────────────────────────────
#
# The scheduled prewarm runs every Monday 00:30 ET (see backend/scheduler.py
# `_weekly_prewarm_job`). This endpoint exists so an operator can fire the
# same work on demand — useful after a data-repair push, or the very first
# time after the Mon–Sun window fix landed and no prewarm cron had run yet
# against the new anchor date.
#
# Same fire-and-forget shape as /send/*: returns in <100ms with
# {status, kind, window_end} while the background thread runs.


def _prewarm_weekly_background() -> None:
    """Run the weekly prewarm on a daemon thread with its own SessionLocal.

    This is a thin wrapper that reuses the same logic as scheduler._weekly_prewarm_job
    so on-demand and scheduled paths always cache exactly the same rows.
    """
    from database import SessionLocal  # noqa: PLC0415
    from services import period_summary_service as _pss  # noqa: PLC0415
    from services.digest_service import (  # noqa: PLC0415
        PRIORITY_TITLES,
        _weekly_window_end,
    )
    from datetime import date as _date  # noqa: PLC0415
    import time as _time  # noqa: PLC0415

    session = SessionLocal()
    try:
        today = _date.today()
        window_end = _weekly_window_end(today)
        logger.info(
            "On-demand weekly prewarm starting for anchor Sunday %s (%d titles).",
            window_end.isoformat(),
            len(PRIORITY_TITLES),
        )
        started_at = _time.monotonic()
        ok, fail = 0, 0
        for game_id, name in PRIORITY_TITLES:
            t0 = _time.monotonic()
            try:
                _pss.generate_window_summary(
                    session, game_id=game_id, days=7, end_date=window_end,
                )
                dt = _time.monotonic() - t0
                logger.info(
                    "On-demand prewarm ok: game_id=%d %r in %.1fs", game_id, name, dt,
                )
                ok += 1
            except Exception:  # noqa: BLE001
                logger.exception(
                    "On-demand prewarm FAILED for game_id=%d %r", game_id, name,
                )
                fail += 1
        total = _time.monotonic() - started_at
        logger.info(
            "On-demand weekly prewarm complete for anchor %s: %d ok / %d failed in %.1fs.",
            window_end.isoformat(), ok, fail, total,
        )
    except Exception:  # noqa: BLE001
        logger.exception("On-demand weekly prewarm crashed")
    finally:
        session.close()
        with _PREWARM_INFLIGHT_LOCK:
            _PREWARM_INFLIGHT.discard("weekly")


@router.post("/prewarm/weekly")
def prewarm_weekly_now(db: Session = Depends(get_db)):
    """Trigger an on-demand WindowSummary prewarm for the current anchor Sunday.

    Fire-and-forget: returns immediately with {status, kind, window_end}.
    The background thread generates WindowSummary rows for every priority
    title so the next /preview/weekly or /send/weekly (or the Monday
    07:00 ET digest cron) reads from cache instead of doing on-demand LLM
    work. Total wall-time is typically 3–5 minutes cold; <10s if the
    scheduled prewarm already ran for this anchor.

    Idempotent: overlapping calls with the same kind return
    {status: 'already_running'} instead of spawning a second thread.
    """
    from services.digest_service import _weekly_window_end  # noqa: PLC0415
    from datetime import date as _date  # noqa: PLC0415

    with _PREWARM_INFLIGHT_LOCK:
        if "weekly" in _PREWARM_INFLIGHT:
            return {
                "status": "already_running",
                "kind": "weekly",
                "window_end": _weekly_window_end(_date.today()).isoformat(),
            }
        _PREWARM_INFLIGHT.add("weekly")

    threading.Thread(
        target=_prewarm_weekly_background,
        name="digest-prewarm-weekly",
        daemon=True,
    ).start()
    logger.info("digest prewarm/weekly background started")
    return {
        "status": "started",
        "kind": "weekly",
        "window_end": _weekly_window_end(_date.today()).isoformat(),
    }


# ── One-time skip flags for the scheduled digest jobs ───────────────────────
#
# The APScheduler jobs in backend/scheduler.py honor AppSetting rows
# named 'weekly_digest_skip_until' and 'monthly_digest_skip_until'.
# While `now < skip_until`, the corresponding job no-ops (logging that
# it was skipped). Once the timestamp passes, normal cadence resumes
# automatically — no follow-up action needed.

_WEEKLY_SKIP_KEY = "weekly_digest_skip_until"
_MONTHLY_SKIP_KEY = "monthly_digest_skip_until"
_VALID_SKIP_KEYS = {"weekly": _WEEKLY_SKIP_KEY, "monthly": _MONTHLY_SKIP_KEY}


class DigestSkipRequest(BaseModel):
    which: str            # 'weekly' or 'monthly'
    skip_until: str       # ISO-8601 UTC timestamp (e.g. '2026-07-28T00:00:00Z')


class DigestSkipResponse(BaseModel):
    key: str
    skip_until: Optional[str]
    active_now: bool      # True iff now < skip_until


def _read_skip(db: Session, key: str) -> DigestSkipResponse:
    row = db.query(AppSetting).filter_by(key=key).first()
    value = row.value if row and row.value else None
    active = False
    if value:
        try:
            raw = value.strip()
            if raw.endswith("Z"):
                raw = raw[:-1] + "+00:00"
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            active = datetime.now(tz=timezone.utc) < parsed
        except Exception:
            active = False
    return DigestSkipResponse(key=key, skip_until=value, active_now=active)


@router.get("/skip", response_model=List[DigestSkipResponse])
def list_skip_flags(db: Session = Depends(get_db)):
    """Return both weekly + monthly skip flags with an active_now boolean."""
    return [_read_skip(db, k) for k in (_WEEKLY_SKIP_KEY, _MONTHLY_SKIP_KEY)]


@router.post("/skip", response_model=DigestSkipResponse)
def set_skip_flag(payload: DigestSkipRequest, db: Session = Depends(get_db)):
    """Set a skip-until timestamp for the weekly or monthly digest job."""
    if payload.which not in _VALID_SKIP_KEYS:
        raise HTTPException(400, "which must be 'weekly' or 'monthly'")
    # Validate the timestamp parses — don't silently store garbage.
    raw = payload.skip_until.strip()
    if raw.endswith("Z"):
        raw_for_parse = raw[:-1] + "+00:00"
    else:
        raw_for_parse = raw
    try:
        parsed = datetime.fromisoformat(raw_for_parse)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
    except Exception as exc:
        raise HTTPException(400, f"skip_until must be ISO-8601: {exc}")
    if datetime.now(tz=timezone.utc) >= parsed:
        raise HTTPException(
            400, "skip_until must be a future UTC timestamp; nothing to skip",
        )
    key = _VALID_SKIP_KEYS[payload.which]
    row = db.query(AppSetting).filter_by(key=key).first()
    if row is None:
        row = AppSetting(key=key, value=raw)
        db.add(row)
    else:
        row.value = raw
    db.commit()
    logger.info("Digest skip flag set: %s = %s", key, raw)
    return _read_skip(db, key)


@router.delete("/skip", response_model=DigestSkipResponse)
def clear_skip_flag(
    which: str = Query(..., description="'weekly' or 'monthly'"),
    db: Session = Depends(get_db),
):
    """Clear a previously-set skip flag so the next scheduled run fires."""
    if which not in _VALID_SKIP_KEYS:
        raise HTTPException(400, "which must be 'weekly' or 'monthly'")
    key = _VALID_SKIP_KEYS[which]
    row = db.query(AppSetting).filter_by(key=key).first()
    if row is not None:
        db.delete(row)
        db.commit()
        logger.info("Digest skip flag cleared: %s", key)
    return _read_skip(db, key)
