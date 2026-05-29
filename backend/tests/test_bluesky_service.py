"""
Tests for bluesky_service.py

All HTTP calls are mocked with requests_mock so tests run offline and fast.

Bluesky searchPosts response shape:
    {
      "posts": [
        {
          "uri": "at://did:plc:.../app.bsky.feed.post/rkey",
          "cid": "...",
          "author": {"did": "did:plc:...", "handle": "user.bsky.social"},
          "record": {"text": "...", "createdAt": "2026-05-29T18:00:00Z"},
          "likeCount": 5,
          "replyCount": 0,
          "repostCount": 0
        }
      ],
      "cursor": "..."
    }
"""
import time
from datetime import datetime
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pytest
import requests_mock as requests_mock_module

import services.bluesky_service as bsky_mod
from services.bluesky_service import (
    BLUESKY_BASE,
    BLUESKY_MAX_PAGES,
    BLUESKY_SEARCH_PATH,
    _BlueskySession,
    _get_session,
    fetch_bluesky_posts_for_game,
)

SEARCH_URL = f"{BLUESKY_BASE}{BLUESKY_SEARCH_PATH}"
CREATE_SESSION_URL = f"{BLUESKY_BASE}/xrpc/com.atproto.server.createSession"
REFRESH_SESSION_URL = f"{BLUESKY_BASE}/xrpc/com.atproto.server.refreshSession"

FAKE_ACCESS_JWT = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.access.fake"
FAKE_REFRESH_JWT = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.refresh.fake"
FAKE_ACCESS_JWT_2 = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.access.fake2"
FAKE_REFRESH_JWT_2 = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.refresh.fake2"


# ── Fixtures ───────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _reset_singleton(monkeypatch):
    """Reset the module-level _session singleton before each test.

    Without this, singleton state leaks between tests that set env vars.
    """
    monkeypatch.setattr(bsky_mod, "_session", None)
    yield
    monkeypatch.setattr(bsky_mod, "_session", None)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Silence inter-page sleep in all tests for speed."""
    monkeypatch.setattr(time, "sleep", lambda _: None)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_post(
    uri: str = "at://did:plc:abc123/app.bsky.feed.post/rkey1",
    handle: str = "user.bsky.social",
    text: str = "Space Marine 2 is an amazing game!",
    created_at: str = "2026-05-29T18:00:00Z",
    like_count: int = 5,
) -> dict:
    """Build a minimal Bluesky searchPosts post dict."""
    return {
        "uri": uri,
        "cid": "bafyreiabc123",
        "author": {
            "did": "did:plc:abc123",
            "handle": handle,
        },
        "record": {
            "text": text,
            "createdAt": created_at,
            "$type": "app.bsky.feed.post",
        },
        "likeCount": like_count,
        "replyCount": 0,
        "repostCount": 0,
    }


def _bsky_ok(posts: list[dict], cursor: str = "") -> dict:
    """Build a well-formed Bluesky searchPosts success response."""
    resp: dict = {"posts": posts}
    if cursor:
        resp["cursor"] = cursor
    return resp


def _session_ok_response() -> dict:
    """Build a successful createSession / refreshSession response."""
    return {
        "accessJwt": FAKE_ACCESS_JWT,
        "refreshJwt": FAKE_REFRESH_JWT,
        "handle": "test.bsky.social",
        "did": "did:plc:testuser",
    }


def _set_credentials(monkeypatch, handle="test.bsky.social", password="test-app-pw"):
    """Set Bluesky credential env vars via monkeypatch."""
    monkeypatch.setenv("BLUESKY_HANDLE", handle)
    monkeypatch.setenv("BLUESKY_APP_PASSWORD", password)


def _clear_credentials(monkeypatch):
    """Remove Bluesky credential env vars."""
    monkeypatch.delenv("BLUESKY_HANDLE", raising=False)
    monkeypatch.delenv("BLUESKY_APP_PASSWORD", raising=False)


# ── Session Manager Tests ──────────────────────────────────────────────────────

# ── New Test S1: _get_session returns None when no credentials ─────────────────

def test_get_session_returns_none_when_no_credentials(monkeypatch):
    """_get_session() returns None when BLUESKY_HANDLE/APP_PASSWORD are not set."""
    _clear_credentials(monkeypatch)
    result = _get_session()
    assert result is None


# ── New Test S2: _get_session initializes when credentials are present ─────────

def test_get_session_initializes_when_credentials_present(monkeypatch):
    """_get_session() returns a _BlueskySession when credentials are configured."""
    _set_credentials(monkeypatch, handle="myhandle.bsky.social", password="secret123")
    result = _get_session()
    assert result is not None
    assert isinstance(result, _BlueskySession)
    assert result.handle == "myhandle.bsky.social"
    assert result.app_password == "secret123"


# ── New Test S3: createSession success stores JWTs ────────────────────────────

def test_create_session_success_returns_jwts():
    """_BlueskySession._create_session() stores accessJwt and refreshJwt on success."""
    session = _BlueskySession("test.bsky.social", "test-pw")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        ok = session._create_session()
    assert ok is True
    assert session._access_jwt == FAKE_ACCESS_JWT
    assert session._refresh_jwt == FAKE_REFRESH_JWT


# ── New Test S4: createSession HTTP 401 returns False ─────────────────────────

def test_create_session_http_401_returns_false():
    """_create_session() returns False on HTTP 401."""
    session = _BlueskySession("bad.handle.bsky.social", "wrong-pw")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, status_code=401)
        ok = session._create_session()
    assert ok is False
    assert session._access_jwt is None
    assert session._refresh_jwt is None


# ── New Test S5: createSession HTTP 500 returns False ────────────────────────

def test_create_session_http_500_returns_false():
    """_create_session() returns False on HTTP 500."""
    session = _BlueskySession("test.bsky.social", "test-pw")
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, status_code=500)
        ok = session._create_session()
    assert ok is False
    assert session._access_jwt is None


# ── New Test S6: refreshSession uses refreshJwt in Bearer header ──────────────

def test_refresh_session_uses_refresh_jwt_in_bearer_header():
    """_refresh_session() sends Authorization: Bearer <refreshJwt>."""
    session = _BlueskySession("test.bsky.social", "test-pw")
    session._refresh_jwt = FAKE_REFRESH_JWT

    refresh_response = {
        "accessJwt": FAKE_ACCESS_JWT_2,
        "refreshJwt": FAKE_REFRESH_JWT_2,
        "handle": "test.bsky.social",
        "did": "did:plc:testuser",
    }
    with requests_mock_module.Mocker() as m:
        m.post(REFRESH_SESSION_URL, json=refresh_response)
        ok = session._refresh_session()

    assert ok is True
    # Verify the Authorization header used the refresh JWT
    assert m.last_request.headers.get("Authorization") == f"Bearer {FAKE_REFRESH_JWT}"
    # Access JWT should now be the new one
    assert session._access_jwt == FAKE_ACCESS_JWT_2
    assert session._refresh_jwt == FAKE_REFRESH_JWT_2


# ── New Test S7: refresh failure triggers re-login on next call ───────────────

def test_refresh_session_failure_triggers_relogin_on_next_call():
    """When _refresh_session() fails, refresh() falls back to _create_session()."""
    session = _BlueskySession("test.bsky.social", "test-pw")
    session._access_jwt = "old-access-jwt"
    session._refresh_jwt = FAKE_REFRESH_JWT

    with requests_mock_module.Mocker() as m:
        # Refresh fails with 401
        m.post(REFRESH_SESSION_URL, status_code=401)
        # Full re-login succeeds
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        ok = session.refresh()

    assert ok is True
    assert session._access_jwt == FAKE_ACCESS_JWT
    assert m.call_count == 2  # one refresh attempt + one create attempt


# ── New Test S8: fetch returns empty when no credentials ──────────────────────

def test_fetch_returns_empty_when_no_credentials(monkeypatch):
    """fetch_bluesky_posts_for_game returns [] when credentials are not configured."""
    _clear_credentials(monkeypatch)
    with requests_mock_module.Mocker() as m:
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)
    assert results == []
    # Should not have made any HTTP requests
    assert m.call_count == 0


# ── New Test S9: fetch retries once on 401 after refresh ──────────────────────

def test_fetch_retries_once_on_401_after_refresh(monkeypatch):
    """On HTTP 401, fetch_bluesky_posts_for_game refreshes and retries exactly once."""
    _set_credentials(monkeypatch)

    post = _make_post(text="Space Marine 2 is great")

    with requests_mock_module.Mocker() as m:
        # createSession on first access_jwt call
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        # First search attempt returns 401
        # After refresh, second search attempt succeeds
        # refreshSession returns new tokens
        m.post(REFRESH_SESSION_URL, json={
            "accessJwt": FAKE_ACCESS_JWT_2,
            "refreshJwt": FAKE_REFRESH_JWT_2,
            "handle": "test.bsky.social",
            "did": "did:plc:testuser",
        })
        m.get(SEARCH_URL, [
            {"status_code": 401},
            {"json": _bsky_ok([post]), "status_code": 200},
        ])
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert len(results) == 1
    # Verify we made exactly 2 search requests (initial 401 + retry)
    search_calls = [r for r in m.request_history if SEARCH_URL in r.url]
    assert len(search_calls) == 2


# ── New Test S10: fetch returns empty when auth fully fails ───────────────────

def test_fetch_returns_empty_when_auth_fully_fails(monkeypatch):
    """When both 401 retry attempts fail, fetch returns []."""
    _set_credentials(monkeypatch)

    with requests_mock_module.Mocker() as m:
        # createSession succeeds initially
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        # refreshSession also fails
        m.post(REFRESH_SESSION_URL, status_code=401)
        # Both search attempts return 401
        m.get(SEARCH_URL, status_code=401)
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert results == []


# ── Test 1: Single page search returns correct dict shape ─────────────────────

def test_single_page_returns_correct_dict_shape(monkeypatch):
    """
    Single page with one result should return the correct dict shape with
    all required keys.
    """
    _set_credentials(monkeypatch)
    post = _make_post(
        uri="at://did:plc:abc/app.bsky.feed.post/rkey1",
        handle="player.bsky.social",
        text="Warhammer 40000 Space Marine 2 is fantastic!",
        created_at="2026-05-29T18:00:00Z",
        like_count=10,
    )

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        results = fetch_bluesky_posts_for_game("Warhammer 40,000: Space Marine 2", limit=10)

    assert len(results) == 1
    r = results[0]
    for key in ("external_id", "author", "title", "body", "url", "upvotes", "post_date"):
        assert key in r, f"Missing key: {key}"

    assert r["external_id"] == "at://did:plc:abc/app.bsky.feed.post/rkey1"
    assert r["author"] == "player.bsky.social"
    assert r["title"] == ""
    assert "Space Marine" in r["body"]
    assert r["upvotes"] == 10
    assert "bsky.app" in r["url"]
    # post_date is now a parsed datetime (not the raw ISO string) so that
    # SQLAlchemy's DateTime column can store it.
    assert isinstance(r["post_date"], datetime)
    assert r["post_date"].year == 2026
    assert r["post_date"].month == 5
    assert r["post_date"].day == 29
    assert r["post_date"].hour == 18


# ── Test 2: Multi-page search follows cursor up to MAX_PAGES ──────────────────

def test_multi_page_follows_cursor_up_to_max_pages(monkeypatch):
    """
    When the response includes a cursor and we haven't hit the limit,
    the service should follow pagination up to BLUESKY_MAX_PAGES.
    """
    _set_credentials(monkeypatch)
    posts_page1 = [_make_post(
        uri=f"at://did:plc:abc/app.bsky.feed.post/rkey{i}",
        text=f"Space Marine 2 post number {i}",
    ) for i in range(3)]
    posts_page2 = [_make_post(
        uri=f"at://did:plc:abc/app.bsky.feed.post/rkey1{i}",
        text=f"Space Marine 2 post number 1{i}",
    ) for i in range(3)]
    posts_page3 = [_make_post(
        uri=f"at://did:plc:abc/app.bsky.feed.post/rkey2{i}",
        text=f"Space Marine 2 post number 2{i}",
    ) for i in range(3)]

    search_responses = [
        {"json": _bsky_ok(posts_page1, cursor="cursor1")},
        {"json": _bsky_ok(posts_page2, cursor="cursor2")},
        {"json": _bsky_ok(posts_page3)},  # no cursor on last page
    ]

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, search_responses)
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=100)

    search_calls = [r for r in m.request_history if SEARCH_URL in r.url]
    assert len(search_calls) == BLUESKY_MAX_PAGES, (
        f"Expected exactly {BLUESKY_MAX_PAGES} HTTP requests, got {len(search_calls)}"
    )
    assert len(results) == 9


# ── Test 3: Stops at MAX_PAGES even if cursor is present ──────────────────────

def test_stops_at_max_pages(monkeypatch):
    """
    Even if a cursor is always present, pagination must stop at BLUESKY_MAX_PAGES.
    """
    _set_credentials(monkeypatch)
    posts = [_make_post(text="Space Marine 2 is great")]
    # Return a cursor on every page to test the stop condition
    always_cursor_response = {"json": _bsky_ok(posts, cursor="next_cursor")}

    search_responses = [always_cursor_response] * 10  # more than BLUESKY_MAX_PAGES

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, search_responses)
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=1000)

    search_calls = [r for r in m.request_history if SEARCH_URL in r.url]
    assert len(search_calls) == BLUESKY_MAX_PAGES, (
        f"Expected max {BLUESKY_MAX_PAGES} requests, got {len(search_calls)}"
    )


# ── Test 4: HTTP 503 returns empty list without raising ───────────────────────

def test_http_503_returns_empty_list(monkeypatch):
    _set_credentials(monkeypatch)
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, status_code=503)
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)
    assert results == []


# ── Test 5: HTTP 502 returns empty list without raising ───────────────────────

def test_http_502_returns_empty_list(monkeypatch):
    _set_credentials(monkeypatch)
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, status_code=502)
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)
    assert results == []


# ── Test 6: HTTP 429 returns empty list without raising ───────────────────────

def test_http_429_returns_empty_list(monkeypatch):
    _set_credentials(monkeypatch)
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, status_code=429)
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)
    assert results == []


# ── Test 7: Connection timeout returns empty list without raising ──────────────

def test_connection_timeout_returns_empty_list(monkeypatch):
    import requests.exceptions

    _set_credentials(monkeypatch)
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, exc=requests.exceptions.Timeout("timed out"))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)
    assert results == []


# ── Test 8: Malformed JSON returns empty list without raising ──────────────────

def test_malformed_json_returns_empty_list(monkeypatch):
    _set_credentials(monkeypatch)
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, text="<html>Not JSON</html>", status_code=200)
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)
    assert results == []


# ── Test 9: Empty posts array returns empty list ──────────────────────────────

def test_empty_posts_array_returns_empty_list(monkeypatch):
    _set_credentials(monkeypatch)
    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json={"posts": []})
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)
    assert results == []


# ── Test 10: Multi-word game name produces quoted exact-phrase query ───────────

def test_multi_word_game_name_produces_quoted_query(monkeypatch):
    """
    Multi-word game names should be wrapped in double-quotes in the query
    string so Bluesky searches for the exact phrase, not individual words.
    """
    _set_credentials(monkeypatch)
    post = _make_post(text="Space Marine 2 is awesome")

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    search_calls = [r for r in m.request_history if SEARCH_URL in r.url]
    assert len(search_calls) == 1
    # Inspect the actual query string used
    request_url = search_calls[0].url
    parsed = urlparse(request_url)
    query_params = parse_qs(parsed.query)
    q_value = query_params.get("q", [""])[0]
    assert q_value.startswith('"') and q_value.endswith('"'), (
        f"Expected quoted exact-phrase query, got: {q_value!r}"
    )
    assert "Space Marine 2" in q_value


# ── Test 11: _post_mentions_game filter excludes irrelevant posts ─────────────

def test_post_mentions_game_filter_excludes_irrelevant_posts(monkeypatch):
    """
    A post whose text doesn't contain any distinctive keyword from the game
    name should be excluded even if the Bluesky search returned it.
    """
    _set_credentials(monkeypatch)
    relevant_post = _make_post(
        uri="at://did:plc:abc/app.bsky.feed.post/rkey_rel",
        text="Playing Space Marine 2 all weekend, amazing game",
    )
    irrelevant_post = _make_post(
        uri="at://did:plc:abc/app.bsky.feed.post/rkey_irr",
        text="Just finished a great sci-fi novel, nothing to do with games",
    )

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([relevant_post, irrelevant_post]))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=100)

    ids = {r["external_id"] for r in results}
    assert "at://did:plc:abc/app.bsky.feed.post/rkey_rel" in ids
    assert "at://did:plc:abc/app.bsky.feed.post/rkey_irr" not in ids


# ── Test 12: Body is truncated to 2000 chars ──────────────────────────────────

def test_body_truncated_to_2000_chars(monkeypatch):
    _set_credentials(monkeypatch)
    long_text = "Space Marine 2 " + "x" * 3000
    post = _make_post(text=long_text)

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert len(results) == 1
    assert len(results[0]["body"]) == 2000


# ── Test 13: url field is constructed correctly from handle and rkey ───────────

def test_url_field_constructed_from_handle_and_rkey(monkeypatch):
    """
    URL must be https://bsky.app/profile/{handle}/post/{rkey}
    where rkey is the last path component of the at:// URI.
    """
    _set_credentials(monkeypatch)
    post = _make_post(
        uri="at://did:plc:abc123/app.bsky.feed.post/3klmn12345z",
        handle="gamer.bsky.social",
        text="Space Marine 2 review",
    )

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert len(results) == 1
    assert results[0]["url"] == "https://bsky.app/profile/gamer.bsky.social/post/3klmn12345z"


# ── Test 14: external_id is the full at:// URI ────────────────────────────────

def test_external_id_is_full_at_uri(monkeypatch):
    _set_credentials(monkeypatch)
    full_uri = "at://did:plc:uniqueuser123/app.bsky.feed.post/uniquerkey456"
    post = _make_post(uri=full_uri, text="Space Marine 2 discussion post")

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert len(results) == 1
    assert results[0]["external_id"] == full_uri


# ── Test 15: post_date is parsed to a Python datetime (regression test) ────────────

def test_post_date_preserved_as_iso8601(monkeypatch):
    """createdAt must be parsed to a Python datetime so SQLAlchemy's DateTime
    column can store it (regression test for the silent-rollback bug where
    every Bluesky post failed to insert because post_date was an ISO string).
    """
    _set_credentials(monkeypatch)
    iso_date = "2026-05-29T18:30:00.000Z"
    post = _make_post(text="Space Marine 2 gameplay", created_at=iso_date)

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert len(results) == 1
    parsed = results[0]["post_date"]
    assert isinstance(parsed, datetime), (
        f"post_date must be a datetime, got {type(parsed).__name__}: {parsed!r}"
    )
    assert parsed.year == 2026
    assert parsed.month == 5
    assert parsed.day == 29
    assert parsed.hour == 18
    assert parsed.minute == 30


def test_post_date_none_when_created_at_missing(monkeypatch):
    """Posts without a createdAt field should yield post_date=None instead of
    crashing the pipeline."""
    _set_credentials(monkeypatch)
    post = _make_post(text="Space Marine 2 chatter")
    post["record"].pop("createdAt", None)

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert len(results) == 1
    assert results[0]["post_date"] is None


def test_post_date_none_when_created_at_unparseable(monkeypatch):
    """Malformed createdAt values should yield post_date=None (not crash)."""
    _set_credentials(monkeypatch)
    post = _make_post(
        text="Space Marine 2 chatter",
        created_at="not-a-valid-iso-date",
    )

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert len(results) == 1
    assert results[0]["post_date"] is None


# ── Test 16: upvotes defaults to 0 when likeCount is missing ──────────────────

def test_upvotes_defaults_to_zero_when_like_count_missing(monkeypatch):
    _set_credentials(monkeypatch)
    post = _make_post(text="Space Marine 2 is fun", like_count=0)
    del post["likeCount"]  # completely absent

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert len(results) == 1
    assert results[0]["upvotes"] == 0


# ── Test 17: Author handle missing → fallback to '[deleted]' ──────────────────

def test_author_handle_missing_falls_back_to_deleted(monkeypatch):
    _set_credentials(monkeypatch)
    post = _make_post(text="Space Marine 2 experience")
    post["author"] = {}  # handle absent

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        results = fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    assert len(results) == 1
    assert results[0]["author"] == "[deleted]"


# ── Test 18: search request includes Authorization Bearer header ───────────────

def test_search_request_includes_authorization_header(monkeypatch):
    """Authenticated requests must send Authorization: Bearer <accessJwt>."""
    _set_credentials(monkeypatch)
    post = _make_post(text="Space Marine 2 rocks")

    with requests_mock_module.Mocker() as m:
        m.post(CREATE_SESSION_URL, json=_session_ok_response())
        m.get(SEARCH_URL, json=_bsky_ok([post]))
        fetch_bluesky_posts_for_game("Space Marine 2", limit=10)

    search_calls = [r for r in m.request_history if SEARCH_URL in r.url]
    assert len(search_calls) == 1
    auth_header = search_calls[0].headers.get("Authorization", "")
    assert auth_header.startswith("Bearer "), (
        f"Expected Bearer token, got: {auth_header!r}"
    )
    assert FAKE_ACCESS_JWT in auth_header


# ── Test 19: BLUESKY_BASE is bsky.social (authenticated endpoint) ─────────────

def test_bluesky_base_is_authenticated_endpoint():
    """BLUESKY_BASE must point to bsky.social, not public.api.bsky.app."""
    assert BLUESKY_BASE == "https://bsky.social", (
        f"Expected https://bsky.social, got {BLUESKY_BASE!r}"
    )


# ── Test 20: invalidate clears access JWT ────────────────────────────────────

def test_invalidate_clears_access_jwt():
    """session.invalidate() should clear _access_jwt so next get_access_jwt re-creates."""
    session = _BlueskySession("test.bsky.social", "test-pw")
    session._access_jwt = "some-jwt"
    session._refresh_jwt = FAKE_REFRESH_JWT
    session.invalidate()
    assert session._access_jwt is None
