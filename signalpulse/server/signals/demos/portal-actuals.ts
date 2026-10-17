/**
 * APPROVED 2026-10-17 (user decision, SignalPulse thread 033faf70):
 * complimentary units and lifetime free licenses are collected daily as a
 * SEPARATE licenses metric ("Free licenses (LTD)"), displayed alongside
 * -- never instead of -- playtime downloads. They must never enter
 * demo_window_estimates_daily or any download-semantics table, and the
 * leaderboard continues to rank by downloads. computeDemoWindowActuals()
 * below stays UNWIRED for exactly that reason.
 *
 * Saber Steamworks Sales & Activations ground truth for Saber's OWN demos
 * (2026-09-22).
 *
 * Reuses the exact same shared Steamworks partner-portal session cookie
 * (steamworks_sessions id='default') and HTML fetch/parse path
 * (steamworks-portal.ts fetchPortalPage/parsePortalHtml) that
 * ingestSteamSales() already uses in production for paid-title revenue.
 * We do NOT touch that function or its session-alerting state -- this
 * module only READS the session row and never writes lastVerifiedAt /
 * lastVerifiedResult / alertSentAt, so cookie-health alerting stays
 * exclusively owned by ingestSteamSales(). If the cookie is dead, both
 * paths fail the same way on their own next attempt; we just don't want
 * to double-fire the alert or reset its cooldown from a second call site.
 *
 * Demos are free, so the paid-title fields (Steam units/revenue) don't
 * apply. The relevant Steamworks fields are a per-day "Complimentary
 * units" row and a lifetime "Lifetime free licenses" total. Both labels
 * were LIVE-VERIFIED 2026-10-17 against the Hellraiser: Revival Demo
 * (appid 5184670) via the routed read-only probe: the label matched, and
 * Valve's own tooltip defines the metric ("A free license is a grant of a
 * product to a user, but does not necessarily mean the user has
 * downloaded the product."). That same probe exposed a value-extraction
 * bug -- the shared extractor captured a comma from the tooltip prose
 * instead of the adjacent value cell. The bug, the label wording, and
 * the row structure are live-verified; the fixed row-scoped extractor
 * (rowValueAfterLabel() in steamworks-portal.ts) is verified against a
 * fixture built from that live-observed row, and the live VALUE is
 * re-verified via the probe after each deploy -- the live total moves
 * daily, so it is never hard-coded as an acceptance value.
 *
 * Only Saber's own demos (is_saber_published=1) are ever fetched -- we
 * have no view permission on any other publisher's Steamworks account,
 * same constraint documented in steamworks-portal.ts's original header.
 */

import { storage, rawSqlite } from "../../storage";
import { log } from "../../log";
import { fetchPortalPage, type ParsedPortalPage } from "../../steamworks-portal";

// Same stagger used by ingestSteamSales() (server/ingestion.ts
// PORTAL_FETCH_DELAY_MS) -- gentle on Steamworks, kept as a local literal
// rather than importing a non-exported const across modules.
const PORTAL_FETCH_DELAY_MS = 2000;
// Request deadline for the scheduled collector (paid-title ingestion is
// unchanged -- fetchPortalPage only applies a signal when timeoutMs is set).
const PORTAL_FETCH_TIMEOUT_MS = 30_000;

// Deliberately NOT importing anything (even a single named function) from
// "../../ingestion" here -- that module does `import { log } from "./index"`,
// and index.ts is the full server bootstrap (calls app.listen(), starts
// every cron scheduler) as a MODULE-LEVEL side effect. A value import from
// ingestion.ts would transitively boot a second full server on every unit
// test that imports this file (confirmed: it printed "[express] serving on
// port 5000" and hung the test process). `IngestionResult`'s shape is
// duplicated locally (not `import type` re-exported) for the same reason
// -- keep it in sync with server/ingestion.ts's definition by hand if that
// one changes.
export interface IngestionResult {
  source: string;
  status: "success" | "skipped" | "error";
  message: string;
  productsProcessed?: number;
  dataPointsAdded?: number;
}

function getYesterdayGmtDateString(): string {
  return new Date(Date.now() - 86400000).toISOString().split("T")[0];
}

interface SaberDemoRow {
  id: number;
  steam_app_id: string;
  name: string;
}

function loadSaberDemoRoster(): SaberDemoRow[] {
  return rawSqlite
    .prepare(`SELECT id, steam_app_id, name FROM demo_titles WHERE is_saber_published = 1`)
    .all() as SaberDemoRow[];
}

const upsertPortalDailyStmt = () => rawSqlite.prepare(
  `INSERT INTO demo_portal_daily
     (demo_title_id, date, complimentary_units_period, lifetime_free_licenses,
      lifetime_unique_users, current_players, period_label, source, batch_id,
      created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'portal_fetch', ?, ?, ?)
   ON CONFLICT(demo_title_id, date) DO UPDATE SET
     complimentary_units_period = excluded.complimentary_units_period,
     -- Licenses observation is NON-DESTRUCTIVE: a re-run of the same
     -- target date that fails to parse licenses must never erase the
     -- last successful value or its observation timestamp (updated_at).
     lifetime_free_licenses = COALESCE(excluded.lifetime_free_licenses, demo_portal_daily.lifetime_free_licenses),
     lifetime_unique_users = COALESCE(excluded.lifetime_unique_users, demo_portal_daily.lifetime_unique_users),
     current_players = COALESCE(excluded.current_players, demo_portal_daily.current_players),
     period_label = excluded.period_label,
     batch_id = excluded.batch_id,
     updated_at = CASE WHEN excluded.lifetime_free_licenses IS NOT NULL THEN excluded.updated_at ELSE demo_portal_daily.updated_at END`
);

/**
 * Daily "yesterday" snapshot collector for Saber's demo roster. Mirrors
 * ingestSteamSales()'s shared-cookie, stop-early-on-expiry pattern, minus
 * any session-alerting (that stays owned by ingestSteamSales()).
 *
 * Identity + success rules (2026-10-17): the report's own app id (parsed
 * from the page's <h1> header) must equal the requested demo's app id,
 * and a data point only counts when a valid non-negative integer was
 * parsed for lifetime free licenses -- a successful HTTP response with
 * a null licenses value is recorded as an error for that demo (the last
 * successful snapshot remains authoritative for display), never as a
 * collected data point.
 */
export async function runDemosPortalCollector(): Promise<IngestionResult> {
  const demos = loadSaberDemoRoster();
  if (demos.length === 0) {
    return { source: "demos_portal", status: "skipped", message: "No Saber-published demos in demo_titles" };
  }

  const session = storage.getSteamworksSession("default");
  if (!session) {
    return { source: "demos_portal", status: "skipped", message: "No Steamworks session cookie configured" };
  }
  if (session.lastVerifiedResult && /session expired/i.test(session.lastVerifiedResult)) {
    // Read-only early exit -- ingestSteamSales() already knows the cookie
    // is dead as of its last attempt and owns the alert for that. Don't
    // burn a guaranteed-failing HTTP call per demo on top of it.
    return {
      source: "demos_portal",
      status: "skipped",
      message: `Skipped: Steamworks session already known expired (${session.lastVerifiedResult.slice(0, 120)})`,
    };
  }

  const targetDate = getYesterdayGmtDateString();
  const nowIso = new Date().toISOString();
  let dataPoints = 0;
  const errors: Array<{ demo: string; error: string }> = [];

  for (let i = 0; i < demos.length; i++) {
    const demo = demos[i];
    if (i > 0) await new Promise((r) => setTimeout(r, PORTAL_FETCH_DELAY_MS));

    try {
      // Bounded fetch: a hung Steamworks request must never stall the
      // daily pipeline (the try/catch below does not bound runtime).
      const result = await fetchPortalPage({
        appId: Number(demo.steam_app_id),
        dateStart: targetDate,
        dateEnd: targetDate,
        cookieHeader: session.cookieValue,
        timeoutMs: PORTAL_FETCH_TIMEOUT_MS,
      });

      if (!result.ok || !result.parsed) {
        const errMsg = (result.error ?? "unknown error").slice(0, 200);
        errors.push({ demo: demo.name, error: errMsg });
        log(`Demos portal fetch failed for ${demo.name}: ${errMsg}`, "demos-portal");
        if (/session expired/i.test(errMsg)) break; // shared cookie -- rest would fail identically
        continue;
      }

      const p: ParsedPortalPage = result.parsed;
      // Report identity: the page's own <h1> app id must be PRESENT and
      // equal the requested demo's app id. A page without the header
      // (or reporting a different app) is rejected outright -- an
      // unidentifiable report must never be attributed to this demo.
      if (p.reportAppId == null || p.reportAppId !== Number(demo.steam_app_id)) {
        const errMsg = p.reportAppId == null
          ? "report identity missing: page has no Game header app id"
          : `report identity mismatch: page reports app ${p.reportAppId}, requested ${demo.steam_app_id}`;
        errors.push({ demo: demo.name, error: errMsg });
        log(`Demos portal identity rejected for ${demo.name}: ${errMsg}`, "demos-portal");
        continue;
      }
      const batchId = `demos-portal-cron-${demo.id}-${targetDate}`;
      upsertPortalDailyStmt().run(
        demo.id, targetDate,
        p.periodComplimentaryUnits, p.lifetimeFreeLicenses, p.lifetimeUniqueUsers,
        p.currentPlayers, p.periodLabel, batchId, nowIso, nowIso,
      );
      // Success requires a valid non-negative integer for the licenses
      // metric (the row above still preserves the other parsed fields and
      // display falls back to the last successful non-null snapshot).
      if (p.lifetimeFreeLicenses == null || !Number.isSafeInteger(p.lifetimeFreeLicenses) || p.lifetimeFreeLicenses < 0) {
        const errMsg = "free licenses not parsed from report";
        errors.push({ demo: demo.name, error: errMsg });
        log(`Demos portal licenses missing for ${demo.name}: ${errMsg}`, "demos-portal");
        continue;
      }
      dataPoints += 1;
    } catch (err: any) {
      errors.push({ demo: demo.name, error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  const status: IngestionResult["status"] = dataPoints > 0 ? "success" : errors.length > 0 ? "error" : "skipped";
  const message = `Fetched ${dataPoints}/${demos.length} Saber demo(s) for ${targetDate}` +
    (errors.length > 0 ? `; ${errors.length} error(s): ${errors.map((e) => `${e.demo}: ${e.error}`).join("; ").slice(0, 300)}` : "");

  return { source: "demos_portal", status, message, productsProcessed: demos.length, dataPointsAdded: dataPoints };
}

export interface DemoActualsRunResult {
  demosWithActuals: number;
  rowsWritten: number;
}

const upsertActualStmt = () => rawSqlite.prepare(
  `INSERT INTO demo_window_estimates_daily
     (demo_title_id, window, as_of_date, review_count_total, review_delta,
      units_low, units_mid, units_high, multiplier_id, method, created_at)
   VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL, 'steamworks_actual', ?)
   ON CONFLICT(demo_title_id, window, as_of_date) DO UPDATE SET
     units_low = excluded.units_low,
     units_mid = excluded.units_mid,
     units_high = excluded.units_high,
     method = 'steamworks_actual'`
);

/**
 * Turns collected demo_portal_daily rows into demo_window_estimates_daily
 * rows with method='steamworks_actual'. Unlike the multiplier estimator
 * (computeDemoWindowEstimates), this NEVER writes a row unless it found a
 * real non-null actual for that demo+window -- so a demo with no portal
 * coverage yet is left entirely alone and the multiplier estimate stays
 * authoritative for it. Safe to re-run any time; upsert is unconditional
 * (an actual always may overwrite a prior estimate -- that's the upgrade
 * path -- but this function only ever produces 'steamworks_actual' rows,
 * so it can never itself downgrade one).
 */
export function computeDemoWindowActuals(asOfDate = new Date().toISOString().slice(0, 10)): DemoActualsRunResult {
  const demos = loadSaberDemoRoster();
  const nowIso = new Date().toISOString();
  let rowsWritten = 0;
  let demosWithActuals = 0;

  for (const demo of demos) {
    let wroteAny = false;

    // Lifetime: Steamworks' lifetime box is already a cumulative-to-date
    // total regardless of the URL's date range, so use the MOST RECENT
    // snapshot's lifetime_free_licenses directly (never summed).
    const latestRow = rawSqlite
      .prepare(
        `SELECT lifetime_free_licenses FROM demo_portal_daily
         WHERE demo_title_id = ? AND lifetime_free_licenses IS NOT NULL
         ORDER BY date DESC LIMIT 1`
      )
      .get(demo.id) as { lifetime_free_licenses: number | null } | undefined;

    if (latestRow?.lifetime_free_licenses != null) {
      const v = latestRow.lifetime_free_licenses;
      upsertActualStmt().run(demo.id, "ltd", asOfDate, v, v, v, nowIso);
      rowsWritten += 1;
      wroteAny = true;
    }

    // Rolling windows: sum the per-day "Complimentary units" deltas
    // within the window. Only write if at least one day of coverage
    // exists in-window -- a demo with zero rows in a short window (e.g.
    // cookie was down all week) correctly falls back to the multiplier
    // estimate rather than reporting a false zero.
    for (const [windowKey, days] of Object.entries({ d7: 7, d30: 30, d90: 90, m12: 365 })) {
      const cutoff = days === null
        ? null
        : new Date(Date.now() - Number(days) * 86400_000).toISOString().slice(0, 10);
      const sumRow = rawSqlite
        .prepare(
          `SELECT COALESCE(SUM(complimentary_units_period), 0) as s, COUNT(*) as n
           FROM demo_portal_daily
           WHERE demo_title_id = ? AND complimentary_units_period IS NOT NULL
             AND (? IS NULL OR date >= ?)`
        )
        .get(demo.id, cutoff, cutoff) as { s: number; n: number };

      if (sumRow.n > 0) {
        upsertActualStmt().run(demo.id, windowKey, asOfDate, sumRow.s, sumRow.s, sumRow.s, nowIso);
        rowsWritten += 1;
        wroteAny = true;
      }
    }

    if (wroteAny) demosWithActuals += 1;
  }

  log(`demo window actuals computed: demos=${demos.length} demosWithActuals=${demosWithActuals} rowsWritten=${rowsWritten} asOfDate=${asOfDate}`, "demos-portal");
  return { demosWithActuals, rowsWritten };
}

export interface PortalProbeResult {
  appId: number;
  ok: boolean;
  httpStatus?: number;
  error?: string;
  parsedFields?: {
    appName: string | null;
    reportAppId: number | null;
    currentPlayers: number | null;
    lifetimeUniqueUsers: number | null;
    lifetimeFreeLicenses: number | null;
    lifetimeFreeLicensesLabel: string | null;
    periodComplimentaryUnits: number | null;
    periodComplimentaryUnitsLabel: string | null;
    periodLabel: string | null;
  };
  /** ~300-char window around the first "omplimentary" or "free licens"
   * match in the raw HTML, for manual eyeballing of the ACTUAL label
   * Valve rendered when none of the regex candidates matched. Null when
   * no such text exists in the page at all (i.e. this demo genuinely has
   * no free/comp section — for instance the fetch happened on a paid
   * app, or Valve's section is gated behind a different tab entirely). */
  rawExcerpt?: string | null;
}

/**
 * Pure read-only probe: ONE live fetch against a given demo appid, no DB
 * writes. Ops-token gated via GET /api/ops/demos-portal-probe/:appId --
 * see routes-demos-leaderboard.ts. Exists so an operator can confirm,
 * against a REAL Saber demo and the real production cookie, which label
 * Valve actually renders before fully trusting the automated collector.
 */
export async function probeDemoPortal(appId: number, dateStart: string, dateEnd: string): Promise<PortalProbeResult> {
  const session = storage.getSteamworksSession("default");
  if (!session) return { appId, ok: false, error: "No Steamworks session cookie configured" };

  const result = await fetchPortalPage({
    appId, dateStart, dateEnd, cookieHeader: session.cookieValue, includeRawHtml: true,
  });
  if (!result.ok || !result.parsed) {
    return { appId, ok: false, httpStatus: result.httpStatus, error: result.error };
  }

  const p = result.parsed;
  let rawExcerpt: string | null = null;
  // Search the FULL page for the row containing "complimentary" or "free
  // licens" text and return it as tag-stripped text -- the label AND its
  // adjacent value cell, so an operator can see exactly what Valve
  // rendered (and the parsed value can be checked against it). A null
  // result means the text genuinely isn't anywhere on the page (the app
  // has no free/comp section at all), not a truncation artifact.
  const html = result.rawHtml ?? "";
  const rowMatch = html.match(/<tr\b[^>]*>(?:(?!<tr\b)[\s\S])*?(omplimentary|[Ff]ree licen[cs]e)[\s\S]*?<\/tr>/);
  if (rowMatch) {
    rawExcerpt = rowMatch[0]
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
      .replace(/\s+/g, " ").trim().slice(0, 600);
  }

  return {
    appId,
    ok: true,
    httpStatus: result.httpStatus,
    parsedFields: {
      appName: p.appName,
      reportAppId: p.reportAppId,
      currentPlayers: p.currentPlayers,
      lifetimeUniqueUsers: p.lifetimeUniqueUsers,
      lifetimeFreeLicenses: p.lifetimeFreeLicenses,
      lifetimeFreeLicensesLabel: p.lifetimeFreeLicensesLabel,
      periodComplimentaryUnits: p.periodComplimentaryUnits,
      periodComplimentaryUnitsLabel: p.periodComplimentaryUnitsLabel,
      periodLabel: p.periodLabel,
    },
    rawExcerpt,
  };
}
