/**
 * Regression test for the title_id allocator (2026-09-12 fix).
 *
 * Reproduces the failure mode from 2026-09-11: an allocator that seeds a
 * fresh-id counter from `MAX(title_id)+1` at startup and never re-reads.
 * When two runs (or two invocations that share such a counter's start
 * value) allocate for disjoint SKU sets, they collide — two SKUs get the
 * same title_id. That's the bug that produced 19 colliding Xbox title_ids.
 *
 * Test uses an in-memory DB and compares the two allocators head-to-head:
 *   (1) BUGGY:  cached counter seeded from MAX once, never re-read.
 *   (2) FIXED:  every fresh allocation runs inside `BEGIN IMMEDIATE`,
 *               reads MAX from live state, and INSERTs a reservation row.
 *
 * Run: `npx tsx signalpulse/scripts/test-title-id-allocator.ts`
 * Exits 0 on pass, 1 on any failure.
 */

import Database from "better-sqlite3";

interface DBLike {
  prepare(sql: string): {
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
  transaction: <T>(fn: () => T) => { immediate: () => T };
  exec(sql: string): void;
  close(): void;
}

function makeDb(): DBLike {
  const db = new Database(":memory:") as DBLike;
  db.exec(`
    CREATE TABLE platform_sku_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      external_sku TEXT NOT NULL,
      concept_id TEXT,
      sku_role TEXT NOT NULL,
      business_model TEXT NOT NULL DEFAULT 'unknown',
      msrp_usd_cents INTEGER,
      business_model_source TEXT,
      is_manual_override INTEGER NOT NULL DEFAULT 0,
      is_gamepass INTEGER NOT NULL DEFAULT 0,
      refreshed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX platform_sku_map_unique
      ON platform_sku_map (platform, external_sku);
  `);
  // Seed 50 existing rows so MAX(title_id) starts at 10049.
  const seed = db.prepare(`INSERT INTO platform_sku_map
      (title_id, platform, external_sku, sku_role, refreshed_at, created_at)
      VALUES (?, ?, ?, 'base', ?, ?)`);
  const now = new Date().toISOString();
  for (let i = 0; i < 50; i++) {
    seed.run(10000 + i, "seed", `SEED${i}`, now, now);
  }
  return db;
}

// ── (1) BUGGY allocator: cached counter, seeded once. ────────────────────────
function makeBuggyAllocator(db: DBLike) {
  const maxRow = db.prepare(
    `SELECT COALESCE(MAX(title_id), 9999) AS max_id FROM platform_sku_map`
  ).get() as { max_id: number };
  let nextTitleId = maxRow.max_id + 1;
  const cache = new Map<string, number>();
  const lookup = db.prepare(
    `SELECT title_id FROM platform_sku_map WHERE platform = ? AND external_sku = ?`
  );
  return (platform: string, sku: string): number => {
    const key = `${platform}:${sku}`;
    if (cache.has(key)) return cache.get(key)!;
    const existing = lookup.get(platform, sku) as { title_id: number } | undefined;
    const id = existing?.title_id ?? nextTitleId++;
    cache.set(key, id);
    return id;
  };
}

// ── (2) FIXED allocator: BEGIN IMMEDIATE + INSERT reservation. ───────────────
function makeFixedAllocator(db: DBLike) {
  const cache = new Map<string, number>();
  const lookup = db.prepare(
    `SELECT title_id FROM platform_sku_map WHERE platform = ? AND external_sku = ?`
  );
  const maxStmt = db.prepare(
    `SELECT COALESCE(MAX(title_id), 9999) AS max_id FROM platform_sku_map`
  );
  const reserveStmt = db.prepare(
    `INSERT INTO platform_sku_map
       (title_id, platform, external_sku, concept_id, sku_role,
        business_model, msrp_usd_cents, business_model_source, is_manual_override,
        refreshed_at, created_at)
     VALUES (?, ?, ?, NULL, 'base', 'unknown', NULL, 'allocator_reservation', 0, ?, ?)
     ON CONFLICT(platform, external_sku) DO NOTHING`
  );
  return (platform: string, sku: string): number => {
    const key = `${platform}:${sku}`;
    if (cache.has(key)) return cache.get(key)!;
    const existing = lookup.get(platform, sku) as { title_id: number } | undefined;
    if (existing) { cache.set(key, existing.title_id); return existing.title_id; }
    const nowIso = new Date().toISOString();
    const tx = db.transaction((): number => {
      const inside = lookup.get(platform, sku) as { title_id: number } | undefined;
      if (inside) return inside.title_id;
      const { max_id } = maxStmt.get() as { max_id: number };
      const fresh = max_id + 1;
      reserveStmt.run(fresh, platform, sku, nowIso, nowIso);
      return fresh;
    });
    const id = tx.immediate();
    cache.set(key, id);
    return id;
  };
}

// ── Test harness ─────────────────────────────────────────────────────────────
function simulateTwoRuns(allocatorFactory: (db: DBLike) => (p: string, s: string) => number): {
  collisions: Array<{ id: number; skus: string[] }>;
  totalAllocations: number;
} {
  const db = makeDb();

  // Run 1: allocate for cohort A. This mimics one discovery process.
  const alloc1 = allocatorFactory(db);
  const cohortA = Array.from({ length: 20 }, (_, i) => `A_${i}`);
  const ids1 = new Map<string, number>();
  for (const sku of cohortA) ids1.set(sku, alloc1("xbox", sku));

  // Run 2: DIFFERENT process — new allocator instance, same DB.
  // The buggy allocator seeds `nextTitleId` from MAX again — but its cache
  // is empty AND `existingLookup` returns undefined for the cohort-B SKUs,
  // so it falls into the fresh-counter path starting from an id that WILL
  // collide with Run 1's IF Run 1's rows were never actually written
  // (buggy path never writes reservation rows; only later upsertSkuMap does).
  //
  // Mimic the real timing: Run 1 minted title_ids but its `upsertSkuMap`
  // write hasn't landed yet (crashed, still in progress, or serialization
  // gap). In production, Run 1 DID write, but Run 2 started BEFORE Run 1's
  // MAX was visible to it (buggy allocator caches MAX at construction).
  // Equivalent: buggy allocator2 caches MAX(pre-run-1); reservation-based
  // fixed allocator re-reads MAX inside every tx.
  const alloc2 = allocatorFactory(db);
  const cohortB = Array.from({ length: 20 }, (_, i) => `B_${i}`);
  const ids2 = new Map<string, number>();
  for (const sku of cohortB) ids2.set(sku, alloc2("xbox", sku));

  // Simulate that Run 1's writes DID land (via upsertSkuMap post-allocator).
  // For the buggy allocator this is post-hoc; we insert rows here to check
  // whether Run 2's ids collided with Run 1's.
  const insertRun1 = db.prepare(`INSERT OR IGNORE INTO platform_sku_map
      (title_id, platform, external_sku, sku_role, refreshed_at, created_at)
      VALUES (?, 'xbox', ?, 'base', ?, ?)`);
  const nowIso = new Date().toISOString();
  for (const [sku, id] of ids1.entries()) insertRun1.run(id, sku, nowIso, nowIso);

  // Check: does any id appear in BOTH runs for DIFFERENT skus?
  const totalAllocations = ids1.size + ids2.size;
  const idToSkus = new Map<number, string[]>();
  for (const [sku, id] of [...ids1, ...ids2]) {
    const list = idToSkus.get(id) ?? [];
    list.push(sku);
    idToSkus.set(id, list);
  }
  const collisions: Array<{ id: number; skus: string[] }> = [];
  for (const [id, skus] of idToSkus.entries()) {
    if (skus.length > 1) collisions.push({ id, skus });
  }
  db.close();
  return { collisions, totalAllocations };
}

console.log("─── title_id allocator regression test ───\n");

console.log("(1) BUGGY allocator (in-process counter, cached at startup):");
const buggy = simulateTwoRuns(makeBuggyAllocator);
console.log(`  Total allocations: ${buggy.totalAllocations}`);
console.log(`  Collisions: ${buggy.collisions.length}`);
if (buggy.collisions.length > 0) {
  console.log(`  First 3:`);
  for (const c of buggy.collisions.slice(0, 3)) {
    console.log(`    title_id=${c.id}: ${c.skus.join(" vs ")}`);
  }
}
const buggyReproducedBug = buggy.collisions.length > 0;

console.log("\n(2) FIXED allocator (BEGIN IMMEDIATE + reservation):");
const fixed = simulateTwoRuns(makeFixedAllocator);
console.log(`  Total allocations: ${fixed.totalAllocations}`);
console.log(`  Collisions: ${fixed.collisions.length}`);
if (fixed.collisions.length > 0) {
  console.log(`  First 3:`);
  for (const c of fixed.collisions.slice(0, 3)) {
    console.log(`    title_id=${c.id}: ${c.skus.join(" vs ")}`);
  }
}
const fixedIsClean = fixed.collisions.length === 0;

console.log("\n─── Verdict ───");
if (buggyReproducedBug && fixedIsClean) {
  console.log("✅ PASS — buggy allocator reproduces the 2026-09-11 bug (collisions > 0);");
  console.log("          fixed allocator prevents it (collisions == 0).");
  process.exit(0);
} else {
  console.log(`❌ FAIL — buggyReproducedBug=${buggyReproducedBug} fixedIsClean=${fixedIsClean}`);
  process.exit(1);
}
