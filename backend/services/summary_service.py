"""
Summary generation service — Claude API (claude-3-5-haiku-latest).

Two API calls per game per ingestion run:
  1. Executive summary   — 3-4 sentence paragraph for leadership
  2. Recommended actions — 3-5 numbered action items for the team

Both calls use the exact prompt templates defined in the project spec.

Graceful degradation:
  - ANTHROPIC_API_KEY missing → return clearly-labelled placeholder strings.
  - Any API / network error   → log, return placeholder, never raise.
  - anthropic package missing → log, return placeholder.

This means a missing or broken Claude key never stops the ingestion pipeline.

CLAUDE.md §25 — anti-confabulation contract (CRITICAL):
  This older summary-service path (used by per-day DailySummary generation
  in the ingestor) is on the SAME §25 contract as period_summary_service.
  Any claim in exec_summary or recommended_actions must be classified HARD
  or COMMUNITY-OBSERVED and verified by quoting the supporting passage from
  a cited source.  When refactoring this file, port the verification gate
  from period_summary_service.py.  Read CLAUDE.md §25 first.
"""
import logging
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)

_MODEL = "claude-haiku-4-5-20251001"
_MAX_TOKENS_SUMMARY = 400
_MAX_TOKENS_ACTIONS = 600


# ── Public API ────────────────────────────────────────────────────────────────

def generate_summaries(
    game_name: str,
    top_positive_topics: list[str],
    top_negative_topics: list[str],
    top_neutral_topics: list[str],
    trend_delta: Optional[float],
    total_posts: int,
    # Enriched topic data: list of (topic_label, trend_direction_str) tuples.
    # When provided, trend directions are included in the actions prompt.
    # Falls back to labelling all trends as "stable" when omitted.
    positive_with_trend: Optional[list[tuple[str, str]]] = None,
    negative_with_trend: Optional[list[tuple[str, str]]] = None,
    neutral_with_trend:  Optional[list[tuple[str, str]]] = None,
) -> tuple[str, str]:
    """
    Generate an executive summary paragraph and a recommended-actions list
    for one game's daily sentiment data.

    Returns:
        (executive_summary: str, recommended_actions: str)
    """
    if not _resolve_api_key():
        logger.warning(
            "ANTHROPIC_API_KEY not configured — returning placeholder summaries. "
            "Add the key to .env to enable AI-generated content."
        )
        return (
            _placeholder_summary(game_name, total_posts, trend_delta),
            _placeholder_actions(),
        )

    client = _get_client()
    if client is None:
        return (
            _placeholder_summary(game_name, total_posts, trend_delta),
            _placeholder_actions(),
        )

    # Build trend-enriched lists, falling back to "stable" when not supplied
    neg_trend = negative_with_trend or [(t, "stable") for t in top_negative_topics]
    neu_trend = neutral_with_trend  or [(t, "stable") for t in top_neutral_topics]
    pos_trend = positive_with_trend or [(t, "stable") for t in top_positive_topics]

    exec_summary = _call_executive_summary(
        client,
        game_name=game_name,
        top_positive=top_positive_topics,
        top_negative=top_negative_topics,
        top_neutral=top_neutral_topics,
        trend_delta=trend_delta,
        total_posts=total_posts,
    )

    rec_actions = _call_recommended_actions(
        client,
        game_name=game_name,
        negative_with_trend=neg_trend,
        neutral_with_trend=neu_trend,
        positive_with_trend=pos_trend,
    )

    return exec_summary, rec_actions


# ── Claude API calls ──────────────────────────────────────────────────────────

def _call_executive_summary(
    client,
    game_name: str,
    top_positive: list[str],
    top_negative: list[str],
    top_neutral:  list[str],
    trend_delta:  Optional[float],
    total_posts:  int,
) -> str:
    """
    Prompt (from project spec):

    You are a game industry analyst. Given the following daily sentiment data
    for the game "{game_name}", write a 3-4 sentence executive summary suitable
    for a publisher's leadership team. Be factual and concise.

    Data:
    Positive topics today: {top_positive_topics}
    Negative topics today: {top_negative_topics}
    Neutral topics today:  {top_neutral_topics}
    Net sentiment change vs yesterday: {trend_delta:+.1%}
    Total posts analyzed: {total_posts}

    Write only the summary paragraph. Do not use bullet points.
    """
    delta_str = (
        f"{trend_delta:+.1%}" if trend_delta is not None
        else "N/A (first day of data)"
    )
    pos_str = ", ".join(top_positive) if top_positive else "none identified"
    neg_str = ", ".join(top_negative) if top_negative else "none identified"
    neu_str = ", ".join(top_neutral)  if top_neutral  else "none identified"

    prompt = (
        f"You are a game industry analyst. Given the following daily sentiment "
        f"data for the game \"{game_name}\", write a 3-4 sentence executive "
        f"summary suitable for a publisher's leadership team. "
        f"Be factual and concise.\n\n"
        f"Data:\n"
        f"Positive topics today: {pos_str}\n"
        f"Negative topics today: {neg_str}\n"
        f"Neutral topics today: {neu_str}\n"
        f"Net sentiment change vs yesterday: {delta_str}\n"
        f"Total posts analyzed: {total_posts}\n\n"
        f"Write only the summary paragraph. Do not use bullet points."
    )

    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_SUMMARY,
            messages=[{"role": "user", "content": prompt}],
        )
        text = message.content[0].text.strip()
        logger.debug(
            "Executive summary generated for '%s' (%d chars).",
            game_name, len(text),
        )
        return text
    except Exception as exc:
        logger.error(
            "Claude API error generating executive summary for '%s': %s",
            game_name, exc,
        )
        return _placeholder_summary(game_name, total_posts, trend_delta)


def _call_recommended_actions(
    client,
    game_name: str,
    negative_with_trend: list[tuple[str, str]],
    neutral_with_trend:  list[tuple[str, str]],
    positive_with_trend: list[tuple[str, str]],
) -> str:
    """
    Prompt (from project spec):

    You are a game community manager and product strategist. Based on the
    following negative and neutral sentiment topics for "{game_name}", write
    3-5 specific, actionable recommended actions the publisher or development
    team should take. For each recommendation, note whether it addresses a
    negative issue trending worse, a neutral issue at risk of turning negative,
    or how to amplify an existing positive trend.

    Negative topics (with trend): {negative_topics_with_trend}
    Neutral topics (with trend):  {neutral_topics_with_trend}
    Positive topics (with trend): {positive_topics_with_trend}

    Format as a numbered list. Each item should be 1-2 sentences maximum.
    """
    def _fmt(items: list[tuple[str, str]]) -> str:
        if not items:
            return "none identified"
        return "; ".join(f"{label} ({direction})" for label, direction in items)

    prompt = (
        f"You are a game community manager and product strategist. Based on the "
        f"following negative and neutral sentiment topics for \"{game_name}\", "
        f"write 3-5 specific, actionable recommended actions the publisher or "
        f"development team should take. For each recommendation, note whether it "
        f"addresses a negative issue trending worse, a neutral issue at risk of "
        f"turning negative, or how to amplify an existing positive trend.\n\n"
        f"Negative topics (with trend): {_fmt(negative_with_trend)}\n"
        f"Neutral topics (with trend): {_fmt(neutral_with_trend)}\n"
        f"Positive topics (with trend): {_fmt(positive_with_trend)}\n\n"
        f"Format as a numbered list. Each item should be 1-2 sentences maximum."
    )

    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_ACTIONS,
            messages=[{"role": "user", "content": prompt}],
        )
        text = message.content[0].text.strip()
        logger.debug(
            "Recommended actions generated for '%s' (%d chars).",
            game_name, len(text),
        )
        return text
    except Exception as exc:
        logger.error(
            "Claude API error generating recommended actions for '%s': %s",
            game_name, exc,
        )
        return _placeholder_actions()


# ── Client factory ────────────────────────────────────────────────────────────

def _resolve_api_key() -> str:
    """
    Return the Anthropic API key, reading the .env file directly when the
    value from settings is empty.

    This is necessary because the Claude Code CLI shell sets
    ANTHROPIC_API_KEY='' in the process environment, which pydantic-settings
    reads with higher priority than the .env file, leaving settings.anthropic_api_key
    as an empty string even when the key is present in .env.

    dotenv_values() reads the file without touching os.environ, so it always
    returns the raw file value regardless of what the shell has set.

    Paths are resolved relative to this file's location (not the process cwd)
    so the lookup works regardless of where uvicorn was launched from.
    """
    if settings.anthropic_api_key:
        return settings.anthropic_api_key
    try:
        import os  # noqa: PLC0415
        from dotenv import dotenv_values  # noqa: PLC0415

        # services/summary_service.py → services/ → backend/ → project root
        services_dir = os.path.dirname(os.path.abspath(__file__))
        backend_dir  = os.path.dirname(services_dir)
        project_root = os.path.dirname(backend_dir)

        for env_path in (
            os.path.join(project_root, ".env"),   # <project>/.env  (primary)
            os.path.join(backend_dir,  ".env"),   # <project>/backend/.env (fallback)
        ):
            if os.path.exists(env_path):
                key = dotenv_values(env_path).get("ANTHROPIC_API_KEY", "")
                if key:
                    return key
    except Exception:
        pass
    return ""


def _get_client():
    """Return an Anthropic client, or None if the package is unavailable."""
    try:
        import anthropic  # noqa: PLC0415
        # Pin base_url to the real Anthropic API endpoint so the client is
        # never affected by proxy env-vars (e.g. ANTHROPIC_BASE_URL) set by
        # other tools in the shell environment.
        return anthropic.Anthropic(
            api_key=_resolve_api_key(),
            base_url="https://api.anthropic.com",
        )
    except ImportError:
        logger.error(
            "The 'anthropic' package is not installed. "
            "Run: pip install anthropic"
        )
        return None


# ── Placeholder fallbacks ─────────────────────────────────────────────────────

def _placeholder_summary(
    game_name: str,
    total_posts: int,
    trend_delta: Optional[float],
) -> str:
    delta_str = f"{trend_delta:+.1%}" if trend_delta is not None else "N/A"
    return (
        f"[AI summary unavailable — configure ANTHROPIC_API_KEY to enable.] "
        f"{total_posts} community posts were analysed for {game_name} today. "
        f"Net sentiment change vs yesterday: {delta_str}."
    )


def _placeholder_actions() -> str:
    return (
        "1. [AI actions unavailable — configure ANTHROPIC_API_KEY to enable.]\n"
        "2. Review negative topics manually and prioritise high-velocity issues.\n"
        "3. Amplify positive community feedback through official channels."
    )
