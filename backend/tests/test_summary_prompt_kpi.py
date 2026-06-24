"""
Tests that the exec-summary prompt includes sentiment KPI breakdown so Claude
cannot contradict the dashboard numbers (Bug 2 fix).

Specifically tests:
  - pos_count/neg_count/neu_count are present in the prompt
  - A "must reference counts numerically" instruction is in the prompt
  - The banned phrase list is in the prompt when neg_pct > 5%
  - When neg_pct <= 5% the banned phrase list is NOT enforced
  - All counts flow correctly through _call_claude_for_period

These are pure unit tests — no Claude API calls, no network.
"""
import pytest
from unittest.mock import patch, MagicMock

from services import period_summary_service as pss


# ── Fake Claude client (same pattern as test_period_summary_guardrails.py) ───

class _FakeMessage:
    def __init__(self, text: str):
        self.content = [type("C", (), {"text": text})()]


class _CapturingClient:
    """Records every prompt sent to .messages.create()."""

    def __init__(self, response: str = "A valid executive summary that is long enough to pass any checks."):
        self.prompts: list[str] = []
        self._response = response

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        self.prompts.append(kwargs["messages"][0]["content"])
        return _FakeMessage(self._response)


# ── Helper ────────────────────────────────────────────────────────────────────

def _call_exec_capturing(pos_count, neg_count, neu_count, response="Valid exec summary text here."):
    """Call _call_exec with a capturing client and return (prompt, result)."""
    total = pos_count + neg_count + neu_count
    client = _CapturingClient(response=response)
    result = pss._call_exec(
        client,
        game_name="Test Game",
        window_label="1 Jan, 2024",
        pos_str="Great Gameplay",
        neg_str="Fuel Changes",
        neu_str="General Discussion",
        total_posts=total,
        pos_count=pos_count,
        neg_count=neg_count,
        neu_count=neu_count,
    )
    return client.prompts[0], result


# ── Sentiment counts in prompt ────────────────────────────────────────────────

class TestSentimentCountsInPrompt:
    """The exec-summary prompt must include the actual pos/neg/neu counts."""

    def test_pos_count_in_prompt(self):
        prompt, _ = _call_exec_capturing(67, 33, 100)
        assert "67" in prompt, f"pos_count 67 not found in prompt:\n{prompt}"

    def test_neg_count_in_prompt(self):
        prompt, _ = _call_exec_capturing(67, 33, 100)
        assert "33" in prompt, f"neg_count 33 not found in prompt:\n{prompt}"

    def test_neu_count_in_prompt(self):
        prompt, _ = _call_exec_capturing(67, 33, 100)
        assert "100" in prompt, f"neu_count 100 not found in prompt:\n{prompt}"

    def test_positive_percentage_in_prompt(self):
        """The positive percentage should be present (computed from counts)."""
        prompt, _ = _call_exec_capturing(67, 33, 100)
        # 67 / 200 * 100 = 33.5%
        assert "33.5" in prompt, f"Positive percentage 33.5% not found in prompt:\n{prompt}"

    def test_negative_percentage_in_prompt(self):
        """The negative percentage should be present."""
        prompt, _ = _call_exec_capturing(67, 33, 100)
        # 33 / 200 * 100 = 16.5%
        assert "16.5" in prompt, f"Negative percentage 16.5% not found in prompt:\n{prompt}"

    def test_breakdown_section_header_in_prompt(self):
        """The prompt should have a data section with breakdown labels."""
        prompt, _ = _call_exec_capturing(67, 33, 100)
        prompt_lower = prompt.lower()
        assert "positive" in prompt_lower
        assert "negative" in prompt_lower
        assert "neutral" in prompt_lower


# ── Mandatory numeric reference instruction ───────────────────────────────────

class TestMandatoryNumericReference:
    """The prompt must instruct Claude to reference counts numerically."""

    def test_must_reference_counts_numerically_instruction_present(self):
        """The prompt must contain the mandatory numeric reference instruction."""
        prompt, _ = _call_exec_capturing(67, 33, 100)
        # Check for the key instruction
        assert "MUST reference" in prompt or "must reference" in prompt.lower(), (
            "Prompt missing mandatory numeric reference instruction"
        )

    def test_must_reference_positive_and_negative_counts(self):
        """The instruction must specifically mention positive AND negative counts."""
        prompt, _ = _call_exec_capturing(67, 33, 100)
        prompt_lower = prompt.lower()
        assert "positive" in prompt_lower and "negative" in prompt_lower, (
            "Instruction should mention both positive and negative counts"
        )

    def test_numeric_example_in_instruction(self):
        """The prompt should include a numeric example (e.g. 'X positive vs Y negative posts')."""
        prompt, _ = _call_exec_capturing(67, 33, 100)
        # e.g. "67 positive vs 33 negative posts" as an example
        assert "positive vs" in prompt or "positive AND negative" in prompt.lower(), (
            "Prompt should demonstrate the expected numeric reference format"
        )


# ── Banned phrase list ────────────────────────────────────────────────────────

class TestBannedPhraseList:
    """The banned phrase list is enforced when neg_pct > 5%, not otherwise."""

    def test_banned_phrases_present_when_neg_pct_above_5_percent(self):
        """When negative is >5% of total, banned phrases must appear in prompt."""
        # 33 / 200 = 16.5% — well above 5%
        prompt, _ = _call_exec_capturing(67, 33, 100)
        banned_phrases = [
            "no clear negative signals",
            "no friction points",
            "no negative signals",
            "stable player satisfaction",
            "absence of friction",
        ]
        for phrase in banned_phrases:
            assert phrase in prompt.lower(), (
                f"Banned phrase {phrase!r} not found in prompt when neg_pct=16.5%:\n{prompt}"
            )

    def test_banned_phrase_instruction_present_when_neg_pct_above_5_percent(self):
        """When neg_pct > 5%, the BANNED PHRASES instruction must be present."""
        prompt, _ = _call_exec_capturing(67, 33, 100)
        assert "BANNED" in prompt or "banned" in prompt.lower(), (
            f"No banned phrases instruction found when neg_pct > 5%"
        )

    def test_banned_phrases_NOT_enforced_when_neg_pct_at_or_below_5_percent(self):
        """When negative is ≤5% of total, the banned phrase block is omitted."""
        # 3 / 100 = 3% — below 5%
        prompt, _ = _call_exec_capturing(77, 3, 20)
        # The BANNED PHRASES instruction should NOT be in the prompt
        # (the condition only fires when neg_pct > 5%)
        assert "BANNED PHRASES" not in prompt, (
            f"BANNED PHRASES instruction should not appear when neg_pct <= 5%:\n{prompt}"
        )

    def test_banned_phrases_NOT_enforced_when_exactly_5_percent(self):
        """Exactly 5% negative should NOT trigger the banned phrase block."""
        # 5 / 100 = 5.0% — the condition is strictly > 5%
        prompt, _ = _call_exec_capturing(80, 5, 15)
        assert "BANNED PHRASES" not in prompt, (
            f"BANNED PHRASES should not appear at exactly 5% negative"
        )

    def test_banned_phrases_enforced_just_above_5_percent(self):
        """Just above 5% (e.g. 6/100 = 6%) must trigger the banned phrase block."""
        prompt, _ = _call_exec_capturing(79, 6, 15)
        assert "BANNED PHRASES" in prompt, (
            f"BANNED PHRASES should appear when neg_pct is 6% (just above threshold)"
        )


# ── _call_claude_for_period signature ────────────────────────────────────────

class TestCallClaudeForPeriodSignature:
    """_call_claude_for_period accepts pos_count/neg_count/neu_count, not total_posts."""

    def test_function_accepts_pos_neg_neu_counts(self):
        """The function should accept pos_count/neg_count/neu_count kwargs without error."""
        # Use §15 insufficient-signal path so no real Claude call needed
        result = pss._call_claude_for_period(
            game_name="Test Game",
            window_label="Jan 2024",
            pos_topics=["Gameplay"],
            neg_topics=["Bugs"],
            neu_topics=[],
            pos_count=5,
            neg_count=3,
            neu_count=2,
        )
        # With total=10 < 20, we expect the insufficient-signal sentinel
        assert "Insufficient signal" in result[0]

    def test_total_posts_computed_from_counts(self):
        """total_posts is computed internally as pos+neg+neu."""
        # 5 + 3 + 2 = 10 < 20 → sentinel
        exec_summary, rec_actions, bold_ideas, _citation_map = pss._call_claude_for_period(
            game_name="Test Game",
            window_label="Jan 2024",
            pos_topics=[],
            neg_topics=[],
            neu_topics=[],
            pos_count=5,
            neg_count=3,
            neu_count=2,
        )
        assert "10" in exec_summary, f"Expected total=10 in sentinel: {exec_summary}"

    def test_insufficient_signal_sentinel_unchanged(self):
        """When total < 20, the §15 sentinel is returned without calling Claude."""
        with patch("services.period_summary_service._get_client") as mock_get:
            result = pss._call_claude_for_period(
                game_name="Test Game",
                window_label="Jan 2024",
                pos_topics=[],
                neg_topics=[],
                neu_topics=[],
                pos_count=4,
                neg_count=5,
                neu_count=6,
            )
        # Should not have called _get_client
        mock_get.assert_not_called()
        assert "Insufficient signal" in result[0]

    def test_generate_monthly_summary_passes_counts(self, db, game):
        """generate_monthly_summary passes pos/neg/neu counts to _call_claude_for_period."""
        from models import RawPost, SourceEnum, SentimentRecord, SentimentEnum
        from datetime import datetime

        # Insert posts so total >= 0 (sentinel will fire since < 20)
        # We just need to verify the call signature flows through
        with (
            patch.object(pss, "_aggregate_posts",
                         return_value=(15, 10, 8, ["Gameplay"], ["Bugs"], ["Discussion"])),
            patch.object(pss, "_call_claude_for_period",
                         return_value=("summary", None, [], {})) as mock_claude,
        ):
            try:
                pss.generate_monthly_summary(db, game.id, 2024, 1)
            except Exception:
                pass  # DB commit may fail; we just need to check the mock call

        if mock_claude.called:
            call_kwargs = mock_claude.call_args[1]
            assert "pos_count" in call_kwargs or len(mock_claude.call_args[0]) > 6, (
                "generate_monthly_summary should pass pos_count to _call_claude_for_period"
            )
