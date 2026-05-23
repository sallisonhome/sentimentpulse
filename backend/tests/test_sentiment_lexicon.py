"""
Tests for §18 Layer 4 — gaming-domain lexicon overlay.

Covers:
  - YAML loading: valid config, invalid config (missing required fields, bad
    regex), empty config
  - Rule predicates: each predicate type tested in isolation
  - Combined predicates (AND logic)
  - Priority ordering: high-priority rule wins over low-priority
  - applied_rules list captures all matching rules even when only one changes label
  - reload_rules() works
  - Gate interaction: lexicon does NOT override language gate or low-signal gate
  - Idempotency: no-match post returns identical dict

≥ 25 distinct test cases as required.
"""
import re
import textwrap
from pathlib import Path

import pytest
import yaml


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _make_current(
    label="neutral",
    score=0.5,
    signal_quality="high",
    language="en",
    original_label=None,
    sentiment_conflict=False,
):
    """Return a minimal §18 v2 result dict."""
    return {
        "label": label,
        "score": score,
        "signal_quality": signal_quality,
        "language": language,
        "original_label": original_label,
        "sentiment_conflict": sentiment_conflict,
    }


def _minimal_yaml(rules_yaml: str) -> str:
    """Wrap a pre-formatted rules list string in a minimal valid YAML config."""
    return f"version: 1\ndescription: test config\nrules:\n{rules_yaml}"


# ─────────────────────────────────────────────────────────────────────────────
# YAML loading
# ─────────────────────────────────────────────────────────────────────────────

class TestLoadRules:

    def test_load_valid_config_returns_rules(self, tmp_path):
        """A valid YAML with one rule loads successfully."""
        from services.sentiment_lexicon import load_rules
        yaml_text = textwrap.dedent("""\
            version: 1
            description: test config
            rules:
              - id: test_rule_1
                description: test
                priority: 90
                when:
                  body_contains_any: [bug, crash]
                set:
                  label: negative
                  score: 0.85
                  reason: test
        """)
        p = tmp_path / "rules.yaml"
        p.write_text(yaml_text)
        rules = load_rules(p)
        assert len(rules) == 1
        assert rules[0].id == "test_rule_1"

    def test_load_empty_rules_list(self, tmp_path):
        """An empty rules list is valid and returns []."""
        from services.sentiment_lexicon import load_rules
        p = tmp_path / "rules.yaml"
        p.write_text("version: 1\ndescription: empty\nrules: []\n")
        rules = load_rules(p)
        assert rules == []

    def test_load_file_not_found_raises(self, tmp_path):
        """Non-existent file raises FileNotFoundError."""
        from services.sentiment_lexicon import load_rules
        with pytest.raises(FileNotFoundError):
            load_rules(tmp_path / "nonexistent.yaml")

    def test_load_missing_version_raises(self, tmp_path):
        """Config missing 'version' field raises ValueError."""
        from services.sentiment_lexicon import load_rules
        p = tmp_path / "rules.yaml"
        p.write_text("description: no version\nrules: []\n")
        with pytest.raises(ValueError, match="version"):
            load_rules(p)

    def test_load_missing_id_raises(self, tmp_path):
        """Rule without 'id' field raises ValueError."""
        from services.sentiment_lexicon import load_rules
        yaml_text = textwrap.dedent("""\
            version: 1
            rules:
              - description: no id
                priority: 90
                when:
                  body_contains_any: [bug]
                set:
                  label: negative
                  score: 0.85
                  reason: test
        """)
        p = tmp_path / "rules.yaml"
        p.write_text(yaml_text)
        with pytest.raises(ValueError, match="id"):
            load_rules(p)

    def test_load_missing_when_raises(self, tmp_path):
        """Rule without 'when' raises ValueError."""
        from services.sentiment_lexicon import load_rules
        yaml_text = textwrap.dedent("""\
            version: 1
            rules:
              - id: no_when_rule
                description: missing when
                set:
                  label: negative
                  score: 0.85
                  reason: test
        """)
        p = tmp_path / "rules.yaml"
        p.write_text(yaml_text)
        with pytest.raises(ValueError, match="when"):
            load_rules(p)

    def test_load_missing_set_raises(self, tmp_path):
        """Rule without 'set' raises ValueError."""
        from services.sentiment_lexicon import load_rules
        yaml_text = textwrap.dedent("""\
            version: 1
            rules:
              - id: no_set_rule
                description: missing set
                when:
                  body_contains_any: [bug]
        """)
        p = tmp_path / "rules.yaml"
        p.write_text(yaml_text)
        with pytest.raises(ValueError, match="set"):
            load_rules(p)

    def test_load_bad_regex_raises(self, tmp_path):
        """Rule with an invalid regex in title_matches_any raises ValueError."""
        from services.sentiment_lexicon import load_rules
        yaml_text = textwrap.dedent("""\
            version: 1
            rules:
              - id: bad_regex_rule
                description: bad regex
                when:
                  title_matches_any:
                    - "(?i)[invalid regex (("
                set:
                  label: negative
                  score: 0.80
                  reason: test
        """)
        p = tmp_path / "rules.yaml"
        p.write_text(yaml_text)
        with pytest.raises(ValueError, match="invalid regex|bad regex|regex"):
            load_rules(p)

    def test_load_rules_sorted_by_priority_descending(self, tmp_path):
        """Rules are returned sorted by priority descending."""
        from services.sentiment_lexicon import load_rules
        yaml_text = textwrap.dedent("""\
            version: 1
            rules:
              - id: low_prio
                description: low
                priority: 50
                when:
                  body_contains_any: [x]
                set:
                  label: positive
                  score: 0.85
                  reason: low
              - id: high_prio
                description: high
                priority: 200
                when:
                  body_contains_any: [x]
                set:
                  label: negative
                  score: 0.85
                  reason: high
              - id: mid_prio
                description: mid
                priority: 100
                when:
                  body_contains_any: [x]
                set:
                  label: neutral
                  score: 0.5
                  reason: mid
        """)
        p = tmp_path / "rules.yaml"
        p.write_text(yaml_text)
        rules = load_rules(p)
        priorities = [r.priority for r in rules]
        assert priorities == sorted(priorities, reverse=True)
        assert rules[0].id == "high_prio"

    def test_load_default_priority_100(self, tmp_path):
        """Rule without explicit priority defaults to 100."""
        from services.sentiment_lexicon import load_rules
        yaml_text = textwrap.dedent("""\
            version: 1
            rules:
              - id: default_prio
                description: test
                when:
                  body_contains_any: [bug]
                set:
                  label: negative
                  score: 0.85
                  reason: test
        """)
        p = tmp_path / "rules.yaml"
        p.write_text(yaml_text)
        rules = load_rules(p)
        assert rules[0].priority == 100


# ─────────────────────────────────────────────────────────────────────────────
# Individual predicate tests
# ─────────────────────────────────────────────────────────────────────────────

class TestPredicates:
    """Unit tests for each predicate type in isolation."""

    def _make_rule(self, rule_id, when_block, set_block=None):
        """Helper: build a Rule directly without YAML."""
        from services.sentiment_lexicon import Rule
        if set_block is None:
            set_block = {"label": "negative", "score": 0.85, "reason": "test"}
        return Rule(id=rule_id, description="test", priority=100,
                    when=when_block, set_=set_block)

    # ── body_term_count ───────────────────────────────────────────────────────

    def test_body_term_count_fires_when_threshold_met(self):
        rule = self._make_rule("r1", {
            "body_term_count": {"terms": ["bug", "crash", "broken"], "min": 2}
        })
        assert rule.matches("", "game has bug and crash")

    def test_body_term_count_does_not_fire_below_threshold(self):
        rule = self._make_rule("r1", {
            "body_term_count": {"terms": ["bug", "crash", "broken"], "min": 2}
        })
        assert not rule.matches("", "game has a bug")  # only 1 term

    def test_body_term_count_case_insensitive(self):
        rule = self._make_rule("r1", {
            "body_term_count": {"terms": ["Bug", "CRASH", "Broken"], "min": 2}
        })
        assert rule.matches("", "There is a BUG and a crash in the game")

    def test_body_term_count_multi_word_term(self):
        """Multi-word terms like 'doesn't work' should match as substrings."""
        rule = self._make_rule("r1", {
            "body_term_count": {
                "terms": ["doesn't work", "cant play", "broken"],
                "min": 2,
            }
        })
        assert rule.matches("", "the game doesn't work and is broken")

    def test_body_term_count_each_term_counts_once(self):
        """Even if 'bug' appears 5 times, it still counts as 1 distinct term."""
        rule = self._make_rule("r1", {
            "body_term_count": {"terms": ["bug", "crash"], "min": 2}
        })
        # Only "bug" present, 3 times — still only 1 distinct term
        assert not rule.matches("", "bug bug bug everywhere")

    # ── title_matches_any (regex) ─────────────────────────────────────────────

    def test_title_matches_any_fires_on_match(self):
        rule = self._make_rule("r2", {
            "title_matches_any": [r"(?i)did.*(break|broke)"]
        })
        assert rule.matches("Did the patch break everything?", "body here")

    def test_title_matches_any_no_match_returns_false(self):
        rule = self._make_rule("r2", {
            "title_matches_any": [r"(?i)did.*(break|broke)"]
        })
        assert not rule.matches("Amazing new update dropped!", "body here")

    def test_title_matches_any_case_insensitive_flag(self):
        rule = self._make_rule("r2", {
            "title_matches_any": [r"(?i)is this a joke"]
        })
        assert rule.matches("IS THIS A JOKE?!", "body here")

    # ── title_contains_any (literal) ─────────────────────────────────────────

    def test_title_contains_any_fires(self):
        rule = self._make_rule("r3", {
            "title_contains_any": ["❤️", "🔥"]
        })
        assert rule.matches("Love this game ❤️", "body")

    def test_title_contains_any_no_match(self):
        rule = self._make_rule("r3", {
            "title_contains_any": ["❤️", "🔥"]
        })
        assert not rule.matches("Normal title", "body")

    def test_title_contains_any_case_insensitive(self):
        rule = self._make_rule("r3", {
            "title_contains_any": ["amazing"]
        })
        assert rule.matches("AMAZING game!", "body")

    # ── body_contains_any ─────────────────────────────────────────────────────

    def test_body_contains_any_fires(self):
        rule = self._make_rule("r4", {
            "body_contains_any": ["refund", "uninstalled"]
        })
        assert rule.matches("title", "I want a refund for this game")

    def test_body_contains_any_no_match(self):
        rule = self._make_rule("r4", {
            "body_contains_any": ["refund", "uninstalled"]
        })
        assert not rule.matches("title", "Great game, highly recommended")

    # ── text_matches_any (regex against title+body) ───────────────────────────

    def test_text_matches_any_fires_on_body(self):
        rule = self._make_rule("r5", {
            "text_matches_any": [r"(?i)thanks.*(devs?|developers?)"]
        })
        assert rule.matches("normal title", "thanks devs for ruining the game")

    def test_text_matches_any_fires_on_title(self):
        rule = self._make_rule("r5", {
            "text_matches_any": [r"(?i)\b10\s*/\s*10\b"]
        })
        assert rule.matches("10/10 game of the year", "great body")

    def test_text_matches_any_no_match(self):
        rule = self._make_rule("r5", {
            "text_matches_any": [r"(?i)\b10\s*/\s*10\b"]
        })
        assert not rule.matches("This game is alright", "body text here")

    # ── text_contains_any (literal against title+body) ───────────────────────

    def test_text_contains_any_fires(self):
        rule = self._make_rule("r6", {
            "text_contains_any": ["garbage", "trash"]
        })
        assert rule.matches("what is this garbage", "body")

    def test_text_contains_any_case_insensitive(self):
        rule = self._make_rule("r6", {
            "text_contains_any": ["garbage"]
        })
        assert rule.matches("title", "This game is complete GARBAGE")

    # ── title_ends_with ───────────────────────────────────────────────────────

    def test_title_ends_with_fires(self):
        rule = self._make_rule("r7", {
            "title_ends_with": "?"
        })
        assert rule.matches("Did this update break everything?", "body")

    def test_title_ends_with_no_match(self):
        rule = self._make_rule("r7", {
            "title_ends_with": "?"
        })
        assert not rule.matches("Statement title without punctuation", "body")

    def test_title_ends_with_trailing_whitespace_stripped(self):
        """title.rstrip() is used so trailing spaces don't block the match."""
        rule = self._make_rule("r7", {"title_ends_with": "?"})
        assert rule.matches("Did it break?   ", "body")

    # ── body_min_chars ────────────────────────────────────────────────────────

    def test_body_min_chars_fires(self):
        rule = self._make_rule("r8", {"body_min_chars": 80})
        assert rule.matches("title", "x" * 80)

    def test_body_min_chars_does_not_fire_below_threshold(self):
        rule = self._make_rule("r8", {"body_min_chars": 80})
        assert not rule.matches("title", "x" * 79)

    # ── body_max_chars ────────────────────────────────────────────────────────

    def test_body_max_chars_fires(self):
        rule = self._make_rule("r9", {"body_max_chars": 200})
        assert rule.matches("title", "x" * 100)

    def test_body_max_chars_does_not_fire_above_threshold(self):
        rule = self._make_rule("r9", {"body_max_chars": 200})
        assert not rule.matches("title", "x" * 201)


# ─────────────────────────────────────────────────────────────────────────────
# Combined predicates (AND logic)
# ─────────────────────────────────────────────────────────────────────────────

class TestCombinedPredicates:

    def _make_rule(self, rule_id, when_block):
        from services.sentiment_lexicon import Rule
        return Rule(id=rule_id, description="test", priority=100,
                    when=when_block, set_={"label": "negative", "score": 0.85, "reason": "x"})

    def test_all_predicates_match_returns_true(self):
        """All three predicates satisfied → rule fires."""
        rule = self._make_rule("combo", {
            "title_ends_with": "?",
            "body_min_chars": 80,
            "body_contains_any": ["bug"],
        })
        body = "There are bugs everywhere and the game is completely broken " + "x" * 80
        assert rule.matches("Did the patch break it?", body)

    def test_one_predicate_fails_returns_false(self):
        """If even one predicate fails, the rule does not fire."""
        rule = self._make_rule("combo", {
            "title_ends_with": "?",
            "body_min_chars": 80,
            "body_contains_any": ["bug"],
        })
        # body_contains_any fails — no 'bug' in body
        body = "There are crashes everywhere but nothing else mentioned " + "x" * 80
        assert not rule.matches("Did the patch break it?", body)

    def test_title_regex_and_body_contains_combined(self):
        """title_matches_any AND body_contains_any must both fire."""
        rule = self._make_rule("combo2", {
            "title_matches_any": [r"(?i)did.*(break|broke)"],
            "body_contains_any": ["unplayable"],
        })
        assert rule.matches("Did the patch just break everything?",
                            "The game is completely unplayable now.")
        # Body doesn't contain 'unplayable' → False
        assert not rule.matches("Did the patch just break everything?",
                                "I have some concerns about the update.")


# ─────────────────────────────────────────────────────────────────────────────
# apply_lexicon_rules
# ─────────────────────────────────────────────────────────────────────────────

class TestApplyLexiconRules:

    def _make_rule(self, rule_id, when_block, set_block, priority=100):
        from services.sentiment_lexicon import Rule
        return Rule(id=rule_id, description="test", priority=priority,
                    when=when_block, set_=set_block)

    def test_no_rule_fires_returns_identical_dict(self):
        """When no rules match, applied_rules=[] but result is otherwise identical."""
        from services.sentiment_lexicon import apply_lexicon_rules
        current = {
            "label": "neutral",
            "score": 0.5,
            "signal_quality": "high",
            "language": "en",
            "original_label": "positive",
            "sentiment_conflict": False,
        }
        rules = []  # No rules
        result = apply_lexicon_rules("nice title", "nice body", current, rules)
        assert result["label"] == "neutral"
        assert result["score"] == 0.5
        assert result["applied_rules"] == []
        assert result["signal_quality"] == "high"

    def test_rule_fires_overrides_label_and_score(self):
        """When a rule matches, label and score are overridden."""
        from services.sentiment_lexicon import apply_lexicon_rules
        rule = self._make_rule("r1",
            when_block={"body_contains_any": ["refund"]},
            set_block={"label": "negative", "score": 0.85, "reason": "refund"}
        )
        current = {"label": "positive", "score": 0.90, "signal_quality": "high",
                   "language": "en", "original_label": None, "sentiment_conflict": False}
        result = apply_lexicon_rules("great game?", "I want a refund", current, [rule])
        assert result["label"] == "negative"
        assert result["score"] == 0.85
        assert result["applied_rules"] == ["r1"]

    def test_signal_quality_and_language_preserved(self):
        """Pre-lexicon signal_quality, language, etc. are preserved after override."""
        from services.sentiment_lexicon import apply_lexicon_rules
        rule = self._make_rule("r1",
            when_block={"body_contains_any": ["refund"]},
            set_block={"label": "negative", "score": 0.85, "reason": "refund"}
        )
        current = {"label": "positive", "score": 0.75, "signal_quality": "medium",
                   "language": "en", "original_label": None, "sentiment_conflict": True}
        result = apply_lexicon_rules("title", "I need a refund", current, [rule])
        assert result["signal_quality"] == "medium"
        assert result["language"] == "en"
        assert result["sentiment_conflict"] is True

    def test_language_gate_skips_lexicon(self):
        """Non-English post: lexicon is NOT applied."""
        from services.sentiment_lexicon import apply_lexicon_rules
        rule = self._make_rule("r1",
            when_block={"body_contains_any": ["refund"]},
            set_block={"label": "negative", "score": 0.85, "reason": "refund"}
        )
        current = {"label": "neutral", "score": 0.5, "signal_quality": "high",
                   "language": "ru", "original_label": None, "sentiment_conflict": False}
        result = apply_lexicon_rules("title", "I need a refund", current, [rule])
        # Language gate should block the lexicon — return original unchanged
        assert result["label"] == "neutral"
        assert "applied_rules" not in result  # gate blocked, no lexicon fields added

    def test_low_signal_gate_skips_lexicon(self):
        """Low-signal post: lexicon is NOT applied."""
        from services.sentiment_lexicon import apply_lexicon_rules
        rule = self._make_rule("r1",
            when_block={"body_contains_any": ["refund"]},
            set_block={"label": "negative", "score": 0.85, "reason": "refund"}
        )
        current = {"label": "neutral", "score": 0.5, "signal_quality": "low",
                   "language": "en", "original_label": None, "sentiment_conflict": False}
        result = apply_lexicon_rules("title", "I need a refund", current, [rule])
        # Low-signal gate should block the lexicon
        assert result["label"] == "neutral"
        assert "applied_rules" not in result

    def test_priority_ordering_high_prio_wins(self):
        """When two rules match, higher priority wins for label override."""
        from services.sentiment_lexicon import apply_lexicon_rules
        low_prio = self._make_rule("low",
            when_block={"body_contains_any": ["bug"]},
            set_block={"label": "positive", "score": 0.85, "reason": "low"},
            priority=50
        )
        high_prio = self._make_rule("high",
            when_block={"body_contains_any": ["bug"]},
            set_block={"label": "negative", "score": 0.90, "reason": "high"},
            priority=200
        )
        # List in descending priority order (as load_rules returns them)
        rules = [high_prio, low_prio]
        current = {"label": "neutral", "score": 0.5, "signal_quality": "high",
                   "language": "en", "original_label": None, "sentiment_conflict": False}
        result = apply_lexicon_rules("title", "game has bugs", current, rules)
        assert result["label"] == "negative"  # high_prio wins
        assert result["score"] == 0.90

    def test_all_matching_rules_recorded_in_applied_rules(self):
        """ALL matching rules are in applied_rules even though only one overrides."""
        from services.sentiment_lexicon import apply_lexicon_rules
        r1 = self._make_rule("r1",
            when_block={"body_contains_any": ["bug"]},
            set_block={"label": "negative", "score": 0.85, "reason": "r1"},
            priority=100
        )
        r2 = self._make_rule("r2",
            when_block={"body_contains_any": ["crash"]},
            set_block={"label": "negative", "score": 0.80, "reason": "r2"},
            priority=50
        )
        rules = [r1, r2]  # r1 first (higher priority)
        current = {"label": "positive", "score": 0.90, "signal_quality": "high",
                   "language": "en", "original_label": None, "sentiment_conflict": False}
        result = apply_lexicon_rules("title", "game has bug and crash everywhere", current, rules)
        assert "r1" in result["applied_rules"]
        assert "r2" in result["applied_rules"]
        assert len(result["applied_rules"]) == 2
        # r1 wins (higher priority)
        assert result["label"] == "negative"
        assert result["score"] == 0.85


# ─────────────────────────────────────────────────────────────────────────────
# reload_rules
# ─────────────────────────────────────────────────────────────────────────────

class TestReloadRules:

    def test_reload_rules_updates_cache(self, tmp_path, monkeypatch):
        """reload_rules() picks up changes from disk."""
        import services.sentiment_lexicon as lex

        yaml_v1 = textwrap.dedent("""\
            version: 1
            description: v1
            rules:
              - id: v1_rule
                description: first version
                when:
                  body_contains_any: [bug]
                set:
                  label: negative
                  score: 0.85
                  reason: v1
        """)
        yaml_v2 = textwrap.dedent("""\
            version: 1
            description: v2
            rules:
              - id: v2_rule
                description: second version
                when:
                  body_contains_any: [crash]
                set:
                  label: negative
                  score: 0.90
                  reason: v2
        """)
        p = tmp_path / "rules.yaml"
        p.write_text(yaml_v1)

        # Load v1
        rules_v1 = lex.reload_rules(p)
        assert any(r.id == "v1_rule" for r in rules_v1)

        # Overwrite file on disk with v2
        p.write_text(yaml_v2)

        # reload_rules should pick up v2
        rules_v2 = lex.reload_rules(p)
        assert any(r.id == "v2_rule" for r in rules_v2)
        assert not any(r.id == "v1_rule" for r in rules_v2)

    def test_reload_updates_module_cache(self, tmp_path, monkeypatch):
        """After reload_rules(), _get_rules() returns the new rules."""
        import services.sentiment_lexicon as lex

        yaml_text = textwrap.dedent("""\
            version: 1
            rules:
              - id: cached_rule
                description: test
                when:
                  body_contains_any: [test]
                set:
                  label: negative
                  score: 0.85
                  reason: test
        """)
        p = tmp_path / "rules.yaml"
        p.write_text(yaml_text)

        lex.reload_rules(p)
        cached = lex._get_rules()
        assert any(r.id == "cached_rule" for r in cached)


# ─────────────────────────────────────────────────────────────────────────────
# Real YAML config smoke test
# ─────────────────────────────────────────────────────────────────────────────

class TestRealYAMLConfig:
    """Verify the production rules.yaml loads and rules fire correctly."""

    @pytest.fixture
    def real_rules(self):
        """Load the actual production rules.yaml."""
        from services.sentiment_lexicon import load_rules
        return load_rules()

    def test_real_config_loads_without_error(self, real_rules):
        """Production rules.yaml loads without errors."""
        assert len(real_rules) > 0

    def test_bug_list_rule_present(self, real_rules):
        """bug_list_force_negative rule is present."""
        ids = [r.id for r in real_rules]
        assert "bug_list_force_negative" in ids

    def test_rhetorical_break_question_rule_present(self, real_rules):
        """rhetorical_break_question rule is present."""
        ids = [r.id for r in real_rules]
        assert "rhetorical_break_question" in ids

    def test_bug_list_fires_on_3_plus_terms(self, real_rules):
        """bug_list_force_negative fires when body has 3+ bug terms."""
        from services.sentiment_lexicon import apply_lexicon_rules
        body = "This is bugged, the game keeps crashing and it's completely broken"
        current = _make_current(label="positive", score=0.85)
        result = apply_lexicon_rules("Great patch!", body, current, real_rules)
        assert result["label"] == "negative"
        assert "bug_list_force_negative" in result["applied_rules"]

    def test_refund_signal_fires(self, real_rules):
        """refund_signal fires when body contains 'refund'."""
        from services.sentiment_lexicon import apply_lexicon_rules
        current = _make_current(label="positive", score=0.90)
        result = apply_lexicon_rules(
            "I liked this game", "I'm requesting a refund for this game", current, real_rules
        )
        assert result["label"] == "negative"
        assert "refund_signal" in result["applied_rules"]

    def test_praise_emoji_rule_fires(self, real_rules):
        """praise_emoji_plus_confirmation fires with emoji title + praise body."""
        from services.sentiment_lexicon import apply_lexicon_rules
        current = _make_current(label="neutral", score=0.5)
        result = apply_lexicon_rules(
            "This game is ❤️", "I absolutely love this game, it's perfect and amazing",
            current, real_rules
        )
        assert result["label"] == "positive"
        assert "praise_emoji_plus_confirmation" in result["applied_rules"]

    def test_10_out_of_10_fires(self, real_rules):
        """10_out_of_10 rule fires on '10/10' text."""
        from services.sentiment_lexicon import apply_lexicon_rules
        current = _make_current(label="neutral", score=0.5)
        result = apply_lexicon_rules(
            "10/10 best game I have ever played", "Incredible experience overall",
            current, real_rules
        )
        assert result["label"] == "positive"
        assert "10_out_of_10" in result["applied_rules"]
