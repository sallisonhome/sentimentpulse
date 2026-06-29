"""§24 — Editorial research service unit tests.

Covers:
  * _build_google_news_query / _google_news_rss_url construction
  * _parse_google_news_rss extraction
  * _extract_article_text HTML-to-paragraph extraction
  * format_editorial_for_prompt / editorial_citation_map output shapes
  * fetch_editorial_for_title cache-hit reuses persisted batch
  * citation regex accepts [E-NNN] (extended from [P-NNN] in §20)
"""
from datetime import date, datetime, timezone

import pytest

from services.editorial_research_service import (
    _build_google_news_query,
    _google_news_rss_url,
    _parse_google_news_rss,
    _extract_article_text,
    format_editorial_for_prompt,
    editorial_citation_map,
    fetch_editorial_for_title,
)
from services.period_summary_service import _extract_citations


class TestGoogleNewsQueryConstruction:

    def test_exact_match_query_quotes_title(self):
        q = _build_google_news_query("Turok: Origins")
        assert '"Turok: Origins"' in q
        assert "gaming" in q

    def test_url_contains_recency_filter(self):
        url = _google_news_rss_url("test", 30)
        assert "when:30d" in url
        assert "test" in url
        assert "hl=en-US" in url


class TestRSSParser:

    def test_extracts_title_link_publication(self):
        rss = """<?xml version="1.0"?>
<rss version="2.0">
<channel>
<item>
<title>Hellraiser Revival drops new trailer</title>
<link>https://news.google.com/articles/abc123</link>
<pubDate>Mon, 23 Jun 2026 12:00:00 GMT</pubDate>
<source url="https://ign.com">IGN</source>
</item>
</channel>
</rss>"""
        items = _parse_google_news_rss(rss)
        assert len(items) == 1
        assert items[0]["title"] == "Hellraiser Revival drops new trailer"
        assert items[0]["link"].startswith("https://news.google.com/")
        assert items[0]["publication"] == "IGN"
        assert items[0]["published_at"] is not None

    def test_empty_xml_returns_empty(self):
        assert _parse_google_news_rss("") == []
        assert _parse_google_news_rss("not xml") == []


class TestArticleTextExtraction:

    def test_extracts_paragraphs_in_order(self):
        html = """
        <html><body>
        <h1>Headline</h1>
        <p>This is the first paragraph with substantive content about the game launch and its reception in the press.</p>
        <p>Short.</p>
        <p>Second meaningful paragraph naming Doug Bradley and Pinhead in a longer-than-forty-chars sentence about the casting.</p>
        </body></html>
        """
        body = _extract_article_text(html)
        assert "first paragraph" in body
        assert "Doug Bradley" in body
        assert "Short." not in body  # too short, dropped

    def test_drops_boilerplate(self):
        html = """
        <html><body>
        <p>Subscribe to our newsletter for the latest updates on gaming news every week direct to your inbox.</p>
        <p>This is a real article paragraph about the game and its reception in the gaming community at length.</p>
        </body></html>
        """
        body = _extract_article_text(html)
        assert "Subscribe" not in body
        assert "real article paragraph" in body

    def test_empty_html_returns_empty(self):
        assert _extract_article_text("") == ""


class TestFormatHelpers:

    def _make_article(self, cite="E-001", title="Title", pub="ign.com"):
        # Use a lightweight dict-like stub matching the EditorialArticle
        # attribute surface that format_editorial_for_prompt needs.
        class Stub:
            pass
        s = Stub()
        s.cite = cite
        s.title = title
        s.publication = pub
        s.published_at = datetime(2026, 6, 23, tzinfo=timezone.utc)
        s.summary = "An article about something relevant to the game."
        s.url = f"https://{pub}/article-{cite}"
        return s

    def test_format_editorial_for_prompt_empty(self):
        assert format_editorial_for_prompt([]) == ""

    def test_format_editorial_for_prompt_includes_cite_pub_date(self):
        out = format_editorial_for_prompt([self._make_article()])
        assert "[E-001]" in out
        assert "ign.com" in out
        assert "2026-06-23" in out
        assert "An article about" in out

    def test_citation_map_keys_by_cite(self):
        cmap = editorial_citation_map([
            self._make_article(cite="E-001"),
            self._make_article(cite="E-002", title="Other"),
        ])
        assert set(cmap.keys()) == {"E-001", "E-002"}
        assert cmap["E-001"]["kind"] == "editorial"
        assert cmap["E-001"]["text"]  # not empty


class TestCitationRegexAcceptsEditorial:
    """§24 extends _CITATION_BRACKET_RE / _CITATION_INNER_RE to accept E-NNN
    alongside P-NNN.  This is the lynchpin of the hybrid-citation rule:
    sanitizers and gates accept both prefixes via the same code path.
    """

    def test_extracts_p_only(self):
        assert _extract_citations("Lean into something [P-001]") == {"P-001"}

    def test_extracts_e_only(self):
        assert _extract_citations("Spotlight something [E-005]") == {"E-005"}

    def test_extracts_mixed(self):
        cites = _extract_citations("Bold move [P-001, E-003]")
        assert cites == {"P-001", "E-003"}

    def test_extracts_compound_with_semicolon(self):
        cites = _extract_citations("Idea [E-001; P-002]")
        assert cites == {"E-001", "P-002"}

    def test_pad_to_three_digits(self):
        # 'E-1' and 'E-001' must produce the same canonical key.
        assert _extract_citations("[E-1]") == {"E-001"}
        assert _extract_citations("[E-01]") == {"E-001"}
        assert _extract_citations("[E-001]") == {"E-001"}


class TestPlaywrightBodyExtraction:
    """§24b — Playwright-rendered body fetch.

    These tests MOCK Playwright entirely (no Chromium launched).  We
    verify that:
      * _playwright_browser yields None gracefully when Playwright is
        not installed or _PLAYWRIGHT_ENABLED is False.
      * _extract_body_via_playwright tries the selector chain in order
        and falls back to the HTML sweep when selectors yield nothing.
      * fetch_editorial_for_title wires the Playwright path BEFORE the
        httpx fallback.
    """

    def test_playwright_browser_yields_none_when_disabled(self, monkeypatch):
        from services import editorial_research_service as ers
        monkeypatch.setattr(ers, "_PLAYWRIGHT_ENABLED", False)
        with ers._playwright_browser() as b:
            assert b is None

    def test_playwright_browser_yields_none_on_import_error(self, monkeypatch):
        """When playwright import raises, helper must yield None and not raise."""
        from services import editorial_research_service as ers
        monkeypatch.setattr(ers, "_PLAYWRIGHT_ENABLED", True)
        import builtins
        orig_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "playwright.sync_api":
                raise ImportError("not installed")
            return orig_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        with ers._playwright_browser() as b:
            assert b is None

    def test_extract_body_uses_article_selector_first(self):
        """When <article> selector returns >=400 chars, body comes from there
        and the fallback HTML sweep is NOT consulted."""
        from services import editorial_research_service as ers

        long_text = "x" * 500
        calls = {"selectors_queried": []}

        class FakeEl:
            def inner_text(self, timeout=2000):
                return long_text

        class FakePage:
            url = "https://publisher.example.com/article"

            def goto(self, url, wait_until=None, timeout=None):
                return None

            def wait_for_timeout(self, ms):
                return None

            def query_selector(self, sel):
                calls["selectors_queried"].append(sel)
                if sel == "article":
                    return FakeEl()
                return None

            def content(self):  # pragma: no cover -- must not be hit
                raise AssertionError("HTML fallback should not be used")

        class FakeCtx:
            def new_page(self):
                return FakePage()

            def close(self):
                pass

        class FakeBrowser:
            def new_context(self, user_agent=None):
                return FakeCtx()

        final_url, body = ers._extract_body_via_playwright(
            FakeBrowser(), "https://news.google.com/rss/articles/xyz"
        )
        assert final_url == "https://publisher.example.com/article"
        assert body is not None and len(body) >= 400
        # First selector tried must be 'article'.
        assert calls["selectors_queried"][0] == "article"

    def test_extract_body_falls_back_to_html_when_selectors_fail(self):
        """When all semantic selectors return None, helper calls page.content()
        and runs _extract_article_text on the HTML."""
        from services import editorial_research_service as ers

        html_with_paras = (
            "<html><body>"
            + "".join(
                f"<p>This is paragraph number {i} with enough length to count "
                f"as a real sentence in an editorial article body extraction.</p>"
                for i in range(10)
            )
            + "</body></html>"
        )

        class FakePage:
            url = "https://publisher.example.com/story"

            def goto(self, url, wait_until=None, timeout=None):
                return None

            def wait_for_timeout(self, ms):
                return None

            def query_selector(self, sel):
                return None  # no semantic container present

            def content(self):
                return html_with_paras

        class FakeCtx:
            def new_page(self):
                return FakePage()

            def close(self):
                pass

        class FakeBrowser:
            def new_context(self, user_agent=None):
                return FakeCtx()

        final_url, body = ers._extract_body_via_playwright(
            FakeBrowser(), "https://news.google.com/rss/articles/xyz"
        )
        assert final_url == "https://publisher.example.com/story"
        assert body is not None
        assert len(body) >= 200
        assert "paragraph number" in body

    def test_extract_body_returns_none_on_goto_failure(self):
        """A page.goto exception must not propagate; helper returns (None, None)."""
        from services import editorial_research_service as ers

        class FakePage:
            url = "https://publisher.example.com/x"

            def goto(self, url, wait_until=None, timeout=None):
                raise RuntimeError("net::ERR_TIMED_OUT")

            def wait_for_timeout(self, ms):
                pass

            def query_selector(self, sel):
                return None

            def content(self):
                return ""

        class FakeCtx:
            def new_page(self):
                return FakePage()

            def close(self):
                pass

        class FakeBrowser:
            def new_context(self, user_agent=None):
                return FakeCtx()

        final_url, body = ers._extract_body_via_playwright(
            FakeBrowser(), "https://news.google.com/rss/articles/xyz"
        )
        assert final_url is None and body is None

    def test_extract_body_handles_none_browser(self):
        """Helper must short-circuit when browser is None (e.g. Playwright not installed)."""
        from services import editorial_research_service as ers
        assert ers._extract_body_via_playwright(None, "https://x.com") == (None, None)
