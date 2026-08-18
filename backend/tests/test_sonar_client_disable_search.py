"""Regression tests for sonar_client.call_sonar — 2026-08-18.

Background:
  Sonar's default behavior is to web-search alongside its LLM completion,
  even when the system message says "ground strictly in the provided posts".
  On 2026-08-18 the Turok: Origins dashboard's Top Topics widget rendered
  a "Patch notes fix the shield mech..." bullet — Helldivers 2 patch-note
  vocabulary grafted onto an unreleased game whose 19 admitted 7d posts
  contained no such words. Root cause: `call_sonar` was called with
  search_context_size="low" (still web-enabled). Perplexity's API supports
  a `disable_search: true` flag that fully turns web search off; that's
  what strictly-grounded synthesis needs.

These tests verify:
  1. `disable_search=True` is the default (safe-by-default posture).
  2. When disable_search=True, the request body includes
     `"disable_search": true` and does NOT include `web_search_options`
     (search_context_size is meaningless when search is off).
  3. When disable_search=False, `web_search_options.search_context_size`
     IS included and no `disable_search` key is sent.
  4. All current in-tree callers rely on the strict-grounding path.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch, MagicMock


def _mock_ok_response(text: str = "ok") -> MagicMock:
    """urllib.request.urlopen context-manager mock returning a Sonar payload."""
    body = {
        "id": "test",
        "model": "sonar-pro",
        "choices": [{"message": {"content": text}}],
    }
    resp = MagicMock()
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    resp.read = MagicMock(return_value=json.dumps(body).encode("utf-8"))
    resp.status = 200
    resp.getcode = MagicMock(return_value=200)
    return resp


def _capture_request_body(mock_urlopen):
    """Given a urlopen mock, decode the JSON body of the most recent call."""
    call_args = mock_urlopen.call_args
    req = call_args.args[0] if call_args.args else call_args.kwargs.get("url")
    # urllib.request.Request stores the body on .data
    return json.loads(req.data.decode("utf-8"))


# ── Test 1: disable_search defaults to True ──────────────────────────────────

def test_call_sonar_default_disables_web_search():
    """
    2026-08-18 safe-by-default: calling call_sonar without specifying
    disable_search MUST include `"disable_search": true` in the request
    body. If this fails, a well-meaning refactor has flipped the default
    and a future Turok-style regression is now possible.
    """
    from services import sonar_client

    with patch.object(sonar_client.settings, "perplexity_api_key", "test-key"), \
         patch("services.sonar_client.urllib.request.urlopen",
               return_value=_mock_ok_response("hello")) as mock_urlopen:
        resp = sonar_client.call_sonar("hi")

    assert resp.text == "hello"
    body = _capture_request_body(mock_urlopen)
    assert body.get("disable_search") is True, (
        f"disable_search must default to True. Got body={body}"
    )
    assert "web_search_options" not in body, (
        f"When search is disabled, web_search_options must NOT be sent "
        f"(search_context_size is meaningless when search is off). Got body={body}"
    )


# ── Test 2: disable_search=True explicitly ───────────────────────────────────

def test_call_sonar_explicit_disable_search_true():
    from services import sonar_client

    with patch.object(sonar_client.settings, "perplexity_api_key", "test-key"), \
         patch("services.sonar_client.urllib.request.urlopen",
               return_value=_mock_ok_response()) as mock_urlopen:
        sonar_client.call_sonar("hi", disable_search=True)

    body = _capture_request_body(mock_urlopen)
    assert body.get("disable_search") is True
    assert "web_search_options" not in body


# ── Test 3: disable_search=False sends web_search_options ────────────────────

def test_call_sonar_disable_search_false_sends_web_search_options():
    """
    When a caller opts INTO web search (e.g. hot-thread discovery), the
    request must include web_search_options.search_context_size and must
    NOT include disable_search=true.
    """
    from services import sonar_client

    with patch.object(sonar_client.settings, "perplexity_api_key", "test-key"), \
         patch("services.sonar_client.urllib.request.urlopen",
               return_value=_mock_ok_response()) as mock_urlopen:
        sonar_client.call_sonar(
            "hi",
            disable_search=False,
            search_context_size="medium",
        )

    body = _capture_request_body(mock_urlopen)
    assert body.get("disable_search") is not True, (
        f"With disable_search=False, the body must not force it back on. Got body={body}"
    )
    assert body.get("web_search_options") == {"search_context_size": "medium"}


# ── Test 4: current in-tree callers use the strict-grounding path ────────────

def test_all_call_sonar_sites_in_tree_use_strict_grounding():
    """
    Grep across services/ for `call_sonar(` and assert every call site
    either (a) passes `disable_search=True` explicitly or (b) relies on
    the default (which we've locked to True in test 1 above).

    This is a coarse guard: if someone adds a call site with
    `disable_search=False` for legitimate web-enrichment (e.g. hot-thread
    discovery), they can update this test's whitelist. But an accidental
    `search_context_size="low"`-style call that silently re-enables web
    blending will fail this test.
    """
    import re
    from pathlib import Path

    services_dir = Path(__file__).resolve().parent.parent / "services"
    assert services_dir.is_dir(), f"services dir not found at {services_dir}"

    # A `call_sonar(...)` invocation is bad if it explicitly sets
    # disable_search=False anywhere in the tree without being on the
    # whitelist. Whitelist is empty for now: no legitimate web-enrichment
    # call site exists.
    WHITELIST_FILES: set[str] = set()

    offenders: list[str] = []
    for py in services_dir.rglob("*.py"):
        if py.name == "sonar_client.py":
            continue  # the definition itself; not a call site
        src = py.read_text(encoding="utf-8")
        # Cheap scan: find each `call_sonar(` and look at ~1000 chars
        # after for a `disable_search=False`.
        for m in re.finditer(r"call_sonar\s*\(", src):
            window = src[m.end():m.end() + 1500]
            # Stop scan at the closing paren depth returning to 0.
            depth = 1
            end_idx = 0
            for i, ch in enumerate(window):
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        end_idx = i
                        break
            call_body = window[:end_idx]
            if "disable_search=False" in call_body:
                rel = py.relative_to(services_dir.parent).as_posix()
                if rel not in WHITELIST_FILES:
                    offenders.append(f"{rel}: {call_body.strip()[:200]}")

    assert not offenders, (
        "Found call_sonar(...) sites that pass disable_search=False. If this "
        "is legitimate web-enrichment (e.g. hot-thread discovery), add the "
        "file path to WHITELIST_FILES in this test. Otherwise, remove the "
        "disable_search=False so the strict-grounding default applies.\n"
        "Offenders:\n  " + "\n  ".join(offenders)
    )
