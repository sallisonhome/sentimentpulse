import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawn,spawnSync} from "node:child_process";

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"daily-runner-"));
  mkdirSync(join(dir,"bin"));mkdirSync(join(dir,"node_modules/.bin"),{recursive:true});
  const put=(path:string,body:string)=>writeFileSync(join(dir,path),body,{mode:0o755});
  put("bin/systemctl",`#!/bin/bash
case "$*" in
  *WorkingDirectory*) echo "$QA_DIR";;
  *Environment*) echo LTD_ACCUMULATOR_ENABLED=1;;
  *ActiveState*) echo "\${QA_STATE:-failed}";;
  *InvocationID*) if [ -f "$QA_DIR/started" ]; then echo "\${QA_AFTER:-22222222222222222222222222222222}"; else echo 11111111111111111111111111111111; fi;;
  *ExecMainStatus*) echo "\${QA_STATUS:-0}";;
  *Result*) echo "\${QA_RESULT:-success}";;
  start*) touch "$QA_DIR/started"; exit "\${QA_START_EXIT:-0}";;
esac
`);
  put("bin/journalctl",`#!/bin/bash
for n in 1 2 3 4 5; do echo "PHASE $n:"; done
[ "\${QA_DONE:-yes}" = yes ] && echo 'signalpulse-daily done'
exit 0
`);
  put("node_modules/.bin/tsx",`#!/bin/bash
echo "$QA_ID $1" >> "$QA_DIR/calls"
sleep .03
[[ "$1" != "\${QA_FAIL:-none}" ]]
`);
  // Only relocate the filesystem lock for sandbox isolation; real flock and
  // the production phase runner/timeout commands execute unchanged.
  put("daily.sh",readFileSync("deploy/signalpulse-daily.sh","utf8")
    .replace("/run/lock/signalpulse-maintenance.lock",join(dir,"lock")));
  const env={...process.env,PATH:`${dir}/bin:${process.env.PATH}`,QA_DIR:dir};
  return {dir,env,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test("real flock serializes simultaneous refresh runners without cancelling either",async()=>{
  const f=fixture();
  const run=(id:string)=>new Promise<number|null>((resolve,reject)=>{
    const p=spawn("bash",[join(f.dir,"daily.sh")],{env:{...f.env,QA_ID:id},stdio:"ignore"});
    p.on("error",reject);p.on("exit",resolve);
  });
  try {
    assert.deepEqual(await Promise.all([run("a"),run("b")]),[0,0]);
    const ids=readFileSync(join(f.dir,"calls"),"utf8").trim().split("\n").map(s=>s[0]);
    assert.equal(ids.length,10);
    assert.ok(ids.slice(0,5).every(x=>x===ids[0]));
    assert.ok(ids.slice(5).every(x=>x!==ids[0]));
  } finally {f.cleanup();}
});
test("phase failure stops downstream writes and never emits done",()=>{
  const phases=["verify-discovery","collect-console-signals","estimate-console-units","write-revenue-anchors","evaluate-daily-revenue-mix"];
  for(let i=0;i<phases.length;i++){
    const f=fixture();
    try {
      const r=spawnSync("bash",[join(f.dir,"daily.sh")],{
        env:{...f.env,QA_ID:"a",QA_FAIL:`scripts/${phases[i]}.ts`},encoding:"utf8"});
      assert.equal(r.status,(i+1)*10);
      assert.doesNotMatch(r.stdout,/signalpulse-daily done/);
      assert.equal(readFileSync(join(f.dir,"calls"),"utf8").trim().split("\n").length,i+1);
    }finally{f.cleanup();}
  }
});
test("manual verifier rejects stale success, missing completion, signal-result failures and duplicate starts",()=>{
  const cases:Array<[Record<string,string>,number]>=[
    [{},0],
    [{QA_AFTER:"11111111111111111111111111111111"},1],
    [{QA_DONE:"no"},1],
    [{QA_RESULT:"timeout"},1],
    [{QA_STATUS:"10"},1],
    [{QA_START_EXIT:"1"},1],
    [{QA_STATE:"activating"},75],
  ];
  for(const [extra,expected] of cases){
    const f=fixture();
    try {
      const r=spawnSync("bash",[resolve("deploy/run-daily-and-verify.sh")],{env:{...f.env,...extra},encoding:"utf8"});
      assert.equal(r.status,expected,r.stdout+r.stderr);
      if(extra.QA_STATE) assert.ok(!readdirSync(f.dir).includes("started"));
    }finally{f.cleanup();}
  }
});
test("queue, schedule, lock and timeout configuration cannot regress silently",()=>{
  const workflows=resolve("../.github/workflows");
  let queues=0;
  for(const name of readdirSync(workflows)){
    const text=readFileSync(join(workflows,name),"utf8");
    if(text.includes("group: deploy-droplet")){
      queues++;
      assert.match(text,/cancel-in-progress: false\n  queue: max/,name);
    }
  }
  assert.ok(queues>=30);
  const legacy=readFileSync(join(workflows,"signalpulse-seed-console-data.yml"),"utf8");
  assert.doesNotMatch(legacy,/^\s+schedule:/m);
  assert.match(legacy,/run-daily-and-verify\.sh/);
  for(const name of ["deploy","signalpulse-deploy","partnerships-deploy","promocalendar-deploy"]){
    const text=readFileSync(join(workflows,`${name}.yml`),"utf8");
    assert.match(text,/flock -w 3600 9/);
    assert.ok(text.indexOf("flock -w 3600 9")<text.indexOf("git reset --hard"));
  }
  const wrapper=readFileSync("deploy/signalpulse-daily.sh","utf8");
  assert.match(wrapper,/verify-discovery.ts --production/);
  assert.doesNotMatch(wrapper,/scripts\/verify-console-collectors.ts/);
  assert.match(wrapper,/1800.*collect-console-signals/);
  assert.match(readFileSync("deploy/signalpulse-daily.service","utf8"),/TimeoutStartSec=3600/);
});
