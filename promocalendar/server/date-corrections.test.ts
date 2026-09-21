import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { correctEventDates, repairKnownEventDates } from "./date-corrections.js";
import { parsePromoWorkbook } from "./parser.js";

process.env.PROMOCALENDAR_DB_PATH = ":memory:";
const { initSchema, raw } = await import("./db.js");
const { listEvents } = await import("./storage.js");
const { eventWindow } = await import("./event-performance.js");
initSchema();

test("only the explicitly confirmed Winter Sales tuples are corrected", () => {
  assert.equal(correctEventDates("Steam", "Winter Sales", "2022-12-22", "2022-01-04").end, "2023-01-04");
  assert.equal(correctEventDates("Steam", "Winter Sales", "2026-12-18", "2026-01-05").start, "2025-12-18");
  for (const [platform, program, start, end] of [
    ["Sony", "Winter Sales", "2026-12-18", "2026-01-05"],
    ["Steam", "Other", "2026-12-18", "2026-01-05"],
    ["Steam", "Winter Sales", "2024-12-18", "2024-01-05"],
    ["Steam", "Winter Sales", "2025-12-18", "2026-01-05"],
  ]) assert.deepEqual(correctEventDates(platform, program, start, end), { start, end, note: null });
});

test("real workbook repairs seven campaigns without losing SKU rows", async () => {
  const parsed = await parsePromoWorkbook(readFileSync(process.env.PROMO_SAMPLE_XLSX || "scripts/fixtures/Promo-Schedule-Saber.xlsx"));
  const fixed = parsed.campaigns.filter(c => c.notes?.startsWith("Source date correction:"));
  assert.equal(fixed.length, 7);
  assert.equal(fixed.filter(c => c.end_date === "2023-01-04").length, 2);
  assert.equal(fixed.filter(c => c.start_date === "2025-12-18").length, 5);
  assert.ok(fixed.every(c => c.skus.length > 0 && c.start_date < c.end_date));
  assert.equal(parsed.campaigns.filter(c => c.platform === "Steam" && c.program === "Winter Sales" && c.start_date > c.end_date).length, 0);
});

test("stored repair is scoped, idempotent, preserves unrelated data and yields valid historical events", () => {
  const insert = raw.prepare(`INSERT INTO campaigns
    (upload_id,calendar,sheet_name,game_code,game_label,sheet_year,platform,platform_raw,program,start_date,end_date,notes)
    VALUES (4,?,'test',?,?,2025,?,'STEAM',?,?,?,'Original note')`);
  for (const code of ["ISS", "SNOW"]) insert.run("saber", code, code, "Steam", "Winter Sales", "2022-12-22", "2022-01-04");
  for (const code of ["SM2", "ROADCRAFT", "SNOW", "EXPE", "ISS"]) insert.run("saber", code, code, "Steam", "Winter Sales", "2026-12-18", "2026-01-05");
  insert.run("partner", "ISS", "ISS", "Steam", "Winter Sales", "2026-12-18", "2026-01-05");
  insert.run("saber", "ISS", "ISS", "Sony", "Winter Sales", "2026-12-18", "2026-01-05");
  raw.prepare("INSERT INTO sku_lines (campaign_id,upload_id,content_name) VALUES (1,4,'SKU')").run();
  const before = raw.prepare("SELECT * FROM campaigns").all() as any[];
  const skus = raw.prepare("SELECT * FROM sku_lines").all();
  assert.equal(repairKnownEventDates(raw), 7);
  const after = raw.prepare("SELECT * FROM campaigns").all() as any[];
  assert.deepEqual(after.slice(7), before.slice(7));
  for (let i = 0; i < 7; i++) {
    const { start_date, end_date, notes, ...rest } = after[i];
    const { start_date: oldStart, end_date: oldEnd, notes: oldNotes, ...oldRest } = before[i];
    assert.deepEqual(rest, oldRest);
    assert.match(notes, /^Original note\nSource date correction:/);
  }
  assert.deepEqual(raw.prepare("SELECT * FROM sku_lines").all(), skus);
  assert.equal(repairKnownEventDates(raw), 0);
  assert.deepEqual(raw.prepare("SELECT * FROM campaigns").all(), after);
  const events = listEvents("saber", "2026-09-21").filter(e => e.platform === "Steam");
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.ok(e.end_date < "2026-09-21");
    assert.ok(eventWindow(e, "2026-09-21").days > 0);
  }
});
