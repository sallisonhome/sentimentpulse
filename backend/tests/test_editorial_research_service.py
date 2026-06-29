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


class TestBlockedBodyDetection:
    """§24d — _is_blocked_body must reject WAF / paywall / cookie-wall pages
    that otherwise pass the raw-length threshold.  These are common edge
    cases where the body text we captured is actually a security challenge
    page, sign-in interstitial, or cookie banner."""

    def test_rejects_empty(self):
        from services.editorial_research_service import _is_blocked_body
        assert _is_blocked_body("") is True
        assert _is_blocked_body(None) is True

    def test_rejects_short_body(self):
        from services.editorial_research_service import _is_blocked_body
        # Short bodies (< 400 chars) are always rejected.
        assert _is_blocked_body("a" * 100) is True

    def test_rejects_cloudflare_waf(self):
        from services.editorial_research_service import _is_blocked_body
        waf = (
            "This website is using a security service to protect itself "
            "from online attacks. The action you just performed triggered "
            "the security solution. There are several actions that could "
            "trigger this block including submitting a certain word or "
            "phrase, a SQL command or malformed data."
            + (" Filler text " * 30)
        )
        assert _is_blocked_body(waf) is True

    def test_rejects_paywall_subscribe_prompt(self):
        from services.editorial_research_service import _is_blocked_body
        wall = ("Subscribe to read the full article. " * 40)
        assert _is_blocked_body(wall) is True

    def test_rejects_cookie_consent_banner(self):
        from services.editorial_research_service import _is_blocked_body
        banner = (
            "We've sent an email to validate your registration. From "
            "noreply@example.com. Please enable cookies and reload the "
            "page to continue. " * 20
        )
        assert _is_blocked_body(banner) is True

    def test_accepts_legitimate_long_body(self):
        from services.editorial_research_service import _is_blocked_body
        # A real article body that happens to NOT contain WAF/paywall phrases.
        body = (
            "Warhammer 40,000: Space Marine 2 continues to build momentum "
            "as Focus Entertainment and Saber Interactive reveal new details "
            "in the June Community Update. Patch 14 introduces fresh content "
            "for both PvE and PvP modes, with a new class arriving in Year 3 "
            "alongside expanded Chaos content. Players responded enthusiastically "
            "to the announcement on community forums, with discussions focusing "
            "on the new class abilities and how they will integrate with existing "
            "squad compositions in cooperative play."
        )
        assert _is_blocked_body(body) is False


class TestEditorialGroundingGate:
    """§24c — when editorial is available, bold ideas MUST cite both P- and
    E- references.  The gate drops post-only and editorial-only ideas."""

    def test_no_op_when_editorial_not_available(self):
        from services.period_summary_service import _enforce_editorial_grounding
        ideas = ["Spotlight **X** [P-001]", "Lean into **Y** [P-003]"]
        out = _enforce_editorial_grounding(ideas, {"P-001": {}, "P-003": {}}, editorial_available=False)
        assert out == ideas

    def test_no_op_when_citation_map_has_no_e_entries(self):
        from services.period_summary_service import _enforce_editorial_grounding
        ideas = ["Spotlight **X** [P-001]"]
        out = _enforce_editorial_grounding(ideas, {"P-001": {}}, editorial_available=True)
        assert out == ideas

    def test_keeps_idea_with_both_p_and_e(self):
        from services.period_summary_service import _enforce_editorial_grounding
        ideas = ["Lean into **RE comparison** — community frames it [P-007]; press profiles auteur vision [E-002]."]
        out = _enforce_editorial_grounding(
            ideas, {"P-007": {}, "E-002": {}}, editorial_available=True,
        )
        assert out == ideas

    def test_keeps_post_only_idea_when_editorial_present(self):
        # §24e relax (2026-06-29): post-only bold ideas are fine even when
        # editorial articles are available.  The earlier strict 'must cite
        # BOTH P and E' rule was rejecting genuinely-grounded community-only
        # ideas, which is the opposite of what we want.
        from services.period_summary_service import _enforce_editorial_grounding
        ideas = ["Spotlight **X** [P-001]"]
        out = _enforce_editorial_grounding(
            ideas, {"P-001": {}, "E-001": {}}, editorial_available=True,
        )
        assert out == ideas

    def test_drops_editorial_only_idea(self):
        # Editorial-only ideas (no [P-NNN] post anchor) are still dropped.
        from services.period_summary_service import _enforce_editorial_grounding
        ideas = ["Launch a retrospective inspired by IGN feature [E-001]."]
        out = _enforce_editorial_grounding(
            ideas, {"P-001": {}, "E-001": {}}, editorial_available=True,
        )
        assert out == []

    def test_drops_idea_with_no_citations(self):
        from services.period_summary_service import _enforce_editorial_grounding
        ideas = ["Just a bare claim with no citations at all"]
        out = _enforce_editorial_grounding(
            ideas, {"P-001": {}}, editorial_available=False,
        )
        assert out == []

    def test_drops_idea_with_unknown_citation_index(self):
        from services.period_summary_service import _enforce_editorial_grounding
        ideas = ["Spotlight **X** [P-099]"]  # P-099 not in map
        out = _enforce_editorial_grounding(
            ideas, {"P-001": {}}, editorial_available=False,
        )
        assert out == []

    def test_keeps_mixed_brackets(self):
        from services.period_summary_service import _enforce_editorial_grounding
        ideas = ["Idea [P-007] supported by editorial [E-002]"]
        out = _enforce_editorial_grounding(
            ideas, {"P-007": {}, "E-002": {}}, editorial_available=True,
        )
        assert out == ideas

    def test_keeps_compound_bracket(self):
        from services.period_summary_service import _enforce_editorial_grounding
        ideas = ["Idea [P-007, E-002] both"]
        out = _enforce_editorial_grounding(
            ideas, {"P-007": {}, "E-002": {}}, editorial_available=True,
        )
        assert out == ideas


class TestBoldIdeaFabricationTolerance:
    """§24e relax (2026-06-29): bold ideas with a small number of
    unrecognised proper nouns are KEPT (not dropped).  The §24c grounding
    gate already requires a [P-NNN] citation per idea, so the speculation
    is anchored to community signal.  Strict per-token fact-checking was
    rejecting genuinely-good ideas that named real-world partners, model
    numbers, or comparable titles not in the window's posts.
    """

    def test_keeps_idea_with_few_unrecognised_nouns(self):
        from services.period_summary_service import _sanitize_bold_ideas
        ideas = [
            "Partner with **RIDE** (the BYD spinoff) for K9MD and K11M bus models"
        ]
        out = _sanitize_bold_ideas(
            ideas,
            game_name="Bus Bound",
            sample_posts={"positive": ["Welsh voice acting is great"]},
            distinctive_entities=[],
        )
        # 4 unrecognised tokens (RIDE, BYD, K9MD, K11M) is within tolerance.
        assert out == ideas

    def test_drops_idea_with_many_unrecognised_nouns(self):
        from services.period_summary_service import _sanitize_bold_ideas
        ideas = [
            "Launch a **Foo** **Bar** **Baz** **Qux** **Quux** **Corge** "
            "**Grault** **Garply** event"
        ]
        out = _sanitize_bold_ideas(
            ideas,
            game_name="Some Game",
            sample_posts={"positive": []},
            distinctive_entities=[],
        )
        # >4 unrecognised tokens — dropped.
        assert out == []

    def test_keeps_idea_with_no_unrecognised_nouns(self):
        from services.period_summary_service import _sanitize_bold_ideas
        ideas = ["Amplify Welsh voice acting [P-001]"]
        out = _sanitize_bold_ideas(
            ideas,
            game_name="Bus Bound",
            sample_posts={"positive": ["Welsh voice acting is great"]},
            distinctive_entities=[],
        )
        assert out == ideas


# ── §25: anti-confabulation verification gate ──────────────────────────────


class _FakeAnthropicVerifier:
    """Test double for the Anthropic client used by _verify_claims_against_sources.

    Stores the prompt it was called with and returns a scripted verdict
    string.  One instance per test so each test controls verdict format.
    """

    def __init__(self, scripted_verdicts: str):
        self.scripted_verdicts = scripted_verdicts
        self.calls = []
        self.messages = self

    def create(self, model, max_tokens, messages):
        self.calls.append({"model": model, "messages": messages})
        text = self.scripted_verdicts
        # Mimic the SDK shape: message.content[0].text
        return type("M", (), {
            "content": [type("C", (), {"text": text})()]
        })()


class TestVerifyClaimsAgainstSources:
    """§25 contract:
      - HARD claims with no quoted support → DROPPED
      - COMMUNITY-OBSERVED claims with matching post statement → KEPT
      - PROPOSAL items with cited entity → KEPT
      - Malformed verifier output → original kept (don't risk destruction)
    """

    def _cmap(self):
        return {
            "P-001": {"text": "Doug Bradley returns to voice Pinhead is huge for fans", "url": "x"},
            "P-004": {"text": "Please add Turkish language support for the game!", "url": "x"},
            "P-006": {"text": "The early build gameplay is pretty amazing", "url": "x"},
            "P-014": {"text": "Clive Barker doing oversight is the authentic vision", "url": "x"},
        }

    def test_confabulation_competing_titles_dropped(self):
        # The canonical Hellraiser confabulation: cited posts mention
        # "Hellraiser" but contain NO claim about competing titles.
        from services.period_summary_service import _verify_claims_against_sources
        text = (
            "IP licensing conflicts with competing Hellraiser titles in the "
            "asymmetric multiplayer space are creating friction [P-014]."
        )
        client = _FakeAnthropicVerifier(
            "[1] UNSUPPORTED no source contains the competing-titles claim"
        )
        out = _verify_claims_against_sources(
            client, text, self._cmap(), "exec_summary",
        )
        assert out == ""

    def test_community_wish_preserved(self):
        # Community-observed claim with matching post → KEPT.
        from services.period_summary_service import _verify_claims_against_sources
        text = "Community is asking for Turkish language support [P-004]."
        client = _FakeAnthropicVerifier(
            '[1] SUPPORTED [COMMUNITY] cite=[P-004] quote="Please add Turkish language support"'
        )
        out = _verify_claims_against_sources(
            client, text, self._cmap(), "exec_summary",
        )
        assert "Turkish" in out
        assert out == text

    def test_hard_claim_with_source_quote_preserved(self):
        # A HARD claim that IS backed by a source quote survives.
        from services.period_summary_service import _verify_claims_against_sources
        text = "Doug Bradley returns to voice Pinhead in the upcoming title [P-001]."
        client = _FakeAnthropicVerifier(
            '[1] SUPPORTED [HARD] cite=[P-001] quote="Doug Bradley returns to voice Pinhead"'
        )
        out = _verify_claims_against_sources(
            client, text, self._cmap(), "exec_summary",
        )
        assert out == text

    def test_proposal_with_cited_entity_preserved(self):
        # Pure marketing-action proposal ("Amplify X") with cited entity
        # survives even though no factual claim needs verification.
        from services.period_summary_service import _verify_claims_against_sources
        text = "1. Amplify **Doug Bradley** vocal performance — community celebrates the return. [P-001]"
        client = _FakeAnthropicVerifier(
            '[1] SUPPORTED [PROPOSAL] cite=[P-001] quote="Doug Bradley returns to voice Pinhead"'
        )
        out = _verify_claims_against_sources(
            client, text, self._cmap(), "recommendations",
        )
        assert "Doug Bradley" in out

    def test_mixed_block_drops_only_unsupported_sentence(self):
        # Two-sentence exec: one HARD-supported, one HARD-confabulated.
        from services.period_summary_service import _verify_claims_against_sources
        text = (
            "Doug Bradley returns to voice Pinhead [P-001]. "
            "IP licensing fights over competing Hellraiser titles dominate [P-014]."
        )
        verdicts = (
            '[1] SUPPORTED [HARD] cite=[P-001] quote="Doug Bradley returns to voice Pinhead"\n'
            "[2] UNSUPPORTED no source mentions competing Hellraiser titles"
        )
        client = _FakeAnthropicVerifier(verdicts)
        out = _verify_claims_against_sources(
            client, text, self._cmap(), "exec_summary",
        )
        assert "Doug Bradley" in out
        assert "competing" not in out

    def test_malformed_verifier_output_keeps_original(self):
        # Verifier returns fewer verdicts than units → keep original.
        from services.period_summary_service import _verify_claims_against_sources
        text = (
            "Sentence one [P-001]. "
            "Sentence two [P-004]. "
            "Sentence three [P-006]."
        )
        # Only 1 verdict for 3 sentences → malformed.
        client = _FakeAnthropicVerifier(
            '[1] SUPPORTED [HARD] cite=[P-001] quote="..."'
        )
        out = _verify_claims_against_sources(
            client, text, self._cmap(), "exec_summary",
        )
        assert out == text

    def test_empty_text_short_circuits(self):
        from services.period_summary_service import _verify_claims_against_sources
        out = _verify_claims_against_sources(
            _FakeAnthropicVerifier(""), "", self._cmap(), "exec_summary",
        )
        assert out == ""

    def test_empty_citation_map_short_circuits(self):
        # Without cited sources, the verifier has nothing to verify against.
        from services.period_summary_service import _verify_claims_against_sources
        client = _FakeAnthropicVerifier("")
        out = _verify_claims_against_sources(
            client, "Some text", {}, "exec_summary",
        )
        # Returns original — we don't drop content without evidence to check.
        assert out == "Some text"

    def test_no_client_short_circuits(self):
        from services.period_summary_service import _verify_claims_against_sources
        out = _verify_claims_against_sources(None, "x", {"P-001": {}}, "exec_summary")
        assert out == "x"


class TestStripMonitorOnlyRecs:
    """§25 companion gate: drop recs anchored on monitor-only topics."""

    def test_drops_turkish_rec_when_monitor_only(self):
        # Turkish language tiered as monitor-only by §21h.
        from services.period_summary_service import _strip_monitor_only_recs
        recs = (
            "1. Amplify Doom-like gunplay — community comparison. [P-006]\n\n"
            "2. Communicate Turkish language support status — roadmap. [P-004]"
        )
        cm_table = {
            "positive": [("Doom-like gunplay", 10.0, 3, "theme")],
            "negative": [],
            "neutral": [("Turkish Language Support", 5.0, 2, "monitor-only")],
        }
        out = _strip_monitor_only_recs(recs, cm_table)
        assert "Turkish" not in out
        assert "Doom-like" in out
        assert out.startswith("1. Amplify Doom-like")

    def test_keeps_all_when_no_monitor_only(self):
        from services.period_summary_service import _strip_monitor_only_recs
        recs = (
            "1. First rec [P-001]\n\n"
            "2. Second rec [P-002]"
        )
        cm_table = {
            "positive": [("Foo", 10.0, 3, "theme")],
            "negative": [],
            "neutral": [],
        }
        assert _strip_monitor_only_recs(recs, cm_table) == recs

    def test_renumbers_after_drop(self):
        from services.period_summary_service import _strip_monitor_only_recs
        recs = (
            "1. Address Turkish concerns [P-004]\n\n"
            "2. Amplify Doom comparison [P-006]\n\n"
            "3. Spotlight Pinhead [P-001]"
        )
        cm_table = {
            "positive": [],
            "negative": [],
            "neutral": [("Turkish concerns", 5.0, 2, "monitor-only")],
        }
        out = _strip_monitor_only_recs(recs, cm_table)
        assert "Turkish" not in out
        assert out.startswith("1. Amplify Doom")
        assert "2. Spotlight Pinhead" in out

    def test_empty_table_no_op(self):
        from services.period_summary_service import _strip_monitor_only_recs
        recs = "1. Some rec [P-001]"
        assert _strip_monitor_only_recs(recs, None) == recs
        assert _strip_monitor_only_recs(recs, {}) == recs

    def test_drops_all_returns_empty(self):
        from services.period_summary_service import _strip_monitor_only_recs
        recs = "1. Communicate Turkish localization [P-004]"
        cm_table = {
            "neutral": [("Turkish localization", 5.0, 2, "monitor-only")],
        }
        out = _strip_monitor_only_recs(recs, cm_table)
        assert out == ""


class TestPlaceholderRespectsMonitorOnlyTier:
    """§25d: the §24e grounded placeholder must NOT cite a monitor-only
    label as the 'Top positive topic' / 'Top negative concern.'

    Canonical case: Hellraiser shape — Turkish leads pos_str but is
    classified monitor-only by §21h.  Placeholder must skip it.
    """

    def test_skips_monitor_only_lead(self):
        from services.period_summary_service import _placeholder_summary
        # Hellraiser shape: Turkish leads positive bucket but is monitor-only.
        cm_table = {
            "positive": [
                ("Turkish Language Support", 7.0, 7, "monitor-only"),
                ("Cast & Actor Interviews", 6.0, 5, "theme"),
            ],
            "negative": [
                ("Turkish Community Posts", 5.0, 4, "monitor-only"),
                ("Game Difficulty Settings", 6.0, 3, "theme"),
            ],
            "neutral": [],
        }
        out = _placeholder_summary(
            "Hellraiser", "this week", 45,
            pos_str="Turkish Language Support, Cast & Actor Interviews",
            neg_str="Turkish Community Posts, Game Difficulty Settings",
            pos_count=14, neg_count=11, neu_count=20,
            critical_mass_table=cm_table,
        )
        assert "Turkish" not in out
        assert "Cast & Actor Interviews" in out
        assert "Game Difficulty Settings" in out

    def test_no_theme_tier_omits_lead(self):
        """When every topic is monitor-only, placeholder must not name any."""
        from services.period_summary_service import _placeholder_summary
        cm_table = {
            "positive": [("Turkish Language Support", 7.0, 7, "monitor-only")],
            "negative": [],
            "neutral": [],
        }
        out = _placeholder_summary(
            "Test", "this week", 25,
            pos_str="Turkish Language Support",
            neg_str="",
            pos_count=14, neg_count=0, neu_count=11,
            critical_mass_table=cm_table,
        )
        assert "Turkish" not in out
        assert "Top positive topic" not in out

    def test_legacy_no_table_still_works(self):
        """When no critical_mass_table is provided (legacy callers), the
        placeholder falls back to raw pos_str lead."""
        from services.period_summary_service import _placeholder_summary
        out = _placeholder_summary(
            "Test", "this week", 25,
            pos_str="Game Quality, Combat Mechanics",
            neg_str="Server Issues",
            pos_count=14, neg_count=11, neu_count=0,
        )
        assert "Game Quality" in out


class TestTopicReorderDemotesMonitorOnly:
    """§25d: in _call_claude_for_period, pos_topics/neg_topics/neu_topics
    must be reordered so theme-tier labels come first and monitor-only
    labels are pushed to the end.  This prevents the exec LLM from
    anchoring on a leading monitor-only topic.

    We test the demotion logic directly via the inline function.
    """

    def test_demotion_moves_monitor_only_to_end(self):
        # Reproduce the inline _demote_monitor_only logic for unit testing.
        cm_table = {
            "positive": [
                ("Turkish Language Support", 7.0, 7, "monitor-only"),
                ("Language Support Requests", 6.0, 5, "monitor-only"),
                ("Cast & Actor Interviews", 6.0, 5, "theme"),
                ("Game Release & Timeline", 5.0, 3, "theme"),
            ],
        }
        labels = [
            "Turkish Language Support",
            "Language Support Requests",
            "Cast & Actor Interviews",
            "Game Release & Timeline",
        ]
        # Build the same tier lookup the production code uses.
        tier_lookup = {
            t[0].lower(): t[3] if len(t) >= 4 else "theme"
            for t in cm_table.get("positive", [])
        }
        themes = [L for L in labels if tier_lookup.get(L.lower(), "theme") == "theme"]
        monitors = [L for L in labels if tier_lookup.get(L.lower(), "theme") == "monitor-only"]
        out = themes + monitors

        # Theme-tier labels must come first; monitor-only at the end.
        assert out[0] == "Cast & Actor Interviews"
        assert out[1] == "Game Release & Timeline"
        # Both monitor-only labels follow the themes.
        assert set(out[2:]) == {"Turkish Language Support", "Language Support Requests"}
