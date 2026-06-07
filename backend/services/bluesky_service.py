"""
Bluesky service — fetch posts mentioning a game via the authenticated
bsky.social AT Protocol API.

Authentication
--------------
Uses the AT Protocol session flow (com.atproto.server.createSession /
refreshSession).  A thread-safe singleton `_BlueskySession` lazily creates
a session on first use, refreshes the accessJwt on 401, and falls back to
a full re-login if the refresh also fails.

Credentials are read from environment variables at first use:
  BLUESKY_HANDLE        — e.g. "myaccount.bsky.social"
  BLUESKY_APP_PASSWORD  — app password generated in Bluesky Settings

If either variable is absent the service returns [] and logs a single INFO
line.  JWTs are never logged.

Usage:
    from services.bluesky_service import fetch_bluesky_posts_for_game

All exceptions are caught and logged; the caller never receives a raised
exception, only an empty list.
"""
import logging
import os
import threading
import time
from datetime import datetime
from typing import Optional

import requests

from services.reddit_service import _game_search_query, _post_mentions_game

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

BLUESKY_BASE = "https://bsky.social"
BLUESKY_USER_AGENT = "SentimentPulse/1.0 (Saber Interactive game intel)"
BLUESKY_SEARCH_PATH = "/xrpc/app.bsky.feed.searchPosts"

BLUESKY_MAX_PAGES = 3

_BASE_HEADERS = {
    "User-Agent": BLUESKY_USER_AGENT,
    "Accept": "application/json",
}

_TIMEOUT = 15        # seconds per request
_PAGE_DELAY = 1.0    # seconds between paginated requests

_CREATE_SESSION_PATH = "/xrpc/com.atproto.server.createSession"
_REFRESH_SESSION_PATH = "/xrpc/com.atproto.server.refreshSession"


# ── Session manager ───────────────────────────────────────────────────────────

class _BlueskySession:
    """Thread-safe session manager.

    Lazy-creates a session on first use, refreshes accessJwt on 401,
    falls back to full re-login if refresh fails.

    JWTs are NEVER written to logs.
    """

    def __init__(self, handle: str, app_password: str) -> None:
        self.handle = handle
        self.app_password = app_password
        self._access_jwt: Optional[str] = None
        self._refresh_jwt: Optional[str] = None
        self._lock = threading.Lock()

    # ── Public ────────────────────────────────────────────────────────────────

    def get_access_jwt(self) -> Optional[str]:
        """Return a valid accessJwt, creating/refreshing as needed.

        Returns None on auth failure.  Never logs the JWT itself.
        """
        with self._lock:
            if self._access_jwt is None:
                self._create_session()
            return self._access_jwt

    def invalidate(self) -> None:
        """Clear the cached access JWT so the next call triggers a session refresh."""
        with self._lock:
            self._access_jwt = None

    def refresh(self) -> bool:
        """Attempt to refresh the session; fall back to full re-login on failure.

        Returns True on success, False if all auth attempts fail.
        """
        with self._lock:
            ok = self._refresh_session()
            if not ok:
                logger.info("bluesky: refresh failed, attempting full re-login")
                self._access_jwt = None
                self._refresh_jwt = None
                return self._create_session()
            return True

    # ── Private ───────────────────────────────────────────────────────────────

    def _create_session(self) -> bool:
        """POST /xrpc/com.atproto.server.createSession.

        Stores accessJwt and refreshJwt on success.
        Returns True on success, False otherwise.
        """
        url = f"{BLUESKY_BASE}{_CREATE_SESSION_PATH}"
        try:
            resp = requests.post(
                url,
                json={"identifier": self.handle, "password": self.app_password},
                headers=_BASE_HEADERS,
                timeout=_TIMEOUT,
            )
        except Exception as exc:
            logger.warning("bluesky: createSession request failed — %s", exc)
            return False

        if resp.status_code != 200:
            logger.warning(
                "bluesky: createSession HTTP %d for handle=%r",
                resp.status_code, self.handle,
            )
            return False

        try:
            data = resp.json()
        except Exception as exc:
            logger.warning("bluesky: createSession JSON parse error — %s", exc)
            return False

        access = data.get("accessJwt")
        refresh = data.get("refreshJwt")
        if not access:
            logger.warning("bluesky: createSession returned no accessJwt")
            return False

        self._access_jwt = access
        self._refresh_jwt = refresh
        logger.info("bluesky: session created for handle=%r", self.handle)
        return True

    def _refresh_session(self) -> bool:
        """POST /xrpc/com.atproto.server.refreshSession with Bearer <refreshJwt>.

        Returns True on success; False triggers full re-login by caller.
        """
        if not self._refresh_jwt:
            return False

        url = f"{BLUESKY_BASE}{_REFRESH_SESSION_PATH}"
        headers = {**_BASE_HEADERS, "Authorization": f"Bearer {self._refresh_jwt}"}
        try:
            resp = requests.post(url, headers=headers, timeout=_TIMEOUT)
        except Exception as exc:
            logger.warning("bluesky: refreshSession request failed — %s", exc)
            return False

        if resp.status_code != 200:
            logger.warning("bluesky: refreshSession HTTP %d", resp.status_code)
            return False

        try:
            data = resp.json()
        except Exception as exc:
            logger.warning("bluesky: refreshSession JSON parse error — %s", exc)
            return False

        access = data.get("accessJwt")
        refresh = data.get("refreshJwt")
        if not access:
            logger.warning("bluesky: refreshSession returned no accessJwt")
            return False

        self._access_jwt = access
        if refresh:
            self._refresh_jwt = refresh
        logger.info("bluesky: session refreshed for handle=%r", self.handle)
        return True


# ── Module-level singleton ────────────────────────────────────────────────────

# Lazy-initialized after env is loaded; guarded by _session_init_lock.
_session: Optional[_BlueskySession] = None
_session_init_lock = threading.Lock()


def _get_session() -> Optional[_BlueskySession]:
    """Return the singleton session, or None if credentials are not configured."""
    global _session
    if _session is not None:
        return _session
    with _session_init_lock:
        if _session is not None:   # double-checked locking
            return _session
        handle = os.environ.get("BLUESKY_HANDLE", "").strip()
        password = os.environ.get("BLUESKY_APP_PASSWORD", "").strip()
        if not handle or not password:
            return None
        _session = _BlueskySession(handle, password)
        return _session


# ── Private helpers ───────────────────────────────────────────────────────────

def _build_search_query(game_name: str) -> str:
    """Build a Bluesky search query from the game name.

    Uses the same possessive-prefix stripping as reddit_service._game_search_query,
    then wraps multi-word names in double-quotes for exact-phrase matching so
    'John Wick' doesn't match standalone 'John' or 'Wick'.
    """
    query = _game_search_query(game_name)
    # Wrap multi-word queries in quotes for exact-phrase search
    if " " in query:
        query = f'"{query}"'
    return query


def _convert_post(raw: dict) -> Optional[dict]:
    """Convert a single Bluesky searchPosts post object to the standard
    SentimentPulse pipeline dict shape.

    Expected Bluesky post shape:
        {
          "uri":    "at://did:plc:.../app.bsky.feed.post/rkey",
          "cid":    "...",
          "author": {"did": "did:plc:...", "handle": "user.bsky.social"},
          "record": {"text": "...", "createdAt": "2026-05-29T18:00:00Z"},
          "likeCount": 5,
          ...
        }

    Returns None if the post has no usable URI (silently skipped by caller).
    """
    uri = raw.get("uri", "")
    if not uri:
        return None

    author_obj = raw.get("author") or {}
    handle = author_obj.get("handle") or "[deleted]"

    record_obj = raw.get("record") or {}
    body_raw = record_obj.get("text") or ""
    body = body_raw[:2000]

    # Parse createdAt (ISO 8601) to a Python datetime so SQLAlchemy's DateTime
    # column can store it.  Bluesky uses RFC 3339 with a trailing 'Z' for UTC,
    # which Python's fromisoformat only accepts on 3.11+; we normalize 'Z' to
    # '+00:00' for portability.  If parsing fails we fall back to None rather
    # than dropping the post.
    post_date: Optional[datetime] = None
    created_at_raw = record_obj.get("createdAt")
    if created_at_raw:
        try:
            post_date = datetime.fromisoformat(
                created_at_raw.replace("Z", "+00:00")
            )
        except (ValueError, TypeError, AttributeError):
            post_date = None

    # Build browser-accessible URL from handle + rkey (last path segment of URI)
    rkey = uri.split("/")[-1]
    url = f"https://bsky.app/profile/{handle}/post/{rkey}"

    upvotes = raw.get("likeCount")
    if upvotes is None:
        upvotes = 0
    else:
        try:
            upvotes = max(0, int(upvotes))
        except (ValueError, TypeError):
            upvotes = 0

    return {
        "external_id": uri,
        "author": handle,
        "title": "",            # Bluesky posts are body-only, no titles
        "body": body,
        "url": url,
        "upvotes": upvotes,
        "post_date": post_date,  # datetime object (or None on parse failure)
    }


# Return type: (posts, next_cursor, http_status_code)
# http_status_code is None on network/parse error, otherwise the actual HTTP code.
def _fetch_page(
    query: str,
    limit: int,
    cursor: Optional[str],
    access_jwt: str,
) -> tuple[list[dict], Optional[str], Optional[int]]:
    """Fetch one page of Bluesky search results using an authenticated request.

    Returns (posts, next_cursor, http_status) where:
    - next_cursor is None if there are no more pages or on any error.
    - http_status is the HTTP status code, or None on network/parse error.

    Never raises.
    """
    params: dict = {
        "q": query,
        "limit": min(limit, 100),   # Bluesky caps at 100 per page
        "sort": "latest",
    }
    if cursor:
        params["cursor"] = cursor

    url = f"{BLUESKY_BASE}{BLUESKY_SEARCH_PATH}"
    # IMPORTANT: app.bsky.feed.searchPosts is an AppView query.  Calling it on
    # bsky.social (our PDS host) requires the atproto-proxy header so the PDS
    # routes the request to the Bluesky AppView.  Without this header the PDS
    # returns HTTP 400 because the endpoint isn't implemented on the PDS itself.
    # See https://atproto.com/specs/xrpc#service-proxying
    headers = {
        **_BASE_HEADERS,
        "Authorization": f"Bearer {access_jwt}",
        "atproto-proxy": "did:web:api.bsky.app#bsky_appview",
    }
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=_TIMEOUT)
    except Exception as exc:
        logger.warning("bluesky: request failed — %s", exc)
        return [], None, None

    if resp.status_code == 401:
        logger.warning("bluesky: HTTP 401 — access token may be expired")
        return [], None, 401

    if resp.status_code != 200:
        # Surface the response body (Bluesky returns {error, message}) so
        # silent-failure debugging doesn't require running this locally.
        # CLAUDE.md §19: never hide signals that would let us detect a bug.
        body_preview = (resp.text or "")[:300]
        logger.warning(
            "bluesky: HTTP %d for query=%r body=%s",
            resp.status_code, query, body_preview,
        )
        # Bluesky's AppView returns HTTP 400 with body {"error":"ExpiredToken",
        # "message":"Token has expired"} when a long-running cron outlives
        # the ~2h access-token TTL.  Spec implies 401, but the live PDS sends
        # 400.  Normalize to 401 here so the caller's existing refresh-on-401
        # retry path runs.  Caught by the 2026-06-07 partial_failure cron
        # — the exact failure the Gap 2 hardening was designed to surface.
        if "ExpiredToken" in body_preview or "Token has expired" in body_preview:
            logger.warning(
                "bluesky: HTTP %d body indicates ExpiredToken — normalizing to "
                "401 to trigger session refresh.",
                resp.status_code,
            )
            return [], None, 401
        return [], None, resp.status_code

    try:
        data = resp.json()
    except Exception as exc:
        logger.warning("bluesky: failed to parse JSON — %s", exc)
        return [], None, 200

    raw_posts = data.get("posts") or []
    next_cursor = data.get("cursor") or None

    converted: list[dict] = []
    for raw in raw_posts:
        post = _convert_post(raw)
        if post is not None:
            converted.append(post)

    return converted, next_cursor, 200


# ── Public API ────────────────────────────────────────────────────────────────

def fetch_bluesky_posts_for_game(
    game_name: str,
    limit: int = 100,
) -> list[dict]:
    """Search Bluesky for recent posts mentioning a game.

    Strategy:
      - Check credentials; return [] if not configured.
      - Authenticate via bsky.social session flow (lazy, singleton).
      - Build an exact-phrase search query from game_name (multi-word names
        are quoted so 'John Wick' doesn't match 'John' or 'Wick' alone).
      - GET /xrpc/app.bsky.feed.searchPosts?q=<query>&limit=<n>&sort=latest
        with Authorization: Bearer <accessJwt>
      - On HTTP 401: clear cached JWT, retry once after re-creating session.
        If still 401 → return [].
      - Paginate up to BLUESKY_MAX_PAGES pages if a cursor is returned and
        we haven't yet reached `limit` results.
      - Apply _post_mentions_game() to each post before adding to results
        (§14 relevance filter — Bluesky search returns approximate matches).
      - 15-second timeout per request; 1-second sleep between pages.

    Returns a list of post dicts with keys:
        external_id  — full at://... URI (canonical ID)
        author       — author handle (e.g. 'user.bsky.social'), '[deleted]' fallback
        title        — '' (Bluesky posts have no titles)
        body         — post text, truncated to 2000 chars
        url          — https://bsky.app/profile/{handle}/post/{rkey}
        upvotes      — likeCount, defaults to 0 if missing
        post_date    — ISO 8601 string from record.createdAt (preserved as-is)

    NEVER raises — all exceptions are caught and logged; returns [] on failure.
    """
    # ── Credentials check ─────────────────────────────────────────────────────
    session = _get_session()
    if session is None:
        logger.info("bluesky: credentials not configured, skipping")
        return []

    access_jwt = session.get_access_jwt()
    if not access_jwt:
        logger.warning("bluesky: auth failure — could not obtain access JWT")
        return []

    # ── Setup ─────────────────────────────────────────────────────────────────
    # status starts as 'ok' but flips to 'http_<code>' on the first non-200
    # response we observe.  Previously it stayed 'ok' regardless of HTTP
    # errors, which masked the 2026-06 bluesky.social atproto-proxy routing
    # change for 2+ days.  CLAUDE.md §19: don't log status=ok on a failed call.
    status = "ok"
    total_posts = 0
    total_pages = 0
    last_http_status: Optional[int] = None

    results: list[dict] = []
    search_query = _build_search_query(game_name)
    # _post_mentions_game uses a raw (unquoted) query for keyword matching
    filter_query = _game_search_query(game_name)

    cursor: Optional[str] = None
    remaining = limit
    _401_retried = False  # only retry once per fetch_bluesky_posts_for_game call

    try:
        for page_num in range(1, BLUESKY_MAX_PAGES + 1):
            if remaining <= 0:
                break

            # Get current access JWT (may have been renewed)
            access_jwt = session.get_access_jwt()
            if not access_jwt:
                logger.warning("bluesky: lost access JWT mid-pagination, stopping")
                break

            posts, next_cursor, http_status = _fetch_page(
                search_query, min(remaining, 100), cursor, access_jwt
            )
            total_pages = page_num
            last_http_status = http_status
            # Flip status to a structured error code on the FIRST non-200 we
            # see this call.  Don't overwrite a later 200 — we want the worst
            # observed state to be sticky so the metric line tells the truth.
            if status == "ok" and http_status is not None and http_status != 200:
                status = f"http_{http_status}"
            elif status == "ok" and http_status is None:
                status = "network_error"

            # Handle 401: retry once after refresh/re-login
            if http_status == 401 and not _401_retried:
                _401_retried = True
                session.invalidate()
                logger.info("bluesky: 401 on page %d, attempting session refresh", page_num)
                ok = session.refresh()
                if not ok:
                    logger.warning("bluesky: auth fully failed after refresh attempt")
                    return []
                access_jwt = session.get_access_jwt()
                if not access_jwt:
                    logger.warning("bluesky: still no access JWT after refresh")
                    return []
                posts, next_cursor, http_status = _fetch_page(
                    search_query, min(remaining, 100), cursor, access_jwt
                )
                last_http_status = http_status
                # If the retry recovered, clear the prior http_401 from status
                if http_status == 200 and status == "http_401":
                    status = "ok"
                elif http_status is not None and http_status not in (200, 401):
                    status = f"http_{http_status}"
                if http_status == 401:
                    logger.warning("bluesky: still HTTP 401 after re-login, giving up")
                    return []

            if page_num > 1:
                time.sleep(_PAGE_DELAY)

            for post in posts:
                if _post_mentions_game(post, filter_query):
                    results.append(post)
                    remaining -= 1
                    if remaining <= 0:
                        break

            if not next_cursor or not posts:
                break

            cursor = next_cursor

        total_posts = len(results)

    except Exception as exc:
        status = "error"
        logger.error(
            "bluesky: unexpected error for game='%s': %s",
            game_name, exc,
        )
        return []

    finally:
        # Structured metric line — grep for this in logs to track daily yields
        logger.info(
            "bluesky_metric game=%s posts=%d pages=%d status=%s",
            game_name, total_posts, total_pages, status,
        )

    return results
