"""GTM Slide Pack Studio — FastAPI backend.

Mount point: /gtm/api/ (proxied by Nginx)
Port: 8001
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import sqlite3
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

import httpx
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
from gtm_pack.translate import (  # noqa: E402
    TranslationError,
    load_ru_roadmap_phases,
    translate_form_inputs,
)
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
    strategy: str = ""
    enabled: bool = True


class ReachRow(BaseModel):
    cohort: str
    channel: str            # comma-separated; renderer splits on ","
    message: str
    kpi: str


class CommercialRisk(BaseModel):
    threat_level: str       # critical | high | medium | low (case-insensitive)
    proof: str
    mitigation: str

    @field_validator("threat_level")
    @classmethod
    def _validate_level(cls, v: str) -> str:
        if v.strip().lower() not in ("critical", "high", "medium", "low"):
            raise ValueError("threat_level must be one of: critical, high, medium, low")
        return v


class FormInputs(BaseModel):
    title: str
    genre: str
    game_type: str = "sequel"          # sequel | new_ip_with_fans | custom
    inner: str = "prev"                # prev | dev | other
    release_date: str                  # YYYY-MM-DD
    cohorts: list[Cohort] = Field(min_length=4, max_length=4)

    # Median Commercial Potential (Revision 1). CURRENCY UNITS -- do not
    # confuse these three fields (see gtm_revisions_summary.md for the
    # cents -> dollars -> millions-of-dollars correction history):
    #   - median_revenue_usd_millions: MILLIONS of dollars (e.g. 4.7 == $4.7M)
    #   - avg_price_usd: PLAIN dollars (e.g. 39.99)
    #   - median_units_sold: raw integer unit count (e.g. 1782675)
    comp_set_name: str = "Genre Pulse comp set"
    median_revenue_usd_millions: float = 0.0
    avg_price_usd: float = 0.0
    median_units_sold: int = 0
    avg_hours_played: float = 0.0
    platforms: list[str] = Field(default_factory=lambda: ["PC", "PS5", "XSX", "SWITCH2"])

    usps: list[USP] = Field(min_length=1, max_length=5)
    reach: list[ReachRow] = Field(min_length=4, max_length=4)

    # Commercial Risks (Revision 3)
    # NOTE on backward compatibility: default_factory supplies one placeholder
    # risk so that pre-revision deck rows in the DB (whose inputs_json blob
    # predates this field entirely) can still be read back via GET
    # /library/{id}, clone, and /library/{id}/slides without a validation
    # error. New submissions from the wizard always send this field
    # explicitly with real user-authored content -- the placeholder default
    # is a read-compatibility safety net only, not an intended empty state
    # for new decks.
    risks: list[CommercialRisk] = Field(
        default_factory=lambda: [
            CommercialRisk(threat_level="medium", proof="", mitigation="")
        ],
        min_length=1,
        max_length=5,
    )

    # Description & Razors (Revision 4)
    description_100: str = ""
    razor_20: str = ""
    razor_10: str = ""

    inner_definition: str | None = None
    ring2_definition: str | None = None
    wedge: str | None = None
    wedge_support: str | None = None
    risks_wedge: str | None = None
    risks_wedge_support: str | None = None
    phases_override: dict | None = None

    @field_validator("release_date")
    @classmethod
    def _validate_date(cls, v: str) -> str:
        try:
            dt.date.fromisoformat(v)
        except ValueError:
            raise ValueError(f"release_date must be YYYY-MM-DD, got {v}")
        return v

    @field_validator("usps")
    @classmethod
    def _validate_enabled_usp_count(cls, v: list[USP]) -> list[USP]:
        enabled_count = sum(1 for u in v if u.enabled)
        if not (1 <= enabled_count <= 5):
            raise ValueError(
                f"Enabled USP count must be 1-5 (got {enabled_count} enabled of {len(v)} total)"
            )
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


class TranslateRequest(BaseModel):
    target_lang: str = "ru"

    @field_validator("target_lang")
    @classmethod
    def _validate_target_lang(cls, v: str) -> str:
        if v != "ru":
            raise ValueError("target_lang must be 'ru' (only supported target currently)")
        return v


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


def _form_inputs_to_render_dict(inputs: FormInputs) -> dict[str, Any]:
    """Map FormInputs -> the flat dict shape the gtm_pack renderers expect.

    Most fields pass through as-is via model_dump(); a couple of names differ
    between the Pydantic form schema and the renderer wrapper contract:
      - description_100 (form field name) -> description (renderer key)
      - risks_wedge / risks_wedge_support -> wedge / wedge_support are shared
        between the USP slide and the Commercial Risks slide in the skill's
        CLI, so we pass the risks-specific wedge through under the same
        `wedge`/`wedge_support` keys ONLY when rendering commercial_risks;
        render_full_pack's per-renderer wrappers read wedge/wedge_support
        from the same inputs dict for both USP and Risks, so if the caller
        wants DIFFERENT wedge text on each slide they must render those two
        slides separately rather than via render_full_pack. render_full_pack
        uses `wedge`/`wedge_support` for USP and falls back to
        `risks_wedge`/`risks_wedge_support` (if set) for Commercial Risks.
    """
    d = inputs.model_dump()
    d["description"] = d.pop("description_100", "") or d.get("description", "")
    return d


def _render_to(out_dir: Path, inputs: FormInputs, theme: str) -> dict[str, Any]:
    """Acquire render semaphore, render, return artifact dict."""
    with RENDER_SEMAPHORE:
        return render_pack_with_artifacts(
            _form_inputs_to_render_dict(inputs),
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


# Genre Pulse upstream (howmanyareplaying.com) exposes comp-set aggregates in
# CENTS. This endpoint converts them to the units the GTM Studio form and
# renderers use (see FormInputs / gtm_pack docstrings for the full currency
# history): revenue -> MILLIONS of dollars, price -> PLAIN dollars, units ->
# unchanged raw count.
GENRE_PULSE_BASE_URL = os.getenv("GENRE_PULSE_BASE_URL", "https://www.howmanyareplaying.com")
_GENRE_PULSE_TIMEOUT_S = 8.0


@app.get("/defaults/genre_pulse_comps")
def get_genre_pulse_comps(genre: str = Query(..., description="Genre slug, e.g. 'horror'")):
    """Fetch Genre Pulse (howmanyareplaying.com) comp-set averages for a genre
    and convert them into the units the Commercial Potential form/renderer use.

    Upstream shape (cents-based), from GET /api/genres/{genre}:
      averages.avg_msrp_usd_cents            -> avg_price_usd  (/100)
      averages.avg_hours_median              -> avg_hours_played (unchanged)
      averages.median_estimated_owners       -> median_units_sold (unchanged)
      averages.median_estimated_gross_sales_usd_cents
                                              -> median_revenue_usd_millions
                                                 (/100/1_000_000, rounded to 2dp)

    Response shape:
      {
        "median_revenue_usd_millions": 4.7,
        "avg_price_usd": 39.99,
        "median_units_sold": 1782675,
        "avg_hours_played": 18.7,
        "comp_set_name": "<Genre> — <N> titles",
        "source": "howmanyareplaying.com"
      }
    """
    url = f"{GENRE_PULSE_BASE_URL}/api/genres/{genre}"
    try:
        resp = httpx.get(url, timeout=_GENRE_PULSE_TIMEOUT_S)
        resp.raise_for_status()
        payload = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Genre Pulse upstream request failed: {e}")
    except ValueError as e:
        raise HTTPException(502, f"Genre Pulse upstream returned invalid JSON: {e}")

    averages = payload.get("averages") or {}
    titles = payload.get("titles") or payload.get("games") or []
    n_titles = len(titles) if isinstance(titles, list) else payload.get("title_count")

    try:
        avg_price_cents = averages["avg_msrp_usd_cents"]
        avg_hours = averages["avg_hours_median"]
        median_owners = averages["median_estimated_owners"]
        median_gross_cents = averages["median_estimated_gross_sales_usd_cents"]
    except KeyError as e:
        raise HTTPException(
            502, f"Genre Pulse upstream response missing expected field: {e}"
        )

    median_revenue_usd_millions = round(median_gross_cents / 100 / 1_000_000, 2)
    avg_price_usd = round(avg_price_cents / 100, 2)

    comp_set_name = f"{genre.title()}"
    if n_titles:
        comp_set_name += f" — {n_titles} titles"

    return {
        "median_revenue_usd_millions": median_revenue_usd_millions,
        "avg_price_usd": avg_price_usd,
        "median_units_sold": int(median_owners),
        "avg_hours_played": float(avg_hours),
        "comp_set_name": comp_set_name,
        "source": "howmanyareplaying.com",
    }


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
            f"""SELECT id, title, genre, theme, release_date, is_private, created_at, status,
                       language, translated_from_deck_id
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


@app.post("/library/{deck_id}/translate")
def translate_deck(deck_id: str, req: TranslateRequest):
    """Translate an existing EN library deck into `req.target_lang` (Phase 4).

    Flow:
      1. 404 if the source deck doesn't exist (active, non-private, and --
         intentionally -- must currently be an EN-language deck; translating
         an already-translated deck is out of scope for v1 and rejected).
      2. 409 if a translation to that language already exists for this deck
         (enforced by the DB's UNIQUE index on
         (translated_from_deck_id, language) -- we also pre-check via SELECT
         so we can return the existing deck_id in the 409 body for the
         frontend to link to directly, per the Library.tsx UX spec).
      3. Translate FormInputs via Sonar (gtm_pack.translate.translate_form_inputs).
         Any TranslationError (e.g. Sonar unavailable) surfaces as a 502 --
         this must fail loudly, never silently create a mislabeled deck.
      4. Re-render all 12 slides in the target language, using the
         pre-translated static roadmap phases asset as `phases_override`
         (the roadmap slide copy is fixed checklist content, not per-deck
         user input -- see gtm_pack/translate.py module docstring).
      5. Insert a new gtm_decks row with language=<target_lang> and
         translated_from_deck_id=<source id>, copying is_private from the
         source deck.
      6. Return the new deck_id so the frontend can redirect to its viewer.
    """
    with get_conn() as conn:
        source_row = conn.execute(
            "SELECT * FROM gtm_decks WHERE id = ? AND deleted_at IS NULL AND is_private = 0",
            [deck_id],
        ).fetchone()
    if not source_row:
        raise HTTPException(404, "Deck not found")

    source_language = source_row["language"] if "language" in source_row.keys() else "en"
    if source_language != "en":
        raise HTTPException(
            400,
            f"Deck {deck_id} is already language={source_language!r}; "
            f"only EN decks can be translated in this version.",
        )

    # Pre-check for an existing translation so we can return its deck_id in
    # the 409 body (nicer UX than a bare constraint-violation error; the
    # UNIQUE index below is still the source of truth / race-condition guard).
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM gtm_decks WHERE translated_from_deck_id = ? AND language = ?"
            " AND deleted_at IS NULL",
            [deck_id, req.target_lang],
        ).fetchone()
    if existing:
        raise HTTPException(
            409,
            detail={
                "message": f"A {req.target_lang} translation of this deck already exists.",
                "existing_deck_id": existing["id"],
            },
        )

    source_inputs_dict = json.loads(source_row["inputs_json"])

    # 2026-07-15 pre-flight: reject decks missing the new Description &
    # Razors fields (added in the July revisions) BEFORE we burn a Sonar
    # call.  Legacy decks created before the revisions have empty or
    # missing description_100 / razor_20 / razor_10, and the downstream
    # render_description_razors would blow up with a ValueError.  Fail
    # loudly here with a 400 pointing the user at the fix.
    missing_required: list[str] = []
    for key, label in (
        ("description_100", "100-word description"),
        ("razor_20", "20-word razor"),
        ("razor_10", "10-word razor"),
    ):
        val = source_inputs_dict.get(key)
        if not val or not str(val).strip():
            missing_required.append(f"{label} ({key!r})")
    if missing_required:
        raise HTTPException(
            400,
            detail={
                "message": (
                    "Source deck is missing required fields added in the "
                    "July 2026 revisions. Edit the deck and fill these in "
                    "before translating."
                ),
                "missing": missing_required,
            },
        )

    try:
        translated_inputs_dict = translate_form_inputs(source_inputs_dict, req.target_lang)
    except TranslationError as e:
        raise HTTPException(502, f"Translation failed: {e}")

    # Re-validate through FormInputs to catch any structural corruption from
    # the translation merge before we render or persist anything.
    try:
        translated_inputs = FormInputs(**translated_inputs_dict)
    except Exception as e:
        raise HTTPException(
            502, f"Translated inputs failed validation (translation service bug): {e}"
        )

    theme = source_row["theme"]
    phases_override = None
    if req.target_lang == "ru":
        phases_override = load_ru_roadmap_phases()

    new_deck_id = uuid.uuid4().hex
    deck_dir = LIBRARY_DIR / new_deck_id
    deck_dir.mkdir(parents=True, exist_ok=True)

    try:
        with RENDER_SEMAPHORE:
            result = render_pack_with_artifacts(
                _form_inputs_to_render_dict(translated_inputs),
                theme,
                deck_dir,
                phases_override=phases_override,
                language=req.target_lang,
            )
    except Exception as e:
        shutil.rmtree(deck_dir, ignore_errors=True)
        raise HTTPException(500, f"Translated render failed: {e}")

    pptx_files = list(deck_dir.glob("*.pptx"))
    pdf_files = list(deck_dir.glob("*.pdf"))
    if not pptx_files:
        shutil.rmtree(deck_dir, ignore_errors=True)
        raise HTTPException(500, "PPTX missing from translated render")

    pptx_dst = deck_dir / "deck.pptx"
    if pptx_files[0] != pptx_dst:
        shutil.move(str(pptx_files[0]), str(pptx_dst))
    pdf_dst = None
    if pdf_files:
        pdf_dst = deck_dir / "deck.pdf"
        if pdf_files[0] != pdf_dst:
            shutil.move(str(pdf_files[0]), str(pdf_dst))

    try:
        with get_conn() as conn:
            conn.execute(
                """INSERT INTO gtm_decks
                   (id, title, genre, theme, release_date, inputs_json, is_private,
                    pptx_path, pdf_path, pptx_size_bytes, status, language,
                    translated_from_deck_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)""",
                [
                    new_deck_id,
                    translated_inputs.title,
                    translated_inputs.genre,
                    theme,
                    translated_inputs.release_date,
                    json.dumps(translated_inputs.model_dump()),
                    source_row["is_private"],
                    str(pptx_dst),
                    str(pdf_dst) if pdf_dst else None,
                    pptx_dst.stat().st_size,
                    req.target_lang,
                    deck_id,
                ],
            )
    except sqlite3.IntegrityError as e:
        # Race: another request created the same translation between our
        # pre-check and this INSERT. The UNIQUE index is the real guard.
        shutil.rmtree(deck_dir, ignore_errors=True)
        with get_conn() as conn:
            existing2 = conn.execute(
                "SELECT id FROM gtm_decks WHERE translated_from_deck_id = ? AND language = ?"
                " AND deleted_at IS NULL",
                [deck_id, req.target_lang],
            ).fetchone()
        raise HTTPException(
            409,
            detail={
                "message": f"A {req.target_lang} translation of this deck already exists.",
                "existing_deck_id": existing2["id"] if existing2 else None,
            },
        )

    return {
        "deck_id": new_deck_id,
        "language": req.target_lang,
        "translated_from_deck_id": deck_id,
    }



@app.get("/library/{deck_id}/slides")
def library_slides(deck_id: str):
    """Return (or lazily generate) per-slide PNG URLs for a library deck."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, title, theme, inputs_json, language, translated_from_deck_id"
            " FROM gtm_decks"
            " WHERE id = ? AND deleted_at IS NULL AND is_private = 0",
            [deck_id],
        ).fetchone()
    if not row:
        raise HTTPException(404, "Deck not found")

    # Phase 4: surface language + translated_from_deck_id so the Viewer can
    # show an EN<->RU cross-link chip. `translated_to_deck_id` (the reverse
    # direction, from an EN source to its RU translation if one exists) is
    # resolved separately below since it isn't a column on this row.
    translated_to_deck_id = None
    if row["language"] == "en":
        with get_conn() as conn:
            ru_row = conn.execute(
                "SELECT id FROM gtm_decks WHERE translated_from_deck_id = ?"
                " AND language = 'ru' AND deleted_at IS NULL",
                [deck_id],
            ).fetchone()
        if ru_row:
            translated_to_deck_id = ru_row["id"]

    cache_dir = LIBRARY_DIR / deck_id / "slides"

    # Cache hit: directory exists and has at least one PNG
    if cache_dir.exists():
        cached_pngs = sorted(cache_dir.glob("*.png"))
        if cached_pngs:
            return {
                "deck_id": deck_id,
                "title": row["title"],
                "theme": row["theme"],
                "slide_count": len(cached_pngs),
                "language": row["language"],
                "translated_from_deck_id": row["translated_from_deck_id"],
                "translated_to_deck_id": translated_to_deck_id,
                "pngs": [
                    f"/gtm/api/library/{deck_id}/slides/{p.name}"
                    for p in cached_pngs
                ],
            }

    # Cache miss: render PNGs into cache_dir
    cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        inputs = FormInputs(**json.loads(row["inputs_json"]))
        result = _render_to(cache_dir, inputs, row["theme"])
        pngs: list[Path] = result["pngs"]
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception(
            "Slide render failed for deck %s", deck_id
        )
        # Clean up partial output to avoid a corrupted cache
        shutil.rmtree(cache_dir, ignore_errors=True)
        raise HTTPException(500, f"Slide render failed: {e}")

    return {
        "deck_id": deck_id,
        "title": row["title"],
        "theme": row["theme"],
        "slide_count": len(pngs),
        "language": row["language"],
        "translated_from_deck_id": row["translated_from_deck_id"],
        "translated_to_deck_id": translated_to_deck_id,
        "pngs": [
            f"/gtm/api/library/{deck_id}/slides/{p.name}"
            for p in pngs
        ],
    }


@app.get("/library/{deck_id}/slides/{name}")
def library_slide_png(deck_id: str, name: str):
    """Serve a single cached slide PNG for a library deck."""
    if "/" in name or ".." in name:
        raise HTTPException(400, "Invalid filename")
    if not name.endswith(".png"):
        raise HTTPException(400, "Invalid filename: must end with .png")
    # Visibility check
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM gtm_decks"
            " WHERE id = ? AND deleted_at IS NULL AND is_private = 0",
            [deck_id],
        ).fetchone()
    if not row:
        raise HTTPException(404, "Deck not found")
    p = LIBRARY_DIR / deck_id / "slides" / name
    if not p.exists():
        raise HTTPException(404, "Slide PNG not found")
    return FileResponse(p, media_type="image/png")


# ── Preview workflow ─────────────────────────────────────────────────────────


@app.post("/preview")
def create_preview(req: PreviewRequest):
    """Render a fresh preview. Returns session_id + 12 PNG urls."""
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
        # Numeric-aware sort so 10.png / 11.png / 12.png come after 9.png,
        # not between 1.png and 2.png.  Falls back to lexicographic order
        # for any filename that doesn't have a numeric stem.
        import re as _re
        def _numeric_key(p: Path) -> tuple[int, str]:
            m = _re.match(r"(\d+)", p.stem)
            return (int(m.group(1)) if m else 10_000, p.name)
        pngs = sorted(theme_dir.glob("*.png"), key=_numeric_key)
        # Append the file mtime as a cache-busting query string so browsers
        # pick up newly-seeded PNGs immediately after a deploy re-render,
        # even without a Cache-Control header override. The URL path itself
        # stays stable so nginx / CDN caching on the path is still effective.
        payload["themes"][theme] = [
            f"/gtm/api/example/{theme}/{p.name}?v={int(p.stat().st_mtime)}"
            for p in pngs
        ]
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
    # Force revalidation so stale example PNGs don't linger in browser cache
    # after a re-seed. The ?v=<mtime> query string on the /example JSON URLs
    # is the primary cache-buster; this header is defense-in-depth for any
    # client that hits the PNG endpoint directly without the query string.
    return FileResponse(
        p,
        media_type="image/png",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


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


# Manual in-memory rate limit for login (slowapi decorator conflicts with
# FastAPI's body parsing of Pydantic models). Same semantics: 5 per 15 min per IP.
_LOGIN_ATTEMPTS: dict[str, list[float]] = {}
_LOGIN_RATE_LIMIT = 5
_LOGIN_WINDOW_SECONDS = 15 * 60


def _check_login_rate(ip: str):
    import time
    now = time.time()
    attempts = _LOGIN_ATTEMPTS.get(ip, [])
    # Drop expired
    attempts = [t for t in attempts if now - t < _LOGIN_WINDOW_SECONDS]
    if len(attempts) >= _LOGIN_RATE_LIMIT:
        raise HTTPException(429, "Too many login attempts. Try again in 15 minutes.")
    attempts.append(now)
    _LOGIN_ATTEMPTS[ip] = attempts


@app.post("/admin/login")
def admin_login(request: Request, response: Response, body: LoginRequest):
    ip = get_remote_address(request)
    _check_login_rate(ip)
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
                          body: PasswordChangeRequest,
                          _=Depends(require_admin)):
    """Re-hash and update the password."""
    ip = get_remote_address(request)
    set_new_password_hash(body.new_password)
    _log_admin_action("change_password", None, ip)
    return {"ok": True}
