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
"""
import logging
import re
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from database import get_db
from models import DigestRecipient
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


@router.post("/send/weekly")
def send_weekly_now(db: Session = Depends(get_db)):
    """Trigger an immediate weekly digest send to all active recipients."""
    return digest_service.send_weekly_digest(db)


@router.post("/send/monthly")
def send_monthly_now(db: Session = Depends(get_db)):
    """Trigger an immediate monthly digest send to all active recipients."""
    return digest_service.send_monthly_digest(db)
