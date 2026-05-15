"""Phase 6 acceptance: admin auth + delete/restore/audit."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import bcrypt
import pytest
from fastapi.testclient import TestClient

TEST_ROOT = Path("/tmp/gtm_test_admin")
TEST_ROOT.mkdir(parents=True, exist_ok=True)
os.environ["GTM_DB_PATH"] = str(TEST_ROOT / "db.sqlite")
os.environ["GTM_STORAGE_ROOT"] = str(TEST_ROOT / "storage")
os.environ["GTM_ENV_FILE"] = str(TEST_ROOT / ".env")
# Set a known password hash for tests
os.environ["GTM_ADMIN_PASSWORD_HASH"] = bcrypt.hashpw(b"password", bcrypt.gensalt()).decode()
os.environ["GTM_JWT_SECRET"] = "test-secret-fixed"
os.environ["GTM_COOKIE_PATH"] = "/"  # TestClient sees routes at root

# Fresh DB for each test run
if (TEST_ROOT / "db.sqlite").exists():
    (TEST_ROOT / "db.sqlite").unlink()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# Force re-import of main + db so they pick up our test env vars
for mod in ["main", "db", "admin_auth"]:
    if mod in sys.modules:
        del sys.modules[mod]
from gtm_pack.sample_inputs import SAMPLE_INPUTS  # noqa: E402
from main import app  # noqa: E402
from db import init_db  # noqa: E402
init_db()  # re-init at the new path


@pytest.fixture
def client():
    # Reset rate limiter state between tests
    if hasattr(app.state, "limiter"):
        app.state.limiter.reset()
    return TestClient(app)


@pytest.fixture
def admin_client(client):
    """Logged-in admin TestClient."""
    r = client.post("/admin/login", json={"password": "password"})
    assert r.status_code == 200, r.text
    return client


def test_login_wrong_password(client):
    r = client.post("/admin/login", json={"password": "WRONG"})
    assert r.status_code == 401


def test_login_correct_password(client):
    r = client.post("/admin/login", json={"password": "password"})
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert "gtm_admin" in r.cookies


def test_admin_endpoint_requires_auth(client):
    # No login → 401
    r = client.get("/admin/library")
    assert r.status_code == 401


def test_admin_endpoint_with_auth(admin_client):
    r = admin_client.get("/admin/library")
    assert r.status_code == 200


def test_logout_clears_session(admin_client):
    r = admin_client.post("/admin/logout")
    assert r.status_code == 200
    # Subsequent admin call should fail
    r = admin_client.get("/admin/library")
    assert r.status_code == 401


def test_session_check_endpoint(admin_client):
    r = admin_client.get("/admin/session")
    assert r.status_code == 200
    assert r.json()["authenticated"] is True


def test_delete_and_restore_deck(admin_client):
    # Create a deck via preview→commit
    r = admin_client.post("/preview", json={"inputs": SAMPLE_INPUTS, "theme": "dark"})
    assert r.status_code == 200
    sid = r.json()["session_id"]
    r = admin_client.post(f"/preview/{sid}/commit", json={"is_private": False})
    deck_id = r.json()["deck_id"]

    # Delete (soft)
    r = admin_client.delete(f"/admin/library/{deck_id}")
    assert r.status_code == 200

    # Public library no longer shows it
    r = admin_client.get("/library")
    ids = [d["id"] for d in r.json()["decks"]]
    assert deck_id not in ids

    # Admin library still shows it with deleted_at populated
    r = admin_client.get("/admin/library")
    rec = next(d for d in r.json()["decks"] if d["id"] == deck_id)
    assert rec["deleted_at"] is not None

    # Restore
    r = admin_client.post(f"/admin/library/{deck_id}/restore")
    assert r.status_code == 200
    r = admin_client.get("/library")
    ids = [d["id"] for d in r.json()["decks"]]
    assert deck_id in ids


def test_purge_removes_deck_entirely(admin_client):
    r = admin_client.post("/preview", json={"inputs": SAMPLE_INPUTS, "theme": "dark"})
    sid = r.json()["session_id"]
    r = admin_client.post(f"/preview/{sid}/commit", json={"is_private": False})
    deck_id = r.json()["deck_id"]

    r = admin_client.delete(f"/admin/library/{deck_id}/purge")
    assert r.status_code == 200

    r = admin_client.get("/admin/library")
    ids = [d["id"] for d in r.json()["decks"]]
    assert deck_id not in ids


def test_audit_log_records_actions(admin_client):
    # Login itself should be logged. Plus the actions above.
    r = admin_client.get("/admin/audit")
    assert r.status_code == 200
    actions = r.json()["actions"]
    action_types = {a["action"] for a in actions}
    assert "login" in action_types


def test_change_password_works_end_to_end(admin_client):
    new_pwd = "newp@ssw0rd"
    r = admin_client.post("/admin/password", json={"new_password": new_pwd})
    assert r.status_code == 200

    # Logout
    admin_client.post("/admin/logout")

    # Old password should fail
    r = admin_client.post("/admin/login", json={"password": "password"})
    assert r.status_code == 401

    # New password should work
    r = admin_client.post("/admin/login", json={"password": new_pwd})
    assert r.status_code == 200

    # Reset to "password" for downstream tests
    r = admin_client.post("/admin/password", json={"new_password": "password"})
    assert r.status_code == 200


def test_short_password_rejected(admin_client):
    r = admin_client.post("/admin/password", json={"new_password": "abc"})
    assert r.status_code == 422
