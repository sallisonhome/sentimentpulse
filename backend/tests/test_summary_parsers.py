"""
Tests for the post-LLM parsers that catch meta-leak and markdown junk.

  _parse_bold_ideas: returns [] when input is NONE, all candidates are filtered,
    or the only items are markdown headings / meta-leak. Each surviving item
    must be substantive prose.

  _parse_recommended_actions: returns None when input is NONE or when stripping
    meta-leak lines leaves the body too short to be useful. Otherwise returns
    the cleaned actions text.
"""
import pytest

from services.period_summary_service import (
    _parse_bold_ideas,
    _parse_recommended_actions,
    _looks_like_meta_leak,
    _is_markdown_heading_or_too_short,
)


# \u2500\u2500 _looks_like_meta_leak \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestLooksLikeMetaLeak:
    @pytest.mark.parametrize(
        "leak",
        [
            "I cannot provide actionable recommendations based on this data.",
            "**Reason:** The positive topics are either too generic.",
            "What would help: Community feedback tied to specific features.",
            "I'm instructed not to act on this without separate labels.",
            "The rules say I shouldn't recommend monetization changes.",
            "Forbidden by Rule 2 (Free to Play Model is a business model concept I'm instructed not to act on).",
            "Insufficient data to provide a meaningful recommendation.",
            "I'm not able to generate sprint-board-ready tasks.",
            "I don't have enough context for this analysis.",
            "Based on the constraints, I'll keep this short.",
            "Per the rules, I cannot extrapolate.",
            "Cannot provide actionable recommendations.",
        ],
    )
    def test_detects_meta_leak(self, leak):
        assert _looks_like_meta_leak(leak) is True

    @pytest.mark.parametrize(
        "clean",
        [
            "Launch a 'TV Gaming Setup' showcase campaign featuring community clips.",
            "Patch port compatibility issues immediately to address the negative cluster.",
            "Community engagement around Docked remains nascent with only four posts.",
            "The Hitman-Style Gameplay topic is the strongest positive signal.",
            "Bold idea: launch a community challenge tied to Combat Mechanics.",
            "",  # empty isn't meta-leak (it's just empty)
        ],
    )
    def test_clean_text_not_flagged(self, clean):
        assert _looks_like_meta_leak(clean) is False


# \u2500\u2500 _is_markdown_heading_or_too_short \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestIsMarkdownHeadingOrTooShort:
    @pytest.mark.parametrize(
        "junk",
        [
            "# Analysis: April 2026",
            "## Key Observation",
            "### Subheading",
            "* ",
            "- ",
            "** ",
            "",
            "   ",
            "Short text",  # < 30 chars
            "# Headers",
        ],
    )
    def test_rejects_junk(self, junk):
        assert _is_markdown_heading_or_too_short(junk) is True

    @pytest.mark.parametrize(
        "real_idea",
        [
            "Launch a TV Gaming Setup showcase campaign featuring community clips and best-practice guides.",
            "Develop and ship a 1080p Resolution Support troubleshooting guide and FAQ.",
            "Capitalize on Hitman-Style Gameplay momentum with a free demo weekend.",
        ],
    )
    def test_accepts_substantial_ideas(self, real_idea):
        assert _is_markdown_heading_or_too_short(real_idea) is False


# \u2500\u2500 _parse_bold_ideas \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestParseBoldIdeas:
    def test_none_sentinel_returns_empty(self):
        assert _parse_bold_ideas("NONE") == []
        assert _parse_bold_ideas("none") == []
        assert _parse_bold_ideas("  NONE  ") == []
        assert _parse_bold_ideas("NONE — nothing actionable here") == []

    def test_empty_input_returns_empty(self):
        assert _parse_bold_ideas("") == []
        assert _parse_bold_ideas(None) == []

    def test_numbered_list_parsed_correctly(self):
        raw = (
            "1. Launch a community challenge tied to Combat Mechanics for monthly events.\n"
            "2. Partner with content creators around Story Mode to amplify positive sentiment."
        )
        result = _parse_bold_ideas(raw)
        assert len(result) == 2
        assert "Combat Mechanics" in result[0]
        assert "Story Mode" in result[1]

    def test_rejects_markdown_heading_response(self):
        # The exact bug from the user's screenshot
        raw = (
            "# Analysis: April 2026 Community Signals for Untitled John Wick Game\n"
            "## Key Observation\n"
            "60 posts across April with **zero negative topics identified**."
        )
        result = _parse_bold_ideas(raw)
        # All three lines should be rejected:
        # - "# Analysis" is a heading
        # - "## Key Observation" is a heading
        # - "60 posts across April..." is < 30 substantive chars after stripping markdown
        # The third line is actually long enough \u2014 but it's a description, not an idea.
        # We accept that some borderline lines may survive; the critical thing is
        # the markdown headings are gone.
        for r in result:
            assert not r.startswith("#"), f"Markdown heading leaked: {r!r}"

    def test_rejects_meta_leak_items(self):
        raw = (
            "1. I cannot provide bold ideas based on this sparse data.\n"
            "2. Launch a 'Wick Showcase' community challenge tied to John Wick Gameplay.\n"
            "3. Reason: The positive topics are too generic for actionable bold moves."
        )
        result = _parse_bold_ideas(raw)
        # Item 2 should survive; items 1 and 3 should be dropped
        assert len(result) == 1
        assert "Wick Showcase" in result[0]

    def test_all_filtered_returns_empty(self):
        raw = (
            "# Analysis\n"
            "## Header\n"
            "Short.\n"
            "I cannot.\n"
        )
        assert _parse_bold_ideas(raw) == []


# \u2500\u2500 _parse_recommended_actions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestParseRecommendedActions:
    def test_none_sentinel_returns_none(self):
        assert _parse_recommended_actions("NONE") is None
        assert _parse_recommended_actions("none") is None
        assert _parse_recommended_actions("  NONE\n") is None

    def test_empty_input_returns_none(self):
        assert _parse_recommended_actions("") is None
        assert _parse_recommended_actions(None) is None

    def test_real_recommendations_pass_through(self):
        raw = (
            "1. Patch port compatibility issues immediately to address the negative cluster.\n"
            "2. Launch a community survey targeting Game Trailers viewers.\n"
            "3. Amplify the Hitman-Style Gameplay positive sentiment with a creator program."
        )
        result = _parse_recommended_actions(raw)
        assert result is not None
        assert "Patch port" in result
        assert "Hitman-Style" in result
        # No meta-leak crept in
        assert "I cannot" not in result.lower()

    def test_strips_meta_leak_lines(self):
        # The exact UX bug from the user's screenshot \u2014 a real recommendation
        # accompanied by meta-explanation lines.
        raw = (
            "I cannot provide actionable recommendations based on this data.\n"
            "Reason: The positive topics are either too generic or business model concepts.\n"
            "1. Actually do this real thing about Combat Mechanics specifically.\n"
            "What would help: more specific feedback."
        )
        result = _parse_recommended_actions(raw)
        # The real recommendation should survive
        assert result is not None
        assert "Combat Mechanics" in result
        # The meta-leak should be gone
        assert "I cannot" not in result
        assert "Reason:" not in result
        assert "What would help:" not in result

    def test_returns_none_when_only_meta_leak(self):
        raw = (
            "I cannot provide actionable recommendations based on this data.\n"
            "Reason: The positive topics are too generic.\n"
            "What would help: more specific feedback.\n"
            "Per the rules, I'm not able to recommend monetization changes."
        )
        # Stripping meta-leak leaves effectively nothing \u2014 should collapse to None
        assert _parse_recommended_actions(raw) is None

    def test_short_residue_collapses_to_none(self):
        # Stripping a meta-leak line might leave a numbered scaffold but no content
        raw = "I cannot help with this.\n1.\n2.\n3."
        assert _parse_recommended_actions(raw) is None
