"""Unit tests for the §21b exec leading-theme gate.

Regression: 2026-06-29 user flagged the Hellraiser weekly exec summary as
'total nonsense' because the LLM led with 'Regional localization gaps,
particularly Turkish Community Posts' — a single Turkish post which §21b
had already classified as monitor-only.  Root cause: `_call_exec` was
never being passed `critical_mass_table`, so the exec prompt had no gate
even though `_call_actions` and `_call_bold_ideas` did.

These tests cover the post-LLM `_strip_monitor_only_lead` validator —
the belt-and-suspenders guard for when the LLM ignores the prompt rule.
"""

from services.period_summary_service import _strip_monitor_only_lead


def test_returns_text_unchanged_when_no_monitor_topics():
    text = "Regional localization gaps are the primary liability. Positive signal is strong."
    assert _strip_monitor_only_lead(text, []) == text


def test_returns_text_unchanged_when_empty():
    assert _strip_monitor_only_lead("", ["'Localization' (negative)"]) == ""


def test_strips_lead_when_dominated_by_monitor_only_label():
    text = (
        "Regional localization gaps, particularly Turkish Community Posts and broader "
        "localization friction, surface as the primary liability theme. "
        "Pre-order demand remains strong with collector's edition inquiries dominating positive volume."
    )
    monitor = ["'Localization' (negative)"]
    result = _strip_monitor_only_lead(text, monitor)
    assert "Regional localization gaps" not in result
    assert "Pre-order demand" in result


def test_keeps_lead_when_label_is_only_incidental_mention():
    # Lead sentence is long and label appears only as a passing mention
    # (label/lead ratio is below the 8% dominance threshold).  The lead
    # should be preserved.  We pad with enough context that the label
    # ratio drops well below threshold.
    long_lead = (
        "Community sentiment shifted positively this week with strong organic "
        "comparisons to Resident Evil Requiem driving most of the positive volume "
        "and Barker's auteur vision earning praise across the subreddit, while "
        "localization came up only once in a Turkish post that did not gain traction "
        "and remains a minor concern at best across the entire data window analyzed. "
        "Pre-order demand remains strong."
    )
    monitor = ["'Localization' (negative)"]
    result = _strip_monitor_only_lead(long_lead, monitor)
    assert "Community sentiment shifted" in result


def test_handles_label_in_double_quotes():
    text = "Localization issues lead the negative volume. Positive signal is strong."
    monitor = ['"Localization" (negative)']
    result = _strip_monitor_only_lead(text, monitor)
    assert "Localization issues" not in result
    assert "Positive signal" in result


def test_strips_only_first_sentence_not_subsequent_mentions():
    # A monitor-only topic may be mentioned later as 'worth watching'.
    # Only the LEAD sentence should ever be stripped.
    text = (
        "Localization concerns dominate the negative volume. "
        "Pre-order demand remains strong with collector's edition inquiries leading positive volume. "
        "Localization is also worth monitoring."
    )
    monitor = ["'Localization' (negative)"]
    result = _strip_monitor_only_lead(text, monitor)
    assert not result.startswith("Localization concerns")
    assert "Pre-order demand" in result
    assert "worth monitoring" in result


def test_returns_empty_when_only_sentence_was_monitor_lead():
    text = "Localization is the primary theme."
    monitor = ["'Localization' (negative)"]
    result = _strip_monitor_only_lead(text, monitor)
    assert result == ""
