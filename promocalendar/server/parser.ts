/**
 * Excel promo-schedule parser.
 *
 * Sheet shape (verified against the Saber sample 2026-09-04):
 *   - One workbook = many tabs. Each tab = one game per year.
 *     Tab name pattern: "<Game short-code> <Year>", e.g. "SM2 2026", "Snow 2024".
 *   - A "Prices" tab and any other reference tab is skipped (see IGNORED_SHEET_PREFIXES).
 *   - Inside a tab:
 *       row 1 = merged year label (optional; ignored)
 *       row 2 = column headers: Start Date | End Date | Program | Content Name |
 *               Current SRP ($USD) | Promo SRP ($USD) | Discount %  [| Release]
 *               (2024 sheets add a `Partner` column at A; the parser handles both.)
 *       row 3 = merged platform banner (e.g. "STEAM")
 *       row 4+ = data rows, blank rows separating campaign groups
 *       more platform-banner rows appear further down for MICROSOFT / SONY sections
 *
 * A CAMPAIGN = a contiguous run of data rows sharing (platform, program, start, end).
 * We collapse them into one Campaign row + N SkuLine rows.
 *
 * Parser is intentionally forgiving:
 *   - blank rows are separators, not errors
 *   - prices like `"$29,99"` (European-formatted strings) are parsed to floats
 *   - non-date strings in date columns (e.g. "tbc", "Dec 2024") skip the row + warn
 *   - unknown platform banners default to "Other" with `platform_raw` preserved
 *   - unknown game short-codes default to the raw code as their label
 *
 * The parser NEVER throws on individual bad rows — it collects warnings and
 * returns whatever it could successfully parse. Callers decide whether to accept
 * the ingest based on warning count.
 */
import ExcelJS from "exceljs";
import {
  GAME_NAME_MAP,
  IGNORED_SHEET_PREFIXES,
  PLATFORM_MAP,
  type Platform,
} from "../shared/schema.js";

export interface ParsedSku {
  content_name: string;
  current_srp_usd: number | null;
  promo_srp_usd: number | null;
  discount_pct: number | null;
  extra: Record<string, unknown>;
  source_row: number;
}

export interface ParsedCampaign {
  sheet_name: string;
  game_code: string;
  game_label: string;
  sheet_year: number;
  platform: Platform;
  platform_raw: string;
  program: string;
  start_date: string; // ISO YYYY-MM-DD
  end_date: string;
  notes: string | null;
  source_row_start: number;
  source_row_end: number;
  skus: ParsedSku[];
}

export interface ParseResult {
  campaigns: ParsedCampaign[];
  warnings: string[];
  sheets_processed: string[];
  sheets_skipped: string[];
}

// ─── Value coercion ───────────────────────────────────────────────────────────

/**
 * Coerce a cell value into a Date (UTC midnight). Returns null if the value
 * is not a real date (strings like "tbc", "Dec 2024", empty, etc.).
 * ExcelJS gives us JS Date objects for real date cells, so we mainly need to
 * reject non-Date fallthroughs.
 */
/**
 * ExcelJS wraps formula cells as `{formula, result, sharedType}`. Unwrap to
 * the underlying value so every coercer sees a raw primitive.
 */
function unwrap(v: unknown): unknown {
  if (v != null && typeof v === "object" && !(v instanceof Date) && "result" in (v as any)) {
    return (v as any).result;
  }
  // Rich-text objects come through as `{richText: [{text, font}, ...]}`
  if (v != null && typeof v === "object" && !(v instanceof Date) && Array.isArray((v as any).richText)) {
    return (v as any).richText.map((rt: any) => rt.text).join("");
  }
  return v;
}

function coerceDate(v: unknown): Date | null {
  v = unwrap(v);
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  // Numeric Excel serials sometimes leak through as raw numbers with `data_only`.
  if (typeof v === "number" && v > 30000 && v < 80000) {
    // Excel serial epoch: 1899-12-30
    const ms = (v - 25569) * 86400 * 1000;
    return new Date(ms);
  }
  return null;
}

/**
 * Coerce a price cell to a float in USD. Handles:
 *   number  → as-is
 *   "$29,99" → 29.99 (European comma decimal)
 *   "$29.99" → 29.99
 *   "29.99"  → 29.99
 *   "-", "", null → null
 */
function coercePrice(v: unknown): number | null {
  v = unwrap(v);
  if (v == null || v === "" || v === "-") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed || trimmed === "-") return null;
    // strip currency symbols + whitespace
    let s = trimmed.replace(/[\$€£¥\s]/g, "");
    // "1,234.56" → US style; "1.234,56" → EU style; "29,99" → EU decimal
    // Simple heuristic: if it has a comma and NO period, treat comma as decimal
    if (s.includes(",") && !s.includes(".")) {
      s = s.replace(",", ".");
    } else if (s.includes(",") && s.includes(".")) {
      // Assume US style — remove thousand separators
      s = s.replace(/,/g, "");
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce a discount % cell. Sheets store as decimal (0.6 = 60%).
 */
function coerceDiscount(v: unknown): number | null {
  v = unwrap(v);
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    // If someone stored "60" (percent) instead of "0.6", divide.
    return v > 1.0 ? v / 100 : v;
  }
  if (typeof v === "string") {
    const s = v.trim().replace("%", "");
    if (!s) return null;
    const n = Number(s.replace(",", "."));
    if (!Number.isFinite(n)) return null;
    return n > 1.0 ? n / 100 : n;
  }
  return null;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Sheet name parsing ───────────────────────────────────────────────────────

const SHEET_NAME_RE = /^(?<code>.+?)\s+(?<year>20\d{2})\s*$/;

interface SheetIdent {
  code: string;
  label: string;
  year: number;
}

function parseSheetName(sheetName: string): SheetIdent | null {
  const m = SHEET_NAME_RE.exec(sheetName.trim());
  if (!m || !m.groups) return null;
  const code = m.groups.code.trim().toUpperCase();
  const year = Number(m.groups.year);
  const label = GAME_NAME_MAP[code] ?? code;
  return { code, label, year };
}

function shouldSkipSheet(sheetName: string): boolean {
  const upper = sheetName.trim().toUpperCase();
  return IGNORED_SHEET_PREFIXES.some((p) => upper.startsWith(p));
}

// ─── Header detection ────────────────────────────────────────────────────────

interface HeaderMap {
  headerRow: number;
  partner: number | null;
  start: number;
  end: number;
  program: number;
  content: number;
  currentSrp: number;
  promoSrp: number;
  discount: number;
  extraCols: { name: string; col: number }[];
}

/**
 * Find the header row and column indices. Header row is the row containing
 * "Start Date", "End Date", "Program", "Content Name". Looks in rows 1..6.
 */
function detectHeader(ws: ExcelJS.Worksheet): HeaderMap | null {
  for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const cols: Record<string, number> = {};
    const extras: { name: string; col: number }[] = [];
    for (let c = 1; c <= row.cellCount; c++) {
      const v = row.getCell(c).value;
      if (typeof v !== "string") continue;
      const key = v.trim().toLowerCase();
      if (!key) continue;
      if (key.startsWith("start date")) cols.start = c;
      else if (key.startsWith("end date")) cols.end = c;
      else if (key === "program") cols.program = c;
      else if (key === "content name") cols.content = c;
      else if (key.includes("current srp")) cols.currentSrp = c;
      else if (key.includes("promo srp")) cols.promoSrp = c;
      else if (key.startsWith("discount")) cols.discount = c;
      else if (key === "partner") cols.partner = c;
      else extras.push({ name: v.trim(), col: c });
    }
    if (
      cols.start != null &&
      cols.end != null &&
      cols.program != null &&
      cols.content != null &&
      cols.currentSrp != null &&
      cols.promoSrp != null &&
      cols.discount != null
    ) {
      return {
        headerRow: r,
        partner: cols.partner ?? null,
        start: cols.start,
        end: cols.end,
        program: cols.program,
        content: cols.content,
        currentSrp: cols.currentSrp,
        promoSrp: cols.promoSrp,
        discount: cols.discount,
        extraCols: extras,
      };
    }
  }
  return null;
}

// ─── Platform-banner detection ────────────────────────────────────────────────

/**
 * A platform banner is a row where column A (or the partner column) is a
 * non-empty short string and every other data column is empty.
 * We check against PLATFORM_MAP; unknown banners still terminate the previous
 * platform section but map to "Other".
 */
/**
 * Detect a merged platform-banner row.
 *
 * ExcelJS surfaces merged cells by DUPLICATING the merged value into every
 * covered cell (i.e. row 200 with `A200:G200` merged shows "MICROSOFT" in
 * cols 1..7). So the signal is: every data column across the row is either
 * empty OR equals the col-A string. If col A alone had text but the other
 * cols had real data, we'd know it's a subtitle, not a banner.
 */
function looksLikeBanner(row: ExcelJS.Row, header: HeaderMap): string | null {
  const cell = unwrap(row.getCell(1).value);
  if (typeof cell !== "string") return null;
  const trimmed = cell.trim();
  if (!trimmed || trimmed.length > 40) return null;

  // Every other data column must be blank OR duplicate of the col-A value.
  const otherCols = [header.start, header.end, header.content, header.program, header.currentSrp, header.promoSrp, header.discount];
  for (const c of otherCols) {
    if (c === 1) continue;
    const v = unwrap(row.getCell(c).value);
    if (v == null || v === "") continue;
    if (typeof v === "string" && v.trim() === trimmed) continue;
    // Real data in another column — this isn't a banner.
    return null;
  }
  return trimmed;
}

function normalizePlatform(raw: string): Platform {
  const key = raw.trim().toUpperCase();
  return PLATFORM_MAP[key] ?? "Other";
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export async function parsePromoWorkbook(
  buffer: Buffer | ArrayBuffer,
): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);

  const result: ParseResult = {
    campaigns: [],
    warnings: [],
    sheets_processed: [],
    sheets_skipped: [],
  };

  wb.eachSheet((ws) => {
    const sheetName = ws.name;
    if (shouldSkipSheet(sheetName)) {
      result.sheets_skipped.push(sheetName);
      return;
    }
    const ident = parseSheetName(sheetName);
    if (!ident) {
      result.warnings.push(
        `Sheet "${sheetName}": name does not match "<Game> <Year>" pattern; skipping.`,
      );
      result.sheets_skipped.push(sheetName);
      return;
    }
    const header = detectHeader(ws);
    if (!header) {
      result.warnings.push(
        `Sheet "${sheetName}": could not find header row (Start Date / End Date / Program / Content Name); skipping.`,
      );
      result.sheets_skipped.push(sheetName);
      return;
    }
    result.sheets_processed.push(sheetName);

    // Walk data rows below the header. Track current platform via banners.
    let currentPlatform: Platform | null = null;
    let currentPlatformRaw: string | null = null;

    // Rolling campaign accumulator — we start a new one when
    // (platform, program, start, end) changes OR we hit a blank row.
    let bufKey: string | null = null;
    let bufCampaign: ParsedCampaign | null = null;

    const flushCampaign = () => {
      if (bufCampaign && bufCampaign.skus.length > 0) {
        result.campaigns.push(bufCampaign);
      }
      bufCampaign = null;
      bufKey = null;
    };

    for (let r = header.headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);

      // Platform banner?
      const banner = looksLikeBanner(row, header);
      if (banner) {
        flushCampaign();
        currentPlatformRaw = banner;
        currentPlatform = normalizePlatform(banner);
        continue;
      }

      const startRaw = row.getCell(header.start).value;
      const endRaw = row.getCell(header.end).value;
      const program = unwrap(row.getCell(header.program).value);
      const content = unwrap(row.getCell(header.content).value);

      // Blank spacer row — flush the current campaign.
      const allBlank =
        (startRaw == null || startRaw === "") &&
        (endRaw == null || endRaw === "") &&
        (program == null || program === "") &&
        (content == null || content === "");
      if (allBlank) {
        flushCampaign();
        continue;
      }

      // Skip rows that don't have a content name — probably a section subtitle.
      if (typeof content !== "string" || !content.trim()) {
        continue;
      }
      if (typeof program !== "string" || !program.trim()) {
        // Rows with a content name but no Program are usually inventory
        // reference lists appended below a platform section ("here's every
        // SKU we own, no promo attached"). Skipping is correct; no warning.
        continue;
      }

      const startDate = coerceDate(startRaw);
      const endDate = coerceDate(endRaw);
      if (!startDate || !endDate) {
        // Common quirk: rows with "TBC" or free-text like "TBD post promo 1" in
        // the date columns are staged/future entries the promo team hasn't
        // firmed up yet. Suppress the warning — skipping is the right call.
        const rawStart = unwrap(startRaw);
        const rawEnd = unwrap(endRaw);
        const looksLikeTbc = (v: unknown) =>
          typeof v === "string" && /^(TBC|TBD|TBA)/i.test(v.trim());
        if (!(looksLikeTbc(rawStart) || looksLikeTbc(rawEnd))) {
          result.warnings.push(
            `${sheetName} row ${r}: invalid Start/End date (${JSON.stringify(rawStart)}, ${JSON.stringify(rawEnd)}); skipping.`,
          );
        }
        continue;
      }

      if (!currentPlatform) {
        // No banner seen yet — assume Steam (matches the sample; row 3 is always STEAM).
        currentPlatform = "Steam";
        currentPlatformRaw = "STEAM (inferred)";
        result.warnings.push(
          `${sheetName} row ${r}: encountered data before any platform banner; assuming Steam.`,
        );
      }

      const key = `${currentPlatform}|${program.trim()}|${isoDate(startDate)}|${isoDate(endDate)}`;
      if (key !== bufKey) {
        flushCampaign();
        bufCampaign = {
          sheet_name: sheetName,
          game_code: ident.code,
          game_label: ident.label,
          sheet_year: ident.year,
          platform: currentPlatform,
          platform_raw: currentPlatformRaw ?? currentPlatform,
          program: program.trim(),
          start_date: isoDate(startDate),
          end_date: isoDate(endDate),
          notes: null,
          source_row_start: r,
          source_row_end: r,
          skus: [],
        };
        bufKey = key;
      }

      // Extract spillover columns (Release, Partner override, freeform notes).
      const extra: Record<string, unknown> = {};
      if (header.partner != null) {
        const v = row.getCell(header.partner).value;
        if (v != null && v !== "") extra.partner = String(v).trim();
      }
      for (const ex of header.extraCols) {
        const v = row.getCell(ex.col).value;
        if (v != null && v !== "") extra[ex.name] = v instanceof Date ? isoDate(v) : v;
      }

      const sku: ParsedSku = {
        content_name: content.trim(),
        current_srp_usd: coercePrice(row.getCell(header.currentSrp).value),
        promo_srp_usd: coercePrice(row.getCell(header.promoSrp).value),
        discount_pct: coerceDiscount(row.getCell(header.discount).value),
        extra,
        source_row: r,
      };
      bufCampaign!.skus.push(sku);
      bufCampaign!.source_row_end = r;

      // First non-empty note anywhere in the campaign becomes the campaign note.
      if (!bufCampaign!.notes) {
        const candidateNote =
          (typeof extra.Release === "string" && extra.Release) ||
          (typeof extra["Release"] === "string" && extra["Release"]) ||
          null;
        if (candidateNote) bufCampaign!.notes = candidateNote;
      }
    }
    flushCampaign();
  });

  return result;
}

// ─── Rollup helpers exposed for the ingest handler ────────────────────────────

export function rollupDiscount(skus: ParsedSku[]): { min: number; max: number } {
  const vals = skus
    .map((s) => s.discount_pct)
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  if (!vals.length) return { min: 0, max: 0 };
  return { min: Math.min(...vals), max: Math.max(...vals) };
}
