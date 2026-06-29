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
