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
 *       units    = final revenue / realized or modeled ASP (after anchors)
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

import type { Express, Request } from "express";
import rateLimit from "express-rate-limit";
import { rawSqlite } from "./storage";
import { refreshIgdbForTitle } from "./signals/console/igdb";
import { revenueSummary } from "./console-revenue-share";
import { safeTitleMetadata } from "./console-title-metadata";
import { metadataMatchesStorefront, uniquePlatformTitles } from "./console-title-identity";
import { steamPortrait } from "./console-portrait-art";
import { ensureMixSchema, runMixShadow } from "./revenue-mix-shadow";
import type { Mix } from "./revenue-mix-model";
import { resolveSalesUnits } from "./console-sales-units";
import { ensureDailyMixSchema, runDailyMix, dailyMixStatus, publishedDailyAdjustments, applyDailyAdjustment, publishedDailyRevenue } from "./revenue-mix-daily";

type Platform = "steam" | "xbox" | "ps5";
const PLATFORMS: Platform[] = ["steam", "xbox", "ps5"];
const SALES_CASCADE: Record<string, string[]> = {
  d7: ["d7", "d30"], d30: ["d30", "d90"], d90: ["d90"], m12: ["m12"], ltd: ["ltd"],
};

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
  // Sony also uses square-bracket platform tags (Insurgency: Sandstorm).
  // Normalize only explicit platform packaging, never arbitrary subtitles.
  s = s.replace(/\s*\[(ps4\s*(?:&|and)\s*ps5|ps[45])\]\s*$/, " ($1)");

  // Strip trailing parenthesized platform tags — e.g.
  //   "Cyberpunk 2077: Ultimate Edition (Xbox Series X|S)"
  // Store listings on Xbox often append the platform in parens rather than
  // as a colon/dash-separated suffix. Without this the Xbox SKU falls into a
  // different editionGroupKey than its Steam/PS5 twins and drops out of the
  // multiplatform join. Run in a small loop so nested parens like
  //   "Foo (Deluxe) (Xbox Series X|S)" collapse in one pass.
  // Longest / most-specific first — the strip loop breaks on the first hit,
  // so a shorter tag ('xbox series x') must never be tried before a longer
  // superset ('xbox one & xbox series x|s'). Also: never write a literal
  // backslash here — the regex builder handles pipe-escaping.
  const PAREN_PLATFORM_TAGS = [
    "xbox one & xbox series x|s",
    "xbox one and xbox series x|s",
    "ps4 & ps5",
    "ps4 and ps5",
    "playstation 5",
    "playstation 4",
    "xbox series x|s",
    "xbox series x/s",
    "xbox series x",
    "xbox one",
    "ps5",
    "ps4",
    "pc",
    "windows",
    "steam",
  ];
  let parenChanged = true;
  let parenGuard = 0;
  while (parenChanged && parenGuard++ < 4) {
    parenChanged = false;
    for (const tag of PAREN_PLATFORM_TAGS) {
      const tagEsc = tag.replace(/[|]/g, "\\|").replace(/[.*+?^${}()]/g, "\\$&");
      const re = new RegExp(`\\s*\\(\\s*${tagEsc}\\s*\\)\\s*$`, "i");
      const next = s.replace(re, "");
      if (next !== s && next.length >= 2) {
        s = next.trim();
        parenChanged = true;
        break;
      }
    }
  }

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
    // Rockstar-style bundle suffixes with in-game currency card DLC
    // (Shark Cards for GTA V, Gold Bars for RDR2, etc). The bundle SKU is
    // still the base game with a DLC add-on — collapse to base for the
    // multiplatform join. Long/specific first so they match before their
    // sub-strings.
    "& great white shark card bundle",
    "& tiger shark cash card bundle",
    "& bull shark cash card bundle",
    "& megalodon shark cash card bundle",
    "& whale shark cash card bundle",
    "& shark cash card bundle",
    "and great white shark card bundle",
    "and shark cash card bundle",
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

export function evaluateRevenueMixShadow() {
  const weights = [1, PLATFORM_RATIO_VS_STEAM.ps5!, PLATFORM_RATIO_VS_STEAM.xbox!];
  const total = weights.reduce((a,b) => a+b,0);
  return runMixShadow(rawSqlite, editionGroupKey,
    name => IP_OVERRIDE_RULES.some(r => r.pattern.test(name)),
    weights.map(n => n/total) as Mix);
}

function dailyMixPolicy() {
  const weights = [1, PLATFORM_RATIO_VS_STEAM.ps5!, PLATFORM_RATIO_VS_STEAM.xbox!];
  const total = weights.reduce((a,b)=>a+b,0);
  return { familyKey: editionGroupKey, protectedTitle: (name: string) => IP_OVERRIDE_RULES.some(r=>r.pattern.test(name)),
    baseline: weights.map(n=>n/total) as Mix,
    asp: [aspFactorFor("steam"),aspFactorFor("ps5"),aspFactorFor("xbox")] as Mix };
}
export function evaluateDailyRevenueMix() {
  return runDailyMix(rawSqlite,dailyMixPolicy());
}

// Public rate limiter (2026-09-13). Attached only to the four routes that
// saber-auth's PUBLIC_READ_PATHS / PUBLIC_READ_PREFIXES exempt from JWT
// enforcement, so unauthenticated public traffic can't saturate the shared
// node process. 120 req/min/IP tracks the kickoff-doc budget and gives hmap
// generous headroom (its own /api/buying pass-through caches for 5 min, so
// per-visitor traffic to SignalPulse is well below this). Authenticated
// operator traffic through the SPA never hits these paths as public reads,
// so it's unaffected. Standard headers on so hmap's pass-through can surface
// RateLimit-* headers to the client if we ever want to.
const publicLeaderboardLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Rate-limit only unauthenticated public reads. An authenticated operator
  // (req.saberUser set by saber-auth middleware upstream) is exempt so the
  // SPA's own dashboards never hit the limiter. saber-auth runs before this
  // limiter, so req.saberUser is populated by the time we're called.
  skip: (req) => Boolean((req as Request & { saberUser?: unknown }).saberUser),
  message: { error: "rate_limited", detail: "Too many requests, please try again shortly." },
});

export function registerConsoleLeaderboardRoutes(app: Express) {
  ensureMixSchema(rawSqlite);
  ensureDailyMixSchema(rawSqlite);
  setImmediate(() => {
    try { console.log("[revenue-mix-shadow]", evaluateRevenueMixShadow()); }
    catch (error) { console.error("[revenue-mix-shadow] audit failed; published estimates unchanged", error); }
    try { console.log("[revenue-mix-daily]", evaluateDailyRevenueMix()); }
    catch (error) { console.error("[revenue-mix-daily] evaluation failed; baseline retained", error); }
  });
  // Match the same safe storefront family used by the leaderboard. A console
  // SKU may share the verified family's Steam portrait, never an unrelated IGDB hit.
  async function portraitCandidates(name: string | null, cover: string | null, titleId: number) {
    const key = editionGroupKey(name);
    const steamRows = rawSqlite.prepare(`
      SELECT p.external_sku AS appId, p.title_id AS titleId,
        CASE WHEN i.match_confidence = 'low' OR console_identity_matches(i.store_name, i.name) = 0 THEN i.store_name
             ELSE COALESCE(i.name, i.store_name) END AS name
      FROM platform_sku_map p JOIN console_title_igdb i ON i.title_id = p.title_id
      WHERE p.platform = 'steam' AND p.sku_role = 'base' AND p.business_model = 'paid'
    `).all() as Array<{appId: string; titleId: number; name: string}>;
    const steam = steamRows.find(s => s.titleId === titleId)
      ?? (key ? steamRows.find(s => editionGroupKey(s.name) === key) : undefined);
    const portrait = steam ? await steamPortrait(steam.appId) : null;
    return Array.from(new Set([portrait, cover].filter((url): url is string => Boolean(url))));
  }
  // Attach the public limiter to the exact paths saber-auth exposes
  // unauthenticated. GET-only — the mount uses app.get so it does not
  // affect any future POST/PUT to these paths (which would 404 anyway,
  // but stay behind JWT if ever added).
  app.get("/api/console/leaderboards/steam", publicLeaderboardLimiter);
  app.get("/api/console/leaderboards/ps5", publicLeaderboardLimiter);
  app.get("/api/console/leaderboards/xbox", publicLeaderboardLimiter);
  app.get("/api/console/leaderboards-multiplatform", publicLeaderboardLimiter);
  app.get("/api/console/multiplatform-title/:key", publicLeaderboardLimiter);


  // ─── Leaderboard list ─────────────────────────────────────────────────────
  // One read-side revenue/units pipeline, shared by every Buying surface.
  // Return the complete catalog so anchors and unit sorting precede top-N slicing.
  function platformSales(platform: Platform, window: string, sort = "revenue", dir = "desc") {
      // Default is the 7d window so fresh weekly hits (launches like
      // Halloween: The Game and How to Fish) surface first. Because the
      // estimator sometimes doesn't have 7d numbers yet for very recent
      // launches, the SQL below cascades w.units_mid through d7→d30→d90→ltd
      // per-row so revenue/units always fills top-100 even when a specific
      // window is thin. The `windowUsed` column on each row tells the client
      // which underlying window produced the number.

      // Sort mode + direction. Whitelist rather than string-interpolate to keep
      // the query prepareable and to prevent injection through the query string.

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
      const cascade = SALES_CASCADE[window];

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
      // Exclusion tests must use the same identity as the displayed row. A
      // base game enriched as an update must not be filtered as paid DLC.
      const nameSourceExpr = `LOWER(CASE WHEN igdb.match_confidence='low' OR console_identity_matches(igdb.store_name,igdb.name)=0
        THEN COALESCE(NULLIF(igdb.store_name,''),NULLIF(igdb.name,''),psm.external_sku)
        ELSE COALESCE(NULLIF(igdb.name,''),NULLIF(igdb.store_name,''),psm.external_sku) END)`;
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

      // Unreleased-title filter (2026-09-13). A preorder-window SKU accumulates
      // rating-count-like signal from wishlists/store activity before launch;
      // multiplied by the ownership multiplier this produces windowed revenue
      // values that are definitionally wrong — the game has not sold anything
      // yet. Seen in production 2026-09-13 with COD Modern Warfare 4 (release
      // 2026-10-23) leading the multiplatform d7 board at $1.82B. Excluded
      // here at the query level so the row never enters revenue aggregation.
      //
      // Rows with genuinely unknown release_date (both igdb.release_date and
      // igdb.store_release_date are NULL) are preserved, matching the rest
      // of the codebase's preference for inclusive handling of missing data.
      // Those rows historically don't hit this failure mode because they lack
      // strong signal in the first place.
      const unreleasedFilter = `
        AND (
          (igdb.release_date IS NULL AND igdb.store_release_date IS NULL)
          OR date(
               CASE
                 WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
                   THEN COALESCE(igdb.store_release_date, igdb.release_date)
                 ELSE COALESCE(igdb.release_date, igdb.store_release_date)
               END
             ) <= date('now')
        )
      `;

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
            WHEN psm.platform = 'xbox' THEN CASE WHEN xtc.source = 'seeded_from_cti' AND console_identity_matches(igdb.store_name, xtc.name) = 0 THEN COALESCE(NULLIF(igdb.store_name, ''), xtc.name) ELSE xtc.name END
            WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
              THEN COALESCE(NULLIF(igdb.store_name, ''), NULLIF(igdb.name, ''))
            ELSE COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, ''))
          END                                       AS name,
          CASE
            WHEN psm.platform = 'xbox' THEN xtc.art_url
            WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
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
            WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
              THEN COALESCE(igdb.store_release_date, igdb.release_date)
            ELSE COALESCE(igdb.release_date, igdb.store_release_date)
          END                                       AS releaseDate,
          -- nameSource lets the client badge each row.
          CASE
            WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0) THEN 'store'
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
                 CASE WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
                   THEN COALESCE(igdb.store_release_date, igdb.release_date)
                   ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                 END
               ) IS NOT NULL
                AND (
                 CASE WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
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
         ${unreleasedFilter}
       -- NULL sort values sink so the client still gets a full 100 rows even
       -- before the estimator has populated every window. rating_count is a
       -- stable-sort tie-breaker for every sort mode.
       -- Recent-hot titles get a small tie-breaker bump so a Sep-8 launch
       -- with the same revenue as a tenured title still lands above it in
       -- the 7d view.
       ORDER BY (${sortExprGated} IS NULL) ASC,
                ${sortExprGated} ${dirSql},
                (CASE WHEN (
                   CASE WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
                     THEN COALESCE(igdb.store_release_date, igdb.release_date)
                     ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                   END
                 ) >= ? THEN 1 ELSE 0 END) DESC,
                COALESCE(srs.rating_count, 0) DESC
       -- Do not limit before final anchors, unit reconciliation, and sorting.
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
      for (const r of uniquePlatformTitles(rows as Array<Row & { titleId: number; platform: string; msrpUsdCents: number | null }>)) {
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
            familyTitleIds: [r.titleId],
            representativeRevenue: r.revenueMidUsd ?? 0,
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
        if (rRev > existing.representativeRevenue ||
            (rRev === existing.representativeRevenue && r.titleId < existing.titleId)) {
          const bumped: Row = {
            ...r,
            revenueMidUsd: rRev + eRev,
            unitsMid: rUnits + eUnits,
            editionCount: existing.editionCount + 1,
            editionTitles: [...existing.editionTitles, rawName],
            editionGroupKey: key,
            familyTitleIds: [...existing.familyTitleIds, r.titleId],
            representativeRevenue: rRev,
          };
          byKey.set(groupKey, bumped);
          // Replace in the ordered array at the same slot.
          const idx = groups.indexOf(existing);
          if (idx >= 0) groups[idx] = bumped;
        } else {
          existing.revenueMidUsd = existing.revenueMidUsd != null || r.revenueMidUsd != null ? eRev + rRev : null;
          existing.unitsMid = existing.unitsMid != null || r.unitsMid != null ? eUnits + rUnits : null;
          existing.editionCount += 1;
          existing.editionTitles.push(rawName);
          existing.familyTitleIds.push(r.titleId);
        }
      }
      for (const g of groups) {
        g.unitsMidEstimated = g.unitsMid;
        delete g.representativeRevenue;
        // Weighted family ASP preserves distinct-edition economics; no penny
        // truncation before back-solving large unit quantities.
        g.aspUsdCents = g.unitsMid > 0 && g.revenueMidUsd != null
          ? g.revenueMidUsd * 100 / g.unitsMid
          : (g.msrpUsdCents != null ? g.msrpUsdCents * aspFactor : null);
      }
      // ── Path A: Steam anchor overlay (Steam platform only) ─────────────
      // For any group whose (titleId, 'steam', window) matches a row in
      // revenue_calibration_anchors for the most recent as_of_date, swap the
      // estimator revenue for the anchor's actual_revenue_usd and tag
      // dataSource='actual'. Final units are back-solved below from that
      // revenue and ASP; stored estimator units remain untouched.
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
          SELECT title_id, actual_revenue_usd, actual_units, sale_state, as_of_date, data_source
            FROM revenue_calibration_anchors
           WHERE platform = ? AND window = ?
             AND (title_id, as_of_date) IN (
                 SELECT title_id, MAX(as_of_date)
                   FROM revenue_calibration_anchors
                  WHERE platform = ? AND window = ?
                  GROUP BY title_id
             )
        `).all(platform, win, platform, win) as Array<{title_id:number; actual_revenue_usd:number; actual_units:number|null; sale_state:string; as_of_date:string; data_source:string}>;
        const anchorMap = new Map<number, {actual_revenue_usd:number; actual_units:number|null; sale_state:string; as_of_date:string; data_source:string}>();
        for (const a of anchorRows) anchorMap.set(a.title_id, a);

        // Also load the LTD anchor for THIS platform (any title_id) so that
        // when a shorter-window row (d7/d30/d90) doesn't have its own
        // anchor, we can scale it by the LTD anchor/estimator ratio. This
        // is the "filters adjust appropriately" behavior: correcting an
        // inflated LTD must proportionally shrink the shorter windows,
        // otherwise (e.g.) a d90 revenue would exceed the anchored LTD.
        //
        // Only applies when the LTD anchor is verified (data_source starts
        // with 'manual_anchor_verified_'), NOT for portal_fetch anchors —
        // those already track actual per-window revenue in their own row.
        let ltdAnchorMap: Map<number, {actual_revenue_usd:number; actual_units:number|null; data_source:string}> = new Map();
        let ltdEstimatorRevByTitleId: Map<number, number> = new Map();
        let ltdEstimatorUnitsByTitleId: Map<number, number> = new Map();
        const isShorterWindow = win !== 'ltd';
        if (isShorterWindow) {
          const ltdAnchorRows = rawSqlite.prepare(`
            SELECT title_id, actual_revenue_usd, actual_units, data_source
              FROM revenue_calibration_anchors
             WHERE platform = ? AND window = 'ltd'
               AND data_source LIKE 'manual_anchor_verified_%'
               AND (title_id, as_of_date) IN (
                   SELECT title_id, MAX(as_of_date)
                     FROM revenue_calibration_anchors
                    WHERE platform = ? AND window = 'ltd'
                    GROUP BY title_id
               )
          `).all(platform, platform) as Array<{title_id:number; actual_revenue_usd:number; actual_units:number|null; data_source:string}>;
          for (const a of ltdAnchorRows) ltdAnchorMap.set(a.title_id, a);
        }

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
        const steamRevenueByKey = new Map<string, {revenue:number; source:"anchor"|"estimator"; windowUsed:string|null}>();
        if (consoleRatio != null) {
          // Steam never enters this branch, so recursion terminates after one
          // level. Reusing its final result also preserves verified LTD scaling,
          // family deduplication, and future approved revenue adjustments.
          for (const s of platformSales("steam", window).titles) {
            if (s.editionGroupKey && s.revenueMidUsd != null) {
              steamRevenueByKey.set(s.editionGroupKey, {
                revenue: s.revenueMidUsd,
                source: s.dataSource === "actual" ? "anchor" : "estimator",
                windowUsed: s.windowUsed,
              });
            }
          }
        }

        for (const g of groups) {
          // Path A precedence:
          //   * Steam platform: always wins. Steam anchors are the whole
          //     point of the calibration pipeline (portal_fetch actuals).
          //   * PS5/Xbox platform: only anchors whose data_source starts
          //     with 'manual_anchor_verified_' win. These are executive-
          //     verified LTD figures written specifically to correct the
          //     Game-Pass / rating-driven distortions the platform ratio
          //     alone can't fix (Minecraft Xbox, Spider-Man family PS5).
          //     Other PS5/Xbox anchor rows (auto-derived from the
          //     estimator) are ignored on Path A — letting them win would
          //     re-inflate the very distortions the Path B ratio is
          //     meant to correct.
          // Anchors are keyed to distinct title IDs, not regional listings or
          // whichever edition happens to become the display row for this sort.
          const familyAnchors = (g.familyTitleIds as number[]).map(id => anchorMap.get(id))
            .filter((a): a is NonNullable<typeof a> => Boolean(a &&
              (platform === "steam" || a.data_source?.startsWith("manual_anchor_verified_"))));
          const a = familyAnchors.length ? {
            ...familyAnchors[0],
            actual_revenue_usd: familyAnchors.reduce((sum,a) => sum+a.actual_revenue_usd,0),
            actual_units: familyAnchors.every(a => a.data_source?.startsWith("manual_anchor_verified_") &&
              typeof a.actual_units === "number" && a.actual_units > 0)
              ? familyAnchors.reduce((sum,a) => sum+a.actual_units!,0) : null,
            data_source: familyAnchors.every(a => a.data_source?.startsWith("manual_anchor_verified_"))
              ? "manual_anchor_verified_family" : familyAnchors[0].data_source,
          } : undefined;
          const isVerifiedAnchor = a && a.data_source && a.data_source.startsWith('manual_anchor_verified_');
          const anchorWins = a && (platform === "steam" || isVerifiedAnchor);
          if (anchorWins && a) {
            g.revenueMidUsdEstimated = g.revenueMidUsd;
            g.revenueMidUsd = a.actual_revenue_usd;
            g.dataSource = "actual";
            g.anchorSaleState = a.sale_state;
            g.anchorAsOfDate = a.as_of_date;
            g.windowUsed = win;
            g.gatedReason = null;
            // For verified anchors (executive-provided LTD numbers), the
            // anchor row carries authoritative actual_units too — overwrite
            // the estimator units so the UI shows the exec-provided figure
            // instead of the pre-anchor estimator's cascaded units_mid.
            // Other anchors use modeled ASP in the final unit resolver.
            if (isVerifiedAnchor && typeof a.actual_units === 'number' && a.actual_units > 0) {
              g.unitsMid = a.actual_units;
              g.ownersMid = a.actual_units;
              g.verifiedAnchorUnits = a.actual_units;
            }
            pathAOverlaid++;
            continue;
          }

          // Verified-LTD shorter-window scaling: when a title has a
          // manual_anchor_verified_ltd row on this platform but no
          // direct anchor for this shorter window, scale the estimator
          // revenue by (anchor_ltd / estimator_ltd_for_same_title). This
          // preserves the "anchor drives the ceiling and shorter windows
          // adjust proportionally" behavior the user requested.
          const ltdAnchor = ltdAnchorMap.get(g.titleId);
          if (isShorterWindow && ltdAnchor) {
            // Compute the scaling ratio. Prefer units-based when the anchor
            // carries actual_units — that ratio is independent of the LTD
            // realized ASP, so an operator can inflate LTD revenue to reflect
            // historical pricing (e.g. GTA V originally $59.99 later $29.99)
            // without inflating d7/d30/d90 revenue, which should stay at
            // current-price economics.
            //
            // Fallback: revenue-based ratio (legacy behavior) when the anchor
            // has no actual_units. Preserves back-compat for older anchors.
            let ratio: number | null = null;
            let ratioBasis: 'units' | 'revenue' = 'revenue';

            if (typeof ltdAnchor.actual_units === 'number' && ltdAnchor.actual_units > 0) {
              let estLtdUnits = ltdEstimatorUnitsByTitleId.get(g.titleId);
              if (estLtdUnits === undefined) {
                const ltdRow = rawSqlite.prepare(`
                  SELECT COALESCE(SUM(units_mid), 0) AS units
                    FROM window_estimates_daily
                   WHERE title_id = ? AND platform = ? AND window = 'ltd'
                     AND as_of_date = (
                       SELECT MAX(as_of_date) FROM window_estimates_daily
                        WHERE title_id = ? AND platform = ? AND window = 'ltd'
                     )
                `).get(g.titleId, platform, g.titleId, platform) as { units: number } | undefined;
                estLtdUnits = ltdRow?.units ?? 0;
                ltdEstimatorUnitsByTitleId.set(g.titleId, estLtdUnits);
              }
              if (estLtdUnits > 0) {
                const rawRatio = ltdAnchor.actual_units / estLtdUnits;
                // Guard against broken-estimator pathology: if the LTD
                // estimator reports fewer units than the anchor, the shorter
                // windows are almost certainly untrustworthy too, and scaling
                // by (anchor / est_ltd) can produce absurd revenues (e.g.
                // MK1 Steam: est_ltd=43k, anchor=600k -> 13.7x lift on
                // already-wrong d7=87k -> \$71M/week nonsense). In that
                // case, leave the shorter window at its raw estimator value
                // rather than amplifying an untrustworthy signal.
                if (rawRatio <= 1.0) {
                  ratio = rawRatio;
                  ratioBasis = 'units';
                } else {
                  // Estimator LTD < anchor — broken. Skip the LTD-anchor
                  // shorter-window overlay; let raw estimator flow through
                  // (or Path B derivation for non-Steam) instead.
                }
              }
            }

            if (ratio === null) {
              // Legacy revenue-based scaling for anchors without actual_units,
              // OR fallback when the units-based path was skipped because the
              // estimator LTD was broken. Same > 1.0 cap applies here — a
              // ratio > 1 amplifies an already-untrustworthy signal.
              let estLtdRev = ltdEstimatorRevByTitleId.get(g.titleId);
              if (estLtdRev === undefined) {
                const ltdRow = rawSqlite.prepare(`
                  SELECT COALESCE(SUM(units_mid), 0) AS units
                    FROM window_estimates_daily
                   WHERE title_id = ? AND platform = ? AND window = 'ltd'
                     AND as_of_date = (
                       SELECT MAX(as_of_date) FROM window_estimates_daily
                        WHERE title_id = ? AND platform = ? AND window = 'ltd'
                     )
                `).get(g.titleId, platform, g.titleId, platform) as { units: number } | undefined;
                const units = ltdRow?.units ?? 0;
                const msrp = (g.msrpUsdCents ?? 0) / 100;
                estLtdRev = units * msrp * aspFactor;
                ltdEstimatorRevByTitleId.set(g.titleId, estLtdRev);
              }
              if (estLtdRev > 0) {
                const rawRatio = ltdAnchor.actual_revenue_usd / estLtdRev;
                if (rawRatio <= 1.0) {
                  ratio = rawRatio;
                  ratioBasis = 'revenue';
                }
                // else: skip. Untrustworthy LTD estimator. Fall through to
                // Path B or raw estimator for this shorter window.
              }
            }

            if (ratio !== null) {
              g.revenueMidUsdEstimated = g.revenueMidUsd;
              g.revenueMidUsd = g.revenueMidUsd * ratio;
              g.unitsMid = Math.round(g.unitsMid * ratio);
              g.ownersMid = Math.round((g.ownersMid ?? g.unitsMid) * ratio);
              g.dataSource = ratioBasis === 'units'
                ? 'scaled_to_verified_ltd_anchor_units'
                : 'scaled_to_verified_ltd_anchor';
              g.anchorAsOfDate = null;
              continue;
            }
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
          // Final unit reconciliation below returns null when ASP is unknown.
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
            const hasMeaningfulSteam = s != null && s.revenue >= STEAM_MEANINGFUL_REVENUE_FLOOR_USD;
            if (hasMeaningfulSteam && s) {
              const ipOverride = ipOverrideFactorFor(g.name as string | null | undefined, platform);
              const factor = ipOverride ? ipOverride.factor : consoleRatio;
              const derivedRevenue = s.revenue * factor;
              g.revenueMidUsdEstimated = g.revenueMidUsd;
              g.revenueMidUsd = derivedRevenue;
              g.dataSource = ipOverride ? "derived_from_steam_ip_override" : "derived_from_steam";
              g.derivationRatio = factor;
              g.derivationSteamSource = s.source; // 'anchor' | 'estimator'
              g.windowUsed = s.windowUsed;
              g.gatedReason = g.aspUsdCents == null ? "no_msrp" : null;
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

        if (pathAOverlaid > 0 || pathBDerived > 0) {
          console.log(`[leaderboard-overlay] platform=${platform} window=${win} pathA=${pathAOverlaid} pathB=${pathBDerived} ipOverrides=${ipOverridesApplied} pathBSkippedNoSteam=${pathBSkippedNoSteam} groups=${groups.length}`);
        }
      } catch (overlayErr: any) {
        // Overlay is optional — never fail the leaderboard because of it.
        console.log(`[leaderboard-overlay] skipped (${overlayErr?.message ?? overlayErr}); returning estimates`);
      }

      // Apply approved, recorded daily deltas before resolving units. The older
      // windowed shadow candidates never enter published revenue.
      const daily = platform==="steam" ? new Map() : publishedDailyAdjustments(rawSqlite,dailyMixPolicy(),window);
      for (const g of groups) {
        // Only the generic baseline overlay is eligible. Verified anchors,
        // special IP ratios and LTD-anchor scaling never enter active mode.
        // A cascaded wider estimate is not a measured requested-window total.
        if(g.dataSource==="derived_from_steam" && g.windowUsed===window) {
          const adjustment=applyDailyAdjustment(g.revenueMidUsd,daily.get(g.editionGroupKey),platform);
          if(adjustment.delta!==0){
            g.revenueMidUsdBaseline=g.revenueMidUsd;
            g.revenueMidUsd=adjustment.revenue;
            g.dailyMixAdjustmentUsd=adjustment.delta;
            g.dailyMixAdjustedDays=adjustment.days;
            g.dataSource="derived_from_steam_daily_mix";
          }
        }
        Object.assign(g, resolveSalesUnits(g.revenueMidUsd, g.aspUsdCents, g.verifiedAnchorUnits ?? null));
        delete g.verifiedAnchorUnits;
      }
      if (sort === "revenue" || sort === "units" || sort === "asp") {
        const field = sort === "revenue" ? "revenueMidUsd" : sort === "units" ? "unitsMid" : "aspUsdCents";
        groups.sort((a, b) => {
          if (a[field] == null) return b[field] == null ? 0 : 1;
          if (b[field] == null) return -1;
          return dir === "asc" ? a[field] - b[field] : b[field] - a[field];
        });
      }
      const collapsed = groups;

      // Latest data date for this platform — read from the most recent
      // capture in store_rating_signal_daily. Powers the "Refreshed daily
      // at ~09:15 UTC · Latest data: YYYY-MM-DD" banner note. Kept as a
      // string date (YYYY-MM-DD) because that's what the daily discovery
      // stamps into capture_date. Null if the table is empty for this
      // platform.
      let latestCaptureDate: string | null = null;
      try {
        const latestRow = rawSqlite.prepare(
          `SELECT MAX(capture_date) AS d
             FROM store_rating_signal_daily
            WHERE platform = ?`,
        ).get(platform) as { d: string | null } | undefined;
        latestCaptureDate = latestRow?.d ?? null;
      } catch (latestErr: any) {
        console.log(`[leaderboard-latest] platform=${platform} lookup failed: ${latestErr?.message ?? latestErr}`);
      }

      return {
        platform, window, sort, dir, aspFactor, cascade,
        count: collapsed.length,
        titles: collapsed,
        latestCaptureDate,
        refreshCronUtc: "09:15",
      };
  }

  app.get("/api/console/leaderboards/:platform", (req, res) => {
    try {
      const platform = req.params.platform as Platform;
      const window = (req.query.window as string) || "d7";
      const sort = ((req.query.sort as string) || "revenue").toLowerCase();
      const dir = ((req.query.dir as string) || "desc").toLowerCase();
      if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid platform" });
      if (!["d7","d30","d90","m12","ltd"].includes(window)) return res.status(400).json({ error: "invalid window" });
      if (!["revenue","units","ratings","score","asp"].includes(sort)) return res.status(400).json({ error: "invalid sort" });
      if (!["asc","desc"].includes(dir)) return res.status(400).json({ error: "invalid dir" });
      const result = platformSales(platform, window, sort, dir);
      const titles = result.titles.slice(0, 100);
      res.json({ ...result, titles, count: titles.length });
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
      const cascade = SALES_CASCADE[window];

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
            WHEN psm.platform = 'xbox' THEN CASE WHEN xtc.source = 'seeded_from_cti' AND console_identity_matches(igdb.store_name, xtc.name) = 0 THEN COALESCE(NULLIF(igdb.store_name, ''), xtc.name) ELSE xtc.name END
            WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
              THEN COALESCE(NULLIF(igdb.store_name, ''), NULLIF(igdb.name, ''))
            ELSE COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, ''))
          END                                             AS name,
          CASE
            WHEN psm.platform = 'xbox' THEN xtc.art_url
            WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
              THEN COALESCE(NULLIF(igdb.store_header_image_url, ''), NULLIF(igdb.cover_url, ''))
            ELSE COALESCE(NULLIF(igdb.cover_url, ''), NULLIF(igdb.store_header_image_url, ''))
          END                                             AS coverUrl,
          CASE WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
            THEN igdb.store_release_date
            ELSE COALESCE(igdb.release_date, igdb.store_release_date)
          END                                             AS releaseDate,
          ${cascadeUnitsExpr}                             AS unitsMid,
          ${cascadeWindowExpr}                            AS windowUsed
        FROM platform_sku_map psm
        LEFT JOIN console_title_igdb igdb ON igdb.title_id = psm.title_id
        LEFT JOIN xbox_title_cache  xtc  ON psm.platform = 'xbox' AND xtc.big_id = psm.external_sku
        ${cascadeJoins}
        WHERE psm.platform IN ('steam','ps5','xbox')
          AND psm.business_model = 'paid'
          AND psm.sku_role = 'base'
          -- Xbox integrity gate (2026-09-12): filter Xbox rows with no xtc entry
          AND (psm.platform <> 'xbox' OR xtc.name IS NOT NULL)
          -- Unreleased-title filter (2026-09-13): mirrors per-platform routes;
          -- prevents preorder-window signal from producing windowed revenue for
          -- games that haven't launched yet (e.g. COD MW4 at $1.82B on d7).
          -- See unreleasedFilter definition earlier in this file for the full
          -- rationale. Rows with unknown release_date are preserved.
          AND (
            (igdb.release_date IS NULL AND igdb.store_release_date IS NULL)
            OR date(
                 CASE
                   WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
                     THEN COALESCE(igdb.store_release_date, igdb.release_date)
                   ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                 END
               ) <= date('now')
          )
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
        // De-dup guard: platform_sku_map can have multiple external_sku rows
        // (US + EU regions) that share the same title_id. Anchors are keyed by
        // (title_id, platform), so we only add each anchor once per distinct
        // title_id in the group — otherwise the anchor doubles.
        countedAnchorTitleIds: Set<number>;
        // Same de-dup for raw revenue: if two rows share the same title_id,
        // they read the same units_mid from window_estimates_daily and would
        // double-count if summed as-if independent SKUs.
        countedRawTitleIds: Set<number>;
      };
      const perKeyPerPlatform = new Map<string, Partial<Record<Platform, PerPlatformAgg>>>();
      let filteredMissingSteam = 0;

      for (const r of rows) {
        const key = editionGroupKey(r.name);
        if (!key) continue;

        // Artwork availability must not drop a valid platform's revenue.
        // Identity gating matches the per-platform/PDP handlers.
        if (r.platform === "xbox" && !r.name) { filteredMissingSteam++; continue; }

        const aspFactor = r.platform === "steam" ? steamAspFactor : r.platform === "ps5" ? ps5AspFactor : xboxAspFactor;
        const skuRawRevenue = (r.unitsMid != null && r.msrpUsdCents != null)
          ? r.unitsMid * r.msrpUsdCents * aspFactor / 100
          : 0;
        const anchor = anchorByTitleIdPlatform.get(`${r.titleId}|${r.platform}`) ?? null;

        const bucket = perKeyPerPlatform.get(key) ?? {};
        const prev = bucket[r.platform];
        if (!prev) {
          const countedAnchor = new Set<number>();
          const countedRaw = new Set<number>();
          if (anchor != null) countedAnchor.add(r.titleId);
          if (skuRawRevenue > 0) countedRaw.add(r.titleId);
          bucket[r.platform] = {
            titleId: r.titleId,
            name: r.name,
            coverUrl: r.coverUrl,
            releaseDate: r.releaseDate,
            rawRevenueUsd: skuRawRevenue,
            anchoredRevenueUsd: anchor,
            countedAnchorTitleIds: countedAnchor,
            countedRawTitleIds: countedRaw,
          };
        } else {
          // Multiple SKUs in the same edition family for the same platform.
          // Two shapes to handle correctly:
          //   a) Genuinely distinct SKUs (base + Deluxe on PS5) — sum both
          //      the raw revenue and any per-SKU anchors.
          //   b) One title_id mapped to multiple region SKUs (US + EU) —
          //      raw units and anchor are the SAME data; add each only once
          //      per distinct title_id.
          if (!prev.countedRawTitleIds.has(r.titleId)) {
            prev.rawRevenueUsd += skuRawRevenue;
            if (skuRawRevenue > 0) prev.countedRawTitleIds.add(r.titleId);
          }
          if (anchor != null && !prev.countedAnchorTitleIds.has(r.titleId)) {
            prev.anchoredRevenueUsd = (prev.anchoredRevenueUsd ?? 0) + anchor;
            prev.countedAnchorTitleIds.add(r.titleId);
          }
          if (skuRawRevenue > (perKeyPerPlatform.get(key)?.[r.platform]?.rawRevenueUsd ?? 0)) {
            prev.titleId = r.titleId;
            prev.name = r.name ?? prev.name;
            prev.coverUrl = r.coverUrl ?? prev.coverUrl;
            prev.releaseDate = r.releaseDate ?? prev.releaseDate;
          }
        }
        perKeyPerPlatform.set(key, bucket);
      }

      // Build multiplatform rows. Cross-platform gate: EITHER
      //   (a) Steam present + at least one of {PS5, Xbox}, OR
      //   (b) BOTH PS5 and Xbox are ANCHOR-backed (anchoredRevenueUsd != null).
      //
      // Branch (b) exists so console-only franchises with no Steam SKU can
      // still appear on the multiplatform LTD board when we have durable,
      // executive-verified anchors on both consoles. Anchored-only is the
      // gate — raw estimator revenue alone is not enough to bypass Steam,
      // because the overlay ratio is what normally makes cross-platform
      // scale coherent, and without anchors on both sides a noisy per-
      // platform estimate could pop into the multi-board with no signal to
      // sanity-check it. Requiring anchors on both consoles keeps the bar
      // high (Minecraft is the canonical case).
      type MultiRow = {
        editionGroupKey: string;
        name: string; coverUrl: string | null; releaseDate: string | null;
        steamTitleId?: number; ps5TitleId?: number; xboxTitleId?: number;
        platforms: Platform[];
        revenueSteam: number; revenuePs5: number; revenueXbox: number;
        revenueCombined: number;
        revenueSource: "overlay-ratio" | "overlay-ip-override" | "ps5-exclusive-fallback" | "mixed";
      };
      const multiRows: MultiRow[] = [];
      let overlayRatioCount = 0, overlayIpCount = 0, exclusiveFallbackCount = 0;
      const resolvedSales = new Map(PLATFORMS.map(p => [p,
        new Map(platformSales(p, window).titles.map(r => [r.editionGroupKey, r]))]));

      let noSteamAnchoredCount = 0;
      for (const [key, byPlatform] of Array.from(perKeyPerPlatform.entries())) {
        const steam = byPlatform.steam;
        const ps5   = byPlatform.ps5;
        const xbox  = byPlatform.xbox;
        // Branch (b): no Steam, but both consoles have anchored revenue.
        // Skip the Steam-required checks and continue with steam=undefined
        // downstream. revenueSteam falls to 0 (no Steam SKU exists), and
        // the console anchors alone drive revenueCombined.
        const bothConsolesAnchored = !steam
          && resolvedSales.get("ps5")?.get(key)?.dataSource === "actual"
          && resolvedSales.get("xbox")?.get(key)?.dataSource === "actual";
        if (!steam && !bothConsolesAnchored) continue;   // must be on Steam or dual-anchored
        if (steam && !ps5 && !xbox) continue;            // Steam alone is not cross-platform
        if (bothConsolesAnchored) noSteamAnchoredCount++;

        // Steam revenue: anchor wins over estimator. Zero when there is no
        // Steam SKU (dual-anchored branch b).
        const steamRevenue = steam ? (resolvedSales.get("steam")?.get(key)?.revenueMidUsd ?? 0) : 0;
        // Reuse the canonical final revenue, including protected LTD scaling.
        const ps5Sales = resolvedSales.get("ps5")?.get(key);
        const xboxSales = resolvedSales.get("xbox")?.get(key);
        const revenuePs5 = ps5 ? (ps5Sales?.revenueMidUsd ?? 0) : 0;
        const revenueXbox = xbox ? (xboxSales?.revenueMidUsd ?? 0) : 0;
        const usedIpOverride = [ps5Sales, xboxSales].some(r => r?.dataSource === "derived_from_steam_ip_override");
        const usedFallback = [ps5Sales, xboxSales].some(r => r?.dataSource === "estimated_console_exclusive");
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
          name: (steam?.name || ps5?.name || xbox?.name || key) as string,
          coverUrl: steam?.coverUrl || ps5?.coverUrl || xbox?.coverUrl || null,
          releaseDate: steam?.releaseDate || ps5?.releaseDate || xbox?.releaseDate || null,
          // steamTitleId is now optional on the wire; consumers should not
          // assume every multiplatform row has a Steam SKU. When absent, no
          // Steam PDP link exists for this row.
          steamTitleId: steam?.titleId as number | undefined,
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
      console.log(`[multiplatform-leaderboard] window=${window} candidates=${multiRows.length} returned=${trimmed.length} overlayRatio=${overlayRatioCount} overlayIp=${overlayIpCount} exclusiveFallback=${exclusiveFallbackCount} noSteamAnchored=${noSteamAnchoredCount} xboxFilteredNoName=${filteredMissingSteam}`);

      // Latest data date across ANY platform — the multiplatform board
      // pulls from all three, so we show the maximum capture_date across
      // the store_rating_signal_daily table so the banner note reflects
      // the freshest input feeding this view.
      let latestCaptureDate: string | null = null;
      try {
        const latestRow = rawSqlite.prepare(
          `SELECT MAX(capture_date) AS d FROM store_rating_signal_daily`,
        ).get() as { d: string | null } | undefined;
        latestCaptureDate = latestRow?.d ?? null;
      } catch (latestErr: any) {
        console.log(`[multiplatform-leaderboard-latest] lookup failed: ${latestErr?.message ?? latestErr}`);
      }

      res.json({
        window,
        cascade,
        count: trimmed.length,
        candidatesCount: multiRows.length,
        titles: trimmed,
        revenueSummary: { ...revenueSummary(trimmed, window), calibration: dailyMixStatus(rawSqlite) },
        latestCaptureDate,
        refreshCronUtc: "09:15",
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
  //       { titleId, revenueUsd, unitsMid, ownersMid, windowUsed, msrpUsdCents,
  //         source: "anchor"|"overlay"|"raw" },
  //     combinedRevenueUsd,
  //     combinedUnits,
  //     combinedOwners,
  //     igdb: same nested blob as /api/console/titles/:titleId (parent header),
  //     window,
  //   }
  //
  // Revenue is computed with the SAME overlay pipeline as the leaderboard.
  app.get("/api/console/multiplatform-title/:key", async (req, res) => {
    try {
      const key = decodeURIComponent(req.params.key || "");
      if (!key) return res.status(400).json({ error: "invalid key" });
      const window = ((req.query.window as string) || "d7").toLowerCase();
      if (!["d7","d30","d90","m12","ltd"].includes(window)) return res.status(400).json({ error: "invalid window" });

      const cascade = SALES_CASCADE[window];
      const cascadeUnitsExpr = cascade.map((w, i) => `w${i}.units_mid`).reduce((a, e) => `COALESCE(${a}, ${e})`);
      const cascadeOwnersExpr = cascade.map((w, i) => `w${i}.owners_mid`).reduce((a, e) => `COALESCE(${a}, ${e})`);
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
            WHEN psm.platform = 'xbox' THEN CASE WHEN xtc.source = 'seeded_from_cti' AND console_identity_matches(igdb.store_name, xtc.name) = 0 THEN COALESCE(NULLIF(igdb.store_name, ''), xtc.name) ELSE xtc.name END
            WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
              THEN COALESCE(NULLIF(igdb.store_name, ''), NULLIF(igdb.name, ''))
            ELSE COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, ''))
          END AS name,
          CASE
            WHEN psm.platform = 'xbox' THEN xtc.art_url
            WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
              THEN COALESCE(NULLIF(igdb.store_header_image_url, ''), NULLIF(igdb.cover_url, ''))
            ELSE COALESCE(NULLIF(igdb.cover_url, ''), NULLIF(igdb.store_header_image_url, ''))
          END AS coverUrl,
          ${cascadeUnitsExpr} AS unitsMid,
          ${cascadeOwnersExpr} AS ownersMid,
          ${cascadeWindowExpr} AS windowUsed
        FROM platform_sku_map psm
        LEFT JOIN console_title_igdb igdb ON igdb.title_id = psm.title_id
        LEFT JOIN xbox_title_cache  xtc  ON psm.platform = 'xbox' AND xtc.big_id = psm.external_sku
        ${cascadeJoins}
        WHERE psm.platform IN ('steam','ps5','xbox')
          AND psm.business_model = 'paid'
          AND psm.sku_role = 'base'
          -- Xbox integrity gate (2026-09-12): filter Xbox rows with no xtc entry
          AND (psm.platform <> 'xbox' OR xtc.name IS NOT NULL)
          -- Unreleased-title filter (2026-09-13): mirrors per-platform routes.
          -- See leaderboards listing route above for full rationale.
          AND (
            (igdb.release_date IS NULL AND igdb.store_release_date IS NULL)
            OR date(
                 CASE
                   WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
                     THEN COALESCE(igdb.store_release_date, igdb.release_date)
                   ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                 END
               ) <= date('now')
          )
      `).all() as Array<{ titleId: number; platform: Platform; msrpUsdCents: number | null; name: string | null; coverUrl: string | null; unitsMid: number | null; ownersMid: number | null; windowUsed: string | null }>;

      // Filter to this key.
      const matching = uniquePlatformTitles(rows.filter(r => editionGroupKey(r.name) === key));
      if (matching.length === 0) return res.status(404).json({ error: "key not found" });

      const skuList = matching.map(({titleId,platform,name,coverUrl}) => ({titleId,platform,name,coverUrl}));
      // Pick a display name (prefer Steam SKU's name).
      const steamSku = skuList.find(s => s.platform === "steam") ?? skuList[0];
      const displayName = steamSku?.name ?? key;

      type PerPlatOut = { titleId: number; revenueUsd: number | null; unitsMid: number | null; ownersMid: number | null; windowUsed: string | null; msrpUsdCents: number | null; source: "anchor" | "overlay" | "raw"; aspUsdCents?: number | null; unitsMidEstimated?: number | null; unitSource?: string; dataSource?: string };
      const out: Partial<Record<Platform, PerPlatOut>> = {};
      for (const platform of PLATFORMS) {
        const members = matching.filter(r => r.platform === platform);
        if (!members.length) continue;
        const canonical = platformSales(platform, window).titles.find(r => r.editionGroupKey === key);
        out[platform] = {
          titleId: canonical?.titleId ?? members[0].titleId,
          msrpUsdCents: canonical?.msrpUsdCents ?? members[0].msrpUsdCents,
          ownersMid: members.some(r => r.ownersMid != null)
            ? members.reduce((n,r) => n + (r.ownersMid ?? 0),0) : null,
          revenueUsd: canonical?.revenueMidUsd ?? null,
          unitsMid: canonical?.unitsMid ?? null,
          unitsMidEstimated: canonical?.unitsMidEstimated ?? null,
          aspUsdCents: canonical?.aspUsdCents ?? null,
          unitSource: canonical?.unitSource ?? "unavailable",
          windowUsed: canonical?.windowUsed ?? null,
          dataSource: canonical?.dataSource ?? "unavailable",
          source: canonical?.dataSource === "actual" ? "anchor"
            : canonical?.dataSource?.startsWith("derived_from_steam") ? "overlay" : "raw",
        };
      }
      const combinedRevenueUsd = (out.steam?.revenueUsd ?? 0) + (out.ps5?.revenueUsd ?? 0) + (out.xbox?.revenueUsd ?? 0);
      const parts = Object.values(out);
      const combinedUnits = parts.every(p => p.unitsMid != null)
        ? parts.reduce((sum, p) => sum + p.unitsMid!, 0) : null;
      const ownerParts = [out.steam?.ownersMid, out.ps5?.ownersMid, out.xbox?.ownersMid].filter((n): n is number => n != null);
      const combinedOwners = ownerParts.length > 0 ? ownerParts.reduce((a, b) => a + b, 0) : null;
      const familyRevenueSummary = revenueSummary([{
        revenueSteam: out.steam?.revenueUsd ?? 0,
        revenuePs5: out.ps5?.revenueUsd ?? 0,
        revenueXbox: out.xbox?.revenueUsd ?? 0,
      }], window);

      // Pull IGDB detail from the Steam SKU when we have one; otherwise
      // fall back to the highest-revenue console SKU that has an IGDB row.
      const preferredTitleId = steamSku?.titleId ?? matching[0].titleId;
      const igdb = rawSqlite.prepare(`
        SELECT igdb_id AS igdbId, slug, name, summary, release_date AS releaseDate,
               cover_url AS coverUrl, artwork_url AS artworkUrl,
               screenshots_json AS screenshotsJson, genres_json AS genresJson,
               themes_json AS themesJson, platforms_json AS platformsJson,
               developers_json AS developersJson, publishers_json AS publishersJson,
               rating, rating_count AS ratingCount, refreshed_at AS refreshedAt,
               store_name AS storeName, store_header_image_url AS storeHeaderImageUrl,
               store_release_date AS storeReleaseDate, match_confidence AS matchConfidence
          FROM console_title_igdb WHERE title_id = ?
      `).get(preferredTitleId) as Record<string, any> | undefined;

      // JSON columns. Nested `igdb` matches /api/console/titles/:titleId so the
      // combined PDP can reuse the parent-title header without a second fetch.
      const parsedIgdb = safeTitleMetadata(
        igdb,
        Boolean(igdb?.name && editionGroupKey(igdb.name) !== key),
      );

      const platforms: Platform[] = [];
      if (out.steam) platforms.push("steam");
      if (out.ps5)   platforms.push("ps5");
      if (out.xbox)  platforms.push("xbox");
      const covers = await portraitCandidates(parsedIgdb?.name ?? displayName, parsedIgdb?.coverUrl ?? null, preferredTitleId);
      if (parsedIgdb) parsedIgdb.coverUrl = covers[0] ?? null;

      res.json({
        editionGroupKey: key,
        name: parsedIgdb?.name ?? displayName,
        coverUrl: covers[0] ?? null,
        portraitCandidates: covers,
        artworkUrl: parsedIgdb?.artworkUrl ?? null,
        screenshots: parsedIgdb?.screenshots ?? null,
        genres: parsedIgdb?.genres ?? null,
        themes: parsedIgdb?.themes ?? null,
        developers: parsedIgdb?.developers ?? null,
        publishers: parsedIgdb?.publishers ?? null,
        summary: parsedIgdb?.summary ?? null,
        releaseDate: parsedIgdb?.releaseDate ?? null,
        igdb: parsedIgdb,
        platforms,
        perPlatform: out,
        combinedRevenueUsd,
        combinedUnits,
        combinedOwners,
        revenueSummary: { ...familyRevenueSummary, calibration: dailyMixStatus(rawSqlite) },
        window,
        cascade,
        skus: skuList,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/console/titles/:titleId", async (req, res) => {
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
               rating, rating_count AS ratingCount, refreshed_at AS refreshedAt,
               store_name AS storeName, store_header_image_url AS storeHeaderImageUrl,
               store_release_date AS storeReleaseDate, match_confidence AS matchConfidence
          FROM console_title_igdb WHERE title_id = ?
      `).get(titleId) as Record<string, any> | undefined;

      // Xbox override (2026-09-12): xbox_title_cache is the source of truth
      // for Xbox name/art. Look it up per Xbox SKU under this title_id and,
      // if we have one, prefer its name/art for the PDP header. Multiple
      // Xbox SKUs under one title_id (which shouldn't happen, but historic
      // collisions may leave that shape) → prefer the earliest-landed one.
      const xboxSkus = skus.filter(s => s.platform === "xbox").map(s => s.externalSku as string);
      const xboxCache = xboxSkus.length > 0 ? rawSqlite.prepare(
        `SELECT big_id, name, art_url, source, first_landed_at
           FROM xbox_title_cache
          WHERE big_id IN (${xboxSkus.map(() => "?").join(",")})
          ORDER BY first_landed_at ASC LIMIT 1`,
      ).get(...xboxSkus) as { big_id: string; name: string; art_url: string | null; source: string } | undefined : undefined;
      // Historical CTI seeds were enrichment, not storefront verification.
      // Do not let a frozen bad seed override the exact SKU's store identity.
      if (xboxCache?.source === "seeded_from_cti" && igdb?.storeName &&
          !metadataMatchesStorefront(igdb.storeName, xboxCache.name)) {
        xboxCache.name = igdb.storeName;
        xboxCache.art_url = igdb.storeHeaderImageUrl ?? null;
      }

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
      const cascade = SALES_CASCADE[window];

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

      // One KPI card per platform. Units/owners live at (title_id, platform),
      // not per SKU: PSN ratings are concept-level (lessons.md 2026-09-15),
      // so Standard and Deluxe of the same title share one units_mid. Mapping
      // every SKU produced duplicate cards with identical units/owners and
      // different revenues (Wolverine base $69.99 vs deluxe $79.99 both showed
      // 790,326 units). Pick sku_role='base' per platform; if none, lowest MSRP.
      // Edition SKUs remain on the `skus` array for the SKU list; they just
      // don't mint their own KPI tile.
      const skuForKpiByPlatform = new Map<string, (typeof skus)[number]>();
      for (const sku of skus) {
        const prev = skuForKpiByPlatform.get(sku.platform as string);
        if (!prev) {
          skuForKpiByPlatform.set(sku.platform as string, sku);
          continue;
        }
        const prevIsBase = prev.skuRole === "base";
        const curIsBase = sku.skuRole === "base";
        if (curIsBase && !prevIsBase) {
          skuForKpiByPlatform.set(sku.platform as string, sku);
          continue;
        }
        if (curIsBase === prevIsBase) {
          const prevMsrp = typeof prev.msrpUsdCents === "number" ? prev.msrpUsdCents : Number.POSITIVE_INFINITY;
          const curMsrp = typeof sku.msrpUsdCents === "number" ? sku.msrpUsdCents : Number.POSITIVE_INFINITY;
          if (curMsrp < prevMsrp) skuForKpiByPlatform.set(sku.platform as string, sku);
        }
      }

      const windowKpisPerPlatform = Array.from(skuForKpiByPlatform.values()).map((sku) => {
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

      // Detail KPIs must use the very same final family/platform revenue and
      // units as its leaderboard row, not an independent pre-anchor estimate.
      for (const kpi of windowKpisPerPlatform) {
        const sales = platformSales(kpi.platform, window);
        const canonical = sales.titles.find(r => r.familyTitleIds.includes(titleId));
        Object.assign(kpi, {
          revenueMidUsd: canonical?.revenueMidUsd ?? null,
          unitsMid: canonical?.unitsMid ?? null,
          unitsMidEstimated: canonical?.unitsMidEstimated ?? null,
          aspUsdCents: canonical?.aspUsdCents ?? null,
          unitSource: canonical?.unitSource ?? "unavailable",
          dataSource: canonical?.dataSource ?? "unavailable",
          windowUsed: canonical?.windowUsed ?? null,
          cascade: sales.cascade,
          gatedReason: canonical?.revenueMidUsd != null ? null : kpi.gatedReason ?? "no_estimate",
        });
      }

      // Parse JSON columns, applying the same match_confidence fallback the
      // leaderboard routes already use (see routes-console-leaderboards.ts
      // single-platform query comment, ~line 600). When IGDB's name search
      // matched the wrong game (match_confidence='low', set by
      // refreshIgdbForTitle's release-date sanity check), name/coverUrl/
      // releaseDate fall back to the storefront-truthed store_name /
      // store_header_image_url / store_release_date columns. Descriptive
      // fields with no store-truthed equivalent (summary, developers,
      // publishers, genres, themes, screenshots) are suppressed rather than
      // shown from the wrong game — this is exactly the bug reported
      // 2026-09-19: Steam SKU 3219630 "Halloween: The Game" PDP showed
      // "Solitaire Game Halloween 2" title, cover, and credits because this
      // route returned igdb.* unconditionally while the leaderboard list
      // (which already had this fallback) showed the correct name.
      const parsedIgdb = safeTitleMetadata(igdb);
      const covers = await portraitCandidates(xboxCache?.name ?? parsedIgdb?.name ?? null,
        parsedIgdb?.coverUrl ?? xboxCache?.art_url ?? null, titleId);
      if (parsedIgdb) parsedIgdb.coverUrl = covers[0] ?? null;

      res.json({
        titleId,
        portraitCandidates: covers,
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

  // ─── Estimated daily revenue (all platforms) ──────────────────────────────
  //
  // Derives per-day incremental revenue from day-over-day change in the LTD
  // unit accumulator (window_estimates_daily where window='ltd'), priced with
  // the primary SKU MSRP × ASP factor for each platform.
  //
  //   dailyRevenue[D, p] = max(0, unitsMid_ltd[D, p] - unitsMid_ltd[D-1, p])
  //                        × msrp_usd_cents(p) × aspFactor(p) / 100
  //
  // Only positive deltas produce revenue (the accumulator is monotonic, so
  // negative diffs only appear when an override anchor was seeded — those
  // days should not be treated as revenue events). Combined = steam+ps5+xbox.
  //
  // Data-collection start: 2026-09-14 (title_ltd_state introduced). Dates
  // before that in a requested window are returned as null.
  app.get("/api/console/titles/:titleId/revenue-daily", (req, res) => {
    try {
      const titleId = parseInt(req.params.titleId, 10);
      if (!Number.isFinite(titleId)) return res.status(400).json({ error: "invalid titleId" });
      const to = parseDate(req.query.to as string | undefined, todayIsoDate());
      const from = parseDate(req.query.from as string | undefined, daysAgo(90));
      const COLLECTION_START = "2026-09-14";

      // Cross-platform sibling resolution (2026-09-16). This endpoint powers
      // the PDP's "Estimated daily revenue · all platforms" chart, which is
      // per-title × three-platform by design. In the DB each store SKU is
      // its own title_id, so "Onimusha: Way of the Sword" lives as
      // steam=10011, ps5=10304, xbox=10407 — three rows, one per platform.
      // Without sibling resolution the chart shows one platform's line only
      // (whichever titleId was in the URL), which reads as "broken".
      //
      // Resolution mirrors the multiplatform leaderboard's editionGroupKey
      // join: get the requested title's display name via the same rule
      // (xbox_title_cache for xbox rows, console_title_igdb name/store_name
      // per match_confidence otherwise), then find every base+paid SKU
      // whose title's display name resolves to the same editionGroupKey.
      // We keep the requested titleId in the response envelope (its route
      // still owns the PDP) but broaden the two SQL queries below to the
      // sibling set. Single-platform titles with no siblings degrade to the
      // previous behavior (one platform, chart draws one line).
      const seedNameRow = rawSqlite.prepare(`
        SELECT DISTINCT
          CASE
            WHEN psm.platform = 'xbox' THEN CASE WHEN xtc.source = 'seeded_from_cti' AND console_identity_matches(igdb.store_name, xtc.name) = 0 THEN COALESCE(NULLIF(igdb.store_name, ''), xtc.name) ELSE xtc.name END
            WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
              THEN COALESCE(NULLIF(igdb.store_name, ''), NULLIF(igdb.name, ''))
            ELSE COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, ''))
          END AS name
        FROM platform_sku_map psm
        LEFT JOIN console_title_igdb igdb ON igdb.title_id = psm.title_id
        LEFT JOIN xbox_title_cache  xtc  ON psm.platform = 'xbox' AND xtc.big_id = psm.external_sku
        WHERE psm.title_id = ?
        LIMIT 1
      `).get(titleId) as { name: string | null } | undefined;
      const seedKey = editionGroupKey(seedNameRow?.name ?? null);

      // If we can't resolve a key, fall back to the requested titleId only.
      // sibs is guaranteed to contain the requested titleId.
      let siblingIds: number[] = [titleId];
      if (seedKey) {
        const sibRows = rawSqlite.prepare(`
          SELECT DISTINCT psm.title_id AS titleId,
            CASE
              WHEN psm.platform = 'xbox' THEN CASE WHEN xtc.source = 'seeded_from_cti' AND console_identity_matches(igdb.store_name, xtc.name) = 0 THEN COALESCE(NULLIF(igdb.store_name, ''), xtc.name) ELSE xtc.name END
              WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
                THEN COALESCE(NULLIF(igdb.store_name, ''), NULLIF(igdb.name, ''))
              ELSE COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, ''))
            END AS name
          FROM platform_sku_map psm
          LEFT JOIN console_title_igdb igdb ON igdb.title_id = psm.title_id
          LEFT JOIN xbox_title_cache  xtc  ON psm.platform = 'xbox' AND xtc.big_id = psm.external_sku
          WHERE psm.platform IN ('steam','ps5','xbox')
            AND psm.business_model = 'paid'
            AND psm.sku_role = 'base'
        `).all() as Array<{ titleId: number; name: string | null }>;
        const matched = new Set<number>([titleId]);
        for (const r of sibRows) {
          if (editionGroupKey(r.name) === seedKey) matched.add(r.titleId);
        }
        siblingIds = Array.from(matched);
      }
      const idPlaceholders = siblingIds.map(() => "?").join(",");

      // Pull LTD units + method per platform per day across the sibling set.
      // Method is needed so we can suppress the first-day accumulator
      // initialization spike: when the LTD engine first switches from a pure
      // bootstrap tag to an `ltd_state:derived_max_windows` or
      // `ltd_state:accumulator` tag, the resulting units_mid jumps by orders
      // of magnitude in a single day, and treating that delta as revenue
      // produces cartoon-scale numbers (e.g. Wolverine's Sep 14→15 diff of
      // 317,653 units × PS5 MSRP shows a $17.8M single-day revenue point
      // that never happened).
      //
      // If two sibling titleIds happen to share a platform (should not
      // happen for base+paid SKUs post-Push 2, but the multiplatform join
      // guards against it too), we keep both rows and let the per-platform
      // grouping below use whichever set is non-null on the same date. In
      // practice sibling sets are one-titleId-per-platform.
      const rows = rawSqlite.prepare(`
        SELECT platform, as_of_date AS date, units_mid AS units, method
          FROM window_estimates_daily
         WHERE title_id IN (${idPlaceholders}) AND window = 'ltd'
           AND as_of_date >= ? AND as_of_date <= ?
         ORDER BY platform, as_of_date
      `).all(...siblingIds, from, to) as Array<{ platform: Platform; date: string; units: number | null; method: string | null }>;

      // Primary SKU MSRP per platform across the sibling set (lowest-priced
      // anchor SKU on each platform, regardless of which sibling titleId
      // owns it).
      const skuRows = rawSqlite.prepare(`
        SELECT platform, MIN(msrp_usd_cents) AS msrp_usd_cents
          FROM platform_sku_map
         WHERE title_id IN (${idPlaceholders}) AND msrp_usd_cents IS NOT NULL
         GROUP BY platform
      `).all(...siblingIds) as Array<{ platform: Platform; msrp_usd_cents: number | null }>;
      const msrpByPlatform: Partial<Record<Platform, number>> = {};
      for (const r of skuRows) if (r.msrp_usd_cents != null) msrpByPlatform[r.platform] = r.msrp_usd_cents;

      // Group by platform, then compute day-over-day diff.
      const byPlatform: Partial<Record<Platform, Array<{ date: string; units: number | null; method: string | null }>>> = {};
      for (const r of rows) {
        const arr = byPlatform[r.platform] ?? (byPlatform[r.platform] = []);
        arr.push({ date: r.date, units: r.units, method: r.method });
      }

      // Suppression rules for accumulator initialization jumps. The
      // /api/console/titles/:titleId/revenue-daily route derives per-day
      // revenue from day-over-day change in `window_estimates_daily`
      // where `window='ltd'`. The signal for a real 24-hour sales event
      // is a modest delta consistent with the trailing rate. The signal
      // for an accumulator initialization is a huge one-day jump the
      // first time the LTD engine transitions from a bootstrap-only
      // method tag (no `ltd_state:` suffix) to an accumulator tag
      // (`ltd_state:derived_max_windows` / `ltd_state:accumulator`).
      //
      // We can't suppress the method transition day unconditionally:
      // most titles' bootstrap value tracks the real accumulator value
      // closely (Valheim's Sep 15 accumulator delta was 5,052 units, in
      // line with 5k/day bootstrap growth). We only suppress when the
      // transition-day delta is BOTH abnormally large AND coincident
      // with the method flip. Two layered rules:
      //   Rule A: outlier guard — once we have >=2 prior accepted
      //     positive deltas on a platform, suppress a new delta that
      //     exceeds 20× the median of the trailing 7-day window.
      //   Rule B: method-transition outlier — on the first day the
      //     engine flips from bootstrap-only to accumulator, if we have
      //     any prior accepted positive deltas, suppress if the flip-day
      //     delta exceeds 20× the max of prior deltas.
      // Wolverine (Sep 14=1,926 bootstrap; Sep 15=319,579 accumulator)
      // trips Rule B (max prior delta on Sep 15 is bootstrap increment;
      // 319,577 ≫ 20× max_prior). Valheim (Sep 14=60,853 bootstrap; Sep
      // 15=65,905 accumulator) trips neither and renders normally.
      const isAccumulatorMethod = (m: string | null): boolean =>
        !!m && m.includes("ltd_state:");
      const isBootstrapOnlyMethod = (m: string | null): boolean =>
        !!m && !m.includes("ltd_state:");

      // Union of all dates across platforms in range.
      const dateSet = new Set<string>();
      for (const p of Object.keys(byPlatform) as Platform[]) {
        for (const row of byPlatform[p] ?? []) dateSet.add(row.date);
      }
      const dates = Array.from(dateSet).sort();

      // For each platform, compute incremental revenue for each date.
      const dailyByPlatform: Partial<Record<Platform, Record<string, number | null>>> = {};
      for (const p of Object.keys(byPlatform) as Platform[]) {
        const arr = byPlatform[p] ?? [];
        const msrpCents = msrpByPlatform[p];
        const aspFactor = aspFactorFor(p);
        const dailyRev: Record<string, number | null> = {};
        // All positive deltas we've accepted so far on this platform,
        // used by both outlier rules below. Bootstrap-era deltas count
        // toward this baseline so a real accumulator jump on the flip
        // day has something to be compared against.
        const rollingDeltas: number[] = [];
        let prev: number | null = null;
        let prevMethod: string | null = null;
        for (const row of arr) {
          if (row.date < COLLECTION_START) {
            dailyRev[row.date] = null;
            prev = row.units;
            prevMethod = row.method;
            continue;
          }
          const cur = row.units;
          if (prev == null || cur == null || msrpCents == null) {
            dailyRev[row.date] = null;
          } else {
            const deltaUnits = Math.max(0, cur - prev);
            const isTransitionDay =
              isBootstrapOnlyMethod(prevMethod) && isAccumulatorMethod(row.method);

            let suppress = false;

            if (deltaUnits > 0) {
              // Rule A: general outlier guard. Once we have >=2 prior
              // accepted positive deltas, suppress a new delta that
              // exceeds 20x the median of the trailing 7-day window.
              if (rollingDeltas.length >= 2) {
                const recent = rollingDeltas.slice(-7).slice().sort((a, b) => a - b);
                const median = recent[Math.floor(recent.length / 2)];
                if (median > 0 && deltaUnits > 20 * median) {
                  suppress = true;
                }
              }

              // Rule B: method-transition outlier. On the flip from
              // bootstrap-only to accumulator, suppress only if the
              // flip-day delta is >20x the MAX of prior accepted deltas.
              // Distinguishes Wolverine-style init jumps from Valheim-
              // style clean handovers where bootstrap already tracked
              // the real value.
              if (!suppress && isTransitionDay && rollingDeltas.length >= 1) {
                const maxPrior = Math.max(...rollingDeltas);
                if (maxPrior > 0 && deltaUnits > 20 * maxPrior) {
                  suppress = true;
                }
              }
            }

            if (suppress) {
              dailyRev[row.date] = null;
            } else {
              const rev = (deltaUnits * msrpCents * aspFactor) / 100;
              dailyRev[row.date] = rev;
              if (deltaUnits > 0) rollingDeltas.push(deltaUnits);
            }
          }
          prev = cur;
          prevMethod = row.method;
        }
        dailyByPlatform[p] = dailyRev;
      }

      const recordedDaily = publishedDailyRevenue(rawSqlite,dailyMixPolicy(),seedKey,from,to);
      for (const d of Array.from(recordedDaily.keys())) if(!dates.includes(d)) dates.push(d);
      dates.sort();
      const points = dates.map((d) => {
        const recorded = recordedDaily.get(d);
        if(recorded) {
          const [steam,ps5,xbox]=recorded;
          return {date:d,steam,ps5,xbox,combined:steam+ps5+xbox,source:"daily_mix_ledger"};
        }
        const steam = dailyByPlatform.steam?.[d] ?? null;
        const ps5   = dailyByPlatform.ps5?.[d]   ?? null;
        const xbox  = dailyByPlatform.xbox?.[d]  ?? null;
        const parts = [steam, ps5, xbox].filter((v): v is number => typeof v === "number");
        const combined = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
        return { date: d, steam, ps5, xbox, combined, source:"raw_daily_estimator" };
      });

      res.json({ titleId, from, to, collectionStart: COLLECTION_START, points,
        methodology:"Recorded eligible days use the daily platform-mix ledger. Earlier or ineligible days retain the raw daily estimator; no pre-activation history is reallocated." });
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
