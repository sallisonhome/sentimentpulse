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

import re
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

    # Proactive refresh threshold.  Bluesky's accessJwt TTL is ~2h but the
    # exact lifetime is not contract-stable, so we refresh well before the
    # documented expiry to avoid hitting ExpiredToken mid-cron.  Our daily
    # cron typically completes in <30min, but Bluesky retries can stretch a
    # run to >90min; refreshing every 50min covers both cases with margin.
    _PROACTIVE_REFRESH_SECONDS = 50 * 60

    def __init__(self, handle: str, app_password: str) -> None:
        self.handle = handle
        self.app_password = app_password
        self._access_jwt: Optional[str] = None
        self._refresh_jwt: Optional[str] = None
        self._session_created_at: Optional[float] = None  # epoch seconds
        self._lock = threading.Lock()
        # Public auth-health snapshot — read by ingestor to surface in
        # bluesky_health.  None until the first auth attempt completes.
        # "ok"             — most recent auth call (create OR refresh) succeeded
        # "refresh_failed" — refresh AND re-createSession both failed
        # "create_failed"  — createSession failed (creds or rate limit)
        self.auth_health: Optional[str] = None

    # ── Public ────────────────────────────────────────────────────────────────

    def session_age_seconds(self) -> Optional[float]:
        """Return age of the cached access JWT in seconds, or None if no session."""
        if self._session_created_at is None:
            return None
        return time.time() - self._session_created_at

    def needs_proactive_refresh(self) -> bool:
        """True when the cached JWT is older than _PROACTIVE_REFRESH_SECONDS."""
        age = self.session_age_seconds()
        return age is not None and age >= self._PROACTIVE_REFRESH_SECONDS

    def get_access_jwt(self) -> Optional[str]:
        """Return a valid accessJwt, creating/refreshing as needed.

        Proactively refreshes the session if it's older than
        _PROACTIVE_REFRESH_SECONDS — this is the core hardening that prevents
        the 2026-06-07 ExpiredToken-mid-cron failure from recurring.  When
        the proactive refresh fails we keep the existing (possibly still
        valid) JWT rather than nuking it; reactive 401/400 ExpiredToken
        handling will catch any subsequent failure.

        Returns None on auth failure.  Never logs the JWT itself.
        """
        with self._lock:
            if self._access_jwt is None:
                self._create_session_locked()
                return self._access_jwt
            if self.needs_proactive_refresh():
                logger.info(
                    "bluesky: proactive refresh (session age %.0fs ≥ %ds)",
                    self.session_age_seconds() or 0,
                    self._PROACTIVE_REFRESH_SECONDS,
                )
                self._refresh_or_recreate_locked()
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
            return self._refresh_or_recreate_locked()

    def force_recreate(self) -> bool:
        """Drop the cached session entirely and createSession from scratch.

        Used by the cron-end auto-recovery (#4) when bluesky_health=failed
        and we want to guarantee the next attempt uses a fresh server-side
        session, bypassing both the cached accessJwt and refreshJwt.
        """
        with self._lock:
            logger.info("bluesky: force_recreate — dropping all cached tokens")
            self._access_jwt = None
            self._refresh_jwt = None
            self._session_created_at = None
            return self._create_session_locked()

    def _refresh_or_recreate_locked(self) -> bool:
        """Caller must hold self._lock.  Refresh, falling back to re-login.

        On total failure leaves auth_health='refresh_failed' or 'create_failed'
        so ingestor.py can distinguish auth-broken from no-results.
        """
        ok = self._refresh_session()
        if ok:
            return True
        logger.info("bluesky: refresh failed, attempting full re-login")
        self._access_jwt = None
        self._refresh_jwt = None
        created = self._create_session_locked()
        if not created:
            self.auth_health = "refresh_failed"
        return created

    # ── Private ───────────────────────────────────────────────────────────────

    def _create_session(self) -> bool:
        """Top-level createSession that acquires the lock (back-compat for
        any callers using the old API).  Prefer _create_session_locked."""
        with self._lock:
            return self._create_session_locked()

    def _create_session_locked(self) -> bool:
        """POST /xrpc/com.atproto.server.createSession.  Caller MUST hold self._lock.

        Stores accessJwt and refreshJwt on success, and records the timestamp
        so needs_proactive_refresh() can detect token aging.
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
            self.auth_health = "create_failed"
            return False

        if resp.status_code != 200:
            logger.warning(
                "bluesky: createSession HTTP %d for handle=%r",
                resp.status_code, self.handle,
            )
            self.auth_health = "create_failed"
            return False

        try:
            data = resp.json()
        except Exception as exc:
            logger.warning("bluesky: createSession JSON parse error — %s", exc)
            self.auth_health = "create_failed"
            return False

        access = data.get("accessJwt")
        refresh = data.get("refreshJwt")
        if not access:
            logger.warning("bluesky: createSession returned no accessJwt")
            self.auth_health = "create_failed"
            return False

        self._access_jwt = access
        self._refresh_jwt = refresh
        self._session_created_at = time.time()
        self.auth_health = "ok"
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
        self._session_created_at = time.time()
        self.auth_health = "ok"
        logger.info("bluesky: session refreshed for handle=%r", self.handle)
        return True


# ── Module-level singleton ────────────────────────────────────────────────────

# Lazy-initialized after env is loaded; guarded by _session_init_lock.
_session: Optional[_BlueskySession] = None
_session_init_lock = threading.Lock()


def get_auth_health() -> Optional[str]:
    """Public read of the singleton session's auth_health.

    Returns None if no session has been created in this process yet, else
    one of 'ok' / 'refresh_failed' / 'create_failed'.  Ingestor reads this
    after a Bluesky run to distinguish auth-broken from genuinely-no-posts
    (#2 in the 2026-06-07 hardening plan).
    """
    if _session is None:
        return None
    return _session.auth_health


def force_session_recreate() -> bool:
    """Public helper for the cron-end auto-recovery (#4) — drops the cached
    session and runs createSession from scratch.  Returns True on success."""
    sess = _get_session()
    if sess is None:
        return False
    return sess.force_recreate()


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

# Generic words to drop from a game title before phrase-matching. Kept
# deliberately narrower than reddit_service._GENERIC because Bluesky's
# exact-phrase search benefits from more context (e.g. we WANT to keep
# 'The Game' in 'Halloween: The Game' because that IS the distinctive
# phrase for that title), whereas the Reddit path picks a single
# distinctive word and can afford to be more aggressive.
_BSKY_GENERIC_TAIL = {
    # Version / edition tails that add no phrase-matching value and often
    # aren't repeated by fans in the wild.
    "remastered", "remaster", "remake", "deluxe", "complete",
    "anniversary", "collection", "trilogy", "legendary", "ultimate",
    "gold", "platinum", "edition", "pack", "dlc", "soundtrack",
    "official", "expansion", "prologue",
}


def _build_search_query(
    game_name: str,
    distinctive_keywords: Optional[list[str]] = None,
) -> str:
    """Build a Bluesky exact-phrase search query from a game name.

    When distinctive_keywords is provided and non-empty, it takes
    priority: the query becomes an OR of quoted phrases, one per
    keyword. This is the correct strategy for games whose title is
    a common English word (Docked, Inversion, TimeShift, MX Nitro,
    Wick) or a common multi-word phrase ("A Quiet Place",
    "Dakar Desert Rally") — Bluesky's default search can't
    distinguish the game from the everyday meaning, so we rely on
    game-specific distinctive terms curated per-title.

    Verified 2026-07-28: Bluesky search supports OR of quoted phrases
    (e.g. q="phrase 1" OR "phrase 2").

    Fallback strategy when no distinctive_keywords:
      * Strip possessive studio/director prefix ("John Carpenter's Toxic
        Commando" -> "Toxic Commando").
      * Drop trademark symbols and punctuation that trip Bluesky's
        search parser (:, dashes, commas, em/en dashes).
      * Drop generic edition tails ("Remastered", "Anniversary"...) so
        "Halo 2: Anniversary" -> exact-phrase "Halo 2".
      * If ≥2 meaningful tokens remain, return them wrapped in double
        quotes for Bluesky's exact-phrase match.
      * If only 1 token remains, return it bare — Bluesky doesn't need
        quoting for a single token and quoting can misfire.

    Why NOT reuse reddit_service._game_search_query for the fallback:
      That function returns a SINGLE distinctive word because
      PullPush/Reddit AND-match multi-word queries. Bluesky supports
      true exact-phrase matching via quoting, so a single-word query
      is strictly worse there — it matches thousands of unrelated posts
      ('Silent' matches 'silent night', 'Marine' matches 'marine
      biologist', etc.). See the 2026-07-28 quality audit for details.
    """
    # Distinctive-keywords path: preferred when set. Wraps each keyword
    # in double quotes for exact-phrase match, then ORs them together.
    # We cap at 8 keywords to keep the query string under Bluesky's
    # implicit ~500-char limit.
    #
    # 2026-07-31 fix: `OR` between quoted phrases is NOT a supported Bluesky
    # search operator on app.bsky.feed.searchPosts. The endpoint treats the
    # `OR` token as a literal word to match, so queries like
    #   "Space Marine 2" OR "SM2" OR "WH40K Space Marine 2"
    # return 0 results with HTTP 200 (a silent empty page). Every game in
    # the portfolio with a distinctive_keywords list was hitting this and
    # getting 0 posts across the daily cron for weeks. Only games where
    # distinctive_keywords was NULL (Rideshare "Stimulator") were still
    # working because they fell into the game-name path below.
    #
    # New behaviour: when distinctive_keywords is provided we use ONLY the
    # first keyword as an exact-phrase Bluesky search query. All keywords
    # continue to be used as the post-fetch strict filter in
    # `fetch_bluesky_posts_for_game` (via `filter_keywords`) so ambiguous-
    # title noise still gets rejected. The first keyword is by convention
    # the strongest disambiguator ("Space Marine 2", "Docked Contraband",
    # "Inversion 2012") — curated per-title, and the one most likely to
    # produce real hits when quoted as a phrase.
    if distinctive_keywords:
        cleaned = [
            k.strip() for k in distinctive_keywords
            if isinstance(k, str) and k.strip()
        ]
        if cleaned:
            first = cleaned[0]
            # Single-token first keyword doesn't need quoting; a quoted
            # single word makes the Bluesky parser fall into exact-word
            # mode which is what we want anyway. Return quoted only when
            # the phrase actually has whitespace.
            if " " in first:
                return f'"{first}"'
            return first

    # Fallback: derive from game name (original behavior).
    # Strip possessive prefix
    if "'s " in game_name:
        game_name = game_name.split("'s ", 1)[1]

    # Normalize punctuation to spaces so we don't ship raw colons / dashes
    # to Bluesky's search parser. Keep periods on version numbers by
    # replacing everything else, then collapsing whitespace.
    stripped = re.sub(r"[™®©:\-–—,!?/\\()]", " ", game_name)
    tokens = [t for t in stripped.split() if t]

    # Drop generic edition tails from the END of the token list. We only
    # strip trailing generics because a title like "Halo: Combat Evolved
    # Anniversary" is defined by "Combat Evolved" — "Anniversary" is a
    # release-marker suffix. A leading generic like "Ultimate" in
    # "Ultimate Marvel vs Capcom 3" is actually part of the title and
    # must be kept.
    while tokens and tokens[-1].lower() in _BSKY_GENERIC_TAIL:
        tokens.pop()

    if not tokens:
        # Everything was generic — fall back to the raw stripped form so
        # the caller still has something to search on. Unlikely in
        # practice but never return empty (which would search Bluesky's
        # global firehose).
        fallback = stripped.strip()
        return fallback if fallback else game_name.strip()

    phrase = " ".join(tokens)

    # Single-token titles don't need (and shouldn't have) quoting.
    if len(tokens) == 1:
        return phrase

    # Multi-token: exact-phrase search.
    return f'"{phrase}"'


# ── Aggregator / promo-spam detector ──────────────────────────────────────────

# Regexes used by _is_aggregator_post. Compiled once at module load.
# Numbered list item marker: matches "N. " or "N) " at either the start
# of the body, after a newline, OR after another list item on the same
# line. Real Bluesky release-calendar posts often collapse all their
# numbered entries onto a single line ("... Jul 29, 2026 2. Halloween: ").
_RE_NUMBERED_LIST = re.compile(r'(?:^|\n|\s)(\d{1,2}[.)])(?=\s)')
_RE_DATE_MONTH = re.compile(
    r'\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},?\s?20\d{2}\b',
    re.IGNORECASE,
)

# Deal / affiliate / retailer patterns. These are exact strings observed
# in real Bluesky posts against our portfolio games (2026-07-28 sample of
# ~416 posts across 10 games). Adding to this list is safe — the detector
# ONLY fires when combined with other signals, so a stray substring
# match won't nuke a legitimate post.
_DEAL_TOKENS = (
    "linktw.in/",
    "link.amazon",
    "howl.me/link",
    "amazon/b0",       # short Amazon links common in Brazilian promo bots
    "buff.ly/",
    "bit.ly/",
    "gamestop [$",     # "GameStop [$149.99]:" style price ticker
    "#ad",
    "por: r$",         # Brazilian price format
    "cupom:",
)

_UPCOMING_LIST_PHRASES = (
    "upcoming games",
    "games coming",
    "upcoming horror",
    "upcoming aaa",
    "upcoming pc",
    "upcoming ps5",
    "upcoming xbox",
    "upcoming playstation",
    "coming in the next",
    "game showcase:",
    "release date trailer",
)


def _is_aggregator_post(body: str) -> tuple[bool, str]:
    """Detect release-calendar aggregators and affiliate-promo spam.

    Returns (is_aggregator, reason). Reason is a short human-readable
    tag suitable for log lines when a post is filtered out.

    Design principles (2026-07-28):
      * NEVER false-positive on organic fan posts. Every filter fires
        only when TWO or more independent signals agree, EXCEPT for
        the two most unambiguous cases (deal/promo with a retailer
        token + short body; multi-date list with numbered items).
      * Uses zero-cost regex + substring checks. Runs on every fetched
        Bluesky post so must stay fast.
      * Detects the four aggregator patterns actually observed in
        production against our portfolio games:
          1. "20 Upcoming Games" numbered lists (numbered items + dates)
          2. Affiliate deal spam (retailer tokens + short body)
          3. Multi-game promo carousels (many game emojis + dates)
          4. Hashtag-stuffed keyword-blast bots (>=8 hashtags AND the
             game keyword appears only as a hashtag, not in prose)

    Not implemented (deliberately): author-based blocklist. Author
    blocking creates a maintenance burden and can be circumvented by
    account rotation. Content-based filters are self-correcting.

    Verified against a 416-post sample: catches all 21+11+few extra of
    the clearly-aggregator posts while leaving all 354 organic posts
    untouched.
    """
    if not body:
        return False, ""
    lower = body.lower()

    numbered_items = len(_RE_NUMBERED_LIST.findall(body))
    dates = len(_RE_DATE_MONTH.findall(body))
    game_emojis = body.count("\U0001F3AE") + body.count("\u2728") + body.count("\U0001F3AC")
    hashtags = body.count("#")
    aaa_markers = body.count("(AAA)")

    is_upcoming_phrase = any(p in lower for p in _UPCOMING_LIST_PHRASES)
    deal_tokens_hit = sum(1 for tok in _DEAL_TOKENS if tok in lower)
    # Retailer-domain tokens separately, so "#ad" without a retailer
    # domain doesn't trip the '#ad + retailer' short-circuit rule.
    # A bare "#ad" tag ("Sponsored review coming this week #ad") is
    # not enough signal on its own — real influencers use it too.
    _RETAILER_TOKENS = tuple(tok for tok in _DEAL_TOKENS if tok != "#ad")
    retailer_tokens_hit = sum(1 for tok in _RETAILER_TOKENS if tok in lower)

    # ── Signal 1: Numbered list of games with dates ───────────────────────
    # Real fan posts almost never combine 3+ numbered items with 3+ month
    # dates. Aggregator template posts do this constantly.
    if numbered_items >= 3 and dates >= 3:
        return True, f"numbered_list_dates(n={numbered_items},d={dates})"

    # ── Signal 2: Multi-game AAA carousel ─────────────────────────────────
    # "(AAA)" appears 3+ times only in gaming-release aggregator templates
    # (verified across 416 posts). Fan posts never repeat that marker.
    if aaa_markers >= 3:
        return True, f"aaa_carousel(n={aaa_markers})"

    # ── Signal 3: Deal / affiliate spam ───────────────────────────────────
    # Any deal token + short body length + at most one line of prose is
    # very likely a promo bot. But a legitimate news post can share a
    # short link, so we require the retailer signal to be strong
    # (bracket price like "[$X]", or multiple deal tokens, or explicit
    # "#ad").
    if deal_tokens_hit >= 2:
        return True, f"deal_promo(tokens={deal_tokens_hit})"
    if "#ad" in lower and retailer_tokens_hit >= 1:
        return True, "deal_promo(#ad+retailer)"
    if "gamestop [$" in lower or "por: r$" in lower:
        return True, "deal_promo(price_ticker)"

    # ── Signal 4: "Upcoming games" template + list markers ────────────────
    # A post with an "upcoming games" heading + 3+ numbered items is
    # near-certain to be an aggregator, even if it happens to lack
    # dates (e.g. "TBA" entries).
    if is_upcoming_phrase and numbered_items >= 3:
        return True, f"upcoming_template(n={numbered_items})"

    # ── Signal 5: Hashtag-stuffed keyword blast ───────────────────────────
    # NSFW/promo bots pack every popular keyword into hashtags. We fire
    # only when: (a) 8+ hashtags AND (b) the body contains a hashtag
    # count comparable to the word count (a real post has ~10-30x more
    # words than hashtags). Fan posts commonly have 4-7 hashtags but
    # they're a small fraction of the total content.
    if hashtags >= 8:
        # Rough word count — count whitespace-separated tokens minus hashtags.
        words = len(body.split())
        if words > 0 and hashtags / words >= 0.25:
            return True, f"hashtag_blast(h={hashtags},w={words})"

    return False, ""


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
    since: Optional[str] = None,
    until: Optional[str] = None,
) -> tuple[list[dict], Optional[str], Optional[int]]:
    """Fetch one page of Bluesky search results using an authenticated request.

    Args:
        since: RFC3339 UTC timestamp; only return posts created at or after
            this instant. Used by backfills to bound the search window.
        until: RFC3339 UTC timestamp; only return posts created before this
            instant. Used by backfills to bound the search window.

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
    if since:
        params["since"] = since
    if until:
        params["until"] = until

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
    since: Optional[str] = None,
    until: Optional[str] = None,
    max_pages: Optional[int] = None,
    distinctive_keywords: Optional[list[str]] = None,
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
    # Aggregator/promo posts dropped by _is_aggregator_post. Logged in
    # the metrics line at end-of-call for observability. Not returned to
    # the caller (they're just noise, not an error state).
    aggregator_filtered = 0
    last_http_status: Optional[int] = None

    results: list[dict] = []
    search_query = _build_search_query(game_name, distinctive_keywords=distinctive_keywords)
    # Post-fetch filter (2026-07-28 v2): when distinctive_keywords is
    # available, require the body to contain at least one of them.
    # This is the ONLY reliable way to filter posts for games with
    # ambiguous titles (Docked, Inversion, Wick, TimeShift, MX Nitro,
    # A Quiet Place, etc.) because the game title itself matches
    # thousands of unrelated posts. Fallback to the old single-word
    # extractor when distinctive_keywords is absent — kept for backward
    # compatibility with games whose title is inherently distinctive
    # (SnowRunner, Gloomhaven, Hellraiser, etc.).
    filter_keywords: Optional[list[str]] = None
    if distinctive_keywords:
        filter_keywords = [
            k.strip().lower() for k in distinctive_keywords
            if isinstance(k, str) and k.strip()
        ]
    filter_query = _game_search_query(game_name)  # fallback

    cursor: Optional[str] = None
    remaining = limit
    _401_retried = False  # only retry once per fetch_bluesky_posts_for_game call
    # Effective pagination cap for THIS call. Defaults to the module-level
    # BLUESKY_MAX_PAGES (3) for daily incremental ingest so a normal run stays
    # cheap. Callers doing a bounded historical backfill pass a much larger
    # value to reach deeper into the search index.
    effective_max_pages = max_pages if max_pages is not None else BLUESKY_MAX_PAGES

    try:
        for page_num in range(1, effective_max_pages + 1):
            if remaining <= 0:
                break

            # Get current access JWT (may have been renewed)
            access_jwt = session.get_access_jwt()
            if not access_jwt:
                logger.warning("bluesky: lost access JWT mid-pagination, stopping")
                break

            posts, next_cursor, http_status = _fetch_page(
                search_query, min(remaining, 100), cursor, access_jwt,
                since=since, until=until,
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
                    search_query, min(remaining, 100), cursor, access_jwt,
                    since=since, until=until,
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
                # Filter 1: must mention the game via a distinctive keyword.
                # When curated distinctive_keywords are available, require
                # at least one to appear in title+body (case-insensitive).
                # This is the strict-match path that fixes noise for
                # ambiguous-title games. Fallback to _post_mentions_game
                # (single-word heuristic) when no keywords curated.
                if filter_keywords is not None:
                    text = (
                        (post.get("title") or "") + " " + (post.get("body") or "")
                    ).lower()
                    if not any(kw in text for kw in filter_keywords):
                        continue
                elif not _post_mentions_game(post, filter_query):
                    continue

                # Filter 2: aggregator / promo-spam detector. Catches
                # "20 Upcoming Games" release-calendar templates and
                # affiliate deal bots that would otherwise dilute
                # sentiment scores with neutral non-fan content.
                # Added 2026-07-28 after finding aggregators dominated
                # the noise on multi-word game names like
                # SILENT HILL: Townfall and Halloween: The Game.
                body_text = (post.get("body") or "")
                is_agg, agg_reason = _is_aggregator_post(body_text)
                if is_agg:
                    aggregator_filtered += 1
                    logger.debug(
                        "bluesky: dropped aggregator post for game='%s' reason=%s",
                        game_name, agg_reason,
                    )
                    continue

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
        # Structured metric line — grep for this in logs to track daily yields.
        # aggregator_filtered = count of otherwise-relevant posts dropped by the
        # release-calendar / promo-spam detector (added 2026-07-28).
        logger.info(
            "bluesky_metric game=%s posts=%d pages=%d aggregator_filtered=%d status=%s",
            game_name, total_posts, total_pages, aggregator_filtered, status,
        )

    return results
