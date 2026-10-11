import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

/**
 * Validates the d90/m12/ltd behavior of the native-model guard before
 * widening its window scope from d7/d30 to all five windows.
 *
 * Method: fixture the two TLOU PS5 rows with the actual production values
 * captured 2026-10-11 from the live estimator (`window_estimates_daily`
 * `units_mid` rows) and the actual Steam sibling revenues that drive the
 * Steam×9 IP override (titleId 11117 = Part I, 11116 = Part II Rem).
 *
 * Run the real leaderboard route twice — guard scope d7/d30 (current
 * production) vs d7/d30/d90/m12/ltd (the proposed widening) — and assert:
 *
 * 1. Under the widened scope, d90/m12/ltd serve the native `revenueMidUsd`
 *    computed from `units_mid × (aspUsdCents / 100)` and `dataSource`
 *    = "native_model_guarded", replacing the Steam×9 derived value.
 * 2. Under the widened scope, d7/d30 behavior is unchanged.
 * 3. A non-target Sony title (e.g. God of War Ragnarök, 10370) keeps the
 *    Steam×9 IP override path in every window — no leakage.
 * 4. Chart consistency and daily mix don't fire for d90/m12/ltd (chart pass
 *    only runs for d7/d30; daily mix only for `derived_from_steam`).
 */

test("wider-window counterfactual: d90/m12/ltd guarded rows keep native estimator, control title keeps Steam×9", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "tlou-wider-"));
  process.chdir(dir);
  let db: any;
  let server: any;
  try {
    db = (await import("./storage")).rawSqlite;

    // ── Guard: fixture the two target titles and one control ────────────
    const TLOU_TARGETS = [11188, 11179];
    const CONTROL = 10370; // God of War Ragnarök (PS5)

    const ps5SkuRow = (id: number, sku: string, name: string, msrp: number) => {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,'ps5',?,?,'paid',?,?,?)`).run(id, sku, "base", msrp, "2026-10-11", "2026-10-11");
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,refreshed_at,created_at) VALUES(?,?,?,?)`).run(id, name, "2026-10-11", "2026-10-11");
    };

    ps5SkuRow(11188, "UP9000-PPSA03396_00-THELASTOFUSPART1", "The Last of Us™ Part I", 6999);
    ps5SkuRow(11179, "UP9000-PPSA10662_00-THELASTOFUSPART2", "The Last of Us™ Part II Remastered", 4999);
    ps5SkuRow(CONTROL, "UP9000-PPSA06741_00-GODOFWARRAGNAROK", "God of War Ragnarök", 5999);

    // ── Steam siblings: enough revenue to trip the Steam×9 IP override ────
    for (const [id, sku, name, msrp] of [
      [11117, "3490200", "The Last of Us Part I", 5999],
      [11116, "1888930", "The Last of Us Part II Remastered", 5999],
      [10369, "1593500", "God of War Ragnarök", 5999],
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
      [CONTROL]: { d7: 8000, d30: 25000, d90: 70000, m12: 200000, ltd: 600000 },
    };
    const PS5_METHOD: Record<number, Record<string, string>> = {
      11188: { d7: "backfill-observed-pace", d30: "backfill-observed-pace", d90: "backfill-observed-pace", m12: "backfill-observed-pace", ltd: "ltd-anchor-median-v03+ltd_state:accumulator" },
      11179: { d7: "backfill-observed-pace", d30: "backfill-observed-pace", d90: "backfill-observed-pace", m12: "backfill-observed-pace", ltd: "ltd-anchor-median-v03+ltd_state:accumulator" },
      [CONTROL]: { d7: "backfill-observed-pace", d30: "backfill-observed-pace", d90: "backfill-observed-pace", m12: "backfill-observed-pace", ltd: "ltd-anchor-median-v03+ltd_state:accumulator" },
    };

    for (const id of [...TLOU_TARGETS, CONTROL]) {
      for (const w of WINDOWS) {
        const units = PS5_UNITS[id][w];
        db.prepare(
          `INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,signal_value,owners_mid,units_mid,method,created_at)
           VALUES(?,?,?,'2026-10-11',?,?,?,?,?)`,
        ).run(id, "ps5", w, units, units * 0.8, units, PS5_METHOD[id][w], "2026-10-11");
      }
    }

    const STEAM_SIBLING_UNITS: Record<number, number> = { 11117: 4000, 11116: 3000, 10369: 2000 };
    for (const id of [11117, 11116, 10369]) {
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

    // ── Baseline (current shipped scope: d7/d30 only) ────────────────────
    const baselineBoards: Record<string, any> = {};
    for (const w of WINDOWS) baselineBoards[w] = await readBoard(w);

    // Assert the baseline: d7/d30 guarded, d90/m12/ltd NOT guarded.
    for (const id of TLOU_TARGETS) {
      for (const w of ["d7", "d30"] as const) {
        const row = findRow(baselineBoards[w], id);
        assert.equal(row?.dataSource, "native_model_guarded", `baseline ${id}/${w} guarded`);
      }
      for (const w of ["d90", "m12", "ltd"] as const) {
        const row = findRow(baselineBoards[w], id);
        assert.equal(row?.dataSource, "derived_from_steam_ip_override", `baseline ${id}/${w} NOT guarded`);
      }
    }
    // Control row: Steam×9 in every window.
    for (const w of WINDOWS) {
      const row = findRow(baselineBoards[w], CONTROL);
      assert.equal(row?.dataSource, "derived_from_steam_ip_override", `control ${CONTROL}/${w} Steam×9`);
    }

    // ── Widened scope: widen the guard windows in-process, drive the route ──
    const restoreGuards = guardsModule.widenGuardScopeForTest(["d7", "d30", "d90", "m12", "ltd"]);

    // Drive d90/m12/ltd under the widened scope.
    const widenedBoards: Record<string, any> = {};
    for (const w of ["d90", "m12", "ltd"] as const) widenedBoards[w] = await readBoard(w);

    // Restore before assertions so a failed assert can't leave state dirty.
    restoreGuards();

    for (const id of TLOU_TARGETS) {
      for (const w of ["d90", "m12", "ltd"] as const) {
        const row = findRow(widenedBoards[w], id);
        assert.ok(row, `widened ${id}/${w} row exists`);
        assert.equal(row?.dataSource, "native_model_guarded", `widened ${id}/${w} guarded`);
        assert.ok(row?.revenueCaveat?.length > 20, `widened ${id}/${w} carries audit reason`);
        assert.ok(row?.nativeModelGuard?.version === "native_model_guard_v1", `widened ${id}/${w} carries policy version`);

        // The served units should equal the native estimator's units_mid
        // (the guard preserves revenue and units as they came from SQL).
        const expectedUnits = PS5_UNITS[id][w];
        assert.equal(row?.unitsMid, expectedUnits, `widened ${id}/${w} units = native units_mid`);

        // The served revenue should be `units_mid × (msrp × 0.8 / 100)`.
        const msrp = id === 11188 ? 6999 : 4999;
        const expectedRevUsd = (expectedUnits * (msrp * 0.8)) / 100;
        assert.ok(
          Math.abs((row?.revenueMidUsd ?? 0) - expectedRevUsd) < 1,
          `widened ${id}/${w} revenue ≈ native units_mid × asp`,
        );

        // The Steam×9 derivation fields should be absent.
        assert.ok(row?.derivationRatio == null, `widened ${id}/${w} derivationRatio null`);
        assert.ok(row?.derivationSteamSource == null, `widened ${id}/${w} derivationSteamSource null`);
      }
    }

    // Control row under widened scope: still Steam×9 in every window (no leakage).
    for (const w of ["d90", "m12", "ltd"] as const) {
      const row = findRow(widenedBoards[w], CONTROL);
      assert.equal(row?.dataSource, "derived_from_steam_ip_override", `control ${CONTROL}/${w} Steam×9 under widened scope`);
      assert.equal(row?.derivationRatio, 9, `control ${CONTROL}/${w} ratio = 9`);
    }

    // Confirm d7/d30 behavior unchanged under the widened scope.
    const d7Board = await readBoard("d7");
    const d30Board = await readBoard("d30");
    for (const id of TLOU_TARGETS) {
      const r7 = findRow(d7Board, id);
      const r30 = findRow(d30Board, id);
      assert.equal(r7?.dataSource, "native_model_guarded");
      assert.equal(r30?.dataSource, "native_model_guarded");
      assert.equal(r7?.unitsMid, PS5_UNITS[id]["d7"]);
      assert.equal(r30?.unitsMid, PS5_UNITS[id]["d30"]);
    }

    // Chart-consistency and daily-mix are not applied for d90/m12/ltd.
    for (const w of ["d90", "m12", "ltd"] as const) {
      for (const id of TLOU_TARGETS) {
        const row = findRow(widenedBoards[w], id);
        assert.equal(row?.dailyMixAdjustmentUsd, undefined, `${id}/${w} daily-mix not applied`);
        assert.equal(row?.chartAdjustment, undefined, `${id}/${w} chart pass not applied`);
      }
    }

    // Restore worked.
    assert.equal(guardsModule.CONSOLE_NATIVE_MODEL_GUARDS, origGuards);
    assert.equal(guardsModule.nativeModelGuardFor([11188], "ps5", "d90"), null);
    assert.ok(guardsModule.nativeModelGuardFor([11188], "ps5", "d30"));
  } finally {
    if (server) server.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
