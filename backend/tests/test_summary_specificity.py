"""Unit tests for the executive-summary specifics-extraction helpers.

These helpers are the core of the 2026-05-30 hardening pass that fixed
generic, label-only summaries.  See CLAUDE.md §19 and the design notes in
services/period_summary_service.py:_sample_posts_for_window.
"""
from services.period_summary_service import (
    _distinctive_entities,
    _format_entities_block,
    _format_sample_posts_block,
)


# ── _distinctive_entities ────────────────────────────────────────────────────

def test_distinctive_entities_finds_multi_word_proper_nouns():
    samples = {
        "positive": [
            "The Salamanders Chapter Pack is fantastic free content",
            "Loving the new Salamanders Chapter Pack drop",
            "Salamanders Chapter Pack release was perfect timing",
        ],
        "negative": [],
        "neutral": [],
    }
    entities = _distinctive_entities(samples)
    assert any("Salamanders Chapter Pack" in e for e in entities)


def test_distinctive_entities_finds_boss_names():
    samples = {
        "positive": [],
        "negative": [
            "Tyranid Warrior is overtuned at Ruthless",
            "Tyranid Warrior boss keeps killing my squad",
            "Why is Tyranid Warrior so brutal on Helldive",
        ],
        "neutral": [],
    }
    entities = _distinctive_entities(samples)
    assert any("Tyranid Warrior" in e for e in entities)


def test_distinctive_entities_skips_stopwords():
    samples = {
        "positive": ["The game is good", "The game is great", "The game is fun"],
        "negative": [],
        "neutral": [],
    }
    entities = _distinctive_entities(samples)
    # "The" should not surface despite high count
    assert not any(e.lower() == "the" for e in entities)
    # "game" is in the stopword list, should not surface
    assert not any(e.lower() == "game" for e in entities)


def test_distinctive_entities_handles_empty_samples():
    samples = {"positive": [], "negative": [], "neutral": []}
    entities = _distinctive_entities(samples)
    assert entities == []


def test_distinctive_entities_relaxes_threshold_when_sparse():
    """If <5 entities pass the 3-post threshold, the helper should relax to 2
    posts.  Otherwise sparse but real entities never surface."""
    samples = {
        "positive": [
            "Inferno Pistol is amazing",
            "Inferno Pistol balance is perfect now",  # 2 mentions of "Inferno Pistol"
        ],
        "negative": [],
        "neutral": [],
    }
    entities = _distinctive_entities(samples)
    # Should surface because relaxed threshold is 2
    assert any("Inferno Pistol" in e for e in entities)


# ── _format_sample_posts_block ───────────────────────────────────────────────

def test_format_sample_posts_block_renders_each_bucket():
    samples = {
        "positive": ["Loving the new patch"],
        "negative": ["This boss is broken"],
        "neutral": [],  # empty bucket should be skipped
    }
    block = _format_sample_posts_block(samples)
    assert "-- POSITIVE samples --" in block
    assert "-- NEGATIVE samples --" in block
    assert "-- NEUTRAL samples --" not in block  # empty, skipped
    assert "Loving the new patch" in block
    assert "This boss is broken" in block


def test_format_sample_posts_block_empty():
    assert _format_sample_posts_block({}) == ""
    assert _format_sample_posts_block({"positive": [], "negative": [], "neutral": []}) == ""


def test_format_sample_posts_block_collapses_whitespace():
    """Posts with newlines/tabs should be rendered on a single line so the
    prompt structure remains parseable."""
    samples = {
        "positive": ["Line one.\n\nLine two.\tTabbed."],
        "negative": [],
        "neutral": [],
    }
    block = _format_sample_posts_block(samples)
    assert "Line one. Line two. Tabbed." in block
    assert "\n\n" not in block.split("--")[2]  # bucket body has no double newlines


# ── _format_entities_block ───────────────────────────────────────────────────

def test_format_entities_block_basic():
    assert _format_entities_block(["A", "B", "C"]) == "A, B, C"


def test_format_entities_block_empty():
    assert _format_entities_block([]) == ""
    assert _format_entities_block(None) == ""
