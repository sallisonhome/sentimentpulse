"""Tests for the Bluesky proactive-refresh + auth-health + force-recreate
hardening shipped 2026-06-07.

Covers items #1, #2, and the helpers used by #4 from the post-incident plan:
  #1  get_access_jwt() proactively refreshes when session age >= 50min
  #2  auth_health flips to 'refresh_failed' / 'create_failed' on auth errors
  #4  force_recreate() drops cached tokens + runs createSession from scratch
"""
import time
from unittest.mock import patch

import pytest
import requests_mock as requests_mock_module

from services.bluesky_service import _BlueskySession
import services.bluesky_service as bsvc

CREATE_SESSION_URL = f"{bsvc.BLUESKY_BASE}/xrpc/com.atproto.server.createSession"
REFRESH_SESSION_URL = f"{bsvc.BLUESKY_BASE}/xrpc/com.atproto.server.refreshSession"


def _ok_create():
    return {
        "accessJwt": "access-jwt-v1",
        "refreshJwt": "refresh-jwt-v1",
        "handle": "test.bsky.social",
        "did": "did:plc:test",
    }


def _ok_refresh():
    return {
        "accessJwt": "access-jwt-v2",
        "refreshJwt": "refresh-jwt-v2",
        "handle": "test.bsky.social",
        "did": "did:plc:test",
    }


# ── #1 Proactive refresh ─────────────────────────────────────────────────────

def test_session_age_seconds_none_before_creation():
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    assert sess.session_age_seconds() is None
    assert sess.needs_proactive_refresh() is False


def test_get_access_jwt_records_creation_time():
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_ok_create())
        jwt = sess.get_access_jwt()
    assert jwt == "access-jwt-v1"
    age = sess.session_age_seconds()
    assert age is not None and age < 5  # just created
    assert sess.auth_health == "ok"


def test_proactive_refresh_fires_when_session_aged_past_threshold():
    """#1: a 50min+ old session must trigger refresh on next get_access_jwt."""
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_ok_create())
        m.post(REFRESH_SESSION_URL, json=_ok_refresh())
        # First call: creates session
        sess.get_access_jwt()
        # Pretend the session is 51min old
        sess._session_created_at = time.time() - (51 * 60)
        # Next call should trigger refresh and return the new JWT
        jwt = sess.get_access_jwt()

    assert jwt == "access-jwt-v2", "proactive refresh should have rotated the JWT"
    # And the timestamp should be fresh
    age = sess.session_age_seconds()
    assert age is not None and age < 5


def test_proactive_refresh_does_not_fire_for_fresh_session():
    """A session under the threshold must NOT refresh on get_access_jwt."""
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_ok_create())
        m.post(REFRESH_SESSION_URL, json=_ok_refresh())
        sess.get_access_jwt()
        # 10 minutes old — under threshold
        sess._session_created_at = time.time() - (10 * 60)
        jwt = sess.get_access_jwt()
        refresh_calls = [r for r in m.request_history if REFRESH_SESSION_URL in r.url]

    assert jwt == "access-jwt-v1"
    assert len(refresh_calls) == 0


def test_proactive_refresh_failure_keeps_existing_jwt():
    """If proactive refresh fails (refresh AND re-create both return non-200),
    the existing JWT is kept — reactive 401 handling will catch any later
    failure, and we'd rather try the existing token than nuke our session."""
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_ok_create())
        sess.get_access_jwt()
        sess._session_created_at = time.time() - (51 * 60)

        # Both refresh AND re-create fail
        m.post(REFRESH_SESSION_URL, status_code=400, json={"error": "ExpiredToken"})
        m.post(CREATE_SESSION_URL, status_code=429, text="rate limited")
        jwt = sess.get_access_jwt()

    # NOTE: refresh+create both failed → _create_session_locked wipes _access_jwt.
    # So jwt is None.  Auth_health surfaces the failure to the caller.
    assert jwt is None
    assert sess.auth_health == "refresh_failed"


# ── #2 Auth-health snapshot ──────────────────────────────────────────────────

def test_create_session_failure_sets_create_failed():
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, status_code=401, text="bad password")
        ok = sess._create_session()
    assert ok is False
    assert sess.auth_health == "create_failed"


def test_refresh_failure_then_recreate_success_sets_ok():
    """When refresh fails but the subsequent re-createSession succeeds, the
    final auth_health must be 'ok' — only total failure flips to broken."""
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, [
            {"json": _ok_create()},  # initial
            {"json": _ok_create()},  # re-login after refresh fails
        ])
        m.post(REFRESH_SESSION_URL, status_code=400)
        sess.get_access_jwt()           # creates session
        ok = sess.refresh()             # refresh fails → re-createSession runs
    assert ok is True
    assert sess.auth_health == "ok"


def test_refresh_and_recreate_both_fail_sets_refresh_failed():
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, [
            {"json": _ok_create()},
            {"status_code": 401, "text": "bad password"},
        ])
        m.post(REFRESH_SESSION_URL, status_code=400)
        sess.get_access_jwt()
        ok = sess.refresh()
    assert ok is False
    assert sess.auth_health == "refresh_failed"


def test_get_auth_health_returns_none_when_no_session():
    """Module-level helper returns None before any session is created."""
    # Reset the singleton for this test
    with patch.object(bsvc, "_session", None):
        assert bsvc.get_auth_health() is None


# ── #4 force_recreate ────────────────────────────────────────────────────────

def test_force_recreate_drops_cached_tokens_and_calls_create_session():
    """#4: force_recreate must NOT use the cached refreshJwt — it must call
    createSession from scratch.  Otherwise a stuck-state refreshJwt would
    survive the recovery attempt."""
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, [
            {"json": _ok_create()},                                    # initial
            {"json": {"accessJwt": "fresh", "refreshJwt": "fresh-r",   # force_recreate
                      "handle": "test.bsky.social", "did": "did:plc:test"}},
        ])
        sess.get_access_jwt()
        # Now force_recreate
        ok = sess.force_recreate()
        refresh_calls = [r for r in m.request_history if REFRESH_SESSION_URL in r.url]
        create_calls = [r for r in m.request_history if CREATE_SESSION_URL in r.url]

    assert ok is True
    assert sess._access_jwt == "fresh"
    # Refresh endpoint should NEVER be hit by force_recreate
    assert len(refresh_calls) == 0
    # createSession called twice (initial + force_recreate)
    assert len(create_calls) == 2


def test_force_recreate_failure_returns_false_and_sets_create_failed():
    sess = _BlueskySession("test.bsky.social", "app-password-here")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, [
            {"json": _ok_create()},
            {"status_code": 401, "text": "bad password"},
        ])
        sess.get_access_jwt()
        ok = sess.force_recreate()
    assert ok is False
    assert sess.auth_health == "create_failed"
