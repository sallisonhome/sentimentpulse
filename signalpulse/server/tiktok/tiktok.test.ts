/**
 * TikTok Pulse unit tests.
 *
 * Tests: relevance rules, cohort leaderboard SQL, comment-feed pagination,
 * pipeline discovery admit/reject, and permanent-retention exclusions.
 * No live EnsembleData calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { matchVideo, RELEVANCE_VERSION } from "./relevance";
import { TIKTOK_SCHEMA_SQL, openTikTokDb } from "./db";
import { computeCohortLeaderboard, listTitleVideos } from "./cohort";
import { scheduledTikTokRunDue } from "./cron";
import { readCommentFeed } from "./feed";
import { readTikTokSeries } from "./series";
import { syncTitles, buildTitleSources, applyCollectionExclusions, TITLE_SEEDS } from "./titles";
import { removeVideo, runPipeline } from "./pipeline";
import { EnsembleDataClient, type EnsembleDataResponse } from "./api";

// ── Relevance ──
test("relevance admits Space Marine 2 gameplay post", () => {
  const verdict = matchVideo(
    { phrases: ["space marine 2"], excludeTerms: [], requireCompanion: false },
    { desc: "Space Marine 2 gameplay part 1 #spacemarine2" },
  );
  assert.equal(verdict.admit, true);
});

test("relevance rejects movie-only John Wick post", () => {
  const verdict = matchVideo(
    {
      phrases: ["john wick"],
      excludeTerms: ["movie", "film", "chapter 4"],
      requiredTerms: ["saber"],
      requireCompanion: true,
    },
    { desc: "John Wick Chapter 4 movie clip" },
  );
  assert.equal(verdict.admit, false);
});

test("relevance rejects post with no distinctive phrase", () => {
  const verdict = matchVideo(
    { phrases: ["space marine 2"], excludeTerms: [], requireCompanion: false },
    { desc: "Great gameplay of a war game" },
  );
  assert.equal(verdict.admit, false);
});

// ── Cohort leaderboard ──
function seedDb() {
  const db = new Database(":memory:");
  db.exec(TIKTOK_SCHEMA_SQL);
  const iso = (n: number) => new Date(n).toISOString();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tt_titles (title_id, title, steam_app_id, is_saber, phrases, exclude_terms,` +
    ` title_excludes, required_terms, require_companion, enabled, backfill_floor, config_source, updated_at)` +
    ` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(2183900, "Space Marine 2", "2183900", 1, JSON.stringify(["space marine 2"]),
    JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 0, 1, "2017-01-01", "seed", iso(now));
  db.prepare(
    `INSERT INTO tt_videos (aweme_id, title_id, desc, create_time, view_count, like_count,` +
    ` comment_count, repost_count, match_reason, relevance_version, discovered_via, first_seen_at, last_refreshed_at)` +
    ` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("aw1", 2183900, "Space Marine 2 gameplay", Math.floor((now - 86400_000) / 1000), 1000, 100, 50, 10,
    "space marine 2", RELEVANCE_VERSION, "hashtag", iso(now), iso(now));
  db.prepare(
    `INSERT INTO tt_video_stats_daily (aweme_id, date, view_count, like_count, comment_count)` +
    ` VALUES (?, ?, ?, ?, ?)`
  ).run("aw1", new Date(now).toISOString().slice(0, 10), 1000, 100, 50);
  return db;
}

test("cohort leaderboard aggregates views for 24h window", () => {
  const db = seedDb();
  const rows = computeCohortLeaderboard(db, "d1", "views", "desc");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].views, 1000);
  assert.equal(rows[0].likesPct, 10);
});

test("cohort excludes out-of-window videos", () => {
  const db = seedDb();
  // Push the video's create_time to 3 days ago so it falls outside d1 but inside d7.
  db.prepare("UPDATE tt_videos SET create_time=? WHERE aweme_id='aw1'")
    .run(Math.floor((Date.now() - 3 * 86400_000) / 1000));
  const rows = computeCohortLeaderboard(db, "d1", "views", "desc");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].videos, 0);
  const d7 = computeCohortLeaderboard(db, "d7", "views", "desc");
  assert.equal(d7[0].videos, 1);
});

// ── Feed ──
test("comment feed paginates by fetched_at", () => {
  const db = seedDb();
  const now = new Date(Date.now() - 5000); // fetched 5s ago so it's inside the feed window
  const ins = db.prepare(
    `INSERT INTO tt_comments (cid, aweme_id, title_id, text, like_count, create_time, fetched_at)` +
    ` VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run("c1", "aw1", 2183900, "first comment", 5, Math.floor(Date.now() / 1000), now.toISOString());
  ins.run("c2", "aw1", 2183900, "second comment", 3, Math.floor(Date.now() / 1000), now.toISOString());
  const page = readCommentFeed(db, { limit: 1 });
  assert.equal(page.comments.length, 1);
  assert.equal(page.nextCursor, `${now.toISOString()}|c1`);
  const page2 = readCommentFeed(db, { cursor: page.nextCursor, limit: 1 });
  assert.equal(page2.comments.length, 1);
  assert.equal(page2.comments[0].commentId, "c2");
});

// ── Pipeline discovery admit/reject (no live calls) ──
test("discovery admits on-topic post and rejects off-topic post", async () => {
  const db = seedDb();
  // Fake client that returns a fixed set of posts
  const fakeClient = {
    hashtagPosts: async (name: string, cursor: number): Promise<EnsembleDataResponse> => ({
      data: {
        data: [
          { aweme_id: "on1", desc: "Space Marine 2 gameplay walkthrough", create_time: Math.floor(Date.now() / 1000), statistics: { play_count: 500 } },
          { aweme_id: "off1", desc: "Movie trailer clip", create_time: Math.floor(Date.now() / 1000), statistics: { play_count: 10 } },
        ],
        nextCursor: null,
      },
      units_charged: 1,
    }),
    keywordSearch: async (): Promise<EnsembleDataResponse> => ({ data: { data: [], nextCursor: null }, units_charged: 0 }),
    postInfo: async (): Promise<EnsembleDataResponse> => ({ data: { post: null }, units_charged: 0 }),
    postComments: async (): Promise<EnsembleDataResponse> => ({ data: { comments: [], nextCursor: null }, units_charged: 0 }),
  };
  // Seed hashtags on the title
  db.prepare("UPDATE tt_titles SET hashtags=?").run(JSON.stringify(["spacemarine2"]));
  const counters = await runPipeline(db, fakeClient as unknown as EnsembleDataClient, {
    extendedStorageApproved: true, steps: ["discovery"],
  }, "test");
  assert.equal(counters.videosDiscovered, 1);
  const rejected = (db.prepare("SELECT COUNT(*) AS n FROM tt_rejected_videos").get() as any).n;
  assert.equal(rejected, 1);
});

/** runStats must handle the real EnsembleData /tt/post/info response shape.
 *  Live-verified 2026-10-13: the root is { data: [post] } — an array, not
 *  { data: { post } }. Prior code read res.data?.post, which was always
 *  undefined, so runStats silently no-oped on every video and never updated
 *  last_refreshed_at (root cause of the 61-minute "running" stall). */
test("stats refreshes video view_count from array-shaped postInfo response", async () => {
  const db = seedDb();
  // seedDb already inserted video 'aw1' (title 2183900, view_count=1000)
  const fakeClient = {
    postInfo: async (): Promise<EnsembleDataResponse> => ({
      // Real shape: data is an ARRAY of posts, not { post: {...} }
      data: [{
        aweme_id: "aw1",
        statistics: { play_count: 9999, digg_count: 123, comment_count: 45, share_count: 6, download_count: 7, repost_count: 8 },
      }],
      units_charged: 2,
    }),
  };
  const counters = await runPipeline(db, fakeClient as unknown as EnsembleDataClient, {
    extendedStorageApproved: true, steps: ["stats"],
  }, "test");
  assert.equal(counters.postInfoCalls, 1);
  assert.equal(counters.videosRefreshed, 1);
  const v = db.prepare("SELECT view_count, like_count, comment_count, last_refreshed_at FROM tt_videos WHERE aweme_id='aw1'").get() as any;
  assert.equal(v.view_count, 9999);
  assert.equal(v.like_count, 123);
  assert.equal(v.comment_count, 45);
  const stat = db.prepare("SELECT view_count FROM tt_video_stats_daily WHERE aweme_id='aw1' ORDER BY date DESC LIMIT 1").get() as any;
  assert.equal(stat.view_count, 9999);
});

test("removeVideo excludes but retains raw text", () => {
  const db = seedDb();
  const now = new Date();
  db.prepare(
    `INSERT INTO tt_comments (cid, aweme_id, title_id, text, like_count, create_time, fetched_at)` +
    ` VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("c1", "aw1", 2183900, "original text", 0, 0, now.toISOString());
  const removed = removeVideo(db, "aw1", "test reason", new Date());
  assert.equal(removed, 1);
  const c = db.prepare("SELECT text, excluded_at FROM tt_comments WHERE cid='c1'").get() as any;
  assert.equal(c.text, "original text");
  assert.ok(c.excluded_at);
});

// ── Title sync ──
test("title sync creates rows for six Saber titles and competitor children", () => {
  const db = openTikTokDb(":memory:");
  const products = [
    { id: 1, title: "Space Marine 2", steamAppId: "2183900", releaseDate: "2024-09-09" },
    { id: 2, title: "SnowRunner", steamAppId: "1465360", releaseDate: "2020-04-28" },
  ];
  const spGames = [
    { id: 10, steam_app_id: 2183900, name: "Space Marine 2", release_date: "2024-09-09", is_active: true },
    { id: 11, steam_app_id: 2947860, name: "John Wick", release_date: null, is_active: true },
    { id: 12, steam_app_id: 675010, name: "MudRunner", release_date: "2017-10-31", is_active: true },
  ];
  const sources = buildTitleSources(products, spGames as any, new Map());
  syncTitles(db, sources, new Date(), true);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM tt_titles WHERE enabled=1").get() as any).n;
  assert.ok(n >= 3);
  const sm2 = db.prepare("SELECT hashtags FROM tt_titles WHERE title_id=2183900").get() as any;
  assert.equal(JSON.parse(sm2.hashtags).length, 4);
});

test("collection opt-out disables collection but preserves history", () => {
  const db = openTikTokDb(":memory:");
  // Simulate a YouTube-style opt-out seed
  const seed = TITLE_SEEDS["2183900"];
  assert.ok(seed);
  // Inject a row and verify applyCollectionExclusions honors collectionEnabled=false
  db.prepare(`INSERT INTO tt_titles (title_id, title, steam_app_id, phrases, exclude_terms, enabled,
    backfill_floor, config_source, updated_at) VALUES (?, ?, ?, ?, '[]', 1, '2017-01-01', 'seed', ?)`)
    .run(3230960, "EXODUS", "3230960", JSON.stringify(["exodus"]), new Date().toISOString());
  // Manually mark it disabled to simulate an opt-out
  db.prepare("UPDATE tt_titles SET enabled=0 WHERE title_id=3230960").run();
  const enabled = (db.prepare("SELECT enabled FROM tt_titles WHERE title_id=3230960").get() as any).enabled;
  assert.equal(enabled, 0);
});

// ── Cron scheduling ──
test("scheduled TikTok run is due at 04:30 ET and not before", () => {
  // 2026-10-12 05:30 ET = 2026-10-12 09:30 UTC. 05:30 is after 04:30, so due.
  const due = new Date("2026-10-12T09:30:00Z");
  assert.equal(scheduledTikTokRunDue(due, null), true);
  // 2026-10-12 03:30 ET = 07:30 UTC. Before 04:30, not due.
  const early = new Date("2026-10-12T07:30:00Z");
  assert.equal(scheduledTikTokRunDue(early, null), false);
  // Already ran today, not due again.
  const already = new Date("2026-10-12T09:30:00Z");
  assert.equal(scheduledTikTokRunDue(already, "2026-10-12"), false);
});

// ── 90-day backfill (no live calls) ──
test("backfill early-exits when oldest comment on a page is outside the window", async () => {
  const db = seedDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const daySec = 86400;
  // page 1: 30 comments, all recent. page 2: 30 comments, oldest is 120 days old (outside 90-day window).
  const mk = (i: number, ageDays: number) => ({
    cid: `bf-p1-${i}`, aweme_id: "aw1", create_time: nowSec - ageDays * daySec,
    reply_id: null, user: { unique_id: "u" }, text: `comment ${i} recent`, digg_count: 0,
    is_author_digged: false, reply_comment_total: 0,
  });
  const page1 = Array.from({ length: 30 }, (_, i) => mk(i, 5));
  const page2 = Array.from({ length: 30 }, (_, i) => ({ ...mk(i, 120), cid: `bf-p2-${i}` }));
  const calls: Array<{ aweme: string; cursor: number }> = [];
  const fakeClient = {
    postComments: async (awemeId: string, cursor: number): Promise<EnsembleDataResponse> => {
      calls.push({ aweme: awemeId, cursor });
      const comments = cursor === 0 ? page1 : page2;
      return { data: { comments, nextCursor: cursor === 0 ? 30 : null }, units_charged: 1 };
    },
  };
  const counters = await runPipeline(db, fakeClient as unknown as EnsembleDataClient, {
    extendedStorageApproved: true, steps: ["backfill"], backfillWindowDays: 90, backfillUnitCap: 100,
  }, "test");
  // both videos in the seed (aw1) — actually seedDb has one video aw1
  assert.equal(counters.backfillPages, 2);         // page1 + page2, then early exit
  assert.equal(counters.backfillEarlyExits, 1);    // page2's oldest was outside window
  assert.equal(counters.commentsSaved, 30);        // only the recent 30
  // only the recent ones persisted
  const rows = db.prepare("SELECT COUNT(*) AS n FROM tt_comments WHERE cid LIKE 'bf-p%'").get() as any;
  assert.equal(rows.n, 30);
});

test("backfill saves nothing when all comments are outside the window", async () => {
  const db = seedDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const daySec = 86400;
  const fakeClient = {
    postComments: async (_awemeId: string, _cursor: number): Promise<EnsembleDataResponse> => ({
      data: {
        comments: [{ cid: "old1", aweme_id: "aw1", create_time: nowSec - 200 * daySec,
          reply_id: null, user: { unique_id: "u" }, text: "very old", digg_count: 0,
          is_author_digged: false, reply_comment_total: 0 }],
        nextCursor: null,
      },
      units_charged: 1,
    }),
  };
  const counters = await runPipeline(db, fakeClient as unknown as EnsembleDataClient, {
    extendedStorageApproved: true, steps: ["backfill"], backfillWindowDays: 90,
  }, "test");
  assert.equal(counters.commentsSaved, 0);
  assert.equal(counters.backfillEarlyExits, 1);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM tt_comments WHERE cid='old1'").get() as any;
  assert.equal(rows.n, 0);
});

test("backfill respects the unit cap and stops mid-title", async () => {
  const db = seedDb();
  const nowSec = Math.floor(Date.now() / 1000);
  // Add three more videos so the cap (2 units) stops mid-title.
  for (let i = 2; i <= 4; i++) {
    db.prepare(`INSERT INTO tt_videos (aweme_id, title_id, desc, create_time, view_count, like_count,
      comment_count, repost_count, match_reason, relevance_version, discovered_via, first_seen_at, last_refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`aw${i}`, 2183900, `SM2 video ${i}`, nowSec - 100, 100 * i, 10, 5, 1,
        "space marine 2", RELEVANCE_VERSION, "hashtag", new Date().toISOString(), new Date().toISOString());
  }
  const fakeClient = {
    postComments: async (awemeId: string, _cursor: number): Promise<EnsembleDataResponse> => ({
      data: {
        comments: [{ cid: `cap-${awemeId}`, aweme_id: awemeId, create_time: nowSec,
          reply_id: null, user: { unique_id: "u" }, text: "recent", digg_count: 0,
          is_author_digged: false, reply_comment_total: 0 }],
        nextCursor: null,
      },
      units_charged: 1,
    }),
  };
  const counters = await runPipeline(db, fakeClient as unknown as EnsembleDataClient, {
    extendedStorageApproved: true, steps: ["backfill"], backfillUnitCap: 2,
  }, "test");
  assert.equal(counters.units, 2);
  assert.equal(counters.backfillVideos, 2);   // stopped mid-title after 2 units
  assert.ok(counters.notes.some((n: string) => n.includes("unit budget exhausted")));
});

test("backfill scopes to explicit titleIds only", async () => {
  const db = seedDb();
  // seedDb has one title 2183900 (SM2) and one video aw1. Add a second title with a video.
  db.prepare(`INSERT INTO tt_titles (title_id, title, steam_app_id, is_saber, phrases, exclude_terms,
    title_excludes, required_terms, require_companion, enabled, backfill_floor, config_source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(1465360, "SnowRunner", "1465360", 1, JSON.stringify(["snowrunner"]),
      JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 0, 1, "2017-01-01", "seed", new Date().toISOString());
  db.prepare(`INSERT INTO tt_videos (aweme_id, title_id, desc, create_time, view_count, like_count,
    comment_count, repost_count, match_reason, relevance_version, discovered_via, first_seen_at, last_refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("aw2", 1465360, "SnowRunner gameplay", 1, 100, 10, 5, 1,
      "snowrunner", RELEVANCE_VERSION, "hashtag", new Date().toISOString(), new Date().toISOString());
  const nowSec = Math.floor(Date.now() / 1000);
  const touched: string[] = [];
  const fakeClient = {
    postComments: async (awemeId: string, _cursor: number): Promise<EnsembleDataResponse> => {
      touched.push(awemeId);
      return { data: { comments: [], nextCursor: null }, units_charged: 0 };
    },
  };
  await runPipeline(db, fakeClient as unknown as EnsembleDataClient, {
    extendedStorageApproved: true, steps: ["backfill"],
    backfillTitleIds: [2183900],  // SM2 only, SnowRunner excluded
  }, "test");
  assert.ok(touched.includes("aw1"));
  assert.ok(!touched.includes("aw2"));
});
