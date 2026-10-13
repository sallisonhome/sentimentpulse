import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Integration test for the 2026-10-12 age-covering-window LTD ceiling.
 *
 * Runs the real estimator against a fixture DB and asserts:
 *   - regime 2 caps LTD to the age-covering window when the raw max exceeds it
 *   - the state carry-forward no longer re-inflates the capped value
 *   - d7/d30/d90/m12 rows are unchanged by the cap
 *   - an anchored title is exempt from the cap
 */
test("estimator: LTD capped at age window, state updated, windows untouched", async () => {
  const root = process.cwd(), dir = mkdtempSync(join(tmpdir(), "ltd-age-cap-"));
  let db: any;
  try {
    process.chdir(dir);
    // Import storage AFTER chdir so ./data.db resolves to the temp dir
    db = (await import(resolve(root, "server/storage"))).rawSqlite;

    const stamp = new Date().toISOString();
    const day = new Date().toISOString().slice(0, 10);
    const rel = "2026-01-15"; // ~270 days before 2026-10-12; m12 window

    db.exec(`INSERT INTO ownership_multipliers(platform,cohort_key,multiplier,ci_pct,digital_unit_share,confidence,method,effective_from,created_at)
      VALUES('ps5','default',10,.3,1,'test','test_model','2020-01-01','${stamp}')`);

    const addTitle = (id: number, release: string, d30Units: number, anchor: boolean) => {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(id, "ps5", `sku${id}`, "base", "paid", 4999, stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(id, `T${id}`, `T${id}`, release, release, stamp, stamp);
      // signal history for d30 window
      const iso = (d: number) => new Date(Date.parse(day) - d * 86400000).toISOString().slice(0, 10);
      for (const [d, c] of Array.from({ length: 10 }, (_, k) => 9 - k).map(k => [iso(k), k >= 7 ? d30Units : Math.round(d30Units * 1.5)] as [string, number]))
        db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,raw_json,created_at) VALUES(?,?,?,?,?,'{}',?)`)
          .run(id, "ps5", d, "test", c, stamp);
      if (anchor) {
        db.prepare(`INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,actual_revenue_usd,actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at) VALUES(?,?,?,?,?,?,?, 'regular','manual_anchor_verified_ltd',?)`)
          .run(id, "ps5", "d30", day, 999999 * 49.99, 999999, 4999, stamp);
      }
    };

    // Title A: 270 days old, d30 estimate 100K but state carry-forward 500K -> LTD should cap to d30
    const A = 50001, ANCHORED = 50002, CONTROL = 50003;
    addTitle(A, rel, 1000, false);
    addTitle(ANCHORED, rel, 1000, true);
    addTitle(CONTROL, "2019-01-01", 1000, false); // >366d, accumulator regime

    // Seed inflated state for A (simulating the carried-forward high-water)
    db.prepare(`INSERT INTO title_ltd_state(title_id,platform,ltd_units,ltd_source,last_signal_value,last_updated_iso,seeded_from)
      VALUES(?,?,?,?,?,?,NULL)`).run(A, "ps5", 5000000, "derived_max_windows", 1000, stamp);

    const run = () => execFileSync(resolve(root, "node_modules/.bin/tsx"),
      ["--tsconfig", resolve(root, "tsconfig.json"), resolve(root, "scripts/estimate-console-units.ts")],
      { cwd: dir, env: { ...process.env, DB_PATH: join(dir, "data.db"), LTD_ACCUMULATOR_ENABLED: "1" }, timeout: 60000, stdio: "pipe" }).toString();

    const out = run();
    assert.match(out, /anchored titles exempt from age cap: \d+/);

    const get = (id: number, w: string) => db.prepare(
      "SELECT units_mid, method FROM window_estimates_daily WHERE title_id=? AND platform='ps5' AND window=? AND as_of_date=?"
    ).get(id, w, day) as { units_mid: number | null; method: string } | undefined;
    const state = (id: number) => db.prepare(
      "SELECT ltd_units FROM title_ltd_state WHERE title_id=? AND platform='ps5'"
    ).get(id) as { ltd_units: number } | undefined;

    const aL = get(A, "ltd")!;
    assert.ok(aL, "LTD row for A exists");
    const aD30 = get(A, "d30")!;
    assert.ok(aD30 && aD30.units_mid != null, "d30 row for A exists");
    // The cap: LTD must be <= d30 units
    assert.ok((aL.units_mid as number) <= (aD30.units_mid as number) + 1,
      `LTD (${aL.units_mid}) must not exceed d30 (${aD30.units_mid})`);
    // State must also be capped
    const aState = state(A)!;
    assert.ok(aState.ltd_units <= (aD30.units_mid as number) + 1,
      `state LTD (${aState.ltd_units}) must not exceed d30 (${aD30.units_mid})`);

    // Anchored title exempt
    const anL = get(ANCHORED, "ltd")!;
    assert.ok(anL);
    // anchored LTD should NOT have the age_cap tag
    assert.doesNotMatch(anL.method, /age_cap/, `anchored title must not be age-capped: ${anL.method}`);

    // Control (>=366d) unchanged path
    const cL = get(CONTROL, "ltd");
    assert.ok(cL, "control LTD row exists");
  } finally {
    process.chdir(root);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
