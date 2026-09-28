const {test}=require("node:test"),assert=require("node:assert/strict");
const {runReviewPriority}=require("./demo-review-priority.cjs");
const rows=[
  {steam_app_id:"s",status:"running"},
  {steam_app_id:"p",status:"pending"},
  {steam_app_id:"r",status:"running"},
];
const titles=["p","s","r","completed","mismatch","new"].map(id=>({
  steam_app_id:id,is_saber_published:id==="s"?1:0,
}));
const db={prepare(sql){
  assert(sql.includes("kind='reviews'")&&sql.includes("'pending','running'"));
  return {all:()=>rows};
}};
test("Saber then partial then pending, no duplicate or new/terminal jobs, shared budget and reviews only",async()=>{
  const budget={requests:0,available:true,stopped:false},calls=[];
  const result=await runReviewPriority(db,titles,new Set(["s"]),budget,async(d,t,a,c,b,scope)=>{
    assert.equal(d,db);assert.equal(c,undefined);assert.equal(b,budget);assert.equal(scope,"reviews");
    calls.push(t.map(x=>x.steam_app_id));b.requests+=2;
    return {jobsAttempted:t.length,errors:0,budgetLimited:false,stopReason:null};
  });
  assert.deepEqual(calls,[["s"],["r"],["p"]]);
  assert.equal(result.requests,6);assert.equal(result.jobsAttempted,3);
  assert.deepEqual(result.priorityGroups.map(g=>g.requests),[2,2,2]);
});
test("One shared exhausted budget stops lower priorities",async()=>{
  const budget={requests:0,available:true,stopped:false};
  let calls=0;
  const r=await runReviewPriority(db,titles,new Set(),budget,async()=>{calls++;budget.requests=200;budget.available=false;
    return {jobsAttempted:1,errors:0,budgetLimited:true,stopReason:null};});
  assert.equal(calls,1);assert.equal(r.requests,200);assert.equal(r.budgetLimited,true);
});
test("Authentication/rate-limit stop does not continue or retry another group",async()=>{
  const budget={requests:0,available:true,stopped:false};
  let calls=0;
  const r=await runReviewPriority(db,titles,new Set(),budget,async()=>{calls++;budget.requests++;budget.available=false;budget.stopped=true;
    return {jobsAttempted:1,errors:1,budgetLimited:false,stopReason:"source stop"};});
  assert.equal(calls,1);assert.equal(r.stopReason,"source stop");assert.equal(r.errors,1);
});
test("No unfinished reviews makes no collector call",async()=>{
  const r=await runReviewPriority({prepare:()=>({all:()=>[]})},titles,new Set(),{requests:0,available:true},
    async()=>{throw Error("Unexpected call");});
  assert.equal(r.requests,0);assert.equal(r.jobsAttempted,0);
});
