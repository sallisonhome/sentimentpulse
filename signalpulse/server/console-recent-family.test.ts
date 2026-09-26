import {test} from "node:test";
import assert from "node:assert/strict";
import {recentFamilyScale, recentFamilyApplies, LONG_FAMILY_VERSION} from "./console-recent-family";
import {editionGroupKey} from "./console-sales-family";
const input={family:"ea sports fc 26",window:"d30",steamRevenue:7502270.094,steamWindow:"d30",
  peers:[{platform:"ps5",revenue:12638850.192,windowUsed:"d30",ratio:6.5,protected:false}]};
test("all-period scale preserves the existing sports mix, never increases revenue",()=>{
  for(const window of ["d7","d30","d90","m12","ltd"]){
    const result=recentFamilyScale({...input,window,steamWindow:window,
      peers:input.peers.map(p=>({...p,windowUsed:window}))})!;
    assert.equal(result.revenue,12638850.192/6.5);
    assert.equal(result.revenue*6.5,12638850.192);
    assert.ok(result.factor>0&&result.factor<1);
  }
  assert.equal(recentFamilyScale({...input,steamRevenue:100})!.revenue,100);
});
test("other editions/years and protected models are untouched",()=>{
  for(const family of ["ea sports fc 27","ea sports fc 26 showcase"])
    assert.equal(recentFamilyScale({...input,family}),null);
  assert.equal(recentFamilyScale({...input,peers:[...input.peers,
    {...input.peers[0],platform:"xbox",protected:true}]}),null);
});
test("long-window rollback retains short-window repair",()=>{
  try {
    process.env.FC26_LONG_FAMILY_ENABLED="0";
    for(const window of ["ltd","m12"])assert.equal(recentFamilyApplies(input.family,window),false);
    assert.ok(recentFamilyScale(input));
    delete process.env.FC26_LONG_FAMILY_ENABLED;
    for(const window of ["m12","ltd"]){
      const r=recentFamilyScale({...input,window,steamWindow:window,
        peers:input.peers.map(p=>({...p,windowUsed:window}))})!;
      assert.equal(r.version,LONG_FAMILY_VERSION);
      assert.ok(!r.caveat.includes("unchanged"));
      assert.equal(recentFamilyScale({...input,window,steamWindow:window}),null,
        "short-window evidence cannot restate a long window");
      assert.equal(recentFamilyScale({...input,window,steamWindow:window,
        peers:[{...input.peers[0],windowUsed:window,method:"backfill-steam-pace+ltd_state:derived_max_windows"}]}),null);
    }
  } finally {delete process.env.FC26_LONG_FAMILY_ENABLED;}
});
test("missing, nonfinite, zero and wider-period peers cannot fabricate a ceiling",()=>{
  for(const revenue of [null,0,-1,NaN,Infinity])
    assert.equal(recentFamilyScale({...input,peers:[{...input.peers[0],revenue}]}),null);
  assert.equal(recentFamilyScale({...input,peers:[{...input.peers[0],windowUsed:"d90"}]}),null);
  assert.equal(recentFamilyScale({...input,steamWindow:"d90"}),null);
  assert.equal(recentFamilyScale({...input,steamRevenue:null}),null);
  assert.equal(recentFamilyScale({...input,peers:[{...input.peers[0],method:"backfill-steam-pace"}]}),null);
});
test("fresh Xbox evidence can constrain the shared scale without summing platforms",()=>{
  const r=recentFamilyScale({...input,peers:[...input.peers,
    {platform:"xbox",revenue:2500000,ratio:2.5,protected:false,windowUsed:"d30"}]})!;
  assert.equal(r.revenue,1000000);
  assert.equal(r.limitingPlatform,"xbox");
});
test("annual franchise numbers are preserved in every platform and edition family",()=>{
  for(const year of [26,27])for(const suffix of [""," Standard Edition PS4 & PS5"," Ultimate Edition XBOX One & XBOX Series X|S"," Xbox Series X|S"])
    assert.equal(editionGroupKey(`EA SPORTS FC™ ${year}${suffix}`),`ea sports fc ${year}`);
});
