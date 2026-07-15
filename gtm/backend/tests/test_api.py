"""Phase 1 acceptance: exercise every public endpoint."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Use a temp DB + storage for tests
TEST_ROOT = Path("/tmp/gtm_test_api")
TEST_ROOT.mkdir(parents=True, exist_ok=True)
os.environ["GTM_DB_PATH"] = str(TEST_ROOT / "db.sqlite")
os.environ["GTM_STORAGE_ROOT"] = str(TEST_ROOT / "storage")
# Remove stale db so we start fresh each test run
if (TEST_ROOT / "db.sqlite").exists():
    (TEST_ROOT / "db.sqlite").unlink()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gtm_pack.sample_inputs import SAMPLE_INPUTS  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_roadmap_defaults():
    r = client.get("/defaults/roadmap_phases")
    assert r.status_code == 200
    data = r.json()
    assert "slides" in data
    assert "summary_events" in data


def test_library_empty():
    r = client.get("/library")
    assert r.status_code == 200
    assert r.json()["total"] == 0
    assert r.json()["decks"] == []


@pytest.fixture(scope="module")
def session_id():
    """Create a preview session that other tests can use."""
    r = client.post("/preview", json={"inputs": SAMPLE_INPUTS, "theme": "dark"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["slide_count"] == 6  # v6.0: 6 slides (roadmap dropped 2026-07-15)
    assert len(data["pngs"]) == 6
    return data["session_id"]


def test_preview_creates_session(session_id):
    # The fixture already asserts; this test just confirms the side effect.
    assert session_id


def test_preview_png_404_on_bogus(session_id):
    r = client.get(f"/preview/{session_id}/png/nonexistent.png")
    assert r.status_code == 404


def test_preview_commit(session_id):
    r = client.post(f"/preview/{session_id}/commit", json={"is_private": False})
    assert r.status_code == 200
    deck_id = r.json()["deck_id"]
    assert deck_id

    # Library should now have 1 deck
    r = client.get("/library")
    assert r.json()["total"] >= 1

    # Fetch the deck
    r = client.get(f"/library/{deck_id}")
    assert r.status_code == 200
    assert r.json()["theme"] == "dark"

    # Clone returns inputs
    r = client.get(f"/library/{deck_id}/clone")
    assert r.status_code == 200
    inputs = r.json()["inputs"]
    assert inputs["title"] == SAMPLE_INPUTS["title"]

    # Download PPTX
    r = client.get(f"/library/{deck_id}/download?format=pptx")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats")

    # Download PDF
    r = client.get(f"/library/{deck_id}/download?format=pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"


def test_private_deck_hidden_from_library():
    # Create a private deck
    r = client.post("/preview", json={"inputs": SAMPLE_INPUTS, "theme": "light"})
    assert r.status_code == 200
    sid = r.json()["session_id"]
    r = client.post(f"/preview/{sid}/commit", json={"is_private": True})
    assert r.status_code == 200
    private_id = r.json()["deck_id"]

    # Public library does not include it
    r = client.get("/library?theme=light")
    ids = [d["id"] for d in r.json()["decks"]]
    assert private_id not in ids

    # Direct GET fails (returns 404 because deleted_at IS NULL AND is_private = 0)
    r = client.get(f"/library/{private_id}")
    assert r.status_code == 404

    # Admin endpoint now requires auth (added in Phase 6)
    r = client.get("/admin/library")
    assert r.status_code == 401  # unauthenticated
