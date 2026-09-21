"""
Digest router (all under /api/digest):

  GET    /api/digest/recipients         — list configured email recipients
  POST   /api/digest/recipients         — add a new recipient
  DELETE /api/digest/recipients/{id}    — remove a recipient
  PATCH  /api/digest/recipients/{id}    — toggle is_active

  GET    /api/digest/preview/weekly     — render the weekly digest HTML (no send)
  GET    /api/digest/preview/monthly    — render the monthly digest HTML (no send)
  POST   /api/digest/send/weekly        — send the weekly digest NOW (operator action)
  POST   /api/digest/send/monthly       — send the monthly digest NOW (operator action)

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

@router.get("/preview/weekly", response_class=HTMLResponse)
def preview_weekly(db: Session = Depends(get_db)):
    """Render the weekly digest HTML directly in the browser — no send.

    Useful before the first scheduled run to QA layout, ratio formatting,
    and per-title content against live data.
    """
    built = digest_service.build_weekly_digest(db)
    return HTMLResponse(content=built["html"])


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


def _send_digest_background(kind: str) -> None:
    """Run send_weekly_digest / send_monthly_digest on a daemon thread
    with its own DB session (background threads must not reuse the
    request-scoped session). Logs the outcome so operators can trace it
    in journalctl -u sentimentpulse.
    """
    from database import SessionLocal  # noqa: PLC0415

    session = SessionLocal()
    try:
        if kind == "weekly":
            result = digest_service.send_weekly_digest(session)
        else:
            result = digest_service.send_monthly_digest(session)
        logger.info(
            "digest send/%s background complete: sent=%s reason=%s subject=%r",
            kind, result.get("sent"), result.get("reason"), result.get("subject"),
        )
    except Exception:  # noqa: BLE001 — background thread, log + swallow
        logger.exception("digest send/%s background failed", kind)
    finally:
        session.close()
        with _SEND_INFLIGHT_LOCK:
            _SEND_INFLIGHT.discard(kind)


def _start_send_background(kind: str) -> dict:
    """Idempotent fire-and-forget: spawn the background sender if not
    already running for this digest kind. Returns immediately.
    """
    with _SEND_INFLIGHT_LOCK:
        if kind in _SEND_INFLIGHT:
            return {"status": "already_running", "kind": kind}
        _SEND_INFLIGHT.add(kind)

    thread = threading.Thread(
        target=_send_digest_background,
        args=(kind,),
        name=f"digest-send-{kind}",
        daemon=True,
    )
    thread.start()
    logger.info("digest send/%s background started", kind)
    return {"status": "started", "kind": kind}


@router.post("/send/weekly")
def send_weekly_now(db: Session = Depends(get_db)):
    """Trigger an immediate weekly digest send to all active recipients.

    v0032 (2026-09-21): NON-BLOCKING. The build step is slow on cold
    cache (all 9 priority titles × WindowSummary regeneration × LLM
    synthesis) and the old sync endpoint 504'd through nginx's 120s
    proxy_read_timeout. This now returns {status: 'started' | 'already_running'}
    in <100ms and runs the actual build + Resend send on a background
    thread. Follow-up in journalctl -u sentimentpulse for the outcome.
    """
    return _start_send_background("weekly")


@router.post("/send/monthly")
def send_monthly_now(db: Session = Depends(get_db)):
    """Trigger an immediate monthly digest send to all active recipients.

    v0032 (2026-09-21): NON-BLOCKING for the same reason as send/weekly.
    See the docstring on send_weekly_now.
    """
    return _start_send_background("monthly")


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
