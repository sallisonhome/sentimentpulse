"""LLM backend bake-off harness — Landing 6 of the Sonar-deprecation migration
(2026-09-19; deadline 2026-09-27).

Purpose
-------
Sonar Chat Completions is deprecated. SentimentPulse (via services/llm_client.py),
SignalPulse (via signalpulse/server/sonar-client.ts), and GTM Studio (via
gtm/backend/gtm_pack/translate.py) each have an Agent API branch behind an
env var flag. Before flipping any of those flags in production we want
side-by-side output for the exact prompt shapes each block sends, so a
human (Steve) can pick the winning backend per block based on real
comparable output — not vibes.

What this script does
---------------------
For each fixed prompt in `PROMPTS` (representative of one production block —
topics sentence, digest paragraph, period summary, translate) this script
calls `services.llm_client.call_llm(...)` three times: once forcing Sonar,
once forcing Anthropic, once forcing Agent API. The three responses are
captured with elapsed time and any error, then written to a single
Markdown file for eyeball comparison. No production data is touched.

The env-var override is set per-call by temporarily setting
`LLM_PRIMARY_<BLOCK>` and using an ephemeral block_kind so we don't
collide with any real block's env config.

Usage
-----
    cd sentimentpulse/backend
    PERPLEXITY_API_KEY=...  ANTHROPIC_API_KEY=... \\
        python -m scripts.llm_bakeoff --out /tmp/llm_bakeoff.md

    # Only run one prompt (fast iteration):
    python -m scripts.llm_bakeoff --only topics

    # Skip backends whose keys aren't set (default) or fail LOUD:
    python -m scripts.llm_bakeoff --strict

Design decisions
----------------
- Reuses services.llm_client — that's the same abstraction production uses,
  so bake-off results reflect what production will do post-flip. Building a
  separate raw-HTTP harness would risk drifting from production behavior.
- One Markdown file (not JSON) so Steve can review in a browser or IDE
  without a viewer. Errors and elapsed times are inlined.
- Never raises past a per-call failure — one blown backend on one prompt
  should not lose the other two backends' output.
"""
from __future__ import annotations

import argparse
import contextlib
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# Repo layout: this file is backend/scripts/llm_bakeoff.py. Add backend/ to
# sys.path so `from services.llm_client import ...` works when invoked as
# `python -m scripts.llm_bakeoff` from the backend/ dir.
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from services.llm_client import LlmResponse, call_llm  # noqa: E402

logger = logging.getLogger("llm_bakeoff")

BACKENDS = ("sonar", "anthropic", "agent-api")


# ---------------------------------------------------------------------------
# Prompt fixtures — mirror what each production block actually sends
# ---------------------------------------------------------------------------

@dataclass
class Prompt:
    """One bake-off test case. `block_kind` is a fresh identifier we control
    (never a real production block name) so we can set
    LLM_PRIMARY_<BLOCK_KIND> per-call without touching production env."""
    name: str            # short human label ("topics", "digest", ...)
    block_kind: str      # env-var suffix (uppercased). e.g. "BAKEOFF_TOPICS"
    system: str
    prompt: str
    max_tokens: int
    temperature: float
    disable_search: bool


PROMPTS: list[Prompt] = [
    Prompt(
        name="topics",
        block_kind="BAKEOFF_TOPICS",
        system=(
            "You summarize a cluster of Steam-review or Reddit posts into one "
            "short sentence naming the shared topic. Ground on the given posts "
            "only; do not invent details. 12-18 words. No headers or bullets."
        ),
        prompt=(
            "Summarize this cluster in one sentence:\n"
            "- \"Framerate tanks in the demo boss fight even on a 4080.\"\n"
            "- \"Boss encounter drops from 90 to 25 fps on Ultra.\"\n"
            "- \"Frame pacing feels awful once the second cenobite appears.\"\n"
            "- \"Devs need to profile the boss fight — it's unplayable at high settings.\""
        ),
        max_tokens=80,
        temperature=0.2,
        disable_search=True,
    ),
    Prompt(
        name="digest",
        block_kind="BAKEOFF_DIGEST",
        system=(
            "You write short factual paragraphs for an internal leadership digest. "
            "Ground numbers strictly in the data provided. 2-4 plain sentences, "
            "no markdown, no bullets, no headers."
        ),
        prompt=(
            "Write a 2-4 sentence digest paragraph for these Steam wishlist movers "
            "for the week of 2026-09-08 through 2026-09-14:\n"
            "- Clive Barker's Hellraiser: Revival (AppID 1551980): +14,204 net wishlist "
            "adds, +8,300 followers, rank #47 (+12 spots).\n"
            "- Space Marine 2 Season Pass DLC (AppID 2183900): +2,150 wishlist adds, "
            "+970 followers, rank stable.\n"
            "- Robo Survivors (AppID 3421770): +610 wishlist adds, +42 followers, "
            "unranked (new)."
        ),
        max_tokens=350,
        temperature=0.2,
        disable_search=True,
    ),
    Prompt(
        name="period_summary",
        block_kind="BAKEOFF_PERIODSUMMARY",
        system=(
            "You write 4-6 sentence sentiment-summary paragraphs for a per-game "
            "period dashboard. Ground strictly on the provided numbers and topic list."
        ),
        prompt=(
            "Write the weekly-summary paragraph for Hellraiser: Revival (Sep 15-21, 2026):\n"
            "- 638 Steam reviews (883 positive Steam-wide; our sample skews similar)\n"
            "- 2720 forum posts; top topics: BDSM/faithfulness to source (positive), "
            "  nudity/censorship (mixed), HDR support (negative), no-progress-transfer "
            "  to full game (negative), framerate on demo boss (negative).\n"
            "- 174 reddit comments in past 24h across r/patientgamers, r/gaming, "
            "  r/HellraiserGame."
        ),
        max_tokens=500,
        temperature=0.3,
        disable_search=True,
    ),
    Prompt(
        name="translate",
        block_kind="BAKEOFF_TRANSLATE",
        system=(
            "You are a professional translator. Translate every string value in "
            "the given JSON to Russian. Preserve JSON structure exactly. Never "
            "translate numbers, dates, booleans, or enum strings. Return ONLY valid JSON."
        ),
        prompt=(
            '{"title":"Clive Barker\'s Hellraiser: Revival",'
            '"genre":"Survival Horror",'
            '"tagline":"A slow-burn descent through the Order of the Gash",'
            '"cohorts":[{"name":"Horror Genre Fans","size":420000},'
            '{"name":"Clive Barker Loyalists","size":85000}]}'
        ),
        max_tokens=500,
        temperature=0.2,
        disable_search=True,
    ),
]


# ---------------------------------------------------------------------------
# One call per backend, captured
# ---------------------------------------------------------------------------

@dataclass
class CallResult:
    backend: str
    ok: bool
    text: str
    elapsed_s: float
    error: str | None
    source_label: str            # e.g. "sonar:sonar-pro", "agent-api:preset=low"
    fell_back_from: str | None   # populated only if router fallback fired


@contextlib.contextmanager
def _forced_backend(block_kind: str, backend: str):
    """Set LLM_PRIMARY_<BLOCK_KIND>=backend and disable fallback for the
    duration of the block. Restores prior env on exit."""
    env_var = f"LLM_PRIMARY_{block_kind.upper()}"
    prev = os.environ.get(env_var)
    prev_fallback = os.environ.get("LLM_FALLBACK")
    os.environ[env_var] = backend
    # Disable fallback so a Sonar-forced call that fails doesn't silently
    # return Anthropic output — we want per-backend truth in the report.
    os.environ["LLM_FALLBACK"] = "none"
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(env_var, None)
        else:
            os.environ[env_var] = prev
        if prev_fallback is None:
            os.environ.pop("LLM_FALLBACK", None)
        else:
            os.environ["LLM_FALLBACK"] = prev_fallback


def _run_one(prompt: Prompt, backend: str) -> CallResult:
    started = time.monotonic()
    try:
        with _forced_backend(prompt.block_kind, backend):
            resp: LlmResponse = call_llm(
                prompt.prompt,
                block_kind=prompt.block_kind,
                system=prompt.system,
                max_tokens=prompt.max_tokens,
                temperature=prompt.temperature,
                disable_search=prompt.disable_search,
            )
        elapsed = time.monotonic() - started
        return CallResult(
            backend=backend,
            ok=True,
            text=resp.text,
            elapsed_s=elapsed,
            error=None,
            source_label=resp.source,
            fell_back_from=resp.fell_back_from,
        )
    except Exception as exc:  # noqa: BLE001 — bake-off must never crash on a single failure
        elapsed = time.monotonic() - started
        return CallResult(
            backend=backend,
            ok=False,
            text="",
            elapsed_s=elapsed,
            error=f"{type(exc).__name__}: {exc}",
            source_label=f"{backend}:error",
            fell_back_from=None,
        )


# ---------------------------------------------------------------------------
# Markdown emitter
# ---------------------------------------------------------------------------

def _emit_markdown(prompts: list[Prompt], results: dict[str, dict[str, CallResult]]) -> str:
    """Render the bake-off report. `results[prompt.name][backend]` is a CallResult."""
    lines: list[str] = []
    lines.append("# LLM Backend Bake-Off Report")
    lines.append("")
    lines.append(f"_Generated: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}_")
    lines.append("")
    lines.append(
        "Purpose: pick per-block winner before flipping "
        "`LLM_PRIMARY_<BLOCK>` on the droplet for the 2026-09-27 Sonar sunset. "
        "Each row calls the exact same prompt through all three backends "
        "(Sonar / Anthropic / Agent API) with fallback disabled so per-backend "
        "output is honest."
    )
    lines.append("")

    # Summary table first
    lines.append("## Summary")
    lines.append("")
    header = "| Block | " + " | ".join(f"Sonar" if b == "sonar" else "Anthropic" if b == "anthropic" else "Agent API" for b in BACKENDS) + " |"
    lines.append(header)
    lines.append("|---" + "|---" * len(BACKENDS) + "|")
    for p in prompts:
        row = [f"**{p.name}**"]
        for b in BACKENDS:
            r = results[p.name][b]
            cell = f"{'OK' if r.ok else 'FAIL'} — {r.elapsed_s:.2f}s"
            if not r.ok:
                cell += f" _{r.error.split(':', 1)[0]}_"
            row.append(cell)
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")

    # Detail sections
    for p in prompts:
        lines.append(f"## Block: `{p.name}` (block_kind=`{p.block_kind}`)")
        lines.append("")
        lines.append("### Prompt")
        lines.append("```")
        lines.append(f"[system] {p.system}")
        lines.append("")
        lines.append(f"[user] {p.prompt}")
        lines.append("```")
        lines.append("")
        for b in BACKENDS:
            r = results[p.name][b]
            title = {"sonar": "Sonar (`sonar-pro`)",
                     "anthropic": "Anthropic (Claude)",
                     "agent-api": "Perplexity Agent API"}[b]
            lines.append(f"### {title} — `{r.source_label}`")
            lines.append("")
            lines.append(f"_elapsed: {r.elapsed_s:.2f}s_")
            if r.fell_back_from:
                lines.append(f"")
                lines.append(f"_(fallback fired from `{r.fell_back_from}`)_")
            lines.append("")
            if r.ok:
                # Fence the response so markdown doesn't re-render it
                lines.append("```")
                lines.append(r.text)
                lines.append("```")
            else:
                lines.append(f"**FAILED:** `{r.error}`")
            lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=Path("/tmp/llm_bakeoff.md"),
                        help="Where to write the Markdown report.")
    parser.add_argument("--only", type=str, default=None,
                        help="Run only the named block (topics|digest|period_summary|translate).")
    parser.add_argument("--strict", action="store_true",
                        help="Exit non-zero if any single call fails. Default: soft-fail per call.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    prompts = PROMPTS
    if args.only:
        prompts = [p for p in PROMPTS if p.name == args.only]
        if not prompts:
            logger.error("--only=%s did not match any prompt. Available: %s",
                         args.only, ", ".join(p.name for p in PROMPTS))
            return 2

    results: dict[str, dict[str, CallResult]] = {}
    any_failed = False
    for p in prompts:
        logger.info("---- prompt: %s ----", p.name)
        results[p.name] = {}
        for b in BACKENDS:
            logger.info("  -> backend %s", b)
            r = _run_one(p, b)
            results[p.name][b] = r
            if not r.ok:
                any_failed = True
                logger.warning("     FAIL: %s", r.error)
            else:
                logger.info("     OK (%.2fs, %d chars)", r.elapsed_s, len(r.text))

    md = _emit_markdown(prompts, results)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(md, encoding="utf-8")
    logger.info("Wrote report: %s (%d bytes)", args.out, args.out.stat().st_size)

    if args.strict and any_failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
