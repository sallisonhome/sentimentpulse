"""
Period-based summary generation service.

Provides:
  - generate_monthly_summary(db, game_id, year, month) -> MonthlySummary
  - generate_window_summary(db, game_id, days=7) -> WindowSummary

Both call Claude via _call_claude_for_period() which is cache-unaware;
the caching layer is implemented here before calling Claude.

Bold ideas: gracefully returns [] when Claude responds with "NONE".
"""
import logging
import re
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from config import settings
from models import (
    Game,
    MonthlySummary,
    RawPost,
    SentimentEnum,
    SentimentRecord,
    WindowSummary,
)

logger = logging.getLogger(__name__)

_MODEL = "claude-haiku-4-5-20251001"
_MAX_TOKENS_SUMMARY = 500
# Tightened from 700 → 350 to discourage verbose multi-clause recommendations.
# With the 25-word-per-item budget, 5 items × ~40 tokens = 200 tokens; 350 leaves
# comfortable headroom while still capping runaway prose.
_MAX_TOKENS_ACTIONS = 350
_MAX_TOKENS_BOLD = 400

MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


# ── Public API ────────────────────────────────────────────────────────────────

def generate_monthly_summary(
    db: Session,
    game_id: int,
    year: int,
    month: int,
) -> MonthlySummary:
    """
    Generate (or return existing) a MonthlySummary for (game_id, year, month).

    Window covers [first-of-month, last-of-month] inclusive, using
    COALESCE(post_date, collected_at) to assign each post to the day it was posted.
    """
    game: Optional[Game] = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise ValueError(f"Game {game_id} not found.")

    # Build window dates
    _, last_day = monthrange(year, month)
    window_start = date(year, month, 1)
    window_end   = date(year, month, last_day)

    window_label = f"{MONTH_NAMES[month]} {year}"

    # Compute stats
    pos, neg, neu, top_pos, top_neg, top_neu = _aggregate_posts(
        db, game_id, window_start, window_end
    )
    total = pos + neg + neu

    # Call Claude (even if total==0; let the LLM handle sparse data gracefully)
    exec_summary, rec_actions, bold_ideas = _call_claude_for_period(
        game_name=game.name,
        window_label=window_label,
        pos_topics=top_pos,
        neg_topics=top_neg,
        neu_topics=top_neu,
        total_posts=total,
    )

    # Upsert
    existing: Optional[MonthlySummary] = (
        db.query(MonthlySummary)
        .filter_by(game_id=game_id, period_year=year, period_month=month)
        .first()
    )
    if existing:
        existing.positive_count = pos
        existing.negative_count = neg
        existing.neutral_count = neu
        existing.total_posts = total
        existing.top_positive_topics = top_pos
        existing.top_negative_topics = top_neg
        existing.top_neutral_topics = top_neu
        existing.executive_summary = exec_summary
        existing.recommended_actions = rec_actions
        existing.bold_ideas = bold_ideas
        existing.generated_at = datetime.utcnow()
        row = existing
    else:
        row = MonthlySummary(
            game_id=game_id,
            period_year=year,
            period_month=month,
            positive_count=pos,
            negative_count=neg,
            neutral_count=neu,
            total_posts=total,
            top_positive_topics=top_pos,
            top_negative_topics=top_neg,
            top_neutral_topics=top_neu,
            executive_summary=exec_summary,
            recommended_actions=rec_actions,
            bold_ideas=bold_ideas,
        )
        db.add(row)

    db.commit()
    db.refresh(row)
    logger.info(
        "Monthly summary for game=%d %s: pos=%d neg=%d neu=%d total=%d bold=%d",
        game_id, window_label, pos, neg, neu, total, len(bold_ideas or [])
    )
    return row


def generate_window_summary(
    db: Session,
    game_id: int,
    days: int = 7,
) -> WindowSummary:
    """
    Return (cache-hit) or generate a WindowSummary for (game_id, days).

    Finds the latest ingest_date by querying MAX(COALESCE(post_date, collected_at))
    from raw_posts for this game. Window covers [ingest_date - days + 1, ingest_date].

    Cache: if a WindowSummary already exists for (game_id, days, ingest_date), return it.
    """
    game: Optional[Game] = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise ValueError(f"Game {game_id} not found.")

    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)

    # Find the latest date with posts for this game
    max_dt = (
        db.query(func.max(effective_date))
        .filter(RawPost.game_id == game_id)
        .scalar()
    )

    if max_dt is None:
        # No posts at all — use today as anchor
        ingest_date = date.today()
    elif isinstance(max_dt, datetime):
        ingest_date = max_dt.date()
    elif isinstance(max_dt, date):
        ingest_date = max_dt
    else:
        ingest_date = date.today()

    # Cache lookup
    cached: Optional[WindowSummary] = (
        db.query(WindowSummary)
        .filter_by(game_id=game_id, window_days=days, ingest_date=ingest_date)
        .first()
    )
    if cached:
        logger.info(
            "Window summary cache HIT: game=%d days=%d ingest_date=%s",
            game_id, days, ingest_date
        )
        return cached

    # Generate
    window_start = ingest_date - timedelta(days=days - 1)
    window_end   = ingest_date

    # Build window label for Claude prompt
    start_str = window_start.strftime("%-d %b")
    end_str   = ingest_date.strftime("%-d %b, %Y")
    window_label = f"Past {days} days · {start_str} – {end_str}"

    pos, neg, neu, top_pos, top_neg, top_neu = _aggregate_posts(
        db, game_id, window_start, window_end
    )
    total = pos + neg + neu

    exec_summary, rec_actions, bold_ideas = _call_claude_for_period(
        game_name=game.name,
        window_label=window_label,
        pos_topics=top_pos,
        neg_topics=top_neg,
        neu_topics=top_neu,
        total_posts=total,
    )

    row = WindowSummary(
        game_id=game_id,
        window_days=days,
        ingest_date=ingest_date,
        positive_count=pos,
        negative_count=neg,
        neutral_count=neu,
        total_posts=total,
        top_positive_topics=top_pos,
        top_negative_topics=top_neg,
        top_neutral_topics=top_neu,
        executive_summary=exec_summary,
        recommended_actions=rec_actions,
        bold_ideas=bold_ideas,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    logger.info(
        "Window summary MISS → generated: game=%d days=%d ingest_date=%s total=%d",
        game_id, days, ingest_date, total
    )
    return row


# ── Internal helpers ──────────────────────────────────────────────────────────

def _aggregate_posts(
    db: Session,
    game_id: int,
    window_start: date,
    window_end: date,
) -> tuple[int, int, int, list[str], list[str], list[str]]:
    """
    Aggregate sentiment counts and top-5 topics for the given date window.

    Returns (pos, neg, neu, top_positive, top_negative, top_neutral).
    Uses COALESCE(post_date, collected_at) for date filtering.
    """
    # Convert dates to datetimes for comparison with DateTime columns
    start_dt = datetime.combine(window_start, datetime.min.time())
    end_dt   = datetime.combine(window_end,   datetime.max.time())

    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)

    count_rows = (
        db.query(SentimentRecord.sentiment, func.count(SentimentRecord.id))
        .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
        .filter(
            RawPost.game_id == game_id,
            effective_date >= start_dt,
            effective_date <= end_dt,
        )
        .group_by(SentimentRecord.sentiment)
        .all()
    )

    count_map: dict[str, int] = {s.value: c for s, c in count_rows}
    pos = count_map.get("positive", 0)
    neg = count_map.get("negative", 0)
    neu = count_map.get("neutral", 0)

    # Collect top-5 topics per sentiment from SentimentRecord.topics (JSON lists)
    def _top_topics(sentiment: SentimentEnum) -> list[str]:
        rows = (
            db.query(SentimentRecord.topics)
            .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
            .filter(
                RawPost.game_id == game_id,
                SentimentRecord.sentiment == sentiment,
                effective_date >= start_dt,
                effective_date <= end_dt,
            )
            .all()
        )
        freq: dict[str, int] = {}
        for (topics,) in rows:
            for topic in (topics or []):
                freq[topic] = freq.get(topic, 0) + 1
        return [t for t, _ in sorted(freq.items(), key=lambda x: -x[1])[:5]]

    top_pos = _top_topics(SentimentEnum.positive)
    top_neg = _top_topics(SentimentEnum.negative)
    top_neu = _top_topics(SentimentEnum.neutral)

    return pos, neg, neu, top_pos, top_neg, top_neu


def _call_claude_for_period(
    game_name: str,
    window_label: str,
    pos_topics: list[str],
    neg_topics: list[str],
    neu_topics: list[str],
    total_posts: int,
) -> tuple[str, Optional[str], list[str]]:
    """
    Call Claude for (exec_summary, recommended_actions, bold_ideas).

    Returns placeholder strings if the API key is missing or calls fail.
    recommended_actions: Optional[str] — None when Claude returns NONE or all
      content was meta-leak (frontend hides the section).
    bold_ideas: list[str] — empty list when Claude returns "NONE" or all
      candidates were filtered out by quality checks.
    """
    client = _get_client()
    if client is None:
        return (
            _placeholder_summary(game_name, window_label, total_posts),
            _placeholder_actions(),
            [],
        )

    # Quarantine poisoned topic labels before they reach the LLM. Any label
    # containing a forbidden-concept token (free-to-play / battle pass /
    # monetization / etc.) is dropped so Claude can't anchor a summary on it.
    # If quarantining empties a sentiment's list, we substitute a generic
    # fallback so the LLM still has something to talk about.
    pos_topics = _quarantine_topics(pos_topics)
    neg_topics = _quarantine_topics(neg_topics)
    neu_topics = _quarantine_topics(neu_topics)

    pos_str = ", ".join(pos_topics) if pos_topics else "General positive sentiment"
    neg_str = ", ".join(neg_topics) if neg_topics else "No clear negative signals"
    neu_str = ", ".join(neu_topics) if neu_topics else "General neutral discussion"

    exec_summary  = _call_exec(client, game_name, window_label, pos_str, neg_str, neu_str, total_posts)
    rec_actions   = _call_actions(client, game_name, window_label, pos_str, neg_str, neu_str)
    bold_ideas    = _call_bold_ideas(client, game_name, window_label, pos_str, neg_str, neu_str, total_posts)

    return exec_summary, rec_actions, bold_ideas


# ── Topic-label quarantine (CLAUDE.md §13 defense in depth) ─────────────────────
# Even after the humanization filter, older DB rows may still hold poisoned
# topic labels (e.g. "Free to Play Model" attributed to a non-F2P game). We
# drop these on the way into the summary prompts so the LLM never sees them.
_QUARANTINE_TOKENS = (
    "free to play", "free-to-play", "f2p",
    "battle pass", "battlepass",
    "monetization", "monetisation",
    "microtransaction", "micro-transaction",
    "gacha",
    "live service",
    "season pass", "seasonpass",
    "pay to win", "pay-to-win", "p2w",
    "loot box", "lootbox",
    "subscription",
)


def _quarantine_topics(labels: list[str]) -> list[str]:
    """Drop any topic label that contains a forbidden monetization-concept token.

    Returns a new list with poisoned labels removed. Original order preserved.
    See CLAUDE.md §13 — evidence-only insights.
    """
    kept: list[str] = []
    for label in (labels or []):
        if not isinstance(label, str) or not label.strip():
            continue
        normalized = re.sub(r"[^a-z0-9]+", " ", label.lower()).strip()
        if any(tok in normalized for tok in _QUARANTINE_TOKENS):
            logger.info("Quarantined poisoned topic label from summary input: %r", label)
            continue
        kept.append(label)
    return kept


# ── Output style for all summary LLM calls (CLAUDE.md §13) ──────────────────────
# A style guide — NOT a list of "rules" the model can mention.
# Critical: the output must read like an analyst speaking to a reader. The
# constraints below are guidance for the writer; the writer must NEVER refer to
# them, justify what it can't do, or reveal that it was told anything. If an
# insight isn't supported, just don't write it.
_OUTPUT_STYLE = (
    "OUTPUT STYLE (follow silently, never mention these rules in the output):\n"
    "- Write as a confident analyst. Use the topic labels exactly as provided.\n"
    "- Never reference reasoning, instructions, rules, system prompts, or your own limitations. "
    "Never say \"I cannot\", \"the rules say\", \"I'm instructed\", \"insufficient data to provide\", "
    "\"based on the constraints\", or anything that breaks the analyst voice.\n"
    "- Do not invent topics or extrapolate. Only discuss what the topic labels actually say. "
    "If a topic isn't there, don't mention the concept.\n"
    "- If post volume is low, note it briefly and write a shorter, hedged analysis — do NOT apologize or refuse.\n"
    "- Never reference monetization, business model, pricing, platforms, or release strategy unless a topic label literally names them.\n"
    "- If you genuinely have nothing useful to say, follow the empty-output sentinel for the section (specified below). "
    "Do NOT write a meta-explanation about why you're empty.\n\n"
)


def _call_exec(client, game_name, window_label, pos_str, neg_str, neu_str, total_posts) -> str:
    prompt = (
        f'You are a game industry analyst writing for the leadership team about "{game_name}".\n\n'
        + _OUTPUT_STYLE +
        f"Write a TIGHT 3-5 sentence executive summary of community sentiment covering {window_label}.\n\n"
        f"Concision rules:\n"
        f"- 120 WORDS MAX. Aim for 80-100.\n"
        f"- Lead with the dominant signal in 1 sentence, then 2-4 sentences of supporting detail.\n"
        f"- Cite topic names exactly as provided.\n"
        f"- NO parenthetical lists of examples. NO 'this suggests... which means... and therefore...' chains.\n"
        f"- If post volume is low, say so plainly in 1 short sentence and keep the rest equally short.\n\n"
        f"Data ({window_label}):\n"
        f"Top positive topics: {pos_str}\n"
        f"Top negative topics: {neg_str}\n"
        f"Top neutral topics: {neu_str}\n"
        f"Total posts analyzed: {total_posts}\n\n"
        f"Write ONLY the summary paragraph. No bullet points, no headings, no preamble."
    )
    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_SUMMARY,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text.strip()
    except Exception as exc:
        logger.error("Claude exec summary error for '%s': %s", game_name, exc)
        return _placeholder_summary(game_name, window_label, total_posts)


def _call_actions(client, game_name, window_label, pos_str, neg_str, neu_str) -> str:
    prompt = (
        f'You are a game community manager and product strategist for "{game_name}".\n\n'
        + _OUTPUT_STYLE +
        f"Write 3-5 sprint-board-ready recommendations. Each one MUST follow this format strictly:\n\n"
        f"  <Imperative verb> **<exact topic label>** — <what to do, in <=15 words>.\n\n"
        f"Hard concision rules:\n"
        f"- 25 WORDS MAX per recommendation. Aim for 15-20.\n"
        f"- Start with an imperative verb (Ship, Patch, Audit, Launch, Amplify, Clarify, Document, Sunset, etc.).\n"
        f"- Bold the topic label exactly as provided, using **double asterisks**.\n"
        f"- NO parenthetical examples, NO 'this is your clearest signal' framing, NO 'should anchor messaging through next quarter' filler.\n"
        f"- ONE sentence per recommendation. No semicolons. No 'and... and...' chains. If you need two ideas, write two recommendations.\n\n"
        f"Good example:\n"
        f"  1. Ship **John Wick vs Competition** head-to-head feature comparisons in community channels.\n"
        f"  2. Patch **Horror & Suspense Elements** difficulty spikes flagged in negative cluster.\n\n"
        f"Bad example (too verbose, has parenthetical and filler):\n"
        f"  1. Lean into **John Wick vs Competition** momentum by shipping comparative feature breakdowns (kill-cam mechanics, precision controls, level design philosophy) that reinforce differentiation—this positive signal is your clearest community validation point and should anchor messaging through next quarter.\n\n"
        f"If you genuinely cannot produce 3+ actionable recommendations from the available topics, "
        f"respond with the SINGLE LINE: NONE — nothing else, no explanation.\n\n"
        f"Data ({window_label}):\n"
        f"Negative topics: {neg_str}\n"
        f"Neutral topics: {neu_str}\n"
        f"Positive topics: {pos_str}\n\n"
        f"Output: numbered list (1. ... 2. ... 3. ...). Plain prose, no markdown headings."
    )
    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_ACTIONS,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        return _parse_recommended_actions(raw)
    except Exception as exc:
        logger.error("Claude actions error for '%s': %s", game_name, exc)
        return _placeholder_actions()


def _call_bold_ideas(client, game_name, window_label, pos_str, neg_str, neu_str, total_posts) -> list[str]:
    prompt = (
        f'You are a creative game marketing strategist for "{game_name}". '
        f"Looking at community signals from {window_label}, find opportunities a typical analyst would MISS.\n\n"
        + _OUTPUT_STYLE +
        f"If — and only if — the topic labels reveal something genuinely worth flagging as a bold move "
        f"beyond the obvious fixes, propose 1 or 2 bold ideas.\n\n"
        f"Concision rules:\n"
        f"- 40 WORDS MAX per idea. Aim for 25-30.\n"
        f"- One sentence stating the bold move, optionally one second sentence on why.\n"
        f"- Bold the referenced topic label exactly as provided, using **double asterisks**.\n"
        f"- Be surprising or non-obvious (community event, partnership angle, unexpected creative response).\n"
        f"- NO 'this is your X' framing. NO 'compounds loyalty' or 'lock in goodwill' filler.\n\n"
        f"If nothing in the data clearly supports a bold idea, respond with the SINGLE LINE: NONE — nothing else. "
        f"Most periods should return NONE. Only fire when there is a real signal.\n\n"
        f"Data ({window_label}):\n"
        f"Positive topics: {pos_str}\n"
        f"Negative topics: {neg_str}\n"
        f"Neutral topics: {neu_str}\n"
        f"Total posts: {total_posts}\n\n"
        f"Format (when ideas exist):\n"
        f"1. <Tight bold idea naming a **topic label**, 25-40 words>\n"
        f"2. <Optional second>\n\n"
        f"No markdown headings. No \"# Analysis\" or \"## Key Observation\" sections. "
        f"No preamble. Either the numbered list, or NONE."
    )
    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_BOLD,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        return _parse_bold_ideas(raw)
    except Exception as exc:
        logger.error("Claude bold ideas error for '%s': %s", game_name, exc)
        return []


# ── Output parsers ─────────────────────────────────────────────────────────────────────────

# Phrases that indicate the LLM is breaking the analyst voice with a meta-
# explanation of why it cannot do something. Any line/idea containing one of
# these is dropped from parsed output.
#
# We deliberately use non-word-boundary anchors so that markdown decoration
# like "**Reason:**" still matches. Each pattern is tested as a substring
# against the lowercased text.
_META_LEAK_PHRASES = (
    "i cannot",
    "i'm instructed",
    "i am instructed",
    "the rules say",
    "the rule says",
    "insufficient data to provide",
    "based on the constraints",
    "based on the rules",
    "reason:",
    "what would help:",
    "forbidden by rule",
    "business model concept i'm",
    "per the rules",
    "per the guidelines",
    "per the instructions",
    "i don't have enough",
    "i lack sufficient",
    "i'm not able to",
    "unable to provide",
    "cannot provide actionable",
    "cannot generate",
    "rule 1", "rule 2", "rule 3", "rule 4", "rule 5",
)

# A bold idea must look like substantive prose. Drop anything that's a markdown
# heading, bullet decoration, or too short to be a real idea.
_MARKDOWN_HEADING_OR_DECORATION = re.compile(r"^\s*(#{1,6}\s|[-*•]\s*$|\*{1,3}\s*$)")


def _looks_like_meta_leak(text: str) -> bool:
    """True if the text contains an analyst-voice-breaking meta-explanation.

    Substring match against a lowercased copy of the text so markdown decoration
    like "**Reason:**" and bullet prefixes don't hide the leak.
    """
    if not text:
        return False
    lower = text.lower()
    return any(phrase in lower for phrase in _META_LEAK_PHRASES)


def _is_markdown_heading_or_too_short(text: str) -> bool:
    """True if the text is a markdown heading or too short to be a real item.

    Filters out things like "# Analysis", "## Key Observation", or short stubs
    that result from accidentally splitting a structured response into items.
    """
    stripped = (text or "").strip()
    if not stripped:
        return True
    if _MARKDOWN_HEADING_OR_DECORATION.match(stripped):
        return True
    # Strip leading markdown bullet/heading characters to assess real length
    plain = re.sub(r"^[#*\-•\s]+", "", stripped)
    if len(plain) < 30:
        return True
    return False


def _parse_bold_ideas(raw: str) -> list[str]:
    """
    Parse Claude's bold ideas response.

    Returns [] when:
      - response is "NONE" (case-insensitive, trimmed),
      - all extracted candidate items are filtered out by quality checks.

    Parses numbered list ("1. ...\n2. ...") into list[str], then drops:
      - markdown headings or bullet decoration ("# Analysis", "## Key Observation")
      - items shorter than 30 chars (likely stub headers)
      - items containing meta-leak phrases ("I cannot", "the rules say", etc.)
    """
    if not raw or raw.strip().upper().startswith("NONE"):
        return []

    candidates: list[str] = []
    # Try numbered list pattern first
    items = re.findall(r"^\d+\.\s+(.+?)(?=\n\d+\.|\Z)", raw, re.MULTILINE | re.DOTALL)
    if items:
        candidates = [item.strip() for item in items]
    else:
        # Fallback: split on newlines
        for line in raw.splitlines():
            line = re.sub(r"^\d+\.\s*", "", line.strip())
            if line:
                candidates.append(line)

    # Quality filter: drop headings, stubs, and meta-leak items
    cleaned: list[str] = []
    for c in candidates:
        if _is_markdown_heading_or_too_short(c):
            logger.info("Bold idea dropped (heading/too short): %r", c[:80])
            continue
        if _looks_like_meta_leak(c):
            logger.info("Bold idea dropped (meta-leak): %r", c[:80])
            continue
        cleaned.append(c)

    return cleaned


def _parse_recommended_actions(raw: str) -> Optional[str]:
    """
    Parse Claude's recommended-actions response.

    Returns None when:
      - response is "NONE" (case-insensitive, trimmed),
      - after filtering meta-leak content, nothing actionable remains.

    Otherwise returns the cleaned actions string (markdown-friendly).
    Meta-leak sentences ("I cannot provide actionable...", "Reason: ...",
    "What would help: ...") are stripped from the body. If stripping leaves
    the body too short to be useful, the whole thing collapses to None.
    """
    if not raw:
        return None
    stripped_full = raw.strip()
    if stripped_full.upper().startswith("NONE"):
        return None

    # Split into lines/paragraphs and filter out meta-leak lines
    out_lines: list[str] = []
    for line in stripped_full.splitlines():
        # Drop a line entirely if it is meta-leak. We are deliberately
        # aggressive here — the cost of dropping a borderline line is low,
        # the cost of leaving the user staring at "I cannot recommend" is high.
        if _looks_like_meta_leak(line):
            logger.info("Recommendation line dropped (meta-leak): %r", line[:80])
            continue
        out_lines.append(line)

    cleaned = "\n".join(out_lines).strip()

    # If the cleanup left us with effectively nothing (just a numbered-list
    # scaffold, or fewer than ~40 chars of substantive content), return None
    # so the frontend hides the section entirely instead of showing a stub.
    plain = re.sub(r"[\s\d.\-*#]+", " ", cleaned).strip()
    if len(plain) < 40:
        logger.info("Recommended actions collapsed to None after meta-leak filter")
        return None

    return cleaned


# ── Claude client factory ─────────────────────────────────────────────────────

def _get_client():
    """Return an Anthropic client, or None if key is missing / package absent."""
    api_key = _resolve_api_key()
    if not api_key:
        logger.warning(
            "ANTHROPIC_API_KEY not configured — returning placeholder summaries."
        )
        return None
    try:
        import anthropic  # noqa: PLC0415
        return anthropic.Anthropic(
            api_key=api_key,
            base_url="https://api.anthropic.com",
        )
    except ImportError:
        logger.error("'anthropic' package not installed. Run: pip install anthropic")
        return None
    except Exception as exc:
        logger.error("Failed to initialise Anthropic client: %s", exc)
        return None


def _resolve_api_key() -> str:
    if settings.anthropic_api_key:
        return settings.anthropic_api_key
    try:
        import os
        from dotenv import dotenv_values

        services_dir = os.path.dirname(os.path.abspath(__file__))
        backend_dir  = os.path.dirname(services_dir)
        project_root = os.path.dirname(backend_dir)

        for env_path in (
            os.path.join(project_root, ".env"),
            os.path.join(backend_dir,  ".env"),
        ):
            if os.path.exists(env_path):
                key = dotenv_values(env_path).get("ANTHROPIC_API_KEY", "")
                if key:
                    return key
    except Exception:
        pass
    return ""


# ── Placeholder fallbacks ─────────────────────────────────────────────────────

def _placeholder_summary(game_name: str, window_label: str, total_posts: int) -> str:
    return (
        f"[AI summary unavailable — configure ANTHROPIC_API_KEY to enable.] "
        f"{total_posts} community posts were analysed for {game_name} during {window_label}."
    )


def _placeholder_actions() -> str:
    return (
        "1. [AI actions unavailable — configure ANTHROPIC_API_KEY to enable.]\n"
        "2. Review negative topics manually and prioritise high-velocity issues.\n"
        "3. Amplify positive community feedback through official channels."
    )
