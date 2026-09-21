import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { Router } from "wouter";

process.env.PROMOCALENDAR_DB_PATH = ":memory:";
const { initSchema, raw } = await import("./db.js");
const { listEvents, getEvent, ingest, rollbackTo, archiveStartedEvents } = await import("./storage.js");
const { actualSalesAdapters, refreshEventPerformance, readEventPerformance, eventWindow } = await import("./event-performance.js");
const { registerRoutes } = await import("./routes.js");
const { EventPerformanceSummary, EventPerformanceDetail } = await import("../client/src/components/EventPerformance.js");
const { EventCard } = await import("../client/src/components/EventCard.js");
const { getSteamRevenueBatch } = await import("./signalpulse-client.js");
const { performanceCoverage } = await import("../shared/event-performance.js");
initSchema();
const adapter = actualSalesAdapters.Steam;
const originalFetch = adapter.fetch;
const originalResolve = adapter.resolve;
const date = "2026-09-21";
const time = new Date("2026-09-21T12:00:00Z");
let calls: Array<any[]> = [];
function seed(program = "Publisher Sales", platform = "Steam", start = "2026-09-03", end = "2026-09-14", codes = ["SM2", "SNOW"]) {
  for (const c of codes) raw.prepare(`INSERT INTO campaigns
    (upload_id,calendar,sheet_name,game_code,game_label,sheet_year,platform,platform_raw,program,start_date,end_date,sku_count,max_discount_pct,min_discount_pct)
    VALUES(1,'saber','test',?,?,2026,?,?, ?,?,?,1,.5,.2)`).run(c, c, platform, platform, program, start, end);
}
function event(program = "Publisher Sales") { return listEvents("saber", date).find(e => e.program === program)!; }
function perf(program = "Publisher Sales", today = date, now = time) { return readEventPerformance("saber", event(program), today, now); }
function fakeRows(qs: any[]) { return qs.map(q => ({ found: true, net_revenue_usd: 100, gross_revenue_usd: 120, days_covered: eventWindow({ start_date: q.since, end_date: q.until } as any, date).days })); }
beforeEach(() => {
  raw.exec("DELETE FROM event_performance; DELETE FROM event_archive; DELETE FROM campaigns; DELETE FROM sku_lines; DELETE FROM uploads;");
  calls = [];
  adapter.resolve = originalResolve;
  adapter.fetch = async qs => { calls.push(qs); return fakeRows(qs); };
  delete actualSalesAdapters.Sony;
});
after(() => { adapter.fetch = originalFetch; adapter.resolve = originalResolve; raw.close(); });

test("schema migration is idempotent and preserves existing campaigns", () => {
  seed(); initSchema(); initSchema();
  assert.equal(raw.prepare("SELECT count(*) n FROM campaigns").get().n, 2);
  assert.deepEqual((raw.prepare("PRAGMA table_info(event_performance)").all() as any[]).map(r => r.name),
    ["calendar","event_key","fingerprint","payload","checked_at","next_refresh_at","refresh_error"]);
});
test("past full-window totals, gross, title-day coverage and local-only reads", async () => {
  seed(); assert.equal(perf().status, "pending");
  await refreshEventPerformance(date, time);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].until, "2026-09-14");
  assert.equal(perf().net_revenue_usd, 200);
  assert.equal(perf().gross_revenue_usd, 240);
  assert.equal(perf().title_days_covered, 24);
  assert.equal(perf().status, "complete");
  for (let i = 0; i < 30; i++) perf();
  await refreshEventPerformance(date, time);
  assert.equal(calls.length, 1);
});
test("live window stops at today; ending an event retains its identity and revenue", async () => {
  seed("Live", "Steam", "2026-09-20", "2026-09-21");
  const key = event("Live").event_key;
  await refreshEventPerformance(date, time);
  assert.equal(calls[0][0].until, date);
  await refreshEventPerformance("2026-09-22", new Date("2026-09-22T12:00:00Z"));
  assert.equal(event("Live").event_key, key);
  assert.equal(calls[1][0].until, date);
  assert.equal(readEventPerformance("saber", event("Live"), "2026-09-22", new Date("2026-09-22T12:00:00Z")).net_revenue_usd, 200);
});
test("unmapped titles and incomplete days are visibly partial, not complete", async () => {
  seed("Partial", "Steam", "2026-09-03", "2026-09-14", ["SM2", "SNOW", "UNMAPPED"]);
  adapter.fetch = async qs => fakeRows(qs).map((r, i) => ({ ...r, days_covered: i ? 5 : 12 }));
  await refreshEventPerformance(date, time);
  assert.equal(perf("Partial").status, "partial");
  assert.equal(perf("Partial").title_days_expected, 36);
  assert.equal(perf("Partial").title_days_covered, 17);
  assert.match(performanceCoverage(perf("Partial")), /2\/3 titles.*17\/36 title-days/);
});
test("reported zero remains zero; absent rows remain unavailable, never fake zero", async () => {
  seed();
  adapter.fetch = async qs => fakeRows(qs).map(r => ({ ...r, net_revenue_usd: 0, gross_revenue_usd: 0 }));
  await refreshEventPerformance(date, time);
  assert.equal(perf().net_revenue_usd, 0);
  assert.equal(perf().status, "complete");
  raw.exec("DELETE FROM event_performance");
  adapter.fetch = async qs => fakeRows(qs).map(r => ({ ...r, found: false, days_covered: 0 }));
  await refreshEventPerformance(date, time);
  assert.equal(perf().net_revenue_usd, null);
  assert.equal(perf().status, "unavailable");
});
test("outage retains successful totals and reports saved data plus refresh failure", async () => {
  seed(); await refreshEventPerformance(date, time);
  adapter.fetch = async () => { throw new Error("source offline"); };
  const later = new Date(time.getTime() + 7 * 3600000);
  await refreshEventPerformance(date, later);
  const p = perf("Publisher Sales", date, later);
  assert.equal(p.net_revenue_usd, 200);
  assert.equal(p.fetched_at, time.toISOString());
  assert.equal(p.stale, true);
  assert.equal(p.refresh_error, true);
});
test("late backfills/corrections refresh, but missing source days cannot erase saved figures", async () => {
  seed(); await refreshEventPerformance(date, time);
  adapter.fetch = async qs => fakeRows(qs).map(r => ({ ...r, net_revenue_usd: 90 }));
  const later = new Date(time.getTime() + 7 * 3600000);
  await refreshEventPerformance(date, later);
  assert.equal(perf().net_revenue_usd, 180);
  adapter.fetch = async qs => fakeRows(qs).map(r => ({ ...r, found: false, days_covered: 0 }));
  await refreshEventPerformance(date, new Date(later.getTime() + 7 * 3600000));
  assert.equal(perf().net_revenue_usd, 180);
  assert.equal(perf().refresh_error, true);
});
test("membership/mapping changes invalidate old totals", async () => {
  seed(); await refreshEventPerformance(date, time);
  raw.prepare("UPDATE campaigns SET game_code='EXPE' WHERE game_code='SNOW'").run();
  assert.equal(perf().status, "pending");
  await refreshEventPerformance(date, time);
  assert.equal(perf().status, "complete");
  adapter.resolve = c => c === "SM2" ? "999" : originalResolve(c);
  assert.equal(perf().status, "pending");
});
test("duplicate source mappings never double-count revenue", async () => {
  seed(); adapter.resolve = () => "2183900";
  await refreshEventPerformance(date, time);
  assert.equal(calls[0].length, 1);
  assert.equal(perf().net_revenue_usd, 100);
  assert.equal(perf().status, "partial");
});
test("invalid windows, future events and disconnected PS5 do not call sales API", async () => {
  seed("Invalid", "Steam", "2026-12-18", "2026-01-05");
  seed("Future", "Steam", "2026-12-18", "2027-01-05");
  seed("Sony sale", "Sony");
  await refreshEventPerformance(date, time);
  assert.equal(calls.length, 0);
  assert.equal(perf("Invalid").status, "invalid_window");
  assert.equal(perf("Future").status, "not_started");
  assert.equal(perf("Sony sale").status, "unsupported");
});
test("PS5 actual-sales adapter uses the same contract without Steam-specific UI fields", async () => {
  seed("Sony sale", "Sony");
  actualSalesAdapters.Sony = { source: "test.partner-actuals", platform: "ps5", resolve: c => c, fetch: async qs => fakeRows(qs) };
  await refreshEventPerformance(date, time);
  assert.equal(perf("Sony sale").platform, "ps5");
  assert.equal(perf("Sony sale").net_revenue_usd, 200);
  assert.equal(perf("Sony sale").basis, "actual");
});
test("bounded batch refresh is independent of page reads and drains history fairly", async () => {
  for (let i = 0; i < 60; i++) seed(`Sale ${i}`);
  await refreshEventPerformance(date, time);
  assert.equal(raw.prepare("SELECT count(*) n FROM event_performance").get().n, 24);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2); // same source/window is deduplicated across events
  await refreshEventPerformance(date, time);
  await refreshEventPerformance(date, time);
  assert.equal(raw.prepare("SELECT count(*) n FROM event_performance").get().n, 60);
  assert.ok(calls.every(c => c.length <= 200));
});
test("single-flight worker does not overlap source requests", async () => {
  seed();
  let release!: () => void;
  adapter.fetch = async qs => { calls.push(qs); await new Promise<void>(r => { release = r; }); return fakeRows(qs); };
  const first = refreshEventPerformance(date, time);
  await refreshEventPerformance(date, time);
  assert.equal(calls.length, 1);
  release(); await first;
});
test("one event losing coverage does not hold back another event's correction", async () => {
  seed("A", "Steam", "2026-09-01", "2026-09-02");
  seed("B", "Steam", "2026-09-03", "2026-09-04");
  await refreshEventPerformance(date, time);
  adapter.fetch = async qs => fakeRows(qs).map((r, i) => qs[i].since === "2026-09-01"
    ? { ...r, found: false, days_covered: 0 } : { ...r, net_revenue_usd: 90 });
  await refreshEventPerformance(date, new Date(time.getTime() + 7 * 3600000));
  assert.equal(perf("A").net_revenue_usd, 200);
  assert.equal(perf("A").refresh_error, true);
  assert.equal(perf("B").net_revenue_usd, 180);
  assert.equal(perf("B").refresh_error, false);
});
test("large source batches split at 200 and persisted retry deadlines prevent retries on every tick", async () => {
  const codes = Array.from({ length: 12 }, (_, i) => `GAME${i}`);
  adapter.resolve = c => c;
  for (let i = 0; i < 24; i++) seed(`Sale ${i}`, "Steam", `2026-08-${String(i + 1).padStart(2, "0")}`, "2026-09-01", codes);
  await refreshEventPerformance(date, time);
  assert.deepEqual(calls.map(c => c.length), [200, 88]);
  adapter.fetch = async qs => { calls.push(qs); throw new Error("offline"); };
  const later = new Date(time.getTime() + 7 * 3600000);
  await refreshEventPerformance(date, later);
  const before = calls.length;
  await refreshEventPerformance(date, new Date(later.getTime() + 15_000));
  assert.equal(calls.length, before);
});
test("archive survives workbook replacement and rollback, scoped to calendar", async () => {
  seed(); await refreshEventPerformance(date, time);
  const key = event().event_key;
  const uploaded = ingest("saber", { filename: "empty.xlsx", buffer: Buffer.from("fixture") }, null, { campaigns: [], warnings: [] } as any);
  assert.equal(event().archived, true);
  assert.equal(getEvent("saber", key, date)?.games.length, 2);
  assert.equal(perf().net_revenue_usd, 200);
  assert.equal(listEvents("saber_focus", date).length, 0);
  await rollbackTo(uploaded.upload.id, async () => ({ campaigns: [], warnings: [] } as any));
  assert.equal(perf().net_revenue_usd, 200);
  initSchema();
  assert.equal(perf().net_revenue_usd, 200);
});
test("current schedule supersedes archive, archived events obey every filter", async () => {
  seed(); archiveStartedEvents("saber", date);
  assert.equal(listEvents("saber", date).length, 1);
  raw.exec("DELETE FROM campaigns");
  assert.equal(listEvents("saber", date, { when: "past", platform: "Steam" }).length, 1);
  for (const filter of [{ when: "live" }, { platform: "Sony" }, { from: "2026-09-20" }, { to: "2026-08-01" }, { min_titles: 3 }, { program: "No match" }]) {
    assert.equal(listEvents("saber", date, filter as any).length, 0);
  }
});
test("demo date cannot expose later captured revenue", async () => {
  seed(); await refreshEventPerformance(date, time);
  assert.equal(perf("Publisher Sales", "2026-09-05").net_revenue_usd, null);
});
test("event list/detail routes return matching historical performance, no upstream work", async () => {
  seed(); await refreshEventPerformance(date, time);
  const app = express(); registerRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const list = await (await fetch(`${base}/api/saber/events?when=past&today=${date}`)).json();
    const detail = await (await fetch(`${base}/api/saber/events/${event().event_key}?today=${date}`)).json();
    assert.equal(list.events[0].performance.net_revenue_usd, 200);
    assert.deepEqual(list.events[0].performance, detail.event.performance);
    assert.equal(list.events[0].steam_total_net_revenue_usd, 200);
    assert.equal(calls.length, 1);
    assert.equal((await fetch(`${base}/api/saber/events/no-such-event`)).status, 404);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
test("frontend renders historical money, zero, coverage, unknown states and detail provenance", async () => {
  seed(); await refreshEventPerformance(date, time);
  const p = perf();
  const html = renderToStaticMarkup(React.createElement(Router, { ssrPath: "/events" },
    React.createElement(EventCard, { event: { ...event(), performance: p } })));
  assert.match(html, /Net revenue/);
  assert.match(html, /Complete/);
  assert.match(html, /24\/24 title-days/);
  assert.match(renderToStaticMarkup(React.createElement(EventPerformanceSummary, { performance: { ...p, net_revenue_usd: 0 } })), /\$0/);
  assert.match(renderToStaticMarkup(React.createElement(EventPerformanceDetail, { performance: p })), /not incremental uplift/);
  assert.match(renderToStaticMarkup(React.createElement(EventPerformanceSummary, { performance: { ...p, status: "unsupported", net_revenue_usd: null } })), /feed not connected/);
});
test("batch transport validates identity, range, found, money and HTTP failures", async () => {
  const savedFetch = globalThis.fetch;
  const item = { steam_app_id: 2183900, since: "2026-09-03", until: "2026-09-14" };
  const valid = { ...item, found: true, days_covered: 12, net_revenue_usd: 0, gross_revenue_usd: 0 };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify([valid]), { status: 200 });
    assert.equal((await getSteamRevenueBatch([item]))[0].net_revenue_usd, 0);
    for (const bad of [{ ...valid, steam_app_id: 42 }, { ...valid, until: date }, { ...valid, found: false }, { ...valid, net_revenue_usd: null }, { ...valid, days_covered: -1 }, { ...valid, error: "failure" }]) {
      globalThis.fetch = async () => new Response(JSON.stringify([bad]), { status: 200 });
      await assert.rejects(getSteamRevenueBatch([item]));
    }
    globalThis.fetch = async () => new Response("offline", { status: 503 });
    await assert.rejects(getSteamRevenueBatch([item]));
  } finally { globalThis.fetch = savedFetch; }
});
