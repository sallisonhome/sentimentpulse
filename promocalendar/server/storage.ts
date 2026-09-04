/**
 * All DB reads/writes live here. Routes stay HTTP-focused.
 * Every query is scoped to a single `calendar` (saber | saber_focus) so the
 * two calendars are hard-isolated.
 */
import { raw as sqlite } from "./db.js";
import { CALENDARS, UPLOAD_HISTORY_LIMIT, type CalendarId } from "../shared/schema.js";
import type { ParseResult, ParsedCampaign } from "./parser.js";
import { rollupDiscount } from "./parser.js";
import crypto, { createHash } from "node:crypto";

export function isCalendarId(x: unknown): x is CalendarId {
  return typeof x === "string" && (CALENDARS as readonly string[]).includes(x);
}

// ─── Uploads ──────────────────────────────────────────────────────────────────

export interface UploadRow {
  id: number;
  calendar: CalendarId;
  filename: string;
  file_size_bytes: number;
  file_sha256: string;
  uploaded_at: string;
  uploaded_by: string | null;
  events_count: number;
  campaigns_count: number;
  parse_warnings: string[];
  is_active: boolean;
  notes: string | null;
}

function shapeUpload(r: any): UploadRow {
  return {
    id: r.id,
    calendar: r.calendar,
    filename: r.filename,
    file_size_bytes: r.file_size_bytes,
    file_sha256: r.file_sha256,
    uploaded_at: r.uploaded_at,
    uploaded_by: r.uploaded_by,
    events_count: r.events_count,
    campaigns_count: r.campaigns_count,
    parse_warnings: JSON.parse(r.parse_warnings || "[]"),
    is_active: !!r.is_active,
    notes: r.notes,
  };
}

export function listUploads(calendar: CalendarId): UploadRow[] {
  const rows = sqlite
    .prepare(
      `SELECT * FROM uploads WHERE calendar = ? ORDER BY uploaded_at DESC`,
    )
    .all(calendar) as any[];
  return rows.map(shapeUpload);
}

export function getActiveUpload(calendar: CalendarId): UploadRow | null {
  const row = sqlite
    .prepare(
      `SELECT * FROM uploads WHERE calendar = ? AND is_active = 1 LIMIT 1`,
    )
    .get(calendar) as any;
  return row ? shapeUpload(row) : null;
}

export function getUploadBlob(id: number): { calendar: CalendarId; filename: string; blob: Buffer } | null {
  const row = sqlite
    .prepare(`SELECT calendar, filename, file_blob FROM uploads WHERE id = ?`)
    .get(id) as any;
  if (!row) return null;
  return {
    calendar: row.calendar,
    filename: row.filename,
    blob: Buffer.from(row.file_blob, "base64"),
  };
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

export interface IngestResult {
  upload: UploadRow;
  parseResult: ParseResult;
}

/**
 * Persist a new upload, activate it, deactivate the previous active upload,
 * write all campaigns + SKUs, and prune upload history to the last N.
 */
export function ingest(
  calendar: CalendarId,
  file: { filename: string; buffer: Buffer },
  uploadedBy: string | null,
  parseResult: ParseResult,
): IngestResult {
  const sha = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const base64 = file.buffer.toString("base64");
  const now = new Date().toISOString();

  const tx = sqlite.transaction(() => {
    // Deactivate any existing active upload (full-replace behavior).
    sqlite
      .prepare(`UPDATE uploads SET is_active = 0 WHERE calendar = ? AND is_active = 1`)
      .run(calendar);

    const info = sqlite
      .prepare(
        `INSERT INTO uploads
         (calendar, filename, file_size_bytes, file_sha256, file_blob, uploaded_at, uploaded_by,
          events_count, campaigns_count, parse_warnings, is_active, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`,
      )
      .run(
        calendar,
        file.filename,
        file.buffer.length,
        sha,
        base64,
        now,
        uploadedBy,
        parseResult.campaigns.reduce((s, c) => s + c.skus.length, 0),
        parseResult.campaigns.length,
        JSON.stringify(parseResult.warnings),
      );
    const uploadId = Number(info.lastInsertRowid);

    // Wipe all rows for this calendar from prior uploads (full-replace).
    // We deliberately keep the OLD upload rows in `uploads` for rollback, but
    // the campaigns/sku_lines tables only ever hold the ACTIVE upload's data.
    sqlite.prepare(`DELETE FROM sku_lines WHERE campaign_id IN
        (SELECT id FROM campaigns WHERE calendar = ?)`).run(calendar);
    sqlite.prepare(`DELETE FROM campaigns WHERE calendar = ?`).run(calendar);

    const insertCamp = sqlite.prepare(
      `INSERT INTO campaigns
       (upload_id, calendar, sheet_name, game_code, game_label, sheet_year,
        platform, platform_raw, program, start_date, end_date,
        sku_count, max_discount_pct, min_discount_pct, notes,
        source_row_start, source_row_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSku = sqlite.prepare(
      `INSERT INTO sku_lines
       (campaign_id, upload_id, content_name, current_srp_usd, promo_srp_usd,
        discount_pct, extra, source_row)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const c of parseResult.campaigns) {
      const disc = rollupDiscount(c.skus);
      const info = insertCamp.run(
        uploadId,
        calendar,
        c.sheet_name,
        c.game_code,
        c.game_label,
        c.sheet_year,
        c.platform,
        c.platform_raw,
        c.program,
        c.start_date,
        c.end_date,
        c.skus.length,
        disc.max,
        disc.min,
        c.notes,
        c.source_row_start ?? null,
        c.source_row_end ?? null,
      );
      const campaignId = Number(info.lastInsertRowid);
      for (const s of c.skus) {
        insertSku.run(
          campaignId,
          uploadId,
          s.content_name,
          s.current_srp_usd,
          s.promo_srp_usd,
          s.discount_pct,
          JSON.stringify(s.extra),
          s.source_row ?? null,
        );
      }
    }

    // Prune upload history to the last N per calendar (delete OLDEST inactive
    // rows). Never delete the currently-active row.
    const historyOverflow = sqlite
      .prepare(
        `SELECT id FROM uploads
         WHERE calendar = ? AND is_active = 0
         ORDER BY uploaded_at DESC
         LIMIT -1 OFFSET ?`,
      )
      .all(calendar, UPLOAD_HISTORY_LIMIT - 1) as { id: number }[];
    if (historyOverflow.length) {
      const ids = historyOverflow.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      sqlite.prepare(`DELETE FROM uploads WHERE id IN (${placeholders})`).run(...ids);
    }

    return uploadId;
  });

  const uploadId = tx();
  const uploadRow = sqlite
    .prepare(`SELECT * FROM uploads WHERE id = ?`)
    .get(uploadId) as any;
  return { upload: shapeUpload(uploadRow), parseResult };
}

/**
 * Roll back to a specific historical upload — activates that upload and
 * replays its campaigns/skus by re-parsing its stored blob.
 * Returns null if the upload doesn't exist.
 */
export async function rollbackTo(
  uploadId: number,
  parse: (buf: Buffer) => Promise<ParseResult>,
): Promise<UploadRow | null> {
  const stored = getUploadBlob(uploadId);
  if (!stored) return null;
  const parsed = await parse(stored.blob);

  const tx = sqlite.transaction(() => {
    // Deactivate current active for this calendar.
    sqlite
      .prepare(`UPDATE uploads SET is_active = 0 WHERE calendar = ? AND is_active = 1`)
      .run(stored.calendar);
    // Wipe campaigns/skus for this calendar.
    sqlite.prepare(`DELETE FROM sku_lines WHERE campaign_id IN
        (SELECT id FROM campaigns WHERE calendar = ?)`).run(stored.calendar);
    sqlite.prepare(`DELETE FROM campaigns WHERE calendar = ?`).run(stored.calendar);
    // Reactivate the target.
    sqlite.prepare(`UPDATE uploads SET is_active = 1 WHERE id = ?`).run(uploadId);

    // Re-insert campaigns/skus.
    const insertCamp = sqlite.prepare(
      `INSERT INTO campaigns
       (upload_id, calendar, sheet_name, game_code, game_label, sheet_year,
        platform, platform_raw, program, start_date, end_date,
        sku_count, max_discount_pct, min_discount_pct, notes,
        source_row_start, source_row_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSku = sqlite.prepare(
      `INSERT INTO sku_lines
       (campaign_id, upload_id, content_name, current_srp_usd, promo_srp_usd,
        discount_pct, extra, source_row)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of parsed.campaigns) {
      const disc = rollupDiscount(c.skus);
      const info = insertCamp.run(
        uploadId,
        stored.calendar,
        c.sheet_name,
        c.game_code,
        c.game_label,
        c.sheet_year,
        c.platform,
        c.platform_raw,
        c.program,
        c.start_date,
        c.end_date,
        c.skus.length,
        disc.max,
        disc.min,
        c.notes,
        c.source_row_start ?? null,
        c.source_row_end ?? null,
      );
      const campaignId = Number(info.lastInsertRowid);
      for (const s of c.skus) {
        insertSku.run(
          campaignId,
          uploadId,
          s.content_name,
          s.current_srp_usd,
          s.promo_srp_usd,
          s.discount_pct,
          JSON.stringify(s.extra),
          s.source_row ?? null,
        );
      }
    }
  });
  tx();

  const row = sqlite.prepare(`SELECT * FROM uploads WHERE id = ?`).get(uploadId) as any;
  return shapeUpload(row);
}

// ─── Campaigns / calendar reads ───────────────────────────────────────────────

export interface CampaignRow {
  id: number;
  calendar: CalendarId;
  game_code: string;
  game_label: string;
  sheet_name: string;
  sheet_year: number;
  platform: string;
  platform_raw: string;
  program: string;
  start_date: string;
  end_date: string;
  sku_count: number;
  max_discount_pct: number;
  min_discount_pct: number;
  notes: string | null;
}

function shapeCampaign(r: any): CampaignRow {
  return {
    id: r.id,
    calendar: r.calendar,
    game_code: r.game_code,
    game_label: r.game_label,
    sheet_name: r.sheet_name,
    sheet_year: r.sheet_year,
    platform: r.platform,
    platform_raw: r.platform_raw,
    program: r.program,
    start_date: r.start_date,
    end_date: r.end_date,
    sku_count: r.sku_count,
    max_discount_pct: r.max_discount_pct,
    min_discount_pct: r.min_discount_pct,
    notes: r.notes,
  };
}

export interface CampaignFilter {
  platform?: string;
  game_code?: string;
  from?: string; // inclusive ISO date
  to?: string; // inclusive ISO date
  program?: string;
}

export function listCampaigns(
  calendar: CalendarId,
  filter: CampaignFilter = {},
): CampaignRow[] {
  const clauses = ["calendar = ?"];
  const params: any[] = [calendar];
  if (filter.platform) {
    clauses.push("platform = ?");
    params.push(filter.platform);
  }
  if (filter.game_code) {
    clauses.push("game_code = ?");
    params.push(filter.game_code);
  }
  if (filter.program) {
    clauses.push("program = ?");
    params.push(filter.program);
  }
  if (filter.from) {
    // Campaign OVERLAPS the window [from, to]: end_date >= from
    clauses.push("end_date >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push("start_date <= ?");
    params.push(filter.to);
  }
  const sql = `SELECT * FROM campaigns
               WHERE ${clauses.join(" AND ")}
               ORDER BY start_date ASC, game_label ASC`;
  const rows = sqlite.prepare(sql).all(...params) as any[];
  return rows.map(shapeCampaign);
}

export function getCampaign(id: number): { campaign: CampaignRow; skus: any[] } | null {
  const row = sqlite.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id) as any;
  if (!row) return null;
  const skus = sqlite
    .prepare(`SELECT * FROM sku_lines WHERE campaign_id = ? ORDER BY id ASC`)
    .all(id) as any[];
  return {
    campaign: shapeCampaign(row),
    skus: skus.map((s) => ({
      id: s.id,
      content_name: s.content_name,
      current_srp_usd: s.current_srp_usd,
      promo_srp_usd: s.promo_srp_usd,
      discount_pct: s.discount_pct,
      extra: JSON.parse(s.extra || "{}"),
      source_row: s.source_row,
    })),
  };
}

// ─── Games directory ──────────────────────────────────────────────────────────

export interface GameSummary {
  game_code: string;
  game_label: string;
  campaign_count: number;
  platforms: string[];
}

export function listGames(calendar: CalendarId): GameSummary[] {
  const rows = sqlite
    .prepare(
      `SELECT game_code, game_label,
              COUNT(*) AS campaign_count,
              GROUP_CONCAT(DISTINCT platform) AS platforms
       FROM campaigns
       WHERE calendar = ?
       GROUP BY game_code, game_label
       ORDER BY game_label ASC`,
    )
    .all(calendar) as any[];
  return rows.map((r) => ({
    game_code: r.game_code,
    game_label: r.game_label,
    campaign_count: r.campaign_count,
    platforms: (r.platforms || "").split(",").filter(Boolean).sort(),
  }));
}

// ─── Next Up ──────────────────────────────────────────────────────────────────

export interface NextUpBeat {
  campaign_id: number;
  game_code: string;
  game_label: string;
  platform: string;
  program: string;
  start_date: string;
  end_date: string;
  max_discount_pct: number;
  days_until_start: number; // negative if in-flight
  is_active: boolean; // start_date <= today <= end_date
  // Optional Steam revenue enrichment (only populated for in-flight Steam
  // beats where SignalPulse has data). Sums net + gross revenue from
  // start_date through today (server-anchored) so the number matches what
  // shows up on SignalPulse's Steam Revenue Leaderboard cumulatively.
  //
  // null when SignalPulse is unreachable / has no rows yet / not a Steam
  // beat. Callers must render "—" or hide the chip in that case, never
  // display $0 unless days_covered > 0 confirms there really are zero
  // sales in the window.
  steam_current_net_revenue_usd?: number | null;
  steam_current_gross_revenue_usd?: number | null;
  steam_current_days_covered?: number | null;
  // The BASE-GAME SKU on this campaign, if the sheet had one. Detection
  // rule: SKU whose content_name exactly equals the campaign's game_label.
  // Cards use this to show real prices (strike-through SRP + promo price +
  // exact discount) instead of the vaguer "up to X%".
  //
  // null when the sale is DLC-only (e.g. "Add-on Sale" campaigns where
  // every SKU is a pack or season pass and no SKU matches the base game).
  // Callers must fall back to the "up to {max_discount_pct}%" framing in
  // that case, per the 2026-09-04 rule.
  primary_sku?: {
    content_name: string;
    current_srp_usd: number;
    promo_srp_usd: number;
    discount_pct: number;
  } | null;
}

/**
 * Next N STRICTLY-FUTURE beats for a single title, across every platform.
 * Server anchors on `today` so this self-updates as beats pass.
 *
 * In-flight beats (start_date <= today <= end_date) are deliberately
 * excluded — they belong on a Live Now surface, not Next Up. A campaign
 * cannot be both a live promo and "next up" simultaneously; showing it in
 * both surfaces produces a live-badged card under a "Next Up" label.
 *
 * Changed 2026-09-04 for parity with nextUpForCalendar/nextUpMultiTitle
 * after the same bug was flagged at the PDP level. See lessons.md.
 */
export function nextUpForGame(
  calendar: CalendarId,
  game_code: string,
  limit: number,
  today: string,
): NextUpBeat[] {
  const rows = sqlite
    .prepare(
      `SELECT id, game_code, game_label, platform, program, start_date, end_date, max_discount_pct
       FROM campaigns
       WHERE calendar = ? AND game_code = ? AND start_date > ?
       ORDER BY start_date ASC, end_date ASC, id ASC
       LIMIT ?`,
    )
    .all(calendar, game_code, today, limit) as any[];
  return shapeBeatsWithPrimarySku(rows, today);
}

/**
 * Next N STRICTLY-FUTURE beats for a specific platform, across every title
 * in the calendar. Powers each platform view's "Next Up" strip.
 *
 * Same rationale as nextUpForGame above — in-flight beats are excluded
 * because they belong on Live Now, not Next Up. Changed 2026-09-04.
 */
export function nextUpForPlatform(
  calendar: CalendarId,
  platform: string,
  limit: number,
  today: string,
): NextUpBeat[] {
  const rows = sqlite
    .prepare(
      `SELECT id, game_code, game_label, platform, program, start_date, end_date, max_discount_pct
       FROM campaigns
       WHERE calendar = ? AND platform = ? AND start_date > ?
       ORDER BY start_date ASC, end_date ASC, id ASC
       LIMIT ?`,
    )
    .all(calendar, platform, today, limit) as any[];
  return shapeBeatsWithPrimarySku(rows, today);
}

/**
 * Next N upcoming beats for the WHOLE calendar (any platform, any title).
 * Powers the calendar-level "Next Up" strip on the landing page.
 */
export function nextUpForCalendar(
  calendar: CalendarId,
  limit: number,
  today: string,
): NextUpBeat[] {
  // Next Up = STRICTLY FUTURE (start_date > today). In-flight beats belong
  // on the Promos Live Now surface (liveNowForCalendar), not Next Up. A
  // campaign cannot be both simultaneously — that would double-count it on
  // the landing page and produce a live-badged card under a "Next Up" label.
  //
  // Changed 2026-09-04 after user flagged live-badged cards appearing in
  // the Next Up rows. See lessons.md.
  const rows = sqlite
    .prepare(
      `SELECT id, game_code, game_label, platform, program, start_date, end_date, max_discount_pct
       FROM campaigns
       WHERE calendar = ? AND start_date > ?
       ORDER BY start_date ASC, end_date ASC, id ASC
       LIMIT ?`,
    )
    .all(calendar, today, limit) as any[];
  return shapeBeatsWithPrimarySku(rows, today);
}

/**
 * ALL campaigns currently in-flight (start_date <= today <= end_date). No
 * limit — powers the "Promos Live Now" surface which shows the top few
 * inline plus a "view all" affordance.
 *
 * Sort: Steam-biased first, then soonest-ending. This matches the treatment
 * elsewhere in the app that assumes Steam is the primary revenue channel and
 * therefore the highest-signal cards to surface when we can only show a few.
 *   1. Steam campaigns before non-Steam.
 *   2. Within a platform group, campaigns ending soonest come first
 *      (max urgency — they roll off the badge soon).
 *   3. Deterministic tiebreaker by campaign id.
 */
export function liveNowForCalendar(
  calendar: CalendarId,
  today: string,
): NextUpBeat[] {
  const rows = sqlite
    .prepare(
      `SELECT id, game_code, game_label, platform, program, start_date, end_date, max_discount_pct
       FROM campaigns
       WHERE calendar = ? AND start_date <= ? AND end_date >= ?
       ORDER BY
         CASE WHEN platform = 'Steam' THEN 0 ELSE 1 END,
         end_date ASC,
         id ASC`,
    )
    .all(calendar, today, today) as any[];
  return shapeBeatsWithPrimarySku(rows, today);
}

/**
 * ALL currently in-flight campaigns for a SINGLE title (start_date <= today
 * <= end_date). Powers the title-detail (PDP) "Live Now" strip — mirrors
 * liveNowForCalendar's Steam-biased ordering so the PDP treatment stays
 * consistent with the landing page.
 *
 * Added 2026-09-04 as the counterpart to the strict-future PDP Next Up
 * fix: with in-flight beats removed from Next Up, we need a first-class
 * PDP surface to show what's active right now for the title.
 */
export function liveNowForGame(
  calendar: CalendarId,
  game_code: string,
  today: string,
): NextUpBeat[] {
  const rows = sqlite
    .prepare(
      `SELECT id, game_code, game_label, platform, program, start_date, end_date, max_discount_pct
       FROM campaigns
       WHERE calendar = ? AND game_code = ? AND start_date <= ? AND end_date >= ?
       ORDER BY
         CASE WHEN platform = 'Steam' THEN 0 ELSE 1 END,
         end_date ASC,
         id ASC`,
    )
    .all(calendar, game_code, today, today) as any[];
  return shapeBeatsWithPrimarySku(rows, today);
}

/**
 * Look up the base-game SKU (content_name == game_label) for a batch of
 * campaign IDs in ONE query. Returns a Map<campaign_id, sku|null>.
 * Callers hand the map to shapeBeat() so per-card price display doesn't
 * fan out to N follow-up queries. Uses ROW_NUMBER over (discount_pct DESC,
 * id ASC) so if a base-game SKU appears twice on the same campaign
 * (unlikely but harmless) we keep the higher-discount row.
 *
 * A campaign missing an exact-match base-game SKU (DLC-only "Add-on Sale"
 * etc.) simply has no entry in the map; callers treat that as null and
 * fall back to the vaguer "up to X%" framing on the card.
 *
 * Added 2026-09-04 for the strike-through price treatment on per-title
 * beat cards.
 */
function fetchPrimarySkusForCampaigns(
  campaignIds: number[],
): Map<number, {
  content_name: string;
  current_srp_usd: number;
  promo_srp_usd: number;
  discount_pct: number;
} | null> {
  const out = new Map();
  if (!campaignIds.length) return out;
  const placeholders = campaignIds.map(() => "?").join(",");
  // Pull EVERY SKU that could plausibly be the base game for each
  // campaign in the batch, then rank them per campaign in application
  // code. Ranking beats SQL-only matching because the sheets use several
  // conventions that a single WHERE clause can't cleanly express:
  //
  //   Convention A  content_name == game_label (SM2 sheet, Gamescom)
  //   Convention B  case drift    ("RoadCraft" vs "Roadcraft")
  //   Convention C  punctuation drift ("Insurgency: Sandstorm" vs
  //                                     "Insurgency Sandstorm")
  //   Convention D  "<game_label> Base Game" (Expeditions sheet)
  //   Convention E  literal "Base Game" row (Toxic Commando sheet)
  //
  // Priority: A > B > C > D > E. Only one of these is picked per
  // campaign; ties inside a rank fall to the higher-discount row.
  const rows = sqlite
    .prepare(
      `SELECT s.campaign_id,
              s.content_name,
              s.current_srp_usd,
              s.promo_srp_usd,
              s.discount_pct,
              c.game_label
         FROM sku_lines s
         JOIN campaigns c ON c.id = s.campaign_id
        WHERE s.campaign_id IN (${placeholders})
          AND s.current_srp_usd IS NOT NULL
          AND s.promo_srp_usd IS NOT NULL`,
    )
    .all(...campaignIds) as any[];

  const norm = (s: string) =>
    s.toLowerCase().replace(/[:,\-]/g, " ").replace(/\s+/g, " ").trim();

  // Per-campaign best pick: (rank, discount) DESC. Lower rank = better
  // convention match.
  type Pick = {
    rank: number;
    row: any;
  };
  const best = new Map<number, Pick>();

  for (const r of rows) {
    const cn = (r.content_name ?? "").trim();
    const gl = (r.game_label ?? "").trim();
    if (!cn || !gl) continue;

    const cnL = cn.toLowerCase();
    const glL = gl.toLowerCase();
    let rank = 0;
    if (cn === gl) rank = 5; // A: exact
    else if (cnL === glL) rank = 4; // B: case drift
    else if (norm(cn) === norm(gl)) rank = 3; // C: punctuation drift
    else if (cnL === `${glL} base game`) rank = 2; // D
    else if (cnL === "base game") rank = 1; // E
    else continue;

    const prev = best.get(r.campaign_id);
    if (
      !prev ||
      rank > prev.rank ||
      (rank === prev.rank && r.discount_pct > prev.row.discount_pct)
    ) {
      best.set(r.campaign_id, { rank, row: r });
    }
  }

  for (const [cid, pick] of best) {
    out.set(cid, {
      content_name: pick.row.content_name,
      current_srp_usd: pick.row.current_srp_usd,
      promo_srp_usd: pick.row.promo_srp_usd,
      discount_pct: pick.row.discount_pct,
    });
  }
  return out;
}

function shapeBeat(
  r: any,
  today: string,
  primarySku?:
    | {
        content_name: string;
        current_srp_usd: number;
        promo_srp_usd: number;
        discount_pct: number;
      }
    | null,
): NextUpBeat {
  const daysUntil = Math.round(
    (Date.parse(r.start_date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) /
      86400000,
  );
  return {
    campaign_id: r.id,
    game_code: r.game_code,
    game_label: r.game_label,
    platform: r.platform,
    program: r.program,
    start_date: r.start_date,
    end_date: r.end_date,
    max_discount_pct: r.max_discount_pct,
    days_until_start: daysUntil,
    is_active: r.start_date <= today && r.end_date >= today,
    primary_sku: primarySku ?? null,
  };
}

/**
 * Apply base-game-SKU enrichment to a batch of raw campaign rows and
 * shape them into NextUpBeat[]. Every caller that returned NextUpBeats
 * from a rows list is a candidate; we ran one JOIN per row before, now
 * ONE JOIN for the whole batch.
 */
function shapeBeatsWithPrimarySku(rows: any[], today: string): NextUpBeat[] {
  const ids = rows.map((r) => r.id);
  const skuMap = fetchPrimarySkusForCampaigns(ids);
  return rows.map((r) => shapeBeat(r, today, skuMap.get(r.id) ?? null));
}

// ─── Next Up: Multi-Title Promos ─────────────────────────────────────────────

export interface MultiTitleBeat {
  program: string;
  platform: string;
  start_date: string;
  end_date: string;
  title_count: number;
  games: {
    game_code: string;
    game_label: string;
    campaign_id: number;
    max_discount_pct: number;
  }[];
  max_discount_pct: number;
  min_discount_pct: number;
  days_until_start: number;
  is_active: boolean;
}

/**
 * Next N multi-title promo events for a calendar. A multi-title event is
 * defined as a (program, platform, start_date, end_date) tuple spanning 2+
 * distinct games. In-flight events (start <= today <= end) come first sorted
 * by end date, then upcoming sorted by start date. Server anchors on `today`
 * so this self-updates as beats pass.
 *
 * Optional `platform` filter narrows to one platform view.
 */
export function nextUpMultiTitle(
  calendar: CalendarId,
  limit: number,
  today: string,
  opts: { platform?: string; minTitles?: number } = {},
): MultiTitleBeat[] {
  const minTitles = opts.minTitles ?? 2;
  // Next Up multi-title = STRICTLY FUTURE (start_date > today). Same reason
  // as nextUpForCalendar above: in-flight multi-title events belong on the
  // Promos Live Now surface, and duplicating them here produces cards
  // labelled "Next Up" that are actually live-badged. Changed 2026-09-04.
  const clauses = ["calendar = ?", "start_date > ?"];
  const params: any[] = [calendar, today];
  if (opts.platform) {
    clauses.push("platform = ?");
    params.push(opts.platform);
  }

  // Step 1: find qualifying (program, platform, start, end) tuples with 2+ titles.
  const groupSql = `
    SELECT program, platform, start_date, end_date,
           COUNT(DISTINCT game_code) AS title_count,
           MAX(max_discount_pct) AS max_discount_pct,
           MIN(min_discount_pct) AS min_discount_pct
    FROM campaigns
    WHERE ${clauses.join(" AND ")}
    GROUP BY program, platform, start_date, end_date
    HAVING title_count >= ?
    ORDER BY start_date ASC, end_date ASC
    LIMIT ?
  `;
  const groups = sqlite
    .prepare(groupSql)
    .all(...params, minTitles, limit) as any[];

  if (!groups.length) return [];

  // Step 2: hydrate the games list for each group in a single follow-up query.
  const results: MultiTitleBeat[] = [];
  const gameStmt = sqlite.prepare(
    `SELECT id, game_code, game_label, max_discount_pct
     FROM campaigns
     WHERE calendar = ?
       AND program = ?
       AND platform = ?
       AND start_date = ?
       AND end_date = ?
     ORDER BY game_label ASC`,
  );
  for (const g of groups) {
    const games = gameStmt.all(
      calendar,
      g.program,
      g.platform,
      g.start_date,
      g.end_date,
    ) as any[];
    const daysUntil = Math.round(
      (Date.parse(g.start_date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) /
        86400000,
    );
    results.push({
      program: g.program,
      platform: g.platform,
      start_date: g.start_date,
      end_date: g.end_date,
      title_count: g.title_count,
      games: games.map((row) => ({
        game_code: row.game_code,
        game_label: row.game_label,
        campaign_id: row.id,
        max_discount_pct: row.max_discount_pct,
      })),
      max_discount_pct: g.max_discount_pct,
      min_discount_pct: g.min_discount_pct,
      days_until_start: daysUntil,
      is_active: g.start_date <= today && g.end_date >= today,
    });
  }
  return results;
}

// ─── Events (Multi-title promo browsing) ──────────────────────────────────────
//
// An EVENT is a first-class object: any (program, platform, start, end) tuple
// spanning 2+ distinct titles. Same grouping key as `nextUpMultiTitle`, but
// exposed for browsing (all events, filterable) rather than "next N".
//
// event_key is a deterministic hash so URLs stay stable across sessions.

export interface EventRow {
  event_key: string;
  program: string;
  platform: string;
  start_date: string;
  end_date: string;
  title_count: number;
  max_discount_pct: number;
  min_discount_pct: number;
  days_until_start: number;
  is_active: boolean;
  is_past: boolean;
}

export interface EventDetail extends EventRow {
  games: {
    game_code: string;
    game_label: string;
    campaign_id: number;
    sku_count: number;
    max_discount_pct: number;
    min_discount_pct: number;
  }[];
}

function eventKey(
  calendar: string,
  program: string,
  platform: string,
  start_date: string,
  end_date: string,
): string {
  return createHash("sha1")
    .update(`${calendar}|${program}|${platform}|${start_date}|${end_date}`)
    .digest("hex")
    .slice(0, 16);
}

export interface EventFilter {
  platform?: string;
  program?: string;
  when?: "upcoming" | "live" | "past" | "all";
  min_titles?: number;
  from?: string;
  to?: string;
}

/**
 * List every multi-title event in the calendar, sorted by start date.
 * `when` narrows to upcoming (start > today), live (start <= today <= end),
 * past (end < today), or all (default). Default `min_titles` = 2.
 *
 * Sort order:
 *   upcoming/live: live first (by end date), then upcoming (by start date)
 *   past: newest first (by start date DESC)
 *   all: chronological by start date ASC (past too)
 */
export function listEvents(
  calendar: CalendarId,
  today: string,
  filter: EventFilter = {},
): EventRow[] {
  const minTitles = filter.min_titles ?? 2;
  const clauses = ["calendar = ?"];
  const params: any[] = [calendar];
  if (filter.platform) {
    clauses.push("platform = ?");
    params.push(filter.platform);
  }
  if (filter.program) {
    clauses.push("program = ?");
    params.push(filter.program);
  }
  if (filter.from) {
    clauses.push("end_date >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push("start_date <= ?");
    params.push(filter.to);
  }
  const when = filter.when ?? "all";
  if (when === "upcoming") {
    clauses.push("start_date > ?");
    params.push(today);
  } else if (when === "live") {
    clauses.push("start_date <= ?");
    clauses.push("end_date >= ?");
    params.push(today, today);
  } else if (when === "past") {
    clauses.push("end_date < ?");
    params.push(today);
  }

  let orderBy: string;
  const orderByParams: any[] = [];
  if (when === "past") {
    orderBy = "start_date DESC, end_date DESC";
  } else if (when === "upcoming" || when === "live") {
    orderBy =
      "CASE WHEN start_date <= ? THEN 0 ELSE 1 END, start_date ASC, end_date ASC";
    orderByParams.push(today);
  } else {
    orderBy = "start_date ASC, end_date ASC";
  }

  const sql = `
    SELECT program, platform, start_date, end_date,
           COUNT(DISTINCT game_code) AS title_count,
           MAX(max_discount_pct) AS max_discount_pct,
           MIN(min_discount_pct) AS min_discount_pct
    FROM campaigns
    WHERE ${clauses.join(" AND ")}
    GROUP BY program, platform, start_date, end_date
    HAVING title_count >= ?
    ORDER BY ${orderBy}
  `;
  const rows = sqlite
    .prepare(sql)
    .all(...params, minTitles, ...orderByParams) as any[];

  return rows.map((r) => {
    const daysUntil = Math.round(
      (Date.parse(r.start_date + "T00:00:00Z") -
        Date.parse(today + "T00:00:00Z")) /
        86400000,
    );
    const isLive = r.start_date <= today && r.end_date >= today;
    const isPast = r.end_date < today;
    return {
      event_key: eventKey(calendar, r.program, r.platform, r.start_date, r.end_date),
      program: r.program,
      platform: r.platform,
      start_date: r.start_date,
      end_date: r.end_date,
      title_count: r.title_count,
      max_discount_pct: r.max_discount_pct,
      min_discount_pct: r.min_discount_pct,
      days_until_start: daysUntil,
      is_active: isLive,
      is_past: isPast,
    };
  });
}

/**
 * Load a single event by its deterministic key (SHA1 of the tuple).
 * Returns the games participating with per-title campaign IDs and discount
 * ranges so the UI can link straight to each title's campaign detail.
 */
export function getEvent(
  calendar: CalendarId,
  event_key: string,
  today: string,
): EventDetail | null {
  // Reverse lookup: find the (program, platform, start, end) tuple whose
  // hash matches. SQLite doesn't do SHA1, and we don't want to hash every row
  // on the client, so we scan the group set and hash in JS. The group set is
  // small (<600 rows against 1000+ campaigns for the sample).
  const groups = sqlite
    .prepare(
      `SELECT program, platform, start_date, end_date,
              COUNT(DISTINCT game_code) AS title_count,
              MAX(max_discount_pct) AS max_discount_pct,
              MIN(min_discount_pct) AS min_discount_pct
       FROM campaigns
       WHERE calendar = ?
       GROUP BY program, platform, start_date, end_date
       HAVING title_count >= 2`,
    )
    .all(calendar) as any[];
  const match = groups.find(
    (g) =>
      eventKey(calendar, g.program, g.platform, g.start_date, g.end_date) ===
      event_key,
  );
  if (!match) return null;

  const games = sqlite
    .prepare(
      `SELECT id, game_code, game_label, sku_count, max_discount_pct, min_discount_pct
       FROM campaigns
       WHERE calendar = ?
         AND program = ?
         AND platform = ?
         AND start_date = ?
         AND end_date = ?
       ORDER BY game_label ASC`,
    )
    .all(calendar, match.program, match.platform, match.start_date, match.end_date) as any[];

  const daysUntil = Math.round(
    (Date.parse(match.start_date + "T00:00:00Z") -
      Date.parse(today + "T00:00:00Z")) /
      86400000,
  );
  const isLive = match.start_date <= today && match.end_date >= today;
  return {
    event_key,
    program: match.program,
    platform: match.platform,
    start_date: match.start_date,
    end_date: match.end_date,
    title_count: match.title_count,
    max_discount_pct: match.max_discount_pct,
    min_discount_pct: match.min_discount_pct,
    days_until_start: daysUntil,
    is_active: isLive,
    is_past: match.end_date < today,
    games: games.map((g) => ({
      game_code: g.game_code,
      game_label: g.game_label,
      campaign_id: g.id,
      sku_count: g.sku_count,
      max_discount_pct: g.max_discount_pct,
      min_discount_pct: g.min_discount_pct,
    })),
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * The server anchors "today" on the local date. Callers can override for
 * demo/testing via `?today=YYYY-MM-DD`.
 */
export function serverToday(override?: string | null): string {
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function distinctPlatforms(calendar: CalendarId): string[] {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT platform FROM campaigns WHERE calendar = ? ORDER BY platform ASC`,
    )
    .all(calendar) as { platform: string }[];
  return rows.map((r) => r.platform);
}

export function distinctPrograms(calendar: CalendarId): string[] {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT program FROM campaigns WHERE calendar = ? ORDER BY program ASC`,
    )
    .all(calendar) as { program: string }[];
  return rows.map((r) => r.program);
}
