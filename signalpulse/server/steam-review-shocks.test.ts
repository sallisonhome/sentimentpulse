import {test} from "node:test";
import assert from "node:assert/strict";
import {reviewShockEvidence} from "./steam-review-shocks";
import {reviewWindow,type ReviewBucket} from "./steam-review-windows";
const start=Date.parse("2026-08-27T00:00:00Z")/1000;
const row=(i:number,up:number,down:number):ReviewBucket=>({bucket_start:start+i*86400,
  bucket_granularity:"day",recommendations_up:up,recommendations_down:down});
const baseline=()=>Array.from({length:27},(_,i)=>row(i,50,10));
test("mature negative-only burst is isolated without editing raw review evidence",()=>{
  const input=[...baseline(),row(27,100,17000),row(28,150,9000)],copy=structuredClone(input);
  const e=reviewShockEvidence(input,"2026-09-24","2016-06-06");
  assert.equal(e.events.length,2);assert.equal(e.events[0].retainedNegative,20);
  assert.equal(e.events[1].retainedNegative,30);assert.equal(e.excludedActivity,25950);
  assert.deepEqual(input,copy);
  assert.equal(reviewWindow(e.adjustedBuckets,"2026-09-24",7).signal,600);
});
test("launches, sparse evidence, positive growth and proportional sale spikes are not suppressed",()=>{
  for(const input of [[...baseline(),row(27,17000,100)], [...baseline(),row(27,5000,1000)],
    [...baseline().slice(0,10),row(27,100,17000)]]){
    assert.equal(reviewShockEvidence(input,"2026-09-24","2016-06-06").events.length,0);
  }
  assert.equal(reviewShockEvidence([...baseline(),row(27,100,17000)],"2026-09-24","2026-08-27").events.length,0);
  assert.equal(reviewShockEvidence([...baseline(),row(27,100,17000)],"2026-09-24",null).events.length,0);
});
test("ordinary bad reception and small negative samples are not labelled an anomalous burst",()=>{
  assert.equal(reviewShockEvidence([...baseline(),row(27,5,90)],"2026-09-24","2016-06-06").events.length,0);
  const negativeBaseline=Array.from({length:27},(_,i)=>row(i,5,50));
  assert.equal(reviewShockEvidence([...negativeBaseline,row(27,5,5000)],"2026-09-24","2016-06-06").events.length,0);
});
test("corresponding monthly rollup is adjusted once; event history is deterministic",()=>{
  const daily=[...baseline(),row(27,100,17000),row(28,150,9000)];
  const sep=daily.filter(r=>r.bucket_start>=Date.parse("2026-09-01")/1000);
  const month:ReviewBucket={bucket_start:Date.parse("2026-09-01")/1000,bucket_granularity:"month",
    recommendations_up:sep.reduce((n,r)=>n+r.recommendations_up,0),
    recommendations_down:sep.reduce((n,r)=>n+r.recommendations_down,0)};
  const e=reviewShockEvidence([...daily,month],"2026-09-24","2016-06-06");
  assert.equal(reviewWindow(e.adjustedBuckets,"2026-09-24",30,"month").signal,27*60+300);
  assert.deepEqual(reviewShockEvidence([...daily,month].reverse(),"2026-09-24","2016-06-06").events,e.events);
  assert.equal(reviewShockEvidence([...daily,month],"2026-09-22","2016-06-06").events.length,0);
});
test("duplicate days cannot amplify the baseline; malformed observations fail closed",()=>{
  const rows=[...baseline(),row(27,100,17000)];
  assert.deepEqual(reviewShockEvidence(rows.concat(rows),"2026-09-24","2016-06-06").events,
    reviewShockEvidence(rows,"2026-09-24","2016-06-06").events);
  assert.equal(reviewShockEvidence([...rows,row(0,-1,3)],"2026-09-24","2016-06-06").events.length,0);
});
test("a stale coarse rollup cannot be silently clamped into reconciled sales evidence",()=>{
  const input=[...baseline(),row(27,100,17000),{...row(5,500,1),bucket_granularity:"month"}];
  const evidence=reviewShockEvidence(input,"2026-09-24","2016-06-06");
  assert.equal(evidence.invalid,true);
  assert.equal(reviewWindow(evidence.adjustedBuckets,"2026-09-24",30).signal,null);
});
