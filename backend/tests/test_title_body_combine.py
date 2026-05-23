"""
Tests for §18 PR #10 — Layer 2 (title/body separation) and Layer 3
(confidence floor).

Covers:
  - is_rhetorical_question()
  - combine_title_body()
  - apply_confidence_floor()

≥ 15 distinct test cases as required.
"""
import pytest


# ─────────────────────────────────────────────────────────────────────────────
# is_rhetorical_question
# ─────────────────────────────────────────────────────────────────────────────

class TestIsRhetoricalQuestion:

    def test_question_title_long_body_returns_true(self):
        """Title ends with '?' AND body >= 100 chars → True."""
        from services.sentiment_gate import is_rhetorical_question
        title = "So did the patch just straight up break more than it fixed?"
        body = "a" * 100  # exactly 100 chars
        assert is_rhetorical_question(title, body) is True

    def test_question_title_body_over_100_chars(self):
        """Real-world-length body with '?' title → True."""
        from services.sentiment_gate import is_rhetorical_question
        title = "Why is the performance so bad after the update?"
        body = (
            "I cannot get above 30 fps since the last patch. "
            "Settings are all the same as before. GPU is fine. "
            "This is completely unplayable. What happened?"
        )
        assert len(body) >= 100
        assert is_rhetorical_question(title, body) is True

    def test_question_title_short_body_returns_false(self):
        """Title ends with '?' but body < 100 chars → False."""
        from services.sentiment_gate import is_rhetorical_question
        title = "Is this game worth buying?"
        body = "Just curious."  # << 100 chars
        assert is_rhetorical_question(title, body) is False

    def test_question_title_exactly_99_char_body_returns_false(self):
        """Body of exactly 99 chars is below the 100-char threshold → False."""
        from services.sentiment_gate import is_rhetorical_question
        title = "Did they fix the crash?"
        body = "x" * 99
        assert is_rhetorical_question(title, body) is False

    def test_no_question_mark_long_body_returns_false(self):
        """Title does NOT end with '?' → False even with long body."""
        from services.sentiment_gate import is_rhetorical_question
        title = "The new patch broke everything"
        body = "b" * 200
        assert is_rhetorical_question(title, body) is False

    def test_empty_title_returns_false(self):
        """Empty title → does not end with '?' → False."""
        from services.sentiment_gate import is_rhetorical_question
        assert is_rhetorical_question("", "x" * 200) is False

    def test_empty_body_returns_false(self):
        """Empty body → length 0 < 100 → False."""
        from services.sentiment_gate import is_rhetorical_question
        title = "Is the game good?"
        assert is_rhetorical_question(title, "") is False

    def test_title_ends_with_question_mark_after_strip(self):
        """Title with trailing whitespace: strip() then check ending '?'."""
        from services.sentiment_gate import is_rhetorical_question
        title = "Is this game worth playing?   "  # trailing spaces
        body = "c" * 150
        assert is_rhetorical_question(title, body) is True


# ─────────────────────────────────────────────────────────────────────────────
# combine_title_body
# ─────────────────────────────────────────────────────────────────────────────

class TestCombineTitleBody:

    def test_matching_labels_returns_min_score_no_conflict(self):
        """Both positive → min(title_score, body_score), no conflict."""
        from services.sentiment_gate import combine_title_body
        label, score, conflict = combine_title_body(
            "positive", 0.85,
            "positive", 0.75,
            "Great update!", "This is a really solid improvement to the game.",
        )
        assert label == "positive"
        assert abs(score - 0.75) < 1e-9  # min of (0.85, 0.75)
        assert conflict is False

    def test_matching_negative_labels_min_score(self):
        """Both negative → min score used."""
        from services.sentiment_gate import combine_title_body
        label, score, conflict = combine_title_body(
            "negative", 0.90,
            "negative", 0.80,
            "Terrible patch.", "The framerate dropped and crashes are constant now.",
        )
        assert label == "negative"
        assert abs(score - 0.80) < 1e-9
        assert conflict is False

    def test_matching_neutral_labels_min_score(self):
        """Both neutral → min score used."""
        from services.sentiment_gate import combine_title_body
        label, score, conflict = combine_title_body(
            "neutral", 0.72,
            "neutral", 0.78,
            "Patch notes are out.", "Here are the patch notes for today.",
        )
        assert label == "neutral"
        assert abs(score - 0.72) < 1e-9
        assert conflict is False

    def test_disagreement_rhetorical_question_body_wins_no_conflict(self):
        """
        Title positive, body negative, rhetorical question → body wins, no conflict.
        Regression case: "So did the patch just straight up break more than it fixed?"
        with bug-list body → must classify as negative, not positive.
        """
        from services.sentiment_gate import combine_title_body
        title = "So did the patch just straight up break more than it fixed?"
        body = (
            "List of things broken since the update: "
            "1. Audio is completely missing in combat. "
            "2. The save system corrupts files randomly. "
            "3. Enemy AI is completely broken and non-functional. "
            "4. Framerate issues are worse than ever."
        )
        assert len(body) >= 100
        label, score, conflict = combine_title_body(
            "positive", 0.75,
            "negative", 0.82,
            title, body,
        )
        assert label == "negative"
        assert abs(score - 0.82) < 1e-9
        assert conflict is False  # rhetorical — no conflict flag

    def test_disagreement_no_rhetorical_body_wins_conflict_flagged(self):
        """
        Title positive, body negative, non-rhetorical → body wins, score capped,
        conflict flag = True.
        """
        from services.sentiment_gate import combine_title_body
        title = "The game just got a big update"
        body = (
            "Unfortunately the update introduced more bugs than it fixed. "
            "Performance is worse and the developers seem unresponsive."
        )
        label, score, conflict = combine_title_body(
            "positive", 0.80,
            "negative", 0.78,
            title, body,
        )
        assert label == "negative"
        assert score <= 0.65
        assert conflict is True

    def test_disagreement_no_rhetorical_score_capped_at_065(self):
        """When labels disagree (no rhetorical), body score > 0.65 → capped at 0.65."""
        from services.sentiment_gate import combine_title_body
        title = "Amazing looking game."
        body = (
            "Really disappointing experience — the combat is terrible, "
            "the story is incoherent, and the performance tanks constantly."
        )
        label, score, conflict = combine_title_body(
            "positive", 0.85,
            "negative", 0.90,  # high body score — must be capped
            title, body,
        )
        assert label == "negative"
        assert score == 0.65  # min(0.90, 0.65) = 0.65
        assert conflict is True

    def test_disagreement_no_rhetorical_body_score_below_065_not_raised(self):
        """When labels disagree (no rhetorical), body score < 0.65 → kept as-is."""
        from services.sentiment_gate import combine_title_body
        title = "Nice looking game."
        body = (
            "But actually it has a lot of disappointing bugs and issues "
            "that make it quite frustrating to play through."
        )
        label, score, conflict = combine_title_body(
            "positive", 0.80,
            "negative", 0.55,  # below cap — must not be raised to 0.65
            title, body,
        )
        assert label == "negative"
        assert score == 0.55
        assert conflict is True

    def test_rhetorical_no_score_cap(self):
        """Rhetorical question path should NOT cap the body score at 0.65."""
        from services.sentiment_gate import combine_title_body
        title = "Can they even fix this disaster?"
        body = "x" * 150  # long body, but the content is neutral
        label, score, conflict = combine_title_body(
            "positive", 0.70,
            "negative", 0.88,
            title, body,
        )
        assert label == "negative"
        assert abs(score - 0.88) < 1e-9  # no cap
        assert conflict is False

    def test_returns_three_tuple(self):
        """combine_title_body always returns a 3-tuple."""
        from services.sentiment_gate import combine_title_body
        result = combine_title_body(
            "positive", 0.80, "positive", 0.80, "Title.", "Body text here."
        )
        assert isinstance(result, tuple)
        assert len(result) == 3


# ─────────────────────────────────────────────────────────────────────────────
# apply_confidence_floor
# ─────────────────────────────────────────────────────────────────────────────

class TestApplyConfidenceFloor:

    def test_positive_above_threshold_unchanged(self):
        """Positive with score ≥ 0.70 → unchanged, original_label=None."""
        from services.sentiment_gate import apply_confidence_floor
        label, score, original = apply_confidence_floor("positive", 0.80)
        assert label == "positive"
        assert abs(score - 0.80) < 1e-9
        assert original is None

    def test_positive_at_exact_threshold_unchanged(self):
        """Score exactly 0.70 → NOT demoted (threshold is exclusive below)."""
        from services.sentiment_gate import apply_confidence_floor
        label, score, original = apply_confidence_floor("positive", 0.70)
        assert label == "positive"
        assert abs(score - 0.70) < 1e-9
        assert original is None

    def test_positive_below_threshold_demoted_to_neutral(self):
        """Positive with score < 0.70 → demoted to neutral, original_label recorded."""
        from services.sentiment_gate import apply_confidence_floor
        label, score, original = apply_confidence_floor("positive", 0.65)
        assert label == "neutral"
        assert abs(score - 0.5) < 1e-9
        assert original == "positive"

    def test_negative_below_threshold_demoted(self):
        """Negative with score < 0.70 → demoted to neutral."""
        from services.sentiment_gate import apply_confidence_floor
        label, score, original = apply_confidence_floor("negative", 0.60)
        assert label == "neutral"
        assert score == 0.5
        assert original == "negative"

    def test_neutral_input_never_demoted(self):
        """Neutral input with any score → never demoted (already neutral)."""
        from services.sentiment_gate import apply_confidence_floor
        # Even with a score below threshold, neutral stays neutral
        label, score, original = apply_confidence_floor("neutral", 0.50)
        assert label == "neutral"
        assert abs(score - 0.50) < 1e-9
        assert original is None

    def test_neutral_low_score_unchanged(self):
        """Neutral with score 0.1 → unchanged (rule only applies to non-neutral)."""
        from services.sentiment_gate import apply_confidence_floor
        label, score, original = apply_confidence_floor("neutral", 0.10)
        assert label == "neutral"
        assert original is None

    def test_custom_threshold_respected(self):
        """Custom threshold parameter is used instead of default 0.70."""
        from services.sentiment_gate import apply_confidence_floor
        # With threshold=0.80, score=0.75 should be demoted
        label, score, original = apply_confidence_floor("positive", 0.75, threshold=0.80)
        assert label == "neutral"
        assert original == "positive"
        # With threshold=0.60, score=0.65 should not be demoted
        label2, score2, original2 = apply_confidence_floor("positive", 0.65, threshold=0.60)
        assert label2 == "positive"
        assert original2 is None

    def test_returns_three_tuple(self):
        """apply_confidence_floor always returns a 3-tuple."""
        from services.sentiment_gate import apply_confidence_floor
        result = apply_confidence_floor("positive", 0.8)
        assert isinstance(result, tuple)
        assert len(result) == 3

    def test_score_069_just_below_threshold_demoted(self):
        """Score 0.699... is strictly below 0.70 → demoted."""
        from services.sentiment_gate import apply_confidence_floor
        label, score, original = apply_confidence_floor("negative", 0.699)
        assert label == "neutral"
        assert original == "negative"

    def test_score_071_just_above_threshold_not_demoted(self):
        """Score 0.701 is above 0.70 → not demoted."""
        from services.sentiment_gate import apply_confidence_floor
        label, score, original = apply_confidence_floor("positive", 0.701)
        assert label == "positive"
        assert original is None
