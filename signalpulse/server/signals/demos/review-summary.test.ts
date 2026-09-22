import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("demo Steam scores use own lifetime buckets, never parents or overlapping grains; API rating sort is numeric", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demo-reviews-"));
  process.chdir(dir);
  let db: any, server: any;
  try {
    db = (await import("../../storage")).rawSqlite;
    const stamp = new Date().toISOString();
    const today = stamp.slice(0, 10);
    const day = Date.parse(`${today}T00:00:00Z`) / 1000;
    for (const id of [1,2,3,4,5,6]) {
      db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,genre,release_date,discovered_via,is_active,first_seen_at,created_at,updated_at)
        VALUES(?,?,?,'Casual',?,'test',1,?,?,?)`).run(id,String(id),`Demo ${id}`, id===5 ? "2020-01-01":today,stamp,stamp,stamp);
    }
    const bucket = (id: string, grain: string, up: number, down: number, seen=stamp) =>
      db.prepare(`INSERT INTO steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,source_endpoint,created_at)
        VALUES(?,?,?,?,?,'steam:appreviewhistogram',?)`).run(id,day,grain,up,down,seen);
    bucket("1","week",201,5);
    bucket("1","day",201,5); // overlapping representation, not extra reviews
    bucket("2","week",0,10); // genuine 0% is not missing
    bucket("3","week",0,0); // no reviews
    bucket("4","day",9,1); // full release-to-date daily coverage
    bucket("5","day",100,0); // recent-only daily coverage is not lifetime
    bucket("6","week",999,1,"2020-01-01"); // stale old representation
    bucket("6","month",8,2);
    bucket("500","week",100000,0); // parent/non-demo app, never inherited
    const { loadDemoReviewSummaries } = await import("./review-summary");
    const summaries = loadDemoReviewSummaries();
    assert.deepEqual(summaries.get("1"), {positive:201,negative:5,total:206,positivePercent:201/206*100});
    assert.equal(summaries.get("2")?.positivePercent,0);
    assert.equal(summaries.get("3")?.positivePercent,null);
    assert.equal(summaries.get("4")?.positivePercent,90);
    assert.equal(summaries.has("5"),false);
    assert.equal(summaries.get("6")?.total,10);
    assert.equal(summaries.has("500"),false);
    const { default: express } = await import("express");
    const { registerDemosLeaderboardRoutes } = await import("../../routes-demos-leaderboard");
    const app = express(); registerDemosLeaderboardRoutes(app);
    server = app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/demos/leaderboard`;
    for(const window of ["d7","d30","d90","m12","ltd"]){
      const data = await (await fetch(`${url}?window=${window}&sort=rating&direction=desc&genre=Casual`)).json();
      assert.deepEqual(data.demos.map((d:any)=>d.id),[1,4,6,2,3,5]);
      assert.equal(data.demos[0].reviewCountTotal,206);
      assert.equal(data.demos[0].steamReviews.positive,201);
      const limited = await (await fetch(`${url}?window=${window}&sort=rating&direction=asc&limit=1`)).json();
      assert.equal(limited.demos[0].id,2);
      assert.equal(limited.demos[0].steamReviews.positivePercent,0);
    }
  } finally {
    if(server) await new Promise<void>(resolve=>server.close(resolve));
    db?.close(); process.chdir(cwd); rmSync(dir,{recursive:true,force:true});
  }
});
