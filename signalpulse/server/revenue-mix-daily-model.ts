import type { Mix } from "./revenue-mix-model";
export const DAILY_MIX_VERSION = "daily-ratings-v1";
export const DAILY_HISTORY_DAYS = 14;
export const DAILY_STEP = .005;
export const DAILY_MAX_DEVIATION = .05;
export type DailyEvidence = {
  key: string; cohort: string; baseline: Mix; today: Mix; history: Mix[]; blocked?: string;
};
export const median = (values: number[]) => {
  const v = [...values].sort((a,b)=>a-b);
  return v.length ? (v[Math.floor((v.length-1)/2)]+v[Math.floor(v.length/2)])/2 : 0;
};
const normalize = (v: Mix) => v.map(x=>x/v.reduce((a,b)=>a+b,0)) as Mix;
const centeredLogs = (v: Mix) => {
  const logs = v.map(n=>Math.log(Math.max(1,n)));
  const center = median(logs);
  return logs.map(n=>n-center) as Mix;
};
function valid(e: DailyEvidence) {
  return !e.blocked && e.baseline.every(n=>Number.isFinite(n)&&n>0)
    && e.history.length === DAILY_HISTORY_DAYS
    && e.history.every(row=>row.every(n=>Number.isFinite(n)&&n>=0))
    && e.today.every((n,i)=>Number.isFinite(n)&&n>=(i===2?5:20))
    && e.today.every((_,i)=>e.history.reduce((s,row)=>s+row[i],0)>=(i===2?25:100));
}
/** A deterministic guarded heuristic, not an assertion of observed sales. */
export function proposeDailyMix(e: DailyEvidence, peers: DailyEvidence[], previous?: Mix) {
  const fallback = (reason: string) => ({ candidate: e.baseline, confidence: 0, reason, peerCount: 0, indices: [0,0,0] as Mix });
  if (e.blocked) return fallback(e.blocked);
  if (!valid(e)) return fallback("insufficient_daily_history_or_volume");
  const cohort = peers.filter(p=>p.key!==e.key&&p.cohort===e.cohort&&valid(p));
  if (cohort.length<10) return fallback("insufficient_cohort_peers");
  // Reject abrupt batch spikes, not moderate sale-like changes. We do not label
  // an event a sale without independent price/promotion evidence.
  if (e.today.some((n,i)=>n>Math.max(i===2?50:200,5*median(e.history.map(h=>h[i]))))) {
    return fallback("extreme_daily_spike");
  }
  const own = centeredLogs(e.today);
  const indices = [0,1,2].map(i=>{
    const norms = cohort.map(p=>median(p.history.map(h=>centeredLogs(h)[i])));
    const norm = median(norms);
    const mad = median(norms.map(n=>Math.abs(n-norm)));
    const deviation = own[i]-norm;
    return Math.abs(deviation)>=Math.max(Math.log(1.5),3*1.4826*mad) ? deviation : 0;
  }) as Mix;
  if (!indices.some(n=>n!==0)) return fallback("within_norms");
  if (indices.some(n=>Math.abs(n)>Math.log(5))) return fallback("extreme_platform_outlier");
  const confidence = Math.min(.2,cohort.length/100);
  const evidence = normalize(e.baseline.map((b,i)=>b*Math.exp(indices[i])) as Mix);
  let candidate = e.baseline.map((b,i)=>b*(1-confidence)+evidence[i]*confidence) as Mix;
  const deviation = Math.max(...candidate.map((n,i)=>Math.abs(n-e.baseline[i])));
  const scale = Math.min(1,DAILY_MAX_DEVIATION/(deviation||1));
  candidate = candidate.map((n,i)=>e.baseline[i]+(n-e.baseline[i])*scale) as Mix;
  // Carry yesterday's candidate only while the same direction remains unusual.
  // Normal days (above) reset exactly to baseline; there is no compounding.
  const prior = previous && previous.every((n,i)=>Number.isFinite(n)&&n>0&&
    Math.abs(n-e.baseline[i])<=DAILY_MAX_DEVIATION+1e-9) &&
    Math.abs(previous.reduce((a,b)=>a+b,0)-1)<1e-9 ? previous : e.baseline;
  const movement = Math.max(...candidate.map((n,i)=>Math.abs(n-prior[i])));
  const step = Math.min(1,DAILY_STEP/(movement||1));
  candidate = candidate.map((n,i)=>prior[i]+(n-prior[i])*step) as Mix;
  return { candidate, confidence, reason: "daily_outlier", peerCount: cohort.length, indices };
}
