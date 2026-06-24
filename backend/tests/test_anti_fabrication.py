"""Regression tests for the anti-fabrication prompt rule (2026-06-24).

Failure mode: live Hellraiser digest cited "Jamie Clayton voice casting"
in Recommended Actions + Big Ideas.  Ground truth in raw_posts:

  • Zero posts mentioned Clayton (she played Pinhead in the 2022 movie).
  • One post explicitly said "Doug Bradley returns to voice Pinhead".

The LLM autocompleted Clayton from background knowledge of the franchise
because the actions + bold-ideas prompts asked for "specific entities"
without constraining specifics to the input data.

The fix: shared _anti_fabrication_clause() injected into all three
prompts (exec, actions, bold ideas).  These tests verify the clause is
actually in the prompts when entities/samples are present, and that the
fallback "no specifics → don't invent" form appears when they aren't.
"""
import re
from unittest.mock import MagicMock, patch

import pytest

from services import period_summary_service as pss


# ── _anti_fabrication_clause itself ─────────────────────────────────────────

class TestAntiFabricationClauseShape:
    def test_includes_franchise_warning_when_data_present(self):
        clause = pss._anti_fabrication_clause(
            samples_block="some sample post text",
            entities_block="Doug Bradley, Pinhead",
        )
        assert "ANTI-FABRICATION RULES" in clause
        assert "verbatim" in clause.lower()
        assert "background knowledge" in clause.lower()
        # Explicit movie/franchise guard
        assert "movies" in clause.lower() or "franchise" in clause.lower()

    def test_no_specifics_fallback_when_blocks_empty(self):
        clause = pss._anti_fabrication_clause(
            samples_block="",
            entities_block="",
        )
        assert "NO SPECIFICS AVAILABLE" in clause
        assert "Do NOT invent" in clause
        # Hard rule sections should NOT be present in the empty case \u2014
        # there's nothing to anchor against, so the instruction is just
        # \"don't invent.\"
        assert "ANTI-FABRICATION RULES" not in clause


# ── Prompts actually contain the clause ──────────────────────────────────────

class TestPromptsIncludeAntiFabrication:
    """Patch the Claude client so we capture the literal prompt strings.

    Each test asserts the anti-fabrication clause is in the prompt AND
    that the Hellraiser regression scenario (Bradley in data, Clayton not)
    is structurally protected: only Bradley shows up in the prompt's
    DISTINCTIVE ENTITIES + SAMPLE POSTS sections.
    """

    HELLRAISER_SAMPLES = {
        "positive": [
            "Doug Bradley returns to voice Pinhead in Hellraiser Revival — "
            "this is the perfect choice for fans",
        ],
        "negative": [
            "Why has Pinhead got a double voice? He never had them in any of the films",
        ],
        "neutral": [
            "The pain will be exquisite. Saber Interactive and Boss Team Games bring "
            "us Clive Barker's Hellraiser: Revival, launching October 8th 2026",
        ],
    }
    HELLRAISER_ENTITIES = ["Doug Bradley", "Pinhead", "Hellraiser Revival", "Saber Interactive"]

    def _capture_prompt(self, call_fn, **kwargs):
        """Run the given _call_* function with a mocked Claude client, return prompt."""
        captured = {}

        def fake_create(**create_kwargs):
            captured["prompt"] = create_kwargs["messages"][0]["content"]
            mock_msg = MagicMock()
            mock_msg.content[0].text = "1. Patch **Pinhead** double-voice — community flagged it. 2. Amplify **Doug Bradley** casting."
            return mock_msg

        client = MagicMock()
        client.messages.create = fake_create
        call_fn(client, **kwargs)
        return captured["prompt"]

    def test_actions_prompt_has_clause_and_only_real_entities(self):
        prompt = self._capture_prompt(
            pss._call_actions,
            game_name="Clive Barker's Hellraiser: Revival",
            window_label="Jun 18 - Jun 24, 2026",
            pos_str="hands-on impressions, casting, source material",
            neg_str="voice direction, double voice",
            neu_str="release date, preorder",
            sample_posts=self.HELLRAISER_SAMPLES,
            distinctive_entities=self.HELLRAISER_ENTITIES,
        )
        assert "ANTI-FABRICATION RULES" in prompt
        assert "verbatim" in prompt.lower()
        # Real entities ARE in the prompt
        assert "Doug Bradley" in prompt
        assert "Pinhead" in prompt
        # Fabricated entity is NOT
        assert "Jamie Clayton" not in prompt
        assert "Clayton" not in prompt
        # The anti-fabrication clause must appear BEFORE the data section
        # so the LLM sees the rule before reading the data.
        ar_pos = prompt.index("ANTI-FABRICATION RULES")
        data_pos = prompt.find("Data (")
        assert ar_pos < data_pos, "anti-fab clause must appear before the Data section"

    def test_bold_ideas_prompt_has_clause(self):
        prompt = self._capture_prompt(
            pss._call_bold_ideas,
            game_name="Clive Barker's Hellraiser: Revival",
            window_label="Jun 18 - Jun 24, 2026",
            pos_str="hands-on, casting",
            neg_str="voice direction",
            neu_str="release",
            total_posts=68,
            sample_posts=self.HELLRAISER_SAMPLES,
            distinctive_entities=self.HELLRAISER_ENTITIES,
        )
        assert "ANTI-FABRICATION RULES" in prompt
        # Both the shared clause and the bold-ideas-specific reminder
        assert "Background knowledge" in prompt or "background knowledge" in prompt
        assert "Doug Bradley" in prompt
        assert "Jamie Clayton" not in prompt

    def test_actions_prompt_with_no_data_uses_no_specifics_fallback(self):
        """When samples+entities are both empty, the prompt must explicitly tell
        the model NOT to invent names, since there's nothing to anchor on."""
        prompt = self._capture_prompt(
            pss._call_actions,
            game_name="Some Quiet Game",
            window_label="Jun 18 - Jun 24, 2026",
            pos_str="general praise",
            neg_str="",
            neu_str="",
            sample_posts={"positive": [], "negative": [], "neutral": []},
            distinctive_entities=[],
        )
        assert "NO SPECIFICS AVAILABLE" in prompt
        assert "Do NOT invent named entities" in prompt


# ── Post-LLM fact-check gate ─────────────────────────────────────────────────

class TestFactCheckGate:
    """REGRESSION (2026-06-24): even with anti-fabrication prompt rules,
    Claude still surfaced "Jamie Clayton voicing Pinhead" for Hellraiser
    because she's strongly associated with the franchise in training data.
    Prompt instructions nudge the model; this gate ENFORCES."""

    HELLRAISER_SAMPLES = {
        "positive": [
            "Doug Bradley returns to voice Pinhead in Hellraiser Revival",
            "We played an early build of Clive Barker's Hellraiser: Revival",
        ],
        "negative": [
            "Why has Pinhead got a double voice? He never had them in any films",
        ],
        "neutral": [
            "Saber Interactive and Boss Team Games launching October 8th 2026",
        ],
    }
    HELLRAISER_ENTITIES = ["Doug Bradley", "Pinhead", "Hellraiser Revival",
                            "Saber Interactive", "Clive Barker"]
    GAME = "Clive Barker's Hellraiser: Revival"

    def test_fact_check_flags_jamie_clayton(self):
        text = "Document Jamie Clayton voice casting decisions for Pinhead."
        fabs = pss._fact_check_for_fabrications(
            text, self.GAME, self.HELLRAISER_SAMPLES, self.HELLRAISER_ENTITIES,
        )
        assert "Clayton" in fabs
        assert "Jamie" in fabs
        # Pinhead is in the samples → must NOT be flagged
        assert "Pinhead" not in fabs
        # Doug Bradley is in entities → must NOT be flagged
        # (Note: case-insensitive matching is applied internally)

    def test_fact_check_accepts_real_entities(self):
        text = "Amplify Doug Bradley casting and the Pinhead double-voice."
        fabs = pss._fact_check_for_fabrications(
            text, self.GAME, self.HELLRAISER_SAMPLES, self.HELLRAISER_ENTITIES,
        )
        assert fabs == [], f"expected no fabrications, got {fabs}"

    def test_fact_check_ignores_months_and_common_words(self):
        text = "Announce on October 8th. The community is waiting."
        fabs = pss._fact_check_for_fabrications(
            text, self.GAME, self.HELLRAISER_SAMPLES, self.HELLRAISER_ENTITIES,
        )
        assert "October" not in fabs

    def test_sanitize_recommendations_drops_clayton_line(self):
        text = """1. Amplify **Clive Barker's vision** — source material respect.

2. Document **voice cast decisions** — Jamie Clayton signals appetite for casting.

3. Clarify **preorder strategy** — confirm timeline publicly."""
        out = pss._sanitize_recommendations(
            text, self.GAME, self.HELLRAISER_SAMPLES, self.HELLRAISER_ENTITIES,
        )
        assert "Jamie" not in out
        assert "Clayton" not in out
        # The other two recs survive AND get renumbered 1, 2
        assert "Clive Barker" in out
        assert "preorder strategy" in out
        # Renumbered cleanly
        assert out.startswith("1.")
        assert "\n\n2." in out
        assert "3." not in out  # only 2 survivors, not 3

    def test_sanitize_recommendations_all_dropped_returns_empty(self):
        """If every recommendation contains a fabrication, return '' so the
        caller can fall back to NONE."""
        text = "1. Partner Jamie Clayton for DLC.\n\n2. Cast Jamie Clayton again."
        out = pss._sanitize_recommendations(
            text, self.GAME, self.HELLRAISER_SAMPLES, self.HELLRAISER_ENTITIES,
        )
        assert out == ""

    def test_sanitize_bold_ideas_drops_clayton(self):
        ideas = [
            "Lean into **Jamie Clayton** casting speculation as official reveal.",
            "Amplify **Clive Barker's** creative authority in messaging.",
        ]
        out = pss._sanitize_bold_ideas(
            ideas, self.GAME, self.HELLRAISER_SAMPLES, self.HELLRAISER_ENTITIES,
        )
        assert len(out) == 1
        assert "Clive Barker" in out[0]
        assert "Clayton" not in out[0]

    def test_sanitize_executive_summary_drops_clayton_sentence(self):
        text = (
            "Community sentiment for the game is positive. "
            "Jamie Clayton voicing Pinhead emerged as a point of interest. "
            "Pre-launch chatter dominates."
        )
        out = pss._sanitize_executive_summary(
            text, self.GAME, self.HELLRAISER_SAMPLES, self.HELLRAISER_ENTITIES,
        )
        assert "Clayton" not in out
        assert "Jamie" not in out
        assert "Community sentiment" in out
        assert "Pre-launch chatter" in out
