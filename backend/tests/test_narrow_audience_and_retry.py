"""Tests for §25h (volume-only topic gate) and §22b (low-rec retry).

§25h (2026-06-29): volume is the only rule for topic mention in summaries.
A topic appears in the exec or recs only when it clears the critical-mass
volume threshold. The prior §21h pattern-based narrow-audience demotion
and §25g rec-substring gate are removed.

§22b: when _call_actions produces fewer than _REC_COUNT_MIN valid items
on a substantive title, a single retry runs with a fix-list hint.
"""
from services.period_summary_service import (
    _count_valid_recommendations,
    _retry_actions_if_below_min,
    _REC_COUNT_MIN,
    _shipped_regional_allowlist,
    _shipped_regional_low_volume_topics,
    _strip_monitor_only_recs,
    _LOW_VOLUME_WEIGHT_MAX,
)


# ────────────────────────────────────────────────────────────────────────
# §25h: SHIPPED REGIONAL CONTENT marker parsing
# ────────────────────────────────────────────────────────────────────────

class TestShippedRegionalAllowlistParser:
    """§25h: parse SHIPPED REGIONAL CONTENT marker from commercial_context.

    The marker is still parsed (used only for the §25h low-volume exec
    exception); the pattern-based narrow-audience gate is gone.
    """

    def test_returns_empty_for_none_or_empty(self):
        assert _shipped_regional_allowlist(None) == []
        assert _shipped_regional_allowlist("") == []

    def test_returns_empty_when_no_marker_line(self):
        ctx = (
            "POSITIONING: Indie sim/strategy title.\n"
            "COMMERCIAL CONTEXT: Niche genre with loyal long-tail audience.\n"
        )
        assert _shipped_regional_allowlist(ctx) == []

    def test_parses_single_token(self):
        ctx = (
            "POSITIONING: Indie sim/strategy.\n"
            "SHIPPED REGIONAL CONTENT: Welsh\n"
            "DO NOT: AAA-marketing actions.\n"
        )
        assert _shipped_regional_allowlist(ctx) == ["welsh"]

    def test_parses_multiple_tokens(self):
        ctx = "SHIPPED REGIONAL CONTENT: Welsh, Scots Gaelic, Brazilian Portuguese"
        assert _shipped_regional_allowlist(ctx) == [
            "welsh", "scots gaelic", "brazilian portuguese",
        ]

    def test_parses_underscore_variant(self):
        ctx = "SHIPPED_REGIONAL_CONTENT: welsh"
        assert _shipped_regional_allowlist(ctx) == ["welsh"]

    def test_parses_localization_variant(self):
        ctx = "SHIPPED LOCALIZATION: Welsh"
        assert _shipped_regional_allowlist(ctx) == ["welsh"]

    def test_case_insensitive_marker(self):
        for line in (
            "shipped regional content: welsh",
            "Shipped Regional Content: Welsh",
            "SHIPPED REGIONAL CONTENT: Welsh",
        ):
            assert _shipped_regional_allowlist(line) == ["welsh"], line

    def test_deduplicates_tokens(self):
        ctx = "SHIPPED REGIONAL CONTENT: Welsh, welsh, WELSH"
        assert _shipped_regional_allowlist(ctx) == ["welsh"]


# ────────────────────────────────────────────────────────────────────────
# §25h: low-volume tier classification + shipped-content low-volume picker
# ────────────────────────────────────────────────────────────────────────

class TestShippedRegionalLowVolumePicker:
    """§25h: _shipped_regional_low_volume_topics picks out top-5 low-volume
    topics whose label matches a shipped-regional token. These are the ONLY
    topics that may surface in the exec at sub-threshold volume, and only
    with the mandatory qualifier."""

    def test_empty_inputs_return_empty(self):
        assert _shipped_regional_low_volume_topics({}, []) == []
        assert _shipped_regional_low_volume_topics({}, ["welsh"]) == []
        assert _shipped_regional_low_volume_topics(
            {"positive": [("Welsh VO", 2, 1, "low-volume")]}, [],
        ) == []

    def test_picks_low_volume_welsh_when_in_shipped_tokens(self):
        cm = {
            "positive": [
                ("Welsh Voice Acting", 2, 1, "low-volume"),
                ("Combat Mechanics", 8, 3, "theme"),
            ],
            "negative": [],
            "neutral": [],
        }
        out = _shipped_regional_low_volume_topics(cm, ["welsh"])
        assert out == [("positive", "Welsh Voice Acting", 2, 1)]

    def test_skips_welsh_when_tier_is_theme(self):
        # If Welsh hits theme tier on its own merit, it doesn't need the
        # exception — it's a regular theme topic.
        cm = {
            "positive": [("Welsh Voice Acting", 8, 3, "theme")],
            "negative": [], "neutral": [],
        }
        out = _shipped_regional_low_volume_topics(cm, ["welsh"])
        assert out == []

    def test_skips_welsh_when_tier_is_monitor_only(self):
        # monitor-only is not the exception path; the qualifier is only for
        # low-volume topics that name shipped content.
        cm = {
            "positive": [("Welsh Voice Acting", 4, 1, "monitor-only")],
            "negative": [], "neutral": [],
        }
        out = _shipped_regional_low_volume_topics(cm, ["welsh"])
        assert out == []

    def test_skips_turkish_when_not_in_shipped_tokens(self):
        # Turok-shaped: Turkish low-volume but not in commercial_context.
        cm = {
            "neutral": [("Turkish Language Support", 1, 1, "low-volume")],
            "positive": [], "negative": [],
        }
        # Empty shipped tokens (no SHIPPED REGIONAL CONTENT line) → no pick.
        assert _shipped_regional_low_volume_topics(cm, []) == []
        # Even if Welsh is declared shipped, Turkish on a different game
        # doesn't qualify.
        assert _shipped_regional_low_volume_topics(cm, ["welsh"]) == []

    def test_substring_match_against_label(self):
        # The token matches as a substring against the full topic label so
        # "Community Celebrates Welsh VO" matches the single "welsh" token.
        cm = {
            "positive": [
                ("Community Celebrates Welsh VO Cast", 2, 1, "low-volume"),
            ],
            "negative": [], "neutral": [],
        }
        out = _shipped_regional_low_volume_topics(cm, ["welsh"])
        assert len(out) == 1
        assert out[0][1] == "Community Celebrates Welsh VO Cast"


# ────────────────────────────────────────────────────────────────────────
# §25h: _strip_monitor_only_recs reverts to literal-label-only gate
# ────────────────────────────────────────────────────────────────────────

class TestStripMonitorOnlyRecsLiteralLabels:
    """§25h: _strip_monitor_only_recs drops recs whose text substring-matches
    a monitor-only OR low-volume topic label. The pattern-based narrow-
    audience regex extension (§25g) is removed."""

    def _rec(self, text: str) -> str:
        return f"1. {text}"

    def test_passes_through_when_no_table(self):
        rec = self._rec("Patch **combat bug** [P-001]")
        assert _strip_monitor_only_recs(rec, critical_mass_table=None) == rec

    def test_passes_through_when_table_has_no_sub_theme_labels(self):
        # Only theme-tier topics in the table — nothing to strip.
        cm = {
            "positive": [("Combat Mechanics", 8, 3, "theme")],
            "negative": [], "neutral": [],
        }
        rec = self._rec("Patch **execute animation** [P-011]")
        assert _strip_monitor_only_recs(rec, cm) == rec

    def test_drops_rec_matching_monitor_only_label(self):
        cm = {
            "neutral": [("Game Language Support Questions", 3, 1, "monitor-only")],
            "positive": [], "negative": [],
        }
        rec = self._rec(
            "Clarify Game Language Support Questions roadmap [P-004]"
        )
        out = _strip_monitor_only_recs(rec, cm)
        assert out == "" or out is None

    def test_drops_rec_matching_low_volume_label(self):
        # §25h: low-volume labels are stripped the same way monitor-only are.
        cm = {
            "neutral": [("Turkish Language Support", 1, 1, "low-volume")],
            "positive": [], "negative": [],
        }
        rec = self._rec(
            "Communicate Turkish Language Support timeline [P-004]"
        )
        out = _strip_monitor_only_recs(rec, cm)
        assert out == "" or out is None

    def test_does_NOT_drop_rec_with_unrelated_label_substring(self):
        # §25h: the gate now matches LITERAL topic labels only — no pattern-
        # based regex. A rec mentioning "Turkish" in passing, when there is
        # no Turkish topic in the critical-mass table, MUST survive.
        cm = {
            "positive": [("Combat Mechanics", 8, 3, "theme")],
            "negative": [], "neutral": [],
        }
        rec = self._rec(
            "Clarify localization timeline — multiple language options "
            "including Turkish under review [P-004]"
        )
        # No topic in the table contains the word "Turkish", so the literal-
        # label gate doesn't fire and the rec survives the gate.  The volume
        # gate is what handles the underlying signal-quality question.
        assert _strip_monitor_only_recs(rec, cm) == rec

    def test_renumbers_survivors(self):
        cm = {
            "neutral": [("Turkish Language Support", 1, 1, "low-volume")],
            "positive": [], "negative": [],
        }
        recs = (
            "1. Patch **execute animation collision** [P-011]\n\n"
            "2. Communicate Turkish Language Support roadmap [P-004]\n\n"
            "3. Spotlight **co-op gameplay** [P-005]"
        )
        out = _strip_monitor_only_recs(recs, cm)
        assert out and "Turkish" not in out
        assert "1. Patch" in out
        assert "2. Spotlight" in out


# ────────────────────────────────────────────────────────────────────────
# §22b retry behaviour (unchanged by §25h)
# ────────────────────────────────────────────────────────────────────────

class TestCountValidRecommendations:

    def test_zero_for_none(self):
        assert _count_valid_recommendations(None) == 0
        assert _count_valid_recommendations("") == 0

    def test_zero_for_none_sentinel(self):
        assert _count_valid_recommendations("NONE") == 0

    def test_three_for_three_valid_items(self):
        recs = (
            "1. Patch **Combat Mechanics** -- broken execute animations [P-001]\n\n"
            "2. Amplify **Salamanders Chapter Pack** -- driving positive volume [P-002]\n\n"
            "3. Address **Difficulty & Challenge** -- balance pass needed [P-003]"
        )
        assert _count_valid_recommendations(recs) == 3

    def test_drops_items_without_bold(self):
        recs = (
            "1. Patch Combat Mechanics -- no bold marker here [P-001]\n\n"
            "2. Amplify **Salamanders Chapter Pack** -- valid [P-002]"
        )
        assert _count_valid_recommendations(recs) == 1

    def test_drops_items_without_imperative_verb(self):
        recs = (
            "1. The community is praising **Combat Mechanics** [P-001]\n\n"
            "2. Patch **Combat Mechanics** -- valid [P-002]"
        )
        assert _count_valid_recommendations(recs) == 1


class TestRetryActionsBelowMin:

    def test_no_retry_when_count_at_min(self):
        recs = (
            "1. Patch **a** -- x [P-001]\n\n"
            "2. Amplify **b** -- x [P-002]\n\n"
            "3. Patch **c** -- x [P-003]"
        )
        out = _retry_actions_if_below_min(
            client=None,
            rec_actions=recs,
            total_posts=500,
            game_name="Test Game",
            window_label="x",
            pos_str="", neg_str="", neu_str="",
        )
        assert out == recs

    def test_no_retry_when_total_posts_below_threshold(self):
        recs = "1. Patch **a** -- x [P-001]"
        out = _retry_actions_if_below_min(
            client=None,
            rec_actions=recs,
            total_posts=5,
            game_name="Test Game",
            window_label="x",
            pos_str="", neg_str="", neu_str="",
        )
        assert out == recs

    def test_no_retry_when_no_theme_tier_topics(self):
        """§24e change: retry now fires even without theme tier; the test
        verifies behaviour when the client is None — the retry attempts a
        call, the call fails, we keep the original output."""
        recs = "1. Patch **a** -- x [P-001]"
        out = _retry_actions_if_below_min(
            client=None,
            rec_actions=recs,
            total_posts=500,
            game_name="Test Game",
            window_label="x",
            pos_str="", neg_str="", neu_str="",
            critical_mass_table={
                "positive": [], "negative": [], "neutral": []
            },
        )
        # Retry was attempted (client=None) but fewer items returned, so
        # original is kept.
        assert out == recs

    def test_retry_fires_when_all_three_conditions_met(self):
        recs = "1. Patch **a** -- x [P-001]"
        out = _retry_actions_if_below_min(
            client=None,
            rec_actions=recs,
            total_posts=500,
            game_name="Test Game",
            window_label="x",
            pos_str="", neg_str="", neu_str="",
            critical_mass_table={
                "positive": [], "negative": [("a", 5, 2, "theme")], "neutral": []
            },
        )
        assert out == recs


# ────────────────────────────────────────────────────────────────────────
# §25h: removed-API guard — old §21h helpers are gone
# ────────────────────────────────────────────────────────────────────────

class TestRemovedAPIs:
    """§25h: assert the pattern-based narrow-audience helpers are gone.

    These tests document the API removal so future re-introduction would
    require deliberate action."""

    def test_topic_is_narrow_audience_is_removed(self):
        import services.period_summary_service as svc
        assert not hasattr(svc, "_topic_is_narrow_audience"), (
            "§25h: _topic_is_narrow_audience was removed. Re-introducing "
            "pattern-based narrow-audience demotion requires removing §25h."
        )

    def test_narrow_audience_markers_is_removed(self):
        import services.period_summary_service as svc
        assert not hasattr(svc, "_NARROW_AUDIENCE_MARKERS"), (
            "§25h: _NARROW_AUDIENCE_MARKERS regex was removed."
        )
        assert not hasattr(svc, "_NARROW_AUDIENCE_RE"), (
            "§25h: _NARROW_AUDIENCE_RE compiled regex was removed."
        )

    def test_low_volume_constant_is_set(self):
        # Sanity: the new volume threshold constant is in place.
        assert _LOW_VOLUME_WEIGHT_MAX == 2
