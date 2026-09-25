import {type ReviewBucket} from "./steam-review-windows";

export const STEAM_REVIEW_SHOCK_VERSION="steam_review_shock_guard_v1";
const DAY=86400;
const median=(values:number[])=>{
  const v=values.slice().sort((a,b)=>a-b),n=v.length;
  return n ? (n%2 ? v[(n-1)/2] : (v[n/2-1]+v[n/2])/2) : 0;
};
export type ReviewShock={
  date:string; rawPositive:number; rawNegative:number; retainedNegative:number;
  excludedActivity:number; baselineDays:number; baselinePositive:number;
  baselineNegative:number; baselineNegativeShare:number;
};
export type ShockEvidence={events:ReviewShock[]; excludedActivity:number; adjustedBuckets:ReviewBucket[]; invalid?:boolean};

/**
 * A review is not a new purchase. An extreme negative-only burst on an
 * established title is unsafe sales evidence, even when every review is real.
 * Preserve raw history; retain the ordinary negative rate implied by that
 * title's pre-event cohort and observed positive volume. Never edit sentiment.
 * This is a disclosed estimator safeguard, not a finding of fraudulent reviews.
 */
export function reviewShockEvidence(input:ReviewBucket[],asOfDate:string,releaseDate:string|null):ShockEvidence{
  const end=Date.parse(asOfDate+"T00:00:00Z")/1000;
  const release=releaseDate?Date.parse(releaseDate+"T00:00:00Z")/1000:NaN;
  const unchanged=()=>({events:[],excludedActivity:0,adjustedBuckets:input});
  if(!Number.isFinite(end)||!Number.isFinite(release))return unchanged();
  const byDay=new Map<number,ReviewBucket>();
  for(const row of input.filter(r=>r.bucket_granularity==="day"&&r.bucket_start<=end)){
    if(!Number.isSafeInteger(row.recommendations_up)||row.recommendations_up<0||
       !Number.isSafeInteger(row.recommendations_down)||row.recommendations_down<0)return unchanged();
    const prior=byDay.get(row.bucket_start);
    if(prior&&(prior.recommendations_up!==row.recommendations_up||prior.recommendations_down!==row.recommendations_down))return unchanged();
    byDay.set(row.bucket_start,row);
  }
  const days=Array.from(byDay.values()).sort((a,b)=>a.bucket_start-b.bucket_start);
  const events:ReviewShock[]=[],adjusted=new Map<number,number>();
  for(const row of days){
    if(row.bucket_start-release<90*DAY)continue;
    const prior=days.filter(p=>p.bucket_start<row.bucket_start&&p.bucket_start>=row.bucket_start-28*DAY);
    if(prior.length<14)continue;
    const pos=prior.map(p=>p.recommendations_up);
    const neg=prior.map(p=>adjusted.get(p.bucket_start)??p.recommendations_down);
    const pTotal=pos.reduce((a,b)=>a+b,0),nTotal=neg.reduce((a,b)=>a+b,0);
    if(pTotal+nTotal<100||pTotal===0)continue;
    const up=row.recommendations_up,down=row.recommendations_down,total=up+down;
    const ordinaryNeg=median(neg),ordinaryTotal=median(pos.map((p,i)=>p+neg[i]));
    const baselineShare=nTotal/(pTotal+nTotal),negativeShare=total?down/total:0;
    // Multiple independent gates, no title/publisher exceptions:
    // >=100 negatives, >=8x ordinary negative volume, >=4x total activity,
    // >=80% negative and >=35 percentage points worse than prior sentiment.
    if(down<Math.max(100,8*Math.max(1,ordinaryNeg))||
       total<4*Math.max(1,ordinaryTotal)||negativeShare<.8||negativeShare-baselineShare<.35)continue;
    const retained=Math.min(down,Math.ceil(Math.max(ordinaryNeg,up*nTotal/pTotal)));
    const excluded=down-retained;
    if(excluded<=0)continue;
    adjusted.set(row.bucket_start,retained);
    events.push({date:new Date(row.bucket_start*1000).toISOString().slice(0,10),
      rawPositive:up,rawNegative:down,retainedNegative:retained,excludedActivity:excluded,
      baselineDays:prior.length,baselinePositive:pTotal,baselineNegative:nTotal,baselineNegativeShare:baselineShare});
  }
  const eventByTime=new Map(events.map(e=>[Date.parse(e.date+"T00:00:00Z")/1000,e]));
  let invalid=false;
  const adjustedBuckets=input.map(row=>{
    if(row.bucket_granularity==="day"){
      const event=eventByTime.get(row.bucket_start);
      return event?{...row,recommendations_down:event.retainedNegative}:row;
    }
    if(!["week","month"].includes(row.bucket_granularity))return row;
    const date=new Date(row.bucket_start*1000);
    const stop=row.bucket_granularity==="week"?row.bucket_start+7*DAY:
      Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)/1000;
    const excluded=events.filter(e=>{
      const t=Date.parse(e.date+"T00:00:00Z")/1000;return t>=row.bucket_start&&t<stop;
    }).reduce((n,e)=>n+e.excludedActivity,0);
    // A stale coarse rollup may not contain the event yet. Do not silently
    // clamp it to zero and claim that mismatched populations were reconciled.
    if(excluded>row.recommendations_down)invalid=true;
    return excluded?{...row,recommendations_down:row.recommendations_down-excluded}:row;
  });
  return {events,excludedActivity:events.reduce((n,e)=>n+e.excludedActivity,0),adjustedBuckets,invalid};
}
