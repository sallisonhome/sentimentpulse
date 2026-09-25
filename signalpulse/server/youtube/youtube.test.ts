import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openYoutubeDb, type YtDb } from "./db";
import { matchVideo, parseIsoDuration, isShortForm, RELEVANCE_VERSION } from "./relevance";
import { readCommentFeed } from "./feed";
import { computeCohortLeaderboard, windowStart, listTitleVideos } from "./cohort";
import { runRetention, removeVideo, runComments, type RunCounters } from "./pipeline";
import { scheduledRunDue } from "./cron";
import { syncTitles, backfillFloor, TITLE_SEEDS, seedFor, buildTitleSources, specificityExcludes, cleanTitleName, matchConfigOf, type ProductLite, type SentimentPulseGameLite } from "./titles";
import { aggregateLookup, runLookup, lookupConfig } from "./lookup";
import { readYoutubeSeries, SeriesInputError } from "./series";
import { youtubeSeriesCsv } from "../../shared/youtube-series";
import { YouTubeClient } from "./api";

const src = (products: ProductLite[], games: SentimentPulseGameLite[] | null = [], comp = new Map<number, number>()) => buildTitleSources(products, games, comp);

const cfg = (steam: string) => {
  const s = TITLE_SEEDS[steam];
  return { phrases: s.phrases, excludeTerms: s.excludeTerms ?? [], requiredTerms: s.requiredTerms, requireCompanion: !!s.requireCompanion };
};
const counters = (): RunCounters => ({ searchCalls: 0, units: 0, videosDiscovered: 0, videosRefreshed: 0, videosRemoved: 0, commentsSaved: 0, commentsRefreshed: 0, commentsDeleted: 0, notes: [] });
const DAY = 86_400_000;

function freshDb(): YtDb {
  return openYoutubeDb(":memory:");
}

test("completed comment backfill restarts without a literal null page token", async () => {
  const db = freshDb();
  const now = new Date();
  syncTitles(db, src([{ id: 1, title: "Game", steamAppId: "123", releaseDate: null }]));
  addVideo(db, { video_id: "v", title_id: 123, published_at: now.toISOString(), comment_count: 1 });
  db.prepare("UPDATE yt_videos SET comments_polled_at=?, comments_backfill_done=1, comments_backfill_token=NULL").run(now.toISOString());
  const urls: URL[] = [];
  const client = new YouTubeClient(db, "test-only", (async (input: any) => {
    const url = new URL(String(input));
    urls.push(url);
    assert.equal(url.searchParams.has("pageToken"), false);
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as typeof fetch);
  const c = counters();
  await runComments(db, client, c, { extendedStorageApproved: true, now: () => now });
  assert.equal(urls.length, 1);
  assert.deepEqual(c.notes, []);
  // Defense in depth for nullable DB values reaching any API caller.
  await client.commentThreads({ videoId: "v", pageToken: null as any });
  assert.equal(urls.length, 2);
  db.close();
});

function addVideo(db: YtDb, v: Partial<Record<string, any>> & { video_id: string; title_id: number; published_at: string }) {
  const row = {
    title: "t", channel_title: "c", view_count: 0, like_count: 0, comment_count: 0, is_short_form: 0,
    comments_disabled: 0, match_reason: "test", discovered_via: "incremental",
    first_seen_at: v.published_at, last_refreshed_at: new Date().toISOString(), ...v,
  };
  db.prepare(`INSERT INTO yt_videos (video_id, title_id, title, channel_title, published_at, view_count, like_count,
    comment_count, is_short_form, comments_disabled, match_reason, discovered_via, first_seen_at, last_refreshed_at)
    VALUES (@video_id, @title_id, @title, @channel_title, @published_at, @view_count, @like_count, @comment_count,
    @is_short_form, @comments_disabled, @match_reason, @discovered_via, @first_seen_at, @last_refreshed_at)`).run(row);
  db.prepare("UPDATE yt_videos SET relevance_version=? WHERE video_id=?").run(RELEVANCE_VERSION, v.video_id);
}

test("title time series separates publications, stored comments, snapshots and same-video velocity", () => {
  const db = freshDb();
  syncTitles(db, src([{ id: 1, title: "=Formula Game", steamAppId: "123", releaseDate: null }]));
  addVideo(db, { video_id: "old", title_id: 123, published_at: "2026-09-20T12:00:00Z" });
  addVideo(db, { video_id: "new", title_id: 123, published_at: "2026-09-22T12:00:00Z", is_short_form: 1 });
  db.prepare("INSERT INTO yt_comments(comment_id,video_id,title_id,text,published_at,fetched_at) VALUES('c','old',123,'kept','2026-09-22T15:00:00Z','2026-09-24T00:00:00Z')").run();
  const snap = db.prepare("INSERT INTO yt_video_stats_daily(video_id,date,view_count,like_count,comment_count) VALUES(?,?,?,?,?)");
  snap.run("old", "2026-09-21", 100, 10, 5);
  snap.run("old", "2026-09-22", 130, 12, 4); // correction can be negative
  snap.run("new", "2026-09-22", 1000, 100, 20); // no prior, never counted as velocity
  const s = readYoutubeSeries(db, 123, { start: "2026-09-21", end: "2026-09-23", bucket: "day" }, new Date("2026-09-24T00:00:00Z"));
  assert.equal(s.rows[1].publishedVideos, 1);
  assert.equal(s.rows[1].shortFormVideos, 1);
  assert.equal(s.rows[1].collectedComments, 1);
  assert.equal(s.rows[1].snapshotViews, 1130);
  assert.equal(s.rows[1].netViews, 30);
  assert.equal(s.rows[1].netComments, -1);
  assert.equal(s.rows[2].snapshotViews, null);
  assert.equal(s.rows[2].netViews, null);
  const csv = youtubeSeriesCsv(s);
  assert.match(csv, /^\uFEFFtitle_id,/);
  assert.match(csv, /'=Formula Game/); // formula injection neutralized
  assert.match(csv, /,"-1"\r\n/); // numeric correction remains signed, not formula escaped
});

test("title time series validates dates and aggregated velocity refuses partial buckets", () => {
  const db = freshDb();
  syncTitles(db, src([{ id: 1, title: "Game", steamAppId: "123", releaseDate: null }]));
  addVideo(db, { video_id: "v", title_id: 123, published_at: "2026-09-01T00:00:00Z" });
  const snap = db.prepare("INSERT INTO yt_video_stats_daily(video_id,date,view_count,like_count,comment_count) VALUES(?,?,?,?,?)");
  snap.run("v", "2026-09-21", 1, 1, 1); snap.run("v", "2026-09-22", 2, 2, 2);
  const weekly = readYoutubeSeries(db, 123, { start: "2026-09-21", end: "2026-09-23", bucket: "week" }, new Date("2026-09-24T00:00:00Z"));
  assert.equal(weekly.rows[0].netViews, null);
  assert.throws(() => readYoutubeSeries(db, 123, { start: "2026-09-24", end: "2026-09-21" }), SeriesInputError);
  assert.throws(() => readYoutubeSeries(db, 123, { start: "2026-09-21", end: "2026-09-25" }, new Date("2026-09-24T00:00:00Z")), /future/);
  assert.throws(() => readYoutubeSeries(db, 123, { start: "2026-02-30", end: "2026-09-24" }), /valid/);
  assert.throws(() => readYoutubeSeries(db, 123, { bucket: "year" }), /Bucket/);
  assert.throws(() => readYoutubeSeries(db, 999, {}), /not found/);
  const complete = readYoutubeSeries(db, 123, { start: "2026-09-22", end: "2026-09-22", bucket: "month" });
  assert.equal(complete.rows[0].netViews, 1);
  assert.equal(complete.rows[0].snapshotViews, 2);
  removeVideo(db, "v", "no_longer_matches", new Date("2026-09-24T00:00:00Z"));
  const hidden = readYoutubeSeries(db, 123, { start: "2026-09-01", end: "2026-09-24" });
  assert.equal(hidden.rows.reduce((n, r) => n + r.publishedVideos, 0), 0);
  assert.equal(hidden.archivedVideos, 1);
  const archived = readYoutubeSeries(db, 123, { start: "2026-09-01", end: "2026-09-24", includeArchived: true });
  assert.equal(archived.rows.reduce((n, r) => n + r.publishedVideos, 0), 1);
  assert.equal(archived.rows.find(r => r.date === "2026-09-22")!.snapshotViews, 2);
});

test("total view charts use title-specific observed snapshots, never sum buckets or fill missing days", () => {
  const db = freshDb();
  try {
    syncTitles(db, src([
      { id: 1, title: "Saber example", steamAppId: "123", releaseDate: null },
      { id: 2, title: "Other example", steamAppId: "456", releaseDate: null },
    ]));
    addVideo(db, { video_id: "a", title_id: 123, published_at: "2020-01-01T00:00:00Z", view_count: 999999 });
    addVideo(db, { video_id: "b", title_id: 456, published_at: "2020-01-01T00:00:00Z" });
    const snap = db.prepare("INSERT INTO yt_video_stats_daily(video_id,date,view_count) VALUES(?,?,?)");
    snap.run("a", "2026-09-21", 0);
    snap.run("a", "2026-09-22", 120);
    snap.run("a", "2026-09-24", 150);
    snap.run("b", "2026-09-22", 700);
    const now = new Date("2026-09-25T12:00:00Z");
    const daily = readYoutubeSeries(db, 123, { start: "2026-09-20", end: "2026-09-25" }, now);
    assert.deepEqual(daily.rows.map(r => r.snapshotViews), [null, 0, 120, null, 150, null]);
    assert.equal(daily.rows.reduce((n, r) => n + r.publishedVideos, 0), 0);
    for (const bucket of ["week", "month"]) {
      const complete = readYoutubeSeries(db, 123, { start: "2026-09-21", end: "2026-09-24", bucket }, now);
      assert.equal(complete.rows[0].snapshotViews, 150); // not 0 + 120 + 150
      assert.equal(complete.rows[0].endDate, "2026-09-24");
      const missingEnd = readYoutubeSeries(db, 123, { start: "2026-09-21", end: "2026-09-25", bucket }, now);
      assert.equal(missingEnd.rows[0].snapshotViews, null); // no carry-forward
    }
    const other = readYoutubeSeries(db, 456, { start: "2026-09-22", end: "2026-09-22" }, now);
    assert.equal(other.rows[0].snapshotViews, 700);
    const csv = youtubeSeriesCsv(daily);
    assert.ok(csv.includes("snapshotViews"));
  } finally {
    db.close();
  }
});

test("daily views exclude discovery totals, preserve corrections and require consecutive dates", () => {
  const db = freshDb();
  try {
    syncTitles(db, src([
      { id: 1, title: "Daily views example", steamAppId: "123", releaseDate: null },
      { id: 2, title: "Other title", steamAppId: "456", releaseDate: null },
    ]));
    addVideo(db, { video_id: "old", title_id: 123, published_at: "2020-01-01T00:00:00Z" });
    addVideo(db, { video_id: "discovered", title_id: 123, published_at: "2020-01-01T00:00:00Z" });
    addVideo(db, { video_id: "other", title_id: 456, published_at: "2020-01-01T00:00:00Z" });
    const snap = db.prepare("INSERT INTO yt_video_stats_daily(video_id,date,view_count) VALUES(?,?,?)");
    for (const [date, views] of [["2026-09-20", 1000], ["2026-09-21", 1100], ["2026-09-22", 1100], ["2026-09-23", 1080], ["2026-09-25", 1200]] as const) snap.run("old", date, views);
    snap.run("discovered", "2026-09-21", 9000000); // lifetime total must never become daily growth
    snap.run("other", "2026-09-20", 0);
    snap.run("other", "2026-09-21", 500000);
    const now = new Date("2026-09-25T12:00:00Z");
    const daily = readYoutubeSeries(db, 123, { start: "2026-09-20", end: "2026-09-25" }, now);
    assert.deepEqual(daily.rows.map(r => r.netViews), [null, 100, 0, -20, null, null]);
    assert.equal(daily.rows[1].snapshotViews, 9001100);
    for (const bucket of ["day", "week", "month"]) {
      const series = readYoutubeSeries(db, 123, { start: "2026-09-21", end: "2026-09-23", bucket }, now);
      assert.deepEqual(series.rows.map(r => r.netViews), bucket === "day" ? [100, 0, -20] : [80]);
      // The day preceding the custom start remains a valid baseline.
      const csv = youtubeSeriesCsv(series).trim().split("\r\n");
      const column = csv[0].split(",").indexOf("netViews");
      assert.deepEqual(csv.slice(1).map(line => Number(line.split(",")[column].replaceAll('"', ""))),
        series.rows.map(r => r.netViews));
      if (bucket !== "day") {
        const incomplete = readYoutubeSeries(db, 123, { start: "2026-09-21", end: "2026-09-25", bucket }, now);
        assert.equal(incomplete.rows[0].netViews, null);
      }
    }
  } finally { db.close(); }
});

test("PDP featured views chart uses daily changes rather than lifetime snapshots", () => {
  const page = readFileSync(new URL("../../client/src/pages/youtube-title-detail.tsx", import.meta.url), "utf8");
  assert.match(page, /metric="netViews" title=\{`\$\{viewsLabel\} over time`\}/);
  assert.doesNotMatch(page, /metric="snapshotViews"/);
  assert.doesNotMatch(page, /Total views over time/);
  assert.match(page, /color="#38a8c9" featured bars/);
});

// ─── relevance ───────────────────────────────────────────────────────────────

test("relevance: phrase must be in the video title, hashtags count for long phrases", () => {
  const sm = cfg("2183900");
  assert.equal(matchVideo(sm, { title: "Space Marine 2 – Siege mode gameplay", categoryId: "20" }).admit, true);
  assert.equal(matchVideo(sm, { title: "Insane clutch #SpaceMarine2 #shorts", categoryId: "20" }).admit, true);
  assert.equal(matchVideo(sm, { title: "Top 10 games of 2024", description: "includes Space Marine 2", categoryId: "20" }).admit, false);
});

test("relevance: ambiguous titles need Gaming category AND a game term; excludes reject", () => {
  const jw = cfg("2947860");
  assert.equal(matchVideo(jw, { title: "John Wick game reveal trailer", description: "Saber Interactive official game", categoryId: "20" }).admit, true);
  assert.equal(matchVideo(jw, { title: "John Wick game reveal trailer", categoryId: "24" }).admit, false);
  assert.equal(matchVideo(jw, { title: "John Wick Chapter 4 ending explained", categoryId: "20" }).admit, false);
  assert.equal(matchVideo(jw, { title: "John Wick movie trailer breakdown game", categoryId: "20" }).admit, false);
  assert.equal(matchVideo(jw, { title: "John Wick in Fortnite gameplay", categoryId: "20" }).admit, false);
  const wwz = cfg("699130");
  assert.equal(matchVideo(wwz, { title: "World War Z Aftermath co-op gameplay", categoryId: "20" }).admit, true);
  assert.equal(matchVideo(wwz, { title: "World War Z (2013) Brad Pitt scene", categoryId: "1" }).admit, false);
  const docked = cfg("2487300");
  assert.equal(matchVideo(docked, { title: "Switch 2 docked vs handheld performance", categoryId: "20" }).admit, false);
  assert.equal(matchVideo(docked, { title: "Docked – port management sim gameplay", categoryId: "20" }).admit, true);
  const rk = cfg("2141130");
  assert.equal(matchVideo(rk, { title: "Road Kings MC ride out", categoryId: "20" }).admit, false);
});

test("relevance: non-ambiguous titles admit with Gaming category or a game term", () => {
  const sr = cfg("1465360");
  assert.equal(matchVideo(sr, { title: "SnowRunner season 15 trailer", categoryId: "22" }).admit, true);
  assert.equal(matchVideo(sr, { title: "SnowRunner", categoryId: "20" }).admit, true);
  assert.equal(matchVideo(sr, { title: "SnowRunner", categoryId: "22" }).admit, false);
});

test("durations: ISO parsing and short-form (<=180s, never live)", () => {
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("P1DT1S"), 86401);
  assert.equal(parseIsoDuration("P0D"), 0);
  assert.equal(parseIsoDuration("garbage"), null);
  assert.equal(parseIsoDuration(null), null);
  assert.equal(isShortForm(180), true);
  assert.equal(isShortForm(181), false);
  assert.equal(isShortForm(0), false);
  assert.equal(isShortForm(null), false);
  assert.equal(isShortForm(30, "live"), false);
  assert.equal(isShortForm(30, "none"), true);
});

// ─── titles ──────────────────────────────────────────────────────────────────

test("relevance regressions: other-game comparisons, docked hardware and substring matches", () => {
  const jw = cfg("2947860"), docked = cfg("2487300"), rk = cfg("2141130");
  for (const title of [
    "BLACKWOOD - Part 1 - The Beginning (John Wick Simulator)",
    "This Is Basically John Wick in a Cyberpunk World! | SPINE",
    "I am the John Wick of BF6 #battlefield6",
    "John Wick game reveal trailer", // without Saber identity, uncertain
  ]) assert.equal(matchVideo(jw, { title, categoryId: "20" }).admit, false, title);
  assert.equal(matchVideo(jw, { title: "Saber's John Wick game reveal trailer", categoryId: "20" }).admit, true);
  for (const title of [
    "This game lets you play chess docked to a corner of your screen",
    "Call of Duty Beta #NintendoSwitch2 Gameplay (Docked)",
    "Yaka Gaming docked",
  ]) assert.equal(matchVideo(docked, { title, categoryId: "20" }).admit, false, title);
  assert.equal(matchVideo(docked, { title: "Docked port management gameplay", categoryId: "20" }).admit, true);
  assert.equal(matchVideo(rk, { title: 'Day 006: "The Off-road Kings" DayZ gameplay', categoryId: "20" }).admit, false);
  assert.equal(matchVideo(cfg("2183900"), { title: "#notspacemarine2 gameplay", categoryId: "20" }).admit, false);
  assert.equal(matchVideo(cfg("2183900"), { title: "#spacemarine2 gameplay", categoryId: "20" }).admit, true);
});

test("feed: verified-only, stable snapshots, tied timestamps, deletion-only resumes", () => {
  const db = freshDb();
  const at = "2026-09-24T12:00:00.000Z", snapshot = "2026-09-24T13:00:00.000Z";
  syncTitles(db, src([{ id: 1, title: "Game", steamAppId: "123", releaseDate: null }]));
  addVideo(db, { video_id: "v", title_id: 123, published_at: at });
  addVideo(db, { video_id: "unverified", title_id: 123, published_at: at });
  db.prepare("UPDATE yt_videos SET relevance_version=0 WHERE video_id='unverified'").run();
  for (const [id, video, fetched] of [["a", "v", at], ["b", "v", at], ["c", "unverified", at], ["d", "v", "2026-09-24T14:00:00.000Z"]]) {
    db.prepare("INSERT INTO yt_comments(comment_id,video_id,title_id,text,published_at,fetched_at) VALUES (?,?,123,'text',?,?)").run(id, video, at, fetched);
  }
  db.prepare("INSERT INTO yt_comment_tombstones(comment_id,title_id,reason,deleted_at) VALUES('deleted',123,'no_longer_matches',?)").run(at);
  const first = readCommentFeed(db, { until: snapshot, limit: 1, steamAppId: "123" }, new Date("2026-09-24T15:00:00Z"));
  assert.equal(first.comments[0].commentId, "a");
  assert.equal(first.feedVersion, 2);
  const second = readCommentFeed(db, { until: snapshot, limit: 1, steamAppId: "123", cursor: first.nextCursor! }, new Date("2026-09-24T15:00:00Z"));
  assert.equal(second.comments[0].commentId, "b");
  assert.equal(second.tombstones.length, 1);
  const last = readCommentFeed(db, { until: snapshot, limit: 1, steamAppId: "123", cursor: second.nextCursor! }, new Date("2026-09-24T15:00:00Z"));
  assert.equal(last.comments.length, 0);
  assert.equal(last.nextCursor, null);
  assert.equal(last.tombstones.length, 1);
  assert.equal(computeCohortLeaderboard(db, "ltd")[0].videos, 1);
  assert.throws(() => readCommentFeed(db, { cursor: "broken" }), /cursor/);
});

test("daily collection polls unchanged totals and updates replies on known threads", async () => {
  const db = freshDb(), now = new Date("2026-09-24T12:00:00Z");
  addVideo(db, { video_id: "v", title_id: 3, published_at: "2026-09-01T00:00:00Z", comment_count: 2 });
  db.prepare(`UPDATE yt_videos SET comments_count_at_poll=2,comments_polled_at='2026-09-23T12:00:00Z',
    comments_newest_at='2026-09-22T12:00:00Z',comments_backfill_done=1`).run();
  const old = "2026-09-20T12:00:00Z";
  let calls = 0;
  const fake: any = {
    commentThreads: async () => {
      calls++;
      return { items: [{
        snippet: { topLevelComment: { id: "parent", snippet: { textOriginal: "edited", publishedAt: old } }, totalReplyCount: 1 },
        replies: { comments: [{ id: "reply", snippet: { textOriginal: "new reply", publishedAt: now.toISOString() } }] },
      }] };
    },
  };
  const c = counters();
  await runComments(db, fake, c, { extendedStorageApproved: false, now: () => now });
  assert.ok(calls >= 1);
  assert.equal((db.prepare("SELECT text FROM yt_comments WHERE comment_id='parent'").get() as any).text, "edited");
  assert.equal((db.prepare("SELECT parent_id FROM yt_comments WHERE comment_id='reply'").get() as any).parent_id, "parent");
  assert.equal((db.prepare("SELECT comments_polled_at FROM yt_videos").get() as any).comments_polled_at, now.toISOString());
  assert.equal((db.prepare("SELECT comments_backfill_polled_at FROM yt_videos").get() as any).comments_backfill_polled_at, now.toISOString());
});

test("older thread sweeps rotate independently from new-comment polling", async () => {
  const db = freshDb(), now = new Date("2026-09-24T12:00:00Z");
  for (const id of ["a", "b"]) addVideo(db, { video_id: id, title_id: 3, published_at: now.toISOString(), comment_count: 1 });
  db.prepare("UPDATE yt_videos SET comments_polled_at=?").run(now.toISOString());
  db.prepare("UPDATE yt_videos SET comments_backfill_polled_at=? WHERE video_id='a'").run(now.toISOString());
  const order: string[] = [];
  const fake: any = { commentThreads: async ({ videoId }: any) => { order.push(videoId); return { items: [] }; } };
  await runComments(db, fake, counters(), { extendedStorageApproved: false, now: () => now });
  assert.deepEqual(order, ["b", "a"]);
});

test("titles: floor, seed fallback, manual config preserved, removed titles disabled", () => {
  assert.equal(backfillFloor("2028-11-09"), "2024-11-09");
  assert.equal(backfillFloor("2019-01-01"), "2017-01-01");
  assert.equal(backfillFloor(""), "2017-01-01");
  assert.equal(backfillFloor(null), "2017-01-01");
  assert.equal(seedFor({ steamAppId: "999", name: "New Game™" }).requireCompanion, true);
  assert.deepEqual(seedFor({ steamAppId: "999", name: "New Game™" }).phrases, ["new game"]);
  const db = freshDb();
  syncTitles(db, src([
    { id: 3, title: "Space Marine 2", steamAppId: "2183900", releaseDate: "2024-09-09" },
    { id: 9, title: "World War Z", steamAppId: "699130", releaseDate: "2019-04-16" },
  ]));
  db.prepare("UPDATE yt_titles SET config_source='manual', search_query='custom' WHERE title_id=699130").run();
  syncTitles(db, src([{ id: 9, title: "World War Z", steamAppId: "699130", releaseDate: "2019-04-16" }]));
  const rows = db.prepare("SELECT title_id, enabled, search_query FROM yt_titles ORDER BY title_id").all() as any[];
  assert.deepEqual(rows, [
    { title_id: 699130, enabled: 1, search_query: "custom" },
    { title_id: 2183900, enabled: 0, search_query: '"space marine 2"' },
  ]);
  // non-authoritative sync (SentimentPulse unreachable) never disables
  syncTitles(db, src([{ id: 3, title: "Space Marine 2", steamAppId: "2183900", releaseDate: "2024-09-09" }]), new Date(), false);
  assert.equal((db.prepare("SELECT enabled FROM yt_titles WHERE title_id=699130").get() as any).enabled, 1);
});

test("titles: SentimentPulse games incl. competitors are tracked; aliases fold; products win names", () => {
  assert.equal(cleanTitleName("Clive Barker's Hellraiser: Revival"), "Hellraiser: Revival");
  assert.equal(cleanTitleName("Untitled John Wick Game"), "John Wick");
  assert.equal(cleanTitleName("HOT WHEELS UNLEASHED™"), "HOT WHEELS UNLEASHED");
  const games: SentimentPulseGameLite[] = [
    { id: 21, steam_app_id: 1551980, name: "Clive Barker's Hellraiser: Revival", release_date: null, is_active: true, alias_steam_app_ids: [5184670] },
    { id: 156, steam_app_id: 5184670, name: "Clive Barker's Hellraiser: Revival Demo", release_date: null, is_active: true },
    { id: 138, steam_app_id: 1757350, name: "ILL", release_date: null, is_active: true },
    { id: 99, steam_app_id: 111, name: "Inactive", release_date: null, is_active: false },
  ];
  const s = src([{ id: 7, title: "Hellraiser: Revival", steamAppId: "1551980", releaseDate: "2026-10-08" }], games, new Map([[138, 21]]));
  assert.deepEqual(s.map((t) => [t.steamAppId, t.name, t.isSaber, t.parentSteamAppId, t.source]).sort(), [
    ["1551980", "Hellraiser: Revival", true, null, "both"],
    ["1757350", "ILL", false, "1551980", "sentimentpulse"],
  ]);
  const db = freshDb();
  syncTitles(db, s);
  const lb = computeCohortLeaderboard(db, "d7");
  assert.deepEqual(lb.map((r) => r.titleId), [1551980]); // Saber scope by default
  const all = computeCohortLeaderboard(db, "d7", "views", "desc", new Date(), "all");
  const ill = all.find((r) => r.titleId === 1757350)!;
  assert.equal(ill.isSaber, false);
  assert.equal(ill.parentTitle, "Hellraiser: Revival");
});

test("titles: overlapping names go to the more specific title", () => {
  assert.deepEqual(specificityExcludes(["mudrunner", "mud runner"], [["expeditions a mudrunner game", "mudrunner expeditions"], ["snowrunner"]]),
    ["expeditions a mudrunner game", "mudrunner expeditions"]);
  assert.deepEqual(specificityExcludes(["space marine 2"], [["space marine"]]), []);
  const db = freshDb();
  syncTitles(db, src([
    { id: 1, title: "MudRunner", steamAppId: "675010", releaseDate: "2017-10-31" },
    { id: 2, title: "Expeditions: A MudRunner Game", steamAppId: "2477340", releaseDate: "2024-03-05" },
  ]));
  const mr = matchConfigOf(db.prepare("SELECT * FROM yt_titles WHERE title_id=675010").get() as any);
  const ex = matchConfigOf(db.prepare("SELECT * FROM yt_titles WHERE title_id=2477340").get() as any);
  const v = { title: "Expeditions: A MudRunner Game – new DLC gameplay", categoryId: "20" };
  assert.equal(matchVideo(mr, v).admit, false);
  assert.equal(matchVideo(ex, v).admit, true);
  assert.equal(matchVideo(mr, { title: "MudRunner Xbox gameplay", categoryId: "20" }).admit, true);
});

// ─── cohort ──────────────────────────────────────────────────────────────────

test("cohort: window membership by publish date, sums of current stats, likes% excludes hidden likes", () => {
  const db = freshDb();
  const now = new Date("2026-09-24T12:00:00Z");
  syncTitles(db, src([
    { id: 3, title: "Space Marine 2", steamAppId: "3", releaseDate: "2024-09-09" },
    { id: 16, title: "SnowRunner", steamAppId: "16", releaseDate: "2020-04-28" },
    { id: 17, title: "Twisted Tower", steamAppId: "17", releaseDate: "2026-01-01" },
  ]), now);
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
  addVideo(db, { video_id: "a", title_id: 3, published_at: ago(2), view_count: 1000, like_count: 50, comment_count: 10, is_short_form: 1 });
  addVideo(db, { video_id: "b", title_id: 3, published_at: ago(30), view_count: 5000, like_count: null, comment_count: 20 });
  addVideo(db, { video_id: "c", title_id: 16, published_at: ago(5), view_count: 3000, like_count: 300, comment_count: 1 });
  addVideo(db, { video_id: "d", title_id: 16, published_at: ago(24 * 400), view_count: 900000, like_count: 9000, comment_count: 5 });

  const d1 = computeCohortLeaderboard(db, "d1", "views", "desc", now);
  assert.deepEqual(d1.map((r) => [r.titleId, r.views, r.videos]), [[16, 3000, 1], [3, 1000, 1], [17, 0, 0]]);
  assert.equal(d1[1].shortForm, 1);
  assert.equal(d1[1].likesPct, 5);

  const d7 = computeCohortLeaderboard(db, "d7", "views", "desc", now);
  const sm = d7.find((r) => r.titleId === 3)!;
  assert.equal(sm.views, 6000);
  assert.equal(sm.likes, 50);
  assert.equal(sm.likesHiddenVideos, 1);
  assert.equal(sm.likesPct, 5); // 50 / 1000, the hidden-likes video is excluded from the denominator
  assert.equal(sm.topVideo?.videoId, "b");

  const ltd = computeCohortLeaderboard(db, "ltd", "views", "desc", now);
  assert.equal(ltd[0].titleId, 16);
  assert.equal(ltd[0].views, 903000);
  const m12 = computeCohortLeaderboard(db, "m12", "views", "desc", now);
  assert.equal(m12.find((r) => r.titleId === 16)!.views, 3000);

  // missing likesPct sorts last in both directions
  for (const dir of ["asc", "desc"] as const) {
    const s = computeCohortLeaderboard(db, "d1", "likesPct", dir, now);
    assert.equal(s[s.length - 1].titleId, 17);
  }
  const byTitle = computeCohortLeaderboard(db, "ltd", "title", "asc", now);
  assert.deepEqual(byTitle.map((r) => r.title), ["SnowRunner", "Space Marine 2", "Twisted Tower"]);
  assert.equal(windowStart("ltd", now), null);
  assert.deepEqual(listTitleVideos(db, 3, "d7", 10, now).map((v) => v.videoId), ["b", "a"]);
});

// ─── retention ───────────────────────────────────────────────────────────────

test("retention: comments, videos and snapshots survive age boundaries permanently", async () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
  for (const approved of [false, true]) {
    const db = freshDb();
    addVideo(db, { video_id: "fresh", title_id: 3, published_at: ago(100), last_refreshed_at: ago(1) });
    addVideo(db, { video_id: "stale", title_id: 3, published_at: ago(100), last_refreshed_at: ago(31) });
    const addC = (id: string, vid: string, fetched: string) => db.prepare(`INSERT INTO yt_comments (comment_id, video_id, title_id, text, published_at, fetched_at)
      VALUES (?, ?, 3, 'txt', ?, ?)`).run(id, vid, fetched, fetched);
    addC("c-new", "fresh", ago(1));
    addC("c-28", "fresh", ago(28));
    addC("c-31", "fresh", ago(31));
    addC("c-stalevid", "stale", ago(2));
    const addS = (vid: string, days: number) => db.prepare("INSERT INTO yt_video_stats_daily (video_id, date, view_count) VALUES (?, ?, 1)").run(vid, ago(days).slice(0, 10));
    addS("fresh", 5); addS("fresh", 40); addS("fresh", 400);
    db.prepare("INSERT INTO yt_comment_tombstones (comment_id, title_id, reason, deleted_at) VALUES ('old-t', 3, 'x', ?)").run(ago(50));

    const c = counters();
    await runRetention(db, null, c, { retentionMode: "unlimited", extendedStorageApproved: approved, now: () => now });

    const comments = (db.prepare("SELECT comment_id FROM yt_comments ORDER BY comment_id").all() as any[]).map((r) => r.comment_id);
    assert.deepEqual(comments, ["c-28", "c-31", "c-new", "c-stalevid"]);
    const videos = (db.prepare("SELECT video_id FROM yt_videos").all() as any[]).map((r) => r.video_id);
    assert.deepEqual(videos.sort(), ["fresh", "stale"]);
    const tomb = (db.prepare("SELECT comment_id, reason FROM yt_comment_tombstones ORDER BY comment_id").all() as any[]);
    assert.deepEqual(tomb, [
      { comment_id: "old-t", reason: "x" },
    ]);
    const statDays = (db.prepare("SELECT COUNT(*) AS n FROM yt_video_stats_daily").get() as any).n;
    assert.equal(statDays, 3);
    assert.equal(c.videosRemoved, 0);
    removeVideo(db, "fresh", "no_longer_matches", now);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM yt_video_stats_daily").get() as any).n, 3);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM yt_comments").get() as any).n, 4);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM yt_videos").get() as any).n, 2);
  }
});

test("retention: edit refresh and removal exclusions never erase the stored text", async () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
  const db = freshDb();
  addVideo(db, { video_id: "v", title_id: 3, published_at: ago(60), last_refreshed_at: ago(1) });
  for (const id of ["keep", "gone"]) db.prepare(`INSERT INTO yt_comments (comment_id, video_id, title_id, text, published_at, fetched_at)
    VALUES (?, 'v', 3, 'old', ?, ?)`).run(id, ago(28), ago(28));
  const fake: any = { commentsById: async (ids: string[]) => ({ items: ids.filter((i) => i === "keep").map((id) => ({ id, snippet: { textOriginal: "edited", likeCount: 4 } })) }) };
  const c = counters();
  await runRetention(db, fake, c, { retentionMode: "unlimited", extendedStorageApproved: false, now: () => now });
  const rows = db.prepare("SELECT comment_id, text, fetched_at FROM yt_comments WHERE excluded_at IS NULL").all() as any[];
  assert.deepEqual(rows, [{ comment_id: "keep", text: "edited", fetched_at: now.toISOString() }]);
  assert.equal(c.commentsRefreshed, 1);
  assert.equal((db.prepare("SELECT text FROM yt_comments WHERE comment_id='gone'").get() as any).text, "old");
  assert.equal((db.prepare("SELECT reason FROM yt_comment_tombstones WHERE comment_id='gone'").get() as any).reason, "removed_on_youtube");
});

test("retention unlimited (default): nothing is purged by age, only caches are trimmed", async () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
  const db = freshDb();
  addVideo(db, { video_id: "old", title_id: 3, published_at: ago(900), last_refreshed_at: ago(200) });
  db.prepare(`INSERT INTO yt_comments (comment_id, video_id, title_id, text, published_at, fetched_at) VALUES ('c', 'old', 3, 'txt', ?, ?)`).run(ago(400), ago(400));
  db.prepare("INSERT INTO yt_video_stats_daily (video_id, date, view_count) VALUES ('old', ?, 1)").run(ago(700).slice(0, 10));
  db.prepare("INSERT INTO yt_rejected_videos (video_id, title_id, reason, seen_at) VALUES ('r', 3, 'x', ?)").run(ago(31));
  db.prepare("INSERT INTO yt_comment_tombstones (comment_id, title_id, reason, deleted_at) VALUES ('t', 3, 'x', ?)").run(ago(50));
  let calls = 0;
  const fake: any = { commentsById: async () => { calls++; return { items: [] }; } };
  const c = counters();
  await runRetention(db, null, c, { extendedStorageApproved: false, now: () => now }); // mode omitted → unlimited
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
  assert.equal(n("yt_videos"), 1);
  assert.equal(n("yt_comments"), 1);
  assert.equal(n("yt_video_stats_daily"), 1);
  assert.equal(n("yt_rejected_videos"), 0);
  assert.equal(n("yt_comment_tombstones"), 1); // durable deletion delivery
  assert.equal(calls, 0); // unavailable API does not cause age-only erasure
  assert.equal(c.commentsDeleted, 0);
});

// ─── lookup ──────────────────────────────────────────────────────────────────

test("lookup: same metrics over 24h/7d/30d, relevance applied, cached without spending quota", async () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
  const items: Record<string, any> = {
    v1: { id: "v1", snippet: { title: "Helldivers 2 new warbond gameplay", categoryId: "20", publishedAt: ago(3), channelTitle: "A" }, statistics: { viewCount: "1000", likeCount: "100", commentCount: "10" }, contentDetails: { duration: "PT59S" } },
    v2: { id: "v2", snippet: { title: "Helldivers 2 review", categoryId: "20", publishedAt: ago(24 * 5), channelTitle: "B" }, statistics: { viewCount: "5000", commentCount: "3" }, contentDetails: { duration: "PT12M" } },
    v3: { id: "v3", snippet: { title: "Helldivers 2 patch notes", categoryId: "20", publishedAt: ago(24 * 20), channelTitle: "C" }, statistics: { viewCount: "2000", likeCount: "40", commentCount: "0" }, contentDetails: { duration: "PT4M" } },
    v4: { id: "v4", snippet: { title: "Top 10 co-op games", description: "helldivers 2", categoryId: "20", publishedAt: ago(10), channelTitle: "D" }, statistics: { viewCount: "99999" }, contentDetails: { duration: "PT20M" } },
  };
  let searches = 0;
  const fake: any = {
    counters: { searchCalls: 0, units: 0 },
    search: async () => { searches++; fake.counters.searchCalls++; return { items: Object.keys(items).map((id) => ({ id: { videoId: id } })) }; },
    videos: async (ids: string[]) => { fake.counters.units++; return { items: ids.map((i) => items[i]) }; },
  };
  const db = freshDb();
  const r = await runLookup(db, fake, "  Helldivers   2 ", { now });
  assert.equal(r.query, "Helldivers 2");
  assert.equal(r.admitted, 3);
  assert.equal(r.rejected, 1);
  assert.deepEqual([r.windows.d1.views, r.windows.d7.views, r.windows.d30.views], [1000, 6000, 8000]);
  assert.deepEqual([r.windows.d1.videos, r.windows.d7.videos, r.windows.d30.videos], [1, 2, 3]);
  assert.equal(r.windows.d30.shortForm, 1);
  assert.equal(r.windows.d30.comments, 13);
  assert.equal(r.windows.d30.likes, 140);
  assert.equal(r.windows.d30.likesPct, (140 / 3000) * 100); // v2 hides likes → out of the ratio
  assert.equal(r.windows.d30.likesHiddenVideos, 1);
  assert.equal(r.topVideos[0].videoId, "v2");
  assert.equal(r.coverage.exhausted, true);
  const again = await runLookup(db, fake, "helldivers 2", { now });
  assert.equal(again.cached, true);
  assert.equal(searches, 1);
  await assert.rejects(() => runLookup(db, fake, "ab", { now }), /at least 3/);
  // strict needs a game term AND Gaming category
  assert.equal(matchVideo(lookupConfig("Alien", true), { title: "Alien Isolation", categoryId: "1" }).admit, false);
  assert.equal(aggregateLookup([], now).d30.likesPct, null);
});

// ─── cron ────────────────────────────────────────────────────────────────────

test("cron: due from 04:30 ET until 20:00 ET, once per ET day", () => {
  // 2026-09-24 is EDT (UTC-4)
  assert.equal(scheduledRunDue(new Date("2026-09-24T08:29:00Z"), null), false); // 04:29 ET
  assert.equal(scheduledRunDue(new Date("2026-09-24T08:30:00Z"), null), true);  // 04:30 ET
  assert.equal(scheduledRunDue(new Date("2026-09-24T08:30:00Z"), "2026-09-24"), false);
  assert.equal(scheduledRunDue(new Date("2026-09-24T15:00:00Z"), "2026-09-23"), true); // catch-up at 11:00 ET
  assert.equal(scheduledRunDue(new Date("2026-09-25T00:00:00Z"), "2026-09-23"), false); // 20:00 ET
  // winter (EST, UTC-5)
  assert.equal(scheduledRunDue(new Date("2026-12-01T09:30:00Z"), null), true);
  assert.equal(scheduledRunDue(new Date("2026-12-01T09:29:00Z"), null), false);
});
