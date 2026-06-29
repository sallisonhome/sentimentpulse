"""Perplexity Sonar HTTP client for SentimentPulse exec / recs / bold-ideas.

Why Sonar (2026-06-29, user direction): Claude Haiku confabulated under
sparse-context summarization (Hellraiser competing-titles, Turok Turkish-lead).
Side-by-side test on Hellraiser showed Sonar produces atomic, cited sentences
that map cleanly to source posts. The §25-series post-LLM filter stack was
needed only because Haiku's output required heavy cleanup; Sonar's output
does not.

This module is intentionally tiny — a thin POST wrapper that mimics the
Anthropic `messages.create(...).content[0].text` shape that the existing
callers expect. That lets the rest of period_summary_service.py treat
Sonar and Anthropic responses identically.

Routing: callers use `call_sonar(...)`. On any error (HTTP, timeout, JSON),
the function raises — the caller decides whether to fall back to Anthropic.
"""
from __future__ import annotations

import json
import logging
import time
import urllib.request
import urllib.error
from dataclasses import dataclass
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)

_SONAR_URL = "https://api.perplexity.ai/chat/completions"
_DEFAULT_MODEL = "sonar-pro"
_DEFAULT_TIMEOUT = 180  # seconds — Sonar can take 5-15s for long context

# Default system message: tells Sonar to ground STRICTLY in user-provided
# context. Without this, Sonar's default behavior is to web-search and
# blend external knowledge.
_DEFAULT_SYSTEM = (
    "You are a game industry analyst writing for the leadership team. "
    "You ground every claim STRICTLY in the user's provided cited posts "
    "and editorial articles. You never use external web knowledge. "
    "You never invent facts, competing products, partnerships, or claims "
    "not present in the cited sources. Sentences that cannot be backed "
    "by a citation are forbidden."
)


@dataclass
class SonarResponse:
    """Mimics the surface of `anthropic_message.content[0].text` so callers
    that previously did `message.content[0].text.strip()` keep working.
    """
    text: str
    raw: dict

    @property
    def content(self) -> list["SonarContentBlock"]:
        return [SonarContentBlock(text=self.text)]


@dataclass
class SonarContentBlock:
    text: str


def sonar_available() -> bool:
    """Return True iff a Perplexity API key is configured."""
    return bool(settings.perplexity_api_key)


def call_sonar(
    prompt: str,
    *,
    model: str = _DEFAULT_MODEL,
    system: Optional[str] = None,
    max_tokens: int = 800,
    temperature: float = 0.2,
    timeout: int = _DEFAULT_TIMEOUT,
    search_context_size: str = "low",
) -> SonarResponse:
    """POST a single user prompt to Sonar and return the response.

    Raises RuntimeError on any failure (no key, HTTP error, parse error).
    The caller is expected to catch and fall back to Anthropic.

    Args:
        prompt: The user message content (full prompt).
        model: Sonar model variant. Default `sonar-pro` (best for long
            grounded summaries). Use `sonar` for cheaper/lighter calls.
        system: System message. Defaults to the strict-grounding preamble.
        max_tokens: Maximum tokens in the response.
        temperature: Sampling temperature. Lower = more deterministic.
        timeout: HTTP timeout in seconds.
        search_context_size: Sonar web-search retrieval depth. `low` is
            usually right for our use case — we don't want Sonar pulling
            in web context that competes with our cited posts, but we
            also can't fully disable it on Sonar. `low` keeps it minimal.
    """
    if not sonar_available():
        raise RuntimeError("Perplexity API key not configured (settings.perplexity_api_key empty).")

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system or _DEFAULT_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "web_search_options": {"search_context_size": search_context_size},
    }
    body_bytes = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        _SONAR_URL,
        data=body_bytes,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.perplexity_api_key}",
            "Accept": "application/json",
        },
        method="POST",
    )

    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw_bytes = resp.read()
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        raise RuntimeError(
            f"Sonar HTTP {e.code}: {e.reason} | body={err_body!r}"
        ) from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Sonar URLError: {e.reason}") from e
    except Exception as e:
        raise RuntimeError(f"Sonar unexpected error: {e}") from e

    elapsed = time.monotonic() - started

    try:
        parsed = json.loads(raw_bytes.decode("utf-8"))
    except Exception as e:
        raise RuntimeError(
            f"Sonar response not JSON ({len(raw_bytes)} bytes): {e}"
        ) from e

    try:
        text = parsed["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(
            f"Sonar response missing choices[0].message.content: {parsed!r}"
        ) from e

    logger.info(
        "Sonar call OK model=%s prompt_len=%d resp_len=%d elapsed=%.2fs",
        model, len(prompt), len(text or ""), elapsed,
    )
    return SonarResponse(text=text or "", raw=parsed)
