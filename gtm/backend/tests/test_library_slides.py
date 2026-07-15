"""Tests for GET /library/{deck_id}/slides and GET /library/{deck_id}/slides/{name}."""

from __future__ import annotations

import json
import os
import shutil as _shutil
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

# ── Test environment setup ────────────────────────────────────────────────────
# These env vars must be set BEFORE any import of main or db so the module-level
# constants (LIBRARY_DIR, DB_PATH etc.) are initialised with the test paths.

TEST_STORAGE = Path("/tmp/gtm_test_library_slides/storage")
TEST_DB = Path("/tmp/gtm_test_library_slides/db.sqlite")
TEST_LIBRARY_DIR = TEST_STORAGE / "library"

# Wipe the entire test root on each collection so stale on-disk slide caches
# from a prior pytest run do not pollute assertions.
_test_root = TEST_DB.parent
if _test_root.exists():
    _shutil.rmtree(_test_root)
_test_root.mkdir(parents=True, exist_ok=True)
TEST_LIBRARY_DIR.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Set env vars temporarily to import main and init the DB, then restore them.
# This prevents our collection-time env settings from clobbering other test
# files (test_admin_auth.py, test_api.py) that also set GTM_DB_PATH at module level.
_prev_db = os.environ.get("GTM_DB_PATH")
_prev_storage = os.environ.get("GTM_STORAGE_ROOT")
os.environ["GTM_DB_PATH"] = str(TEST_DB)
os.environ["GTM_STORAGE_ROOT"] = str(TEST_STORAGE)

from main import app  # noqa: E402
from db import init_db, get_conn  # noqa: E402
import main as _main  # noqa: E402 - needed to patch LIBRARY_DIR per-test

# Initialise our test DB schema.
init_db()

# Restore env vars immediately so other test files are not affected.
if _prev_db is None:
    os.environ.pop("GTM_DB_PATH", None)
else:
    os.environ["GTM_DB_PATH"] = _prev_db
if _prev_storage is None:
    os.environ.pop("GTM_STORAGE_ROOT", None)
else:
    os.environ["GTM_STORAGE_ROOT"] = _prev_storage

client = TestClient(app)

# ── Sample inputs ─────────────────────────────────────────────────────────────
from gtm_pack.sample_inputs import SAMPLE_INPUTS  # noqa: E402

# 12 fake PNGs — matches the current 12-slide pack (name kept for git-blame history)
NINE_FAKE_PNGS = [f"slide-{i+1:02d}.png" for i in range(12)]


# ── autouse fixture: pin LIBRARY_DIR and DB to our test paths ──────────────────
# When the full test suite is collected in one pytest process, other test files
# may change env vars or reimport main with a different LIBRARY_DIR.
# We patch main.LIBRARY_DIR for each test and re-set GTM_DB_PATH in the env.

@pytest.fixture(autouse=True)
def _isolate_storage():
    """Pin main.LIBRARY_DIR and GTM_DB_PATH to our test directories each test.

    NOTE: We do NOT restore GTM_DB_PATH on teardown because env vars are
    process-global and any test file that cares about its DB path sets it
    at module import time (before tests run). Restoring here would clobber
    the env for subsequent test files that also set it at module-level.
    """
    TEST_LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
    os.environ["GTM_DB_PATH"] = str(TEST_DB)
    with patch.object(_main, "LIBRARY_DIR", TEST_LIBRARY_DIR):
        yield TEST_LIBRARY_DIR


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_fake_render_to(out_dir_capture: list | None = None):
    """Return a mock _render_to that writes 12 fake PNGs to the given out_dir."""

    def fake_render_to(out_dir: Path, inputs, theme: str):
        if out_dir_capture is not None:
            out_dir_capture.append(out_dir)
        pngs = []
        for name in NINE_FAKE_PNGS:
            p = out_dir / name
            p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)  # minimal fake PNG
            pngs.append(p)
        return {
            "pngs": pngs,
            "pptx": out_dir / "deck.pptx",
            "pdf": out_dir / "deck.pdf",
        }

    return fake_render_to


def _insert_deck(
    deck_id: str,
    *,
    is_private: int = 0,
    deleted_at=None,
) -> Path:
    """Insert a minimal deck row and create the library directory with pptx stub."""
    deck_dir = TEST_LIBRARY_DIR / deck_id
    deck_dir.mkdir(parents=True, exist_ok=True)
    pptx_path = deck_dir / "deck.pptx"
    pptx_path.write_bytes(b"PK stub")

    with get_conn() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO gtm_decks
               (id, title, genre, theme, release_date, inputs_json,
                is_private, pptx_path, pdf_path, pptx_size_bytes, status, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 7, 'ready', ?)""",
            [
                deck_id,
                f"Test Deck {deck_id}",
                "RPG",
                "dark",
                "2026-01-01",
                json.dumps(SAMPLE_INPUTS),
                is_private,
                str(pptx_path),
                deleted_at,
            ],
        )
    return deck_dir


# ── Tests: GET /library/{deck_id}/slides ─────────────────────────────────────


def test_slides_404_unknown_deck():
    """Returns 404 when the deck_id does not exist in the DB."""
    r = client.get("/library/nonexistent-deck-id/slides")
    assert r.status_code == 404


def test_slides_404_deleted_deck():
    """Returns 404 for a soft-deleted deck."""
    deck_id = "deleted-deck-001"
    _insert_deck(deck_id, deleted_at="2025-01-01 00:00:00")
    r = client.get(f"/library/{deck_id}/slides")
    assert r.status_code == 404


def test_slides_404_private_deck():
    """Returns 404 for a private deck (is_private = 1)."""
    deck_id = "private-deck-001"
    _insert_deck(deck_id, is_private=1)
    r = client.get(f"/library/{deck_id}/slides")
    assert r.status_code == 404


def test_slides_renders_on_first_call():
    """First call with no cache triggers render and returns 9 PNG URLs."""
    deck_id = "fresh-deck-001"
    _insert_deck(deck_id)
    # Ensure no stale slides cache
    _shutil.rmtree(TEST_LIBRARY_DIR / deck_id / "slides", ignore_errors=True)

    with patch("main._render_to", side_effect=_make_fake_render_to()):
        r = client.get(f"/library/{deck_id}/slides")

    assert r.status_code == 200
    data = r.json()
    assert data["deck_id"] == deck_id
    assert data["slide_count"] == 12
    assert len(data["pngs"]) == 12
    # URLs should point at the new slides endpoint
    for url in data["pngs"]:
        assert url.startswith(f"/gtm/api/library/{deck_id}/slides/")
        assert url.endswith(".png")


def test_slides_returns_title_and_theme():
    """Response includes the deck's title and theme."""
    deck_id = "meta-deck-001"
    _insert_deck(deck_id)
    _shutil.rmtree(TEST_LIBRARY_DIR / deck_id / "slides", ignore_errors=True)

    with patch("main._render_to", side_effect=_make_fake_render_to()):
        r = client.get(f"/library/{deck_id}/slides")

    assert r.status_code == 200
    data = r.json()
    assert data["title"] == f"Test Deck {deck_id}"
    assert data["theme"] == "dark"


def test_slides_uses_cache_on_second_call():
    """Second call must not invoke _render_to — it should use the on-disk cache."""
    deck_id = "cache-hit-deck-001"
    deck_dir = _insert_deck(deck_id)
    _shutil.rmtree(deck_dir / "slides", ignore_errors=True)

    call_count = {"n": 0}

    def counting_render(out_dir, inputs, theme):
        call_count["n"] += 1
        return _make_fake_render_to()(out_dir, inputs, theme)

    # First call — populates cache
    with patch("main._render_to", side_effect=counting_render):
        r1 = client.get(f"/library/{deck_id}/slides")
    assert r1.status_code == 200
    assert call_count["n"] == 1

    # Second call — should NOT call _render_to
    with patch("main._render_to", side_effect=counting_render):
        r2 = client.get(f"/library/{deck_id}/slides")
    assert r2.status_code == 200
    assert call_count["n"] == 1, "Cache miss on second call — _render_to was invoked again"


def test_slides_cache_survives_with_extra_png():
    """Cache is still hit if we add an extra PNG between calls — result count reflects disk."""
    deck_id = "cache-extra-deck-001"
    deck_dir = _insert_deck(deck_id)
    _shutil.rmtree(deck_dir / "slides", ignore_errors=True)

    with patch("main._render_to", side_effect=_make_fake_render_to()):
        client.get(f"/library/{deck_id}/slides")

    # Manually add a bonus PNG to the cache dir
    bonus = TEST_LIBRARY_DIR / deck_id / "slides" / "bonus.png"
    bonus.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 10)

    # Second call — cache hit, returns all PNGs (including the bonus)
    with patch("main._render_to") as mock_render:
        r = client.get(f"/library/{deck_id}/slides")
        mock_render.assert_not_called()

    assert r.status_code == 200
    # 12 originals + 1 bonus
    assert r.json()["slide_count"] == 13


def test_slides_render_failure_returns_500_and_cleans_up():
    """If _render_to raises, the endpoint returns 500 and deletes the partial cache dir."""
    deck_id = "fail-render-deck-001"
    _insert_deck(deck_id)
    _shutil.rmtree(TEST_LIBRARY_DIR / deck_id / "slides", ignore_errors=True)

    def boom(out_dir, inputs, theme):
        # Write one PNG then explode
        (out_dir / "slide-01.png").write_bytes(b"\x89PNG")
        raise RuntimeError("render engine exploded")

    with patch("main._render_to", side_effect=boom):
        r = client.get(f"/library/{deck_id}/slides")

    assert r.status_code == 500
    assert "Slide render failed" in r.json()["detail"]
    # Cache directory must be gone (cleaned up)
    cache_dir = TEST_LIBRARY_DIR / deck_id / "slides"
    assert not cache_dir.exists(), "Partial cache dir was not cleaned up after render failure"


# ── Tests: GET /library/{deck_id}/slides/{name} ───────────────────────────────


def test_slide_png_404_on_missing_name():
    """Returns 404 when the requested PNG file does not exist in the cache."""
    deck_id = "png-serve-001"
    _insert_deck(deck_id)
    r = client.get(f"/library/{deck_id}/slides/nonexistent.png")
    assert r.status_code == 404


def test_slide_png_rejects_path_traversal_dotdot():
    """Rejects filenames containing '..' (path traversal attempt)."""
    deck_id = "png-serve-001"  # already inserted above
    r = client.get(f"/library/{deck_id}/slides/..%2Fsecret.png")
    # FastAPI decodes the path param; the endpoint should return 400
    assert r.status_code in (400, 404)


def test_slide_png_rejects_slash_in_name():
    """Rejects names that contain '/' (sub-path traversal attempt)."""
    deck_id = "png-serve-001"
    r = client.get(f"/library/{deck_id}/slides/sub%2Fpath.png")
    assert r.status_code in (400, 404)


def test_slide_png_serves_valid_file():
    """Serves a real PNG file with correct media type."""
    deck_id = "png-serve-002"
    _insert_deck(deck_id)

    # Manually populate the cache with a fake PNG
    slides_dir = TEST_LIBRARY_DIR / deck_id / "slides"
    slides_dir.mkdir(parents=True, exist_ok=True)
    png_name = "slide-01.png"
    (slides_dir / png_name).write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 200)

    r = client.get(f"/library/{deck_id}/slides/{png_name}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"


def test_slide_png_404_for_private_deck():
    """Slide PNG endpoint also returns 404 for private decks."""
    deck_id = "private-png-001"
    _insert_deck(deck_id, is_private=1)

    # Populate cache so we know the 404 comes from auth not missing file
    slides_dir = TEST_LIBRARY_DIR / deck_id / "slides"
    slides_dir.mkdir(parents=True, exist_ok=True)
    (slides_dir / "slide-01.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    r = client.get(f"/library/{deck_id}/slides/slide-01.png")
    assert r.status_code == 404


def test_slide_png_404_for_deleted_deck():
    """Slide PNG endpoint also returns 404 for soft-deleted decks."""
    deck_id = "deleted-png-001"
    _insert_deck(deck_id, deleted_at="2025-01-01 00:00:00")

    slides_dir = TEST_LIBRARY_DIR / deck_id / "slides"
    slides_dir.mkdir(parents=True, exist_ok=True)
    (slides_dir / "slide-01.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    r = client.get(f"/library/{deck_id}/slides/slide-01.png")
    assert r.status_code == 404
