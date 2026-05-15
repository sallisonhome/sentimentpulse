"""GTM Slide Pack Studio — FastAPI backend.

Mount point: /gtm/api/ (proxied by Nginx)
Port: 8001
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

# Make local imports work when running via uvicorn from this directory
sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import DB_PATH, get_conn, init_db  # noqa: E402
from gtm_pack import render_pack_with_artifacts  # noqa: E402
from gtm_pack import ASSETS_DIR as GTM_ASSETS_DIR  # noqa: E402
from admin_auth import (  # noqa: E402
    clear_session_cookie,
    make_session_token,
    require_admin,
    set_new_password_hash,
    set_session_cookie,
    verify_password,
)

# ── Paths ────────────────────────────────────────────────────────────────────
STORAGE_ROOT = Path(os.getenv("GTM_STORAGE_ROOT", "/var/lib/gtm"))
LIBRARY_DIR = STORAGE_ROOT / "library"
TRASH_DIR = STORAGE_ROOT / "trash"
PREVIEW_DIR = STORAGE_ROOT / "preview"

for d in (LIBRARY_DIR, TRASH_DIR, PREVIEW_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Single-render semaphore — droplet is 1GB, LibreOffice peaks ~700MB.
RENDER_SEMAPHORE = threading.Semaphore(1)


# ── Models ───────────────────────────────────────────────────────────────────


class Cohort(BaseModel):
    name: str
    size: int


class USP(BaseModel):
    title: str
    description: str
    proof: str = ""


class ReachRow(BaseModel):
    cohort: str
    channel: str            # comma-separated; renderer splits on ","
    message: str
    kpi: str


class FormInputs(BaseModel):
    title: str
    genre: str
    game_type: str = "sequel"          # sequel | new_ip_with_fans | custom
    inner: str = "prev"                # prev | dev | other
    release_date: str                  # YYYY-MM-DD
    cohorts: list[Cohort] = Field(min_length=4, max_length=4)
    usps: list[USP] = Field(min_length=3, max_length=5)
    reach: list[ReachRow] = Field(min_length=4, max_length=4)
    inner_definition: str | None = None
    ring2_definition: str | None = None
    wedge: str | None = None
    wedge_support: str | None = None
    phases_override: dict | None = None

    @field_validator("release_date")
    @classmethod
    def _validate_date(cls, v: str) -> str:
        try:
            dt.date.fromisoformat(v)
        except ValueError:
            raise ValueError(f"release_date must be YYYY-MM-DD, got {v}")
        return v


class PreviewRequest(BaseModel):
    inputs: FormInputs
    theme: str = "dark"

    @field_validator("theme")
    @classmethod
    def _validate_theme(cls, v: str) -> str:
        if v not in ("dark", "light"):
            raise ValueError("theme must be 'dark' or 'light'")
        return v


class RegenerateRequest(PreviewRequest):
    pass


class CommitRequest(BaseModel):
    is_private: bool = False


# ── App init ─────────────────────────────────────────────────────────────────

# Initialize DB on import (works for both `uvicorn main:app` and TestClient).
init_db()

limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="GTM Slide Pack Studio", root_path="/gtm/api")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "PATCH"],
    allow_headers=["*"],
    allow_credentials=True,
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _render_to(out_dir: Path, inputs: FormInputs, theme: str) -> dict[str, Any]:
    """Acquire render semaphore, render, return artifact dict."""
    with RENDER_SEMAPHORE:
        return render_pack_with_artifacts(
            inputs.model_dump(),
            theme,
            out_dir,
            phases_override=inputs.phases_override,
        )


def _preview_urls(session_id: str, pngs: list[Path]) -> list[str]:
    return [f"/gtm/api/preview/{session_id}/png/{p.name}" for p in pngs]


def _row_to_deck_dict(row) -> dict:
    d = dict(row)
    d["is_private"] = bool(d["is_private"])
    # Don't leak filesystem paths
    d.pop("pptx_path", None)
    d.pop("pdf_path", None)
    return d


# ── Public endpoints ─────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {"ok": True, "db": str(DB_PATH), "storage": str(STORAGE_ROOT)}


@app.get("/defaults/roadmap_phases")
def get_roadmap_phases_defaults():
    """Return the bundled roadmap_phases.json for the form's advanced editor."""
    with open(GTM_ASSETS_DIR / "roadmap_phases.json") as f:
        return json.load(f)


@app.get("/library")
def list_library(
    theme: str | None = None,
    q: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """Paginated active, non-private decks."""
    where = ["deleted_at IS NULL", "is_private = 0"]
    params: list[Any] = []

    if theme:
        where.append("theme = ?")
        params.append(theme)
    if q:
        where.append("title LIKE ?")
        params.append(f"%{q}%")
    if from_date:
        where.append("release_date >= ?")
        params.append(from_date)
    if to_date:
        where.append("release_date <= ?")
        params.append(to_date)

    where_clause = " AND ".join(where) if where else "1=1"
    offset = (page - 1) * page_size

    with get_conn() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM gtm_decks WHERE {where_clause}", params
        ).fetchone()[0]
        rows = conn.execute(
            f"""SELECT id, title, genre, theme, release_date, is_private, created_at, status
                FROM gtm_decks
                WHERE {where_clause}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?""",
            [*params, page_size, offset],
        ).fetchall()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "decks": [_row_to_deck_dict(r) for r in rows],
    }


@app.get("/library/{deck_id}")
def get_deck(deck_id: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM gtm_decks WHERE id = ? AND deleted_at IS NULL AND is_private = 0",
            [deck_id],
        ).fetchone()
    if not row:
        raise HTTPException(404, "Deck not found")
    return _row_to_deck_dict(row)


@app.get("/library/{deck_id}/download")
def download_deck(deck_id: str, format: str = "pptx"):
    if format not in ("pptx", "pdf"):
        raise HTTPException(400, "format must be 'pptx' or 'pdf'")
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM gtm_decks WHERE id = ? AND deleted_at IS NULL AND is_private = 0",
            [deck_id],
        ).fetchone()
    if not row:
        raise HTTPException(404, "Deck not found")
    path = Path(row["pptx_path"] if format == "pptx" else (row["pdf_path"] or ""))
    if not path.exists():
        raise HTTPException(404, f"{format} file missing on disk")
    media = (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        if format == "pptx"
        else "application/pdf"
    )
    filename = f"{row['title']}_{row['theme']}.{format}".replace(" ", "_")
    return FileResponse(path, media_type=media, filename=filename)


@app.get("/library/{deck_id}/clone")
def clone_deck(deck_id: str):
    """Returns the saved inputs_json so the form can be opened pre-filled."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT inputs_json, theme FROM gtm_decks WHERE id = ? AND deleted_at IS NULL AND is_private = 0",
            [deck_id],
        ).fetchone()
    if not row:
        raise HTTPException(404, "Deck not found")
    return {"theme": row["theme"], "inputs": json.loads(row["inputs_json"])}


# ── Preview workflow ─────────────────────────────────────────────────────────


@app.post("/preview")
def create_preview(req: PreviewRequest):
    """Render a fresh preview. Returns session_id + 9 PNG urls."""
    session_id = uuid.uuid4().hex
    session_dir = PREVIEW_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    try:
        result = _render_to(session_dir, req.inputs, req.theme)
    except Exception as e:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(500, f"Render failed: {e}")

    # Save inputs.json for regenerate/commit
    (session_dir / "inputs.json").write_text(req.model_dump_json())

    return {
        "session_id": session_id,
        "theme": req.theme,
        "pngs": _preview_urls(session_id, result["pngs"]),
        "slide_count": len(result["pngs"]),
    }


@app.post("/preview/{session_id}/regenerate")
def regenerate_preview(session_id: str, req: RegenerateRequest):
    """Re-render the entire deck with updated inputs."""
    session_dir = PREVIEW_DIR / session_id
    if not session_dir.exists():
        raise HTTPException(404, "Preview session not found")

    # Wipe old artifacts, keep the directory
    for f in session_dir.iterdir():
        if f.is_file():
            f.unlink()

    try:
        result = _render_to(session_dir, req.inputs, req.theme)
    except Exception as e:
        raise HTTPException(500, f"Re-render failed: {e}")

    (session_dir / "inputs.json").write_text(req.model_dump_json())
    return {
        "session_id": session_id,
        "theme": req.theme,
        "pngs": _preview_urls(session_id, result["pngs"]),
        "slide_count": len(result["pngs"]),
    }


@app.get("/preview/{session_id}/png/{name}")
def preview_png(session_id: str, name: str):
    """Serve a preview PNG."""
    if "/" in name or ".." in name:
        raise HTTPException(400, "Invalid filename")
    p = PREVIEW_DIR / session_id / name
    if not p.exists() or not p.suffix == ".png":
        raise HTTPException(404, "Preview PNG not found")
    return FileResponse(p, media_type="image/png")


@app.post("/preview/{session_id}/commit")
def commit_preview(session_id: str, req: CommitRequest):
    """Promote a preview into the library."""
    session_dir = PREVIEW_DIR / session_id
    inputs_file = session_dir / "inputs.json"
    if not inputs_file.exists():
        raise HTTPException(404, "Preview session not found")

    saved = json.loads(inputs_file.read_text())
    inputs = FormInputs(**saved["inputs"])
    theme = saved["theme"]

    # Find PPTX + PDF
    pptx_files = list(session_dir.glob("*.pptx"))
    pdf_files = list(session_dir.glob("*.pdf"))
    if not pptx_files:
        raise HTTPException(500, "PPTX missing from preview session")

    deck_id = uuid.uuid4().hex
    deck_dir = LIBRARY_DIR / deck_id
    deck_dir.mkdir(parents=True, exist_ok=True)

    pptx_dst = deck_dir / "deck.pptx"
    shutil.copy2(pptx_files[0], pptx_dst)
    pdf_dst = None
    if pdf_files:
        pdf_dst = deck_dir / "deck.pdf"
        shutil.copy2(pdf_files[0], pdf_dst)

    with get_conn() as conn:
        conn.execute(
            """INSERT INTO gtm_decks
               (id, title, genre, theme, release_date, inputs_json, is_private,
                pptx_path, pdf_path, pptx_size_bytes, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')""",
            [
                deck_id,
                inputs.title,
                inputs.genre,
                theme,
                inputs.release_date,
                json.dumps(inputs.model_dump()),
                1 if req.is_private else 0,
                str(pptx_dst),
                str(pdf_dst) if pdf_dst else None,
                pptx_dst.stat().st_size,
            ],
        )

    # Clean up preview session
    shutil.rmtree(session_dir, ignore_errors=True)

    return {"deck_id": deck_id}


# ── Example deck ─────────────────────────────────────────────────────────────


@app.get("/example")
def get_example():
    """Static example pack URLs — rendered at build time by seed script."""
    static_dir = Path(__file__).resolve().parent / "static_example"
    payload = {"themes": {}}
    for theme in ("dark", "light"):
        theme_dir = static_dir / theme
        if not theme_dir.exists():
            payload["themes"][theme] = []
            continue
        pngs = sorted(theme_dir.glob("*.png"))
        payload["themes"][theme] = [f"/gtm/api/example/{theme}/{p.name}" for p in pngs]
    return payload


@app.get("/example/{theme}/{name}")
def example_png(theme: str, name: str):
    if theme not in ("dark", "light"):
        raise HTTPException(400, "Invalid theme")
    if "/" in name or ".." in name:
        raise HTTPException(400, "Invalid filename")
    p = Path(__file__).resolve().parent / "static_example" / theme / name
    if not p.exists():
        raise HTTPException(404, "Example PNG not found")
    return FileResponse(p, media_type="image/png")


# ── Admin endpoints ──────────────────────────────────────────────────────────


def _log_admin_action(action: str, target_deck_id: str | None, ip: str | None):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO gtm_admin_actions (id, action, target_deck_id, ip_address)
               VALUES (?, ?, ?, ?)""",
            [uuid.uuid4().hex, action, target_deck_id, ip],
        )


class LoginRequest(BaseModel):
    password: str


class PasswordChangeRequest(BaseModel):
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _check_len(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("Password must be at least 6 characters")
        return v


@app.post("/admin/login")
@limiter.limit("5/15minutes")
def admin_login(request: Request, response: Response, body: LoginRequest = Body(...)):
    ip = get_remote_address(request)
    if not verify_password(body.password):
        _log_admin_action("login_failed", None, ip)
        raise HTTPException(401, "Invalid password")
    token = make_session_token()
    set_session_cookie(response, token)
    _log_admin_action("login", None, ip)
    return {"ok": True}


@app.post("/admin/logout")
def admin_logout(request: Request, response: Response, _=Depends(require_admin)):
    ip = get_remote_address(request)
    clear_session_cookie(response)
    _log_admin_action("logout", None, ip)
    return {"ok": True}


@app.get("/admin/session")
def admin_session(_=Depends(require_admin)):
    """Lightweight check the frontend can call to know if the cookie is still valid."""
    return {"authenticated": True}


@app.get("/admin/library")
def admin_list_library(_=Depends(require_admin)):
    """All decks including private and soft-deleted."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT id, title, genre, theme, release_date, is_private,
                      created_at, deleted_at, status
               FROM gtm_decks
               ORDER BY created_at DESC"""
        ).fetchall()
    return {"decks": [dict(r) for r in rows]}


@app.delete("/admin/library/{deck_id}")
def admin_delete_deck(deck_id: str, request: Request, _=Depends(require_admin)):
    """Soft delete: sets deleted_at, moves files to trash/<id>/."""
    ip = get_remote_address(request)
    with get_conn() as conn:
        row = conn.execute(
            "SELECT pptx_path, pdf_path FROM gtm_decks WHERE id = ? AND deleted_at IS NULL",
            [deck_id],
        ).fetchone()
        if not row:
            raise HTTPException(404, "Deck not found or already deleted")

        # Move files to trash
        trash_dir = STORAGE_ROOT / "trash" / deck_id
        trash_dir.mkdir(parents=True, exist_ok=True)
        for path_key in ("pptx_path", "pdf_path"):
            p = row[path_key]
            if p and Path(p).exists():
                shutil.move(p, trash_dir / Path(p).name)

        conn.execute(
            "UPDATE gtm_decks SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
            [deck_id],
        )
    _log_admin_action("delete", deck_id, ip)
    return {"ok": True}


@app.post("/admin/library/{deck_id}/restore")
def admin_restore_deck(deck_id: str, request: Request, _=Depends(require_admin)):
    """Reverses soft delete within 30 days."""
    ip = get_remote_address(request)
    with get_conn() as conn:
        row = conn.execute(
            "SELECT pptx_path, pdf_path FROM gtm_decks WHERE id = ? AND deleted_at IS NOT NULL",
            [deck_id],
        ).fetchone()
        if not row:
            raise HTTPException(404, "Deck not found or not deleted")

        # Move files back from trash
        trash_dir = STORAGE_ROOT / "trash" / deck_id
        for path_key in ("pptx_path", "pdf_path"):
            p = row[path_key]
            if p:
                src = trash_dir / Path(p).name
                if src.exists():
                    Path(p).parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(src), p)

        conn.execute(
            "UPDATE gtm_decks SET deleted_at = NULL WHERE id = ?",
            [deck_id],
        )
        if trash_dir.exists() and not any(trash_dir.iterdir()):
            trash_dir.rmdir()
    _log_admin_action("restore", deck_id, ip)
    return {"ok": True}


@app.delete("/admin/library/{deck_id}/purge")
def admin_purge_deck(deck_id: str, request: Request, _=Depends(require_admin)):
    """Hard delete: removes files and DB row."""
    ip = get_remote_address(request)
    with get_conn() as conn:
        row = conn.execute("SELECT pptx_path, pdf_path FROM gtm_decks WHERE id = ?", [deck_id]).fetchone()
        if not row:
            raise HTTPException(404, "Deck not found")
        # Remove files from either library or trash
        for path_key in ("pptx_path", "pdf_path"):
            p = row[path_key]
            if p:
                # Try original path
                if Path(p).exists():
                    Path(p).unlink()
                # Try trash path
                trash_path = STORAGE_ROOT / "trash" / deck_id / Path(p).name
                if trash_path.exists():
                    trash_path.unlink()
        # Clean up empty dirs
        for d in (LIBRARY_DIR / deck_id, TRASH_DIR / deck_id):
            if d.exists() and not any(d.iterdir()):
                d.rmdir()
        conn.execute("DELETE FROM gtm_decks WHERE id = ?", [deck_id])
    _log_admin_action("purge", deck_id, ip)
    return {"ok": True}


@app.get("/admin/audit")
def admin_audit(page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200),
                _=Depends(require_admin)):
    offset = (page - 1) * page_size
    with get_conn() as conn:
        total = conn.execute("SELECT COUNT(*) FROM gtm_admin_actions").fetchone()[0]
        rows = conn.execute(
            """SELECT id, action, target_deck_id, ip_address, timestamp
               FROM gtm_admin_actions
               ORDER BY timestamp DESC LIMIT ? OFFSET ?""",
            [page_size, offset],
        ).fetchall()
    return {"total": total, "page": page, "page_size": page_size,
            "actions": [dict(r) for r in rows]}


@app.post("/admin/password")
def admin_change_password(request: Request,
                          body: PasswordChangeRequest = Body(...),
                          _=Depends(require_admin)):
    """Re-hash and update the password."""
    ip = get_remote_address(request)
    set_new_password_hash(body.new_password)
    _log_admin_action("change_password", None, ip)
    return {"ok": True}
