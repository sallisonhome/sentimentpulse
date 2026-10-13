import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

/**
 * Validates the d90/m12 behavior of the native-model guard for the widened
 * registry (TLOU rows: d7/d30/d90/m12; GoW Ragnarök: d90/m12).
 *
 * Method: fixture the two TLOU PS5 rows with the actual production values
 * captured 2026-10-11 from the live estimator (`window_estimates_daily`
 * `units_mid` rows) and the actual Steam sibling revenues that drive the
 * Steam×9 IP override (titleId 11117 = Part I, 11116 = Part II Rem).
 *
 * Run the real leaderboard route against the fixture DB and assert the
 * production registry directly (the counterfactual widening was applied
 * 2026-10-13):
 *
 * 2026-10-13: the production registry covers three aged first-party rows.
 * TLOU Part I (11188) and TLOU Part II Remastered (11179) are guarded on
 * d7/d30/d90/m12. LTD is deliberately NOT guarded — the durable LTD fix is
 * the public-anchor + AAA-curve work (set LTD from researched public
 * lifetime sales, curve-derive windows, blend observed ratings pace), not a
 * read-side guard. God of War Ragnarök (10370) is guarded on d90/m12 ONLY —
 * the user's 2026-10-13 request scoped the fix to those windows. The test
 * uses Horizon Forbidden West (10446) as the non-target Sony first-party
 * control. Fixture values for 10370 PS5 come from window_estimates_daily
 * as_of 2026-10-13: d7 20,874 / d30 104,621 / d90 311,305 / m12 1,262,495 /
 * LTD 6,633,915. MSRP for the US SKU is 6999.
 *
 * 1. d90/m12 serve the native `revenueMidUsd` computed from
 *    `units_mid × (aspUsdCents / 100)` and `dataSource`
 *    = "native_model_guarded", replacing the Steam×9 derived value.
 * 2. d7/d30 behavior is unchanged.
 * 3. A non-target Sony title (Horizon, 10446) keeps the
 *    Steam×9 IP override path in every window — no leakage.
 * 4. Chart consistency and daily mix don't fire for d90/m12 (chart pass
 *    only runs for d7/d30; daily mix only for `derived_from_steam`).
 */

test("production registry: TLOU rows guarded on d7/d30/d90/m12, GoW Ragnarök on d90/m12 only, control title keeps Steam×9", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "tlou-wider-"));
  process.chdir(dir);
  let db: any;
  let server: any;
  try {
    db = (await import("./storage")).rawSqlite;

    // ── Guard: fixture the three target titles and one control ────────────
    const TLOU_TARGETS = [11188, 11179];
    const GOW_TARGET = 10370; // God of War Ragnarök (PS5)
    const ALL_TARGETS = [...TLOU_TARGETS, GOW_TARGET];
    const CONTROL = 10446; // Horizon Forbidden West (PS5) — non-target Sony first-party

    const ps5SkuRow = (id: number, sku: string, name: string, msrp: number) => {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,'ps5',?,?,'paid',?,?,?)`).run(id, sku, "base", msrp, "2026-10-11", "2026-10-11");
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,refreshed_at,created_at) VALUES(?,?,?,?)`).run(id, name, "2026-10-11", "2026-10-11");
    };

    ps5SkuRow(11188, "UP9000-PPSA03396_00-THELASTOFUSPART1", "The Last of Us™ Part I", 6999);
    ps5SkuRow(11179, "UP9000-PPSA10662_00-THELASTOFUSPART2", "The Last of Us™ Part II Remastered", 4999);
    ps5SkuRow(GOW_TARGET, "UP9000-PPSA08329_00-GOWRAGNAROK00000", "God of War Ragnarök", 6999);
    ps5SkuRow(CONTROL, "UP9000-PPSA12345_00-HORIZONFORBIDDEN", "Horizon Forbidden West", 5999);

    // ── Steam siblings: enough revenue to trip the Steam×9 IP override ────
    for (const [id, sku, name, msrp] of [
      [11117, "3490200", "The Last of Us Part I", 5999],
      [11116, "1888930", "The Last of Us Part II Remastered", 5999],
      [10369, "1593500", "God of War Ragnarök", 5999],
      [10445, "998970", "Horizon Forbidden West", 5999],
    ] as const) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,'steam',?,?,'paid',?,?,?)`).run(id, sku, "base", msrp, "2026-10-11", "2026-10-11");
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,refreshed_at,created_at) VALUES(?,?,?,?)`).run(id, name, "2026-10-11", "2026-10-11");
    }

    // ── window_estimates_daily rows: the actual captured production values ──
    // ps5 rows use the native estimator's `units_mid` (backfill-observed-pace
    // for d7/d30/d90/m12; ltd-anchor-median-v03+ltd_state:accumulator for LTD).
    // steam rows use Steam sibling revenue to drive the IP override.
    const WINDOWS = ["d7", "d30", "d90", "m12", "ltd"] as const;
    const PS5_UNITS: Record<number, Record<string, number>> = {
      11188: { d7: 26463, d30: 129379, d90: 388137, m12: 1574179, ltd: 4589935 },
      11179: { d7: 33316, d30: 163263, d90: 489789, m12: 1986379, ltd: 9787043 },
      [GOW_TARGET]: { d7: 20874, d30: 104621, d90: 311305, m12: 1262495, ltd: 6633915 },
      [CONTROL]: { d7: 8000, d30: 25000, d90: 70000, m12: 200000, ltd: 600000 },
    };
    // The aged-title ceiling clamps d90/m12 to a fraction of the fixture LTD.
    // See server/aged-title-ceilings.ts for the fractions.
    const AGED_CEILING_FRACTIONS: Record<number, Record<string, number>> = {
      11188: { d90: 0.0150, m12: 0.0200 },
      11179: { d90: 0.24, m12: 0.33 },
      [GOW_TARGET]: { d90: 0.0155, m12: 0.0206 },
    };
    const expectedServedUnits = (id: number, w: string): number => {
      const stored = PS5_UNITS[id][w];
      const frac = AGED_CEILING_FRACTIONS[id]?.[w];
      if (frac == null) return stored;
      return Math.min(stored, Math.round(PS5_UNITS[id].ltd * frac));
    };
    const PS5_METHOD: Record<number, Record<string, string>> = {
      11188: { d7: "backfill-observed-pace", d30: "backfill-observed-pace", d90: "backfill-observed-pace", m12: "backfill-observed-pace", ltd: "ltd-anchor-median-v03+ltd_state:accumulator" },
      11179: { d7: "backfill-observed-pace", d30: "backfill-observed-pace", d90: "backfill-observed-pace", m12: "backfill-observed-pace", ltd: "ltd-anchor-median-v03+ltd_state:accumulator" },
      [GOW_TARGET]: { d7: "ltd-anchor-median-v03", d30: "ltd-anchor-median-v03", d90: "backfill-observed-pace", m12: "backfill-observed-pace", ltd: "ltd-anchor-median-v03+ltd_state:accumulator" },
      [CONTROL]: { d7: "backfill-observed-pace", d30: "backfill-observed-pace", d90: "backfill-observed-pace", m12: "backfill-observed-pace", ltd: "ltd-anchor-median-v03+ltd_state:accumulator" },
    };

    for (const id of [...TLOU_TARGETS, GOW_TARGET, CONTROL]) {
      for (const w of WINDOWS) {
        const units = PS5_UNITS[id][w];
        db.prepare(
          `INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,signal_value,owners_mid,units_mid,method,created_at)
           VALUES(?,?,?,'2026-10-11',?,?,?,?,?)`,
        ).run(id, "ps5", w, units, units * 0.8, units, PS5_METHOD[id][w], "2026-10-11");
      }
    }

    const STEAM_SIBLING_UNITS: Record<number, number> = { 11117: 4000, 11116: 3000, 10369: 2000, 10445: 1500 };
    for (const id of [11117, 11116, 10369, 10445]) {
      for (const w of WINDOWS) {
        const steamUnits = STEAM_SIBLING_UNITS[id];
        const steamRevUsd = steamUnits * 39.99;
        db.prepare(
          `INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,signal_value,owners_mid,units_mid,method,created_at)
           VALUES(?,?,?,'2026-10-11',?,?,?,?,?)`,
        ).run(id, "steam", w, Math.round(steamRevUsd * 100), steamUnits, steamUnits, "steam_est", "2026-10-11");
      }
    }

    // ── Wire the route and drive the leaderboard for ps5 across windows ───
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const app = express();
    registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const get = async (path: string) => {
      const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/console/${path}`);
      assert.equal(r.status, 200, `${path} -> 200`);
      return r.json() as Promise<any>;
    };

    const guardsModule = await import("./console-native-model-guards");
    const origGuards = guardsModule.CONSOLE_NATIVE_MODEL_GUARDS;
    const findRow = (board: any, id: number) => board.titles.find((t: any) => t.titleId === id);

    const readBoard = async (w: string) => get(`leaderboards/ps5?window=${w}`);

    // ── Production scope: TLOU on d7/d30/d90/m12; GoW on d90/m12 only ─────
    const boards: Record<string, any> = {};
    for (const w of WINDOWS) boards[w] = await readBoard(w);

    // d7/d30/d90/m12 are guarded for the two TLOU rows; LTD is not.
    for (const id of TLOU_TARGETS) {
      for (const w of ["d7", "d30", "d90", "m12"] as const) {
        const row = findRow(boards[w], id);
        assert.equal(row?.dataSource, "native_model_guarded", `production ${id}/${w} guarded`);
      }
      const ltdRow = findRow(boards["ltd"], id);
      assert.equal(ltdRow?.dataSource, "derived_from_steam_ip_override", `production ${id}/ltd keeps IP override (public-anchor work pending)`);
    }
    // GoW Ragnarök: guarded on d90/m12 only; d7/d30/LTD keep the IP override.
    for (const w of ["d90", "m12"] as const) {
      const row = findRow(boards[w], GOW_TARGET);
      assert.equal(row?.dataSource, "native_model_guarded", `production ${GOW_TARGET}/${w} guarded`);
    }
    for (const w of ["d7", "d30", "ltd"] as const) {
      const row = findRow(boards[w], GOW_TARGET);
      assert.equal(row?.dataSource, "derived_from_steam_ip_override", `production ${GOW_TARGET}/${w} keeps IP override (scoped fix)`);
    }
    // Control row: Steam×9 in every window.
    for (const w of WINDOWS) {
      const row = findRow(boards[w], CONTROL);
      assert.equal(row?.dataSource, "derived_from_steam_ip_override", `control ${CONTROL}/${w} Steam×9`);
    }

    // ── Widened-scope assertions on d90/m12 ──────────────────────────────
    for (const id of TLOU_TARGETS) {
      for (const w of ["d90", "m12"] as const) {
        const row = findRow(boards[w], id);
        assert.ok(row, `${id}/${w} row exists`);
        assert.equal(row?.dataSource, "native_model_guarded", `${id}/${w} guarded`);
        assert.ok(row?.revenueCaveat?.length > 20, `${id}/${w} carries audit reason`);
        assert.ok(row?.nativeModelGuard?.version === "native_model_guard_v1", `${id}/${w} carries policy version`);

        // The served units should equal the native estimator's units_mid
        // CLAMPED by the aged-title ceiling for d90/m12 (the guard preserves
        // revenue and units as they came from SQL; the ceiling then clamps).
        const expectedUnits = expectedServedUnits(id, w);
        assert.equal(row?.unitsMid, expectedUnits, `${id}/${w} units = native units_mid clamped by aged-title ceiling`);

        // The served revenue should be `units_mid × (aspUsdCents / 100)`, where
        // aspUsdCents is the SQL `msrp * aspFactor` as a REAL (no truncation).
        const msrp = id === 11188 ? 6999 : id === 11179 ? 4999 : 5999;
        const expectedRevUsd = (expectedUnits * (msrp * 0.8)) / 100;
        assert.ok(
          Math.abs((row?.revenueMidUsd ?? 0) - expectedRevUsd) < 1,
          `${id}/${w} revenue ≈ native units_mid × asp`,
        );

        // The Steam×9 derivation fields should be absent.
        assert.ok(row?.derivationRatio == null, `${id}/${w} derivationRatio null`);
        assert.ok(row?.derivationSteamSource == null, `${id}/${w} derivationSteamSource null`);
      }
    }

    // GoW Ragnarök d90/m12 guarded with native values.
    for (const w of ["d90", "m12"] as const) {
      const row = findRow(boards[w], GOW_TARGET);
      assert.ok(row, `${GOW_TARGET}/${w} row exists`);
      assert.equal(row?.dataSource, "native_model_guarded", `${GOW_TARGET}/${w} guarded`);
      assert.ok(row?.revenueCaveat?.length > 20, `${GOW_TARGET}/${w} carries audit reason`);
      assert.ok(row?.nativeModelGuard?.version === "native_model_guard_v1", `${GOW_TARGET}/${w} carries policy version`);
      const expectedUnits = expectedServedUnits(GOW_TARGET, w);
      assert.equal(row?.unitsMid, expectedUnits, `${GOW_TARGET}/${w} units = native units_mid clamped by aged-title ceiling`);
      assert.ok(row?.derivationRatio == null, `${GOW_TARGET}/${w} derivationRatio null`);
      assert.ok(row?.derivationSteamSource == null, `${GOW_TARGET}/${w} derivationSteamSource null`);
    }

    // Control row: still Steam×9 in every window (no leakage).
    for (const w of ["d90", "m12", "ltd"] as const) {
      const row = findRow(boards[w], CONTROL);
      assert.equal(row?.dataSource, "derived_from_steam_ip_override", `control ${CONTROL}/${w} Steam×9`);
      assert.equal(row?.derivationRatio, 9, `control ${CONTROL}/${w} ratio = 9`);
    }

    // d7/d30 values unchanged for the TLOU rows.
    for (const id of TLOU_TARGETS) {
      const r7 = findRow(boards["d7"], id);
      const r30 = findRow(boards["d30"], id);
      assert.equal(r7?.dataSource, "native_model_guarded");
      assert.equal(r30?.dataSource, "native_model_guarded");
      assert.equal(r7?.unitsMid, PS5_UNITS[id]["d7"]);
      assert.equal(r30?.unitsMid, PS5_UNITS[id]["d30"]);
    }

    // Chart-consistency and daily-mix are not applied for d90/m12.
    for (const w of ["d90", "m12"] as const) {
      for (const id of TLOU_TARGETS) {
        const row = findRow(boards[w], id);
        assert.equal(row?.dailyMixAdjustmentUsd, undefined, `${id}/${w} daily-mix not applied`);
        assert.equal(row?.chartAdjustment, undefined, `${id}/${w} chart pass not applied`);
      }
    }
  } finally {
    if (server) server.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
