"""
v0030 (2026-09-01, Road Kings mistagging fix) — tests for:

1. Social-nicety pre-classifier gate (nlp_service._is_social_nicety +
   classify_with_gate_v2 + classify_batch_with_gate_v2).
2. Tier-aware admission for reddit_comment in Step 5 (via
   `_AUTO_ADMIT_SOURCES` no longer including reddit_comment).
3. Posts endpoint default now excludes noise tier.

These tests do NOT hit the model; they exercise the pre-model gates
and the router filter logic only.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

# Guard: the model may or may not be present in a test container. All
# tests below stay in the pre-model gates so they never call the model.

import pytest


# ─── 1. Social-nicety gate ──────────────────────────────────────────────

@pytest.mark.parametrize("text", [
    "Thanks",
    "Thanks!",
    "thanks for this explanation",
    "Thanks for this explanation.",
    "Thank you",
    "much appreciated",
    "Cheers",
    "lol",
    "Nice",
    "Got it",
    "Yep",
    "sure",
    "Agreed.",
    "you're welcome",
    "np",
    "sorry",
    "Yeah",
])
def test_is_social_nicety_fires(text):
    from services.nlp_service import _is_social_nicety
    assert _is_social_nicety(text) is True, f"expected nicety: {text!r}"


@pytest.mark.parametrize("text", [
    # Longer than 40 chars — never a pure nicety
    "Thanks for the great support during the launch weekend, everyone!",
    "I hope this patch fixes the crashes I've been seeing on my hardware.",
    # Contains sentiment-bearing content beyond the nicety
    "Thanks for the update but the crashes are still happening after v1.2",
    "Cool feature, but the multiplayer is completely broken right now",
    # Empty / short non-nicety
    "",
    "The game is great",
    "This looks amazing",
    "Terrible launch",
])
def test_is_social_nicety_does_not_fire(text):
    from services.nlp_service import _is_social_nicety
    assert _is_social_nicety(text) is False, f"expected NOT nicety: {text!r}"


def test_classify_with_gate_v2_short_circuits_nicety_to_neutral():
    """The 4 circled Road Kings comments should return neutral without
    calling the model. Two of them ('Thanks for this explanation' and
    'I hope it was enough to help make sense of it foe you') are the
    pure nicety cases; the other two are keyword-gated out earlier
    (before reaching this function) by the Step 5 admission gate."""
    from services.nlp_service import classify_with_gate_v2

    r = classify_with_gate_v2("", "Thanks for this explanation")
    assert r["label"] == "neutral"
    assert r["score"] == 0.5
    assert "v0030_social_nicety" in r["applied_rules"]

    r2 = classify_with_gate_v2("", "Thanks")
    assert r2["label"] == "neutral"
    assert "v0030_social_nicety" in r2["applied_rules"]


def test_classify_batch_with_gate_v2_nicety_short_circuits():
    """Batch path: nicety items resolve to neutral without model call."""
    from services.nlp_service import classify_batch_with_gate_v2

    items = [
        {"title": "", "body": "Thanks"},
        {"title": "", "body": "Cool"},
        {"title": "", "body": ""},  # empty
    ]
    results = classify_batch_with_gate_v2(items)
    assert results[0]["label"] == "neutral"
    assert "v0030_social_nicety" in results[0]["applied_rules"]
    assert results[1]["label"] == "neutral"
    assert "v0030_social_nicety" in results[1]["applied_rules"]
    # empty still neutral, but via empty-input path (no nicety rule)
    assert results[2]["label"] == "neutral"
    assert "v0030_social_nicety" not in results[2]["applied_rules"]


# ─── 2. Tier-aware admission (Step 5) ────────────────────────────────────

def test_auto_admit_sources_no_longer_includes_reddit_comment():
    """The bug fix: reddit_comment must NOT be in _AUTO_ADMIT_SOURCES so
    Step 5 falls through to the tier check + keyword gate."""
    import inspect
    from services import ingestor

    src = inspect.getsource(ingestor._step5_classify_sentiment)
    # Locate the set literal
    import re
    m = re.search(r"_AUTO_ADMIT_SOURCES\s*=\s*\{([^}]+)\}", src, re.MULTILINE)
    assert m, "could not find _AUTO_ADMIT_SOURCES definition"
    body = m.group(1)
    assert "steam_review" in body, "steam_review must remain auto-admitted"
    assert "steam_forum" in body, "steam_forum must remain auto-admitted"
    assert "reddit_comment" not in body, (
        "reddit_comment must NOT be auto-admitted (v0030 fix)"
    )


# ─── 3. Posts endpoint noise filter ──────────────────────────────────────

def test_posts_endpoint_default_excludes_noise():
    """Default behavior (no relevance param) must add a WHERE clause that
    excludes noise-tier posts."""
    import inspect
    from routers import posts

    src = inspect.getsource(posts.get_posts)
    assert 'relevance_tier != "noise"' in src or "relevance_tier != 'noise'" in src, (
        "get_posts must add a default filter that excludes noise tier"
    )
    assert "'all'" in src or '"all"' in src, (
        "get_posts must accept 'all' as an explicit opt-in to include noise"
    )


# ─── 4. Cleanup endpoint sanity ──────────────────────────────────────────

def test_cleanup_noise_endpoint_registered():
    """The new admin cleanup endpoint must be registered on the ingest router."""
    from routers.ingest import router
    paths = [r.path for r in router.routes]
    assert "/ingest/sentiment/cleanup_noise" in paths or \
           any(p.endswith("/sentiment/cleanup_noise") for p in paths), \
           f"cleanup_noise endpoint not found; got: {paths[-10:]}"


def test_cleanup_noise_endpoint_requires_confirmation():
    """dry_run=false without confirm must 400."""
    from fastapi.testclient import TestClient
    # Import lazily to avoid loading heavy modules at collect time
    try:
        from main import app
    except Exception as exc:
        pytest.skip(f"main app import failed (expected in some CI envs): {exc}")
        return

    client = TestClient(app)
    r = client.post("/api/ingest/sentiment/cleanup_noise?dry_run=false")
    assert r.status_code == 400, r.text
    assert "YES_DELETE_NOISE_SENTIMENT" in r.text
