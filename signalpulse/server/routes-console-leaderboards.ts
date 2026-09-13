/**
 * Console leaderboards + PDP API routes.
 *
 * Endpoints:
 *   GET /api/console/leaderboards/:platform
 *     Query:
 *       window = d7|d30|d90|m12|ltd  (default d30)
 *       sort   = revenue|units|ratings|score|asp   (default revenue)
 *       dir    = asc|desc   (default desc)
 *
 *     Returns top-100 titles for that platform for the requested window.
 *
 *     Ranking columns:
 *       revenue  = units_mid * asp_usd_cents / 100 (window-scoped, ASP-adjusted)
 *       units    = window_estimates_daily.units_mid
 *       ratings  = store_rating_signal_daily.rating_count (latest LTD snapshot)
 *       score    = store_rating_signal_daily.avg_rating   (latest LTD snapshot)
 *
 *     ASP factors (fraction of MSRP realized per platform, applied to revenue only):
 *       steam 0.66  (heavy discounting + regional pricing)
 *       ps5   0.80  (year-round PSN Store discounts + PS+ Extra bundling)
 *       xbox  0.80  (Microsoft Store discounts + Game Pass rev share)
 *     Configurable via app_settings keys asp_factor_steam / asp_factor_ps5 /
 *       asp_factor_xbox; defaults live in ASP_FACTOR_DEFAULTS below.
 *
 *     Ratings and score feed the estimator; they are also user-selectable
 *     sort keys. Titles with a NULL sort value sink to the bottom rather
 *     than being excluded, so the client still gets a full 100 rows even
 *     before the estimator has populated every window. rating_count is a
 *     stable-sort tie-breaker for every sort mode.
 *
 *     Only rows with business_model = 'paid' AND sku_role = 'base' are returned.
 *
 *   GET /api/console/titles/:titleId
 *     Returns PDP header data: title metadata, current LTD snapshot per platform,
 *     IGDB enrichment (cover, screenshots, genres, developers), platform SKUs.
 *
 *   GET /api/console/titles/:titleId/timeseries
 *     Query: platform=steam|xbox|ps5   (required)
 *            from=YYYY-MM-DD           (optional, default 90d ago)
 *            to=YYYY-MM-DD             (optional, default today)
 *            metric=rating_count|avg_rating|owners_mid  (default rating_count)
 *     Returns array of { date, value } points from store_rating_signal_daily
 *     joined with window_estimates_daily.
 *
 *   POST /api/console/igdb/refresh/:titleId
 *     Admin-only re-cache of IGDB metadata for one title.
 */

import type { Express } from "express";
import { rawSqlite } from "./storage";
import { refreshIgdbForTitle } from "./signals/console/igdb";

type Platform = "steam" | "xbox" | "ps5";
const PLATFORMS: Platform[] = ["steam", "xbox", "ps5"];

function parseDate(v: string | undefined, fallback: string): string {
  if (!v) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return fallback;
  return v;
}

function todayIsoDate(): string { return new Date().toISOString().slice(0, 10); }
function daysAgo(n: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Edition-suffix normalizer used by the leaderboard rollup (Change 10, Push 2).
//
// Purpose: collapse SKU variants of the SAME game family within a single platform
// so "NBA 2K27" and "NBA 2K27 Deluxe" render as one row rather than two.
//
// Strategy: lowercase, strip trademark noise, then chop off known edition suffixes.
// Order matters — we strip the longest suffix first so "Digital Deluxe" wins over
// "Deluxe", "Premium Deluxe" wins over "Deluxe", etc. Anything left after the
// suffix strip is the group key. "Marvel's Wolverine" and "Marvel's Wolverine:
// Digital Deluxe Edition" both collapse to "marvel's wolverine".
//
// The output is opaque — it is compared for equality but never displayed. A
// title without any known edition suffix returns its own normalized name so
// it groups only with exact-duplicate SKUs (which should not exist post-Push 2).
//
// Also collapses Sony's PS4 & PS5 hybrid SKUs into their PS5-only twin
// (Change 6, Push 2): "Marvel's Spider-Man 2 PS4 & PS5" and "Marvel's
// Spider-Man 2" both collapse to the same key.
export function editionGroupKey(name: string | null | undefined): string {
  if (!name) return "";
  let s = name.toLowerCase();
  // Strip trademark / registered / smart-quote noise so "PS4™ & PS5™" matches.
  s = s.replace(/[™®℗℠]/g, "");
  s = s.replace(/[‘’‚‛‹›]/g, "'");
  s = s.replace(/[“”„‟«»]/g, '"');
  // Collapse whitespace early so " - " / ": " separators normalize.
  s = s.replace(/\s+/g, " ").trim();

  // Ordered list of edition suffixes. Long/specific first so multi-word suffixes
  // are recognized before their sub-strings. Match at end-of-string only; the
  // pattern anchors at (a) end or (b) end after a colon/dash separator.
  const SUFFIXES: string[] = [
    // Composite / multi-word first
    "digital deluxe edition",
    "premium deluxe edition",
    "legendary edition",
    "definitive edition",
    "anniversary edition",
    "gold edition",
    "deluxe edition",
    "ultimate edition",
    "complete edition",
    "standard edition",
    "premium edition",
    "vault edition",
    "eclipse edition",
    "legacy edition",
    "enhanced edition",
    "kickoff bundle",
    "digital version",
    "friend's pass",
    "friends pass",
    "free trial",
    "game preview",
    // Cross-gen indicators
    "ps4 & ps5",
    "ps4 and ps5",
    "ps5 version",
    "ps4 version",
    "xbox one & xbox series x|s",
    "xbox one and xbox series x|s",
    "xbox series x|s",
    // Bare qualifiers (last so they don't over-match)
    "digital deluxe",
    "premium deluxe",
    "super deluxe",
    "deluxe",
    "ultimate",
    "premium",
    "standard",
    "complete",
    "definitive",
    "gold",
    "vault",
    "eclipse",
    "legacy",
    "enhanced",
  ];

  // Repeatedly strip trailing suffixes so "NBA 2K27: Standard Edition Deluxe"
  // — nonsensical but possible — collapses in one pass.
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    for (const suf of SUFFIXES) {
      // Strip separator (colon or dash) + optional space + suffix at end.
      const patterns = [
        new RegExp(`[:\\-]\\s*${suf.replace(/[|]/g, "\\|").replace(/[.*+?^${}()]/g, "\\$&")}\\s*$`),
        new RegExp(`\\s+${suf.replace(/[|]/g, "\\|").replace(/[.*+?^${}()]/g, "\\$&")}\\s*$`),
        new RegExp(`^${suf.replace(/[|]/g, "\\|").replace(/[.*+?^${}()]/g, "\\$&")}\\s*$`),
      ];
      for (const re of patterns) {
        const next = s.replace(re, "");
        if (next !== s && next.length >= 2) {
          s = next.trim();
          changed = true;
          break;
        }
      }
    }
  }

  // Strip trailing colon / dash / whitespace once suffix removal is done.
  s = s.replace(/[\s:\-]+$/g, "").trim();
  return s;
}

// Platform ASP factors used to translate MSRP into an Average Selling Price
// estimate. Applied at read time so an operator can retune without a re-run
// of the estimator. Kept out of window_estimates_daily on purpose: units are
// the modelled quantity; ASP is a downstream pricing overlay.
const ASP_FACTOR_DEFAULTS: Record<Platform, number> = {
  steam: 0.66,
  ps5:   0.80,
  xbox:  0.80,
};

function aspFactorFor(platform: Platform): number {
  // app_settings override lets us retune from the Settings UI without a deploy.
  try {
    const r = rawSqlite
      .prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get(`asp_factor_${platform}`) as { value: string } | undefined;
    if (r && r.value != null) {
      const v = parseFloat(r.value);
      if (Number.isFinite(v) && v > 0 && v <= 1) return v;
    }
  } catch { /* app_settings may not exist in an odd sandbox */ }
  return ASP_FACTOR_DEFAULTS[platform];
}

// ─── Immutable platform revenue-mix + per-IP overrides ────────────────────
// Lifted from inside the per-platform handler so the multiplatform endpoint
// can reuse the exact same math (see routes-console-leaderboards.ts:Path B
// and lessons.md 2026-09-12 entries). Values must stay in sync across every
// consumer — do not fork.
const PLATFORM_RATIO_VS_STEAM: Partial<Record<Platform, number>> = {
  ps5:  37.9 / 49.5,   // ≈ 0.7657
  xbox: 12.6 / 49.5,   // ≈ 0.2545
};

type IpOverrideRule = { pattern: RegExp; label: string; ps5: number; xbox: number; steam: number };
const IP_OVERRIDE_RULES: IpOverrideRule[] = [
  // Sports IPs — console-dominant mix (PS5 65 / Xbox 25 / Steam 10).
  { pattern: /^\s*nba\s*2k/i,                     label: "NBA 2K",                      ps5: 65, xbox: 25, steam: 10 },
  { pattern: /^\s*madden\s*nfl/i,                 label: "Madden NFL",                  ps5: 65, xbox: 25, steam: 10 },
  { pattern: /^\s*ea\s*sports\s*college\s*football/i, label: "EA Sports College Football", ps5: 65, xbox: 25, steam: 10 },
  { pattern: /^\s*ea\s*sports\s*fc/i,             label: "EA Sports FC",                ps5: 65, xbox: 25, steam: 10 },
  // Sony first-party IPs — PS5 flagship mix (PS5 90 / Steam 10 / Xbox 0).
  { pattern: /^\s*(marvel'?s\s+)?spider-?man/i,   label: "Spider-Man",                  ps5: 90, xbox: 0,  steam: 10 },
  { pattern: /^\s*god\s*of\s*war/i,               label: "God of War",                  ps5: 90, xbox: 0,  steam: 10 },
  { pattern: /^\s*the\s+last\s+of\s+us/i,         label: "The Last of Us",              ps5: 90, xbox: 0,  steam: 10 },
  { pattern: /^\s*horizon\s+(zero|forbidden|call)/i, label: "Horizon",                  ps5: 90, xbox: 0,  steam: 10 },
  { pattern: /^\s*gran\s*turismo/i,               label: "Gran Turismo",                ps5: 90, xbox: 0,  steam: 10 },
  { pattern: /^\s*uncharted/i,                    label: "Uncharted",                   ps5: 90, xbox: 0,  steam: 10 },
  { pattern: /^\s*ratchet\s*(&|and)\s*clank/i,    label: "Ratchet & Clank",             ps5: 90, xbox: 0,  steam: 10 },
];

function ipOverrideFactorFor(displayName: string | null | undefined, plat: Platform): { factor: number; label: string } | null {
  if (plat !== "ps5" && plat !== "xbox") return null;
  if (!displayName) return null;
  for (const r of IP_OVERRIDE_RULES) {
    if (r.pattern.test(displayName)) {
      const numer = plat === "ps5" ? r.ps5 : r.xbox;
      return { factor: numer / r.steam, label: r.label };
    }
  }
  return null;
}

// Threshold below which a Steam revenue value is treated as "no meaningful
// Steam signal" (delisted PC port, missing SKU, etc.) so console rows fall
// through to their raw estimator instead of getting zeroed. Matches the
// threshold in the per-platform overlay.
const STEAM_MEANINGFUL_REVENUE_FLOOR_USD = 1000;

export function registerConsoleLeaderboardRoutes(app: Express) {

  // ─── Leaderboard list ─────────────────────────────────────────────────────
  app.get("/api/console/leaderboards/:platform", (req, res) => {
    try {
      const platform = req.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid platform" });
      // Default is the 7d window so fresh weekly hits (launches like
      // Halloween: The Game and How to Fish) surface first. Because the
      // estimator sometimes doesn't have 7d numbers yet for very recent
      // launches, the SQL below cascades w.units_mid through d7→d30→d90→ltd
      // per-row so revenue/units always fills top-100 even when a specific
      // window is thin. The `windowUsed` column on each row tells the client
      // which underlying window produced the number.
      const window = (req.query.window as string) || "d7";
      if (!["d7","d30","d90","m12","ltd"].includes(window)) return res.status(400).json({ error: "invalid window" });

      // Sort mode + direction. Whitelist rather than string-interpolate to keep
      // the query prepareable and to prevent injection through the query string.
      const sort = ((req.query.sort as string) || "revenue").toLowerCase();
      if (!["revenue","units","ratings","score","asp"].includes(sort)) return res.status(400).json({ error: "invalid sort" });
      const dir = ((req.query.dir as string) || "desc").toLowerCase();
      if (!["asc","desc"].includes(dir)) return res.status(400).json({ error: "invalid dir" });

      const aspFactor = aspFactorFor(platform);

      // sortExpr maps each sort key to the column expression. revenue is
      // units × asp/100 (dollars), where asp = msrp × platform ASP factor,
      // so a title with unknown msrp (NULL) sinks. The ASP factor is a
      // constant per request — sqlite treats it as a bound parameter below.
      //
      // Sort expressions reference the CASCADED window value (built below as
      // cascadeUnits) rather than a single window's row, so a title with only
      // 30d data still sorts sensibly against titles that have real 7d data.
      const sortExprFor = (cascadeUnitsSql: string): Record<string, string> => ({
        revenue: `(${cascadeUnitsSql} * psm.msrp_usd_cents * ? / 100.0)`,
        units:   cascadeUnitsSql,
        ratings: "srs.rating_count",
        score:   "srs.avg_rating",
        // ASP sort ranks by MSRP directly since ASP = MSRP × platform factor is
        // a fixed monotonic multiplier per platform. Cheaper avoids two more binds.
        asp:     "psm.msrp_usd_cents",
      });
      const dirSql = dir === "asc" ? "ASC" : "DESC";

      // Row-level window cascade. Business rule:
      //   Bias toward the requested window (default 7d), but if that window has
      //   no estimate yet for a given (title, platform), fall back to the next
      //   wider window so the row still ranks. Order: d7 → d30 → d90 → m12 → ltd.
      //   Never widen NARROWER (e.g. d30 request doesn't fall to d7): that would
      //   break the semantics of a user asking specifically for the 30d view.
      //
      // m12 explicitly does NOT fall through to ltd. LTD is a lifetime cumulative
      // that spans arbitrary years — showing it as a 12-month value routinely
      // inflated legacy titles (CoD MW4 at $1.82B m12 = actually the full lifetime
      // total). The cascade-cliff gate below sinks m12 rows lacking a real m12
      // estimate, matching how d7/d30/d90 sink when their nearest rung is missing.
      //
      // v0.4 (2026-09-12): narrow cascades no longer fall through to m12. Ghost
      // of Yotei (released 2025-10) had d7/d30/d90 all gated as insufficient_history,
      // but m12 fired `backfill-bootstrap` with signal=LTD. With the previous
      // cascade [d7, d30, d90, m12] a d7 request COALESCE'd all the way to m12 and
      // displayed LTD numbers as a 7-day value. The route's near-rung cliff gate
      // (w0 OR w1) admitted the row because w1=d30 was null but w2/w3 were checked
      // via COALESCE, not the cliff. Narrowing the cascade cuts that path.
      const CASCADE_BY_WINDOW: Record<string, string[]> = {
        d7:  ["d7", "d30"],
        d30: ["d30", "d90"],
        d90: ["d90"],
        m12: ["m12"],
        ltd: ["ltd"],
      };
      const cascade = CASCADE_BY_WINDOW[window];

      // "Recent hot" = the title released in the last 30 days AND has any 7d
      // estimate at all. Surfaces launches like Halloween: The Game (2026-09-08)
      // and How to Fish (2026-08-20) with a badge so the operator can see the
      // 7d chart is being driven by new releases rather than tenured titles.
      const recentHotThresholdIso = daysAgo(30);

      // Build the LEFT JOIN chain for the cascade. Each level pulls its own
      // latest as_of_date so a stale d7 row from last week doesn't win over a
      // fresh d30 row from today. Window strings are HARDCODED from the whitelist
      // above (never user input) so it's safe to interpolate directly.
      const cascadeJoins = cascade.map((w, i) => `
        LEFT JOIN window_estimates_daily w${i}
               ON w${i}.title_id = psm.title_id
              AND w${i}.platform = psm.platform
              AND w${i}.window = '${w}'
              AND w${i}.as_of_date = (SELECT MAX(as_of_date) FROM window_estimates_daily
                                        WHERE title_id = psm.title_id AND platform = psm.platform AND window = '${w}')
      `).join("\n");

      // COALESCE picks the first non-null level in cascade order. The parallel
      // CASE expression records which window actually produced the value so the
      // client can badge "est. via 30d" when 7d was empty.
      //
      // SQLite's COALESCE requires >=2 arguments; single-arg raises
      // "wrong number of arguments to function COALESCE()" and takes down the
      // whole leaderboard route. window=ltd has exactly one cascade level
      // (['ltd']), so emit the bare column expression in that case. All wider
      // windows still get real COALESCE.
      const cascadeCoalesce = (col: string): string =>
        cascade.length === 1
          ? `w0.${col}`
          : `COALESCE(${cascade.map((_, i) => `w${i}.${col}`).join(", ")})`;
      const cascadeUnits = cascadeCoalesce("units_mid");
      // Bind the ASP factor twice for revenue sort (once in ORDER BY IS NULL,
      // once in ORDER BY sortExpr) so the constant lands in both slots.
      const sortBinds = sort === "revenue" ? [aspFactor, aspFactor] : [];

      const cascadeWindowUsed = "CASE " + cascade.map((w, i) => `WHEN w${i}.units_mid IS NOT NULL THEN '${w}'`).join(" ") + " ELSE NULL END";
      // Method tag of the winning cascade level. The estimator writes
      // 'backfill-bootstrap' / 'backfill-steam-pace' / 'backfill-peer-ratio'
      // when a backfill source produced the value, otherwise it's the
      // multiplier's own method (e.g. 'v0-defaults'). Exposed so the UI can
      // badge rows that are running on inference vs. native/forward-delta.
      const cascadeMethod = "CASE " + cascade.map((_, i) => `WHEN w${i}.units_mid IS NOT NULL THEN w${i}.method`).join(" ") + " ELSE NULL END";

      // Recent-hot needs the STRICT 7d estimate, which is w0 only when the
      // requested window is d7. For wider requests we do a small correlated
      // EXISTS to check 7d explicitly.
      const recentHot7dTest = window === "d7"
        ? "w0.units_mid IS NOT NULL"
        : "EXISTS (SELECT 1 FROM window_estimates_daily w7d WHERE w7d.title_id = psm.title_id AND w7d.platform = psm.platform AND w7d.window = 'd7' AND w7d.units_mid IS NOT NULL)";

      // ── SKU display-name filter (bundles / DLC / PC-only Microsoft Store) ──
      // Applied at query time against IGDB canonical name OR store name fallback,
      // whichever the SELECT already resolves. Kept in one place so PS5 and Xbox
      // share the same exclusion vocabulary. Names are LOWER()'d for matching.
      //
      // DLC vocabulary — never real base games: 'season pass', ' season 1..6' (word-final),
      //   'episode 1..5', 'skin pack', '- 2008 movie ... skin', 'worlds part', '- aftermath',
      //   ': aftermath', 'character/weapon/map/mission/mythology pack', 'starter bundle'.
      // Bundle vocabulary — multi-title or paid-upgrade combos, NOT cross-gen base SKUs:
      //   'cross-gen bundle' (explicit Sony upgrade-path SKU, distinct from a game that
      //   happens to be labeled 'PS4 & PS5'), 'saga bundle', 'legacy bundle', 'collection
      //   bundle', 'complete bundle', 'trilogy bundle', 'legendary edition bundle',
      //   'anniversary bundle', and any '<X> + <Y> Bundle' combo.
      // PC-only (Xbox platform only): 'java & bedrock edition for pc' and its variants —
      //   Microsoft Store surfaces these under the same displaycatalog as Xbox games.
      //
      // Cross-gen base SKUs like 'Miles Morales PS4 & PS5' or 'DOOM Eternal PS4 & PS5'
      // are NOT filtered here: they are legitimate base games Sony sells from the PS5
      // store, and Push 2 will canonicalize them alongside any PS5-only twin SKU.
      const nameSourceExpr = `LOWER(COALESCE(NULLIF(igdb.name,''), NULLIF(igdb.store_name,''), psm.external_sku))`;
      const dlcBundleFilter = `
        AND ${nameSourceExpr} NOT LIKE '%season pass%'
        AND ${nameSourceExpr} NOT LIKE '% season 1'
        AND ${nameSourceExpr} NOT LIKE '% season 2'
        AND ${nameSourceExpr} NOT LIKE '% season 3'
        AND ${nameSourceExpr} NOT LIKE '% season 4'
        AND ${nameSourceExpr} NOT LIKE '% season 5'
        AND ${nameSourceExpr} NOT LIKE '% season 6'
        AND ${nameSourceExpr} NOT LIKE '%- season %'
        AND ${nameSourceExpr} NOT LIKE '%episode 1%'
        AND ${nameSourceExpr} NOT LIKE '%episode 2%'
        AND ${nameSourceExpr} NOT LIKE '%episode 3%'
        AND ${nameSourceExpr} NOT LIKE '%episode 4%'
        AND ${nameSourceExpr} NOT LIKE '%episode 5%'
        AND ${nameSourceExpr} NOT LIKE '%skin pack%'
        AND ${nameSourceExpr} NOT LIKE '% movie % skin%'
        AND ${nameSourceExpr} NOT LIKE '%worlds part%'
        AND ${nameSourceExpr} NOT LIKE '%- aftermath%'
        AND ${nameSourceExpr} NOT LIKE ': aftermath%'
        AND ${nameSourceExpr} NOT LIKE '%character pack%'
        AND ${nameSourceExpr} NOT LIKE '%weapon pack%'
        AND ${nameSourceExpr} NOT LIKE '%map pack%'
        AND ${nameSourceExpr} NOT LIKE '%mission pack%'
        AND ${nameSourceExpr} NOT LIKE '%mythology pack%'
        AND ${nameSourceExpr} NOT LIKE '%starter bundle%'
        AND ${nameSourceExpr} NOT LIKE '%cosmetic bundle%'
        AND ${nameSourceExpr} NOT LIKE '%color pack%'
        AND ${nameSourceExpr} NOT LIKE '%additional color%'
        AND ${nameSourceExpr} NOT LIKE '%cross-gen bundle%'
        AND ${nameSourceExpr} NOT LIKE '%saga bundle%'
        AND ${nameSourceExpr} NOT LIKE '%legacy bundle%'
        AND ${nameSourceExpr} NOT LIKE '%collection bundle%'
        AND ${nameSourceExpr} NOT LIKE '%complete bundle%'
        AND ${nameSourceExpr} NOT LIKE '%trilogy bundle%'
        AND ${nameSourceExpr} NOT LIKE '%legendary edition bundle%'
        AND ${nameSourceExpr} NOT LIKE '%anniversary bundle%'
        AND NOT (${nameSourceExpr} LIKE '% + %' AND ${nameSourceExpr} LIKE '%bundle%')
      `;
      // Xbox-only extra: filter Microsoft Store PC apps that leak into Xbox catalog.
      const pcOnlyFilter = platform === 'xbox' ? `
        AND ${nameSourceExpr} NOT LIKE '%java & bedrock edition for pc%'
        AND ${nameSourceExpr} NOT LIKE '%: java & bedrock%pc%'
        AND ${nameSourceExpr} NOT LIKE '%for windows 10%'
        AND ${nameSourceExpr} NOT LIKE '%for pc%'
      ` : '';

      // Cascade-cliff gate: reject rows whose earliest non-null cascade rung is
      // >1 step from the requested window. Without this gate a d7 request that
      // has no d7/d30/d90 signal falls all the way through to m12 or ltd, and
      // the UI badges 'EST. VIA M12' with a units number that is actually a
      // year- or lifetime-total masquerading as a 7-day quantity.
      //
      // Rule: only w0 (the requested window) and w1 (the next wider window)
      // are permitted contributors. If both are null, drop the row from this
      // window's leaderboard. Cascade fallback of one step (d7 → d30) is still
      // a badgeable approximation the operator understands; two-plus steps
      // (d7 → d90/m12/ltd) is actively misleading.
      //
      // For window='ltd' the whole cascade IS just ['ltd'] (length 1) and no
      // gate applies. For window='m12' cascade length is 2 (['m12','ltd']) and
      // the existing behavior is preserved — both rungs count.
      const gateToLtd = window !== 'ltd' && cascade.length >= 2;
      // The cliff filter admits any row where w0 OR w1 has a signal. For
      // cascades of length ≥ 3 this is tighter than the prior 'any pre-LTD
      // rung has signal' rule; for length 2 it collapses to the prior rule
      // (w0 OR w1 IS w0 OR w_last).
      const nearRungHasSignal = cascade.length >= 2
        ? `w0.units_mid IS NOT NULL OR w1.units_mid IS NOT NULL`
        : `w0.units_mid IS NOT NULL`;
      const cascadeUnitsGated = gateToLtd
        ? `CASE WHEN ${nearRungHasSignal} THEN ${cascadeCoalesce('units_mid')} ELSE NULL END`
        : cascadeCoalesce('units_mid');
      const cascadeOwnersGated = gateToLtd
        ? `CASE WHEN ${nearRungHasSignal} THEN ${cascadeCoalesce('owners_mid')} ELSE NULL END`
        : cascadeCoalesce('owners_mid');
      const cascadeWindowUsedGated = gateToLtd
        ? `CASE WHEN ${nearRungHasSignal} THEN (${cascadeWindowUsed}) ELSE NULL END`
        : cascadeWindowUsed;
      const gatedReasonExpr = gateToLtd
        ? `CASE WHEN ${nearRungHasSignal} THEN ${cascadeCoalesce('gated_reason')} ELSE 'cascade_cliff' END`
        : cascadeCoalesce('gated_reason');
      // Recompute the sort expression on the gated units so revenue/units sorts
      // treat a gated row as NULL (sinks to bottom) instead of using LTD units.
      const sortExprGated = sortExprFor(cascadeUnitsGated)[sort];

      // Grab latest daily rating snapshot per (title, platform). Only paid business_model.
      const rows = rawSqlite.prepare(`
        WITH latest_rating AS (
          SELECT title_id, platform, MAX(capture_date) AS max_date
            FROM store_rating_signal_daily
           WHERE platform = ?
           GROUP BY title_id, platform
        )
        SELECT
          psm.title_id                              AS titleId,
          psm.external_sku                          AS externalSku,
          psm.msrp_usd_cents                        AS msrpUsdCents,
          psm.business_model                        AS businessModel,
          -- Name / cover selection:
          --   Prefer IGDB's canonical name/cover when the match looks trustworthy.
          --   When match_confidence='low' (release-date sanity check flagged a
          --   mismatch during IGDB refresh) OR IGDB has no data yet, fall back
          --   to the storefront's name / header art. Those are preserved on
          --   console_title_igdb (store_name / store_header_image_url) by
          --   bootstrapConsoleTitleNames() and are never overwritten by the
          --   IGDB refresh path. This fixes cases like Steam appid 3219630
          --   ("Halloween: The Game") whose IGDB search happened to match
          --   "Solitaire Game Halloween 2".
          -- Xbox override (2026-09-12): xbox_title_cache is the source of
          -- truth for Xbox name/art, keyed by bigId (=psm.external_sku).
          -- Once landed there, name/art are immutable and never fall back
          -- to a numeric title_id render on the client. If xtc.name is
          -- NULL for an Xbox row, that row is filtered out below.
          CASE
            WHEN psm.platform = 'xbox' THEN xtc.name
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(NULLIF(igdb.store_name, ''), NULLIF(igdb.name, ''))
            ELSE COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, ''))
          END                                       AS name,
          CASE
            WHEN psm.platform = 'xbox' THEN xtc.art_url
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(NULLIF(igdb.store_header_image_url, ''), NULLIF(igdb.cover_url, ''))
            ELSE COALESCE(NULLIF(igdb.cover_url, ''), NULLIF(igdb.store_header_image_url, ''))
          END                                       AS coverUrl,
          -- Effective release date the isRecentHot flag and client badge read.
          -- When match_confidence='low' we know IGDB matched a different game
          -- (e.g. Solitaire Game Halloween 2 in place of Halloween: The Game),
          -- so its release_date is not trustworthy either — prefer the store's
          -- own date in that case. Otherwise prefer IGDB and fall back to the
          -- store's date only when IGDB is missing.
          CASE
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(igdb.store_release_date, igdb.release_date)
            ELSE COALESCE(igdb.release_date, igdb.store_release_date)
          END                                       AS releaseDate,
          -- nameSource lets the client badge each row.
          CASE
            WHEN igdb.match_confidence = 'low' THEN 'store'
            WHEN igdb.name IS NOT NULL AND igdb.name != '' THEN 'igdb'
            ELSE 'store'
          END                                       AS nameSource,
          igdb.match_confidence                     AS matchConfidence,
          srs.rating_count                          AS ratingCount,
          srs.avg_rating                            AS avgRating,
          -- Steam's native semantics are 'percent of ratings that are positive'
          -- (thumbs-up recommendations), NOT a 5-star mean. The collector rescales
          -- it to 0-5 as (up/total)*5 for cross-platform sortability, but that
          -- reads misleadingly on the UI: 70% recommended (which Steam labels
          -- 'Mixed') shows as 3.5/5, close to 'Positive' on a console-eye scale.
          --
          -- Expose the native percent alongside the 0-5 value and let the client
          -- render '87% · Very Positive' for Steam rows and keep '4.3' on PS5/Xbox.
          -- For non-Steam platforms these fields are null.
          --
          -- Percent is the exact inversion of the collector: avg_rating * 20.
          -- Label follows Steam's own bucket thresholds:
          --   >=95: Overwhelmingly Positive
          --   80-94: Very Positive
          --   70-79: Mostly Positive
          --   40-69: Mixed
          --   20-39: Mostly Negative
          --   0-19:  Overwhelmingly Negative
          CASE WHEN psm.platform = 'steam' AND srs.avg_rating IS NOT NULL
               THEN CAST(ROUND(srs.avg_rating * 20) AS INTEGER)
               ELSE NULL END                        AS avgRatingPercent,
          CASE WHEN psm.platform = 'steam' AND srs.avg_rating IS NOT NULL
               THEN CASE
                 WHEN srs.avg_rating * 20 >= 95 THEN 'Overwhelmingly Positive'
                 WHEN srs.avg_rating * 20 >= 80 THEN 'Very Positive'
                 WHEN srs.avg_rating * 20 >= 70 THEN 'Mostly Positive'
                 WHEN srs.avg_rating * 20 >= 40 THEN 'Mixed'
                 WHEN srs.avg_rating * 20 >= 20 THEN 'Mostly Negative'
                 ELSE 'Overwhelmingly Negative'
               END
               ELSE NULL END                        AS avgRatingLabel,
          srs.capture_date                          AS ratingCapturedAt,
          ${cascadeOwnersGated}                     AS ownersMid,
          ${cascadeUnitsGated}                      AS unitsMid,
          ${cascadeWindowUsedGated}                 AS windowUsed,
          ${cascadeMethod}                          AS estimateMethod,
          -- ASP (Average Selling Price) in USD cents = MSRP × platform ASP factor.
          -- Kept as an integer-cents value so the client formats it the same as MSRP.
          CAST(psm.msrp_usd_cents * ? AS INTEGER)   AS aspUsdCents,
          -- Estimated in-window revenue in USD dollars = cascaded units × ASP.
          -- ASP applies platform-specific realization (steam ~66%, consoles ~80%).
          (${cascadeUnitsGated} * psm.msrp_usd_cents * ? / 100.0) AS revenueMidUsd,
          ${gatedReasonExpr}                        AS gatedReason,
          -- Recent-hot flag = released in the last 30d AND has a real 7d estimate.
          -- Same confidence-aware date resolution as the releaseDate column: when
          -- IGDB matched the wrong game we prefer the store's own date, since
          -- IGDB's release_date would otherwise refer to a completely different
          -- game and hide a brand-new launch from the Recent hot badge.
          CASE WHEN (
                 CASE WHEN igdb.match_confidence = 'low'
                   THEN COALESCE(igdb.store_release_date, igdb.release_date)
                   ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                 END
               ) IS NOT NULL
                AND (
                 CASE WHEN igdb.match_confidence = 'low'
                   THEN COALESCE(igdb.store_release_date, igdb.release_date)
                   ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                 END
               ) >= ?
                AND ${recentHot7dTest}
               THEN 1 ELSE 0 END                    AS isRecentHot
        FROM platform_sku_map psm
        LEFT JOIN latest_rating lr
               ON lr.title_id = psm.title_id AND lr.platform = psm.platform
        LEFT JOIN store_rating_signal_daily srs
               ON srs.title_id = psm.title_id
              AND srs.platform = psm.platform
              AND srs.capture_date = lr.max_date
        LEFT JOIN console_title_igdb igdb
               ON igdb.title_id = psm.title_id
        -- Xbox source-of-truth cache (2026-09-12): immutable name/art per bigId.
        -- LEFT JOIN so non-Xbox rows are unaffected; the CASE in the select list
        -- gates on psm.platform='xbox' before reading xtc columns.
        LEFT JOIN xbox_title_cache xtc
               ON psm.platform = 'xbox' AND xtc.big_id = psm.external_sku
        ${cascadeJoins}
       WHERE psm.platform = ?
         AND psm.business_model = 'paid'
         AND psm.sku_role = 'base'
         -- Xbox integrity gate (2026-09-12): a paid Xbox row with no
         -- xbox_title_cache entry NEVER appears on the leaderboard. The
         -- bigId is instead sitting in xbox_bigid_retry_queue; it will
         -- appear as soon as one of the 3 resolvers lands its name/art.
         -- This is what prevents 12-char bigIds from ever rendering in
         -- place of a real title.
         AND (psm.platform <> 'xbox' OR xtc.name IS NOT NULL)
         ${dlcBundleFilter}
         ${pcOnlyFilter}
       -- NULL sort values sink so the client still gets a full 100 rows even
       -- before the estimator has populated every window. rating_count is a
       -- stable-sort tie-breaker for every sort mode.
       -- Recent-hot titles get a small tie-breaker bump so a Sep-8 launch
       -- with the same revenue as a tenured title still lands above it in
       -- the 7d view.
       ORDER BY (${sortExprGated} IS NULL) ASC,
                ${sortExprGated} ${dirSql},
                (CASE WHEN (
                   CASE WHEN igdb.match_confidence = 'low'
                     THEN COALESCE(igdb.store_release_date, igdb.release_date)
                     ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                   END
                 ) >= ? THEN 1 ELSE 0 END) DESC,
                COALESCE(srs.rating_count, 0) DESC
       -- LIMIT raised from 100 → 250 (Change 10, Push 2). Edition rollup collapses
       -- SKU variants below in JS; we need enough headroom that a family with
       -- 3+ editions (e.g. NHL 27 Deluxe + Standard, EA FC 27 Ultimate + Standard)
       -- still leaves 100 unique game families on the client. 250 is a safe
       -- overshoot: current top-100 has ~10–15 edition-collapsed rows, worst-case
       -- ~2× blowup, so 250 rows in guarantees ≥100 groups out.
       LIMIT 250
      `).all(
        platform,               // 1: latest_rating CTE WHERE platform = ?
        aspFactor,              // 2: SELECT aspUsdCents CAST(msrp * ? AS INTEGER)
        aspFactor,              // 3: SELECT revenueMidUsd = units * msrp * ? / 100
        recentHotThresholdIso,  // 4: isRecentHot release_date >= ?
        platform,               // 5: outer WHERE psm.platform = ?
        ...sortBinds,           // 6,7: ORDER BY sortExpr contains one ? per use (twice when sort=revenue)
        recentHotThresholdIso,  // last: ORDER BY recent-hot tie-breaker release_date >= ?
      ) as Array<Record<string, any>>;

      // ── Edition rollup (Change 10, Push 2) ─────────────────────────────────
      // Group SKU variants of the same game family within this platform. We
      // fetched 250 rows above; group them by editionGroupKey(name) so that
      // "NBA 2K27" and "NBA 2K27 Deluxe" collapse into one leaderboard row.
      //
      // Rules:
      //   • Display row = the group's highest-revenue member (with unitsMid /
      //     revenueMidUsd fallback so a row that gated to NULL revenue never
      //     wins over a real one).
      //   • revenueMidUsd, unitsMid = SUM across all members of the group.
      //     Rollup treats sibling editions as additive sales, which is the
      //     evidence-bound assumption: they are separate SKUs that sold
      //     separately, and the operator wants total franchise revenue in the
      //     window, not the largest edition's revenue.
      //   • editionCount = number of collapsed siblings (0 if standalone).
      //   • editionTitles = list of grouped display names (for tooltip / "+N
      //     editions" badge on the client).
      //   • Grouping only happens when the key is non-empty AND at least one
      //     of the members carries a real name from IGDB/store — external_sku
      //     fallbacks (raw storefront IDs) never group with anything, since
      //     those keys are noisy and would risk cross-family collisions.
      //
      // Ordering after grouping is preserved from the SQL ORDER BY because we
      // walk the input rows in order and record each group's first-appearance
      // slot as its rank. That keeps sort=revenue / sort=score / etc. stable
      // without a second sort pass.
      type Row = Record<string, any>;
      const groups: Row[] = [];
      const byKey = new Map<string, Row>();
      for (const r of rows) {
        const rawName = (r.name ?? "") as string;
        const key = editionGroupKey(rawName);
        // Fall back to title_id-anchored key when name normalization yields
        // empty (external_sku fallbacks, unicode-only names). This keeps the
        // row in the output but prevents it from grouping with anything else.
        const groupKey = key.length >= 2 ? `k:${key}` : `t:${r.titleId ?? Math.random()}`;
        const existing = byKey.get(groupKey);
        if (!existing) {
          const initial: Row = {
            ...r,
            editionCount: 0,
            editionTitles: [rawName],
            editionGroupKey: key,
          };
          byKey.set(groupKey, initial);
          groups.push(initial);
          continue;
        }
        // Sum window-derived quantities. Missing/NULL is treated as 0 for the
        // SUM but preserved on the display row when nothing has a value.
        const rRev = typeof r.revenueMidUsd === "number" ? r.revenueMidUsd : 0;
        const rUnits = typeof r.unitsMid === "number" ? r.unitsMid : 0;
        const eRev = typeof existing.revenueMidUsd === "number" ? existing.revenueMidUsd : 0;
        const eUnits = typeof existing.unitsMid === "number" ? existing.unitsMid : 0;
        // If the incoming row's revenue is higher than the current display,
        // promote it to the display row (keep its metadata: title, releaseDate,
        // avgRating, coverUrl, etc.) but carry the accumulated sums forward.
        if (rRev > eRev) {
          const bumped: Row = {
            ...r,
            revenueMidUsd: rRev + eRev,
            unitsMid: rUnits + eUnits,
            editionCount: existing.editionCount + 1,
            editionTitles: [...existing.editionTitles, rawName],
            editionGroupKey: key,
          };
          byKey.set(groupKey, bumped);
          // Replace in the ordered array at the same slot.
          const idx = groups.indexOf(existing);
          if (idx >= 0) groups[idx] = bumped;
        } else {
          existing.revenueMidUsd = eRev + rRev || null;
          existing.unitsMid = eUnits + rUnits || null;
          existing.editionCount += 1;
          existing.editionTitles.push(rawName);
        }
      }
      // ── Path A: Steam anchor overlay (Steam platform only) ─────────────
      // For any group whose (titleId, 'steam', window) matches a row in
      // revenue_calibration_anchors for the most recent as_of_date, swap the
      // estimator revenue for the anchor's actual_revenue_usd and tag
      // dataSource='actual'. Units stay estimated on purpose — during active
      // sales the units count is inflated relative to the estimator's ASP
      // model, so replacing units with actual would mis-represent the
      // per-unit economics; only the revenue side is trustworthy for a
      // sale-active window. See lessons.md 2026-09-12 anchor entry.
      //
      // ── Path B: Platform revenue-ratio derivation (PS5 / Xbox) ─────────
      // Immutable platform revenue mix + per-IP overrides live at MODULE
      // scope so the multiplatform endpoint can reuse them; see the
      // PLATFORM_RATIO_VS_STEAM, IP_OVERRIDE_RULES, and ipOverrideFactorFor
      // definitions near the top of this file. Do not fork.
      //
      // For every PS5 / Xbox group whose editionGroupKey ALSO has a Steam
      // SKU in platform_sku_map (cross-platform title), the console revenue
      // is DERIVED from Steam revenue for the same window, not computed
      // independently. Steam revenue used as the anchor is, in preference:
      //   1. Steam's anchor row (actual_revenue_usd) if one exists.
      //   2. Steam's live estimator revenue = cascaded units_mid ×
      //      msrp_usd_cents × steam_asp_factor / 100.
      //
      // Console-exclusive titles (no Steam SKU under the same key) fall
      // through to the SQL-computed revenue unchanged.
      try {
        const win = window;

        // Latest anchor per titleId for THIS platform+window (used for
        // Path A on Steam AND for the LTD-preserved exception on
        // PS5/Xbox anchored titles).
        const anchorRows = rawSqlite.prepare(`
          SELECT title_id, actual_revenue_usd, sale_state, as_of_date
            FROM revenue_calibration_anchors
           WHERE platform = ? AND window = ?
             AND (title_id, as_of_date) IN (
                 SELECT title_id, MAX(as_of_date)
                   FROM revenue_calibration_anchors
                  WHERE platform = ? AND window = ?
                  GROUP BY title_id
             )
        `).all(platform, win, platform, win) as Array<{title_id:number; actual_revenue_usd:number; sale_state:string; as_of_date:string}>;
        const anchorMap = new Map<number, {actual_revenue_usd:number; sale_state:string; as_of_date:string}>();
        for (const a of anchorRows) anchorMap.set(a.title_id, a);

        let pathAOverlaid = 0;
        let pathBDerived = 0;
        let pathBSkippedNoSteam = 0;
        let ipOverridesApplied = 0;

        // Only build Steam-side revenue lookups when we're serving a
        // console leaderboard that needs Path B.
        const consoleRatio = PLATFORM_RATIO_VS_STEAM[platform];

        // Steam revenue keyed by editionGroupKey(name), NOT by title_id.
        // Reason: title_id is per-platform in platform_sku_map. Steam's
        // "Marvel's Spider-Man 2" has one title_id, PS5's has another.
        // The only reliable cross-platform join key is the normalized
        // display name (same helper the client uses to collapse editions
        // within a platform). This is the fix for Path B silently missing
        // every cross-platform title.
        const steamRevenueByKey = new Map<string, {revenue:number; source:"anchor"|"estimator"}>();
        // Console group keys we need Steam revenue for.
        const groupKeysNeeded = new Set<string>();
        for (const g of groups) {
          const k = (g.editionGroupKey as string | undefined) ?? "";
          if (k.length >= 2) groupKeysNeeded.add(k);
        }

        if (consoleRatio != null && groupKeysNeeded.size > 0) {
          // Discover every Steam base SKU whose editionGroupKey is one of
          // the keys we need. We fetch all Steam base SKUs and filter in
          // JS because SQLite has no way to run editionGroupKey().
          const allSteamSkus = rawSqlite.prepare(`
            SELECT psm.title_id AS titleId,
                   CASE
                     WHEN igdb.match_confidence = 'low'
                       THEN COALESCE(NULLIF(igdb.store_name,''), NULLIF(igdb.name,''))
                     ELSE COALESCE(NULLIF(igdb.name,''), NULLIF(igdb.store_name,''))
                   END AS name,
                   psm.msrp_usd_cents AS msrpUsdCents
              FROM platform_sku_map psm
              LEFT JOIN console_title_igdb igdb ON igdb.title_id = psm.title_id
             WHERE psm.platform = 'steam'
               AND psm.business_model = 'paid'
               AND psm.sku_role = 'base'
               AND psm.msrp_usd_cents IS NOT NULL
               AND psm.msrp_usd_cents > 0
          `).all() as Array<{titleId:number; name:string|null; msrpUsdCents:number}>;
          // Map: editionGroupKey -> [{titleId, msrpUsdCents}]
          const steamSkusByKey = new Map<string, Array<{titleId:number; msrpUsdCents:number}>>();
          for (const s of allSteamSkus) {
            const k = editionGroupKey(s.name);
            if (k.length < 2 || !groupKeysNeeded.has(k)) continue;
            const arr = steamSkusByKey.get(k) ?? [];
            arr.push({ titleId: s.titleId, msrpUsdCents: s.msrpUsdCents });
            steamSkusByKey.set(k, arr);
          }

          // Collect the union of Steam title_ids that matter, for one
          // batched anchor + estimator lookup.
          const steamTitleIds: number[] = [];
          const steamTitleIdToKey = new Map<number, string>();
          steamSkusByKey.forEach((list, k) => {
            for (const s of list) {
              steamTitleIds.push(s.titleId);
              steamTitleIdToKey.set(s.titleId, k);
            }
          });

          if (steamTitleIds.length > 0) {
            const placeholders = steamTitleIds.map(() => "?").join(",");

            // Steam anchors first (authoritative). Aggregate SUM by key.
            const steamAnchors = rawSqlite.prepare(`
              SELECT title_id, actual_revenue_usd
                FROM revenue_calibration_anchors
               WHERE platform = 'steam' AND window = ?
                 AND title_id IN (${placeholders})
                 AND (title_id, as_of_date) IN (
                     SELECT title_id, MAX(as_of_date)
                       FROM revenue_calibration_anchors
                      WHERE platform = 'steam' AND window = ?
                        AND title_id IN (${placeholders})
                      GROUP BY title_id
                 )
            `).all(win, ...steamTitleIds, win, ...steamTitleIds) as Array<{title_id:number; actual_revenue_usd:number}>;
            const anchoredKeys = new Set<string>();
            for (const r of steamAnchors) {
              const k = steamTitleIdToKey.get(r.title_id);
              if (!k) continue;
              const prev = steamRevenueByKey.get(k);
              const nextRev = (prev?.revenue ?? 0) + r.actual_revenue_usd;
              steamRevenueByKey.set(k, { revenue: nextRev, source: "anchor" });
              anchoredKeys.add(k);
            }

            // Steam estimator revenue for keys we didn't find an anchor for.
            // Aggregates across every Steam base SKU per title_id, then we
            // sum by editionGroupKey below.
            const needEstimatorTitleIds = steamTitleIds.filter(tid => {
              const k = steamTitleIdToKey.get(tid);
              return k != null && !anchoredKeys.has(k);
            });
            if (needEstimatorTitleIds.length > 0) {
              const steamAspFactor = aspFactorFor("steam");
              const ph2 = needEstimatorTitleIds.map(() => "?").join(",");
              const steamCascadeJoins = cascade.map((w, i) => `
                LEFT JOIN window_estimates_daily w${i}
                       ON w${i}.title_id = psm.title_id
                      AND w${i}.platform = 'steam'
                      AND w${i}.window = '${w}'
                      AND w${i}.as_of_date = (SELECT MAX(as_of_date) FROM window_estimates_daily
                                                WHERE title_id = psm.title_id AND platform='steam' AND window = '${w}')
              `).join("\n");
              const steamCascadeUnits = cascade.length === 1
                ? `w0.units_mid`
                : `COALESCE(${cascade.map((_, i) => `w${i}.units_mid`).join(", ")})`;
              const steamCascadeGated = cascade.length >= 2 && window !== "ltd"
                ? `CASE WHEN (w0.units_mid IS NOT NULL OR w1.units_mid IS NOT NULL) THEN ${steamCascadeUnits} ELSE NULL END`
                : steamCascadeUnits;
              const steamRows = rawSqlite.prepare(`
                SELECT psm.title_id AS titleId,
                       SUM(
                         COALESCE(
                           (${steamCascadeGated}) * psm.msrp_usd_cents * ? / 100.0,
                           0
                         )
                       ) AS steamRevenue
                  FROM platform_sku_map psm
                  ${steamCascadeJoins}
                 WHERE psm.platform = 'steam'
                   AND psm.business_model = 'paid'
                   AND psm.sku_role = 'base'
                   AND psm.msrp_usd_cents IS NOT NULL
                   AND psm.msrp_usd_cents > 0
                   AND psm.title_id IN (${ph2})
                 GROUP BY psm.title_id
                HAVING SUM(COALESCE((${steamCascadeGated}) * psm.msrp_usd_cents, 0)) > 0
              `).all(steamAspFactor, ...needEstimatorTitleIds) as Array<{titleId:number; steamRevenue:number}>;
              // Sum estimator revenue by editionGroupKey.
              for (const r of steamRows) {
                if (r.steamRevenue <= 0) continue;
                const k = steamTitleIdToKey.get(r.titleId);
                if (!k) continue;
                const prev = steamRevenueByKey.get(k);
                if (prev && prev.source === "anchor") continue; // anchor wins
                const nextRev = (prev?.revenue ?? 0) + r.steamRevenue;
                steamRevenueByKey.set(k, { revenue: nextRev, source: "estimator" });
              }
            }
          }
        }

        for (const g of groups) {
          // Path A precedence:
          //   * Steam platform: always wins. Steam anchors are the whole
          //     point of the calibration pipeline (portal_fetch actuals).
          //   * PS5/Xbox platform: Path A NEVER wins today. Every PS5/Xbox
          //     anchor currently in revenue_calibration_anchors was written
          //     by the anchor writer FROM the estimator (there is no
          //     verified-console-LTD source yet). Letting them win would
          //     re-inflate exactly the Game-Pass/rating-driven distortions
          //     the platform revenue ratio is meant to correct (Minecraft
          //     Xbox LTD = \$1.5B is the canonical failure). When a real
          //     verified-console-LTD source lands, gate this on that
          //     source flag instead of the platform.
          const a = anchorMap.get(g.titleId);
          const anchorWins = a && platform === "steam";
          if (anchorWins && a) {
            g.revenueMidUsdEstimated = g.revenueMidUsd;
            g.revenueMidUsd = a.actual_revenue_usd;
            g.dataSource = "actual";
            g.anchorSaleState = a.sale_state;
            g.anchorAsOfDate = a.as_of_date;
            pathAOverlaid++;
            continue;
          }
          // Path B: derive PS5/Xbox windowed revenue from Steam via ratio,
          // then back-compute units from that derived revenue so units and
          // revenue stay internally consistent.
          //
          // Revenue derivation: derived_revenue = steam_revenue × factor.
          //   factor = per-IP override if the title matches an IP rule
          //            (e.g. NBA 2K, Madden NFL, EA Sports FC, EA Sports
          //            College Football — PS5 = Steam × 6.5, Xbox = Steam
          //            × 2.5); otherwise consoleRatio (the general
          //            immutable mix).
          // Unit derivation:    derived_units = derived_revenue / (asp_usd_cents / 100).
          //
          // If we left units at the estimator's independent output the row
          // would show a revenue and a units count whose implied ASP diverges
          // from the platform's actual ASP — unfixable without either
          // recomputing revenue (breaks the immutable ratio) or recomputing
          // units (this branch). We recompute units.
          //
          // aspUsdCents may be null when MSRP is missing; in that case we
          // preserve the estimator units rather than write a bad number.
          if (consoleRatio != null) {
            const gk = (g.editionGroupKey as string | undefined) ?? "";
            const s = gk.length >= 2 ? steamRevenueByKey.get(gk) : undefined;
            // Steam-anchored derivation requires a MEANINGFUL Steam revenue.
            // PS5-exclusive Sony IPs (e.g. Gran Turismo 7) have no Steam SKU
            // at all -> s is undefined -> we fall through to
            // 'estimated_console_exclusive' and keep the raw PS5 estimator.
            // Also fall through when a Steam SKU exists but reports \$0 for
            // this window (e.g. a delisted PC port), because Steam × factor
            // = 0 would zero out an otherwise-real console row.
            const hasMeaningfulSteam = s != null && s.revenue >= 1000; // \$1k threshold
            if (hasMeaningfulSteam && s) {
              const ipOverride = ipOverrideFactorFor(g.name as string | null | undefined, platform);
              const factor = ipOverride ? ipOverride.factor : consoleRatio;
              const derivedRevenue = s.revenue * factor;
              g.revenueMidUsdEstimated = g.revenueMidUsd;
              g.revenueMidUsd = derivedRevenue;
              g.unitsMidEstimated = g.unitsMid;
              const aspCents = typeof g.aspUsdCents === "number" ? g.aspUsdCents : null;
              if (aspCents != null && aspCents > 0) {
                g.unitsMid = Math.round(derivedRevenue / (aspCents / 100));
              }
              g.dataSource = ipOverride ? "derived_from_steam_ip_override" : "derived_from_steam";
              g.derivationRatio = factor;
              g.derivationSteamSource = s.source; // 'anchor' | 'estimator'
              if (ipOverride) { g.derivationIpOverride = ipOverride.label; ipOverridesApplied++; }
              pathBDerived++;
              continue;
            }
            // Console exclusive (no Steam SKU family matched by name): keep
            // the SQL-computed revenue AND units unchanged.
            g.dataSource = "estimated_console_exclusive";
            pathBSkippedNoSteam++;
            continue;
          }
          // Steam platform, no anchor: unchanged.
          g.dataSource = "estimated";
        }

        // Re-sort groups by whichever sort key the client asked for so the
        // overlay/derivation doesn't leave rows in visually-wrong positions.
        // Only re-sort when sort is revenue-based; other sorts (score,
        // ratings, asp, units) operate on fields these paths don't touch.
        if (sort === "revenue") {
          groups.sort((a, b) => {
            const av = typeof a.revenueMidUsd === "number" ? a.revenueMidUsd : -1;
            const bv = typeof b.revenueMidUsd === "number" ? b.revenueMidUsd : -1;
            return dir === "asc" ? av - bv : bv - av;
          });
        }

        if (pathAOverlaid > 0 || pathBDerived > 0) {
          console.log(`[leaderboard-overlay] platform=${platform} window=${win} pathA=${pathAOverlaid} pathB=${pathBDerived} ipOverrides=${ipOverridesApplied} pathBSkippedNoSteam=${pathBSkippedNoSteam} groups=${groups.length}`);
        }
      } catch (overlayErr: any) {
        // Overlay is optional — never fail the leaderboard because of it.
        console.log(`[leaderboard-overlay] skipped (${overlayErr?.message ?? overlayErr}); returning estimates`);
      }

      // Trim to top-100 groups. The input SQL was ordered, group order was
      // preserved, so groups[0..99] is the final leaderboard.
      const collapsed = groups.slice(0, 100);

      res.json({ platform, window, sort, dir, aspFactor, cascade, count: collapsed.length, titles: collapsed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Multiplatform leaderboard (top-20 combined-revenue) ────────────
  //
  // Ranks titles that ship on Steam AND at least one of {PS5, Xbox}, by
  // combined revenue across the platforms that have a base SKU. Uses the
  // SAME immutable ratio + IP override + PS5-exclusive fallback overlay as
  // the per-platform boards, so a title's per-platform revenue here always
  // matches what appears in its Steam / PS5 / Xbox column.
  //
  // Query: window=d7|d30|d90|m12|ltd  (default d7)
  //        limit=1..20                 (default 20)
  //
  // Response: { window, count, titles: MultiplatformRow[] } where
  //   MultiplatformRow = {
  //     editionGroupKey,
  //     name, coverUrl, releaseDate,
  //     steamTitleId, ps5TitleId?, xboxTitleId?,
  //     platforms: ("steam"|"ps5"|"xbox")[],  // in Steam,PS5,Xbox order
  //     revenueSteam, revenuePs5, revenueXbox,
  //     revenueCombined,
  //     revenueSource: "overlay-ratio" | "overlay-ip-override" | "ps5-exclusive-fallback" | "mixed",
  //   }
  //
  // Ranking key: revenueCombined desc.
  // Path: /api/console/leaderboards-multiplatform  (matches per-platform prefix).
  app.get("/api/console/leaderboards-multiplatform", (req, res) => {
    try {
      const window = ((req.query.window as string) || "d7").toLowerCase();
      if (!["d7","d30","d90","m12","ltd"].includes(window)) return res.status(400).json({ error: "invalid window" });
      const limit = Math.min(20, Math.max(1, parseInt((req.query.limit as string) || "20", 10) || 20));

      const steamAspFactor = aspFactorFor("steam");
      const ps5AspFactor   = aspFactorFor("ps5");
      const xboxAspFactor  = aspFactorFor("xbox");

      // Cascade order matches the per-platform handler.
      const CASCADE = ["d7","d30","d90","m12","ltd"] as const;
      const cascade = CASCADE.slice(CASCADE.indexOf(window as any));

      // Fetch every paid base SKU across the three platforms with the
      // metadata we need for edition rollup, IGDB display, and revenue math.
      // We cascade window_estimates_daily within SQL via LEFT JOINs so a
      // single-window miss doesn't drop a title.
      //
      // Cascade selection expression is materialised in JS so we can reuse
      // the same cascade order as the per-platform overlay without a giant
      // parameterised CASE.
      const cascadeUnitsExpr = cascade
        .map((w, i) => `w${i}.units_mid`)
        .reduce((acc, e) => `COALESCE(${acc}, ${e})`);
      const cascadeWindowExpr = cascade
        .map((w, i) => `CASE WHEN w${i}.units_mid IS NOT NULL THEN '${w}' END`)
        .reduce((acc, e) => `COALESCE(${acc}, ${e})`);
      const cascadeJoins = cascade
        .map((w, i) => `LEFT JOIN window_estimates_daily w${i}\n          ON w${i}.title_id = psm.title_id\n         AND w${i}.platform = psm.platform\n         AND w${i}.window   = '${w}'\n         AND w${i}.as_of_date = (\n              SELECT MAX(as_of_date) FROM window_estimates_daily\n               WHERE title_id = psm.title_id AND platform = psm.platform AND window = '${w}'\n             )`)
        .join("\n        ");

      const rows = rawSqlite.prepare(`
        SELECT
          psm.title_id                                    AS titleId,
          psm.platform                                    AS platform,
          psm.msrp_usd_cents                              AS msrpUsdCents,
          CASE
            WHEN psm.platform = 'xbox' THEN xtc.name
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(NULLIF(igdb.store_name, ''), NULLIF(igdb.name, ''))
            ELSE COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, ''))
          END                                             AS name,
          CASE
            WHEN psm.platform = 'xbox' THEN xtc.art_url
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(NULLIF(igdb.store_header_image_url, ''), NULLIF(igdb.cover_url, ''))
            ELSE COALESCE(NULLIF(igdb.cover_url, ''), NULLIF(igdb.store_header_image_url, ''))
          END                                             AS coverUrl,
          igdb.release_date                               AS releaseDate,
          ${cascadeUnitsExpr}                             AS unitsMid,
          ${cascadeWindowExpr}                            AS windowUsed
        FROM platform_sku_map psm
        LEFT JOIN console_title_igdb igdb ON igdb.title_id = psm.title_id
        LEFT JOIN xbox_title_cache  xtc  ON xtc.title_id  = psm.title_id AND psm.platform = 'xbox'
        ${cascadeJoins}
        WHERE psm.platform IN ('steam','ps5','xbox')
          AND psm.business_model = 'paid'
          AND psm.sku_role = 'base'
      `).all() as Array<{
        titleId: number;
        platform: Platform;
        msrpUsdCents: number | null;
        name: string | null;
        coverUrl: string | null;
        releaseDate: string | null;
        unitsMid: number | null;
        windowUsed: string | null;
      }>;

      // Latest anchor per (title_id, platform, window) for the requested window.
      const anchorRows = rawSqlite.prepare(`
        SELECT rca.title_id AS titleId, rca.platform AS platform, rca.actual_revenue_usd AS revenue
        FROM revenue_calibration_anchors rca
        JOIN (
          SELECT title_id, platform, MAX(as_of_date) AS mx
          FROM revenue_calibration_anchors
          WHERE window = ? AND platform IN ('steam','ps5','xbox')
          GROUP BY title_id, platform
        ) latest
          ON latest.title_id = rca.title_id AND latest.platform = rca.platform
         AND latest.mx = rca.as_of_date
        WHERE rca.window = ?
      `).all(window, window) as Array<{ titleId: number; platform: Platform; revenue: number }>;
      const anchorByTitleIdPlatform = new Map<string, number>();
      for (const a of anchorRows) anchorByTitleIdPlatform.set(`${a.titleId}|${a.platform}`, a.revenue);

      // Roll up per-platform SKUs by editionGroupKey. Sum unit-derived and
      // anchor revenues at the SKU level, then aggregate to a per-key,
      // per-platform revenue value that mirrors what the per-platform
      // handler computes group-wise.
      type PerPlatformAgg = {
        titleId: number;                 // primary SKU (highest revenue)
        name: string | null;
        coverUrl: string | null;
        releaseDate: string | null;
        rawRevenueUsd: number;           // pre-overlay (SKU-native)
        anchoredRevenueUsd: number | null; // sum of anchors across SKUs in this key, if any
      };
      const perKeyPerPlatform = new Map<string, Partial<Record<Platform, PerPlatformAgg>>>();
      let filteredMissingSteam = 0;

      for (const r of rows) {
        const key = editionGroupKey(r.name);
        if (!key) continue;

        // Xbox rows without a resolved name/cover are still filtered off
        // the leaderboard (same rule as the per-platform handler).
        if (r.platform === "xbox" && (!r.name || !r.coverUrl)) { filteredMissingSteam++; continue; }

        const aspFactor = r.platform === "steam" ? steamAspFactor : r.platform === "ps5" ? ps5AspFactor : xboxAspFactor;
        const skuRawRevenue = (r.unitsMid != null && r.msrpUsdCents != null)
          ? r.unitsMid * r.msrpUsdCents * aspFactor / 100
          : 0;
        const anchor = anchorByTitleIdPlatform.get(`${r.titleId}|${r.platform}`) ?? null;

        const bucket = perKeyPerPlatform.get(key) ?? {};
        const prev = bucket[r.platform];
        if (!prev) {
          bucket[r.platform] = {
            titleId: r.titleId,
            name: r.name,
            coverUrl: r.coverUrl,
            releaseDate: r.releaseDate,
            rawRevenueUsd: skuRawRevenue,
            anchoredRevenueUsd: anchor,
          };
        } else {
          // Multiple SKUs in the same edition family for the same platform
          // (e.g. NBA 2K27 base + Deluxe on PS5). Sum revenues; keep the
          // metadata from the higher-revenue SKU so the badge picks the
          // canonical listing.
          prev.rawRevenueUsd += skuRawRevenue;
          if (anchor != null) prev.anchoredRevenueUsd = (prev.anchoredRevenueUsd ?? 0) + anchor;
          if (skuRawRevenue > (perKeyPerPlatform.get(key)?.[r.platform]?.rawRevenueUsd ?? 0)) {
            prev.titleId = r.titleId;
            prev.name = r.name ?? prev.name;
            prev.coverUrl = r.coverUrl ?? prev.coverUrl;
            prev.releaseDate = r.releaseDate ?? prev.releaseDate;
          }
        }
        perKeyPerPlatform.set(key, bucket);
      }

      // Build multiplatform rows. Cross-platform gate: MUST have Steam + at
      // least one of {PS5, Xbox}.
      type MultiRow = {
        editionGroupKey: string;
        name: string; coverUrl: string | null; releaseDate: string | null;
        steamTitleId: number; ps5TitleId?: number; xboxTitleId?: number;
        platforms: Platform[];
        revenueSteam: number; revenuePs5: number; revenueXbox: number;
        revenueCombined: number;
        revenueSource: "overlay-ratio" | "overlay-ip-override" | "ps5-exclusive-fallback" | "mixed";
      };
      const multiRows: MultiRow[] = [];
      let overlayRatioCount = 0, overlayIpCount = 0, exclusiveFallbackCount = 0;

      for (const [key, byPlatform] of Array.from(perKeyPerPlatform.entries())) {
        const steam = byPlatform.steam;
        const ps5   = byPlatform.ps5;
        const xbox  = byPlatform.xbox;
        if (!steam) continue;                            // must be on Steam
        if (!ps5 && !xbox) continue;                     // and at least one console

        // Steam revenue: anchor wins over estimator.
        const steamRevenue = steam.anchoredRevenueUsd != null ? steam.anchoredRevenueUsd : steam.rawRevenueUsd;
        const hasMeaningfulSteam = steamRevenue >= STEAM_MEANINGFUL_REVENUE_FLOOR_USD;

        // Choose a canonical display name for IP-override matching (Steam
        // first — IGDB-cleanest source — falling back to console name).
        const displayName = steam.name || ps5?.name || xbox?.name || null;
        const ipOverridePs5  = ps5  ? ipOverrideFactorFor(displayName, "ps5")  : null;
        const ipOverrideXbox = xbox ? ipOverrideFactorFor(displayName, "xbox") : null;
        const usedIpOverride = Boolean(ipOverridePs5 || ipOverrideXbox);

        // Console revenue derivation. Anchor for that console+window wins
        // absolutely (Path A). Otherwise Path B: overlay from Steam; if the
        // Steam signal is not meaningful, fall back to that console's raw
        // estimator revenue (PS5-exclusive fallback covers this).
        let revenuePs5 = 0;
        let revenueXbox = 0;
        let usedFallback = false;

        if (ps5) {
          if (ps5.anchoredRevenueUsd != null) {
            revenuePs5 = ps5.anchoredRevenueUsd;
          } else if (hasMeaningfulSteam) {
            const factor = ipOverridePs5 ? ipOverridePs5.factor : (PLATFORM_RATIO_VS_STEAM.ps5 as number);
            revenuePs5 = steamRevenue * factor;
          } else {
            revenuePs5 = ps5.rawRevenueUsd;
            usedFallback = true;
          }
        }
        if (xbox) {
          if (xbox.anchoredRevenueUsd != null) {
            revenueXbox = xbox.anchoredRevenueUsd;
          } else if (hasMeaningfulSteam) {
            const factor = ipOverrideXbox ? ipOverrideXbox.factor : (PLATFORM_RATIO_VS_STEAM.xbox as number);
            revenueXbox = steamRevenue * factor;
          } else {
            revenueXbox = xbox.rawRevenueUsd;
            usedFallback = true;
          }
        }

        const revenueCombined = steamRevenue + revenuePs5 + revenueXbox;
        if (revenueCombined <= 0) continue; // no signal on any platform

        // Track source category for observability.
        let revenueSource: MultiRow["revenueSource"];
        const flags = [usedIpOverride, usedFallback];
        if (usedFallback && usedIpOverride) revenueSource = "mixed";
        else if (usedIpOverride)             revenueSource = "overlay-ip-override";
        else if (usedFallback)               revenueSource = "ps5-exclusive-fallback";
        else                                 revenueSource = "overlay-ratio";
        void flags;
        if (revenueSource === "overlay-ratio") overlayRatioCount++;
        else if (revenueSource === "overlay-ip-override") overlayIpCount++;
        else if (revenueSource === "ps5-exclusive-fallback") exclusiveFallbackCount++;

        const platforms: Platform[] = [];
        if (steam) platforms.push("steam");
        if (ps5)   platforms.push("ps5");
        if (xbox)  platforms.push("xbox");

        multiRows.push({
          editionGroupKey: key,
          name: (steam.name || ps5?.name || xbox?.name || key) as string,
          coverUrl: steam.coverUrl || ps5?.coverUrl || xbox?.coverUrl || null,
          releaseDate: steam.releaseDate || ps5?.releaseDate || xbox?.releaseDate || null,
          steamTitleId: steam.titleId,
          ps5TitleId:  ps5?.titleId,
          xboxTitleId: xbox?.titleId,
          platforms,
          revenueSteam: steamRevenue,
          revenuePs5:   revenuePs5,
          revenueXbox:  revenueXbox,
          revenueCombined,
          revenueSource,
        });
      }

      multiRows.sort((a, b) => b.revenueCombined - a.revenueCombined);
      const trimmed = multiRows.slice(0, limit);

      // Observability log line, mirrors the per-platform overlay log style.
      console.log(`[multiplatform-leaderboard] window=${window} candidates=${multiRows.length} returned=${trimmed.length} overlayRatio=${overlayRatioCount} overlayIp=${overlayIpCount} exclusiveFallback=${exclusiveFallbackCount} xboxFilteredNoName=${filteredMissingSteam}`);

      res.json({
        window,
        cascade,
        count: trimmed.length,
        candidatesCount: multiRows.length,
        titles: trimmed,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Calibration status ────────────────────────────────────────────
  //
  // Backs the leaderboard banner. Returns latest applied calibration_events
  // row for the platform, so the client can render "Revenue estimates
  // calibrated on YYYY-MM-DD from N verified sales anchors." No individual
  // anchor titles are exposed. If no calibration has ever run for the
  // platform, returns { calibrated: false }.
  // Health endpoint (2026-09-12): observable count of Xbox rows that would
  // be filtered off the leaderboard because no xbox_title_cache entry
  // exists yet. Also reports retry-queue depth. Zero on both = the daily
  // leaderboard is complete. Non-zero here → there are bigIds sighted on
  // the store chart that no resolver has landed yet; the hourly worker is
  // handling them.
  app.get("/api/console/xbox-title-health", (_req, res) => {
    try {
      const totalPaid = (rawSqlite.prepare(
        `SELECT COUNT(*) AS n FROM platform_sku_map WHERE platform = 'xbox' AND business_model = 'paid' AND sku_role = 'base'`,
      ).get() as { n: number }).n;
      const missingCache = (rawSqlite.prepare(
        `SELECT COUNT(*) AS n
           FROM platform_sku_map psm
           LEFT JOIN xbox_title_cache xtc ON xtc.big_id = psm.external_sku
          WHERE psm.platform = 'xbox' AND psm.business_model = 'paid' AND psm.sku_role = 'base'
            AND xtc.big_id IS NULL`,
      ).get() as { n: number }).n;
      const queueDepth = (rawSqlite.prepare(
        `SELECT COUNT(*) AS n FROM xbox_bigid_retry_queue`,
      ).get() as { n: number }).n;
      const dueNow = (rawSqlite.prepare(
        `SELECT COUNT(*) AS n FROM xbox_bigid_retry_queue WHERE next_attempt_at <= ?`,
      ).get(new Date().toISOString()) as { n: number }).n;
      const cacheSize = (rawSqlite.prepare(
        `SELECT COUNT(*) AS n FROM xbox_title_cache`,
      ).get() as { n: number }).n;
      res.json({
        totalXboxPaidBase: totalPaid,
        missingFromCache: missingCache,
        retryQueueDepth: queueDepth,
        retryQueueDueNow: dueNow,
        cacheSize,
        healthy: missingCache === 0,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/console/leaderboards/:platform/calibration", (req, res) => {
    try {
      const platform = req.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid platform" });
      const ev = rawSqlite.prepare(`
        SELECT as_of_date, anchor_count, window_used, weight_method,
               observed_ratio, old_multiplier, new_multiplier, method,
               applied, notes, created_at
          FROM calibration_events
         WHERE platform = ? AND applied = 1
         ORDER BY as_of_date DESC, id DESC
         LIMIT 1
      `).get(platform) as any;
      if (!ev) return res.json({ calibrated: false, platform });
      // Overlay count: how many rows on the current leaderboard will show
      // an anchor overlay. We report on the m12 window as an informative
      // proxy — the actual overlay count varies by window the user views.
      const overlayCount = (rawSqlite.prepare(`
        SELECT COUNT(DISTINCT title_id) AS n
          FROM revenue_calibration_anchors
         WHERE platform = ?
           AND as_of_date = (SELECT MAX(as_of_date) FROM revenue_calibration_anchors WHERE platform = ?)
      `).get(platform, platform) as {n:number} | undefined)?.n ?? 0;
      res.json({
        calibrated: true,
        platform,
        lastCalibratedDate: ev.as_of_date,
        anchorCount: ev.anchor_count,
        windowUsed: ev.window_used,
        weightMethod: ev.weight_method,
        observedRatio: ev.observed_ratio,
        multiplierBefore: ev.old_multiplier,
        multiplierAfter: ev.new_multiplier,
        method: ev.method,
        overlayCount, // total distinct titles that have any anchor overlay available
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PDP header ────────────────────────────────────────────────────────
  //
  // Accepts `?window=d7|d30|d90|m12|ltd` (default `ltd`). The response now
  // includes a `windowKpisPerPlatform` array with window-scoped estimates
  // (units, owners, revenue) and a rating delta over the same window, so the
  // client can bind KPI tiles to the tab the user selected. `latestPerPlatform`
  // is preserved for backwards compat and continues to reflect the most
  // recent absolute capture (LTD-ish snapshot).
  // ─── Multiplatform PDP endpoint ───────────────────────────────
  //
  // Route: GET /api/console/multiplatform-title/:key
  // Query: window=d7|d30|d90|m12|ltd  (default ltd)
  //
  // :key is a URL-encoded editionGroupKey. Returns:
  //   {
  //     editionGroupKey, name, coverUrl, artworkUrl?, screenshots?, genres?,
  //     developers?, publishers?, summary?, releaseDate?, platforms,
  //     perPlatform: { steam?, ps5?, xbox? } where each is
  //       { titleId, revenueUsd, unitsMid, windowUsed, msrpUsdCents,
  //         ratingCount?, avgRating?, source: "anchor"|"overlay"|"raw" },
  //     combinedRevenueUsd,
  //     combinedUnits,
  //     window,
  //   }
  //
  // Revenue is computed with the SAME overlay pipeline as the leaderboard.
  app.get("/api/console/multiplatform-title/:key", (req, res) => {
    try {
      const key = decodeURIComponent(req.params.key || "");
      if (!key) return res.status(400).json({ error: "invalid key" });
      const window = ((req.query.window as string) || "ltd").toLowerCase();
      if (!["d7","d30","d90","m12","ltd"].includes(window)) return res.status(400).json({ error: "invalid window" });

      const steamAspFactor = aspFactorFor("steam");
      const ps5AspFactor   = aspFactorFor("ps5");
      const xboxAspFactor  = aspFactorFor("xbox");

      const CASCADE = ["d7","d30","d90","m12","ltd"] as const;
      const cascade = CASCADE.slice(CASCADE.indexOf(window as any));
      const cascadeUnitsExpr = cascade.map((w, i) => `w${i}.units_mid`).reduce((a, e) => `COALESCE(${a}, ${e})`);
      const cascadeWindowExpr = cascade.map((w, i) => `CASE WHEN w${i}.units_mid IS NOT NULL THEN '${w}' END`).reduce((a, e) => `COALESCE(${a}, ${e})`);
      const cascadeJoins = cascade.map((w, i) => `LEFT JOIN window_estimates_daily w${i}
          ON w${i}.title_id = psm.title_id AND w${i}.platform = psm.platform
         AND w${i}.window = '${w}'
         AND w${i}.as_of_date = (SELECT MAX(as_of_date) FROM window_estimates_daily
                                   WHERE title_id = psm.title_id AND platform = psm.platform AND window = '${w}')`).join("\n        ");

      // Pull every paid base SKU across steam/ps5/xbox with name+cover.
      const rows = rawSqlite.prepare(`
        SELECT
          psm.title_id AS titleId, psm.platform AS platform,
          psm.msrp_usd_cents AS msrpUsdCents,
          CASE
            WHEN psm.platform = 'xbox' THEN xtc.name
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(NULLIF(igdb.store_name, ''), NULLIF(igdb.name, ''))
            ELSE COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, ''))
          END AS name,
          CASE
            WHEN psm.platform = 'xbox' THEN xtc.art_url
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(NULLIF(igdb.store_header_image_url, ''), NULLIF(igdb.cover_url, ''))
            ELSE COALESCE(NULLIF(igdb.cover_url, ''), NULLIF(igdb.store_header_image_url, ''))
          END AS coverUrl,
          ${cascadeUnitsExpr} AS unitsMid,
          ${cascadeWindowExpr} AS windowUsed
        FROM platform_sku_map psm
        LEFT JOIN console_title_igdb igdb ON igdb.title_id = psm.title_id
        LEFT JOIN xbox_title_cache  xtc  ON xtc.title_id = psm.title_id AND psm.platform = 'xbox'
        ${cascadeJoins}
        WHERE psm.platform IN ('steam','ps5','xbox')
          AND psm.business_model = 'paid'
          AND psm.sku_role = 'base'
      `).all() as Array<{ titleId: number; platform: Platform; msrpUsdCents: number | null; name: string | null; coverUrl: string | null; unitsMid: number | null; windowUsed: string | null }>;

      // Filter to this key.
      const matching = rows.filter(r => editionGroupKey(r.name) === key);
      if (matching.length === 0) return res.status(404).json({ error: "key not found" });

      // Anchor lookup for this window.
      const anchorRows = rawSqlite.prepare(`
        SELECT rca.title_id AS titleId, rca.platform AS platform, rca.actual_revenue_usd AS revenue
        FROM revenue_calibration_anchors rca
        JOIN (SELECT title_id, platform, MAX(as_of_date) AS mx FROM revenue_calibration_anchors WHERE window = ? GROUP BY title_id, platform) l
          ON l.title_id = rca.title_id AND l.platform = rca.platform AND l.mx = rca.as_of_date
        WHERE rca.window = ?
      `).all(window, window) as Array<{ titleId: number; platform: Platform; revenue: number }>;
      const anchorMap = new Map<string, number>();
      for (const a of anchorRows) anchorMap.set(`${a.titleId}|${a.platform}`, a.revenue);

      // Aggregate per platform.
      type PerPlat = { titleId: number; msrpUsdCents: number | null; rawRevenue: number; anchorRevenue: number | null; unitsMid: number; windowUsed: string | null };
      const perPlatform: Partial<Record<Platform, PerPlat>> = {};
      const skuList: Array<{ titleId: number; platform: Platform; name: string | null; coverUrl: string | null }> = [];
      for (const r of matching) {
        skuList.push({ titleId: r.titleId, platform: r.platform, name: r.name, coverUrl: r.coverUrl });
        const asp = r.platform === "steam" ? steamAspFactor : r.platform === "ps5" ? ps5AspFactor : xboxAspFactor;
        const raw = (r.unitsMid != null && r.msrpUsdCents != null) ? r.unitsMid * r.msrpUsdCents * asp / 100 : 0;
        const anchor = anchorMap.get(`${r.titleId}|${r.platform}`) ?? null;
        const prev = perPlatform[r.platform];
        if (!prev) {
          perPlatform[r.platform] = { titleId: r.titleId, msrpUsdCents: r.msrpUsdCents, rawRevenue: raw, anchorRevenue: anchor, unitsMid: r.unitsMid ?? 0, windowUsed: r.windowUsed };
        } else {
          prev.rawRevenue += raw;
          if (anchor != null) prev.anchorRevenue = (prev.anchorRevenue ?? 0) + anchor;
          prev.unitsMid += r.unitsMid ?? 0;
          if (raw > 0 && prev.msrpUsdCents == null) prev.msrpUsdCents = r.msrpUsdCents;
        }
      }

      // Overlay-final revenue per platform.
      const steam = perPlatform.steam;
      const steamRevenue = steam ? (steam.anchorRevenue ?? steam.rawRevenue) : 0;
      const hasMeaningfulSteam = steamRevenue >= STEAM_MEANINGFUL_REVENUE_FLOOR_USD;

      // Pick a display name (prefer Steam SKU's name).
      const steamSku = skuList.find(s => s.platform === "steam") ?? skuList[0];
      const displayName = steamSku?.name ?? key;
      const ipPs5  = ipOverrideFactorFor(displayName, "ps5");
      const ipXbox = ipOverrideFactorFor(displayName, "xbox");

      type PerPlatOut = { titleId: number; revenueUsd: number; unitsMid: number; windowUsed: string | null; msrpUsdCents: number | null; source: "anchor" | "overlay" | "raw" };
      const out: Partial<Record<Platform, PerPlatOut>> = {};
      if (steam) {
        out.steam = {
          titleId: steam.titleId, revenueUsd: steamRevenue, unitsMid: steam.unitsMid, windowUsed: steam.windowUsed,
          msrpUsdCents: steam.msrpUsdCents, source: steam.anchorRevenue != null ? "anchor" : (steam.rawRevenue > 0 ? "raw" : "raw"),
        };
      }
      const ps5 = perPlatform.ps5;
      if (ps5) {
        let revenue = ps5.rawRevenue;
        let src: "anchor" | "overlay" | "raw" = "raw";
        if (ps5.anchorRevenue != null) { revenue = ps5.anchorRevenue; src = "anchor"; }
        else if (hasMeaningfulSteam) { revenue = steamRevenue * (ipPs5 ? ipPs5.factor : (PLATFORM_RATIO_VS_STEAM.ps5 as number)); src = "overlay"; }
        out.ps5 = { titleId: ps5.titleId, revenueUsd: revenue, unitsMid: ps5.unitsMid, windowUsed: ps5.windowUsed, msrpUsdCents: ps5.msrpUsdCents, source: src };
      }
      const xbox = perPlatform.xbox;
      if (xbox) {
        let revenue = xbox.rawRevenue;
        let src: "anchor" | "overlay" | "raw" = "raw";
        if (xbox.anchorRevenue != null) { revenue = xbox.anchorRevenue; src = "anchor"; }
        else if (hasMeaningfulSteam) { revenue = steamRevenue * (ipXbox ? ipXbox.factor : (PLATFORM_RATIO_VS_STEAM.xbox as number)); src = "overlay"; }
        out.xbox = { titleId: xbox.titleId, revenueUsd: revenue, unitsMid: xbox.unitsMid, windowUsed: xbox.windowUsed, msrpUsdCents: xbox.msrpUsdCents, source: src };
      }

      const combinedRevenueUsd = (out.steam?.revenueUsd ?? 0) + (out.ps5?.revenueUsd ?? 0) + (out.xbox?.revenueUsd ?? 0);
      const combinedUnits = (out.steam?.unitsMid ?? 0) + (out.ps5?.unitsMid ?? 0) + (out.xbox?.unitsMid ?? 0);

      // Pull IGDB detail from the Steam SKU when we have one; otherwise
      // fall back to the highest-revenue console SKU that has an IGDB row.
      const preferredTitleId = steamSku?.titleId ?? matching[0].titleId;
      const igdb = rawSqlite.prepare(`
        SELECT igdb_id AS igdbId, slug, name, summary, release_date AS releaseDate,
               cover_url AS coverUrl, artwork_url AS artworkUrl,
               screenshots_json AS screenshotsJson, genres_json AS genresJson,
               themes_json AS themesJson, platforms_json AS platformsJson,
               developers_json AS developersJson, publishers_json AS publishersJson,
               rating, rating_count AS ratingCount, refreshed_at AS refreshedAt
          FROM console_title_igdb WHERE title_id = ?
      `).get(preferredTitleId) as Record<string, any> | undefined;

      // JSON columns.
      const jsonParse = (s: string | null | undefined): any => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };

      const platforms: Platform[] = [];
      if (out.steam) platforms.push("steam");
      if (out.ps5)   platforms.push("ps5");
      if (out.xbox)  platforms.push("xbox");

      res.json({
        editionGroupKey: key,
        name: displayName,
        coverUrl: steamSku?.coverUrl ?? matching[0].coverUrl,
        artworkUrl: igdb?.artworkUrl ?? null,
        screenshots: jsonParse(igdb?.screenshotsJson),
        genres: jsonParse(igdb?.genresJson),
        themes: jsonParse(igdb?.themesJson),
        developers: jsonParse(igdb?.developersJson),
        publishers: jsonParse(igdb?.publishersJson),
        summary: igdb?.summary ?? null,
        releaseDate: igdb?.releaseDate ?? null,
        platforms,
        perPlatform: out,
        combinedRevenueUsd,
        combinedUnits,
        window,
        cascade,
        skus: skuList,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/console/titles/:titleId", (req, res) => {
    try {
      const titleId = parseInt(req.params.titleId, 10);
      if (!Number.isFinite(titleId)) return res.status(400).json({ error: "invalid titleId" });

      const window = (req.query.window as string) || "ltd";
      if (!["d7", "d30", "d90", "m12", "ltd"].includes(window)) {
        return res.status(400).json({ error: "invalid window" });
      }

      const skus = rawSqlite.prepare(`
        SELECT platform, external_sku AS externalSku, concept_id AS conceptId, sku_role AS skuRole,
               business_model AS businessModel, msrp_usd_cents AS msrpUsdCents, refreshed_at AS refreshedAt
          FROM platform_sku_map WHERE title_id = ? ORDER BY platform
      `).all(titleId) as Array<Record<string, any>>;

      if (skus.length === 0) return res.status(404).json({ error: "title not found" });

      const igdb = rawSqlite.prepare(`
        SELECT igdb_id AS igdbId, slug, name, summary, release_date AS releaseDate,
               cover_url AS coverUrl, artwork_url AS artworkUrl,
               screenshots_json AS screenshotsJson, genres_json AS genresJson,
               themes_json AS themesJson, platforms_json AS platformsJson,
               developers_json AS developersJson, publishers_json AS publishersJson,
               rating, rating_count AS ratingCount, refreshed_at AS refreshedAt
          FROM console_title_igdb WHERE title_id = ?
      `).get(titleId) as Record<string, any> | undefined;

      // Xbox override (2026-09-12): xbox_title_cache is the source of truth
      // for Xbox name/art. Look it up per Xbox SKU under this title_id and,
      // if we have one, prefer its name/art for the PDP header. Multiple
      // Xbox SKUs under one title_id (which shouldn't happen, but historic
      // collisions may leave that shape) → prefer the earliest-landed one.
      const xboxSkus = skus.filter(s => s.platform === "xbox").map(s => s.externalSku as string);
      const xboxCache = xboxSkus.length > 0 ? rawSqlite.prepare(
        `SELECT big_id, name, art_url, first_landed_at
           FROM xbox_title_cache
          WHERE big_id IN (${xboxSkus.map(() => "?").join(",")})
          ORDER BY first_landed_at ASC LIMIT 1`,
      ).get(...xboxSkus) as { big_id: string; name: string; art_url: string | null } | undefined : undefined;

      // Current LTD-ish rating snapshot per platform (most recent capture)
      const latestPerPlatform = rawSqlite.prepare(`
        SELECT srs.platform, srs.capture_date AS captureDate, srs.rating_count AS ratingCount,
               srs.avg_rating AS avgRating, srs.window_label AS windowLabel
          FROM store_rating_signal_daily srs
          JOIN (SELECT platform, MAX(capture_date) AS md
                  FROM store_rating_signal_daily WHERE title_id = ?
                 GROUP BY platform) x
            ON x.platform = srs.platform AND x.md = srs.capture_date
         WHERE srs.title_id = ?
      `).all(titleId, titleId) as Array<Record<string, any>>;

      // ── Window-scoped KPIs per platform ────────────────────────────────
      // Reuses the same cascade rule as the leaderboard: bias toward the
      // requested window, widen to the next tier only when the requested
      // window has no estimate. Never narrows.
      // Same rule as the leaderboard cascade: LTD is excluded from all windowed
      // rungs so a legacy title's lifetime total never masquerades as a 12-month
      // value on the standalone PDP. See CASCADE_BY_WINDOW comment above.
      const CASCADE_BY_WINDOW_PDP: Record<string, string[]> = {
        d7:  ["d7", "d30", "d90", "m12"],
        d30: ["d30", "d90", "m12"],
        d90: ["d90", "m12"],
        m12: ["m12"],
        ltd: ["ltd"],
      };
      const cascade = CASCADE_BY_WINDOW_PDP[window];

      // For each SKU, walk the cascade and find the first (platform, window)
      // with a units_mid row. Emit units/owners/revenue and the windowUsed tag.
      // Rating delta is a separate query per platform: end_count − start_count
      // over the same window (LTD = latest capture only, so delta is null).
      const WINDOW_DAYS: Record<string, number | null> = { d7: 7, d30: 30, d90: 90, m12: 365, ltd: null };
      const daysBack = WINDOW_DAYS[window];

      // Single lookup per (platform, window) — small N (up to 3 platforms × 5
      // cascade levels = 15 statements). Prepared once per handler call.
      const winStmt = rawSqlite.prepare(`
        SELECT units_mid AS unitsMid, owners_mid AS ownersMid, method, as_of_date AS asOfDate
          FROM window_estimates_daily
         WHERE title_id = ? AND platform = ? AND window = ?
         ORDER BY as_of_date DESC LIMIT 1
      `);

      const ratingDeltaStmt = rawSqlite.prepare(`
        SELECT capture_date AS captureDate, rating_count AS ratingCount, avg_rating AS avgRating
          FROM store_rating_signal_daily
         WHERE title_id = ? AND platform = ?
           AND capture_date >= date('now', ?)
         ORDER BY capture_date ASC
      `);
      const ratingLatestStmt = rawSqlite.prepare(`
        SELECT capture_date AS captureDate, rating_count AS ratingCount, avg_rating AS avgRating
          FROM store_rating_signal_daily
         WHERE title_id = ? AND platform = ?
         ORDER BY capture_date DESC LIMIT 1
      `);

      const windowKpisPerPlatform = skus.map((sku) => {
        const platform = sku.platform as Platform;
        const msrpUsdCents = sku.msrpUsdCents as number | null;
        const asp = aspFactorFor(platform);
        const aspUsdCents = msrpUsdCents != null ? Math.round(msrpUsdCents * asp) : null;

        // Walk cascade for units_mid / owners_mid.
        let winRow: { unitsMid: number | null; ownersMid: number | null; method: string | null; asOfDate: string } | null = null;
        let windowUsed: string | null = null;
        for (const w of cascade) {
          const row = winStmt.get(titleId, platform, w) as any;
          if (row && row.unitsMid != null) {
            winRow = row;
            windowUsed = w;
            break;
          }
        }

        // Cascade-to-LTD gate: same rule as the leaderboard. If the request
        // is for a bounded window but the only signal we have is LTD, don't
        // multiply LTD units by ASP as if it were a window quantity — emit
        // nulls and set gatedReason so the client can badge it.
        const gateToLtd = window !== "ltd" && cascade.length >= 2;
        const gatedLtdOnly = gateToLtd && windowUsed === "ltd";
        const unitsMid = gatedLtdOnly ? null : (winRow?.unitsMid ?? null);
        const ownersMid = gatedLtdOnly ? null : (winRow?.ownersMid ?? null);
        const revenueMidUsd = (unitsMid != null && aspUsdCents != null)
          ? Math.round((unitsMid * aspUsdCents) / 100)
          : null;
        const gatedReason = gatedLtdOnly ? "ltd_only_signal"
          : (winRow == null ? "no_estimate" : (msrpUsdCents == null ? "no_msrp" : null));

        // Rating delta over the window. LTD returns the absolute latest count
        // and null delta (nothing to compare against).
        let ratingCountStart: number | null = null;
        let ratingCountEnd: number | null = null;
        let ratingDelta: number | null = null;
        let avgRatingLatest: number | null = null;
        let captureLatestDate: string | null = null;
        if (daysBack == null) {
          const latest = ratingLatestStmt.get(titleId, platform) as any;
          if (latest) {
            ratingCountEnd = latest.ratingCount;
            avgRatingLatest = latest.avgRating;
            captureLatestDate = latest.captureDate;
          }
        } else {
          const rows = ratingDeltaStmt.all(titleId, platform, `-${daysBack} days`) as any[];
          if (rows.length >= 2) {
            ratingCountStart = rows[0].ratingCount;
            ratingCountEnd = rows[rows.length - 1].ratingCount;
            avgRatingLatest = rows[rows.length - 1].avgRating;
            captureLatestDate = rows[rows.length - 1].captureDate;
            if (ratingCountStart != null && ratingCountEnd != null) {
              ratingDelta = ratingCountEnd - ratingCountStart;
            }
          } else if (rows.length === 1) {
            // Only one capture in the window: report it as the end value with a
            // null delta rather than pretending we have a window measurement.
            ratingCountEnd = rows[0].ratingCount;
            avgRatingLatest = rows[0].avgRating;
            captureLatestDate = rows[0].captureDate;
          }
        }

        return {
          platform,
          window,
          windowUsed,
          cascade,
          unitsMid,
          ownersMid,
          revenueMidUsd,
          aspUsdCents,
          msrpUsdCents,
          method: winRow?.method ?? null,
          asOfDate: winRow?.asOfDate ?? null,
          gatedReason,
          ratingCountStart,
          ratingCountEnd,
          ratingDelta,
          avgRatingLatest,
          captureLatestDate,
        };
      });

      // Parse JSON columns
      const parsedIgdb = igdb ? {
        ...igdb,
        screenshots: igdb.screenshotsJson ? JSON.parse(igdb.screenshotsJson) : [],
        genres: igdb.genresJson ? JSON.parse(igdb.genresJson) : [],
        themes: igdb.themesJson ? JSON.parse(igdb.themesJson) : [],
        platforms: igdb.platformsJson ? JSON.parse(igdb.platformsJson) : [],
        developers: igdb.developersJson ? JSON.parse(igdb.developersJson) : [],
        publishers: igdb.publishersJson ? JSON.parse(igdb.publishersJson) : [],
      } : null;

      res.json({
        titleId,
        window,
        cascade,
        skus,
        igdb: parsedIgdb,
        // Xbox source-of-truth override (immutable-once-landed).
        // Client should prefer these over igdb.name / igdb.coverUrl when present.
        xboxTitle: xboxCache ? { bigId: xboxCache.big_id, name: xboxCache.name, artUrl: xboxCache.art_url } : null,
        latestPerPlatform,
        windowKpisPerPlatform,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Timeseries for date-range picker ──────────────────────────────────────
  app.get("/api/console/titles/:titleId/timeseries", (req, res) => {
    try {
      const titleId = parseInt(req.params.titleId, 10);
      if (!Number.isFinite(titleId)) return res.status(400).json({ error: "invalid titleId" });
      const platform = req.query.platform as Platform;
      if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "platform required" });
      const metric = (req.query.metric as string) || "rating_count";
      if (!["rating_count", "avg_rating", "owners_mid"].includes(metric)) return res.status(400).json({ error: "invalid metric" });
      const to = parseDate(req.query.to as string | undefined, todayIsoDate());
      const from = parseDate(req.query.from as string | undefined, daysAgo(90));

      let points: Array<{ date: string; value: number | null }> = [];
      if (metric === "owners_mid") {
        const window = (req.query.window as string) || "d30";
        points = rawSqlite.prepare(`
          SELECT as_of_date AS date, owners_mid AS value
            FROM window_estimates_daily
           WHERE title_id = ? AND platform = ? AND window = ?
             AND as_of_date >= ? AND as_of_date <= ?
           ORDER BY as_of_date
        `).all(titleId, platform, window, from, to) as Array<{ date: string; value: number | null }>;
      } else {
        const col = metric === "avg_rating" ? "avg_rating" : "rating_count";
        points = rawSqlite.prepare(`
          SELECT capture_date AS date, ${col} AS value
            FROM store_rating_signal_daily
           WHERE title_id = ? AND platform = ?
             AND capture_date >= ? AND capture_date <= ?
           ORDER BY capture_date
        `).all(titleId, platform, from, to) as Array<{ date: string; value: number | null }>;
      }

      res.json({ titleId, platform, metric, from, to, points });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── IGDB manual refresh (admin) ───────────────────────────────────────────
  app.post("/api/console/igdb/refresh/:titleId", async (req, res) => {
    try {
      const titleId = parseInt(req.params.titleId, 10);
      if (!Number.isFinite(titleId)) return res.status(400).json({ error: "invalid titleId" });
      const name = (req.body?.name as string) || undefined;
      if (!name) return res.status(400).json({ error: "name required" });
      const result = await refreshIgdbForTitle(titleId, name);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
