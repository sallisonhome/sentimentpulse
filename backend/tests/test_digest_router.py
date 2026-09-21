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
    """v0032 (2026-09-21): /preview/weekly is now cache-first, non-blocking.
    Cold-cache hits return 202 + a meta-refresh placeholder (fast), warm-cache
    hits return 200 + the real digest HTML. See routers/digest.py.
    """

    def test_preview_weekly_cold_cache_returns_placeholder_202(self, client, publisher):
        # Fresh test-DB — no cache entry exists, so first call returns 202
        # + the meta-refresh placeholder. The heavy build runs in a daemon
        # thread; the request itself finishes in <100ms.
        from routers import digest as _d
        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_CACHE.clear()
            _d._PREVIEW_BUILD_INFLIGHT.clear()

        # Patch the background builder so this test never touches Claude.
        from unittest.mock import patch
        with patch("routers.digest._build_weekly_preview_background"):
            r = client.get("/api/digest/preview/weekly")
        assert r.status_code == 202
        assert "text/html" in r.headers["content-type"]
        assert "Building the weekly digest" in r.text
        assert "meta http-equiv=\"refresh\"" in r.text

        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_CACHE.clear()
            _d._PREVIEW_BUILD_INFLIGHT.clear()

    def test_preview_weekly_warm_cache_returns_html_200(self, client, publisher):
        from routers import digest as _d
        from services.digest_service import _weekly_window_end
        from datetime import date
        window_end_iso = _weekly_window_end(date.today()).isoformat()

        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_CACHE.clear()
            _d._PREVIEW_BUILD_INFLIGHT.clear()
            _d._PREVIEW_CACHE[("weekly", window_end_iso)] = {
                "html": "<!DOCTYPE html><html><body>Weekly Executive Digest — test-seeded body</body></html>",
                "subject": "Weekly Executive Digest — test",
                "built_at": "2026-09-21T14:00:00+00:00",
            }

        r = client.get("/api/digest/preview/weekly")
        assert r.status_code == 200
        assert "Weekly Executive Digest" in r.text
        assert "test-seeded body" in r.text

        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_CACHE.clear()

    def test_preview_weekly_status_idle_pending_ready(self, client, publisher):
        from routers import digest as _d
        from services.digest_service import _weekly_window_end
        from datetime import date
        window_end_iso = _weekly_window_end(date.today()).isoformat()
        key = ("weekly", window_end_iso)

        # Idle.
        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_CACHE.clear()
            _d._PREVIEW_BUILD_INFLIGHT.clear()
            _d._PREVIEW_LAST_ERROR.clear()
        r = client.get("/api/digest/preview/weekly/status")
        assert r.status_code == 200
        assert r.json() == {"status": "idle", "window_end": window_end_iso}

        # Pending.
        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_BUILD_INFLIGHT.add(key)
        r = client.get("/api/digest/preview/weekly/status")
        assert r.json() == {"status": "pending", "window_end": window_end_iso}
        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_BUILD_INFLIGHT.discard(key)

        # Ready.
        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_CACHE[key] = {
                "html": "<html>x</html>",
                "subject": "Test subject",
                "built_at": "2026-09-21T14:00:00+00:00",
            }
        body = client.get("/api/digest/preview/weekly/status").json()
        assert body["status"] == "ready"
        assert body["window_end"] == window_end_iso
        assert body["subject"] == "Test subject"
        assert body["built_at"] == "2026-09-21T14:00:00+00:00"

        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_CACHE.clear()

    def test_preview_weekly_status_error_state(self, client, publisher):
        from routers import digest as _d
        from services.digest_service import _weekly_window_end
        from datetime import date
        window_end_iso = _weekly_window_end(date.today()).isoformat()
        key = ("weekly", window_end_iso)

        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_CACHE.clear()
            _d._PREVIEW_BUILD_INFLIGHT.clear()
            _d._PREVIEW_LAST_ERROR.clear()
            _d._PREVIEW_LAST_ERROR[key] = "RuntimeError: simulated build failure"
        body = client.get("/api/digest/preview/weekly/status").json()
        assert body["status"] == "error"
        assert body["window_end"] == window_end_iso
        assert "simulated build failure" in body["error"]
        with _d._PREVIEW_CACHE_LOCK:
            _d._PREVIEW_LAST_ERROR.clear()

    def test_preview_monthly_returns_html(self, client, publisher):
        r = client.get("/api/digest/preview/monthly")
        assert r.status_code == 200
        assert "Monthly Executive Digest" in r.text


# ── Manual send ──────────────────────────────────────────────────────────────

class TestManualSend:
    """v0032 (2026-09-21): the /send endpoints are now fire-and-forget
    (non-blocking). They return {status: 'started' | 'already_running'}
    in <100ms and run the actual build + Resend send on a background
    thread. The old assertion `body["sent"] == False` was the *sync* build
    result on a fixture with zero recipients; that outcome now shows up
    only in the journalctl log, not the HTTP response.
    """
    def _drain_inflight(self):
        from routers import digest as _d
        with _d._SEND_INFLIGHT_LOCK:
            _d._SEND_INFLIGHT.clear()

    def test_send_weekly_returns_started(self, client, publisher):
        self._drain_inflight()
        r = client.post("/api/digest/send/weekly")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] in ("started", "already_running")
        assert body["kind"] == "weekly"
        # Default: no banner requested.
        assert body.get("banner_injected") is False

    def test_send_monthly_returns_started(self, client, publisher):
        self._drain_inflight()
        r = client.post("/api/digest/send/monthly")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] in ("started", "already_running")
        assert body["kind"] == "monthly"

    def test_send_weekly_with_banner_flag(self, client, publisher):
        """POST /send/weekly with {banner_html: "..."} echoes
        banner_injected=True and forwards the banner to the background
        sender. We verify the HTTP contract here; the actual injection
        into the sent HTML is exercised by test_inject_banner_* below.
        """
        self._drain_inflight()
        r = client.post(
            "/api/digest/send/weekly",
            json={"banner_html": "<div>correction notice</div>"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] in ("started", "already_running")
        assert body["kind"] == "weekly"
        assert body["banner_injected"] is True


class TestInjectBanner:
    """Direct tests of digest_service._inject_banner — pure string surgery,
    no DB or LLM dependencies."""

    def test_injects_after_body_tag(self):
        from services.digest_service import _inject_banner
        html = "<html><head></head><body><h1>digest</h1></body></html>"
        out = _inject_banner(html, "<div>BANNER</div>")
        assert out == "<html><head></head><body><div>BANNER</div><h1>digest</h1></body></html>"

    def test_no_body_tag_prepends(self):
        from services.digest_service import _inject_banner
        out = _inject_banner("<h1>digest</h1>", "<div>B</div>")
        assert out.startswith("<div>B</div>")

    def test_empty_banner_is_noop(self):
        from services.digest_service import _inject_banner
        html = "<html><body>x</body></html>"
        assert _inject_banner(html, "") == html

    def test_none_banner_is_noop(self):
        from services.digest_service import _inject_banner
        html = "<html><body>x</body></html>"
        assert _inject_banner(html, None) == html
