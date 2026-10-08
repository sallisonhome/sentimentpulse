import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openYoutubeDb, type YtDb } from "./db";
import { syncTitles, buildTitleSources, type ProductLite } from "./titles";
import { runDiscovery, runStatsRefresh, runComments, runRetention, type RunCounters } from "./pipeline";
import { YouTubeClient } from "./api";
import { RELEVANCE_VERSION } from "./relevance";
import { readCommentFeed } from "./feed";
import { readYoutubeSeries } from "./series";

const excluded = [3230960, 4148650];
const main = 2157830;
const products: ProductLite[] = [
  { id: 1, title: "EXODUS", steamAppId: String(excluded[0]), releaseDate: null },
  { id: 2, title: "Toxic Commando - Cosmetic Pack 1", steamAppId: String(excluded[1]), releaseDate: null },
  { id: 3, title: "Toxic Commando", steamAppId: String(main), releaseDate: null },
];
const now = new Date("2026-10-08T12:00:00Z");
const old = "2026-08-01T00:00:00.000Z";
const counters = (): RunCounters => ({
  searchCalls: 0, units: 0, videosDiscovered: 0, videosRefreshed: 0,
  videosRemoved: 0, commentsSaved: 0, commentsRefreshed: 0, commentsDeleted: 0, notes: [],
});
function history(db: YtDb, id: number) {
  db.prepare(`INSERT INTO yt_videos(video_id,title_id,title,published_at,match_reason,discovered_via,
    first_seen_at,last_refreshed_at,relevance_version,comment_count)
    VALUES(?,?,'Toxic Commando gameplay',?,'test','incremental',?,?,?,1)`)
    .run(String(id), id, old, old, old, RELEVANCE_VERSION);
  db.prepare(`INSERT INTO yt_comments(comment_id,video_id,title_id,text,published_at,fetched_at)
    VALUES(?,?,?,'retained history',?,?)`).run(`c${id}`, String(id), id, old, old);
  db.prepare("INSERT INTO yt_video_stats_daily(video_id,date,view_count) VALUES(?,'2026-08-01',123)")
    .run(String(id));
}
function flags(db: YtDb) {
  return db.prepare("SELECT title_id,enabled FROM yt_titles ORDER BY title_id").all();
}

test("owner exclusions survive full, repeated, manual-config and outage syncs; parent stays enabled", () => {
  const db = openYoutubeDb(":memory:");
  try {
    const sources = buildTitleSources(products, [], new Map());
    syncTitles(db, sources, now);
    const expected = [{ title_id: main, enabled: 1 }, ...excluded.map(title_id => ({ title_id, enabled: 0 }))];
    assert.deepEqual(flags(db), expected);
    db.prepare("UPDATE yt_titles SET enabled=1,config_source='manual' WHERE title_id<>?").run(main);
    syncTitles(db, sources, now);
    syncTitles(db, sources, now);
    assert.deepEqual(flags(db), expected);
    db.prepare("UPDATE yt_titles SET enabled=1 WHERE title_id<>?").run(main);
    syncTitles(db, [], now, false);
    assert.deepEqual(flags(db), expected);
    const parent = db.prepare("SELECT title_excludes FROM yt_titles WHERE title_id=?").get(main) as any;
    assert.equal(parent.title_excludes, "[]", "disabled DLC must not shadow the parent");
  } finally { db.close(); }
});

test("opening an existing database applies exclusions without erasing historical data", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-optout-"));
  const path = join(dir, "youtube.db");
  let db = openYoutubeDb(path);
  try {
    syncTitles(db, buildTitleSources(products, [], new Map()), now);
    for (const id of excluded) history(db, id);
    db.prepare("UPDATE yt_titles SET enabled=1").run(); // pre-deployment state
    db.close();
    db = openYoutubeDb(path); // actual production startup path
    for (const id of excluded) {
      assert.equal((db.prepare("SELECT enabled FROM yt_titles WHERE title_id=?").get(id) as any).enabled, 0);
      assert.equal((db.prepare("SELECT text FROM yt_comments WHERE title_id=?").get(id) as any).text, "retained history");
      const series = readYoutubeSeries(db, id, { start: "2026-08-01", end: "2026-08-01" }, now);
      assert.equal(series.rows[0].snapshotViews, 123);
      const feed = readCommentFeed(db, { steamAppId: String(id) }, now);
      assert.equal(feed.comments.length, 0);
      assert.equal(feed.tombstones.length, 0, "opting out must not tombstone history");
    }
    assert.equal((db.prepare("SELECT enabled FROM yt_titles WHERE title_id=?").get(main) as any).enabled, 1);
    assert.equal((db.prepare("SELECT count(*) n FROM yt_videos").get() as any).n, 2);
    assert.equal((db.prepare("SELECT count(*) n FROM yt_video_stats_daily").get() as any).n, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("disabled titles consume zero requests in discovery, stats, comments and old-text refresh", async () => {
  const db = openYoutubeDb(":memory:");
  try {
    syncTitles(db, buildTitleSources(products.slice(0, 2), [], new Map()), now);
    for (const id of excluded) history(db, id);
    const client = new YouTubeClient(db, "test-only", (async () => {
      assert.fail("disabled titles must never reach the API transport");
    }) as typeof fetch);
    const c = counters(), opts = { now: () => now };
    await runDiscovery(db, client, c, opts);
    await runStatsRefresh(db, client, c, opts);
    await runComments(db, client, c, opts);
    await runRetention(db, client, c, opts);
    assert.deepEqual(c, counters());
    assert.equal((db.prepare("SELECT count(*) n FROM yt_quota_daily").get() as any).n, 0);
    assert.equal((db.prepare("SELECT count(*) n FROM yt_comments WHERE excluded_at IS NULL").get() as any).n, 2);
  } finally { db.close(); }
});

test("main Toxic Commando still refreshes stats and comments while disabled siblings are skipped", async () => {
  const db = openYoutubeDb(":memory:");
  try {
    syncTitles(db, buildTitleSources(products, [], new Map()), now);
    for (const id of [...excluded, main]) history(db, id);
    const paths: string[] = [];
    const client = new YouTubeClient(db, "test-only", (async (input: any) => {
      const u = new URL(String(input)); paths.push(u.pathname);
      let items: any[] = [];
      if (u.pathname.endsWith("/videos")) {
        assert.equal(u.searchParams.get("id"), String(main));
        items = [{ id: String(main), snippet: { title: "Toxic Commando gameplay", categoryId: "20",
          publishedAt: old }, statistics: { viewCount: "150", commentCount: "1" } }];
      } else if (u.pathname.endsWith("/commentThreads")) {
        assert.equal(u.searchParams.get("videoId"), String(main));
      } else if (u.pathname.endsWith("/comments")) {
        assert.equal(u.searchParams.get("id"), `c${main}`);
        items = [{ id: `c${main}`, snippet: { textOriginal: "refreshed main game", likeCount: 1 } }];
      } else { assert.fail(`unexpected endpoint: ${u.pathname}`); }
      return new Response(JSON.stringify({ items }), { status: 200 });
    }) as typeof fetch);
    const c = counters(), opts = { now: () => now };
    await runStatsRefresh(db, client, c, opts);
    await runComments(db, client, c, opts);
    await runRetention(db, client, c, opts);
    assert.equal(c.videosRefreshed, 1);
    assert.equal(c.commentsRefreshed, 1);
    assert.ok(paths.some(p => p.endsWith("/commentThreads")));
    for (const id of excluded) {
      assert.equal((db.prepare("SELECT fetched_at FROM yt_comments WHERE title_id=?").get(id) as any).fetched_at, old);
      assert.equal((db.prepare("SELECT last_refreshed_at FROM yt_videos WHERE title_id=?").get(id) as any).last_refreshed_at, old);
    }
  } finally { db.close(); }
});
