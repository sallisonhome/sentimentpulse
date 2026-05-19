"""
Tests for the topic-humanization evidence-only guardrails (CLAUDE.md \u00a713).

Two layers of defense:

  1. The prompt sent to Claude includes explicit "no inventing" rules and negative
     examples calling out the F2P / battle-pass / monetization hallucination pattern.
  2. A post-LLM filter rejects any humanized label that contains a forbidden
     concept token NOT present in the source cluster, falling back to the raw
     label and logging a warning.

These tests are pure unit tests \u2014 no Claude API calls, no network.
"""
import pytest

from services.topic_service import (
    _FORBIDDEN_CONCEPT_TOKENS,
    _call_claude_humanize_batch,
    _label_violates_evidence_rule,
    _normalize_for_check,
)


# \u2500\u2500 Post-LLM filter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestLabelViolatesEvidenceRule:
    """The defensive filter that catches whatever the prompt misses."""

    @pytest.mark.parametrize(
        "raw, humanized",
        [
            # The exact John Wick bug
            ("free + play + game",         "Free to Play Model"),
            ("john + wick + game",         "Free-to-Play John Wick"),
            ("like + good + game",         "Battle Pass Success"),
            ("competitor + alternative",   "F2P Competitive Positioning"),
            ("good + great + fun",         "Monetization Strategy"),
            ("price + worth",              "Microtransactions Concern"),  # close to a real one, but not in cluster
            ("trailer + announce",         "Live Service Approach"),
            ("story + ending",             "Season Pass Reception"),
            ("crash + bug",                "Pay-to-Win Concerns"),
            ("multiplayer + lag",          "Loot Box Outrage"),
            ("price + value",              "Subscription Model"),     # "subscription" not in cluster
            ("update + patch",             "DLC Roadmap"),            # DLC not in cluster
        ],
    )
    def test_rejects_invented_concept(self, raw, humanized):
        assert _label_violates_evidence_rule(humanized, raw) is True

    @pytest.mark.parametrize(
        "raw, humanized",
        [
            # Genuine groundings: the forbidden token IS in the raw cluster
            ("free + play + microtransaction",  "Microtransactions Concern"),
            ("battle + pass + reward",          "Battle Pass Rewards"),
            ("dlc + season + content",          "DLC & Season Content"),
            ("monetization + price + worth",    "Monetization Friction"),
            ("subscription + monthly + cost",   "Subscription Pricing"),
            # No forbidden tokens at all
            ("crash + fps + performance",       "Performance & FPS Issues"),
            ("story + narrative + ending",      "Story & Narrative"),
            ("love + game + play",              "General Positive Sentiment"),
            ("trailer + announce + reveal",     "Trailers & Announcements"),
            ("good + great + fun",              "General Positive Sentiment"),
            ("think + want + would",            "General Discussion"),
        ],
    )
    def test_accepts_grounded_label(self, raw, humanized):
        assert _label_violates_evidence_rule(humanized, raw) is False

    def test_case_insensitive(self):
        # Forbidden detection should not depend on case
        assert _label_violates_evidence_rule("BATTLE PASS SUCCESS", "good + game") is True
        assert _label_violates_evidence_rule("battle pass success", "good + game") is True
        assert _label_violates_evidence_rule("Battle Pass Success", "good + game") is True

    def test_punctuation_insensitive(self):
        # "free-to-play" and "free to play" both forbidden; punctuation in raw cluster shouldn't matter
        assert _label_violates_evidence_rule("Free-to-Play Model", "good + game") is True
        assert _label_violates_evidence_rule("Free To Play", "good + game") is True
        # Punctuation in cluster doesn't hide grounding
        assert _label_violates_evidence_rule("Free-to-Play Model", "free + play + game") is False or True
        # ^ note: "free to play" as 3 contiguous tokens isn't present in "free + play + game"
        # The normalize collapses + to space, giving "free play game" which does NOT contain "free to play".
        # So this SHOULD be rejected. Asserting actual behavior:
        assert _label_violates_evidence_rule("Free-to-Play Model", "free + play + game") is True

    def test_normalize_handles_punctuation(self):
        assert _normalize_for_check("Free-to-Play!") == "free to play"
        assert _normalize_for_check("F2P/F2P/F2P") == "f2p f2p f2p"
        assert _normalize_for_check("   Pay to Win   ") == "pay to win"


# \u2500\u2500 Prompt content (regression guard) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class _FakeMessage:
    def __init__(self, text: str):
        self.content = [type("C", (), {"text": text})()]


class _FakeClient:
    """Captures the prompt sent to Claude so we can assert on it."""

    def __init__(self, response: str = "{}"):
        self.captured_prompt: str | None = None
        self._response = response

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        # Latest message's content is the prompt
        self.captured_prompt = kwargs["messages"][0]["content"]
        return _FakeMessage(self._response)


class TestHumanizePromptContent:
    """Regression guards: future edits to the prompt must keep these protections."""

    def _captured(self) -> str:
        client = _FakeClient(response='{"crash + fps + bug": "Performance & Bugs"}')
        _call_claude_humanize_batch(client, "Test Game", ["crash + fps + bug"])
        assert client.captured_prompt is not None
        return client.captured_prompt

    def test_prompt_contains_no_inventing_rule(self):
        p = self._captured()
        assert "NO INVENTING" in p
        assert "NO SPECULATING" in p

    def test_prompt_calls_out_forbidden_tokens(self):
        p = self._captured().lower()
        # Each protected concept must appear at least once in the prompt
        for required in [
            "free-to-play", "f2p", "battle pass", "monetization",
            "microtransactions", "gacha", "live service",
            "season pass", "pay-to-win", "loot box", "subscription", "dlc",
        ]:
            assert required in p, f"prompt missing forbidden-concept warning for {required!r}"

    def test_prompt_includes_negative_examples(self):
        p = self._captured()
        # The specific bug we're fixing: free+play+game should NOT become "Free to Play Model"
        assert "free + play + game" in p
        assert "Free to Play Model" in p
        # And the prompt should mark it as BAD
        assert "BAD" in p

    def test_prompt_offers_generic_fallback_labels(self):
        p = self._captured()
        # Claude should know it has an out for vague clusters
        assert "General Discussion" in p


# \u2500\u2500 _FORBIDDEN_CONCEPT_TOKENS coverage \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500


class TestForbiddenTokensCoverage:
    def test_all_tokens_are_lowercase_substrings(self):
        for tok in _FORBIDDEN_CONCEPT_TOKENS:
            assert tok == tok.lower()
            assert tok.strip() == tok
            assert tok  # not empty

    def test_key_business_model_concepts_present(self):
        toks_joined = " ".join(_FORBIDDEN_CONCEPT_TOKENS)
        for concept in ["free", "f2p", "battle pass", "monetiz", "gacha",
                        "live service", "pay", "loot", "subscription", "dlc"]:
            assert concept in toks_joined, f"forbidden tokens missing coverage for {concept!r}"
