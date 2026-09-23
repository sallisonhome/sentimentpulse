import test from "node:test";
import assert from "node:assert/strict";
import { computePassParentActivity, validPair, type ActivityPair } from "./pass-parent-model";

const DAY = 86400_000, now = Date.UTC(2026,8,23), mapping = {
  status: "verified" as const, parent_app_id: "200", parent_name: "Parent",
  evidence_url: "https://evidence.example/parent", verified_at: new Date(now-3600_000).toISOString(),
};
function pair(daysAgo: number, pass: number, parent: number, suffix = ""): ActivityPair {
  const t = new Date(now-daysAgo*DAY + 7*3600_000 + Number(suffix || 0)).toISOString();
  return { parent_app_id:"200",captured_at:t,pass_requested_at:t,pass_received_at:t,
    parent_requested_at:t,parent_received_at:t,pass_ccu:pass,parent_ccu:parent };
}
test("latest ratio and combined share are distinct and evidence is retained", () => {
  const r = computePassParentActivity(mapping,[pair(1,50,100)],"latest",now);
  assert.equal(r.status,"available"); assert.equal(r.ratio,.5); assert.equal(r.sharePercent,100/3);
  assert.equal(r.passCcu,50); assert.equal(r.parentCcu,100); assert.equal(r.evidenceUrl,mapping.evidence_url);
});
test("period ratio uses summed counts, one sample per day, and a qualified prior period", () => {
  const rows = [];
  for (let d=1;d<=14;d++) rows.push(pair(d,d<=7?10:20,d<=7?100:100));
  rows.push(pair(1,9999,10,"1"));
  const r=computePassParentActivity(mapping,rows,"d7",now);
  assert.equal(r.status,"available"); assert.equal(r.sampleDays,7); assert.equal(r.ratio,.1);
  assert.equal(r.changePercentagePoints,-10);
});
test("gates insufficient history, low parent, stale evidence and shared runtimes", () => {
  assert.equal(computePassParentActivity(mapping,[pair(1,10,100)],"d7",now).status,"insufficient_history");
  assert.equal(computePassParentActivity(mapping,[pair(1,5,9)],"latest",now).status,"low_parent");
  assert.equal(computePassParentActivity({...mapping,verified_at:new Date(now-48*3600_000).toISOString()},
    [pair(1,10,100)],"latest",now).status,"stale");
  assert.equal(computePassParentActivity({...mapping,status:"shared_runtime"},[],"latest",now).status,"shared_runtime");
});
test("rejects impossible or unsynchronized pairs", () => {
  const p=pair(1,1,20); assert.equal(validPair(p),true);
  assert.equal(validPair({...p,parent_received_at:new Date(Date.parse(p.parent_received_at)+31_000).toISOString()}),false);
  assert.equal(validPair({...p,pass_ccu:-1}),false);
});
test("zero pass activity is valid, parent zero is not, ratios above one are not clamped", () => {
  assert.equal(computePassParentActivity(mapping,[pair(1,0,100)],"latest",now).ratio,0);
  assert.equal(computePassParentActivity(mapping,[pair(1,10,0)],"latest",now).ratio,null);
  assert.equal(computePassParentActivity(mapping,[pair(1,200,100)],"latest",now).ratio,2);
});
test("wrong parent, future samples, invalid counts, failed collection do not leak ratios", () => {
  assert.equal(computePassParentActivity(mapping,[{...pair(1,5,100),parent_app_id:"other"}],"latest",now).status,"no_samples");
  assert.equal(computePassParentActivity(mapping,[pair(0,5,100)],"latest",now).status,"no_samples");
  assert.equal(computePassParentActivity(mapping,[pair(1,NaN,100)],"latest",now).status,"no_samples");
  assert.equal(computePassParentActivity({...mapping,status:"failed"},[pair(1,10,100)],"latest",now).ratio,null);
  assert.equal(computePassParentActivity(mapping,[pair(3,10,100)],"latest",now).status,"stale");
});
test("daily gates count missing days honestly; manual checks do not enter period aggregates", () => {
  const rows=Array.from({length:6},(_,i)=>pair(i+1,i===0?100:10,i===0?1000:20));
  const r=computePassParentActivity(mapping,rows,"d7",now);
  assert.equal(r.ratio,150/1100); assert.equal(r.changePercentagePoints,null);
  assert.equal(computePassParentActivity(mapping,rows.slice(0,5),"d7",now).status,"insufficient_history");
  const manual=pair(1,10,100); const t=new Date(now-DAY+16*3600_000).toISOString();
  Object.assign(manual,{captured_at:t,pass_requested_at:t,pass_received_at:t,parent_requested_at:t,parent_received_at:t});
  assert.equal(computePassParentActivity(mapping,[manual],"d7",now).sampleDays,0);
});
test("30-day threshold and duplicate insertion order are deterministic", () => {
  const rows=Array.from({length:24},(_,i)=>pair(i+1,10,20));
  assert.equal(computePassParentActivity(mapping,rows,"d30",now).ratio,.5);
  assert.equal(computePassParentActivity(mapping,rows.slice(0,23),"d30",now).status,"insufficient_history");
  assert.deepEqual(computePassParentActivity(mapping,[...rows].reverse(),"d30",now),
    computePassParentActivity(mapping,rows,"d30",now));
});
