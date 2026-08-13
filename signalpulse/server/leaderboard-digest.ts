/**
 * Weekly Steam Leaderboard Digest (Phase 5). See CLAUDE_STEAM_LEADERBOARDS.md
 * §8/§8.1.
 *
 * Renders the approved HTML design (ported verbatim from the
 * design-sign-off preview, `/home/user/workspace/build_digest_preview.py`)
 * against LIVE leaderboard data via the same `leaderboards.ts` getters the
 * `/leaderboards` UI uses — no separate calculation path, per plan.
 *
 * Resend send logic mirrors `sentimentpulse/backend/services/digest_service.py`
 * `_post_to_resend`/`_send_via_resend` exactly: HTTPS-only (DigitalOcean
 * blocks outbound SMTP on this droplet), custom User-Agent (Resend's
 * Cloudflare edge 403s the default fetch UA), retry once on
 * 429/5xx/network, never on 4xx.
 */
import { storage } from "./storage";
import {
  getWishlistLeaderboardRows, getWishlistLeaderboardKpis,
  getRevenueLeaderboardRows, getRevenueLeaderboardKpis,
  type WishlistLeaderboardRow, type RevenueLeaderboardRow,
  type LeaderboardMover, type RevenueLeaderboardMover,
} from "./leaderboards";
import { log } from "./index";

const BASE_URL = "http://104.236.239.46/signal";

const BRAND_ACCENT = "#1a3a5c";
const TEXT_PRIMARY = "#1f2937";
const TEXT_MUTED = "#6b7280";
const BG_PAGE = "#f5f5f0";
const BG_CARD = "#ffffff";
const BORDER = "#e5e7eb";
const POSITIVE = "#15803d";
const NEGATIVE = "#b91c1c";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function esc(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtNum(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

function fmtUsd(n: number | null | undefined): string {
  return n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtSigned(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("en-US")}`;
}

function arrow(direction: "up" | "down"): string {
  return direction === "up" ? "▲" : "▼";
}

function colorFor(direction: "up" | "down"): string {
  return direction === "up" ? POSITIVE : NEGATIVE;
}

function moverCard(
  label: string,
  mover: LeaderboardMover | RevenueLeaderboardMover | null,
  opts?: { widthPct?: number; emptyMessage?: string },
): string {
  const widthPct = opts?.widthPct ?? 33.33;
  if (mover == null) {
    return `
    <td style="width:${widthPct}%; padding:6px;" valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:${BG_CARD}; border:1px solid ${BORDER}; border-radius:8px;">
        <tr><td style="padding:16px;">
          <div style="font-size:11px; font-weight:700; letter-spacing:.06em; color:${TEXT_MUTED};
                      text-transform:uppercase; margin-bottom:8px; font-family:${FONT};">${esc(label)}</div>
          <div style="font-size:14px; color:${TEXT_MUTED}; font-style:italic; font-family:${FONT};">${esc(opts?.emptyMessage ?? "Not enough history yet")}</div>
        </td></tr>
      </table>
    </td>`;
  }
  const isPercent = "isPercent" in mover && mover.isPercent;
  const deltaDisplay = isPercent ? fmtPct(mover.delta) : fmtSigned(mover.delta);
  const c = colorFor(mover.direction);
  return `
    <td style="width:${widthPct}%; padding:6px;" valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:${BG_CARD}; border:1px solid ${BORDER}; border-radius:8px;">
        <tr><td style="padding:16px;">
          <div style="font-size:11px; font-weight:700; letter-spacing:.06em; color:${TEXT_MUTED};
                      text-transform:uppercase; margin-bottom:8px; font-family:${FONT};">${esc(label)}</div>
          <div style="display:flex; align-items:flex-start; gap:8px;">
            <img src="${esc(mover.headerImage)}" width="40" style="border-radius:4px; display:block; margin-top:1px;" />
            <div style="min-width:0; flex:1;">
              <div style="font-size:12.5px; font-weight:600; color:${TEXT_PRIMARY}; font-family:${FONT}; margin-bottom:3px;
                          line-height:1.25; word-break:break-word;">${esc(mover.title)}</div>
              <div style="font-size:18px; font-weight:800; color:${c}; font-family:${FONT}; font-variant-numeric:tabular-nums;">
                ${arrow(mover.direction)} ${deltaDisplay}
              </div>
            </div>
          </div>
        </td></tr>
      </table>
    </td>`;
}

function wlTableRow(r: WishlistLeaderboardRow): string {
  const wlDeltaC = (r.wishlistDelta1d ?? 0) >= 0 ? POSITIVE : NEGATIVE;
  const folDeltaC = (r.followersDelta1d ?? 0) >= 0 ? POSITIVE : NEGATIVE;
  return `
    <tr style="border-bottom:1px solid ${BORDER};">
      <td style="padding:10px 8px; font-family:${FONT};">
        <div style="display:flex; align-items:center; gap:8px;">
          <img src="${esc(r.headerImage)}" width="32" style="border-radius:3px; display:block;" />
          <span style="font-size:13px; font-weight:600; color:${TEXT_PRIMARY};">${esc(r.title)}</span>
        </div>
      </td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtNum(r.wishlistTotal)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${wlDeltaC}; font-weight:600; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtSigned(r.wishlistDelta1d)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtNum(r.followersTotal)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${folDeltaC}; font-weight:600; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtSigned(r.followersDelta1d)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${r.rankCurrent ?? "—"}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_MUTED}; font-variant-numeric:tabular-nums; font-family:${FONT};">${r.rankDelta7d != null ? fmtSigned(r.rankDelta7d) : "—"}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${r.igdbHype ?? "—"}</td>
    </tr>`;
}

function revTableRow(r: RevenueLeaderboardRow): string {
  const revDeltaC = (r.revenueDeltaPct24h ?? 0) >= 0 ? POSITIVE : NEGATIVE;
  const d30C = (r.revenueDelta30dPct ?? 0) >= 0 ? POSITIVE : NEGATIVE;
  return `
    <tr style="border-bottom:1px solid ${BORDER};">
      <td style="padding:10px 8px; font-family:${FONT};">
        <div style="display:flex; align-items:center; gap:8px;">
          <img src="${esc(r.headerImage)}" width="32" style="border-radius:3px; display:block;" />
          <span style="font-size:13px; font-weight:600; color:${TEXT_PRIMARY};">${esc(r.title)}</span>
        </div>
      </td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtNum(r.units24h)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtUsd(r.revenue24hUsd)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${revDeltaC}; font-weight:600; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtPct(r.revenueDeltaPct24h)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtUsd(r.ltdRevenueUsd)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtUsd(r.revenue30d)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${d30C}; font-weight:600; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtPct(r.revenueDelta30dPct)}</td>
    </tr>`;
}

function formatWeekLabel(now: Date): { weekOf: string; sentOn: string } {
  // "Week of" = the prior Mon-Sun week ending the Sunday before this send
  // (send happens Monday 07:00 ET, covering the week that just closed).
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow = et.getDay(); // 0=Sun..6=Sat; a Monday send has dow===1
  const daysSinceSunday = dow === 0 ? 7 : dow; // days back to the most recent Sunday (end of prior week)
  const weekEnd = new Date(et);
  weekEnd.setDate(et.getDate() - daysSinceSunday);
  const weekStart = new Date(weekEnd);
  weekStart.setDate(weekEnd.getDate() - 6);

  const monthDay = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
  const weekOf = weekStart.getMonth() === weekEnd.getMonth()
    ? `${monthDay(weekStart)} – ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
    : `${monthDay(weekStart)} – ${monthDay(weekEnd)}, ${weekEnd.getFullYear()}`;
  const sentOn = et.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
  return { weekOf, sentOn };
}

export function renderWeeklyDigestHtml(now: Date = new Date()): { subject: string; html: string } {
  const wlRows = getWishlistLeaderboardRows();
  const wlKpis = getWishlistLeaderboardKpis(wlRows);
  const revRows = getRevenueLeaderboardRows();
  const revKpis = getRevenueLeaderboardKpis(revRows);

  const wlRowsHtml = wlRows.map(wlTableRow).join("");
  const revRowsHtml = revRows.map(revTableRow).join("");
  const { weekOf, sentOn } = formatWeekLabel(now);

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background:${BG_PAGE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG_PAGE};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;">

<!-- Banner -->
<tr><td style="padding:0 6px 22px 6px;">
  <div style="font-family:${FONT}; font-weight:900; font-size:13px; letter-spacing:.14em; color:${BRAND_ACCENT};
              text-transform:uppercase; margin-bottom:4px;">SABER · SIGNALPULSE</div>
  <div style="font-family:${FONT}; font-weight:800; font-size:26px; letter-spacing:-.01em; color:${TEXT_PRIMARY}; line-height:1.2;">
    Weekly Steam Leaderboard Digest</div>
  <div style="font-family:${FONT}; font-size:13px; color:${TEXT_MUTED}; margin-top:4px;">
    Week of ${esc(weekOf)} &nbsp;·&nbsp; Sent Monday, ${esc(sentOn)}, 7:00 AM ET</div>
</td></tr>

<!-- Wishlist Section -->
<tr><td style="padding:0 6px 10px 6px;">
  <div style="font-family:${FONT}; font-size:12px; font-weight:700; letter-spacing:.08em; color:${BRAND_ACCENT};
              text-transform:uppercase; border-bottom:2px solid ${BRAND_ACCENT}; padding-bottom:6px; margin-bottom:14px;">
    Pre-Release Steam Wishlist Leaderboard</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${moverCard("Biggest 24hr Wishlist Mover", wlKpis.biggest24hWishlistMover)}
    ${moverCard("Biggest 7-Day Rank Mover", wlKpis.biggest7dRankMover)}
    ${moverCard("Biggest 24hr Follower Mover", wlKpis.biggest24hFollowerMover)}
  </tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin-top:14px; background:${BG_CARD}; border:1px solid ${BORDER}; border-radius:8px; border-collapse:collapse;">
    <tr style="background:#fafafa;">
      <th style="padding:9px 8px; text-align:left; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Title</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Wishlist</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">1d Δ</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Followers</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">1d Δ</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Rank</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">7d Δ</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Hype</th>
    </tr>
    ${wlRowsHtml}
  </table>

  <div style="margin-top:12px;">
    <a href="${BASE_URL}/?board=wishlist#/" style="font-family:${FONT}; font-size:13px; font-weight:600; color:${BRAND_ACCENT}; text-decoration:none;">
      View full Wishlist Leaderboard →</a>
  </div>
</td></tr>

<!-- Spacer -->
<tr><td style="padding:22px 0 0 0;"></td></tr>

<!-- Revenue Section -->
<tr><td style="padding:0 6px 10px 6px;">
  <div style="font-family:${FONT}; font-size:12px; font-weight:700; letter-spacing:.08em; color:${BRAND_ACCENT};
              text-transform:uppercase; border-bottom:2px solid ${BRAND_ACCENT}; padding-bottom:6px; margin-bottom:14px;">
    Saber Steam Revenue Leaderboard</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${moverCard("Biggest 24hr Mover, Units", revKpis.biggest24hUnitsMover, { widthPct: 50 })}
    ${moverCard("Biggest 24hr Mover, $", revKpis.biggest24hRevenueMover, { widthPct: 50 })}
  </tr></table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;"><tr>
    ${moverCard(
      revKpis.biggest30dRevenueLift?.direction === "down" ? "Biggest % Revenue Drop vs Prior 30d" : "Biggest % Revenue Lift vs Prior 30d",
      revKpis.biggest30dRevenueLift,
      { widthPct: 50 }
    )}
    ${moverCard(
      "Biggest % Revenue Lift (Positive Only)",
      revKpis.biggestPositive30dRevenueLift,
      { widthPct: 50, emptyMessage: "N/A — no positive revenue lift in period" }
    )}
  </tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin-top:14px; background:${BG_CARD}; border:1px solid ${BORDER}; border-radius:8px; border-collapse:collapse;">
    <tr style="background:#fafafa;">
      <th style="padding:9px 8px; text-align:left; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Title</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">24h Units</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">24h Rev</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">24h Δ%</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">LTD Rev</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">30d Rev</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">30d Δ%</th>
    </tr>
    ${revRowsHtml}
  </table>

  <div style="margin-top:12px;">
    <a href="${BASE_URL}/?board=revenue#/" style="font-family:${FONT}; font-size:13px; font-weight:600; color:${BRAND_ACCENT}; text-decoration:none;">
      View full Revenue Leaderboard →</a>
  </div>
</td></tr>

<!-- Footer -->
<tr><td style="padding:28px 6px 4px 6px; border-top:1px solid ${BORDER}; margin-top:20px;">
  <div style="font-family:${FONT}; font-size:11px; color:${TEXT_MUTED}; line-height:1.5;">
    You're receiving this because you're on the Saber SignalPulse leaderboard distribution list.
    Manage recipients in <a href="${BASE_URL}/settings#/" style="color:${TEXT_MUTED};">Settings → Weekly Digest</a>.
  </div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject: `Saber SignalPulse — Weekly Steam Leaderboard Digest · Week of ${weekOf}`, html };
}

// ─── Resend HTTPS send ──────────────────────────────────────────────────────
// Mirrors sentimentpulse/backend/services/digest_service.py::_post_to_resend /
// _send_via_resend. DigitalOcean blocks outbound SMTP (25/465/587) so the
// HTTPS path (api.resend.com:443) is the ONLY transport that works from the
// production droplet.

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 30_000;
const RESEND_USER_AGENT = "SignalPulse/1.0 (+https://github.com/sallisonhome/sentimentpulse)";

type ResendOutcome =
  | { kind: "ok"; status: number; body: string }
  | { kind: "retryable"; status: number; body: string }
  | { kind: "fatal"; status: number; body: string }
  | { kind: "network"; message: string };

async function postToResend(
  apiKey: string, fromAddr: string, subject: string, to: string[], htmlBody: string,
): Promise<ResendOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        // Resend's Cloudflare edge returns HTTP 403 for requests carrying
        // Node's default fetch User-Agent — it's on a banned-signature
        // list, exactly like Python's default urllib UA. A simple
        // identifying UA bypasses the block (see digest_service.py).
        "User-Agent": RESEND_USER_AGENT,
      },
      body: JSON.stringify({ from: fromAddr, to, subject, html: htmlBody }),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (res.ok) {
      return { kind: "ok", status: res.status, body: bodyText.slice(0, 200) };
    }
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      return { kind: "retryable", status: res.status, body: bodyText.slice(0, 300) };
    }
    return { kind: "fatal", status: res.status, body: bodyText.slice(0, 300) };
  } catch (err: any) {
    return { kind: "network", message: err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export interface DigestSendResult {
  sent: boolean;
  reason?: string;
  recipients?: number;
  status?: number;
  detail?: string;
}

/** Send `htmlBody` to `recipients` via Resend. Retries once on transient
 * failures (429/5xx/network). Never throws — always returns a result. */
async function sendViaResend(subject: string, recipients: string[], htmlBody: string): Promise<DigestSendResult> {
  const apiKey = storage.getSetting("resend_api_key")?.value;
  if (!apiKey) {
    return { sent: false, reason: "resend_not_configured" };
  }
  const fromAddr = storage.getSetting("resend_from")?.value || "onboarding@resend.dev";

  const first = await postToResend(apiKey, fromAddr, subject, recipients, htmlBody);
  if (first.kind === "ok") {
    return { sent: true, recipients: recipients.length, status: first.status };
  }
  if (first.kind === "fatal") {
    return { sent: false, reason: "resend_rejected", status: first.status, detail: first.body };
  }
  // retryable or network — wait briefly and retry exactly once.
  await new Promise((r) => setTimeout(r, 1500));
  const second = await postToResend(apiKey, fromAddr, subject, recipients, htmlBody);
  if (second.kind === "ok") {
    return { sent: true, recipients: recipients.length, status: second.status };
  }
  const detail = second.kind === "network" ? second.message : second.body;
  return { sent: false, reason: `resend_failed_after_retry_${second.kind}`, detail };
}

/** Send the weekly digest to every active recipient. Used by both the
 * Monday cron and the manual "Send test digest now" trigger. */
export async function sendWeeklyLeaderboardDigest(now: Date = new Date()): Promise<DigestSendResult & { subject: string }> {
  const recipients = storage.getActiveLeaderboardEmailRecipients().map((r) => r.email);
  const { subject, html } = renderWeeklyDigestHtml(now);

  if (recipients.length === 0) {
    log("Weekly leaderboard digest: no active recipients, skipping send", "leaderboard-digest");
    return { sent: false, reason: "no_active_recipients", subject };
  }

  const result = await sendViaResend(subject, recipients, html);
  if (result.sent) {
    log(`Weekly leaderboard digest sent to ${result.recipients} recipient(s)`, "leaderboard-digest");
  } else {
    log(`Weekly leaderboard digest NOT sent: ${result.reason}${result.detail ? " — " + result.detail : ""}`, "leaderboard-digest");
  }
  return { ...result, subject };
}

// ─── Weekly Cron Scheduler ──────────────────────────────────────────────────
// Self-contained interval scheduler. `server/ingestion.ts` exports
// `startIngestionCron`/`stopIngestionCron` but — confirmed by repo-wide grep —
// neither is ever called anywhere in this codebase, so there is no existing
// in-process daily cron to piggyback on. Daily ingestion on the droplet is
// triggered externally (not by this Node process). This scheduler is
// independent of that and is explicitly started from `server/index.ts`.
//
// Cadence: Monday 07:00 America/New_York, matching SentimentPulse's existing
// `_weekly_digest_job` precedent (CLAUDE_STEAM_LEADERBOARDS.md §8).
//
// Uses Intl.DateTimeFormat with an explicit America/New_York timeZone rather
// than a fixed UTC hour so the send time doesn't drift across the DST
// transition (07:00 ET is 11:00 UTC in EDT, 12:00 UTC in EST).

let weeklyDigestCronInterval: ReturnType<typeof setInterval> | null = null;
let weeklyDigestLastRunDate = "";

function getEasternHourMinuteWeekday(now: Date): { hour: number; minute: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = parseInt(get("hour"), 10) % 24; // "24" at midnight with hour12:false
  const minute = parseInt(get("minute"), 10);
  const weekday = get("weekday"); // "Mon", "Tue", ...
  return { hour, minute, weekday };
}

/** Start the in-process weekly digest scheduler (checks every minute, same
 * pacing style as the existing daily ingestion scheduler in ingestion.ts). */
export function startWeeklyDigestCron(): void {
  if (weeklyDigestCronInterval) return; // idempotent
  log("Weekly leaderboard digest cron scheduler started (Mondays 07:00 America/New_York)", "leaderboard-digest");

  weeklyDigestCronInterval = setInterval(() => {
    const now = new Date();
    const { hour, minute, weekday } = getEasternHourMinuteWeekday(now);
    const todayStr = now.toISOString().split("T")[0];

    if (weekday === "Mon" && hour === 7 && minute === 0 && weeklyDigestLastRunDate !== todayStr) {
      weeklyDigestLastRunDate = todayStr;
      sendWeeklyLeaderboardDigest(now).catch((err) => {
        log(`Weekly leaderboard digest cron error: ${err}`, "leaderboard-digest");
      });
    }
  }, 60_000);
}

export function stopWeeklyDigestCron(): void {
  if (weeklyDigestCronInterval) {
    clearInterval(weeklyDigestCronInterval);
    weeklyDigestCronInterval = null;
    log("Weekly leaderboard digest cron scheduler stopped", "leaderboard-digest");
  }
}
