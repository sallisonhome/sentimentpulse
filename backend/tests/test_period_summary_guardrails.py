"""
Tests that period-summary LLM prompts enforce the evidence-only output style
(CLAUDE.md \u00a713) without leaking the rules into the visible output.

Two layers of defense:

  1. Prompts include the _OUTPUT_STYLE preamble which tells Claude to follow
     constraints silently and never reference rules, reasoning, or limitations.
  2. Post-LLM parsers (_parse_bold_ideas, _parse_recommended_actions) strip
     any output that leaked meta-explanation or markdown headings, returning
     None / [] when nothing actionable remains.

These tests are pure unit tests \u2014 no Claude API calls, no network.
"""
import pytest

from services import period_summary_service as pss


# \u2500\u2500 Fake Claude client \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class _FakeMessage:
    def __init__(self, text: str):
        self.content = [type("C", (), {"text": text})()]


class _CapturingClient:
    """Records every prompt sent to .messages.create()."""

    def __init__(self, response: str):
        self.prompts: list[str] = []
        self._response = response

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        self.prompts.append(kwargs["messages"][0]["content"])
        return _FakeMessage(self._response)


# \u2500\u2500 Output style preamble \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestOutputStylePreamble:
    def test_preamble_exists(self):
        assert hasattr(pss, "_OUTPUT_STYLE")
        assert isinstance(pss._OUTPUT_STYLE, str)
        assert len(pss._OUTPUT_STYLE) > 0

    def test_preamble_forbids_meta_leak_phrases(self):
        g = pss._OUTPUT_STYLE.lower()
        # The exact phrases that broke the John Wick UX must be explicitly forbidden
        for phrase in [
            "i cannot",
            "the rules say",
            "i'm instructed",
            "insufficient data to provide",
            "based on the constraints",
        ]:
            assert phrase in g, f"preamble doesn't forbid {phrase!r}"

    def test_preamble_forbids_monetization_extrapolation(self):
        g = pss._OUTPUT_STYLE.lower()
        # Must mention business-model / monetization off-limits
        assert "monetization" in g
        assert "business model" in g
        assert "pricing" in g

    def test_preamble_tells_model_to_be_silent_about_rules(self):
        g = pss._OUTPUT_STYLE.lower()
        assert "follow silently" in g or "never mention these rules" in g


# \u2500\u2500 Topic quarantine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestQuarantineTopics:
    @pytest.mark.parametrize(
        "poisoned",
        [
            "Free to Play Model",
            "Free-to-Play John Wick",
            "F2P Competitive Positioning",
            "Battle Pass Reception",
            "BattlePass Success",
            "Monetization Strategy",
            "Microtransactions Concern",
            "Live Service Approach",
            "Season Pass Buzz",
            "Pay-to-Win Concerns",
            "P2W Debate",
            "Loot Box Outrage",
            "Subscription Pricing",
            "Gacha Mechanics",
        ],
    )
    def test_drops_poisoned_label(self, poisoned):
        result = pss._quarantine_topics([poisoned, "Combat Mechanics"])
        assert poisoned not in result
        assert "Combat Mechanics" in result

    @pytest.mark.parametrize(
        "clean_label",
        [
            "Combat Mechanics",
            "Story & Narrative",
            "Performance & FPS Issues",
            "Multiplayer Connectivity Bugs",
            "General Positive Sentiment",
            "Trailers & Announcements",
        ],
    )
    def test_keeps_clean_label(self, clean_label):
        result = pss._quarantine_topics([clean_label])
        assert clean_label in result

    def test_empty_input_returns_empty(self):
        assert pss._quarantine_topics([]) == []
        assert pss._quarantine_topics(None) == []

    def test_drops_blank_and_non_string(self):
        result = pss._quarantine_topics(["", "  ", None, "Valid Topic"])
        assert result == ["Valid Topic"]

    def test_preserves_order(self):
        result = pss._quarantine_topics([
            "Topic A", "Free to Play Model", "Topic B", "F2P", "Topic C",
        ])
        assert result == ["Topic A", "Topic B", "Topic C"]


# \u2500\u2500 Prompt regression guards \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestCallExecPrompt:
    def test_exec_prompt_includes_output_style(self):
        client = _CapturingClient(response="A short executive summary that is long enough to pass any minimum length check we might add.")
        pss._call_exec(client, "Test Game", "April 2026",
                       "Combat", "Story", "Trailers", 100)
        assert len(client.prompts) == 1
        prompt = client.prompts[0]
        assert "OUTPUT STYLE" in prompt
        assert "i cannot" in prompt.lower()
        assert "Test Game" in prompt
        assert "April 2026" in prompt


class TestCallActionsPrompt:
    def test_actions_prompt_includes_output_style(self):
        client = _CapturingClient(response="1. Action one is concrete and references a real topic.\n2. Action two also references a topic.\n3. Third action.")
        pss._call_actions(client, "Test Game", "April 2026",
                          "Combat", "Story", "Trailers")
        assert "OUTPUT STYLE" in client.prompts[0]

    def test_actions_prompt_offers_none_escape(self):
        client = _CapturingClient(response="NONE")
        pss._call_actions(client, "Test Game", "April 2026",
                          "General positive sentiment",
                          "No clear negative signals",
                          "General neutral discussion")
        prompt = client.prompts[0]
        # The new NONE sentinel must be the documented escape valve
        assert "NONE" in prompt
        # NONE sentinel must be documented as the escape valve with NO meta-message
        assert "nothing else, no explanation" in prompt.lower()

    def test_actions_returns_none_when_claude_says_none(self):
        client = _CapturingClient(response="NONE")
        result = pss._call_actions(client, "Test Game", "April 2026",
                                    "Combat", "Story", "Trailers")
        assert result is None

    def test_actions_strips_meta_leak_lines(self):
        # The exact bug from the user's screenshot
        bad_response = (
            "**Reason:** The positive topics are either too generic.\n"
            "I cannot provide actionable recommendations based on this data.\n"
            "Some real action that mentions Combat Mechanics specifically and is long enough.\n"
            "**What would help:** Community feedback tied to specific features.\n"
            "Another real recommendation that references Story Mode and has substance."
        )
        client = _CapturingClient(response=bad_response)
        result = pss._call_actions(client, "Test Game", "April 2026",
                                    "Combat", "Story", "Trailers")
        # Output should retain the real recommendations and drop the meta-leak
        assert result is not None
        assert "I cannot" not in result
        assert "Reason:" not in result
        assert "What would help:" not in result
        assert "Combat Mechanics" in result or "Story Mode" in result


class TestCallBoldIdeasPrompt:
    def test_bold_ideas_prompt_includes_output_style(self):
        client = _CapturingClient(response="NONE")
        pss._call_bold_ideas(client, "Test Game", "April 2026",
                             "Combat", "Story", "Trailers", 100)
        assert "OUTPUT STYLE" in client.prompts[0]

    def test_bold_ideas_prompt_forbids_markdown_headings(self):
        client = _CapturingClient(response="NONE")
        pss._call_bold_ideas(client, "Test Game", "April 2026",
                             "Combat", "Story", "Trailers", 100)
        p = client.prompts[0]
        # The new prompt must explicitly forbid the markdown-heading output we saw
        assert "No markdown headings" in p
        assert "# Analysis" in p

    def test_bold_ideas_preserves_none_escape(self):
        client = _CapturingClient(response="NONE")
        result = pss._call_bold_ideas(client, "Test Game", "April 2026",
                                       "Combat", "Story", "Trailers", 100)
        assert result == []
