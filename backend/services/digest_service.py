"""
Executive digest service — weekly + monthly.

Builds an agency-grade HTML email summarizing the 8 priority Saber titles.
Each title's section presents:

    1. Metrics strip       — total posts · pos/neg/neu counts · pos:neg ratio
    2. Executive Summary   — narrative paragraph from WindowSummary
    3. Recommended Actions — sprint-board-ready items
    4. Big Ideas to Consider — bold strategic plays

Weekly:  uses 7-day window-summaries (regenerated if cache is stale)
Monthly: uses MonthlySummary rows for the prior calendar month

Send pipeline: stdlib smtplib over TLS with SMTP credentials from env
(SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, DIGEST_FROM_EMAIL,
DIGEST_FROM_NAME).  If SMTP env is incomplete, send_*() returns
{"sent": False, "reason": "smtp_not_configured"} without raising — this
lets us deploy + preview before credentials are wired.
"""
from __future__ import annotations

import html
import logging
import os
import smtplib
import ssl
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Optional

from sqlalchemy.orm import Session

from models import DigestRecipient, Game, MonthlySummary, WindowSummary

logger = logging.getLogger(__name__)


# ── The 8 fixed priority titles (resolved 2026-06-24 against the live DB) ────
# Locked in code rather than configurable in the UI because:
#  • The user specified an exact list during planning.
#  • Many DLC variants have similar names (e.g. 20 different Space Marine 2
#    cosmetic packs) and we don't want them sneaking into the digest.
# To change the list, edit this constant and ship a release.
PRIORITY_TITLES: list[tuple[int, str]] = [
    (24,  "Warhammer 40,000: Space Marine 2"),
    (25,  "John Carpenter's Toxic Commando"),
    (23,  "Turok: Origins"),
    (21,  "Clive Barker's Hellraiser: Revival"),
    (134, "Bus Bound"),
    (131, "HITMAN Classic Trilogy Remastered"),
    (20,  "Untitled John Wick Game"),
    (130, "Stuntman: Hollywood"),
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
        return TitleBlock(
            game_id=game_id, name=name, total_posts=0,
            positive=0, negative=0, neutral=0,
            pos_neg_ratio="no signal",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label=period_label, has_data=False,
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
    )


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
        return TitleBlock(
            game_id=game_id, name=name, total_posts=0,
            positive=0, negative=0, neutral=0,
            pos_neg_ratio="no signal",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label=period_label, has_data=False,
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


def _markdown_to_email_html(text: str) -> str:
    """
    Render the narrow subset of Markdown that period_summary_service emits:
      • **bold** → <strong>
      • Numbered lists '1. ' → <ol>
      • Blank-line paragraphs

    Deliberately minimal so we don't depend on a Markdown library in the
    email path (where dependency surface matters for security review).
    Everything is HTML-escaped first.
    """
    if not text:
        return ""
    text = html.escape(text)
    # **bold** → <strong>
    import re
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)

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
            flush_para()
            if in_list:
                out.append("</ol>")
                in_list = False
        else:
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


def _render_title_section(b: TitleBlock) -> str:
    """One full title section: name, period, metrics strip, then three sub-sections."""
    if not b.has_data:
        body = (
            f'<p style="margin:0; color:{_TEXT_MUTED}; font-style:italic; '
            f'font-size:14px;">No qualifying posts in this window. Either '
            f'community discussion is dormant or topics did not meet the '
            f'§14/§15 relevance + critical-mass gates.</p>'
        )
    else:
        bold_html = ""
        if b.bold_ideas:
            bold_items = "".join(
                f'<li style="margin:0 0 10px 0;">{_inline_md(idea)}</li>'
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
            f'  {_markdown_to_email_html(b.executive_summary)}'
            f'</div>'
            f'<div style="margin-bottom:18px;">'
            f'  <div style="font-size:12px; font-weight:700; letter-spacing:.06em; '
            f'  color:{_BRAND_ACCENT}; text-transform:uppercase; margin-bottom:6px;">'
            f'  Recommended Actions</div>'
            f'  {_markdown_to_email_html(b.recommended_actions)}'
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


def _inline_md(text: str) -> str:
    """Inline-only Markdown: escape + **bold**.  For list items where we
    don't want block-level <p>/<ol> wrapping."""
    import re
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html.escape(text or ""))


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


# ── SMTP send ────────────────────────────────────────────────────────────────

def _smtp_config() -> Optional[dict]:
    """Return SMTP env or None if incomplete.  Logs which key is missing
    so ops can fix it without reading source code."""
    cfg = {
        "host":     os.getenv("SMTP_HOST"),
        "port":     int(os.getenv("SMTP_PORT", "587") or 587),
        "username": os.getenv("SMTP_USERNAME"),
        "password": os.getenv("SMTP_PASSWORD"),
        "from_email": os.getenv("DIGEST_FROM_EMAIL"),
        "from_name":  os.getenv("DIGEST_FROM_NAME", "SentimentPulse Intelligence"),
    }
    missing = [k for k, v in cfg.items()
               if k != "from_name" and not v]
    if missing:
        logger.warning("digest send skipped: missing SMTP env keys: %s", missing)
        return None
    return cfg


def _active_recipients(db: Session) -> list[str]:
    rows = db.query(DigestRecipient).filter(DigestRecipient.is_active.is_(True)).all()
    return [r.email for r in rows]


def _send_email(
    cfg: dict, recipients: list[str], subject: str, html_body: str
) -> dict:
    """Single SMTP transaction sending to all recipients (BCC).

    Returns a dict describing the result.  Never raises — failures are
    captured and logged so the scheduler keeps running.
    """
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f'{cfg["from_name"]} <{cfg["from_email"]}>'
    msg["To"]   = cfg["from_email"]      # primary "to" is the from address
    msg["Bcc"]  = ", ".join(recipients)  # recipients via Bcc so their
                                          # addresses don't leak to each other
    msg.set_content(
        "This is an HTML email. View it in a Markdown- or HTML-capable client."
    )
    msg.add_alternative(html_body, subtype="html")

    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=30) as s:
            s.starttls(context=ctx)
            s.login(cfg["username"], cfg["password"])
            s.send_message(msg)
        return {"sent": True, "recipients": len(recipients)}
    except Exception as exc:
        logger.exception("digest send failed: %s", exc)
        return {"sent": False, "reason": "smtp_error", "error": str(exc)}


def send_weekly_digest(db: Session, today: Optional[date] = None) -> dict:
    """Build + send the weekly digest.  Wired up by the APScheduler job."""
    built = build_weekly_digest(db, today=today)
    recipients = _active_recipients(db)
    if not recipients:
        logger.info("weekly digest built but no active recipients — skipping send")
        return {"sent": False, "reason": "no_recipients",
                "subject": built["subject"], "html_length": len(built["html"])}
    cfg = _smtp_config()
    if cfg is None:
        return {"sent": False, "reason": "smtp_not_configured",
                "subject": built["subject"], "html_length": len(built["html"])}
    sent = _send_email(cfg, recipients, built["subject"], built["html"])
    sent["subject"] = built["subject"]
    return sent


def send_monthly_digest(db: Session, today: Optional[date] = None) -> dict:
    """Build + send the monthly digest."""
    built = build_monthly_digest(db, today=today)
    recipients = _active_recipients(db)
    if not recipients:
        logger.info("monthly digest built but no active recipients — skipping send")
        return {"sent": False, "reason": "no_recipients",
                "subject": built["subject"], "html_length": len(built["html"])}
    cfg = _smtp_config()
    if cfg is None:
        return {"sent": False, "reason": "smtp_not_configured",
                "subject": built["subject"], "html_length": len(built["html"])}
    sent = _send_email(cfg, recipients, built["subject"], built["html"])
    sent["subject"] = built["subject"]
    return sent
