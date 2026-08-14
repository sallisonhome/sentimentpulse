/**
 * Weekly Steam Leaderboard Digest (Phase 5, redesigned v4.0 2026-08-14).
 * See CLAUDE_STEAM_LEADERBOARDS.md §8/§8.1.
 *
 * v4.0 change (user direction, 2026-08-14): the digest previously rendered
 * LIVE point-in-time leaderboard state (24h/7d deltas) via leaderboards.ts.
 * It now summarizes the PRIOR Mon-Sun week: total wishlist adds, total
 * follower adds, rank movement (closing Sunday vs prior Sunday), and total
 * revenue per title per SKU category (base game vs DLC) — see
 * leaderboard-digest-weekly.ts for all aggregation/gating logic.
 *
 * v4.0 also adds a hold/release gate: if any revenue-eligible title is
 * missing a cron-ingestion batch for any day in the week window (e.g. the
 * Steamworks session cookie went stale), the Monday send is HELD rather
 * than sent with a silent gap. It auto-releases and sends as soon as the
 * missing day(s) are backfilled by a later ingestion run.
 *
 * Resend send logic mirrors `sentimentpulse/backend/services/digest_service.py`
 * `_post_to_resend`/`_send_via_resend` exactly: HTTPS-only (DigitalOcean
 * blocks outbound SMTP on this droplet), custom User-Agent (Resend's
 * Cloudflare edge 403s the default fetch UA), retry once on
 * 429/5xx/network, never on 4xx.
 */
import { storage } from "./storage";
import {
  getWeekWindow, getWeeklyWishlistRows, getWeeklyWishlistKpis,
  getWeeklyRevenueRows, getWeeklyRevenueKpis,
  detectSalesGaps, getHeldDigestWeek, setHeldDigestWeek, clearHeldDigestWeek,
  type WeekWindow, type WeeklyWishlistRow, type WeeklyRevenueRow,
  type WeeklyMover, type WeeklyRevenueMover,
} from "./leaderboard-digest-weekly";
import { callSonar, sonarAvailable, type SonarResult } from "./sonar-client";
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

function fmtSigned(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("en-US")}`;
}

function fmtSignedUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function arrow(direction: "up" | "down"): string {
  return direction === "up" ? "▲" : "▼";
}

function colorFor(direction: "up" | "down"): string {
  return direction === "up" ? POSITIVE : NEGATIVE;
}

function moverCard(
  label: string,
  mover: WeeklyMover | WeeklyRevenueMover | null,
  opts?: { widthPct?: number; emptyMessage?: string; suffix?: string; format?: (n: number) => string },
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
          <div style="font-size:14px; color:${TEXT_MUTED}; font-style:italic; font-family:${FONT};">${esc(opts?.emptyMessage ?? "No movement this week")}</div>
        </td></tr>
      </table>
    </td>`;
  }
  const fmt = opts?.format ?? fmtSigned;
  const deltaDisplay = `${fmt(mover.delta)}${opts?.suffix ?? ""}`;
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

function statPill(label: string, value: string, widthPct = 50): string {
  return `
    <td style="width:${widthPct}%; padding:6px;" valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:${BRAND_ACCENT}; border-radius:8px;">
        <tr><td style="padding:14px 16px;">
          <div style="font-size:10.5px; font-weight:700; letter-spacing:.06em; color:#cbd8e5;
                      text-transform:uppercase; margin-bottom:5px; font-family:${FONT};">${esc(label)}</div>
          <div style="font-size:22px; font-weight:800; color:#ffffff; font-family:${FONT}; font-variant-numeric:tabular-nums;">${esc(value)}</div>
        </td></tr>
      </table>
    </td>`;
}

function narrativeBlock(result: SonarResult | null): string {
  if (!result?.text) return "";
  const sourcesHtml = result.citations.length
    ? `
    <div style="margin-top:8px; font-size:11px; color:${TEXT_MUTED}; font-family:${FONT};">
      Sources: ${result.citations
        .slice(0, 4)
        .map((url, i) => `<a href="${esc(url)}" style="color:${TEXT_MUTED}; text-decoration:underline;">[${i + 1}]</a>`)
        .join(" ")}
    </div>`
    : "";
  return `
  <div style="margin-top:12px; padding:12px 14px; background:#fafafa; border-left:3px solid ${BRAND_ACCENT}; border-radius:0 6px 6px 0;">
    <div style="font-size:13px; color:${TEXT_PRIMARY}; line-height:1.5; font-family:${FONT};">${esc(result.text)}</div>
    ${sourcesHtml}
  </div>`;
}

function wlTableRow(r: WeeklyWishlistRow): string {
  const addsC = (r.weeklyWishlistAdds ?? 0) >= 0 ? POSITIVE : NEGATIVE;
  const folC = (r.weeklyFollowerAdds ?? 0) >= 0 ? POSITIVE : NEGATIVE;
  const rankDeltaC = r.rankDelta == null ? TEXT_MUTED : r.rankDelta >= 0 ? POSITIVE : NEGATIVE;
  return `
    <tr style="border-bottom:1px solid ${BORDER};">
      <td style="padding:10px 8px; font-family:${FONT};">
        <div style="display:flex; align-items:center; gap:8px;">
          <img src="${esc(r.headerImage)}" width="32" style="border-radius:3px; display:block;" />
          <span style="font-size:13px; font-weight:600; color:${TEXT_PRIMARY};">${esc(r.title)}</span>
        </div>
      </td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${addsC}; font-weight:600; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtSigned(r.weeklyWishlistAdds)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${folC}; font-weight:600; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtSigned(r.weeklyFollowerAdds)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${r.rankSunday ?? "—"}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${rankDeltaC}; font-weight:600; font-variant-numeric:tabular-nums; font-family:${FONT};">${r.rankDelta != null ? fmtSigned(r.rankDelta) : "—"}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${r.igdbHype ?? "—"}</td>
    </tr>`;
}

function revTableRow(r: WeeklyRevenueRow): string {
  return `
    <tr style="border-bottom:1px solid ${BORDER};">
      <td style="padding:10px 8px; font-family:${FONT};">
        <div style="display:flex; align-items:center; gap:8px;">
          <img src="${esc(r.headerImage)}" width="32" style="border-radius:3px; display:block;" />
          <span style="font-size:13px; font-weight:600; color:${TEXT_PRIMARY};">${esc(r.title)}</span>
        </div>
      </td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtNum(r.baseUnitsWeek)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtUsd(r.baseRevenueWeek)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtNum(r.dlcUnitsWeek)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtUsd(r.dlcRevenueWeek)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_PRIMARY}; font-weight:600; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtUsd(r.totalRevenueWeek)}</td>
      <td style="padding:10px 8px; text-align:right; font-size:13px; color:${TEXT_MUTED}; font-variant-numeric:tabular-nums; font-family:${FONT};">${fmtUsd(r.ltdRevenueUsd)}</td>
    </tr>`;
}

function formatWeekLabel(window: WeekWindow, sentAt: Date): { weekOf: string; sentOn: string } {
  const weekStart = new Date(`${window.weekStart}T12:00:00.000Z`);
  const weekEnd = new Date(`${window.weekEnd}T12:00:00.000Z`);
  const monthDay = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const weekOf = weekStart.getUTCMonth() === weekEnd.getUTCMonth()
    ? `${monthDay(weekStart)} – ${weekEnd.getUTCDate()}, ${weekEnd.getUTCFullYear()}`
    : `${monthDay(weekStart)} – ${monthDay(weekEnd)}, ${weekEnd.getUTCFullYear()}`;
  const sentOn = sentAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
  return { weekOf, sentOn };
}

// ─── LLM narrative (Perplexity Sonar, optional — graceful degradation) ─────

/** YYYY-MM-DD -> MM/DD/YYYY, offset by `days` (may be negative). For Sonar's search_*_date_filter params. */
function toSonarDateFilter(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

async function generateDigestNarrative(
  section: "wishlist" | "revenue",
  summary: string,
  window: WeekWindow,
): Promise<SonarResult | null> {
  if (!sonarAvailable()) return null;
  const weekLabel = `${window.weekStart} through ${window.weekEnd}`;
  const prompt = section === "wishlist"
    ? `Write a short internal digest paragraph summarizing this week's (${weekLabel}) Steam wishlist/follower/rank movement for our pre-release titles. For each title, research whether it had any real, dated news during or just before this week (Steam festival/event inclusion, demo drop, reveal trailer, showcase appearance, patch/DLC news, review coverage) that could plausibly explain a notable move in its numbers — only mention this when you find an actual dated source. Data:\n${summary}`
    : `Write a short internal digest paragraph summarizing this week's (${weekLabel}) Steam sales revenue (game + DLC) for our released/pre-purchase titles. For each title, research whether it had a Steam storefront sale/discount, a sales event/festival inclusion, or another news beat (patch/DLC release, review, controversy, esports/streamer coverage) during or just before this week that could plausibly explain a notable move in its units or revenue — only mention this when you find an actual dated source. Data:\n${summary}`;
  return callSonar(prompt, {
    searchAfterDateFilter: toSonarDateFilter(window.weekStart, -3),
    searchBeforeDateFilter: toSonarDateFilter(window.weekEnd, 1),
  });
}

function buildWishlistNarrativeSummary(rows: WeeklyWishlistRow[], kpis: ReturnType<typeof getWeeklyWishlistKpis>): string {
  const lines = rows.map((r) =>
    `- ${r.title} (Steam App ID ${r.steamAppId}): ${r.weeklyWishlistAdds ?? "no data"} net wishlist adds, ${r.weeklyFollowerAdds ?? "no data"} follower adds, rank ${r.rankSunday ?? "unranked"} (${r.rankDelta != null ? (r.rankDelta >= 0 ? `+${r.rankDelta} spots` : `${r.rankDelta} spots`) : "no prior rank"}).`
  );
  return `Total wishlist adds across all titles: ${kpis.totalWishlistAdds}. Total follower adds: ${kpis.totalFollowerAdds}.\n${lines.join("\n")}`;
}

function buildRevenueNarrativeSummary(rows: WeeklyRevenueRow[], kpis: ReturnType<typeof getWeeklyRevenueKpis>): string {
  const lines = rows.map((r) =>
    `- ${r.title} (Steam App ID ${r.steamAppId}): ${r.baseUnitsWeek} base units (${fmtUsd(r.baseRevenueWeek)}), ${r.dlcUnitsWeek} DLC units (${fmtUsd(r.dlcRevenueWeek)}), total ${fmtUsd(r.totalRevenueWeek)} this week.`
  );
  return `Total units this week: ${kpis.totalUnitsWeek}. Total revenue this week: ${fmtUsd(kpis.totalRevenueWeek)}.\n${lines.join("\n")}`;
}

// ─── HTML render ────────────────────────────────────────────────────────────

export async function renderWeeklyDigestHtml(
  window: WeekWindow = getWeekWindow(new Date()),
  sentAt: Date = new Date(),
): Promise<{ subject: string; html: string }> {
  const wlRows = getWeeklyWishlistRows(window);
  const wlKpis = getWeeklyWishlistKpis(wlRows);
  const revRows = getWeeklyRevenueRows(window);
  const revKpis = getWeeklyRevenueKpis(revRows);

  const [wlNarrative, revNarrative] = await Promise.all([
    generateDigestNarrative("wishlist", buildWishlistNarrativeSummary(wlRows, wlKpis), window),
    generateDigestNarrative("revenue", buildRevenueNarrativeSummary(revRows, revKpis), window),
  ]);

  const wlRowsHtml = wlRows.map(wlTableRow).join("");
  const revRowsHtml = revRows.map(revTableRow).join("");
  const { weekOf, sentOn } = formatWeekLabel(window, sentAt);

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
    Week in review: ${esc(weekOf)} &nbsp;·&nbsp; Sent ${esc(sentOn)}</div>
</td></tr>

<!-- Wishlist Section -->
<tr><td style="padding:0 6px 10px 6px;">
  <div style="font-family:${FONT}; font-size:12px; font-weight:700; letter-spacing:.08em; color:${BRAND_ACCENT};
              text-transform:uppercase; border-bottom:2px solid ${BRAND_ACCENT}; padding-bottom:6px; margin-bottom:14px;">
    Pre-Release Steam Wishlist — Week in Review</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${statPill("Total Wishlist Adds", fmtSigned(wlKpis.totalWishlistAdds))}
    ${statPill("Total Follower Adds", fmtSigned(wlKpis.totalFollowerAdds))}
  </tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;"><tr>
    ${moverCard("Biggest Wishlist Mover", wlKpis.biggestWishlistMover)}
    ${moverCard("Biggest Rank Mover", wlKpis.biggestRankMover, { suffix: " spots" })}
    ${moverCard("Biggest Follower Mover", wlKpis.biggestFollowerMover)}
  </tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin-top:14px; background:${BG_CARD}; border:1px solid ${BORDER}; border-radius:8px; border-collapse:collapse;">
    <tr style="background:#fafafa;">
      <th style="padding:9px 8px; text-align:left; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Title</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Week Wishlist Adds</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Week Follower Adds</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Rank (Sun)</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Week Δ</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Hype</th>
    </tr>
    ${wlRowsHtml}
  </table>
  ${narrativeBlock(wlNarrative)}

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
    Saber Steam Revenue — Week in Review</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${statPill("Total Units This Week", fmtNum(revKpis.totalUnitsWeek))}
    ${statPill("Total Revenue This Week", fmtUsd(revKpis.totalRevenueWeek))}
  </tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;"><tr>
    ${moverCard("Biggest Weekly Units Mover", revKpis.biggestUnitsMover, { widthPct: 50 })}
    ${moverCard("Biggest Weekly Revenue Mover", revKpis.biggestRevenueMover, { widthPct: 50, format: fmtSignedUsd })}
  </tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin-top:14px; background:${BG_CARD}; border:1px solid ${BORDER}; border-radius:8px; border-collapse:collapse;">
    <tr style="background:#fafafa;">
      <th style="padding:9px 8px; text-align:left; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Title</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Game Units (Wk)</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Game Rev (Wk)</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">DLC Units (Wk)</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">DLC Rev (Wk)</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">Total Rev (Wk)</th>
      <th style="padding:9px 8px; text-align:right; font-size:10px; font-weight:700; letter-spacing:.04em; color:${TEXT_MUTED}; text-transform:uppercase; font-family:${FONT};">LTD Rev</th>
    </tr>
    ${revRowsHtml}
  </table>
  ${narrativeBlock(revNarrative)}

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

/** Send the weekly digest to every active recipient, or to `overrideRecipients`
 * when provided (used by the manual "Send test digest now" trigger to target a
 * single verified test address instead of the full production distribution
 * list, e.g. while the Resend sending domain is still unverified).
 *
 * `window` — which Mon-Sun week to summarize. Omitted → the live "current"
 * prior week computed from `new Date()` (used by the manual test-send route
 * and the on-time Monday cron path). Explicitly passed by the hold/release
 * path so a backfilled send still reports the ORIGINAL target week, not
 * whatever week is "current" at release time.
 *
 * This function does NOT check the hold gate itself — callers
 * (runWeeklyDigestCronTick / the release check / the manual test-send route)
 * decide whether gating applies. */
export async function sendWeeklyLeaderboardDigest(
  window?: WeekWindow, overrideRecipients?: string[],
): Promise<DigestSendResult & { subject: string }> {
  const effectiveWindow = window ?? getWeekWindow(new Date());
  const recipients = overrideRecipients && overrideRecipients.length > 0
    ? overrideRecipients
    : storage.getActiveLeaderboardEmailRecipients().map((r) => r.email);
  const { subject, html } = await renderWeeklyDigestHtml(effectiveWindow, new Date());

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

/** Proactive alert for a failed/expired Steamworks cookie session, sent from
 * `ingestSteamSales()` in ingestion.ts when the session-expired pattern is
 * detected. Reuses the same Resend infra and recipient list as the weekly
 * leaderboard digest — same audience needs to know sales data has stopped
 * updating. Caller is responsible for its own send cooldown (via
 * storage.setSteamworksSessionAlertSent) so this isn't fired on every cron
 * run while the cookie stays broken. */
export async function sendSteamCookieExpiryAlert(detail: string): Promise<DigestSendResult> {
  const recipients = storage.getActiveLeaderboardEmailRecipients().map((r) => r.email);
  if (recipients.length === 0) {
    log("Steam cookie-expiry alert: no active recipients, skipping send", "leaderboard-digest");
    return { sent: false, reason: "no_active_recipients" };
  }

  const subject = "SignalPulse alert: Steamworks cookie expired — sales data will stop updating";
  const html = `
    <div style="font-family:${FONT};max-width:560px;margin:0 auto;padding:24px;background:${BG_PAGE};">
      <div style="background:${BG_CARD};border:1px solid ${BORDER};border-radius:8px;padding:24px;">
        <h2 style="color:${NEGATIVE};margin:0 0 12px;font-size:18px;">Steamworks session cookie expired</h2>
        <p style="color:${TEXT_PRIMARY};line-height:1.5;font-size:14px;margin:0 0 12px;">
          The daily sales ingestion just failed because the Steamworks session cookie has expired.
          Revenue leaderboard sales data will stop updating until it's refreshed. If this happens during
          the current digest week, the Monday Weekly Steam Leaderboard Digest will be held automatically
          until the missing day's sales data is backfilled.
        </p>
        <p style="color:${TEXT_MUTED};font-size:12px;line-height:1.5;margin:0 0 20px;">${esc(detail)}</p>
        <a href="${BASE_URL}/settings#/settings" style="display:inline-block;background:${BRAND_ACCENT};color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">
          Reconnect cookie in Settings
        </a>
      </div>
    </div>`;

  const result = await sendViaResend(subject, recipients, html);
  if (result.sent) {
    log(`Steam cookie-expiry alert sent to ${result.recipients} recipient(s)`, "leaderboard-digest");
  } else {
    log(`Steam cookie-expiry alert NOT sent: ${result.reason}${result.detail ? " — " + result.detail : ""}`, "leaderboard-digest");
  }
  return result;
}

// ─── Hold/release gate ──────────────────────────────────────────────────────
// Per user direction (2026-08-14): "If there isn't a full week's data because
// a session went stale via steam cookie we pause the digest being sent until
// the missing day is filled in ... then compile and send."

/** Called from the Monday cron tick instead of sendWeeklyLeaderboardDigest
 * directly. If the week has sales-ingestion gaps, holds the digest (persists
 * hold state, does NOT send) and logs which title/day(s) are missing.
 * Otherwise sends normally and clears any stale hold state for that week. */
export async function runWeeklyDigestCronTick(now: Date): Promise<void> {
  const window = getWeekWindow(now);
  const gaps = detectSalesGaps(window);

  if (gaps.hasGaps) {
    setHeldDigestWeek(window, gaps.missingByProduct);
    const missingCount = Object.keys(gaps.missingByProduct).length;
    log(
      `Weekly leaderboard digest HELD for week ${window.weekStart}..${window.weekEnd}: ` +
      `${missingCount} title(s) missing sales-ingestion batch(es) — ${JSON.stringify(gaps.missingByProduct)}`,
      "leaderboard-digest",
    );
    return;
  }

  await sendWeeklyLeaderboardDigest(window);
}

/** Called at the end of every ingestSteamSales() run (success or partial
 * success — gap detection re-checks the actual batches regardless). If a
 * digest is currently held and the week's gaps are now fully filled, sends
 * it immediately using the ORIGINAL held week window (not whatever week is
 * "current" now) and clears the hold. If gaps remain, refreshes the stored
 * missing-day list (in case some but not all days were backfilled) and
 * stays held. No-op if nothing is currently held. Never throws — a failure
 * here must not break the ingestion run that called it. */
export async function checkAndReleaseHeldDigest(): Promise<void> {
  try {
    const held = getHeldDigestWeek();
    if (!held) return;

    const gaps = detectSalesGaps(held);
    if (gaps.hasGaps) {
      setHeldDigestWeek(held, gaps.missingByProduct);
      log(
        `Weekly leaderboard digest still held for week ${held.weekStart}..${held.weekEnd}: ` +
        `${Object.keys(gaps.missingByProduct).length} title(s) still missing data`,
        "leaderboard-digest",
      );
      return;
    }

    clearHeldDigestWeek();
    log(`Weekly leaderboard digest gaps resolved for week ${held.weekStart}..${held.weekEnd} — sending held digest now`, "leaderboard-digest");
    await sendWeeklyLeaderboardDigest(held);
  } catch (err) {
    log(`checkAndReleaseHeldDigest error (non-fatal): ${err}`, "leaderboard-digest");
  }
}

// ─── Weekly Cron Scheduler ──────────────────────────────────────────────────
// Self-contained interval scheduler. `server/ingestion.ts` exports
// `startIngestionCron`/`stopIngestionCron` — confirmed live in production,
// firing daily at 03:00 America/New_York for Steam sales/wishlist ingestion.
// This scheduler is independent of that and is explicitly started from
// `server/index.ts`.
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
 * pacing style as the existing daily ingestion scheduler in ingestion.ts).
 *
 * Fires on a 0-5 minute window past 07:00 ET rather than an exact
 * `minute === 0` match — setInterval ticks can drift a few seconds/minutes
 * under load, and an exact-minute gate can silently skip the whole send for
 * a week (see task-scheduling guidance on exact-minute wall-clock gates).
 * `weeklyDigestLastRunDate` still guarantees at most one run (send-or-hold
 * decision) per calendar day. */
export function startWeeklyDigestCron(): void {
  if (weeklyDigestCronInterval) return; // idempotent
  log("Weekly leaderboard digest cron scheduler started (Mondays 07:00 America/New_York)", "leaderboard-digest");

  weeklyDigestCronInterval = setInterval(() => {
    const now = new Date();
    const { hour, minute, weekday } = getEasternHourMinuteWeekday(now);
    const todayStr = now.toISOString().split("T")[0];

    if (weekday === "Mon" && hour === 7 && minute >= 0 && minute <= 5 && weeklyDigestLastRunDate !== todayStr) {
      weeklyDigestLastRunDate = todayStr;
      runWeeklyDigestCronTick(now).catch((err) => {
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
