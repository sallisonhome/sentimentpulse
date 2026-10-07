#!/usr/bin/env node
import {readFileSync,writeFileSync} from "node:fs";
import assert from "node:assert/strict";
import {resolve} from "node:path";
const [left,right,output]=process.argv.slice(2);
if(!left||!right||!output)throw Error("Usage: baseline-dir candidate-dir comparison.json");
const a=JSON.parse(readFileSync(resolve(left,"report.json"))),b=JSON.parse(readFileSync(resolve(right,"report.json")));
assert.equal(a.date,b.date);assert.equal(a.responses.length,b.responses.length);
const rows=a.responses.map((x,i)=>{
 const y=b.responses[i];assert.equal(x.path,y.path);assert.equal(x.status,200);assert.equal(y.status,200);
 const actualA=JSON.parse(readFileSync(resolve(left,i+".response.json")));
 const actualB=JSON.parse(readFileSync(resolve(right,i+".response.json")));
 assert.deepEqual(actualA,actualB,"Response parity failed: "+x.path);
 assert.equal(x.sha256,y.sha256,"Serialized ordering changed: "+x.path);
 const catalog=q=>q.sql.includes("SELECT DISTINCT psm.title_id AS titleId,");
 return {path:x.path,exact:true,baselineMs:x.ms,candidateMs:y.ms,speedup:x.ms/y.ms,
  baselineSqlCalls:x.queryCalls,candidateSqlCalls:y.queryCalls,
  baselineUdf:x.udfCalls,candidateUdf:y.udfCalls,
  baselineSiblingScans:x.queries.filter(catalog).reduce((n,q)=>n+q.calls,0),
  candidateSiblingScans:y.queries.filter(catalog).reduce((n,q)=>n+q.calls,0)};
});
writeFileSync(output,JSON.stringify({exactResponses:rows.length,left,right,rows},null,2));
console.log(JSON.stringify({exactResponses:rows.length,output}));
