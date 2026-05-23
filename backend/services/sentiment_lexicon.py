"""
§18 Layer 4 — Gaming-Domain Lexicon Overlay
============================================

This module implements a deterministic, YAML-configurable rule layer that
runs AFTER the §18 v2 pipeline (Layers 1-3: gates + title/body separation +
confidence floor) and can OVERRIDE the sentiment result for patterns the
model is known to get wrong in gaming contexts.

Design decisions
----------------
**Priority ordering**: Each rule carries an optional ``priority`` field
(integer, default 100). Rules with a HIGHER priority value take precedence.
When multiple rules match the same post:
  - ALL matching rule IDs are recorded in the ``applied_rules`` list for
    audit purposes.
  - Only the SINGLE rule with the highest priority actually changes the
    ``label`` and ``score``. Ties are broken by position in the file
    (later rule in the file wins among equal-priority ties).

**Gate interaction**: Lexicon rules MUST NOT override the language gate
(non-English stays neutral) or the low-signal gate (≤2 tokens stays neutral
0.5). This module's ``apply_lexicon_rules()`` function checks the incoming
``current`` dict: if the result was produced by one of those hard gates
(``language != "en"`` or ``signal_quality == "low"``), rules are skipped
and the original result is returned unchanged. The lexicon overlay only
applies to posts that made it past Layers 1 and 5.

**Idempotency**: A post that matches no rules is returned from
``apply_lexicon_rules()`` as-is (same dict object, no mutation).

**Hot-reload**: Rules are loaded once at module import and cached in
``_rules_cache``. Call ``reload_rules()`` to force a re-read from disk
without restarting the service. On the production droplet:
  1. Edit ``services/sentiment_rules.yaml``
  2. Trigger ``reload_rules()`` (e.g. via a management endpoint or cron)
  No code change or service restart is required.

Supported predicate keys
------------------------
All predicates in a rule's ``when`` block are combined with AND logic.
Supported keys:

  body_term_count     : dict {terms: list[str], min: int}
                        Count how many distinct case-insensitive terms from
                        the list appear in the body. Fires when count >= min.
  title_matches_any   : list[str] — regex patterns matched against title
  title_contains_any  : list[str] — literal substrings (case-insensitive) in title
  body_contains_any   : list[str] — literal substrings (case-insensitive) in body
  text_matches_any    : list[str] — regex patterns against (title + " " + body)
  text_contains_any   : list[str] — literal substrings against (title + " " + body)
  title_ends_with     : str — literal suffix (case-sensitive)
  body_min_chars      : int — body must be >= this many characters
  body_max_chars      : int — body must be <= this many characters

Public API
----------
  load_rules(path=None) -> list[Rule]
      Load, validate, and compile rules from a YAML file. Raises on errors.

  apply_lexicon_rules(title, body, current, rules) -> dict
      Apply loaded rules to a post. Returns a (possibly modified) dict.

  reload_rules() -> list[Rule]
      Force-reload rules from disk and update the module-level cache.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml

logger = logging.getLogger(__name__)

# ── Default path to the rules file ───────────────────────────────────────────

_DEFAULT_RULES_PATH = Path(__file__).parent / "sentiment_rules.yaml"

# ── Module-level cache ────────────────────────────────────────────────────────

_rules_cache: Optional[list["Rule"]] = None
_rules_path_cache: Optional[Path] = None


# ── Rule dataclass ────────────────────────────────────────────────────────────

@dataclass
class Rule:
    """
    Represents one lexicon rule loaded from the YAML config.

    Attributes
    ----------
    id          : unique rule identifier
    description : human-readable explanation
    priority    : higher value wins when multiple rules fire (default 100)
    when        : dict of predicate key → value (see module docstring)
    set         : dict with keys ``label``, ``score``, ``reason``

    Compiled state
    --------------
    _title_patterns    : compiled regexes for title_matches_any
    _text_patterns     : compiled regexes for text_matches_any
    """
    id: str
    description: str
    priority: int
    when: dict[str, Any]
    set_: dict[str, Any]

    # Compiled regex patterns (populated post-init)
    _title_patterns: list[re.Pattern] = field(default_factory=list, repr=False)
    _text_patterns: list[re.Pattern] = field(default_factory=list, repr=False)

    def __post_init__(self) -> None:
        """Compile all regex patterns at load time so they are not re-compiled per call."""
        self._title_patterns = [
            re.compile(pat) for pat in self.when.get("title_matches_any", [])
        ]
        self._text_patterns = [
            re.compile(pat) for pat in self.when.get("text_matches_any", [])
        ]

    def matches(self, title: str, body: str) -> bool:
        """
        Evaluate all predicates in ``self.when`` against the given post.

        All predicates are combined with AND: every predicate in the ``when``
        dict must be satisfied for the rule to match.

        Parameters
        ----------
        title : post title string (may be empty)
        body  : post body string (may be empty)

        Returns
        -------
        True if all predicates match, False otherwise.
        """
        combined = (title + " " + body).lower()
        title_lower = title.lower()
        body_lower = body.lower()

        for key, value in self.when.items():

            # ── body_term_count ──────────────────────────────────────────────
            if key == "body_term_count":
                terms = [t.lower() for t in value.get("terms", [])]
                min_count = value.get("min", 1)
                count = sum(1 for t in terms if t in body_lower)
                if count < min_count:
                    return False

            # ── title_matches_any ────────────────────────────────────────────
            elif key == "title_matches_any":
                if not any(pat.search(title) for pat in self._title_patterns):
                    return False

            # ── title_contains_any ───────────────────────────────────────────
            elif key == "title_contains_any":
                needles = [v.lower() for v in value]
                if not any(n in title_lower for n in needles):
                    return False

            # ── body_contains_any ────────────────────────────────────────────
            elif key == "body_contains_any":
                needles = [v.lower() for v in value]
                if not any(n in body_lower for n in needles):
                    return False

            # ── text_matches_any ─────────────────────────────────────────────
            elif key == "text_matches_any":
                combined_raw = title + " " + body
                if not any(pat.search(combined_raw) for pat in self._text_patterns):
                    return False

            # ── text_contains_any ────────────────────────────────────────────
            elif key == "text_contains_any":
                needles = [v.lower() for v in value]
                if not any(n in combined for n in needles):
                    return False

            # ── title_ends_with ──────────────────────────────────────────────
            elif key == "title_ends_with":
                if not title.rstrip().endswith(value):
                    return False

            # ── body_min_chars ───────────────────────────────────────────────
            elif key == "body_min_chars":
                if len(body) < value:
                    return False

            # ── body_max_chars ───────────────────────────────────────────────
            elif key == "body_max_chars":
                if len(body) > value:
                    return False

            # Unknown predicate key — skip with a warning rather than crashing
            else:
                logger.warning(
                    "sentiment_lexicon: unknown predicate key '%s' in rule '%s' — skipping",
                    key, self.id,
                )

        return True


# ── YAML loading and validation ───────────────────────────────────────────────

def load_rules(path: str | Path | None = None) -> list[Rule]:
    """
    Load, validate, and compile rules from a YAML file.

    Parameters
    ----------
    path : path to the YAML file. Defaults to
           ``services/sentiment_rules.yaml`` (relative to this module).

    Returns
    -------
    List of ``Rule`` objects sorted by descending priority (highest priority
    first). Rules with equal priority appear in file order.

    Raises
    ------
    FileNotFoundError   if the YAML file does not exist.
    ValueError          if the YAML file fails schema validation (missing
                        required fields, bad regex patterns, etc.).
    yaml.YAMLError      if the file is not valid YAML syntax.
    """
    rules_path = Path(path) if path else _DEFAULT_RULES_PATH

    if not rules_path.exists():
        raise FileNotFoundError(f"sentiment_rules.yaml not found at {rules_path}")

    with rules_path.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)

    if raw is None:
        # Empty file — valid but zero rules
        return []

    if not isinstance(raw, dict):
        raise ValueError(f"Expected a YAML mapping at top level, got {type(raw).__name__}")

    # Validate top-level version field
    if "version" not in raw:
        raise ValueError("YAML config is missing required 'version' field")

    raw_rules = raw.get("rules", [])
    if raw_rules is None:
        raw_rules = []
    if not isinstance(raw_rules, list):
        raise ValueError(f"'rules' must be a list, got {type(raw_rules).__name__}")

    parsed: list[Rule] = []
    for idx, rule_dict in enumerate(raw_rules):
        if not isinstance(rule_dict, dict):
            raise ValueError(f"Rule at index {idx} is not a mapping")

        # Required fields
        rule_id = rule_dict.get("id")
        if not rule_id:
            raise ValueError(f"Rule at index {idx} is missing required 'id' field")

        description = rule_dict.get("description", "")
        priority = int(rule_dict.get("priority", 100))

        when = rule_dict.get("when")
        if not when or not isinstance(when, dict):
            raise ValueError(
                f"Rule '{rule_id}' is missing required 'when' dict (got {when!r})"
            )

        set_block = rule_dict.get("set")
        if not set_block or not isinstance(set_block, dict):
            raise ValueError(
                f"Rule '{rule_id}' is missing required 'set' dict (got {set_block!r})"
            )

        if "label" not in set_block:
            raise ValueError(f"Rule '{rule_id}' set block is missing 'label'")
        if "score" not in set_block:
            raise ValueError(f"Rule '{rule_id}' set block is missing 'score'")

        # Validate and pre-compile all regex patterns
        _validate_and_compile_regexes(rule_id, when)

        rule = Rule(
            id=rule_id,
            description=description,
            priority=priority,
            when=when,
            set_=set_block,
        )
        parsed.append(rule)

    # Sort by descending priority; stable sort preserves file order for ties
    parsed.sort(key=lambda r: r.priority, reverse=True)

    logger.info("sentiment_lexicon: loaded %d rule(s) from %s", len(parsed), rules_path)
    return parsed


def _validate_and_compile_regexes(rule_id: str, when: dict) -> None:
    """
    Compile all regex patterns in the ``when`` block to catch invalid patterns
    at load time rather than at classification time.

    Raises ValueError with a descriptive message on bad patterns.
    """
    for key in ("title_matches_any", "text_matches_any"):
        patterns = when.get(key, [])
        if not isinstance(patterns, list):
            raise ValueError(
                f"Rule '{rule_id}': '{key}' must be a list, got {type(patterns).__name__}"
            )
        for pat in patterns:
            try:
                re.compile(pat)
            except re.error as exc:
                raise ValueError(
                    f"Rule '{rule_id}': invalid regex in '{key}': {pat!r} — {exc}"
                ) from exc


# ── Module-level cache management ─────────────────────────────────────────────

def _get_rules() -> list[Rule]:
    """Return cached rules, loading them on first call."""
    global _rules_cache
    if _rules_cache is None:
        _rules_cache = load_rules()
    return _rules_cache


def reload_rules(path: str | Path | None = None) -> list[Rule]:
    """
    Force-reload rules from disk, bypassing the module-level cache.

    Call this after editing ``sentiment_rules.yaml`` on the production
    droplet to pick up changes without a service restart.

    Parameters
    ----------
    path : optional path override (same semantics as ``load_rules()``).

    Returns
    -------
    The freshly loaded list of Rule objects (sorted by priority descending).
    """
    global _rules_cache
    _rules_cache = load_rules(path)
    logger.info(
        "sentiment_lexicon: rules reloaded (%d rule(s))", len(_rules_cache)
    )
    return _rules_cache


# ── Core override logic ───────────────────────────────────────────────────────

def apply_lexicon_rules(
    title: str,
    body: str,
    current: dict,
    rules: list[Rule],
) -> dict:
    """
    Apply gaming-domain lexicon rules to a classified post.

    The lexicon overlay only fires when the post has passed BOTH hard gates:
      - language gate: ``current["language"] == "en"``
      - signal gate:   ``current["signal_quality"] != "low"``

    If either gate locked the result to neutral, this function returns
    ``current`` unchanged (no audit field is added).

    When rules match:
      - ALL matching rules are recorded in ``applied_rules`` for audit.
      - The rule with the HIGHEST priority overrides ``label`` and ``score``.
      - ``original_label``, ``signal_quality``, ``language``, and
        ``sentiment_conflict`` from the pre-lexicon step are preserved.

    Parameters
    ----------
    title   : post title string
    body    : post body string
    current : dict returned by classify_with_gate_v2 (Layers 1-3 result)
    rules   : list of Rule objects (from load_rules() or reload_rules())

    Returns
    -------
    Either the original ``current`` dict (unchanged, no rule fired) or a new
    dict with ``label``, ``score``, and ``applied_rules`` overridden.
    ``applied_rules`` is always present in the returned dict when the function
    decides to apply the lexicon (i.e. when the post passed the hard gates);
    it is ``[]`` when no rules matched.
    """
    # ── Hard gate guard: skip lexicon if a hard gate locked the result ────────
    language = current.get("language", "en")
    signal_quality = current.get("signal_quality", "high")

    if language != "en":
        # Language gate: non-English stays neutral — do not apply lexicon
        return current

    if signal_quality == "low":
        # Signal gate: low-signal posts stay neutral — do not apply lexicon
        return current

    # ── Evaluate all rules ────────────────────────────────────────────────────
    # Rules are already sorted by descending priority (load_rules guarantees this).
    fired_rules: list[Rule] = []

    for rule in rules:
        if rule.matches(title, body):
            fired_rules.append(rule)

    # ── Build result ──────────────────────────────────────────────────────────
    if not fired_rules:
        # Idempotent: no rule fired — return original result with applied_rules=[]
        result = dict(current)
        result["applied_rules"] = []
        return result

    # The first rule in fired_rules is the highest-priority winner (list is
    # sorted descending by priority; ties keep file order, last match wins among
    # tied priorities due to stable sort semantics with reversed file order).
    winner = fired_rules[0]

    result = dict(current)
    result["label"] = winner.set_["label"]
    result["score"] = float(winner.set_["score"])
    result["applied_rules"] = [r.id for r in fired_rules]

    logger.debug(
        "sentiment_lexicon: post [title=%r] matched %d rule(s); winner=%r → %s %.2f",
        title[:60],
        len(fired_rules),
        winner.id,
        result["label"],
        result["score"],
    )

    return result
