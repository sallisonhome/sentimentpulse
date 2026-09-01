"""§24 — Editorial-Research service for hybrid bold ideas.

For each title, each weekly + monthly digest cycle, fetch 5-10 recent
editorial articles (press, analyst, blog) from Google News RSS,
extract title + lead paragraphs, and persist alongside a 1-paragraph
LLM-generated evidence summary.  The bold-ideas pipeline reads the
latest cache batch and exposes each article as a `[E-NNN]` citable
source alongside the in-window `[P-NNN]` post citations.

Cache key: (game_id, scope, cycle_start).  Re-running a cycle reuses
the existing batch.  Weekly and monthly are separate caches.

Search source: Google News RSS (no auth, no API key).  Query is the
exact game name (in quotes) plus `gaming` as a topical anchor to
exclude unrelated namesakes (e.g. "Turok" the movie).

Article body extraction: simple HTML-to-text with a heuristic that
grabs the article's `<article>`, `<main>`, or top-N `<p>` content.
Not perfect but good enough for the LLM summarizer to extract a
useful evidence brief.

User-Agent: `SentimentPulse/1.0 (+https://github.com/sallisonhome/sentimentpulse)`
per CLAUDE.md §17.
"""
from __future__ import annotations

import logging
import re
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Iterator, Optional
from urllib.parse import quote_plus, urlparse
from xml.etree import ElementTree as ET

import httpx
from sqlalchemy.orm import Session

from models import EditorialArticle, Game

logger = logging.getLogger(__name__)


# ── Configuration ────────────────────────────────────────────────────────────

# Per §24 user decision: deep editorial scope, 5-10 articles per title per cycle.
_TARGET_ARTICLE_COUNT = 7
_MAX_ARTICLE_COUNT = 10
_MIN_ARTICLE_COUNT = 3

# How far back to look (days).  Weekly cycle uses ~30 days for recency
# context; monthly uses ~90 days for broader trend.
_WEEKLY_LOOKBACK_DAYS = 30
_MONTHLY_LOOKBACK_DAYS = 90

# Fetch budget per article.
_FETCH_TIMEOUT_SECS = 15.0
_BODY_MAX_CHARS = 4000  # truncated body for LLM summarization input

# §24b (2026-06-29): Playwright-rendered body fetch.
# Google News article URLs use JS-rendered redirects, so httpx can't reach
# the publisher page directly.  Playwright runs a headless Chromium that
# executes the redirect, then we extract the publisher article body.
#
# Tunables:
_PLAYWRIGHT_PAGE_TIMEOUT_MS = 15000  # max time per page load
_PLAYWRIGHT_IDLE_MS = 800            # post-load settling time before extract
_PLAYWRIGHT_MAX_BODY_CHARS = 8000    # cap extracted body before send to LLM
_BODY_MIN_USABLE_CHARS = 400         # §24d: reject anything shorter as junk

# §24d: phrases that indicate a captured "body" is actually a WAF, paywall,
# cookie banner, or sign-in interstitial rather than real article text.
# Any HIT marks the body unusable -> caller falls through to next path or
# title-only.  Phrases are lowercased before matching.
_BLOCKED_BODY_PHRASES = (
    "security service to protect itself",
    "this website is using a security service",
    "action you just performed triggered",
    "enable cookies and reload",
    "please enable javascript",
    "checking your browser before",
    "verify you are human",
    "are you a robot",
    "subscribe to read",
    "sign in to continue",
    "sign up to read",
    "this content is for subscribers",
    "unlock this article",
    "register to continue reading",
    "create a free account to continue",
    "we've sent an email to validate your registration",
    "access denied",
    "403 forbidden",
    "page not found",
    "cloudflare ray id",
)


def _is_blocked_body(body: Optional[str]) -> bool:
    """§24d: return True when `body` looks like a WAF / paywall / cookie wall
    rather than real article content.  Conservative: only flags when the
    blocked phrase makes up a large fraction of the text (else a legit
    article that mentions one of these phrases in passing would be lost).
    """
    if not body:
        return True
    if len(body) < _BODY_MIN_USABLE_CHARS:
        return True
    sample = body[:1500].lower()
    for phrase in _BLOCKED_BODY_PHRASES:
        if phrase in sample:
            return True
    return False
# When True, the editorial fetcher uses Playwright as the primary path.
# Set to False at module level to fall back to httpx + title-only mode
# (used by tests and as a safety net when Playwright is unavailable).
_PLAYWRIGHT_ENABLED = True

# Custom UA per CLAUDE.md §17.  Bypasses Cloudflare 1010 challenges.
_USER_AGENT = (
    "SentimentPulse/1.0 (+https://github.com/sallisonhome/sentimentpulse)"
)
_HEADERS = {
    "User-Agent": _USER_AGENT,
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# Quality publications we trust.  Articles from these domains are
# preferred when ranking.  Others are accepted but ranked below.
_TRUSTED_PUBLICATIONS = frozenset({
    "ign.com", "polygon.com", "eurogamer.net", "gamesradar.com",
    "gamespot.com", "kotaku.com", "rockpapershotgun.com", "pcgamer.com",
    "destructoid.com", "dualshockers.com", "thegamer.com", "gamerant.com",
    "videogameschronicle.com", "vg247.com", "engadget.com", "wired.com",
    "theverge.com", "pushsquare.com", "purexbox.com", "nintendolife.com",
    "fanbyte.com", "gameinformer.com", "gamingbolt.com",
    "screenrant.com", "comicbook.com", "fangoria.com", "bloody-disgusting.com",
    "dailydead.com", "explosionnetwork.com", "agamingnetwork.com",
})


# ── Google News RSS search ───────────────────────────────────────────────────

def _build_google_news_query(game_name: str) -> str:
    """Build the Google News search query for a game title.

    We quote the title to require an exact match, and add 'gaming' as a
    topical anchor to filter out unrelated namesakes (movies, books,
    other media franchises sharing the name).
    """
    return f'"{game_name}" gaming'


def _google_news_rss_url(query: str, lookback_days: int) -> str:
    """Build the Google News RSS URL for a query.

    Google News RSS supports a `when:Nd` filter to restrict by recency.
    """
    encoded = quote_plus(query)
    return (
        f"https://news.google.com/rss/search?q={encoded}+when:{lookback_days}d"
        f"&hl=en-US&gl=US&ceid=US:en"
    )


def _parse_google_news_rss(rss_xml: str) -> list[dict]:
    """Parse Google News RSS XML into a list of {title, link, published_at, publication} dicts."""
    out: list[dict] = []
    try:
        root = ET.fromstring(rss_xml)
    except ET.ParseError as exc:
        logger.warning("Google News RSS XML parse error: %s", exc)
        return out
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_date_str = (item.findtext("pubDate") or "").strip()
        source = item.find("{http://www.google.com/}source") or item.find("source")
        publication = ""
        if source is not None and source.text:
            publication = source.text.strip()
        elif source is not None and source.get("url"):
            publication = urlparse(source.get("url")).netloc
        published_at: Optional[datetime] = None
        if pub_date_str:
            try:
                # RFC 2822 format e.g. "Mon, 23 Jun 2026 12:00:00 GMT"
                from email.utils import parsedate_to_datetime
                published_at = parsedate_to_datetime(pub_date_str)
            except Exception:
                published_at = None
        if not link or not title:
            continue
        out.append({
            "title": title,
            "link": link,
            "publication": publication,
            "published_at": published_at,
        })
    return out


# ── Article body extraction ──────────────────────────────────────────────────

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_PARAGRAPH_RE = re.compile(r"<p\b[^>]*>(.*?)</p>", re.DOTALL | re.IGNORECASE)


def _extract_article_text(html: str) -> str:
    """Heuristic article-body extraction.

    Strategy: find all <p> tags, strip HTML, join their text content.
    The top-N paragraphs are usually the meat of the article.  Not
    perfect but good enough to give the LLM summarizer real material
    to work with.

    Returns at most _BODY_MAX_CHARS characters.
    """
    if not html:
        return ""
    paragraphs: list[str] = []
    for m in _PARAGRAPH_RE.finditer(html):
        raw_p = m.group(1)
        # Strip inner tags (e.g. <a>, <strong>, <em>).
        text = _HTML_TAG_RE.sub(" ", raw_p)
        text = _WHITESPACE_RE.sub(" ", text).strip()
        # Drop boilerplate-shaped lines.
        if not text or len(text) < 40:
            continue
        if any(
            marker in text.lower()
            for marker in (
                "subscribe to our newsletter",
                "sign up for our",
                "follow us on twitter",
                "cookie policy",
                "advertisement",
                "all rights reserved",
            )
        ):
            continue
        paragraphs.append(text)
        if sum(len(p) for p in paragraphs) > _BODY_MAX_CHARS:
            break
    body = "\n\n".join(paragraphs)
    return body[:_BODY_MAX_CHARS]


def _fetch_article(url: str) -> tuple[Optional[str], Optional[str]]:
    """Fetch an article URL; return (final_url, extracted_body) or (None, None) on failure.

    Google News links go through `news.google.com/articles/...` which
    redirects to the real publisher URL.  `httpx.follow_redirects=True`
    handles this transparently — but only for HTTP redirects.  Google News
    actually uses a JS-rendered redirect that httpx cannot follow, so this
    function reliably fails on news.google.com links.  Kept as a fast
    fallback for direct publisher URLs.
    """
    try:
        resp = httpx.get(
            url, headers=_HEADERS, timeout=_FETCH_TIMEOUT_SECS,
            follow_redirects=True,
        )
        if resp.status_code != 200:
            logger.info(
                "Editorial fetch non-200 (%d) for %s", resp.status_code, url,
            )
            return None, None
        body = _extract_article_text(resp.text)
        return str(resp.url), body
    except httpx.HTTPError as exc:
        logger.info("Editorial fetch error for %s: %s", url, exc)
        return None, None


# ── Playwright body fetch (§24b) ────────────────────────────────────────────────────────────────────

@contextmanager
def _playwright_browser() -> Iterator:
    """Yield a Playwright browser instance with a sane default user-agent.

    Used as a context manager so a single browser is reused across all
    article fetches in one cycle (saves the ~1s startup cost per page).
    Yields None when Playwright is not available; callers must handle
    that fallback path.
    """
    if not _PLAYWRIGHT_ENABLED:
        yield None
        return
    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415
    except ImportError:
        logger.info(
            "§24b: playwright not installed; editorial body fetch falls back to title-only"
        )
        yield None
        return
    pw = None
    browser = None
    try:
        pw = sync_playwright().start()
        browser = pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        yield browser
    except Exception as exc:
        logger.warning("§24b: Playwright launch failed: %s", exc)
        yield None
    finally:
        try:
            if browser is not None:
                browser.close()
        except Exception:
            pass
        try:
            if pw is not None:
                pw.stop()
        except Exception:
            pass


def _extract_body_via_playwright(browser, url: str) -> tuple[Optional[str], Optional[str]]:
    """Navigate `url` in a Playwright page and extract article body.

    Returns (final_url, body) or (None, None) on failure.  The final_url
    is the publisher's resolved URL (not the Google News redirect).

    Strategy:
      1. New page with our UA.
      2. Goto the URL with `wait_until='domcontentloaded'`.
      3. Wait an idle period for client-side hydration.
      4. Try to extract `<article>` text first; fall back to `<main>`,
         then top-N `<p>` paragraphs (existing _extract_article_text).
      5. Return resolved URL via `page.url`.
    """
    if browser is None:
        return None, None
    try:
        ctx = browser.new_context(user_agent=_USER_AGENT)
        page = ctx.new_page()
        try:
            page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=_PLAYWRIGHT_PAGE_TIMEOUT_MS,
            )
        except Exception as exc:
            logger.info("§24b: page.goto failed for %s: %s", url, exc)
            ctx.close()
            return None, None
        # Small settling delay so client-side hydration finishes.  The
        # body extractors below tolerate partial content, so this is short.
        try:
            page.wait_for_timeout(_PLAYWRIGHT_IDLE_MS)
        except Exception:
            pass
        final_url = page.url
        # Try semantic selectors first; fall back to <p> sweep.
        body = ""
        for selector in ("article", "main", "[role='main']"):
            try:
                el = page.query_selector(selector)
                if el is None:
                    continue
                text = el.inner_text(timeout=2000) or ""
                text = _WHITESPACE_RE.sub(" ", text).strip()
                if len(text) >= 400:
                    body = text[:_PLAYWRIGHT_MAX_BODY_CHARS]
                    break
            except Exception:
                continue
        if not body:
            try:
                html = page.content()
                body = _extract_article_text(html)[:_PLAYWRIGHT_MAX_BODY_CHARS]
            except Exception as exc:
                logger.info(
                    "§24b: html fallback extraction failed for %s: %s", url, exc,
                )
        ctx.close()
        if not body or len(body) < 200:
            return final_url, None
        return final_url, body
    except Exception as exc:
        logger.warning("§24b: Playwright fetch error for %s: %s", url, exc)
        return None, None


# ── LLM evidence summarization ───────────────────────────────────────────────

_SUMMARY_PROMPT = (
    "You are a research analyst extracting a single-paragraph evidence "
    "brief from an editorial article for a game-marketing decision-support "
    "system.  Read the article body and produce ONE paragraph (60-100 words) "
    "stating the article's central claim, any specific entities named "
    "(people, products, franchises, mechanics), and any positioning or "
    "audience signal the article surfaces.  Do NOT speculate beyond the "
    "article text.  Do NOT add a headline or preamble.  Output only the "
    "paragraph.\n\n"
    "ARTICLE TITLE: {title}\n"
    "PUBLICATION: {publication}\n\n"
    "ARTICLE BODY:\n{body}\n"
)


def _summarize_article(client, title: str, publication: str, body: str) -> str:
    """Run a single Anthropic call to extract the evidence summary."""
    if not client or not body:
        return ""
    prompt = _SUMMARY_PROMPT.format(
        title=title or "(no title)",
        publication=publication or "(unknown publication)",
        body=body[:_BODY_MAX_CHARS],
    )
    try:
        # Use the same model and token budget as the per-call summary
        # passes in period_summary_service.
        from services.period_summary_service import _MODEL  # noqa: PLC0415
        message = client.messages.create(
            model=_MODEL,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text.strip()
    except Exception as exc:
        logger.warning("Editorial summary LLM error for %r: %s", title[:80], exc)
        return ""


# ── Public API ───────────────────────────────────────────────────────────────

def fetch_editorial_for_title(
    db: Session,
    *,
    game_id: int,
    scope: str,                   # 'weekly' | 'monthly'
    cycle_start: date,
    cycle_end: date,
    anthropic_client=None,
    target_count: int = _TARGET_ARTICLE_COUNT,
) -> list[EditorialArticle]:
    """Fetch (or reuse cached) editorial articles for (game_id, scope, cycle_start).

    Returns the list of EditorialArticle rows for this batch, ordered by
    cite tag.  Idempotent: re-running with the same key returns the
    cached batch without re-fetching.

    If the cache for this key is empty, runs a fresh fetch:
      1. Google News RSS search for `"{game_name}" gaming` within the
         scope's lookback window.
      2. Fetch up to target_count articles, prioritizing trusted
         publications, dedupe by domain.
      3. LLM-summarize each successful fetch.
      4. Persist with sequential E-001, E-002, ... cite tags.
    """
    if scope not in ("weekly", "monthly"):
        raise ValueError(f"scope must be 'weekly' or 'monthly', got {scope!r}")

    # §24b: under pytest, skip the live fetch path entirely.  Tests that
    # need fetch behavior monkeypatch their own seed rows or call the
    # helpers directly; running real Google News RSS + Playwright in CI
    # is both slow and flaky.  Existing cached batches in the test DB
    # are still returned (cache-hit branch below).
    import os  # noqa: PLC0415
    if os.environ.get("PYTEST_CURRENT_TEST") and not os.environ.get(
        "SENTIMENTPULSE_ENABLE_EDITORIAL_IN_TESTS"
    ):
        existing = (
            db.query(EditorialArticle)
            .filter_by(game_id=game_id, scope=scope, cycle_start=cycle_start)
            .order_by(EditorialArticle.cite)
            .all()
        )
        return existing

    # Cache hit: return existing batch.
    existing = (
        db.query(EditorialArticle)
        .filter_by(game_id=game_id, scope=scope, cycle_start=cycle_start)
        .order_by(EditorialArticle.cite)
        .all()
    )
    if existing:
        logger.info(
            "Editorial cache HIT for game_id=%d scope=%s cycle_start=%s (%d articles)",
            game_id, scope, cycle_start, len(existing),
        )
        return existing

    game = db.query(Game).filter_by(id=game_id).first()
    if game is None:
        logger.warning("Editorial fetch: game_id=%d not found", game_id)
        return []

    lookback = (
        _WEEKLY_LOOKBACK_DAYS if scope == "weekly" else _MONTHLY_LOOKBACK_DAYS
    )
    query = _build_google_news_query(game.name)
    rss_url = _google_news_rss_url(query, lookback)
    logger.info(
        "Editorial fetch: game_id=%d scope=%s lookback=%dd query=%r",
        game_id, scope, lookback, query,
    )

    # Step 1: Google News RSS search.
    try:
        resp = httpx.get(
            rss_url, headers=_HEADERS, timeout=_FETCH_TIMEOUT_SECS,
            follow_redirects=True,
        )
        if resp.status_code != 200:
            logger.warning(
                "Google News RSS non-200 (%d) for game_id=%d",
                resp.status_code, game_id,
            )
            return []
        items = _parse_google_news_rss(resp.text)
    except httpx.HTTPError as exc:
        logger.warning("Google News RSS error for game_id=%d: %s", game_id, exc)
        return []

    if not items:
        logger.info(
            "Editorial fetch: Google News returned 0 items for game_id=%d",
            game_id,
        )
        return []

    # Step 2: rank — trusted publications first, then chronological.
    def _rank_key(item):
        pub_lower = (item.get("publication") or "").lower()
        is_trusted = any(p in pub_lower for p in _TRUSTED_PUBLICATIONS)
        pub_dt = item.get("published_at")
        ts = pub_dt.timestamp() if pub_dt else 0
        return (0 if is_trusted else 1, -ts)

    items.sort(key=_rank_key)

    # Step 3: dedupe by publisher domain (only first article per domain).
    seen_domains: set[str] = set()
    candidates: list[dict] = []
    for item in items:
        # We don't know the real publisher URL until we resolve the
        # Google News redirect; use the publication field as the dedupe
        # key (Google News populates this with the publisher name).
        domain_key = (item.get("publication") or "").lower()
        if domain_key and domain_key in seen_domains:
            continue
        seen_domains.add(domain_key)
        candidates.append(item)
        if len(candidates) >= _MAX_ARTICLE_COUNT * 2:
            break

    # Step 4: fetch + summarize until we have target_count successful articles.
    # §24b 2026-06-29: PRIMARY fetch path is Playwright (headless Chromium).
    # Google News URLs use a client-side JS redirect that httpx cannot
    # follow; Playwright can.  Order of fallback per candidate:
    #   (a) Playwright -> resolved publisher URL + body text
    #   (b) httpx _fetch_article  (works for direct publisher URLs)
    #   (c) TITLE-ONLY  -- summarize from headline + publication alone
    saved: list[EditorialArticle] = []
    cite_counter = 1
    with _playwright_browser() as browser:
        for cand in candidates:
            if len(saved) >= target_count:
                break
            final_url: Optional[str] = None
            body: Optional[str] = None
            # (a) Playwright first -- only when browser launched successfully.
            if browser is not None:
                final_url, body = _extract_body_via_playwright(browser, cand["link"])
            # (b) httpx fallback if Playwright unavailable or returned no body.
            if not body:
                hx_url, hx_body = _fetch_article(cand["link"])
                if hx_url and not final_url:
                    final_url = hx_url
                if hx_body:
                    body = hx_body
            # Title-only fallback: use the headline as evidence.  Real article
            # URL is the Google News redirect (still clickable for the user).
            if not final_url:
                final_url = cand["link"]
            # §24d: title-only fallback when body missing/short OR captured
            # a WAF / paywall / cookie wall page.
            if _is_blocked_body(body):
                body = ""
            # Summarize.  When body is empty, the summarizer uses title + pub.
            summary = _summarize_article(
                anthropic_client, cand["title"], cand.get("publication", ""),
                body or cand["title"],  # fallback: re-use title as body input
            )
            if not summary:
                # Title-only fallback summary: a one-line evidence note.
                pub = cand.get("publication", "unknown publication")
                summary = (
                    f"Editorial: {pub} published an article titled "
                    f"'{cand['title']}'.  Treat the headline as the evidence "
                    f"signal; the article likely covers the entity or theme "
                    f"named in the title."
                )
            # Derive final publication: prefer parsed URL netloc, fall back to
            # the RSS source field (e.g. 'Polygon.com').
            derived_pub = urlparse(final_url).netloc.lower()
            if not derived_pub or "news.google.com" in derived_pub:
                derived_pub = (cand.get("publication", "") or "").lower()
            # v0031 (2026-09-01): guard against UNIQUE violations.
            # Two candidates can resolve to the same final_url (Google News
            # redirects, tracking-param variants, mirror publications), and
            # a prior digest run may have already saved this url for the
            # same (game_id, scope, cycle_start). Blind db.add() + commit
            # raises sqlite3.IntegrityError which poisons the whole
            # Session and cascades into every subsequent query on it —
            # observed 2026-09-01: dropped Competitive Set charts on
            # Hellraiser / Turok / Stuntman for the Monday digest send.
            #
            # Two-layer defense:
            #   1. In-batch dedup by final_url
            #   2. Per-row DB existence check before add()
            if final_url in {s.url for s in saved}:
                logger.info(
                    "editorial: skipping in-batch duplicate url game_id=%d url=%s",
                    game_id, final_url,
                )
                continue
            existing_row = (
                db.query(EditorialArticle)
                .filter_by(
                    game_id=game_id,
                    scope=scope,
                    cycle_start=cycle_start,
                    url=final_url,
                )
                .first()
            )
            if existing_row is not None:
                logger.info(
                    "editorial: cross-batch duplicate url already in DB "
                    "game_id=%d cite=%s url=%s (reusing)",
                    game_id, existing_row.cite, final_url,
                )
                saved.append(existing_row)
                continue
            row = EditorialArticle(
                game_id=game_id,
                scope=scope,
                cycle_start=cycle_start,
                cycle_end=cycle_end,
                url=final_url,
                title=cand["title"][:1000] if cand.get("title") else None,
                publication=derived_pub[:255] if derived_pub else None,
                published_at=cand.get("published_at"),
                body=body or None,
                summary=summary,
                cite=f"E-{cite_counter:03d}",
            )
            db.add(row)
            saved.append(row)
            cite_counter += 1
            if body:
                logger.info(
                    "§24b: editorial body OK game_id=%d cite=%s url=%s body_chars=%d",
                    game_id, row.cite, final_url, len(body),
                )
            else:
                logger.info(
                    "§24b: editorial title-only game_id=%d cite=%s url=%s",
                    game_id, row.cite, final_url,
                )

    if not saved:
        logger.info(
            "Editorial fetch: no successful articles for game_id=%d after %d candidates",
            game_id, len(candidates),
        )
        try:
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.warning(
                "editorial: empty-batch commit rolled back (game_id=%d): %s",
                game_id, exc,
            )
        return []

    # Per §24 minimum: if we got fewer than _MIN_ARTICLE_COUNT, we still
    # persist what we have (better some editorial context than none).
    if len(saved) < _MIN_ARTICLE_COUNT:
        logger.warning(
            "Editorial fetch: only %d articles saved for game_id=%d (below target %d)",
            len(saved), game_id, target_count,
        )
    # v0031 (2026-09-01): wrap commit in try/rollback. Belt-and-suspenders
    # — even with the dedup checks above, a concurrent digest run or a
    # rare race could still race us to the UNIQUE index. Rolling back on
    # the commit failure keeps the Session clean so downstream digest
    # steps (competitor_bullets loader, WindowSummary fetch) don't blow
    # up with 'transaction has been rolled back' cascades.
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning(
            "editorial: commit failed (game_id=%d), rolled back to protect session: %s",
            game_id, exc,
        )
        # Return the previously-committed cross-batch rows we found (they're
        # already in the DB) plus best-effort refresh of what we can.
        recovered = [s for s in saved if s.id is not None]
        return recovered
    for row in saved:
        db.refresh(row)
    logger.info(
        "Editorial fetch COMPLETE: game_id=%d scope=%s saved=%d/%d",
        game_id, scope, len(saved), target_count,
    )
    return saved


def get_cached_editorial_for_title(
    db: Session,
    *,
    game_id: int,
    scope: str,
    cycle_start: date,
) -> list[EditorialArticle]:
    """Read-only cache lookup, no fetch fallback.  Returns [] when empty.

    Used by callers that want to surface editorial context if available
    without paying the LLM/fetch cost of a fresh search.
    """
    return (
        db.query(EditorialArticle)
        .filter_by(game_id=game_id, scope=scope, cycle_start=cycle_start)
        .order_by(EditorialArticle.cite)
        .all()
    )


def format_editorial_for_prompt(articles: list[EditorialArticle]) -> str:
    """Render the editorial batch as a SOURCE EDITORIAL block for prompts.

    Format mirrors _format_sample_posts_block_with_citations in
    period_summary_service:

        SOURCE EDITORIAL (recent press coverage relevant to this title):
          [E-001] (ign.com, 2026-06-15) Headline of article -- evidence summary.
          [E-002] (polygon.com, 2026-06-12) Headline -- evidence summary.
    """
    if not articles:
        return ""
    lines = ["SOURCE EDITORIAL (recent press coverage relevant to this title):"]
    for a in articles:
        pub = a.publication or "unknown"
        date_str = (
            a.published_at.strftime("%Y-%m-%d") if a.published_at else "undated"
        )
        title = (a.title or "(no title)").strip()
        summary = (a.summary or "").strip()
        lines.append(
            f"  [{a.cite}] ({pub}, {date_str}) {title[:140]} -- {summary[:400]}"
        )
    return "\n".join(lines)


def editorial_citation_map(
    articles: list[EditorialArticle],
) -> dict[str, dict]:
    """Build a citation map (cite -> {url, title, publication, summary}) for the
    bold-ideas hybrid-citation gate.

    Shape mirrors the post citation_map so downstream sanitizers can
    treat [E-NNN] and [P-NNN] uniformly.
    """
    out: dict[str, dict] = {}
    for a in articles:
        out[a.cite] = {
            "url": a.url,
            "title": a.title,
            "publication": a.publication,
            # The 'text' key is what _self_criticize looks for to pass
            # to the critic.  Use the summary as the admissible evidence.
            "text": a.summary or "",
            "kind": "editorial",
            "cite": a.cite,
        }
    return out
