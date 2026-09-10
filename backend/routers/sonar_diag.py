"""Sonar API diagnostic router.

Added 2026-09-10 in response to the empty Top Topics widget outage that
started ~Sep 7. Every path in the Sonar client silently caught its own
errors and returned None, so from the outside the failure was invisible —
we couldn't tell the difference between "corpus is empty", "key is
missing", "key is wrong", "model was retired" and "endpoint returned
500". This endpoint returns TRUTH about all of the above in one call.

READ-ONLY. Does NOT mutate any product state. Does an actual live POST
to https://api.perplexity.ai/chat/completions with a 3-token max_tokens,
disable_search=true test prompt so we see the real HTTP status/body
from Perplexity.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from fastapi import APIRouter

from config import settings

router = APIRouter(prefix="/diag", tags=["diag"])

_SONAR_URL = "https://api.perplexity.ai/chat/completions"

_TEST_MODELS = ["sonar-pro", "sonar"]


def _mask_key(key: str) -> dict:
    """Return metadata about the key without leaking its value."""
    if not key:
        return {"present": False, "length": 0, "prefix": None, "suffix": None}
    stripped = key.strip()
    return {
        "present": True,
        "length": len(stripped),
        "prefix": stripped[:5] if len(stripped) >= 5 else stripped,
        "suffix": stripped[-3:] if len(stripped) >= 3 else "",
        "starts_with_pplx": stripped.startswith("pplx-"),
        "has_whitespace_in_env": key != stripped,
    }


def _probe_sonar(model: str, timeout: float = 20.0) -> dict:
    """One tiny live probe. Returns the exact HTTP status and body slice."""
    key = (settings.perplexity_api_key or "").strip()
    if not key:
        return {"model": model, "skipped": True, "reason": "no key"}

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Respond with the single word: ok"},
            {"role": "user", "content": "ping"},
        ],
        "max_tokens": 3,
        "temperature": 0.0,
        "disable_search": True,
    }
    req = urllib.request.Request(
        _SONAR_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        },
        method="POST",
    )

    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        elapsed = time.monotonic() - started
        try:
            parsed = json.loads(raw)
            content = None
            try:
                content = parsed["choices"][0]["message"]["content"]
            except Exception:
                pass
            return {
                "model": model,
                "ok": True,
                "http_status": 200,
                "elapsed_s": round(elapsed, 3),
                "content_preview": (content or "")[:120],
                "usage": parsed.get("usage"),
                "response_id": parsed.get("id"),
            }
        except Exception as parse_err:
            return {
                "model": model,
                "ok": False,
                "http_status": 200,
                "elapsed_s": round(elapsed, 3),
                "parse_error": str(parse_err),
                "raw_preview": raw[:400],
            }
    except urllib.error.HTTPError as e:
        elapsed = time.monotonic() - started
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        return {
            "model": model,
            "ok": False,
            "http_status": e.code,
            "reason": e.reason,
            "elapsed_s": round(elapsed, 3),
            "response_body": err_body,
            "response_headers": {k.lower(): v for k, v in (e.headers.items() if e.headers else [])},
        }
    except urllib.error.URLError as e:
        return {
            "model": model,
            "ok": False,
            "http_status": None,
            "url_error": str(e.reason),
            "elapsed_s": round(time.monotonic() - started, 3),
        }
    except Exception as e:  # pragma: no cover
        return {
            "model": model,
            "ok": False,
            "http_status": None,
            "unexpected_error": f"{type(e).__name__}: {e}",
            "elapsed_s": round(time.monotonic() - started, 3),
        }


@router.get("/sonar/status")
def sonar_status() -> dict:
    """Report Sonar key state and live probe result for each candidate model.

    No secrets are returned. `key.prefix` is the first 5 characters (which
    for a valid Perplexity key is always `pplx-`), `key.suffix` is the last
    3, and `key.length` lets us see whether the key was truncated.

    `probes` is a list of live POSTs to https://api.perplexity.ai/chat/completions
    with a 3-token max_tokens. Each probe is short and cheap. Reading this
    endpoint counts against the API just like any other Sonar call.
    """
    return {
        "endpoint": _SONAR_URL,
        "key": _mask_key(settings.perplexity_api_key),
        "probes": [_probe_sonar(m) for m in _TEST_MODELS],
        "notes": {
            "sunset_date": "Sonar Chat Completions supported until 2026-09-27; after that migrate to Agent API. See https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview",
            "purpose": "Diagnostic for the empty Top Topics widget starting ~2026-09-07.",
        },
    }
