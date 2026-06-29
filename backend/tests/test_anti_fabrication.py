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


# ── Layer 3: Citation grounding ─────────────────────────────────────────────

class TestCitationInfrastructure:
    """Verify the citation helpers — _assign_citation_ids, _extract_citations,
    _strip_uncited_*.  No LLM mocks needed: pure-function tests."""

    SAMPLES = {
        "positive": [
            {"id": 101, "text": "Doug Bradley returns to voice Pinhead, fans excited.", "url": "https://x/1"},
            {"id": 102, "text": "Clive Barker creative authority is reassuring.", "url": "https://x/2"},
        ],
        "negative": [
            {"id": 201, "text": "Reboot fatigue concern from longtime fans.", "url": "https://x/3"},
        ],
        "neutral": [],
    }

    def test_assign_citation_ids_numbers_contiguously(self):
        annotated, citation_map = pss._assign_citation_ids(self.SAMPLES)
        # P-001..P-003 across three posts total (2 pos + 1 neg + 0 neu)
        assert set(citation_map.keys()) == {"P-001", "P-002", "P-003"}
        assert annotated["positive"][0]["cite"] == "P-001"
        assert annotated["positive"][1]["cite"] == "P-002"
        assert annotated["negative"][0]["cite"] == "P-003"
        assert citation_map["P-001"]["id"] == 101
        assert citation_map["P-003"]["id"] == 201

    def test_format_block_includes_tokens(self):
        annotated, _ = pss._assign_citation_ids(self.SAMPLES)
        block = pss._format_sample_posts_block_with_citations(annotated)
        assert "[P-001]" in block
        assert "[P-002]" in block
        assert "[P-003]" in block
        assert "Doug Bradley" in block

    def test_citation_requirement_clause_lists_valid_ids(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        clause = pss._citation_requirement_clause(citation_map)
        assert "P-001" in clause
        assert "P-003" in clause
        assert "Cite or omit" in clause

    def test_extract_citations(self):
        text = "Doug Bradley returns [P-001]. Reboot concerns persist [P-003, P-002]."
        out = pss._extract_citations(text)
        assert out == {"P-001", "P-002", "P-003"}

    def test_strip_uncited_sentences_drops_uncited(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        text = (
            "Doug Bradley returns to voice Pinhead [P-001]. "
            "Jamie Clayton confirmed as Pinhead. "  # no citation — must drop
            "Reboot fatigue from fans [P-003]."
        )
        out = pss._strip_uncited_sentences(text, citation_map)
        assert "Doug Bradley" in out
        assert "Reboot fatigue" in out
        assert "Jamie Clayton" not in out

    def test_strip_uncited_sentences_drops_invalid_cite(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        text = "Jamie Clayton confirmed as Pinhead [P-999]."  # invalid id
        out = pss._strip_uncited_sentences(text, citation_map)
        assert out == ""

    def test_strip_uncited_items_renumbers(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        text = (
            "1. Amplify **Doug Bradley** voice reveal [P-001].\n\n"
            "2. Cast **Jamie Clayton** as Pinhead.\n\n"  # no citation
            "3. Address **reboot fatigue** community concerns [P-003]."
        )
        out = pss._strip_uncited_items(text, citation_map)
        assert "1. Amplify" in out
        assert "2. Address" in out
        assert "Jamie Clayton" not in out
        # Original "3." was renumbered to "2."
        assert "3. " not in out

    def test_strip_uncited_items_all_dropped_returns_empty(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        text = "1. Cast **Jamie Clayton** as Pinhead.\n\n2. Make it scary."
        out = pss._strip_uncited_items(text, citation_map)
        assert out == ""

    def test_strip_uncited_bold_ideas(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        ideas = [
            "Lean into **Doug Bradley** voice reveal as marketing centerpiece [P-001].",
            "Cast **Jamie Clayton** as official villain.",  # uncited
        ]
        out = pss._strip_uncited_bold_ideas(ideas, citation_map)
        assert len(out) == 1
        assert "Doug Bradley" in out[0]

    def test_no_op_when_citation_map_empty(self):
        """Legacy callers (no citation_map) get pass-through behavior."""
        text = "Doug Bradley returns. Pre-launch hype building."
        assert pss._strip_uncited_sentences(text, {}) == text
        assert pss._strip_uncited_items(text, {}) == text
        assert pss._strip_uncited_bold_ideas(["x", "y"], {}) == ["x", "y"]


# ── Layer 4: Self-criticism pass ────────────────────────────────────────────

class TestSelfCriticism:
    """Verify the self-criticism pass calls the LLM and strips unsupported
    sentences while keeping supported ones."""

    SAMPLES = {
        "positive": [
            {"id": 101, "text": "Doug Bradley returns to voice Pinhead.", "url": "https://x/1"},
        ],
        "negative": [],
        "neutral": [],
    }

    def _mock_client(self, verdicts: list[str]) -> MagicMock:
        client = MagicMock()
        message = MagicMock()
        message.content = [MagicMock(text="\n".join(verdicts))]
        client.messages.create.return_value = message
        return client

    def test_self_criticize_drops_unsupported(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        # 2 sentences; critic says first SUPPORTED, second UNSUPPORTED
        client = self._mock_client(["SUPPORTED", "UNSUPPORTED post does not mention Clayton"])
        text = "Doug Bradley returns [P-001]. Jamie Clayton voices Pinhead [P-001]."
        out = pss._self_criticize(client, text, citation_map, "exec_summary")
        assert "Doug Bradley" in out
        assert "Jamie Clayton" not in out

    def test_self_criticize_keeps_all_supported(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        client = self._mock_client(["SUPPORTED", "SUPPORTED"])
        text = "Doug Bradley returns [P-001]. Fan reaction is positive [P-001]."
        out = pss._self_criticize(client, text, citation_map, "exec_summary")
        assert "Doug Bradley" in out
        assert "Fan reaction" in out

    def test_self_criticize_noop_when_empty_citation_map(self):
        client = MagicMock()
        text = "Some text without citation infra."
        out = pss._self_criticize(client, text, {}, "exec_summary")
        assert out == text
        client.messages.create.assert_not_called()

    def test_self_criticize_keeps_first_pass_on_critic_error(self):
        """If the critic call raises, we keep the original (better than wiping)."""
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        client = MagicMock()
        client.messages.create.side_effect = RuntimeError("api down")
        text = "Doug Bradley returns [P-001]. Pre-launch hype building [P-001]."
        out = pss._self_criticize(client, text, citation_map, "exec_summary")
        assert out == text  # untouched

    def test_self_criticize_keeps_original_on_malformed_critic_output(self):
        """Critic returns fewer verdicts than sentences → keep original."""
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        client = self._mock_client(["SUPPORTED"])  # only 1 verdict for 2 sents
        text = "Doug Bradley returns [P-001]. Hype building [P-001]."
        out = pss._self_criticize(client, text, citation_map, "exec_summary")
        assert out == text

    def test_self_criticize_items_drops_unsupported(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        client = self._mock_client(["SUPPORTED", "UNSUPPORTED invented"])
        text = (
            "1. Amplify **Doug Bradley** voice reveal [P-001].\n\n"
            "2. Cast **Jamie Clayton** as Pinhead [P-001]."
        )
        out = pss._self_criticize_items(client, text, citation_map, "recommendations")
        assert "Doug Bradley" in out
        assert "Jamie Clayton" not in out
        # Only one item survives → renumbered to 1.
        assert out.startswith("1.")
        assert "\n\n2." not in out

    def test_self_criticize_bold_ideas_drops_unsupported(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        # Two ideas, called sequentially.  Each call returns a one-line verdict.
        client = MagicMock()

        def fake_create(**kwargs):
            content = kwargs["messages"][0]["content"]
            msg = MagicMock()
            if "Jamie Clayton" in content:
                msg.content = [MagicMock(text="UNSUPPORTED no such post")]
            else:
                msg.content = [MagicMock(text="SUPPORTED")]
            return msg

        client.messages.create.side_effect = fake_create
        ideas = [
            "Lean into **Doug Bradley** voice reveal [P-001].",
            "Cast **Jamie Clayton** as Pinhead [P-001].",
        ]
        out = pss._self_criticize_bold_ideas(client, ideas, citation_map)
        assert len(out) == 1
        assert "Doug Bradley" in out[0]


# ── Release-status detection + pre-release sanitizer (2026-06-28 hardening) ──
# After the Hellraiser regression where a pre-release game got a "Patch Game
# Difficulty Settings ... before October release window" recommendation, we
# added a release-status heuristic + a layer-2b sanitizer.  These tests pin
# down both behaviors.

class TestReleaseStatusInference:

    def test_prerelease_signals_dominate(self):
        block = (
            "[P-001] Just watched the trailer, looking forward to wishlisting "
            "this. Coming soon to PS5. (P-001 / positive / 2026-06-15) "
            "[P-002] Based on the trailer it looks generic. (P-002 / negative)"
        )
        assert pss._infer_release_status(block) == "pre-release"

    def test_released_signals_dominate(self):
        block = (
            "[P-001] Patch 13 broke the meta. Matchmaking queues are bad. "
            "[P-002] Server stability since the patch has been awful, lots of "
            "disconnects mid-match. Performance issues on console too."
        )
        assert pss._infer_release_status(block) == "released"

    def test_no_signals_is_unclear(self):
        block = "[P-001] Cool game. Looks fun."
        assert pss._infer_release_status(block) == "unclear"

    def test_empty_block_is_unclear(self):
        assert pss._infer_release_status("") == "unclear"


class TestPreReleaseSanitizer:
    """The canonical violation: 'Patch Difficulty Settings before October
    release window' against an unreleased game must be dropped."""

    def test_drops_patch_verb_in_prerelease(self):
        text = (
            "1. Patch **Game Difficulty Settings** — balance pass required before October release window [P-021]\n\n"
            "2. Clarify **Clive Barker's Vision** — messaging must distinguish franchise direction [P-020]"
        )
        out = pss._sanitize_recommendations_for_release_status(text, "pre-release")
        assert "Patch" not in out
        assert "difficulty settings" not in out.lower()
        # Survivor renumbered to 1
        assert out.startswith("1. Clarify")

    def test_drops_hotfix_rebalance_in_prerelease(self):
        text = (
            "1. Hotfix **Combat Mechanics** — quick fix needed [P-001]\n\n"
            "2. Rebalance **Weapon Stats** — nerf the rifle [P-002]\n\n"
            "3. Communicate **Roadmap** — share plans with community [P-003]"
        )
        out = pss._sanitize_recommendations_for_release_status(text, "pre-release")
        assert "Hotfix" not in out
        assert "Rebalance" not in out
        assert out.startswith("1. Communicate")

    def test_drops_balance_pass_phrase(self):
        text = (
            "1. Address **Combat Tuning** — balance pass required this sprint [P-001]\n\n"
            "2. Document **Roadmap** — share plans [P-002]"
        )
        out = pss._sanitize_recommendations_for_release_status(text, "pre-release")
        assert "balance pass" not in out.lower()
        assert "Document" in out

    def test_drops_before_october_release_phrase(self):
        text = (
            "1. Ship **Polish Update** — improvements needed before October release [P-001]\n\n"
            "2. Reframe **Tone** — emphasize horror creativity [P-002]"
        )
        out = pss._sanitize_recommendations_for_release_status(text, "pre-release")
        assert "before october release" not in out.lower()
        assert "Reframe" in out

    def test_noop_when_released(self):
        text = "1. Patch **Combat** — fix balance [P-001]"
        out = pss._sanitize_recommendations_for_release_status(text, "released")
        assert out == text

    def test_noop_when_unclear(self):
        text = "1. Patch **Combat** — fix balance [P-001]"
        out = pss._sanitize_recommendations_for_release_status(text, "unclear")
        assert out == text

    def test_all_dropped_returns_empty(self):
        text = (
            "1. Patch **A** — fix [P-001]\n\n"
            "2. Hotfix **B** — fix [P-002]"
        )
        out = pss._sanitize_recommendations_for_release_status(text, "pre-release")
        assert out == ""


class TestReleaseStatusClause:

    def test_prerelease_clause_lists_forbidden_verbs(self):
        clause = pss._release_status_clause("pre-release")
        for verb in ("Patch", "Hotfix", "Rebalance", "Nerf"):
            assert verb in clause, f"Pre-release clause should warn about {verb}"
        assert "PRE-RELEASE" in clause

    def test_released_clause_allows_live_verbs(self):
        clause = pss._release_status_clause("released")
        assert "LIVE" in clause or "RELEASED" in clause

    def test_unclear_clause_defaults_to_caution(self):
        clause = pss._release_status_clause("unclear")
        assert "UNCLEAR" in clause


# ── Orphan-reference detection (2026-06-28 hardening) ──
# Failure mode caught in production: a Hellraiser bold idea read "Community
# explicitly rejected this analog [P-003, P-005, P-006], signaling players
# expect **Hellraiser Revival** to define its own identity rather than lean
# on immersive-sim legacy."  The first half of the original idea ("the
# Bioshock comparison was rejected...") was stripped by an earlier pass,
# leaving "this analog" with no antecedent.

class TestOrphanReferenceDetection:

    def test_detects_orphan_this_analog(self):
        idea = "Community explicitly rejected this analog [P-003], signaling players expect **Hellraiser Revival** to define its own identity."
        assert pss._has_orphan_reference(idea) is True

    def test_detects_orphan_this_comparison(self):
        idea = "The community pushed back on this comparison [P-001], suggesting they want a fresh identity."
        assert pss._has_orphan_reference(idea) is True

    def test_detects_orphan_the_complaint(self):
        idea = "Address the complaint [P-001] by shipping a roadmap update."
        assert pss._has_orphan_reference(idea) is True

    def test_allows_introduced_reference(self):
        """When an earlier clause introduces the antecedent via an
        introducing verb (rejected, named, compared, etc.), the 'this X'
        reference is fine."""
        idea = (
            "Community rejected the Bioshock comparison [P-003], signaling "
            "that this analog [P-005] does not capture the studio's intent."
        )
        assert pss._has_orphan_reference(idea) is False

    def test_allows_idea_without_orphan_words(self):
        idea = "Lean into **Doug Bradley** voice reveal as marketing centerpiece [P-001]."
        assert pss._has_orphan_reference(idea) is False

    def test_strip_drops_orphan_ideas(self):
        ideas = [
            "Community explicitly rejected this analog [P-003], signaling identity shift.",
            "Lean into **Doug Bradley** voice reveal [P-001].",
        ]
        out = pss._strip_orphan_reference_ideas(ideas)
        assert len(out) == 1
        assert "Doug Bradley" in out[0]

    def test_strip_keeps_all_clean_ideas(self):
        ideas = [
            "Lean into **Doug Bradley** voice reveal [P-001].",
            "Position **Clive Barker** as creative anchor [P-002].",
        ]
        out = pss._strip_orphan_reference_ideas(ideas)
        assert len(out) == 2


class TestBoldIdeaAtomicCriticism:
    """If the critic strips one sentence of a 2-sentence bold idea, the
    whole idea must be dropped — partial survival creates dangling refs."""

    SAMPLES = {
        "positive": [
            {"id": 101, "text": "Doug Bradley returns to voice Pinhead.",
             "url": "https://x/1"},
        ],
        "negative": [], "neutral": [],
    }

    def test_drop_idea_when_critic_strips_any_sentence(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        # Two-sentence idea; critic accepts sentence 1, rejects sentence 2.
        client = MagicMock()
        message1 = MagicMock()
        message1.content = [MagicMock(text="SUPPORTED\nUNSUPPORTED no such claim")]
        client.messages.create.return_value = message1
        ideas = [
            "Doug Bradley returns to voice [P-001]. Community will riot if anyone else is cast [P-001]."
        ]
        out = pss._self_criticize_bold_ideas(client, ideas, citation_map)
        assert out == []  # whole idea dropped

    def test_keep_idea_when_all_sentences_supported(self):
        _, citation_map = pss._assign_citation_ids(self.SAMPLES)
        client = MagicMock()
        message = MagicMock()
        message.content = [MagicMock(text="SUPPORTED\nSUPPORTED")]
        client.messages.create.return_value = message
        ideas = ["Doug Bradley returns [P-001]. Community is excited [P-001]."]
        out = pss._self_criticize_bold_ideas(client, ideas, citation_map)
        assert len(out) == 1


# ── Commercial Strategic Context (CLAUDE.md §21, 2026-06-29) ────────────────
# After the Hellraiser weekly digest recommended counter-positioning AWAY
# from Resident Evil comparisons — when RE Requiem is the #1 commercial
# horror release of 2026 (7M+ units in 2 months, fastest-selling RE ever) —
# we added a per-title commercial-strategic context brief + a signal
# classification clause that biases recommendations toward AMPLIFYING
# positive comparisons rather than counter-positioning away from them.

class TestCommercialContextClause:

    def test_brief_set_includes_brief_text(self):
        brief = (
            "POSITIONING: single-player survival horror. "
            "TAILWIND TO AMPLIFY: Resident Evil Requiem comparisons are an asset."
        )
        out = pss._commercial_context_clause(brief)
        assert "COMMERCIAL STRATEGIC CONTEXT" in out
        assert "Resident Evil Requiem" in out
        assert "AMPLIFY" in out

    def test_brief_unset_falls_back_to_generic_reminder(self):
        out = pss._commercial_context_clause(None)
        assert "COMMERCIAL STRATEGIC THINKING" in out
        # Generic reminder explicitly warns against deflecting positive
        # comparisons to a market leader.
        assert "do not advise the team to distance" in out.lower()

    def test_brief_empty_string_falls_back(self):
        out = pss._commercial_context_clause("   ")
        assert "COMMERCIAL STRATEGIC THINKING" in out

    def test_signal_classification_clause_calls_out_assets(self):
        out = pss._SIGNAL_CLASSIFICATION_CLAUSE
        assert "ASSET" in out
        assert "AMPLIFY" in out
        assert "Lean into" in out
        # The market-leader comparison rule must be called out as CRITICAL.
        assert "CRITICAL on COMPARISONS" in out
        assert "AMPLIFYING the comparison" in out

    def test_signal_classification_keeps_liability_handling(self):
        out = pss._SIGNAL_CLASSIFICATION_CLAUSE
        assert "LIABILITY" in out
        assert "ADDRESS" in out


class TestSeedCommercialContext:
    """The 8 priority titles each get a sensible default brief that names
    a real commercial benchmark."""

    def test_seed_defaults_cover_all_8_priority_titles(self):
        from seed_commercial_context import DEFAULTS
        priority = {24, 25, 23, 21, 134, 131, 20, 130}
        assert priority.issubset(DEFAULTS.keys()), (
            f"Missing defaults for: {priority - DEFAULTS.keys()}"
        )

    def test_hellraiser_default_names_resident_evil(self):
        from seed_commercial_context import DEFAULTS
        brief = DEFAULTS[21]  # Hellraiser
        # The failure mode that triggered this whole feature — make sure
        # the default explicitly tells the LLM RE is a tailwind, not a
        # threat to counter-position away from.
        assert "Resident Evil" in brief
        assert "AMPLIFY" in brief or "amplify" in brief
        assert "do not" in brief.lower() and "counter-position" in brief.lower()

    def test_hellraiser_default_names_halloween_as_threat(self):
        from seed_commercial_context import DEFAULTS
        brief = DEFAULTS[21]
        # Halloween: The Game (Sept 8 2026) IS a real threat to
        # differentiate from (asymmetrical multiplayer vs. our single-
        # player survival horror).
        assert "Halloween" in brief

    def test_space_marine_2_default_treats_it_as_released(self):
        from seed_commercial_context import DEFAULTS
        brief = DEFAULTS[24]
        # SM2 is a live game; the brief should mention live-game signals,
        # not pre-release marketing.
        assert "live" in brief.lower() or "Live" in brief

    def test_all_defaults_warn_against_counter_positioning(self):
        from seed_commercial_context import DEFAULTS
        for game_id, brief in DEFAULTS.items():
            assert "DO NOT" in brief, f"Game {game_id} brief should have a DO NOT clause"


class TestSignalClassificationBalance:
    """The signal classification clause must surface LIABILITIES, not just
    amplify ASSETS.  Added 2026-06-29 after the user noticed the §21 fix
    might over-correct: after rewording, Hellraiser produced 2 amplify
    actions and skipped surfacing real negative topics like Regional
    Localization Issues that should have been LIABILITY recommendations."""

    def test_clause_lists_liability_triggers_broadly(self):
        out = pss._SIGNAL_CLASSIFICATION_CLAUSE
        for trigger in (
            "legitimate quality concern",
            "regional content gap",
            "localization issue",
            "missing feature",
            "performance problem",
            "communication gap",
        ):
            assert trigger in out, f"LIABILITY trigger should be listed: {trigger}"

    def test_clause_explicitly_requires_mix(self):
        """The prompt must explicitly tell the LLM to mix asset + liability
        actions, not skew to only amplify — BUT only on themes that clear
        the critical-mass tier (don't recommend on single-poster topics)."""
        out = pss._SIGNAL_CLASSIFICATION_CLAUSE
        assert "BALANCE REQUIREMENT" in out
        assert "DO NOT SKEW" in out
        # Explicit anti-white-wash language so a future agent reading this
        # cannot mistake the rule for "always frame everything positively".
        assert "white-washing" in out
        # And the critical-mass tier hook keeps it from over-correcting into
        # "recommend on every negative topic regardless of volume".
        assert "tier='theme'" in out
        assert "tier='monitor-only'" in out

    def test_clause_scopes_comparison_rule_to_market_leaders(self):
        """The 'amplify positive comparisons' rule must NOT be read as
        'amplify all negative signals' — it applies only to market-leader
        comparisons.  Legitimate complaints stay as LIABILITIES."""
        out = pss._SIGNAL_CLASSIFICATION_CLAUSE
        assert "applies ONLY to market-leader comparisons" in out
        assert "legitimate complaints" in out
        assert "remain LIABILITIES" in out


class TestTopicCriticalMass:
    """CLAUDE.md §21b: a topic must clear weight + day-appearance thresholds
    before the LLM is allowed to write a recommendation about it.  Surfacing
    the topic on the dashboard is OK at lower thresholds; only RECOMMENDATIONS
    get the higher bar.

    This prevents the failure mode where a lone Turkish post produced a
    'Patch regional localization' recommendation."""

    def test_single_day_low_weight_is_monitor_only(self):
        """A topic that appeared once at rank 5 (weight=1, days=1) is
        below recommendation threshold."""
        # Direct unit test of the tier logic via constants.
        weight, days = 1.0, 1
        is_theme = (
            weight >= pss._TOPIC_REC_MIN_WEIGHT and days >= pss._TOPIC_REC_MIN_DAYS
        ) or weight >= pss._TOPIC_REC_SINGLE_DAY_WEIGHT
        assert not is_theme

    def test_two_day_appearance_with_weight_clears_threshold(self):
        """A topic at rank 3 on two days (weight = 3+3 = 6, days=2) clears."""
        weight, days = 6.0, 2
        is_theme = (
            weight >= pss._TOPIC_REC_MIN_WEIGHT and days >= pss._TOPIC_REC_MIN_DAYS
        ) or weight >= pss._TOPIC_REC_SINGLE_DAY_WEIGHT
        assert is_theme

    def test_single_day_high_weight_clears_threshold(self):
        """A topic at rank 1 + rank 2 on one day (weight=5+4=9, days=1) clears
        via the single-day-spike branch."""
        weight, days = 9.0, 1
        is_theme = (
            weight >= pss._TOPIC_REC_MIN_WEIGHT and days >= pss._TOPIC_REC_MIN_DAYS
        ) or weight >= pss._TOPIC_REC_SINGLE_DAY_WEIGHT
        assert is_theme

    def test_format_block_lists_tiers(self):
        table = {
            "positive": [("Co-op Gameplay", 15.0, 3, "theme")],
            "negative": [
                ("Server Stability", 9.0, 2, "theme"),
                ("Turkish Localization", 1.0, 1, "monitor-only"),
            ],
            "neutral": [],
        }
        out = pss._format_critical_mass_block(table)
        assert "tier=theme" in out
        assert "tier=monitor-only" in out
        assert "Turkish Localization" in out
        # Must explicitly forbid recommending on monitor-only topics.
        assert "do NOT" in out

    def test_format_block_empty_when_no_topics(self):
        empty = {"positive": [], "negative": [], "neutral": []}
        assert pss._format_critical_mass_block(empty) == ""

    def test_classification_clause_references_critical_mass_table(self):
        """The signal-classification clause must tell the LLM about the
        tier system so it knows to consult the table."""
        out = pss._SIGNAL_CLASSIFICATION_CLAUSE
        assert "tier='theme'" in out
        assert "tier='monitor-only'" in out
        assert "thin" in out  # explicit phrasing about thin signals
        assert "single poster" in out


# ── CLAUDE.md §22 Pre-flight QA (2026-06-29) ────────────────────────────────
# Bugs caught in production on 2026-06-29:
#   - Toxic Commando exec opened with "However, ..." (orphan discourse marker)
#   - Toxic Commando + Turok produced "1. [P-007]" empty-stub recommendations
#   - Multiple titles had <3 recommendations despite having theme-tier topics

class TestOrphanDiscourseMarker:

    def test_scrubs_however(self):
        out = pss._scrub_orphan_opener("However, black screens block players [P-001].")
        assert not out.lower().startswith("however")
        assert out.startswith("B"), f"should capitalize after strip: {out!r}"

    def test_scrubs_moreover(self):
        assert "moreover" not in pss._scrub_orphan_opener("Moreover, this happened.").lower()

    def test_scrubs_additionally(self):
        assert "additionally" not in pss._scrub_orphan_opener("Additionally, X is broken.").lower()

    def test_leaves_clean_opener_alone(self):
        clean = "Community sentiment was mixed during this window."
        assert pss._scrub_orphan_opener(clean) == clean

    def test_strip_uncited_sentences_scrubs_after_strip(self):
        """Integration: when strip removes the leading sentence, the surviving
        sentence's discourse marker also gets scrubbed."""
        text = (
            "Co-op players love the game. "  # no citation — strip drops
            "However, black screens are blocking players [P-001]."
        )
        cm = {"P-001": {"id": 1, "url": "x", "sentiment": "negative"}}
        out = pss._strip_uncited_sentences(text, cm)
        assert "However" not in out and "however" not in out
        assert "Black screens" in out or "black screens" in out


class TestEmptyStubRecommendation:

    def test_detects_citation_only_item(self):
        assert not pss._item_has_substantive_content("1. [P-007]")
        assert not pss._item_has_substantive_content("2.  [P-005, P-013]")
        assert not pss._item_has_substantive_content("3. [P-001] [P-002]")

    def test_keeps_substantive_item(self):
        assert pss._item_has_substantive_content(
            "1. Patch **Server Stability** — fix matchmaking [P-001]"
        )
        assert pss._item_has_substantive_content(
            "2. Audit **Sniper Balance** — DPS underperforms [P-005, P-013]"
        )

    def test_strip_uncited_items_drops_empty_stubs(self):
        text = (
            "1. [P-007]\n\n"
            "2. Audit **Sniper Balance** — DPS underperforms M110 [P-005, P-013]"
        )
        cm = {
            "P-005": {"id": 5, "url": "x", "sentiment": "negative"},
            "P-007": {"id": 7, "url": "x", "sentiment": "negative"},
            "P-013": {"id": 13, "url": "x", "sentiment": "negative"},
        }
        out = pss._strip_uncited_items(text, cm)
        # The empty stub is gone; the substantive item is renumbered to 1.
        assert "[P-007]" not in out or "Audit" in out
        assert out.startswith("1. Audit")
        assert "\n\n2." not in out


class TestValidateSummaryOutput:

    CMAP = {
        "P-001": {"id": 1, "url": "x", "sentiment": "negative"},
        "P-002": {"id": 2, "url": "x", "sentiment": "positive"},
    }

    def test_clean_output_returns_no_failures(self):
        failures = pss._validate_summary_output(
            exec_summary="Community sentiment leans positive [P-002].",
            recommended_actions=(
                "1. Lean into **Doug Bradley** voice reveal [P-002]\n\n"
                "2. Address **Server Stability** issues [P-001]\n\n"
                "3. Document **Roadmap** for community [P-002]"
            ),
            bold_ideas=["Lean into **Doug Bradley** reveal as marketing centerpiece [P-002]."],
            citation_map=self.CMAP,
            total_posts=50,
        )
        assert failures == [], f"unexpected failures: {failures}"

    def test_flags_orphan_however_opener(self):
        failures = pss._validate_summary_output(
            exec_summary="However, X happened [P-001].",
            recommended_actions=None,
            bold_ideas=[],
            citation_map=self.CMAP,
            total_posts=50,
        )
        assert any("orphan discourse marker" in f for f in failures)

    def test_flags_empty_stub_recommendation(self):
        failures = pss._validate_summary_output(
            exec_summary="Community sentiment leans positive [P-002].",
            recommended_actions="1. [P-001]\n\n2. Address **X** [P-001]",
            bold_ideas=[],
            citation_map=self.CMAP,
            total_posts=50,
        )
        assert any("empty stub" in f for f in failures)

    def test_flags_below_minimum_recommendations(self):
        cm_table = {
            "negative": [("Server Stability", 9.0, 2, "theme")],
            "positive": [], "neutral": [],
        }
        failures = pss._validate_summary_output(
            exec_summary="Community sentiment is mixed [P-001].",
            recommended_actions="1. Patch **Server Stability** [P-001]",
            bold_ideas=[],
            citation_map=self.CMAP,
            total_posts=50,
            critical_mass_table=cm_table,
        )
        assert any("only 1 recommendations" in f for f in failures)

    def test_flags_exceeds_max_recommendations(self):
        items = "\n\n".join(
            f"{n}. Patch **Topic{n}** — fix [P-001]"
            for n in range(1, 7)  # 6 items
        )
        failures = pss._validate_summary_output(
            exec_summary="Community sentiment [P-001].",
            recommended_actions=items,
            bold_ideas=[],
            citation_map=self.CMAP,
            total_posts=50,
        )
        assert any("exceeds maximum" in f for f in failures)

    def test_flags_non_imperative_verb(self):
        failures = pss._validate_summary_output(
            exec_summary="Community sentiment [P-001].",
            recommended_actions=(
                "1. Note that **Topic** is broken [P-001]\n\n"
                "2. Address **Other** problem [P-001]\n\n"
                "3. Document **Roadmap** [P-002]"
            ),
            bold_ideas=[],
            citation_map=self.CMAP,
            total_posts=50,
        )
        assert any("does not start with an imperative verb" in f for f in failures)

    def test_flags_missing_bolded_entity(self):
        failures = pss._validate_summary_output(
            exec_summary="Community sentiment [P-001].",
            recommended_actions=(
                "1. Address the server issue [P-001]\n\n"
                "2. Audit **Sniper Balance** [P-001]\n\n"
                "3. Document **Roadmap** [P-002]"
            ),
            bold_ideas=[],
            citation_map=self.CMAP,
            total_posts=50,
        )
        assert any("missing bolded entity" in f for f in failures)


class TestTruncateToMaxRecommendations:

    def test_under_max_unchanged(self):
        text = "1. A [P-001]\n\n2. B [P-001]\n\n3. C [P-001]"
        assert pss._truncate_to_max_recommendations(text) == text

    def test_over_max_truncated_and_renumbered(self):
        text = "\n\n".join(f"{n}. Item{n} [P-001]" for n in range(1, 8))
        out = pss._truncate_to_max_recommendations(text)
        items = [l for l in out.split("\n") if l.strip().startswith(tuple("0123456789"))]
        assert len(items) == 5
        assert items[-1].startswith("5.")
