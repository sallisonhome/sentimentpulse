"""
Tests that the period-summary LLM prompts include the evidence-only guardrail
(CLAUDE.md \u00a713) and the forbidden-concept callout.

These tests capture what is actually sent to Claude. No network calls.
"""
import pytest

from services import period_summary_service as pss


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


# \u2500\u2500 Shared preamble \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestEvidenceGuardrailPreamble:
    def test_preamble_constant_exists_and_is_explicit(self):
        g = pss._EVIDENCE_GUARDRAIL
        assert "NO INVENTING" in g
        assert "NO SPECULATING" in g
        # The specific gaming-business-model concepts must be named
        for tok in ["free-to-play", "F2P", "battle pass", "monetization",
                    "microtransactions", "gacha", "live service", "season pass"]:
            assert tok in g, f"preamble missing {tok!r}"
        # The honesty-about-uncertainty escape valve must be present
        assert "insufficient signal" in g.lower()


# \u2500\u2500 _call_exec \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestCallExecPrompt:
    def test_exec_prompt_includes_evidence_guardrail(self):
        client = _CapturingClient(response="A short executive summary.")
        pss._call_exec(client, "Test Game", "April 2026",
                       "Combat", "Story", "Trailers", 100)
        assert len(client.prompts) == 1
        prompt = client.prompts[0]
        assert "NO INVENTING" in prompt
        assert "free-to-play" in prompt
        assert "Test Game" in prompt
        assert "April 2026" in prompt

    def test_exec_prompt_forbids_extrapolating_to_business_model(self):
        client = _CapturingClient(response="ok")
        pss._call_exec(client, "Test Game", "April 2026",
                       "Combat", "Story", "Trailers", 100)
        prompt = client.prompts[0].lower()
        # Must explicitly call out the no-extrapolating-to-business-model rule
        assert "business model" in prompt or "monetization" in prompt
        assert "pricing" in prompt


# \u2500\u2500 _call_actions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestCallActionsPrompt:
    def test_actions_prompt_includes_evidence_guardrail(self):
        client = _CapturingClient(response="1. Do something\n2. Do something else")
        pss._call_actions(client, "Test Game", "April 2026",
                          "Combat", "Story", "Trailers")
        assert len(client.prompts) == 1
        assert "NO INVENTING" in client.prompts[0]

    def test_actions_prompt_offers_empty_output_when_no_signal(self):
        client = _CapturingClient(response="ok")
        pss._call_actions(client, "Test Game", "April 2026",
                          "none identified", "none identified", "none identified")
        prompt = client.prompts[0]
        # The actions prompt must provide an explicit "nothing to recommend" escape valve
        assert "NO ACTIONABLE RECOMMENDATIONS" in prompt

    def test_actions_prompt_forbids_business_model_recs(self):
        client = _CapturingClient(response="ok")
        pss._call_actions(client, "Test Game", "April 2026",
                          "Combat", "Story", "Trailers")
        p = client.prompts[0].lower()
        assert "business model" in p or "monetization" in p


# \u2500\u2500 _call_bold_ideas \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestCallBoldIdeasPrompt:
    def test_bold_ideas_prompt_includes_evidence_guardrail(self):
        client = _CapturingClient(response="NONE")
        pss._call_bold_ideas(client, "Test Game", "April 2026",
                             "Combat", "Story", "Trailers", 100)
        assert len(client.prompts) == 1
        assert "NO INVENTING" in client.prompts[0]

    def test_bold_ideas_must_be_anchored_in_topic_label(self):
        client = _CapturingClient(response="NONE")
        pss._call_bold_ideas(client, "Test Game", "April 2026",
                             "Combat", "Story", "Trailers", 100)
        p = client.prompts[0]
        # Bold ideas must explicitly name a topic label by name
        assert "specific topic label" in p.lower() or "topic label by name" in p.lower()

    def test_bold_ideas_preserves_none_escape(self):
        client = _CapturingClient(response="NONE")
        result = pss._call_bold_ideas(client, "Test Game", "April 2026",
                                       "Combat", "Story", "Trailers", 100)
        # The NONE response must still parse to an empty list
        assert result == []
