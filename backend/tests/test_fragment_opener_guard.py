"""Tests for §21c/§22 fragment-opener detector and placeholder fallback.

Regression: 2026-06-29 user opened the digest and the Space Marine 2 exec
read '109 negative), players consistently praise the tactile, visceral
Space Marine fantasy...'.  Root cause: the uncited-sentence stripper
chopped the lead clause (which had no citation), exposing the rest of
that sentence as the new lead.  These tests guard against shipping a
mid-sentence fragment lead.
"""

from services.period_summary_service import (
    _looks_like_fragment_lead,
    _placeholder_summary,
    _MIN_SUBSTANTIVE_POSTS,
)


class TestFragmentOpenerDetection:

    def test_clean_sentence_is_not_fragment(self):
        text = "Community sentiment was strongly positive this week."
        assert _looks_like_fragment_lead(text) is False

    def test_capitalized_proper_noun_is_not_fragment(self):
        text = "Space Marine 2 saw strong positive sentiment."
        assert _looks_like_fragment_lead(text) is False

    def test_quoted_capitalized_opener_is_not_fragment(self):
        text = '"Players love the new chapter pack," with strong sentiment.'
        assert _looks_like_fragment_lead(text) is False

    def test_digit_close_paren_lead_is_fragment(self):
        # The SM2 regression — sanitizer chopped front, exposed "109 negative),"
        text = "109 negative), players consistently praise the tactile fantasy."
        assert _looks_like_fragment_lead(text) is True

    def test_lowercase_lead_is_fragment(self):
        # Mid-sentence continuation
        text = "players consistently praise the tactile fantasy of Space Marine 2."
        assert _looks_like_fragment_lead(text) is True

    def test_close_paren_lead_is_fragment(self):
        text = "), players consistently praise the tactile fantasy."
        assert _looks_like_fragment_lead(text) is True

    def test_comma_lead_is_fragment(self):
        text = ", players consistently praise the tactile fantasy."
        assert _looks_like_fragment_lead(text) is True

    def test_and_lead_is_fragment(self):
        text = "and players celebrate co-op campaign moments."
        assert _looks_like_fragment_lead(text) is True

    def test_because_lead_is_fragment(self):
        text = "because of strong community comparisons, demand is rising."
        assert _looks_like_fragment_lead(text) is True

    def test_empty_text_is_not_fragment(self):
        assert _looks_like_fragment_lead("") is False
        assert _looks_like_fragment_lead("   ") is False


class TestPlaceholderSummary:

    def test_low_signal_message_when_below_threshold(self):
        result = _placeholder_summary("Foo Game", "Jun 23 - 29, 2026", 10)
        assert "Insufficient signal" in result
        assert "10 substantive posts" in result

    def test_mixed_signal_message_when_above_threshold(self):
        # 45 posts is above _MIN_SUBSTANTIVE_POSTS (20).  Result should
        # be the mixed-signal analyst observation, not the low-signal one.
        result = _placeholder_summary("Foo Game", "Jun 23 - 29, 2026", 45)
        assert "Insufficient signal" not in result
        assert "mixed" in result.lower()
        assert "45 posts" in result

    def test_placeholder_never_says_ai_unavailable(self):
        # Previous fallback wording was a config-error message that appeared
        # in production digests when sanitizers (not the API) failed.  The
        # new wording must read as a real analyst observation.
        for n in (5, 20, 100, 1000):
            result = _placeholder_summary("Foo", "Jun 2026", n)
            assert "ANTHROPIC_API_KEY" not in result
            assert "AI summary unavailable" not in result

    def test_low_signal_threshold_uses_module_constant(self):
        # Confirm the threshold the function uses matches the module constant.
        result_at = _placeholder_summary("Foo", "Jun 2026", _MIN_SUBSTANTIVE_POSTS)
        result_below = _placeholder_summary("Foo", "Jun 2026", _MIN_SUBSTANTIVE_POSTS - 1)
        assert "Insufficient signal" not in result_at
        assert "Insufficient signal" in result_below
