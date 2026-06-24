"""Integration tests for /api/digest endpoints."""
from unittest.mock import patch

import pytest

from models import DigestRecipient


# ── Recipients CRUD ──────────────────────────────────────────────────────────

class TestRecipientsCRUD:
    def test_list_empty(self, client):
        r = client.get("/api/digest/recipients")
        assert r.status_code == 200
        assert r.json() == []

    def test_add_valid(self, client):
        r = client.post("/api/digest/recipients",
                        json={"email": "steve.allison.home@yahoo.com"})
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["email"] == "steve.allison.home@yahoo.com"
        assert body["is_active"] is True

    def test_add_normalizes_lowercase_and_whitespace(self, client):
        r = client.post("/api/digest/recipients",
                        json={"email": "  Steve@Example.COM  "})
        assert r.status_code == 201
        assert r.json()["email"] == "steve@example.com"

    def test_add_rejects_invalid_email(self, client):
        r = client.post("/api/digest/recipients", json={"email": "not-an-email"})
        assert r.status_code == 422

    def test_add_duplicate_returns_409(self, client):
        client.post("/api/digest/recipients", json={"email": "a@b.com"})
        r = client.post("/api/digest/recipients", json={"email": "a@b.com"})
        assert r.status_code == 409
        assert "already exists" in r.json()["detail"]

    def test_delete(self, client):
        client.post("/api/digest/recipients", json={"email": "a@b.com"})
        listed = client.get("/api/digest/recipients").json()
        rid = listed[0]["id"]
        r = client.delete(f"/api/digest/recipients/{rid}")
        assert r.status_code == 204
        assert client.get("/api/digest/recipients").json() == []

    def test_delete_missing_returns_404(self, client):
        r = client.delete("/api/digest/recipients/99999")
        assert r.status_code == 404

    def test_patch_deactivates(self, client):
        client.post("/api/digest/recipients", json={"email": "a@b.com"})
        rid = client.get("/api/digest/recipients").json()[0]["id"]
        r = client.patch(f"/api/digest/recipients/{rid}", json={"is_active": False})
        assert r.status_code == 200
        assert r.json()["is_active"] is False


# ── Preview ──────────────────────────────────────────────────────────────────

class TestPreview:
    def test_preview_weekly_returns_html(self, client, publisher):
        # Even with no games seeded the renderer should produce valid HTML
        # full of "no qualifying posts" placeholders.
        r = client.get("/api/digest/preview/weekly")
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]
        body = r.text
        assert "<!DOCTYPE html>" in body
        assert "Weekly Executive Digest" in body
        # All 8 title names should appear in the placeholder
        from services.digest_service import PRIORITY_TITLES
        import html as _h
        for _, name in PRIORITY_TITLES:
            assert _h.escape(name) in body

    def test_preview_monthly_returns_html(self, client, publisher):
        r = client.get("/api/digest/preview/monthly")
        assert r.status_code == 200
        assert "Monthly Executive Digest" in r.text


# ── Manual send ──────────────────────────────────────────────────────────────

class TestManualSend:
    def test_send_weekly_with_no_recipients(self, client, publisher):
        r = client.post("/api/digest/send/weekly")
        assert r.status_code == 200
        body = r.json()
        assert body["sent"] is False
        assert body["reason"] == "no_recipients"

    def test_send_monthly_with_no_recipients(self, client, publisher):
        r = client.post("/api/digest/send/monthly")
        assert r.status_code == 200
        assert r.json()["sent"] is False
