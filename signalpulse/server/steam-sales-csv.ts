// ─── Steamworks Sales CSV parser ─────────────────────────────────────────────
//
// Parses the CSV export you get from a Steamworks App Details page's
// "view as .csv" link. The format is a fixed 22-column schema (line 4 is the
// header). Line 1 is `sep=,`, line 2 is a metadata banner
// ("Steam Sales data for {Publisher}: {start} - {end}"), line 3 is blank.
//
// Ingest rules (locked with user 2026-08-11):
//   - Only Type = "Steam" rows count. Retail activations excluded.
//   - Base SKUs (name ∈ {game, game - Deluxe Edition, game - Anniversary
//     Edition variants}) roll up into skuGroup='base'.
//   - Everything else with product-name containing "- <something>" rolls
//     up into skuGroup='dlc' (Chapter Pack, Cosmetic Pack, Season Pass,
//     Bus Pass, Champion Pack, DLC, etc.).
//   - Soundtrack / Artbook / OST / misc → skuGroup='other'.
//
// Output is aggregated: one bucket per (date, skuGroup) with net units,
// gross units, returns, net revenue USD, gross revenue USD summed across
// all countries and platforms and matching SKUs.

import type { InsertSteamSalesDaily } from "@shared/schema";

export interface ParsedSalesCsv {
  publisherName: string | null;
  reportDateStart: string | null;
  reportDateEnd: string | null;
  totalRawRows: number;
  ingestedRows: InsertSteamSalesDaily[]; // aggregated to (date, skuGroup)
  skipped: {
    retail: number;
    zeroUnits: number;
    unclassified: number; // rows we couldn't bucket
  };
  errors: string[]; // parse errors we tolerated
  perSkuBreakdown: SkuBreakdown[]; // for showing user what we found
}

export interface SkuBreakdown {
  productId: string;
  productName: string;
  skuGroup: "base" | "dlc" | "other";
  netUnits: number;
  netRevenueUsd: number;
}

/**
 * Classify a Steam SKU into base / dlc / other based on the product name
 * and the game title. Called once per unique product name.
 *
 * Heuristics (in priority order):
 *  1. Exact match on game title (or "game - Deluxe Edition" /
 *     "game - Anniversary Edition" variants) → 'base'
 *  2. Name contains "Soundtrack" / "Artbook" / "OST" → 'other'
 *  3. Name contains "- " (product has a suffix beyond the game name),
 *     and it's not a base variant → 'dlc'
 *  4. Fallback → 'base' (safest: main game unit undercounts are worse
 *     than DLC overcounts).
 */
export function classifySku(productName: string, gameTitle: string): "base" | "dlc" | "other" {
  const p = productName.trim();
  const g = gameTitle.trim();
  const lower = p.toLowerCase();

  // Rule 2 (checked first because these are unambiguous)
  if (
    lower.includes("soundtrack") ||
    lower.includes("artbook") ||
    lower.includes(" ost") ||
    lower.endsWith("ost") ||
    lower.includes("digital art book") ||
    lower.includes("digital comic")
  ) {
    return "other";
  }

  // Rule 1: exact match
  if (p === g) return "base";

  // Base variant suffixes only count if the product name starts with the
  // game title. Without that prefix check, "X - Deluxe Edition" would
  // match for any unrelated X (real bug from earlier iteration).
  const startsWithGameTitle =
    p.startsWith(g + " - ") || p.startsWith(g + " -") || p.startsWith(g + ": ");
  if (startsWithGameTitle) {
    const baseVariantSuffixes = [
      /\s-\s+deluxe\s+edition\b/i,
      /\s-\s+standard\s+edition\b/i,
      /\s-\s+gold\s+edition\b/i,
      /\s-\s+premium\s+edition\b/i,
      /\s-\s+ultimate\s+edition\b/i,
      /\s-\s+collector'?s\s+edition\b/i,
      /\s-\s+\d+-year\s+anniversary\s+edition\b/i,
      /\s-\s+anniversary\s+edition\b/i,
      /\s-\s+goty\s+edition\b/i,
      /\s-\s+game\s+of\s+the\s+year\b/i,
    ];
    for (const rx of baseVariantSuffixes) {
      if (rx.test(p)) return "base";
    }

    // Rule 3: game title prefix + any other suffix → DLC.
    // (Only reached when none of the base-variant regexes matched.)
    return "dlc";
  }

  // Rule 4: product name doesn't reference the game title at all.
  // Mark as 'other' so we don't inflate base-game counts with bundles
  // or unrelated products that landed in the same CSV.
  return "other";
}

/**
 * Parse a raw Steamworks sales CSV file (as a string) into aggregated
 * SteamSalesDaily inserts, one per (date, skuGroup) bucket.
 */
export function parseSteamSalesCsv(
  rawCsv: string,
  productId: number,
  gameTitle: string,
  now: () => string = () => new Date().toISOString(),
  batchId?: string,
): ParsedSalesCsv {
  const errors: string[] = [];
  let publisherName: string | null = null;
  let reportDateStart: string | null = null;
  let reportDateEnd: string | null = null;
  const skipped = { retail: 0, zeroUnits: 0, unclassified: 0 };
  let totalRawRows = 0;

  // Split into lines, drop trailing empties
  const rawLines = rawCsv.split(/\r?\n/);

  // Line 1: sep=,
  // Line 2: metadata banner
  // Line 3: (blank)
  // Line 4: header
  // Line 5+: data
  //
  // The metadata banner is like:
  //   Steam Sales data for Mad Dog Games, LLC: 2026-08-04 - 2026-08-10
  // Publisher name may contain a comma; we split on the LAST colon.
  if (rawLines.length >= 2) {
    const banner = rawLines[1];
    const lastColon = banner.lastIndexOf(":");
    if (lastColon > 0) {
      const before = banner.slice(0, lastColon).trim();
      const after = banner.slice(lastColon + 1).trim();
      // "Steam Sales data for {Publisher}"
      const forMatch = before.match(/^Steam Sales data for\s+(.+)$/i);
      if (forMatch) publisherName = forMatch[1].trim();
      // "{start} - {end}"
      const dateMatch = after.match(/^(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$/);
      if (dateMatch) {
        reportDateStart = dateMatch[1];
        reportDateEnd = dateMatch[2];
      }
    }
  }

  // Find header row (line index 3, after sep + banner + blank)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rawLines.length, 10); i++) {
    if (rawLines[i].startsWith("Date,") || rawLines[i].startsWith("Date, ")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    errors.push("Could not find 'Date,' header row in first 10 lines");
    return {
      publisherName,
      reportDateStart,
      reportDateEnd,
      totalRawRows: 0,
      ingestedRows: [],
      skipped,
      errors,
      perSkuBreakdown: [],
    };
  }

  const headers = parseCsvLine(rawLines[headerIdx]).map(h => h.trim());
  const col = (name: string) => headers.findIndex(h => h === name);
  const iDate = col("Date");
  const iProductId = col("Product(ID#)");
  const iProductName = col("Product Name");
  const iType = col("Type");
  const iGross = col("Gross Units Sold");
  const iReturns = col("Chargeback/Returns");
  const iNet = col("Net Units Sold");
  const iGrossUsd = col("Gross Steam Sales (USD)");
  const iReturnsUsd = col("Chargeback/Returns (USD)");
  const iNetUsd = col("Net Steam Sales (USD)");

  if ([iDate, iProductId, iProductName, iType, iNet, iNetUsd].some(x => x < 0)) {
    errors.push(`Missing required columns. Got headers: ${headers.slice(0, 10).join(", ")}...`);
  }

  // Aggregate into buckets: date → skuGroup → {netUnits, grossUnits, returns, netRev, grossRev}
  type Agg = {
    netUnits: number;
    grossUnits: number;
    returns: number;
    netRevenueUsd: number;
    grossRevenueUsd: number;
  };
  const byBucket = new Map<string, Agg>(); // key = `${date}||${skuGroup}`
  const perSkuAgg = new Map<string, SkuBreakdown>(); // key = `${productId}||${productName}`

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || !line.trim()) continue;
    // Some Steamworks CSVs occasionally repeat the sep/banner/header (as we
    // saw in the empty test file). Skip anything that isn't a data row.
    if (line.startsWith("sep=") || line.startsWith("Steam Sales data")) continue;

    const cells = parseCsvLine(line);
    if (cells.length < headers.length) {
      // Tolerate short rows silently — they're usually trailing whitespace artifacts.
      continue;
    }
    totalRawRows++;

    const date = cells[iDate]?.trim() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const type = cells[iType]?.trim().replace(/^"|"$/g, "") ?? "";
    if (type !== "Steam") {
      // Retail activations excluded per user rule 2026-08-11.
      skipped.retail++;
      continue;
    }

    const rawName = cells[iProductName] ?? "";
    const productName = rawName.replace(/^"|"$/g, "").trim();
    const skuProductId = cells[iProductId]?.trim() ?? "";
    const skuGroup = classifySku(productName, gameTitle);

    const netUnits = parseInt(cells[iNet] ?? "0", 10) || 0;
    const grossUnits = parseInt(cells[iGross] ?? "0", 10) || 0;
    const returns = parseInt(cells[iReturns] ?? "0", 10) || 0;
    const netRevenueUsd = parseFloat(cells[iNetUsd] ?? "0") || 0;
    const grossRevenueUsd = parseFloat(cells[iGrossUsd] ?? "0") || 0;

    // Bucket aggregation
    const key = `${date}||${skuGroup}`;
    const cur = byBucket.get(key) ?? {
      netUnits: 0,
      grossUnits: 0,
      returns: 0,
      netRevenueUsd: 0,
      grossRevenueUsd: 0,
    };
    cur.netUnits += netUnits;
    cur.grossUnits += grossUnits;
    cur.returns += returns;
    cur.netRevenueUsd += netRevenueUsd;
    cur.grossRevenueUsd += grossRevenueUsd;
    byBucket.set(key, cur);

    // Per-SKU tracking for the UI preview
    const skuKey = `${skuProductId}||${productName}`;
    const existing = perSkuAgg.get(skuKey) ?? {
      productId: skuProductId,
      productName,
      skuGroup,
      netUnits: 0,
      netRevenueUsd: 0,
    };
    existing.netUnits += netUnits;
    existing.netRevenueUsd += netRevenueUsd;
    perSkuAgg.set(skuKey, existing);
  }

  const nowStr = now();
  const ingestedRows: InsertSteamSalesDaily[] = [];
  byBucket.forEach((agg, key) => {
    const [date, skuGroup] = key.split("||");
    ingestedRows.push({
      productId,
      date,
      skuGroup,
      netUnits: agg.netUnits,
      grossUnits: agg.grossUnits,
      returns: agg.returns,
      netRevenueUsd: Math.round(agg.netRevenueUsd * 100) / 100, // cents precision
      grossRevenueUsd: Math.round(agg.grossRevenueUsd * 100) / 100,
      source: "csv_upload",
      batchId: batchId ?? null,
    });
  });
  // Round per-SKU numbers for the preview
  const perSkuBreakdown = Array.from(perSkuAgg.values())
    .map(s => ({ ...s, netRevenueUsd: Math.round(s.netRevenueUsd * 100) / 100 }))
    .sort((a, b) => b.netUnits - a.netUnits);

  return {
    publisherName,
    reportDateStart,
    reportDateEnd,
    totalRawRows,
    ingestedRows,
    skipped,
    errors,
    perSkuBreakdown,
  };
}

/**
 * Simple CSV line parser that handles quoted fields with embedded commas.
 * The Steamworks CSV uses `sep=,` as a hint to Excel; standard comma
 * separation with double-quote escaping. Field values can contain commas
 * if they're wrapped in "..."
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
  }
  cells.push(cur);
  return cells;
}
