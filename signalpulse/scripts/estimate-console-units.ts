/**
 * Phase 4 v0 — write window_estimates_daily rows for every eligible (title, platform, window).
 *
 * Formula (per console_leaderboards_spec §5):
 *   signal(p, w)      = ratings added in window w on platform p
 *   owners_mid(p, w)  = signal(p, w) × multiplier(p, cohort)
 *   owners_low/high   = owners_mid × (1 ∓ ci_pct)
 *   units_mid(p, w)   = owners_mid / digital_unit_share(p)
 *
 * Signal sources (v0):
 *   Steam ltd  — store_rating_signal_daily.rating_count
 *   Steam d7/d30/d90/m12 — SUM(recommendations_up + recommendations_down) from
 *                          steam_review_history buckets ending in [now-N, now]
 *   Xbox ltd/d7/d30 — bundled into store_rating_signal_daily.raw_json.windows[]
 *                     (native from displaycatalog UsageData)
 *   Xbox d90/m12    — forward-only LTD delta (ltd_today − ltd_N_days_ago) when we
 *                     have ≥N+1 daily snapshots; otherwise bootstrap-fill using
 *                     the LTD count for titles released within the window (their
 *                     lifetime ratings all fall inside that window by definition).
 *   PS5 ltd — store_rating_signal_daily.rating_count.
 *   PS5 d7/d30/d90/m12 — same forward-delta + bootstrap strategy as Xbox d90/m12.
 *                        As history accrues, the delta path replaces the bootstrap.
 *
 * Bootstrap gap-fill (critical for coverage on freshly launched platforms):
 *   For any title whose effective release date falls within the requested window,
 *   its LTD signal EQUALS its windowed signal. This lets us present a top-100 on
 *   PS5/Xbox even with a single day of collection history, so long as the recent-
 *   release cohort is populated.
 *
 * Gates:
 *   'signal_too_small'      — signal < noise_gate (spec §6, default 50)
 *   'insufficient_history'  — window needs more days of collection than we have
 *                             AND title predates the window (bootstrap failed)
 *   'no_multiplier'         — active multiplier row missing (should never happen after seed)
 *
 * v0 is CLEARLY LABELLED — confidence='v0-defaults' — and must be replaced by
 * a fitted set before boards leave internal-only state.
 */

/* eslint-disable no-console */

import { rawSqlite } from "../server/storage";

const NOISE_GATE_DEFAULT = 50;

interface MultiplierRow {
  id: number;
  platform: string;
  cohort_key: string;
  multiplier: number;
  ci_pct: number;
  digital_unit_share: number;
  confidence: string;
  method: string;
  gp_rating_deflator: number | null;
}

type Window = "d7" | "d30" | "d90" | "m12" | "ltd";
const ALL_WINDOWS: Window[] = ["d7", "d30", "d90", "m12", "ltd"];
const WINDOW_DAYS: Record<Window, number | null> = {
  d7: 7, d30: 30, d90: 90, m12: 365, ltd: null,
};

interface EstimateRow {
  titleId: number;
  platform: string;
  window: Window;
  asOfDate: string;
  signalValue: number | null;
  ownersLow: number | null;
  ownersMid: number | null;
  ownersHigh: number | null;
  unitsMid: number | null;
  multiplierId: number | null;
  gatedReason: string | null;
  method: string;
}

function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function daysAgoEpochSec(days: number): number {
  return Math.floor((Date.now() - days * 86_400_000) / 1000);
}

async function main() {
  const db = rawSqlite;
  const asOfDate = isoDate();
  const nowIso = new Date().toISOString();

  // ─── 1. Noise gate from app_settings ─────────────────────────────────────
  const gateRow = db.prepare(
    `SELECT value FROM app_settings WHERE key = 'noise_gate_min_signal'`
  ).get() as { value: string } | undefined;
  const noiseGate = gateRow ? parseInt(gateRow.value, 10) : NOISE_GATE_DEFAULT;
  console.log(`[estimate-console-units] noise_gate_min_signal=${noiseGate}`);

  // ─── 2. Latest multiplier per (platform, cohort_key='default') ────────────
  const multipliers = new Map<string, MultiplierRow>();
  for (const platform of ["steam", "xbox", "ps5"]) {
    const row = db.prepare(
      `SELECT id, platform, cohort_key, multiplier, ci_pct, digital_unit_share,
              confidence, method, gp_rating_deflator
         FROM ownership_multipliers
        WHERE platform = ? AND cohort_key = 'default'
          AND effective_from <= ?
        ORDER BY effective_from DESC
        LIMIT 1`
    // Compare against nowIso so hour-granular effective_from timestamps
    // (e.g. '2026-09-11T12:00Z') sort correctly when a same-day recalibration
    // is pushed. Comparing against a date-only asOfDate would incorrectly reject
    // any timestamp with a T component because '2026-09-11T12:00Z' > '2026-09-11'
    // lexically.
    ).get(platform, nowIso) as MultiplierRow | undefined;
    if (row) {
      multipliers.set(platform, row);
      const gpNote = row.gp_rating_deflator ? ` gp_deflator=${row.gp_rating_deflator}` : "";
      console.log(`[estimate-console-units] ${platform}: multiplier=${row.multiplier} ci=±${(row.ci_pct * 100).toFixed(0)}% digital=${row.digital_unit_share}${gpNote} (${row.confidence}, ${row.method})`);
    } else {
      console.warn(`[estimate-console-units] no active multiplier for ${platform} — rows will be gated as no_multiplier`);
    }
  }

  // ─── 2b. is_gamepass flags per (title_id, platform) ────────────────────
  // Only xbox rows carry a GP flag today; keep the map platform-agnostic so
  // future PS Plus day-one segmentation slots in the same way.
  const gpFlagByKey = new Map<string, boolean>();
  const gpFlags = db.prepare(
    `SELECT title_id, platform, MAX(is_gamepass) AS gp
       FROM platform_sku_map
      WHERE is_gamepass = 1
      GROUP BY title_id, platform`
  ).all() as Array<{ title_id: number; platform: string; gp: number }>;
  for (const r of gpFlags) gpFlagByKey.set(`${r.title_id}|${r.platform}`, r.gp === 1);
  console.log(`[estimate-console-units] loaded ${gpFlags.length} Game Pass–flagged (title,platform) pairs`);

  // ─── 3. Load every eligible (title, platform) from platform_sku_map ───────
  const eligible = db.prepare(
    `SELECT DISTINCT title_id, platform
       FROM platform_sku_map
      WHERE business_model = 'paid'
      ORDER BY platform, title_id`
  ).all() as Array<{ title_id: number; platform: string }>;
  console.log(`[estimate-console-units] eligible (title,platform) pairs: ${eligible.length}`);

  // ─── 4. Pre-load latest store_rating_signal_daily row per (title, platform) ─
  const latestSignal = db.prepare(
    `SELECT title_id, platform, capture_date, rating_count, window_label, raw_json
       FROM store_rating_signal_daily s1
      WHERE capture_date = (
        SELECT MAX(capture_date) FROM store_rating_signal_daily s2
         WHERE s2.title_id = s1.title_id AND s2.platform = s1.platform
      )`
  ).all() as Array<{
    title_id: number; platform: string; capture_date: string;
    rating_count: number | null; window_label: string | null; raw_json: string | null;
  }>;
  const latestSignalByKey = new Map<string, typeof latestSignal[number]>();
  for (const r of latestSignal) latestSignalByKey.set(`${r.title_id}|${r.platform}`, r);

  // ─── 5. Xbox bundled windows: parse raw_json.windows[] once per Xbox title ─
  interface XboxWindows { d7?: number | null; d30?: number | null; ltd?: number | null; }
  const xboxWindowsByTitle = new Map<number, XboxWindows>();
  for (const r of latestSignal) {
    if (r.platform !== "xbox" || !r.raw_json) continue;
    try {
      const parsed = JSON.parse(r.raw_json) as { windows?: Array<{ window: string; rating_count: number | null }> };
      const w: XboxWindows = {};
      for (const win of parsed.windows ?? []) {
        if (win.window === "d7") w.d7 = win.rating_count;
        else if (win.window === "d30") w.d30 = win.rating_count;
        else if (win.window === "ltd") w.ltd = win.rating_count;
      }
      xboxWindowsByTitle.set(r.title_id, w);
    } catch {
      // corrupt raw_json — leave map entry absent, will fall through to ltd from rating_count
    }
  }

  // ─── 6. Steam per-window aggregator from steam_review_history ─────────────
  // Cache appid lookups. platform_sku_map.external_sku is the Steam appid for row_role='base'.
  const steamAppidByTitleId = new Map<number, string>();
  const steamSkus = db.prepare(
    `SELECT title_id, external_sku FROM platform_sku_map
      WHERE platform = 'steam' AND business_model = 'paid' AND sku_role = 'base'`
  ).all() as Array<{ title_id: number; external_sku: string }>;
  for (const r of steamSkus) steamAppidByTitleId.set(r.title_id, r.external_sku);

  // ─── 6b. Cross-platform title bridge (console title_id → Steam title_id) ────
  // platform_sku_map keys every SKU by its own title_id, so a PS5 SKU for
  // "Space Marine 2" and the Steam SKU for the same game live under different
  // title_ids. Without a bridge, backfill-steam-pace can never fire on console
  // rows because steamAppidByTitleId.get(consoleTitleId) always misses.
  //
  // Build the bridge at estimator time by normalized-name matching through
  // console_title_igdb. The name column is the IGDB canonical name when the
  // match is trustworthy, otherwise the store name — same field the leaderboard
  // route displays, so operator eyeballs and estimator inference agree.
  //
  // Normalization: lowercased, trimmed. This is intentionally conservative:
  // "Space Marine 2" and "Warhammer 40,000: Space Marine 2" will NOT bridge
  // (different official titles across storefronts). We accept some misses
  // here rather than risk a bad cross-title pace curve.
  const crossPlatformSteamTitleId = new Map<number, number>();
  {
    // Storefront-suffix stripper: PS Store and Xbox Store bake platform / edition
    // qualifiers into the SKU display name that Steam never carries. Bare LOWER+
    // TRIM misses "Hogwarts Legacy PS5 Version" ↔ "Hogwarts Legacy" and dozens more.
    // We first try the raw normalized name; if that misses we retry with a stripped
    // name that removes those known suffixes and typographic curly punctuation.
    function stripStorefrontSuffix(s: string): string {
      let x = s
        .replace(/\u2019/g, "'")               // curly apostrophe → straight
        .replace(/[\u2013\u2014]/g, "-")        // en/em dash → hyphen
        .replace(/[\u2122\u00ae\u00a9]/g, "")   // ™ ® © stripped
        .replace(/[:\-]?\s*(ps4\s*&\s*ps5|ps4\s*and\s*ps5|ps4|ps5|xbox one|xbox series x\|s|xbox series x\/s|xbox series|xbox)\s*(version|edition)?\b/gi, "")
        .replace(/\b(digital deluxe edition|digital edition|deluxe edition|standard edition|complete edition|game of the year edition|goty edition|definitive edition|ultimate edition|premium edition|special edition|collector'?s edition|anniversary edition|remastered)\b/gi, "")
        .replace(/[:\-]\s*digital( version)?$/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      return x;
    }

    interface NameRow { title_id: number; norm_name: string; strip_name: string; platform: string }
    const rowsRaw = db.prepare(
      `SELECT psm.title_id AS title_id,
              LOWER(TRIM(COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, '')))) AS norm_name,
              psm.platform AS platform
         FROM platform_sku_map psm
         JOIN console_title_igdb igdb ON igdb.title_id = psm.title_id
        WHERE psm.business_model = 'paid' AND psm.sku_role = 'base'
          AND igdb.title_id IS NOT NULL`
    ).all() as Array<{ title_id: number; norm_name: string; platform: string }>;
    const rows: NameRow[] = rowsRaw.map(r => ({
      title_id: r.title_id,
      norm_name: r.norm_name,
      strip_name: stripStorefrontSuffix(r.norm_name),
      platform: r.platform,
    }));
    const steamByName = new Map<string, number>();
    const steamByStripName = new Map<string, number>();
    for (const r of rows) {
      if (r.platform === "steam") {
        if (r.norm_name)  steamByName.set(r.norm_name, r.title_id);
        if (r.strip_name) steamByStripName.set(r.strip_name, r.title_id);
      }
    }
    let bridgedExact = 0;
    let bridgedStripped = 0;
    for (const r of rows) {
      if (r.platform === "steam" || !r.norm_name) continue;
      // Try exact normalized name first.
      let steamTid = steamByName.get(r.norm_name);
      if (steamTid != null && steamTid !== r.title_id) {
        crossPlatformSteamTitleId.set(r.title_id, steamTid);
        bridgedExact++;
        continue;
      }
      // Fall back to storefront-suffix-stripped match.
      if (r.strip_name) {
        steamTid = steamByStripName.get(r.strip_name);
        if (steamTid != null && steamTid !== r.title_id) {
          crossPlatformSteamTitleId.set(r.title_id, steamTid);
          bridgedStripped++;
        }
      }
    }
    console.log(`[estimate-console-units] cross-platform bridge: exact=${bridgedExact} stripped=${bridgedStripped} total=${crossPlatformSteamTitleId.size}`);
  }

  // Resolve a title_id to the Steam title_id that carries its review history.
  // If the console title_id itself has a Steam SKU (same-id case), that wins;
  // otherwise fall through to the name-based bridge; otherwise no Steam side.
  function bridgedSteamTitleId(titleId: number): number | null {
    if (steamAppidByTitleId.has(titleId)) return titleId;
    return crossPlatformSteamTitleId.get(titleId) ?? null;
  }

  const steamHistoryAgg = db.prepare(
    `SELECT COALESCE(SUM(recommendations_up + recommendations_down), 0) AS s
       FROM steam_review_history
      WHERE app_id = ? AND bucket_start >= ?`
  );

  function steamWindowSignal(steamTitleId: number, days: number): number | null {
    const appid = steamAppidByTitleId.get(steamTitleId);
    if (!appid) return null;
    const cutoff = daysAgoEpochSec(days);
    const r = steamHistoryAgg.get(appid, cutoff) as { s: number };
    // Zero is a valid answer meaning "no reviews in that window" — return 0, not null.
    // The noise gate handles the too-small case.
    return r.s;
  }

  // Steam latest LTD signal for a Steam title_id. Denominator for backfill-steam-pace.
  function steamLtdSignal(steamTitleId: number): number | null {
    return latestSignalByKey.get(`${steamTitleId}|steam`)?.rating_count ?? null;
  }

  // Steam window/LTD ratio used by backfill-steam-pace to slice the console
  // LTD into a windowed signal. Guardrails:
  //  • both numerator and denominator must exist and be > 0
  //  • Steam LTD must be >= 100 (below that the ratio is noise-dominated)
  //  • ratio is clamped to [0, 1] — a window signal can never exceed lifetime
  //
  // Accepts the console title_id and resolves the Steam side through the
  // bridge internally so callers don't need to know about the mapping.
  function steamWindowRatio(titleId: number, days: number): number | null {
    const steamTid = bridgedSteamTitleId(titleId);
    if (steamTid == null) return null;
    const win = steamWindowSignal(steamTid, days);
    const ltd = steamLtdSignal(steamTid);
    if (win == null || ltd == null || ltd < 100 || ltd <= 0) return null;
    const ratio = win / ltd;
    if (ratio <= 0) return null;
    return Math.min(1, ratio);
  }

  // ─── 7. Forward-history depth per platform, and per-window historical LTD lookup ─
  //     For each (title, platform, window) we may need the LTD count as-of
  //     (today − window_days). If it exists AND the row's current LTD > it, that
  //     delta IS the windowed signal.
  const historyDepth = db.prepare(
    `SELECT platform, COUNT(DISTINCT capture_date) AS n
       FROM store_rating_signal_daily
      GROUP BY platform`
  ).all() as Array<{ platform: string; n: number }>;
  const forwardDaysByPlatform = new Map<string, number>();
  for (const r of historyDepth) forwardDaysByPlatform.set(r.platform, r.n);
  for (const p of ["steam", "xbox", "ps5"]) {
    console.log(`[estimate-console-units] ${p} forward-history depth: ${forwardDaysByPlatform.get(p) ?? 0} day(s)`);
  }

  // Look up an as-of LTD for a (title, platform, target_date). Falls back to the
  // OLDEST snapshot on or after target_date only when the exact date is missing,
  // so short gaps in collection don't kill delta math.
  const asOfLtdStmt = db.prepare(
    `SELECT rating_count, capture_date
       FROM store_rating_signal_daily
      WHERE title_id = ? AND platform = ? AND capture_date <= ?
      ORDER BY capture_date DESC
      LIMIT 1`
  );
  function asOfLtd(titleId: number, platform: string, targetDate: string): number | null {
    const r = asOfLtdStmt.get(titleId, platform, targetDate) as { rating_count: number | null; capture_date: string } | undefined;
    if (!r || r.rating_count == null) return null;
    return r.rating_count;
  }
  function daysAgoIso(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  // ─── 7b. Effective release-date map (mirrors the leaderboard route's CASE) ─
  //     Used for bootstrap gap-fill: if release <= now AND release >= now-window_days,
  //     the title's LTD count is EQUIVALENT to its windowed signal (all ratings arrived
  //     inside that window). Confidence-aware: prefer store_release_date when IGDB
  //     matched the wrong game.
  const releaseRows = db.prepare(
    `SELECT title_id,
            CASE WHEN match_confidence = 'low'
              THEN COALESCE(store_release_date, release_date)
              ELSE COALESCE(release_date, store_release_date)
            END AS effective_release
       FROM console_title_igdb`
  ).all() as Array<{ title_id: number; effective_release: string | null }>;
  const releaseByTitle = new Map<number, string>();
  for (const r of releaseRows) {
    if (r.effective_release) releaseByTitle.set(r.title_id, r.effective_release);
  }
  const todayIso = asOfDate;
  function isReleasedWithin(titleId: number, days: number): boolean {
    const rel = releaseByTitle.get(titleId);
    if (!rel) return false;
    return rel >= daysAgoIso(days) && rel <= todayIso;
  }

  // ─── 8. Per-platform signal resolver ─────────────────────────────────────
  //
  // Signal resolution cascade (from best to worst confidence):
  //   1. native            — platform's own per-window count (Steam review
  //                          history; Xbox d7/d30 UsageData)
  //   2. forward-delta     — ltd_today − ltd_(N_days_ago), only when we have
  //                          N+1 days of collection history
  //   3. backfill-bootstrap — title released inside the window → ltd IS the
  //                           window signal (exact math, no modeling assumption)
  //   4. backfill-steam-pace — apply this title's Steam window/LTD ratio to
  //                            the console LTD (same-title cross-platform ratio)
  //   5. backfill-peer-ratio — reserved for a future decay-adjusted variant.
  //                            Currently subsumed by steam-pace.
  //
  // Each backfill source tags row.method with 'backfill-*' so the client can
  // badge those rows. The tag disappears the moment forward-delta or native
  // returns a value — those paths leave methodTag null and we keep the
  // multiplier's method unchanged.
  interface SignalResult { signal: number; methodTag: string | null }

  function resolveSteamSignal(titleId: number, window: Window): SignalResult | null {
    if (window === "ltd") {
      const s = steamLtdSignal(titleId);
      return s == null ? null : { signal: s, methodTag: null };
    }
    const s = steamWindowSignal(titleId, WINDOW_DAYS[window]!);
    return s == null ? null : { signal: s, methodTag: null };
  }

  function resolveConsoleSignal(
    titleId: number, platform: "xbox" | "ps5", window: Window,
  ): SignalResult | null {
    const ltdNow = platform === "xbox"
      ? (xboxWindowsByTitle.get(titleId)?.ltd
         ?? latestSignalByKey.get(`${titleId}|xbox`)?.rating_count
         ?? null)
      : (latestSignalByKey.get(`${titleId}|ps5`)?.rating_count ?? null);

    if (window === "ltd") {
      return ltdNow == null ? null : { signal: ltdNow, methodTag: null };
    }

    const winDays = WINDOW_DAYS[window]!;

    // 1. NATIVE — Xbox displaycatalog carries d7 and d30 UsageData.
    if (platform === "xbox") {
      const xw = xboxWindowsByTitle.get(titleId);
      if (window === "d7" && xw?.d7 != null) return { signal: xw.d7, methodTag: null };
      if (window === "d30" && xw?.d30 != null) return { signal: xw.d30, methodTag: null };
    }

    // 2. FORWARD-DELTA — kicks in once collection history exceeds window length.
    const historyDays = forwardDaysByPlatform.get(platform) ?? 0;
    if (historyDays > winDays && ltdNow != null) {
      const past = asOfLtd(titleId, platform, daysAgoIso(winDays));
      if (past != null && ltdNow >= past) {
        return { signal: ltdNow - past, methodTag: null };
      }
    }

    // 3. BACKFILL-BOOTSTRAP — title released inside window → ltd IS the window.
    if (ltdNow != null && isReleasedWithin(titleId, winDays)) {
      return { signal: ltdNow, methodTag: "backfill-bootstrap" };
    }

    // 4. BACKFILL-STEAM-PACE — Same-title cross-platform ratio. When the same
    //    title also ships on Steam and has enough LTD to be trustworthy, the
    //    fraction of its ratings that fell in the last N days on Steam is a
    //    strong prior for the console version's own pace.
    if (ltdNow != null) {
      const ratio = steamWindowRatio(titleId, winDays);
      if (ratio != null) {
        return { signal: Math.round(ltdNow * ratio), methodTag: "backfill-steam-pace" };
      }
    }

    // 5. BACKFILL-PEER-RATIO — reserved. Currently steam-pace subsumes it. Kept
    //    as a distinct code path so a future decay-adjusted variant can slot in
    //    without changing the resolver contract or the client's badge dictionary.

    return null;
  }

  // ─── 9. For each (title, platform, window), compute an EstimateRow ────────
  const rows: EstimateRow[] = [];
  for (const { title_id: titleId, platform } of eligible) {
    const mult = multipliers.get(platform);
    for (const window of ALL_WINDOWS) {
      const row: EstimateRow = {
        titleId, platform, window, asOfDate,
        signalValue: null,
        ownersLow: null, ownersMid: null, ownersHigh: null, unitsMid: null,
        multiplierId: mult?.id ?? null,
        gatedReason: null,
        method: mult ? mult.method : "no_multiplier",
      };

      // ─── Missing multiplier ────────────────────────────────────────────
      if (!mult) {
        row.gatedReason = "no_multiplier";
        rows.push(row);
        continue;
      }

      // ─── Signal resolution ─────────────────────────────────────────────
      const resolved = platform === "steam"
        ? resolveSteamSignal(titleId, window)
        : resolveConsoleSignal(titleId, platform as "xbox" | "ps5", window);

      let signal: number | null = null;
      if (resolved) {
        signal = resolved.signal;
        if (resolved.methodTag) row.method = resolved.methodTag;
      } else if (window !== "ltd" && (platform === "xbox" || platform === "ps5")) {
        row.gatedReason = "insufficient_history";
        rows.push(row);
        continue;
      }

      row.signalValue = signal;

      // ─── Missing signal ────────────────────────────────────────────────
      if (signal == null) {
        row.gatedReason = "no_signal";
        rows.push(row);
        continue;
      }

      // ─── Noise gate (against raw signal, before GP deflator) ─────────
      if (signal < noiseGate) {
        row.gatedReason = "signal_too_small";
        rows.push(row);
        continue;
      }

      // ─── Game Pass rating deflator (v0.3, xbox only today) ───────────
      // GP subscribers rate without buying, so per-owner rating rate is
      // inflated. Deflate raw ratings before multiplying so GP-flagged
      // SKUs and non-GP SKUs share one platform multiplier.
      const isGp = gpFlagByKey.get(`${titleId}|${platform}`) ?? false;
      const deflator = isGp && mult.gp_rating_deflator ? mult.gp_rating_deflator : 1;
      const effectiveSignal = signal / deflator;

      // ─── Apply multiplier ──────────────────────────────────────────────
      const ownersMid = effectiveSignal * mult.multiplier;
      const ownersLow = ownersMid * (1 - mult.ci_pct);
      const ownersHigh = ownersMid * (1 + mult.ci_pct);
      const unitsMid = ownersMid / mult.digital_unit_share;

      row.ownersMid = Math.round(ownersMid);
      row.ownersLow = Math.round(ownersLow);
      row.ownersHigh = Math.round(ownersHigh);
      row.unitsMid = Math.round(unitsMid);
      rows.push(row);
    }
  }

  // ─── 9. UPSERT into window_estimates_daily ───────────────────────────────
  const upsert = db.prepare(
    `INSERT INTO window_estimates_daily
       (title_id, platform, window, as_of_date,
        signal_value, owners_low, owners_mid, owners_high, units_mid,
        multiplier_id, gated_reason, method, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(title_id, platform, window, as_of_date) DO UPDATE SET
       signal_value  = excluded.signal_value,
       owners_low    = excluded.owners_low,
       owners_mid    = excluded.owners_mid,
       owners_high   = excluded.owners_high,
       units_mid     = excluded.units_mid,
       multiplier_id = excluded.multiplier_id,
       gated_reason  = excluded.gated_reason,
       method        = excluded.method`
  );

  const tx = db.transaction((rs: EstimateRow[]) => {
    for (const r of rs) {
      upsert.run(
        r.titleId, r.platform, r.window, r.asOfDate,
        r.signalValue, r.ownersLow, r.ownersMid, r.ownersHigh, r.unitsMid,
        r.multiplierId, r.gatedReason, r.method, nowIso,
      );
    }
  });
  tx(rows);

  // ─── 9b. Game Pass revenue-share overlay for Xbox ────────────────────────
  //
  // Game Pass massively inflates Xbox ratings — subscribers rate without
  // buying, and popular day-one GP titles like Palworld pick up ratings at a
  // rate untethered from purchases. The gp_rating_deflator (v0.3) corrects
  // for that on average, but for GP-anchor mega-hits the per-title deflator
  // needed is much larger than the fitted median.
  //
  // Fix: when a GP-flagged Xbox title has a Steam sibling with a solid LTD
  // signal, project Xbox units from the fixed multi-platform revenue share
  // rather than from raw Xbox ratings. Shares (from ops spec):
  //
  //   PC (Steam) 46%   PS5 33%   Xbox 18%   Switch 2 3%
  //
  // For a title on Steam + Xbox + PS5 (no Switch), Xbox revenue share is
  //   0.18 / (0.46 + 0.33 + 0.18) = 0.188  ≈ 18/97
  // Steam revenue is our anchor: revenue_steam = units_steam × MSRP_steam × ASP_steam.
  // Xbox revenue = revenue_steam × (xbox_share / steam_share).
  // Xbox units = revenue_xbox / (MSRP_xbox × ASP_xbox).
  //
  // We compute the overlay for the LTD window per title, then apportion the
  // same fraction across d7/d30/d90/m12 by the Xbox raw signal ratio (so a
  // recent hit's per-window shape is preserved from Xbox's own ratings
  // pace). We only OVERRIDE the rating-derived number when the overlay is
  // LOWER — this is a deflation, never inflation.
  //
  // Method tag: 'steam-anchored-revshare-v01'
  {
    const REV_SHARE: Record<string, number> = { steam: 0.46, ps5: 0.33, xbox: 0.18, switch2: 0.03 };
    const ASP: Record<string, number> = { steam: 0.66, ps5: 0.80, xbox: 0.80 };

    // Pull the fresh rows we just wrote so we work off canonical state.
    const written = db.prepare(
      `SELECT title_id, platform, window, signal_value, owners_low, owners_mid, owners_high, units_mid, gated_reason, method
         FROM window_estimates_daily
        WHERE as_of_date = ?`
    ).all(asOfDate) as Array<{
      title_id: number; platform: string; window: string;
      signal_value: number | null; owners_low: number | null; owners_mid: number | null;
      owners_high: number | null; units_mid: number | null;
      gated_reason: string | null; method: string;
    }>;
    // Index by title_id → platform → window
    const byTPW = new Map<string, typeof written[number]>();
    for (const w of written) byTPW.set(`${w.title_id}|${w.platform}|${w.window}`, w);

    // Bridge Xbox title_id → Steam title_id via same-name lookup used earlier.
    // Xbox title_ids on their own don't carry Steam data, so use bridgedSteamTitleId.
    // We need it to be visible here; it's defined inside main(), so this block IS inside main().

    const msrpByKey = new Map<string, number>();
    for (const r of db.prepare(
      `SELECT title_id, platform, msrp_usd_cents FROM platform_sku_map WHERE msrp_usd_cents IS NOT NULL`
    ).all() as Array<{ title_id: number; platform: string; msrp_usd_cents: number }>) {
      msrpByKey.set(`${r.title_id}|${r.platform}`, r.msrp_usd_cents);
    }

    // Helper: does this title ship on a given platform (paid, base)?
    const shipsOn = new Set<string>();
    for (const r of db.prepare(
      `SELECT DISTINCT title_id, platform FROM platform_sku_map
        WHERE business_model = 'paid' AND sku_role = 'base'`
    ).all() as Array<{ title_id: number; platform: string }>) {
      shipsOn.add(`${r.title_id}|${r.platform}`);
    }

    let overlayApplied = 0;
    let overlaySkippedNoSteam = 0;
    let overlaySkippedRaisesUnits = 0;

    const overlayUpdate = db.prepare(
      `UPDATE window_estimates_daily
          SET owners_mid   = ?,
              owners_low   = ?,
              owners_high  = ?,
              units_mid    = ?,
              method       = ?
        WHERE title_id = ? AND platform = ? AND window = ? AND as_of_date = ?`
    );

    const overlayTx = db.transaction(() => {
      // Iterate Xbox rows only, GP-flagged only.
      const xboxTitles = new Set<number>();
      for (const w of written) if (w.platform === "xbox") xboxTitles.add(w.title_id);

      for (const xboxTid of xboxTitles) {
        const isGp = gpFlagByKey.get(`${xboxTid}|xbox`) ?? false;
        if (!isGp) continue;

        const steamTid = bridgedSteamTitleId(xboxTid);
        if (steamTid == null) { overlaySkippedNoSteam++; continue; }

        // Need Steam LTD units to anchor the projection.
        const steamLtd = byTPW.get(`${steamTid}|steam|ltd`);
        if (!steamLtd || steamLtd.units_mid == null) { overlaySkippedNoSteam++; continue; }

        const steamMsrpCents = msrpByKey.get(`${steamTid}|steam`);
        if (!steamMsrpCents) { overlaySkippedNoSteam++; continue; }

        // Sum ACTIVE revenue shares (platforms this title actually ships on).
        // We drop platforms it doesn't ship on so the pie sums to 1 across the
        // real footprint. Switch 2 is not tracked in platform_sku_map today;
        // treat it as absent unless a switch2 row exists.
        // Sum revenue shares for the platforms this title actually ships on.
        // shipsOn is keyed (title_id, platform) — ps5 title_ids differ from steam,
        // so for ps5 we ask "is there any ps5 title_id that bridges back to our steamTid?".
        let activeShareSum = 0;
        let hasSteam = false, hasXbox = false, hasPs5 = false;
        if (shipsOn.has(`${steamTid}|steam`)) { activeShareSum += REV_SHARE.steam; hasSteam = true; }
        if (shipsOn.has(`${xboxTid}|xbox`))   { activeShareSum += REV_SHARE.xbox;  hasXbox = true; }
        for (const [ps5Tid, brSteam] of crossPlatformSteamTitleId) {
          if (brSteam === steamTid && shipsOn.has(`${ps5Tid}|ps5`)) { hasPs5 = true; break; }
        }
        if (hasPs5) activeShareSum += REV_SHARE.ps5;
        // switch2 skipped — not tracked in platform_sku_map today.
        void hasSteam; void hasXbox; // used implicitly via activeShareSum; retained for future logging
        if (activeShareSum <= 0) continue;

        const steamShareActive = REV_SHARE.steam / activeShareSum;
        const xboxShareActive  = REV_SHARE.xbox  / activeShareSum;

        // Steam LTD revenue in cents: units × MSRP_cents × ASP_steam
        const steamRevCents = steamLtd.units_mid * steamMsrpCents * ASP.steam;

        // Xbox LTD revenue in cents = steam_rev × (xbox_share / steam_share)
        const xboxRevCents  = steamRevCents * (xboxShareActive / steamShareActive);

        const xboxMsrpCents = msrpByKey.get(`${xboxTid}|xbox`) ?? steamMsrpCents;
        // Xbox units = revenue / (MSRP × ASP_xbox)
        const overlayXboxLtdUnits = Math.round(xboxRevCents / (xboxMsrpCents * ASP.xbox));

        // Only overlay when the projection is LOWER than the rating-derived number.
        const xboxLtd = byTPW.get(`${xboxTid}|xbox|ltd`);
        if (!xboxLtd || xboxLtd.units_mid == null) { continue; }
        if (overlayXboxLtdUnits >= xboxLtd.units_mid) { overlaySkippedRaisesUnits++; continue; }

        // Apply the LTD overlay first, then apportion the same shrink ratio
        // across d7/d30/d90/m12 (preserves per-window shape from Xbox ratings).
        const shrink = overlayXboxLtdUnits / xboxLtd.units_mid;

        for (const w of ALL_WINDOWS) {
          const cur = byTPW.get(`${xboxTid}|xbox|${w}`);
          if (!cur || cur.units_mid == null || cur.owners_mid == null) continue;
          const newOwnersMid = cur.owners_mid * shrink;
          const newOwnersLow  = cur.owners_low  == null ? null : cur.owners_low  * shrink;
          const newOwnersHigh = cur.owners_high == null ? null : cur.owners_high * shrink;
          const newUnitsMid   = Math.round(cur.units_mid * shrink);
          overlayUpdate.run(
            Math.round(newOwnersMid),
            newOwnersLow  == null ? null : Math.round(newOwnersLow),
            newOwnersHigh == null ? null : Math.round(newOwnersHigh),
            newUnitsMid,
            "steam-anchored-revshare-v01",
            xboxTid, "xbox", w, asOfDate,
          );
        }
        overlayApplied++;
      }
    });
    overlayTx();

    console.log(`[estimate-console-units] GP revshare overlay: applied=${overlayApplied}, skipped_no_steam_anchor=${overlaySkippedNoSteam}, skipped_would_raise=${overlaySkippedRaisesUnits}`);
  }

  // ─── 10. Summary ─────────────────────────────────────────────────────────
  const byOutcome: Record<string, number> = {};
  for (const r of rows) {
    const key = r.gatedReason ?? "estimated";
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
  }
  console.log(`[estimate-console-units] wrote ${rows.length} rows to window_estimates_daily`);
  for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }

  // Sample the biggest 5 estimated units for a quick sanity check.
  const sample = db.prepare(
    `SELECT w.title_id, w.platform, w.window, w.signal_value, w.units_mid,
            COALESCE(i.name, m.external_sku) AS name
       FROM window_estimates_daily w
  LEFT JOIN console_title_igdb i ON i.title_id = w.title_id
  LEFT JOIN platform_sku_map m
         ON m.title_id = w.title_id AND m.platform = w.platform AND m.sku_role = 'base'
      WHERE w.as_of_date = ? AND w.units_mid IS NOT NULL AND w.window = 'ltd'
      ORDER BY w.units_mid DESC
      LIMIT 8`
  ).all(asOfDate) as Array<{ title_id: number; platform: string; window: string; signal_value: number; units_mid: number; name: string }>;
  console.log(`[estimate-console-units] top-8 LTD units_mid sanity check:`);
  for (const r of sample) {
    console.log(`  ${r.platform.padEnd(5)} ${String(r.signal_value).padStart(9)} sig → ${String(r.units_mid).padStart(11)} units — ${r.name}`);
  }

}

main().catch((err) => {
  console.error("[estimate-console-units] FATAL:", err);
  process.exit(1);
});
