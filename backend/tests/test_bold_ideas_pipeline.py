"""§21g pipeline tests for bold-ideas resilience.

Live trace 2026-06-29 showed the bold-ideas pipeline dropping 60-100% of
candidates across substantive titles:
  * Toxic Commando: 5 -> 0 (critic killed all 5)
  * SM2: 6 -> 0 (critic killed 4 of 6, sanitizer killed remaining 2)
  * Bus Bound: 6 -> 0 (sanitizer killed 4 of 5)
  * Hellraiser: 6 -> 0 (mix across layers)
  * Turok: 4 -> 0 (mix across layers)

These tests guard the three targeted fixes:
  1. `_BOLD_IDEA_IMPERATIVE_RE` filter in `_parse_bold_ideas` drops
     exec-prose preambles before they reach the critic.
  2. `_self_criticize` uses a RELAXED standard for `block_kind="bold_ideas"`
     -- topical proximity IS support.  (Tested indirectly via prompt-shape
     inspection because the actual LLM call is mocked elsewhere.)
  3. `_fact_check_for_fabrications` no longer flags bolded-phrase verbs
     ("Amplify" inside `**Amplify Welsh VO**`), possessive forms
     ("Jeff's" when post has "Jeff"), or common business abbreviations
     (PR, DLC, VO).
"""
from services.period_summary_service import (
    _parse_bold_ideas,
    _fact_check_for_fabrications,
    _build_input_whitelist,
)


class TestParseBoldIdeasImperativeFilter:

    def test_drops_exec_prose_preamble(self):
        raw = (
            "# Executive Summary\n\n"
            "Community signal across the 7-day window is sparse but coherent.\n\n"
            "1. Amplify Doug Bradley creative authority in pre-launch messaging.\n"
            "2. Lean into Resident Evil comparison as market validation.\n"
        )
        result = _parse_bold_ideas(raw)
        assert len(result) == 2
        assert "Amplify" in result[0]
        assert "Lean into" in result[1]

    def test_drops_key_signal_framing(self):
        raw = (
            "**Key Signal:** Turkish localization demand recurring across the window.\n\n"
            "1. Spotlight Cast & Actor Interviews via behind-the-scenes content.\n"
        )
        result = _parse_bold_ideas(raw)
        assert len(result) == 1
        assert "Spotlight" in result[0]

    def test_drops_descriptive_post_reference_lead(self):
        # "The community has organically registered..." is descriptive,
        # not an imperative bold idea.
        raw = (
            "1. The community has organically registered Doug Bradley's casting.\n"
            "2. Partner with Fangoria for an exclusive cover spread to capitalize.\n"
        )
        result = _parse_bold_ideas(raw)
        assert len(result) == 1
        assert "Partner with" in result[0]

    def test_keeps_imperative_verb_openers(self):
        # All bold-idea-style imperatives must pass.
        cases = [
            "Amplify",
            "Lean into",
            "Spotlight",
            "Partner with",
            "Launch",
            "Host",
            "Sponsor",
            "Address",
            "Communicate",
            "Showcase",
            "Reframe",
            "Investigate",
            "Tie",
            "Bridge",
        ]
        for verb in cases:
            raw = (
                f"1. {verb} the Welsh VO talent in a streamer series anchored "
                f"on Jeff and Emberville to amplify localization momentum."
            )
            result = _parse_bold_ideas(raw)
            assert len(result) == 1, f"Verb {verb!r} was incorrectly dropped"


class TestFactCheckWhitelistFixes:

    def test_amplify_inside_bolded_phrase_not_flagged(self):
        # **Amplify Welsh VO** -- "Amplify" must not be flagged as a
        # fabricated proper noun even though it is title-case inside the
        # bolded entity extractor.
        idea = (
            "**Amplify Welsh VO as a localization case study.** The Welsh-language "
            "cast is rare for indie sims [P-001]."
        )
        sample_posts = {
            "positive": ["Welsh voice acting on Bus Bound is incredible."],
            "negative": [],
            "neutral": [],
        }
        fabs = _fact_check_for_fabrications(
            idea, "Bus Bound", sample_posts, ["Welsh VO"], [],
        )
        assert "Amplify" not in fabs

    def test_possessive_form_matches_bare_form(self):
        # Post contains "Jeff" -- idea contains "Jeff's".  Must not be flagged.
        idea = (
            "Spotlight Jeff's voice work in a behind-the-scenes interview series "
            "to amplify Welsh localization momentum [P-001]."
        )
        sample_posts = {
            "positive": ["Jeff from Emberville did the Welsh voice acting."],
            "negative": [],
            "neutral": [],
        }
        fabs = _fact_check_for_fabrications(
            idea, "Bus Bound", sample_posts, ["Jeff"], [],
        )
        assert "Jeff's" not in fabs

    def test_bare_form_matches_possessive_in_source(self):
        # Reverse case: post has "Barker's" -- idea references "Barker".
        idea = "Anchor on Barker's Hellraiser IP as auteur differentiation [P-014]."
        sample_posts = {
            "positive": ["Clive Barker's involvement validates the auteur play."],
            "negative": [],
            "neutral": [],
        }
        fabs = _fact_check_for_fabrications(
            idea, "Hellraiser", sample_posts, ["Clive Barker"], [],
        )
        assert "Barker" not in fabs

    def test_common_business_abbreviations_not_flagged(self):
        idea = (
            "Launch a PR campaign tied to the DLC drop with VO-led promo "
            "to lean on the community FAQ [P-001]."
        )
        sample_posts = {"positive": ["something generic"], "negative": [], "neutral": []}
        fabs = _fact_check_for_fabrications(
            idea, "Test Game", sample_posts, [], [],
        )
        for abbrev in ("PR", "DLC", "VO", "FAQ"):
            assert abbrev not in fabs, f"{abbrev} should not be flagged"


class TestSelfCriticizeBlockKindRouting:
    """The prompt-construction branch should differ for bold_ideas vs other
    block kinds.  We don't mock the Anthropic call here -- we inspect the
    branch logic via a thin probe that captures the prompt that would be
    sent.
    """

    def test_bold_ideas_prompt_uses_relaxed_standard(self):
        """The bold_ideas branch must explicitly tell the critic that
        topical proximity IS support and that strict fact-check rules do
        NOT apply.  This is the line that prevents the 60-100% drop seen
        in the 2026-06-29 trace.
        """
        # Inspect the source to confirm the relaxed branch exists.  This is
        # cheaper than a full Anthropic mock and catches accidental
        # regressions where someone removes the branch.
        import inspect
        from services import period_summary_service
        src = inspect.getsource(period_summary_service._self_criticize)
        assert 'block_kind == "bold_ideas"' in src
        assert "Topical proximity IS support" in src
        assert "interpretive by design" in src
