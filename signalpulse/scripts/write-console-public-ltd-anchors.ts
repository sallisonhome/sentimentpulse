/**
 * write-console-public-ltd-anchors.ts     rev 2026-10-13
 *
 * Writes manual_anchor_verified_ltd rows into revenue_calibration_anchors
 * for aged Sony first-party PS5 SKUs whose estimator LTD is inflated by the
 * 32-day linear-extrapolation (backfill-observed-pace) and the Steam×9 IP
 * override. Each anchor carries a researched public lifetime figure, its
 * source and date, and the platform-split assumption used to scale the
 * all-platform figure to the PS5 SKU.
 *
 * Why anchors and not a read-side guard: verified LTD anchors win on Path A
 * above every read-side pass (Steam×9 IP override, chart consistency, public
 * ceilings, daily mix), scale the shorter windows proportionally via the
 * units-based ratio in routes-console-leaderboards.ts, and are grown by
 * anchorLifetimeGrowth from the observed daily ratings. That is the durable
 * "public anchor + AAA curve + ratings blend" the user approved on 2026-10-13.
 *
 * Each row records:
 *  - actual_units: the researched public figure scaled to the PS5 SKU
 *  - actual_revenue_usd: actual_units × current MSRP (a defensible floor; the
 *    lifetime ASP includes historical discounting but MSRP is the honest
 *    upper bound we can defend without a price history)
 *  - reference_msrp_usd_cents from platform_sku_map
 *  - data_source: 'manual_anchor_verified_public_lifetime_v1' (the
 *    manual_anchor_verified_ prefix is what makes the anchor win on Path A
 *    for PS5 rows — see routes-console-leaderboards.ts)
 *  - notes: the public source URL, the as-of date of the figure, and the
 *    platform-split assumption
 *
 * Idempotent per as_of_date: writes with ON CONFLICT ... DO UPDATE keyed on
 * (title_id, platform, window, as_of_date).
 *
 * DRY_RUN=1 prints the rows without writing. AS_OF_DATE=YYYY-MM-DD overrides.
 */

import { rawSqlite } from "../server/storage";

const DRY_RUN = process.env.DRY_RUN === "1";
const AS_OF = (() => {
  const raw = (process.env.AS_OF_DATE ?? "").trim();
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
})();

/**
 * A researched public lifetime anchor. Every field is mandatory so a future
 * maintainer can audit the provenance without re-doing the research.
 */
interface PublicLtdAnchor {
  titleId: number;
  platform: "ps5";
  /** Display name for the log line only. */
  name: string;
  /** The public figure, all platforms it covers. */
  publicUnits: number;
  /** The date the public figure was stated. */
  publicAsOf: string;
  /** Source URL for the public figure. */
  sourceUrl: string;
  /** Source publisher. */
  sourceName: string;
  /**
   * The fraction of the public figure attributable to this platform's SKU.
   * Documented assumption, not a measurement, unless the source states the
   * split explicitly.
   */
  platformShare: number;
  /** One-line justification for platformShare. */
  platformShareNote: string;
  /** Current MSRP in cents, from platform_sku_map. */
  msrpUsdCents: number;
}

// ─── Researched 2026-10-13. Every figure has a dated, linked source. ─────────
const ANCHORS: PublicLtdAnchor[] = [
  {
    titleId: 10370,
    platform: "ps5",
    name: "God of War Ragnarök",
    // Sony/Santa Monica: 15M units across PS4+PS5 as of 2023-11-19.
    publicUnits: 15_000_000,
    publicAsOf: "2023-11-19",
    sourceUrl: "https://www.kitguru.net/tech-news/mustafa-mahmoud/god-of-war-ragnarok-sells-15-million-copies-in-first-year/",
    sourceName: "Sony Interactive Entertainment / Santa Monica Studio (PlayStation Blog)",
    // Launch-week boxed split was 82% PS5 / 18% PS4 (GamesIndustry/VGC, UK).
    // Lifetime PS5 share likely trends higher as the PS4 base shrinks, but
    // 0.82 is the only dated, published split we can defend.
    platformShare: 0.82,
    platformShareNote: "launch-week boxed split 82% PS5 (UK, GamesIndustry/VGC); lifetime PS5 share assumed equal",
    msrpUsdCents: 6999,
  },
  {
    titleId: 11188,
    platform: "ps5",
    name: "The Last of Us Part I",
    // Alinea Analytics (2026-07-26): 6.3M total, PS5 55.4% / Steam 44.6%.
    publicUnits: 6_300_000,
    publicAsOf: "2026-07-26",
    sourceUrl: "https://x.com/superhys/status/2080374786744533256",
    sourceName: "Alinea Analytics (top remakes & remasters by copies sold)",
    platformShare: 0.554,
    platformShareNote: "Alinea states the split explicitly: PS5 55.4% / Steam 44.6%",
    msrpUsdCents: 6999,
  },
  {
    titleId: 11179,
    platform: "ps5",
    name: "The Last of Us Part II Remastered",
    // Fandom VG Sales Wiki: ~2M PS5 units for the Remastered SKU (2024).
    // Corroborated: ~2M during HBO S2 (Chris Colombo via GamingAmigos);
    // Steam PC port is a separate SKU (~1.1-1.2M, Alinea).
    // Not the 10M/15M Part II PS4 figure — that is a different SKU family.
    publicUnits: 2_000_000,
    publicAsOf: "2025-05-25",
    sourceUrl: "https://www.gamingamigos.com/post/the-last-of-us-part-2-sales-surge-season-2-hbo-show",
    sourceName: "Fandom VG Sales Wiki; corroborated by Chris Colombo (HBO S2 window)",
    platformShare: 1.0,
    platformShareNote: "the ~2M figure is PS5-only for the Remastered SKU; the PC port is a separate Steam SKU",
    msrpUsdCents: 4999,
  },
];

function main() {
  const stmt = rawSqlite.prepare(`
    INSERT INTO revenue_calibration_anchors
      (title_id, platform, window, as_of_date, actual_revenue_usd, actual_units,
       reference_msrp_usd_cents, sale_state, data_source, notes, created_at)
    VALUES (?, ?, 'ltd', ?, ?, ?, ?, 'baseline',
            'manual_anchor_verified_public_lifetime_v1', ?, ?)
    ON CONFLICT(title_id, platform, window, as_of_date) DO UPDATE SET
      actual_revenue_usd = excluded.actual_revenue_usd,
      actual_units = excluded.actual_units,
      reference_msrp_usd_cents = excluded.reference_msrp_usd_cents,
      sale_state = excluded.sale_state,
      data_source = excluded.data_source,
      notes = excluded.notes
  `);

  for (const a of ANCHORS) {
    const ps5Units = Math.round(a.publicUnits * a.platformShare);
    const revenueUsd = Math.round((ps5Units * a.msrpUsdCents) / 100);
    const notes = [
      `Public figure: ${a.publicUnits.toLocaleString()} units as of ${a.publicAsOf} (${a.sourceName}).`,
      `Source: ${a.sourceUrl}`,
      `Platform split: ${a.platformShareNote} → PS5 ${ps5Units.toLocaleString()} units.`,
      `Revenue = PS5 units × current MSRP ($${(a.msrpUsdCents / 100).toFixed(2)}) = $${revenueUsd.toLocaleString()}. ` +
        `This is an MSRP floor; the realized lifetime ASP includes discounting.`,
      `Estimator LTD before this anchor (as_of 2026-10-13): see window_estimates_daily. ` +
        `The anchor wins on Path A and scales d7/d30/d90/m12 by the units ratio; ` +
        `anchorLifetimeGrowth then grows it from the observed daily ratings.`,
    ].join(" ");

    if (DRY_RUN) {
      console.log(`[dry-run] ${a.titleId} ${a.platform} ltd ${AS_OF}: ` +
        `${ps5Units.toLocaleString()} units / $${revenueUsd.toLocaleString()}`);
    } else {
      stmt.run(a.titleId, a.platform, AS_OF, revenueUsd, ps5Units,
        a.msrpUsdCents, notes, new Date().toISOString());
      console.log(`[write] ${a.titleId} ${a.platform} ltd ${AS_OF}: ` +
        `${ps5Units.toLocaleString()} units / $${revenueUsd.toLocaleString()}`);
    }
  }

  if (!DRY_RUN) {
    console.log(`\nWrote ${ANCHORS.length} anchor rows. Verify on the served board:`);
    for (const a of ANCHORS) {
      console.log(`  /api/console/leaderboards/ps5?window=ltd — titleId ${a.titleId} should show ` +
        `dataSource='actual' with the anchored units.`);
    }
  }
}

main();
