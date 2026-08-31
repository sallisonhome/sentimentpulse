"""
Executive digest service — weekly + monthly.

Builds an agency-grade HTML email summarizing the priority Saber titles.
Each title's section presents:

    1. Metrics strip       — total posts · pos/neg/neu counts · pos:neg ratio
    2. Executive Summary   — narrative paragraph from WindowSummary
    3. Recommended Actions — sprint-board-ready items
    4. Big Ideas to Consider — bold strategic plays

Weekly:  uses 7-day window-summaries (regenerated if cache is stale)
Monthly: uses MonthlySummary rows for the prior calendar month

Send pipeline: Resend HTTPS API (port 443), mirroring the pattern proven
out in lifetime-class-booker and SlangIt.  DigitalOcean blocks outbound
SMTP ports (25/465/587) on droplets, so SMTP is NOT a viable transport
in production — it would time out silently.  Configuration:

  RESEND_API_KEY  (required)  — https://resend.com API key
  RESEND_FROM     (optional)  — 'Name <addr@domain>'.  Defaults to
                                'SentimentPulse Intelligence <onboarding@resend.dev>',
                                which works immediately without domain
                                verification, BUT Resend's free tier with
                                the default sender only delivers to the
                                Resend account owner's verified email.
                                Verify a domain at resend.com/domains to
                                send to arbitrary recipients.

Retry semantics (matches lifetime bot):
  • 429 (rate limit) or 5xx → retry once after 1.5s backoff
  • Network/DNS/TLS error → retry once
  • 4xx auth/validation → fatal, do NOT retry (config problem)

If RESEND_API_KEY is unset, send_*() returns {"sent": False,
"reason": "resend_not_configured"} without raising — this lets us
deploy + preview before credentials are wired.
"""
from __future__ import annotations

import html
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from models import (
    CompetitorGame,
    DigestRecipient,
    Game,
    MonthlySummary,
    SentimentEnum,
    TopicTrend,
    WindowSummary,
)

logger = logging.getLogger(__name__)


# ── The fixed priority titles (resolved 2026-06-24 against the live DB) ──────
# Locked in code rather than configurable in the UI because:
#  • The user specified an exact list during planning.
#  • Many DLC variants have similar names (e.g. 20 different Space Marine 2
#    cosmetic packs) and we don't want them sneaking into the digest.
# To change the list, edit this constant and ship a release.
#
# 2026-08-17: added Rideshare "Stimulator" (game_id=144). Saber pre-release
# title that the user wants tracked in both weekly and monthly digests.
PRIORITY_TITLES: list[tuple[int, str]] = [
    (24,  "Warhammer 40,000: Space Marine 2"),
    (25,  "John Carpenter's Toxic Commando"),
    (23,  "Turok: Origins"),
    (21,  "Clive Barker's Hellraiser: Revival"),
    (134, "Bus Bound"),
    (131, "HITMAN Classic Trilogy Remastered"),
    (20,  "Untitled John Wick Game"),
    (130, "Stuntman: Hollywood"),
    (144, "Rideshare \"Stimulator\""),
]


# ── Data shape ───────────────────────────────────────────────────────────────

@dataclass
class TitleBlock:
    """One section of the digest — what gets rendered for a single game."""
    game_id: int
    name: str
    total_posts: int
    positive: int
    negative: int
    neutral: int
    pos_neg_ratio: str       # already-formatted display string
    executive_summary: str
    recommended_actions: str
    bold_ideas: list[str]
    period_label: str        # e.g. "Jun 17 – Jun 24, 2026" or "May 2026"
    has_data: bool           # False → render a "no signal" placeholder
    # CLAUDE.md §20 layer 3: maps [P-NNN] tokens in summary text back to
    # source posts.  None (or missing) when row pre-dates citation infra;
    # renderer treats this as a legacy row and leaves tokens unchanged.
    citation_map: Optional[dict] = None
    # CLAUDE.md §24 (2026-06-29): list of EditorialArticle-shaped dicts for
    # this title's cycle.  Each entry: {cite, url, title, publication,
    # published_at, summary}.  Renderer surfaces these as inline [E-NNN]
    # anchor links (handled via _render_citations once the entries are
    # merged into citation_map) AND as a bottom-of-section "Editorial
    # context" footer per the user's hybrid UX decision.
    editorial_articles: Optional[list] = None
    # 2026-08-30: 2-3 competitor-set bullets appended after "Big Ideas"
    # when the parent title has rows in `competitor_games`. Each bullet
    # tilts commentary toward positive-to-negative ratio (weighting
    # positives and negatives, minimizing neutral) and volume ratio
    # relative to the parent. Populated by _build_competitor_bullets
    # for both weekly (WindowSummary) and monthly (MonthlySummary).
    # None means "no competitors configured for this parent"; a non-
    # empty list renders the "Competitive Set" sub-section.
    competitor_bullets: Optional[list] = None

    @property
    def sentiment_tone(self) -> str:
        """One-word tone for the metrics-strip color (positive/negative/neutral)."""
        if self.total_posts == 0:
            return "neutral"
        if self.positive >= 2 * max(self.negative, 1) and self.positive >= 5:
            return "positive"
        if self.negative >= 2 * max(self.positive, 1) and self.negative >= 5:
            return "negative"
        return "neutral"


# ── Helpers ──────────────────────────────────────────────────────────────────

def _format_ratio(positive: int, negative: int) -> str:
    """Render pos:neg as 'X.X:1' or '1:X.X', with sensible edge cases."""
    if positive == 0 and negative == 0:
        return "no signal"
    if negative == 0:
        return f"{positive}:0"
    if positive == 0:
        return f"0:{negative}"
    if positive >= negative:
        return f"{positive / negative:.1f}:1"
    return f"1:{negative / positive:.1f}"


def _weekly_period_label(end_date: date) -> str:
    """e.g. 'Jun 17 – Jun 24, 2026' for end_date=2026-06-24, window=7d."""
    start = end_date - timedelta(days=6)
    if start.year != end_date.year:
        return f"{start.strftime('%b %d, %Y')} – {end_date.strftime('%b %d, %Y')}"
    return f"{start.strftime('%b %d')} – {end_date.strftime('%b %d, %Y')}"


def _monthly_period_label(year: int, month: int) -> str:
    return date(year, month, 1).strftime("%B %Y")


def _prior_month(today: date) -> tuple[int, int]:
    """Return (year, month) for the calendar month before `today`."""
    if today.month == 1:
        return (today.year - 1, 12)
    return (today.year, today.month - 1)


# ── Block builders ───────────────────────────────────────────────────────────

def build_weekly_block(
    db: Session, game_id: int, name: str, today: Optional[date] = None
) -> TitleBlock:
    """
    Fetch the latest 7-day WindowSummary for `game_id`, regenerating if it's
    older than today.  Falls back to an empty placeholder block on failure
    rather than aborting the whole digest.
    """
    today = today or date.today()
    period_label = _weekly_period_label(today)

    summary: Optional[WindowSummary] = None
    try:
        # Try cached first
        summary = (
            db.query(WindowSummary)
            .filter_by(game_id=game_id, window_days=7, ingest_date=today)
            .first()
        )
        if summary is None:
            # Lazy regenerate; same call path as POST /api/games/{id}/window-summary
            from services import period_summary_service as _pss  # noqa: PLC0415
            summary = _pss.generate_window_summary(db, game_id=game_id, days=7)
    except Exception as exc:
        logger.exception("digest: failed to fetch/generate WindowSummary for game_id=%s: %s",
                         game_id, exc)

    if summary is None or summary.total_posts == 0:
        empty_bullets = _build_competitor_bullets(
            db,
            parent_game_id=game_id,
            parent_positive=0, parent_negative=0, parent_total=0,
            parent_name=name,
            period="weekly",
            today=today,
        )
        return TitleBlock(
            game_id=game_id, name=name, total_posts=0,
            positive=0, negative=0, neutral=0,
            pos_neg_ratio="no signal",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label=period_label, has_data=False,
            competitor_bullets=empty_bullets,
        )

    # §24: read the LATEST weekly editorial batch for this title so the
    # renderer can surface [E-NNN] anchor links and the Editorial-context
    # footer.  Most recent cycle wins; we don't filter by cycle_start to
    # cover the case where the digest is rendered on a day after the
    # editorial fetch ran.
    editorial_articles = _load_latest_editorial(db, game_id, scope="weekly")
    # Merge editorial entries into citation_map so [E-NNN] tokens in the
    # persisted bold_ideas / exec / rec text resolve to anchor links.
    summary_cmap = dict(getattr(summary, "citation_map", None) or {})
    if editorial_articles:
        from services.editorial_research_service import editorial_citation_map
        summary_cmap.update(editorial_citation_map(editorial_articles))

    competitor_bullets = _build_competitor_bullets(
        db,
        parent_game_id=game_id,
        parent_positive=summary.positive_count,
        parent_negative=summary.negative_count,
        parent_total=summary.total_posts,
        parent_name=name,
        period="weekly",
        today=today,
    )

    return TitleBlock(
        game_id=game_id, name=name,
        total_posts=summary.total_posts,
        positive=summary.positive_count,
        negative=summary.negative_count,
        neutral=summary.neutral_count,
        pos_neg_ratio=_format_ratio(summary.positive_count, summary.negative_count),
        executive_summary=summary.executive_summary or "",
        recommended_actions=summary.recommended_actions or "",
        bold_ideas=list(summary.bold_ideas or []),
        period_label=period_label, has_data=True,
        citation_map=summary_cmap or None,
        editorial_articles=[
            {
                "cite": a.cite, "url": a.url, "title": a.title,
                "publication": a.publication,
                "published_at": a.published_at,
                "summary": a.summary,
            }
            for a in editorial_articles
        ] if editorial_articles else None,
        competitor_bullets=competitor_bullets,
    )


def _load_latest_editorial(db: Session, game_id: int, scope: str) -> list:
    """§24: load the most recent editorial batch for (game_id, scope).

    Returns [] when no batch exists.  Tolerant of missing table / model
    (e.g. before migrations land in legacy environments) -- in that
    case logs a warning and returns [].
    """
    try:
        from models import EditorialArticle
        latest_cycle = (
            db.query(EditorialArticle.cycle_start)
            .filter(
                EditorialArticle.game_id == game_id,
                EditorialArticle.scope == scope,
            )
            .order_by(EditorialArticle.cycle_start.desc())
            .first()
        )
        if not latest_cycle:
            return []
        cycle_start = latest_cycle[0]
        rows = (
            db.query(EditorialArticle)
            .filter_by(game_id=game_id, scope=scope, cycle_start=cycle_start)
            .order_by(EditorialArticle.cite)
            .all()
        )
        return list(rows)
    except Exception as exc:
        logger.info(
            "§24: editorial load skipped (game_id=%d scope=%s): %s",
            game_id, scope, exc,
        )
        return []


def build_monthly_block(
    db: Session, game_id: int, name: str, year: int, month: int
) -> TitleBlock:
    """Fetch the MonthlySummary for (game_id, year, month).  Does NOT generate
    — monthly summaries are produced as part of the ingestor's Step 9 on the
    first day of each month, so by the time the digest runs they should exist."""
    period_label = _monthly_period_label(year, month)

    row: Optional[MonthlySummary] = None
    try:
        row = (
            db.query(MonthlySummary)
            .filter_by(game_id=game_id, period_year=year, period_month=month)
            .first()
        )
    except Exception as exc:
        logger.exception("digest: failed MonthlySummary lookup for game_id=%s y=%s m=%s: %s",
                         game_id, year, month, exc)

    if row is None or row.total_posts == 0:
        empty_bullets = _build_competitor_bullets(
            db,
            parent_game_id=game_id,
            parent_positive=0, parent_negative=0, parent_total=0,
            parent_name=name,
            period="monthly",
            year=year, month=month,
        )
        return TitleBlock(
            game_id=game_id, name=name, total_posts=0,
            positive=0, negative=0, neutral=0,
            pos_neg_ratio="no signal",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label=period_label, has_data=False,
            competitor_bullets=empty_bullets,
        )

    # §24: monthly editorial cache (separate from weekly).
    editorial_articles = _load_latest_editorial(db, game_id, scope="monthly")
    row_cmap = dict(getattr(row, "citation_map", None) or {})
    if editorial_articles:
        from services.editorial_research_service import editorial_citation_map
        row_cmap.update(editorial_citation_map(editorial_articles))

    competitor_bullets = _build_competitor_bullets(
        db,
        parent_game_id=game_id,
        parent_positive=row.positive_count,
        parent_negative=row.negative_count,
        parent_total=row.total_posts,
        parent_name=name,
        period="monthly",
        year=year, month=month,
    )

    return TitleBlock(
        game_id=game_id, name=name,
        total_posts=row.total_posts,
        positive=row.positive_count,
        negative=row.negative_count,
        neutral=row.neutral_count,
        pos_neg_ratio=_format_ratio(row.positive_count, row.negative_count),
        executive_summary=row.executive_summary or "",
        recommended_actions=row.recommended_actions or "",
        bold_ideas=list(row.bold_ideas or []),
        period_label=period_label, has_data=True,
        citation_map=row_cmap or None,
        editorial_articles=[
            {
                "cite": a.cite, "url": a.url, "title": a.title,
                "publication": a.publication,
                "published_at": a.published_at,
                "summary": a.summary,
            }
            for a in editorial_articles
        ] if editorial_articles else None,
        competitor_bullets=competitor_bullets,
    )


# ── HTML rendering ───────────────────────────────────────────────────────────

# Email-safe palette.  Email clients strip <style> blocks aggressively, so
# every rule is inlined.  Colors chosen to feel like an agency brief:
# off-white background, slate text, single accent for sentiment chips.
_BRAND_ACCENT = "#1a3a5c"     # deep slate-blue (Saber-adjacent)
_TEXT_PRIMARY = "#1f2937"
_TEXT_MUTED   = "#6b7280"
_BG_PAGE      = "#f5f5f0"      # warm off-white
_BG_CARD      = "#ffffff"
_BORDER       = "#e5e7eb"
_POSITIVE     = "#15803d"
_NEGATIVE     = "#b91c1c"
_NEUTRAL_CHIP = "#475569"


def _markdown_to_email_html(text: str, citation_map: Optional[dict] = None) -> str:
    """
    Render the narrow subset of Markdown that period_summary_service emits:
      • **bold** → <strong>
      • Numbered lists '1. ' → <ol>
      • Blank-line paragraphs
      • [P-NNN] → <sup> link to source post (CLAUDE.md §20 layer 3)

    Deliberately minimal so we don't depend on a Markdown library in the
    email path (where dependency surface matters for security review).
    Everything is HTML-escaped first.
    """
    if not text:
        return ""
    text = html.escape(text)
    # **bold** → <strong>
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    # [P-NNN] → superscript link
    text = _render_citations(text, citation_map)

    # Detect numbered-list blocks (lines that start with "1. ", "2. ", ...)
    lines = text.split("\n")
    out: list[str] = []
    in_list = False
    para_buf: list[str] = []

    def flush_para():
        nonlocal para_buf
        if para_buf:
            joined = " ".join(s.strip() for s in para_buf if s.strip())
            if joined:
                out.append(
                    f'<p style="margin:0 0 12px 0; color:{_TEXT_PRIMARY}; '
                    f'font-size:15px; line-height:1.55;">{joined}</p>'
                )
            para_buf = []

    for raw in lines:
        line = raw.rstrip()
        m = re.match(r"^\d+\.\s+(.*)$", line)
        if m:
            flush_para()
            if not in_list:
                out.append(
                    f'<ol style="margin:0 0 14px 22px; padding:0; '
                    f'color:{_TEXT_PRIMARY}; font-size:15px; line-height:1.55;">'
                )
                in_list = True
            out.append(f'<li style="margin:0 0 8px 0;">{m.group(1)}</li>')
        elif line == "":
            # Blank line: end any open paragraph, but DO NOT close an open
            # <ol> — LLM output puts blank lines between numbered items for
            # readability, and we want them to render as ONE list with
            # 1/2/3 numbering, not three separate <ol>s that all show '1.'.
            # The list only closes when the next non-blank line is NOT a
            # numbered item.
            flush_para()
        else:
            # Non-blank, non-numbered line — if we were in a list, close it
            # first so this becomes a fresh paragraph.
            if in_list:
                out.append("</ol>")
                in_list = False
            para_buf.append(line)

    flush_para()
    if in_list:
        out.append("</ol>")
    return "\n".join(out)


def _render_metrics_strip(b: TitleBlock) -> str:
    """The pos:neg ratio + total posts header for each title section."""
    # Sentiment chip styling depends on tone
    tone = b.sentiment_tone
    if tone == "positive":
        ratio_bg, ratio_fg = "#dcfce7", _POSITIVE
    elif tone == "negative":
        ratio_bg, ratio_fg = "#fee2e2", _NEGATIVE
    else:
        ratio_bg, ratio_fg = "#f1f5f9", _NEUTRAL_CHIP

    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        f'style="margin:0 0 14px 0; width:100%; border-collapse:collapse;">'
        f'  <tr>'
        f'    <td style="padding:10px 14px; background:#fafafa; '
        f'border:1px solid {_BORDER}; border-radius:6px; '
        f'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif; '
        f'font-size:13px; color:{_TEXT_PRIMARY};">'
        f'      <span style="font-weight:600;">{b.total_posts:,}</span>'
        f'      <span style="color:{_TEXT_MUTED};"> posts</span>'
        f'      <span style="color:{_BORDER}; margin:0 8px;">|</span>'
        f'      <span style="color:{_POSITIVE}; font-weight:600;">{b.positive:,}</span>'
        f'      <span style="color:{_TEXT_MUTED};"> pos</span>'
        f'      <span style="color:{_TEXT_MUTED}; margin:0 4px;">·</span>'
        f'      <span style="color:{_NEGATIVE}; font-weight:600;">{b.negative:,}</span>'
        f'      <span style="color:{_TEXT_MUTED};"> neg</span>'
        f'      <span style="color:{_TEXT_MUTED}; margin:0 4px;">·</span>'
        f'      <span style="color:{_NEUTRAL_CHIP}; font-weight:600;">{b.neutral:,}</span>'
        f'      <span style="color:{_TEXT_MUTED};"> neu</span>'
        f'      <span style="color:{_BORDER}; margin:0 8px;">|</span>'
        f'      <span style="display:inline-block; padding:2px 8px; '
        f'background:{ratio_bg}; color:{ratio_fg}; border-radius:10px; '
        f'font-weight:700; font-size:12px;">{html.escape(b.pos_neg_ratio)}'
        f' <span style="font-weight:500;">pos:neg</span></span>'
        f'    </td>'
        f'  </tr>'
        f'</table>'
    )


def _render_editorial_footer(b: TitleBlock) -> str:
    """§24: render the small 'Editorial context' footer per title.

    Shows up to 5 articles consulted for this cycle's bold-ideas, each as
    a single line with publication, headline, and a small text-link.
    Returns empty string when no editorial articles are present.
    """
    if not b.editorial_articles:
        return ""
    rows: list[str] = []
    for art in b.editorial_articles[:5]:
        # Each article entry is a dict (from EditorialArticle.__dict__
        # or the editorial_citation_map shape) with cite/title/url/
        # publication/published_at/summary.
        cite = art.get("cite", "") if isinstance(art, dict) else getattr(art, "cite", "")
        title = art.get("title") if isinstance(art, dict) else getattr(art, "title", None)
        url = art.get("url") if isinstance(art, dict) else getattr(art, "url", None)
        pub = art.get("publication") if isinstance(art, dict) else getattr(art, "publication", None)
        if not (title and url):
            continue
        # 'E1', 'E2', ... bare ordinal-style label for compactness.
        try:
            ord_str = str(int(cite.split("-")[1])) if cite and "-" in cite else ""
        except Exception:
            ord_str = ""
        title_esc = html.escape(title[:160])
        url_esc = html.escape(url, quote=True)
        pub_esc = html.escape(pub or "")
        prefix = f"[E{ord_str}] " if ord_str else ""
        rows.append(
            f'<li style="margin:0 0 4px 0;">'
            f'<span style="color:{_TEXT_MUTED}; font-size:12px;">{prefix}</span>'
            f'<a href="{url_esc}" style="color:{_BRAND_ACCENT}; text-decoration:none;">'
            f'{title_esc}</a>'
            + (f' <span style="color:{_TEXT_MUTED}; font-size:12px;">— {pub_esc}</span>' if pub_esc else "")
            + '</li>'
        )
    if not rows:
        return ""
    items = "".join(rows)
    return (
        f'<div style="margin-top:14px; padding-top:12px; border-top:1px dashed {_BORDER};">'
        f'  <div style="font-size:11px; font-weight:700; letter-spacing:.06em; '
        f'  color:{_TEXT_MUTED}; text-transform:uppercase; margin-bottom:6px;">'
        f'  Editorial context (§24)</div>'
        f'  <ul style="margin:0 0 0 18px; padding:0; color:{_TEXT_PRIMARY}; '
        f'  font-size:13px; line-height:1.45;">{items}</ul>'
        f'</div>'
    )


# ── Competitive Set (2026-08-30, v3 — evening feedback) ──────────────────────
# For any parent title with rows in competitor_games, render:
#
#   1. A pre-rendered PNG line chart showing the last 28 DAILY post-volume
#      points for parent + up to 3 competitors, with a bold 7-day trailing
#      average overlaid on translucent daily lines. Inline data URI.
#   2. One short caption sentence stating the aggregate volume gap.
#   3. Per featured competitor:
#        (a) ONE volume-vs-parent bullet naming that specific competitor's
#            weekly volume delta relative to the Saber title.
#        (b) ONE topic-momentum bullet naming what specific positive AND/OR
#            negative topics have real momentum for that peer this week.
#
# Topic-quality safeguards (2026-08-30 evening user feedback: "Halloween
# Nights Horror" was surfacing with only 2 mentions against 10,669 total
# Halloween posts because velocity + trend_direction alone was driving
# promotion):
#
#   * Absolute mention floor of 5 — a topic with 1-4 mentions never
#     enters a bullet. Filters out fringe noise like "Halloween Nights
#     Horror" (2 mentions) or "Turkish Language Support Request" (1).
#   * Relative floor of 1% of the competitor's weekly total — for
#     high-volume peers like Halloween (10k+ posts) the effective floor
#     jumps to ~100+ mentions, which correctly blocks anything that
#     isn't a real community topic.
#   * Sort order is (mention_count desc, velocity desc, rising first),
#     not (rising first, velocity desc, mention_count desc). A topic
#     with 200 stable mentions must beat a topic with 2 rising mentions.
#   * Per-title blocklists for known-wrong labels (e.g. Halloween Nights
#     Horror is Universal Studios' theme-park event, not the game).
#   * Generic labels ("General Discussion", "General Positive Sentiment",
#     etc.) are still filtered as before.

_COMPETITOR_MAX_FEATURED = 3

# Minimum mention count for a topic to be surfaced in a bullet.
_TOPIC_ABSOLUTE_FLOOR = 5

# Fraction of the competitor's total weekly posts a topic must represent.
_TOPIC_RELATIVE_FLOOR = 0.01

# Boost required for "(rising)" tag to appear next to a topic. The velocity
# unit is mentions-per-day averaged over the trailing week, so a topic
# rising by ≥1.0 posts/day is meaningful; anything below is noise.
_RISING_VELOCITY_THRESHOLD = 1.0

# Generic topic labels — filtered so we prefer specific ones. Match is
# case-insensitive on stripped input.
_GENERIC_TOPIC_LABELS = {
    "general discussion",
    "general positive sentiment",
    "general negative sentiment",
    "general neutral sentiment",
    "general gameplay talk",
    "general gameplay",
    "gameplay",
    "discussion",
    "general",
    "general chat",
    "general comment",
    "general comments",
    "general talk",
    "positive sentiment",
    "negative sentiment",
    "neutral sentiment",
    "other",
    "miscellaneous",
    "misc",
    "unlabeled",
    "unlabelled",
    "n/a",
}

# Per-game blocklist for topic labels that a human reader knows are
# meaningfully wrong for that game — e.g. Halloween: The Game (id=140)
# consistently surfaces "Halloween Nights Horror" (Universal Studios'
# Halloween Horror Nights theme-park event) which has nothing to do
# with the video game. This is a targeted override on top of the
# generic + floor filters; when we spot a false-positive we add it
# here rather than trying to invent a general rule.
#
# Match is case-insensitive on stripped input. Add a note next to each
# entry explaining why it's blocked so future maintainers know what
# real-world topic it refers to.
_TOPIC_BLOCKLIST_BY_GAME: dict[int, set[str]] = {
    # Halloween: The Game (game_id 140):
    140: {
        "halloween nights horror",   # Universal Studios theme-park event
        "halloween horror nights",   # Universal Studios theme-park event
        "hhn",                       # Common HHN abbreviation
        "halloween 20 amazon",       # Halloween 2018 movie DVD/streaming chatter
        "halloween meme culture",    # Real-world holiday meme content
        "halloween event timing",    # Real-world holiday calendar chatter
        "halloween theme & atmosphere",  # Ambiguous — hard to disambiguate
    },
}


def _is_specific_topic(label) -> bool:
    """True if `label` is worth surfacing (not generic boilerplate)."""
    if not label or not isinstance(label, str):
        return False
    stripped = label.strip()
    if not stripped:
        return False
    return stripped.lower() not in _GENERIC_TOPIC_LABELS


def _is_blocked_for_game(label: str, game_id: int) -> bool:
    """True if `label` is on the per-game blocklist for `game_id`."""
    if not label or not isinstance(label, str):
        return False
    blocked = _TOPIC_BLOCKLIST_BY_GAME.get(game_id, set())
    return label.strip().lower() in blocked


def _weighted_pos_neg_score(positive: int, negative: int) -> float:
    """Score positives-vs-negatives on a [-1, 1] axis, ignoring neutrals."""
    denom = positive + negative
    if denom == 0:
        return 0.0
    return (positive - negative) / denom


def _describe_ratio_stance(positive: int, negative: int) -> str:
    """One-clause description of pos:neg posture, without surfacing neutral."""
    if positive == 0 and negative == 0:
        return "has no qualifying pos/neg signal this window"
    if negative == 0:
        return f"is running an unblemished {positive}:0 posture"
    if positive == 0:
        return f"is skewed hard negative ({negative} negatives, no offsetting positives)"
    if positive >= 3 * negative:
        return f"is running strongly positive at {positive / negative:.1f}:1"
    if positive >= 1.5 * negative:
        return f"leans positive at {positive / negative:.1f}:1"
    if negative >= 3 * positive:
        return f"is running strongly negative at 1:{negative / positive:.1f}"
    if negative >= 1.5 * positive:
        return f"leans negative at 1:{negative / positive:.1f}"
    return "sits roughly balanced"


def _load_daily_pos_neg_series(
    db: Session, game_id: int, days: int, today: date
) -> list[tuple[date, int]]:
    """Return a length-`days` list of (day, pos+neg count) tuples ending on
    `today`. Oldest first. Missing days contribute zero.

    Uses RawPost + SentimentRecord (matching routers/dashboard.py
    competitor-timeseries endpoint from 2026-07-27) so the chart series
    is consistent with the on-dashboard chart. Filters out drift-flagged
    posts and NULL-post_date rows.
    """
    from models import RawPost, SentimentRecord, SentimentEnum as _SE  # noqa: PLC0415
    from sqlalchemy import func as _func  # noqa: PLC0415

    try:
        from routers.dashboard import _NOT_DRIFT  # noqa: PLC0415
    except Exception:
        _NOT_DRIFT = True  # type: ignore[assignment]

    start_day = today - timedelta(days=days - 1)
    all_days = [start_day + timedelta(days=i) for i in range(days)]
    day_counts: dict[date, int] = {d: 0 for d in all_days}

    try:
        day_expr = _func.date(RawPost.post_date).label("day")
        q = (
            db.query(day_expr, _func.count(RawPost.id).label("cnt"))
            .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
            .filter(
                RawPost.game_id == game_id,
                RawPost.post_date.isnot(None),
                _func.date(RawPost.post_date) >= start_day,
                _func.date(RawPost.post_date) <= today,
                SentimentRecord.sentiment.in_([
                    _SE.positive, _SE.negative,
                ]),
            )
        )
        if _NOT_DRIFT is not True:
            q = q.filter(_NOT_DRIFT)
        for r in q.group_by(day_expr).all():
            d = r.day
            if isinstance(d, str):
                try:
                    y, m, dd = d.split("-")
                    d = date(int(y), int(m), int(dd))
                except Exception:
                    continue
            if d in day_counts:
                day_counts[d] = int(r.cnt or 0)
    except Exception as exc:
        logger.warning(
            "digest: daily series load failed for game_id=%d: %s", game_id, exc,
        )

    return [(d, day_counts[d]) for d in all_days]


def _smooth_7d(series: list[int]) -> list[float]:
    """Trailing 7-day moving average. First 6 points use a shorter window."""
    out: list[float] = []
    for i in range(len(series)):
        window = series[max(0, i - 6): i + 1]
        out.append(sum(window) / len(window) if window else 0.0)
    return out


def _render_trend_png_data_uri(
    parent_name: str,
    parent_daily: list[tuple[date, int]],
    competitors: list[dict],
    today: date,
) -> str:
    """Render a 28-day daily trend PNG (parent + up to N competitors, pos+neg
    only) and return an inline data:image/png;base64 URI.

    Layout: translucent thin lines for raw daily points + bold 7-day rolling
    average overlays. This is the 2026-08-30 evening fix for the "any so
    linear" complaint — 4 weekly buckets was too coarse and only 3 points
    of connection between them read as jagged. 28 daily points give a real
    trend shape.
    """
    if not competitors or not parent_daily:
        return ""

    try:
        import io
        import base64
        import matplotlib
        matplotlib.use("Agg", force=True)
        import matplotlib.pyplot as plt  # noqa: E402
        import matplotlib.dates as mdates  # noqa: E402
        from matplotlib.ticker import MaxNLocator  # noqa: E402
    except Exception as exc:
        logger.warning("digest: matplotlib import failed: %s", exc)
        return ""

    try:
        parent_days = [d for d, _ in parent_daily]
        parent_counts = [c for _, c in parent_daily]
        parent_smooth = _smooth_7d(parent_counts)

        fig, ax = plt.subplots(figsize=(7.2, 3.2), dpi=140)
        fig.patch.set_facecolor("#ffffff")
        ax.set_facecolor("#ffffff")

        parent_color = "#1a3a5c"
        competitor_colors = ["#b91c1c", "#0d9488", "#a16207", "#7c3aed"]

        # Parent: translucent daily + bold 7d rolling
        ax.plot(parent_days, parent_counts,
                linewidth=0.9, color=parent_color, alpha=0.35, zorder=2)
        ax.plot(parent_days, parent_smooth,
                linewidth=2.4, color=parent_color, alpha=1.0, zorder=4,
                label=parent_name)

        for i, comp in enumerate(competitors):
            c_color = competitor_colors[i % len(competitor_colors)]
            days = [d for d, _ in comp["daily"]]
            counts = [c for _, c in comp["daily"]]
            smooth = _smooth_7d(counts)
            ax.plot(days, counts,
                    linewidth=0.8, color=c_color, alpha=0.30, zorder=2)
            ax.plot(days, smooth,
                    linewidth=1.9, color=c_color, alpha=0.95, zorder=3,
                    label=comp["name"])

        ax.set_title(
            "Daily post volume, last 28 days \u2014 parent vs. competitors "
            "(7-day rolling average; pos + neg only)",
            fontsize=9.5, color="#1f2937", loc="left", pad=10,
        )
        ax.set_ylabel("Qualifying posts / day", fontsize=8.5, color="#6b7280")
        ax.tick_params(axis="both", labelsize=8.5, colors="#6b7280")

        # X-axis: daily minor ticks, major every 4 days
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=4))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
        ax.xaxis.set_minor_locator(mdates.DayLocator())

        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.spines["left"].set_color("#e5e7eb")
        ax.spines["bottom"].set_color("#e5e7eb")
        ax.grid(True, axis="y", linestyle="-", linewidth=0.5,
                color="#e5e7eb", alpha=0.7)
        ax.set_axisbelow(True)
        ax.yaxis.set_major_locator(MaxNLocator(integer=True, nbins=5))
        ax.yaxis.set_major_formatter(
            plt.FuncFormatter(lambda v, _: f"{int(v):,}")
        )

        legend = ax.legend(
            loc="upper center", bbox_to_anchor=(0.5, -0.22),
            ncol=min(len(competitors) + 1, 3),
            frameon=False, fontsize=8.5, handlelength=1.5,
        )
        for text in legend.get_texts():
            text.set_color("#1f2937")

        y_max_candidates = [max(parent_counts or [0])]
        for c in competitors:
            counts = [n for _, n in c["daily"]]
            if counts:
                y_max_candidates.append(max(counts))
        y_max = max(y_max_candidates) if y_max_candidates else 5
        ax.set_ylim(bottom=0, top=max(y_max * 1.15, 5))

        plt.tight_layout()
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=140,
                    facecolor="#ffffff", edgecolor="none")
        plt.close(fig)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64}"
    except Exception as exc:
        logger.warning("digest: trend PNG render failed: %s", exc)
        try:
            plt.close("all")
        except Exception:
            pass
        return ""


def _volume_caption_sentence(
    parent_name: str, parent_total: int, comp_rows: list,
) -> str:
    """ONE short caption describing the aggregate volume gap.

    No per-competitor driver-hypothesis repetition — the individual
    competitor volume commentary is now handled by a dedicated
    per-competitor bullet inside the section.
    """
    if not comp_rows:
        return ""

    total_comp = sum(r["total_posts"] for r in comp_rows)
    n_comps = len(comp_rows)

    def _fmt(n: int) -> str:
        return f"{n:,}"

    if parent_total == 0:
        if total_comp == 0:
            return (
                f"Peer set of {n_comps} tracked competitor"
                f"{'s' if n_comps != 1 else ''} generated no qualifying "
                f"conversation this week either."
            )
        return (
            f"Peer set generated {_fmt(total_comp)} qualifying posts this "
            f"week vs. no qualifying signal for the Saber title."
        )

    combined_ratio = total_comp / parent_total
    if combined_ratio >= 3.0:
        return (
            f"Peer set generated {_fmt(total_comp)} qualifying posts this "
            f"week \u2014 roughly {combined_ratio:.1f}\u00d7 the Saber "
            f"title's {_fmt(parent_total)}."
        )
    if combined_ratio >= 1.5:
        return (
            f"Peer set generated {_fmt(total_comp)} qualifying posts this "
            f"week \u2014 about {combined_ratio:.1f}\u00d7 the Saber "
            f"title's {_fmt(parent_total)}."
        )
    if combined_ratio >= 0.9:
        return (
            f"Peer set generated {_fmt(total_comp)} qualifying posts this "
            f"week \u2014 roughly on par with the Saber title's "
            f"{_fmt(parent_total)}."
        )
    if combined_ratio >= 0.5:
        return (
            f"Peer set generated {_fmt(total_comp)} qualifying posts this "
            f"week \u2014 about {int(combined_ratio * 100)}% of the Saber "
            f"title's {_fmt(parent_total)}."
        )
    return (
        f"Peer set generated {_fmt(total_comp)} qualifying posts this week "
        f"\u2014 well below the Saber title's {_fmt(parent_total)} "
        f"(~{combined_ratio:.2f}\u00d7)."
    )


def _competitor_volume_bullet(
    competitor_name: str,
    competitor_total: int,
    parent_total: int,
) -> str:
    """ONE volume-vs-parent bullet for a specific competitor.

    Restored 2026-08-30 evening — the chart carries the trend visually, but
    Steve asked for per-title volume commentary alongside it so a scanning
    reader gets the number without having to eyeball the chart. Wording
    varies by scale so this doesn't read like the old repeated clause.
    """
    escaped = html.escape(competitor_name)
    if parent_total == 0:
        if competitor_total == 0:
            return f"<strong>{escaped}</strong> \u2014 no qualifying volume this window."
        return (
            f"<strong>{escaped}</strong> \u2014 {competitor_total:,} qualifying "
            f"posts vs. no qualifying signal for the Saber title."
        )
    if competitor_total == 0:
        return (
            f"<strong>{escaped}</strong> \u2014 essentially quiet this week "
            f"(0 vs. {parent_total:,} for the Saber title)."
        )
    ratio = competitor_total / parent_total
    if ratio >= 3.0:
        return (
            f"<strong>{escaped}</strong> \u2014 {competitor_total:,} posts, "
            f"{ratio:.1f}\u00d7 the Saber title's {parent_total:,}."
        )
    if ratio >= 1.5:
        return (
            f"<strong>{escaped}</strong> \u2014 {competitor_total:,} posts, "
            f"outpacing the Saber title's {parent_total:,} by "
            f"{ratio:.1f}\u00d7."
        )
    if ratio >= 0.9:
        return (
            f"<strong>{escaped}</strong> \u2014 {competitor_total:,} posts, "
            f"roughly on par with the Saber title's {parent_total:,}."
        )
    if ratio >= 0.5:
        pct = int(ratio * 100)
        return (
            f"<strong>{escaped}</strong> \u2014 {competitor_total:,} posts, "
            f"about {pct}% of the Saber title's {parent_total:,}."
        )
    pct = int(ratio * 100)
    return (
        f"<strong>{escaped}</strong> \u2014 {competitor_total:,} posts, well "
        f"below the Saber title's {parent_total:,} (~{pct}%)."
    )


def _rank_topic_candidate(t) -> tuple:
    """Sort key. New order (2026-08-30 evening): mention_count is primary
    so high-count stable topics beat low-count rising ones.
    """
    return (
        -(t.mention_count or 0),
        -(t.velocity or 0.0),
        0 if getattr(t.trend_direction, "value", str(t.trend_direction)) == "rising" else 1,
    )


def _passes_topic_floor(
    mention_count: int, competitor_total: int,
) -> bool:
    """A topic must clear both an absolute floor and a share-of-title floor.

    See module-level constants for the tuning. Together these block the
    "Halloween Nights Horror at 2 mentions vs 10,669 total posts" bug
    from 2026-08-30 evening.
    """
    if (mention_count or 0) < _TOPIC_ABSOLUTE_FLOOR:
        return False
    if competitor_total > 0:
        share = mention_count / competitor_total
        if share < _TOPIC_RELATIVE_FLOOR:
            return False
    return True


def _competitor_topic_sentence(
    db: Session,
    competitor_id: int,
    competitor_name: str,
    competitor_total: int,
    week_start: date,
    row,  # WindowSummary or MonthlySummary
) -> str:
    """Return ONE topic-momentum sentence for a single competitor.

    Applies the absolute + relative mention floors, per-title blocklist,
    and generic-label filter before picking. When no topic qualifies,
    emits a stance-only fallback so the reader still knows where the
    peer stands.
    """
    positive_topic = None
    negative_topic = None
    positive_velocity = 0.0
    negative_velocity = 0.0

    try:
        trend_rows = (
            db.query(TopicTrend)
            .filter(
                TopicTrend.game_id == competitor_id,
                TopicTrend.last_seen >= week_start,
            )
            .all()
        )
    except Exception as exc:
        logger.warning(
            "digest: TopicTrend query failed for game_id=%d: %s",
            competitor_id, exc,
        )
        trend_rows = []

    def _eligible(t) -> bool:
        return (
            _is_specific_topic(t.topic_label)
            and not _is_blocked_for_game(t.topic_label, competitor_id)
            and _passes_topic_floor(t.mention_count or 0, competitor_total)
        )

    positive_cands = sorted(
        [
            t for t in trend_rows
            if getattr(t.sentiment, "value", str(t.sentiment)) == "positive"
            and _eligible(t)
        ],
        key=_rank_topic_candidate,
    )
    negative_cands = sorted(
        [
            t for t in trend_rows
            if getattr(t.sentiment, "value", str(t.sentiment)) == "negative"
            and _eligible(t)
        ],
        key=_rank_topic_candidate,
    )

    if positive_cands:
        positive_topic = positive_cands[0].topic_label
        positive_velocity = positive_cands[0].velocity or 0.0
    if negative_cands:
        negative_topic = negative_cands[0].topic_label
        negative_velocity = negative_cands[0].velocity or 0.0

    # WindowSummary fallback — same filters
    if not positive_topic and row is not None:
        for label in (row.top_positive_topics or []):
            if (
                _is_specific_topic(label)
                and not _is_blocked_for_game(label, competitor_id)
            ):
                positive_topic = label
                break
    if not negative_topic and row is not None:
        for label in (row.top_negative_topics or []):
            if (
                _is_specific_topic(label)
                and not _is_blocked_for_game(label, competitor_id)
            ):
                negative_topic = label
                break

    escaped_name = html.escape(competitor_name)

    def _rising_marker(velocity: float) -> str:
        return " (rising)" if velocity >= _RISING_VELOCITY_THRESHOLD else ""

    if positive_topic and negative_topic:
        return (
            f"<strong>{escaped_name}</strong> \u2014 positive momentum on "
            f"<em>{html.escape(positive_topic)}</em>{_rising_marker(positive_velocity)}; "
            f"negative pressure on "
            f"<em>{html.escape(negative_topic)}</em>{_rising_marker(negative_velocity)}."
        )
    if positive_topic:
        return (
            f"<strong>{escaped_name}</strong> \u2014 positive momentum on "
            f"<em>{html.escape(positive_topic)}</em>{_rising_marker(positive_velocity)}; "
            f"no material negative theme met the reporting floor this window."
        )
    if negative_topic:
        return (
            f"<strong>{escaped_name}</strong> \u2014 negative pressure on "
            f"<em>{html.escape(negative_topic)}</em>{_rising_marker(negative_velocity)}; "
            f"no material positive theme met the reporting floor this window."
        )
    pos = getattr(row, "positive_count", 0) if row is not None else 0
    neg = getattr(row, "negative_count", 0) if row is not None else 0
    return (
        f"<strong>{escaped_name}</strong> \u2014 {_describe_ratio_stance(pos, neg)}; "
        f"no specific topic momentum cleared the reporting floor this week."
    )


def _build_competitor_bullets(
    db: Session,
    parent_game_id: int,
    parent_positive: int,
    parent_negative: int,
    parent_total: int,
    parent_name: str,
    period: str,
    *,
    today: Optional[date] = None,
    year: Optional[int] = None,
    month: Optional[int] = None,
) -> Optional[list]:
    """Build the Competitive Set payload for the given parent block.

    Returns None when the parent has zero configured competitors so the
    caller can distinguish "unconfigured" from "configured but no data".
    Otherwise the first bullet is always a chart bundle
    {kind: 'chart', chart_data_uri, html: caption}. Subsequent bullets
    alternate: 'volume' (per-competitor volume) then 'topic' (per-
    competitor topic momentum), one pair per featured competitor.
    """
    try:
        links = (
            db.query(CompetitorGame)
            .filter_by(parent_id=parent_game_id)
            .all()
        )
    except Exception as exc:
        logger.warning(
            "digest: failed to load competitor_games for parent_id=%d: %s",
            parent_game_id, exc,
        )
        return None

    if not links:
        return None

    today_d = today or date.today()

    # Pass 1: gather per-competitor row + daily series
    comp_rows: list[dict] = []
    for link in links:
        cgame = link.competitor
        if cgame is None:
            continue
        c_id = cgame.id
        c_name = cgame.name

        row = None
        c_pos = c_neg = c_neu = c_total = 0

        try:
            if period == "weekly":
                row = (
                    db.query(WindowSummary)
                    .filter_by(game_id=c_id, window_days=7, ingest_date=today_d)
                    .first()
                )
                if row is None:
                    from services import period_summary_service as _pss  # noqa: PLC0415
                    row = _pss.generate_window_summary(db, game_id=c_id, days=7)
                if row is not None:
                    c_pos = row.positive_count
                    c_neg = row.negative_count
                    c_neu = row.neutral_count
                    c_total = row.total_posts
            elif period == "monthly":
                mrow = (
                    db.query(MonthlySummary)
                    .filter_by(game_id=c_id, period_year=year, period_month=month)
                    .first()
                )
                if mrow is not None:
                    c_pos = mrow.positive_count
                    c_neg = mrow.negative_count
                    c_neu = mrow.neutral_count
                    c_total = mrow.total_posts
                row = mrow
        except Exception as exc:
            logger.warning(
                "digest: competitor summary load failed for game_id=%d (%s): %s",
                c_id, period, exc,
            )
            continue

        # 28-day daily series for the chart
        try:
            daily = _load_daily_pos_neg_series(db, c_id, days=28, today=today_d)
        except Exception as exc:
            logger.warning(
                "digest: daily series load failed for game_id=%d: %s",
                c_id, exc,
            )
            daily = [(today_d - timedelta(days=27 - i), 0) for i in range(28)]

        comp_rows.append({
            "competitor_id": c_id,
            "competitor_name": c_name,
            "positive": c_pos, "negative": c_neg, "neutral": c_neu,
            "total_posts": c_total,
            "pos_neg_ratio": _format_ratio(c_pos, c_neg),
            "row": row,
            "daily": daily,
        })

    if not comp_rows:
        return []

    # Rank comps by (sentiment distance from parent) + (log volume gap)
    import math as _math
    parent_score = _weighted_pos_neg_score(parent_positive, parent_negative)
    for r in comp_rows:
        c_score = _weighted_pos_neg_score(r["positive"], r["negative"])
        sent_delta = abs(c_score - parent_score)
        if parent_total > 0 and r["total_posts"] > 0:
            vol_ratio = (
                max(r["total_posts"], parent_total)
                / max(min(r["total_posts"], parent_total), 1)
            )
            vol_delta = _math.log10(vol_ratio)
        else:
            vol_delta = 1.5
        r["_rank_key"] = sent_delta + 0.5 * vol_delta

    featured = sorted(comp_rows, key=lambda r: -r["_rank_key"])[
        :_COMPETITOR_MAX_FEATURED
    ]

    bullets: list[dict] = []

    # Bullet 0: chart + caption
    parent_daily = _load_daily_pos_neg_series(
        db, parent_game_id, days=28, today=today_d,
    )
    chart_uri = _render_trend_png_data_uri(
        parent_name, parent_daily,
        [{"name": r["competitor_name"], "daily": r["daily"]} for r in comp_rows],
        today_d,
    )
    caption = _volume_caption_sentence(parent_name, parent_total, comp_rows)
    bullets.append({
        "kind": "chart",
        "chart_data_uri": chart_uri,
        "html": caption,
    })

    # Bullets 1..N: per featured competitor, ONE volume bullet + ONE topic bullet
    if period == "weekly":
        week_start = today_d - timedelta(days=6)
    else:
        try:
            week_start = date(year, month, 1)
        except Exception:
            week_start = today_d - timedelta(days=30)

    for r in featured:
        bullets.append({
            "kind": "volume",
            "competitor_id": r["competitor_id"],
            "competitor_name": r["competitor_name"],
            "html": _competitor_volume_bullet(
                r["competitor_name"], r["total_posts"], parent_total,
            ),
        })
        bullets.append({
            "kind": "topic",
            "competitor_id": r["competitor_id"],
            "competitor_name": r["competitor_name"],
            "html": _competitor_topic_sentence(
                db,
                competitor_id=r["competitor_id"],
                competitor_name=r["competitor_name"],
                competitor_total=r["total_posts"],
                week_start=week_start,
                row=r["row"],
            ),
        })

    return bullets


def _render_competitive_set(b: TitleBlock) -> str:
    """Render the "Competitive Set" sub-section for a parent's TitleBlock.

    Chart at the top, then aggregate caption, then per-competitor
    (volume bullet + topic bullet) pairs grouped visually.
    """
    if not b.competitor_bullets:
        return ""

    chart_html = ""
    caption_html = ""
    per_comp_groups: dict[int, dict[str, str]] = {}
    per_comp_order: list[int] = []

    for bullet in b.competitor_bullets:
        kind = bullet.get("kind")
        if kind == "chart":
            uri = bullet.get("chart_data_uri") or ""
            if uri:
                chart_html = (
                    f'<div style="margin:8px 0 12px 0; text-align:left;">'
                    f'  <img src="{uri}" '
                    f'    alt="Daily post volume, last 28 days \u2014 parent vs. competitors" '
                    f'    style="max-width:100%; height:auto; display:block; '
                    f'    border:1px solid {_BORDER}; border-radius:6px;">'
                    f'</div>'
                )
            cap = bullet.get("html") or ""
            if cap:
                caption_html = (
                    f'<p style="margin:0 0 12px 0; color:{_TEXT_PRIMARY}; '
                    f'font-size:14px; line-height:1.5;">{cap}</p>'
                )
        elif kind in ("volume", "topic"):
            cid = bullet.get("competitor_id")
            if cid is None:
                continue
            if cid not in per_comp_groups:
                per_comp_groups[cid] = {}
                per_comp_order.append(cid)
            per_comp_groups[cid][kind] = bullet["html"]

    # Render each competitor as its own <li> containing both bullets so
    # they visually group together (volume line, then topic line).
    items_html_parts: list[str] = []
    for cid in per_comp_order:
        group = per_comp_groups[cid]
        vol_html = group.get("volume") or ""
        topic_html = group.get("topic") or ""
        item = (
            f'<li style="margin:0 0 12px 0;">'
            f'  <div>{vol_html}</div>'
        )
        if topic_html:
            item += (
                f'  <div style="margin-top:4px; color:{_TEXT_MUTED}; '
                f'font-size:14px; line-height:1.5;">{topic_html}</div>'
            )
        item += "</li>"
        items_html_parts.append(item)

    bullets_ul = ""
    if items_html_parts:
        bullets_ul = (
            f'<ul style="margin:0 0 0 22px; padding:0; '
            f'color:{_TEXT_PRIMARY}; font-size:15px; line-height:1.55;">'
            f'{"".join(items_html_parts)}'
            f'</ul>'
        )

    return (
        f'<div style="margin-top:18px;">'
        f'  <div style="font-size:12px; font-weight:700; letter-spacing:.06em; '
        f'  color:{_BRAND_ACCENT}; text-transform:uppercase; margin-bottom:6px;">'
        f'  Competitive Set</div>'
        f'  {chart_html}'
        f'  {caption_html}'
        f'  {bullets_ul}'
        f'</div>'
    )


def _render_title_section(b: TitleBlock) -> str:
    """One full title section: name, period, metrics strip, then three sub-sections."""
    if not b.has_data:
        # Even when the parent has no qualifying signal, the reader still
        # benefits from seeing the competitive set if configured — that is
        # in fact THE most useful case for the competitor commentary.
        body = (
            f'<p style="margin:0; color:{_TEXT_MUTED}; font-style:italic; '
            f'font-size:14px;">No qualifying posts in this window. Either '
            f'community discussion is dormant or topics did not meet the '
            f'§14/§15 relevance + critical-mass gates.</p>'
            + _render_competitive_set(b)
        )
    else:
        bold_html = ""
        if b.bold_ideas:
            bold_items = "".join(
                f'<li style="margin:0 0 10px 0;">{_inline_md(idea, b.citation_map)}</li>'
                for idea in b.bold_ideas
            )
            bold_html = (
                f'<ul style="margin:0 0 0 22px; padding:0; '
                f'color:{_TEXT_PRIMARY}; font-size:15px; line-height:1.55;">'
                f'{bold_items}</ul>'
            )
        body = (
            f'<div style="margin-bottom:18px;">'
            f'  <div style="font-size:12px; font-weight:700; letter-spacing:.06em; '
            f'  color:{_BRAND_ACCENT}; text-transform:uppercase; margin-bottom:6px;">'
            f'  Executive Summary</div>'
            f'  {_markdown_to_email_html(b.executive_summary, b.citation_map)}'
            f'</div>'
            f'<div style="margin-bottom:18px;">'
            f'  <div style="font-size:12px; font-weight:700; letter-spacing:.06em; '
            f'  color:{_BRAND_ACCENT}; text-transform:uppercase; margin-bottom:6px;">'
            f'  Recommended Actions</div>'
            f'  {_markdown_to_email_html(b.recommended_actions, b.citation_map)}'
            f'</div>'
            + (
                f'<div>'
                f'  <div style="font-size:12px; font-weight:700; letter-spacing:.06em; '
                f'  color:{_BRAND_ACCENT}; text-transform:uppercase; margin-bottom:6px;">'
                f'  Big Ideas to Consider</div>'
                f'  {bold_html}'
                f'</div>'
                if b.bold_ideas else ""
            )
            + _render_competitive_set(b)
            + _render_editorial_footer(b)
        )

    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        f'style="width:100%; margin:0 0 22px 0; background:{_BG_CARD}; '
        f'border:1px solid {_BORDER}; border-radius:8px; border-collapse:separate;">'
        f'  <tr><td style="padding:22px 26px;">'
        f'    <div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">'
        f'      <h2 style="margin:0 0 2px 0; font-size:20px; line-height:1.25; '
        f'      color:{_TEXT_PRIMARY}; font-weight:700;">{html.escape(b.name)}</h2>'
        f'      <div style="font-size:12px; color:{_TEXT_MUTED}; margin:0 0 12px 0; '
        f'      letter-spacing:.02em;">{html.escape(b.period_label)}</div>'
        f'      {_render_metrics_strip(b)}'
        f'      {body}'
        f'    </div>'
        f'  </td></tr>'
        f'</table>'
    )


# ── Citation rendering (CLAUDE.md §20 layer 3) ────────────────────────────────
# Tokens like [P-001] and [P-001, P-003] in summary text are converted to
# small superscript clickable links resolving to the source-post URLs stored
# in WindowSummary.citation_map / MonthlySummary.citation_map.

# §24 (2026-06-29): renderer accepts P-NNN (post) and E-NNN (editorial)
# citations.  Mixed brackets like [P-001, E-003] resolve into superscript
# anchor lists ordered as they appear in the bracket.
_CITE_BRACKET_RE_EMAIL = re.compile(r"\[((?:[PE]-\d{1,4}[\s,;]*)+)\]")
_CITE_INNER_RE_EMAIL = re.compile(r"([PE])-(\d{1,4})")


def _render_citations(text: str, citation_map: Optional[dict]) -> str:
    """Replace [P-NNN] tokens in `text` with superscript anchor links.

    `text` may already be HTML-escaped; this only touches the literal
    bracket-token pattern so it's safe to run before or after escape.
    When `citation_map` is None/empty (legacy row), tokens are stripped
    entirely to keep the user-visible text clean.
    """
    if not text:
        return text
    cmap = citation_map or {}

    def repl(m):
        inside = m.group(1)
        # Collect each citation token in order of appearance, dedup-preserving.
        # §24: tokens may be P-NNN (post) or E-NNN (editorial).  Display label
        # uses the bare ordinal for posts (legacy behaviour) and "E{ordinal}"
        # prefix for editorial to make the source class visible.
        seen: list[str] = []
        for inner in _CITE_INNER_RE_EMAIL.finditer(inside):
            kind = inner.group(1).upper()
            n = int(inner.group(2))
            tok = f"{kind}-{n:03d}"
            if tok not in seen:
                seen.append(tok)
        if not seen:
            return ""
        if not cmap:
            return ""  # legacy row: hide tokens rather than show raw [P-001]
        anchors: list[str] = []
        for tok in seen:
            entry = cmap.get(tok)
            kind, ordinal_str = tok.split("-")
            ordinal = int(ordinal_str)
            # Editorial citations get an 'E' prefix on the displayed label
            # so the reader knows which source class the citation points to.
            display = str(ordinal) if kind == "P" else f"E{ordinal}"
            if entry and entry.get("url"):
                url_esc = html.escape(entry["url"], quote=True)
                anchors.append(
                    f'<a href="{url_esc}" style="color:{_BRAND_ACCENT}; '
                    f'text-decoration:none;">{display}</a>'
                )
            else:
                anchors.append(display)
        joined = ",".join(anchors)
        return (
            f'<sup style="font-size:10px; color:{_TEXT_MUTED}; '
            f'margin-left:2px;">[{joined}]</sup>'
        )

    return _CITE_BRACKET_RE_EMAIL.sub(repl, text)


def _inline_md(text: str, citation_map: Optional[dict] = None) -> str:
    """Inline-only Markdown: escape + **bold** + [P-NNN] superscript links.
    For list items where we don't want block-level <p>/<ol> wrapping."""
    out = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html.escape(text or ""))
    return _render_citations(out, citation_map)


def render_digest_html(
    blocks: list[TitleBlock], title: str, subtitle: str, period_summary: str
) -> str:
    """Compose the full email HTML from a list of TitleBlocks."""
    # Top-line metrics across all titles with data
    with_data = [b for b in blocks if b.has_data]
    total_posts   = sum(b.total_posts for b in with_data)
    total_pos     = sum(b.positive for b in with_data)
    total_neg     = sum(b.negative for b in with_data)
    portfolio_ratio = _format_ratio(total_pos, total_neg)

    sections = "\n".join(_render_title_section(b) for b in blocks)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
</head>
<body style="margin:0; padding:0; background:{_BG_PAGE};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"
         style="width:100%; background:{_BG_PAGE};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="width:100%; max-width:720px; background:{_BG_PAGE};">
        <!-- Header -->
        <tr><td style="padding:0 6px 24px 6px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          <div style="font-size:11px; font-weight:700; letter-spacing:.14em;
                      color:{_BRAND_ACCENT}; text-transform:uppercase;">
            SentimentPulse Intelligence
          </div>
          <h1 style="margin:6px 0 4px 0; font-size:28px; line-height:1.2;
                     color:{_TEXT_PRIMARY}; font-weight:700;">{html.escape(title)}</h1>
          <div style="font-size:14px; color:{_TEXT_MUTED}; line-height:1.5;">
            {html.escape(subtitle)}
          </div>
        </td></tr>

        <!-- Portfolio brief -->
        <tr><td style="padding:0 0 24px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                 style="width:100%; background:{_BG_CARD}; border:1px solid {_BORDER};
                        border-radius:8px; border-collapse:separate;">
            <tr><td style="padding:18px 22px;
                           font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
              <div style="font-size:11px; font-weight:700; letter-spacing:.08em;
                          color:{_BRAND_ACCENT}; text-transform:uppercase; margin-bottom:6px;">
                Portfolio Brief
              </div>
              <p style="margin:0 0 10px 0; color:{_TEXT_PRIMARY}; font-size:14px; line-height:1.55;">
                {html.escape(period_summary)}
              </p>
              <div style="font-size:13px; color:{_TEXT_PRIMARY};">
                <strong>{total_posts:,}</strong>
                <span style="color:{_TEXT_MUTED};">posts across {len(with_data)} of {len(blocks)} titles</span>
                <span style="color:{_BORDER}; margin:0 8px;">|</span>
                <span style="color:{_POSITIVE}; font-weight:600;">{total_pos:,}</span>
                <span style="color:{_TEXT_MUTED};">positive</span>
                <span style="color:{_TEXT_MUTED}; margin:0 4px;">·</span>
                <span style="color:{_NEGATIVE}; font-weight:600;">{total_neg:,}</span>
                <span style="color:{_TEXT_MUTED};">negative</span>
                <span style="color:{_BORDER}; margin:0 8px;">|</span>
                <span style="font-weight:700;">{html.escape(portfolio_ratio)}</span>
                <span style="color:{_TEXT_MUTED};">pos:neg</span>
              </div>
            </td></tr>
          </table>
        </td></tr>

        <!-- Per-title sections -->
        <tr><td>{sections}</td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 6px 0 6px;
                       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
                       font-size:11px; color:{_TEXT_MUTED}; line-height:1.6;">
          Generated by SentimentPulse · sentiment, topics, and narrative
          synthesized from Reddit, Bluesky, Steam reviews, and Steam forums.
          Recommendations and big ideas are LLM-generated from observed
          community signal — review before acting.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
"""


# ── Build + send (public entry points) ───────────────────────────────────────

def build_weekly_digest(db: Session, today: Optional[date] = None) -> dict:
    """Return {subject, html, blocks, end_date} for the weekly digest.

    Does NOT send.  Used by the preview endpoint and by send_weekly_digest().
    """
    today = today or date.today()
    blocks = [build_weekly_block(db, gid, name, today=today)
              for gid, name in PRIORITY_TITLES]

    with_data = [b for b in blocks if b.has_data]
    total_posts = sum(b.total_posts for b in with_data)
    total_pos = sum(b.positive for b in with_data)
    total_neg = sum(b.negative for b in with_data)
    ratio = _format_ratio(total_pos, total_neg)
    if not with_data:
        portfolio_brief = (
            "No qualifying community signal across the priority titles "
            "this week. Worth checking source health if this persists "
            "into next week's digest."
        )
    else:
        portfolio_brief = (
            f"Across the priority slate, community sentiment is running "
            f"{ratio} positive to negative on {total_posts:,} qualifying "
            f"posts. Title-level narrative, recommended actions, and "
            f"strategic big ideas follow."
        )

    period_label = _weekly_period_label(today)
    subject = f"SentimentPulse — Weekly Digest · {period_label}"
    title = "Weekly Executive Digest"
    subtitle = f"7-day sentiment, topics, and strategic recommendations · {period_label}"
    html_body = render_digest_html(blocks, title, subtitle, portfolio_brief)
    return {
        "subject": subject, "html": html_body, "blocks": blocks,
        "end_date": today.isoformat(),
    }


def build_monthly_digest(
    db: Session, today: Optional[date] = None
) -> dict:
    """Return {subject, html, blocks, year, month} for the monthly digest.

    Summarizes the calendar month BEFORE `today`.
    """
    today = today or date.today()
    year, month = _prior_month(today)
    blocks = [build_monthly_block(db, gid, name, year, month)
              for gid, name in PRIORITY_TITLES]

    with_data = [b for b in blocks if b.has_data]
    total_posts = sum(b.total_posts for b in with_data)
    total_pos = sum(b.positive for b in with_data)
    total_neg = sum(b.negative for b in with_data)
    ratio = _format_ratio(total_pos, total_neg)
    period_label = _monthly_period_label(year, month)
    if not with_data:
        portfolio_brief = (
            f"No qualifying monthly summaries available for {period_label}. "
            "Verify the monthly summary job ran and source health was OK "
            "across the period."
        )
    else:
        portfolio_brief = (
            f"For {period_label}, the priority slate generated "
            f"{total_posts:,} qualifying posts at a {ratio} positive-to-negative "
            f"ratio. Title-level executive summary, recommended actions, and "
            f"strategic big ideas follow."
        )

    subject = f"SentimentPulse — Monthly Digest · {period_label}"
    title = "Monthly Executive Digest"
    subtitle = f"{period_label} sentiment, topics, and strategic recommendations"
    html_body = render_digest_html(blocks, title, subtitle, portfolio_brief)
    return {
        "subject": subject, "html": html_body, "blocks": blocks,
        "year": year, "month": month,
    }


# ── Resend HTTPS send ─────────────────────────────────────────────────────
# Mirrors lifetime-class-booker/automation/email-sender.ts and SlangIt's
# Resend wiring.  DigitalOcean blocks outbound SMTP (25/465/587) so the
# HTTPS path (api.resend.com:443) is the ONLY transport that actually
# works from the production droplet.  Stdlib urllib is used rather than
# adding a `resend` or `requests` dependency — the API surface is small
# enough that the dependency surface isn't worth it for the email path.

_RESEND_URL = "https://api.resend.com/emails"
_RESEND_TIMEOUT = 30  # seconds
_RESEND_RETRY_BACKOFF_SECONDS = 1.5


def _active_recipients(db: Session) -> list[str]:
    rows = db.query(DigestRecipient).filter(DigestRecipient.is_active.is_(True)).all()
    return [r.email for r in rows]


def _post_to_resend(
    api_key: str, from_addr: str, subject: str,
    to: list[str], html_body: str,
) -> dict:
    """
    Single POST to the Resend API.  Classifies the outcome so the caller
    can decide whether to retry.

    Returns a dict whose `kind` is one of:
      "ok"        — 200/2xx, email accepted
      "retryable" — 429 or 5xx (transient, worth one retry)
      "fatal"     — 4xx auth/validation (retry won't help)
      "network"   — connection/DNS/TLS error (retry once)
    """
    body = json.dumps({
        "from": from_addr,
        "to": to,
        "subject": subject,
        "html": html_body,
    }).encode("utf-8")
    req = urllib.request.Request(
        _RESEND_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            # Resend's Cloudflare edge returns HTTP 403 / error 1010 for
            # requests with Python's default urllib User-Agent — it's on a
            # banned-signature list.  A simple identifying UA bypasses the
            # block.  Verified 2026-06-24: Python-urllib/3.13 → 403, this UA
            # → 200.
            "User-Agent": "SentimentPulse/1.0 (+https://github.com/sallisonhome/sentimentpulse)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_RESEND_TIMEOUT) as resp:
            status = resp.status
            preview = (resp.read(200) or b"").decode("utf-8", errors="replace")
            return {"kind": "ok", "status": status, "body": preview}
    except urllib.error.HTTPError as e:
        text = (e.read(300) or b"").decode("utf-8", errors="replace")
        if e.code == 429 or 500 <= e.code <= 599:
            return {"kind": "retryable", "status": e.code, "body": text}
        return {"kind": "fatal", "status": e.code, "body": text}
    except urllib.error.URLError as e:
        return {"kind": "network", "message": str(e.reason)}
    except Exception as e:
        # Defensive: any other exception (TLS, timeout, socket reset)
        # is treated as a network error so the retry path covers it.
        return {"kind": "network", "message": str(e)}


def _send_via_resend(
    subject: str, recipients: list[str], html_body: str,
) -> dict:
    """Send `html_body` to `recipients` via Resend.  Retries once on
    transient failures.  Never raises."""
    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        return {"sent": False, "reason": "resend_not_configured"}
    from_addr = os.getenv(
        "RESEND_FROM",
        "SentimentPulse Intelligence <onboarding@resend.dev>",
    )

    first = _post_to_resend(api_key, from_addr, subject, recipients, html_body)
    if first["kind"] == "ok":
        return {"sent": True, "recipients": len(recipients),
                "provider": "resend"}
    if first["kind"] == "fatal":
        err = f"Resend {first['status']}: {first['body']}"
        logger.error("digest send fatal: %s", err)
        return {"sent": False, "reason": "resend_fatal", "error": err}

    # Transient — log + sleep + retry exactly once.
    if first["kind"] == "retryable":
        logger.warning(
            "digest send: Resend transient %d, retrying in %.1fs",
            first["status"], _RESEND_RETRY_BACKOFF_SECONDS,
        )
    else:
        logger.warning(
            "digest send: network error %r, retrying in %.1fs",
            first.get("message"), _RESEND_RETRY_BACKOFF_SECONDS,
        )
    time.sleep(_RESEND_RETRY_BACKOFF_SECONDS)

    second = _post_to_resend(api_key, from_addr, subject, recipients, html_body)
    if second["kind"] == "ok":
        logger.info("digest send: Resend retry succeeded")
        return {"sent": True, "recipients": len(recipients),
                "provider": "resend", "retried": True}
    if second["kind"] == "fatal":
        err = f"Resend {second['status']} (after retry): {second['body']}"
        return {"sent": False, "reason": "resend_fatal", "error": err}
    if second["kind"] == "retryable":
        err = f"Resend {second['status']} (after retry): {second['body']}"
        return {"sent": False, "reason": "resend_transient", "error": err}
    return {"sent": False, "reason": "resend_network",
            "error": f"network error (after retry): {second.get('message')}"}


def send_weekly_digest(db: Session, today: Optional[date] = None) -> dict:
    """Build + send the weekly digest via Resend.  Wired by APScheduler."""
    built = build_weekly_digest(db, today=today)
    recipients = _active_recipients(db)
    if not recipients:
        logger.info("weekly digest built but no active recipients — skipping send")
        return {"sent": False, "reason": "no_recipients",
                "subject": built["subject"], "html_length": len(built["html"])}
    result = _send_via_resend(built["subject"], recipients, built["html"])
    result["subject"] = built["subject"]
    return result


def send_monthly_digest(db: Session, today: Optional[date] = None) -> dict:
    """Build + send the monthly digest via Resend."""
    built = build_monthly_digest(db, today=today)
    recipients = _active_recipients(db)
    if not recipients:
        logger.info("monthly digest built but no active recipients — skipping send")
        return {"sent": False, "reason": "no_recipients",
                "subject": built["subject"], "html_length": len(built["html"])}
    result = _send_via_resend(built["subject"], recipients, built["html"])
    result["subject"] = built["subject"]
    return result
