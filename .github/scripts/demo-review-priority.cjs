/** Disjoint groups share ONE original collector budget. No job row mutation. */
exports.runReviewPriority=async(db,titles,approved,budget,collector)=>{
  const statuses=new Map(db.prepare(`SELECT steam_app_id,status FROM demo_history_backfill_jobs
    WHERE kind='reviews' AND status IN ('pending','running')`).all().map(j=>[j.steam_app_id,j.status]));
  const groups=[
    ["saber_unfinished",titles.filter(t=>t.is_saber_published===1&&statuses.has(t.steam_app_id))],
    ["other_partial",titles.filter(t=>t.is_saber_published!==1&&statuses.get(t.steam_app_id)==="running")],
    ["other_pending",titles.filter(t=>t.is_saber_published!==1&&statuses.get(t.steam_app_id)==="pending")],
  ];
  const result={jobsAttempted:0,requests:0,budgetLimited:false,errors:0,stopReason:null,priorityGroups:[]};
  for(const [name,group] of groups){
    if(!budget.available){result.budgetLimited=!budget.stopped;break;}
    if(!group.length)continue;
    const before=budget.requests;
    const r=await collector(db,group,approved,undefined,budget,"reviews");
    result.jobsAttempted+=r.jobsAttempted;result.errors+=r.errors;
    result.budgetLimited||=r.budgetLimited;
    result.priorityGroups.push({name,titles:group.length,requests:budget.requests-before});
    if(r.stopReason){result.stopReason=r.stopReason;break;}
  }
  result.requests=budget.requests;
  return result;
};
