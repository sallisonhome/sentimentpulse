export const MIX_VERSION = "ratings-shadow-v1";
export const MIX_PLATFORMS = ["steam", "ps5", "xbox"] as const;
export type Mix = [number, number, number];
export type Evidence = {
  key: string; cohort: string; baseline: Mix;
  // Two non-overlapping blocks of newly accumulated ratings, not lifetime totals.
  blocks: [Mix, Mix]; blocked?: string;
};
const normalize = (v: Mix): Mix => v.map(x => x / v.reduce((a, b) => a + b, 0)) as Mix;
const median = (v: number[]) => { const a = [...v].sort((a,b) => a-b); return (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)]) / 2; };
const valid = (e: Evidence) => !e.blocked && e.blocks.every(b => b.every((n,i) => Number.isFinite(n) && n >= (i === 2 ? 10 : 50)));

/** Pure, conservative candidate model. Never writes or changes live estimates. */
export function proposeMix(e: Evidence, peers: Evidence[], previous?: Mix) {
  const fallback = (reason: string) => ({ candidate: e.baseline, confidence: 0, reason, peerCount: 0 });
  if (e.blocked) return fallback(e.blocked);
  if (!valid(e)) return fallback("insufficient_new_ratings");
  // Leave-one-title-out, equal-weight cohort norms. A blockbuster cannot dominate.
  const cohort = peers.filter(p => p.key !== e.key && p.cohort === e.cohort && valid(p));
  if (cohort.length < 10) return fallback("insufficient_cohort_peers");
  const indices = e.blocks.map((block, bi) => {
    const logs = block.map((n,i) => Math.log(n / e.baseline[i]));
    const center = median(logs);
    return logs.map((n,i) => {
      const norms = cohort.map(p => {
        const log = p.blocks[bi].map((x,j) => Math.log(x / p.baseline[j]));
        return log[i] - median(log);
      });
      return n - center - median(norms);
    }) as Mix;
  });
  // Strong direction must repeat in both disjoint blocks, not merely one spike.
  const sustained = indices[0].map((v,i) => Math.sign(v) === Math.sign(indices[1][i]) &&
    Math.min(Math.abs(v), Math.abs(indices[1][i])) >= Math.log(1.5));
  if (!sustained.some(Boolean)) return fallback("no_sustained_outlier");
  if (indices.some(b => b.some(n => Math.abs(n) > Math.log(5)))) return fallback("extreme_outlier_quarantined");
  const confidence = Math.min(0.25, (cohort.length / 40) * 0.25);
  const evidence = normalize(e.baseline.map((b,i) => b * (sustained[i] ? Math.exp((indices[0][i]+indices[1][i])/2) : 1)) as Mix);
  let candidate = e.baseline.map((b,i) => b*(1-confidence) + evidence[i]*confidence) as Mix;
  // Scale the entire vector toward baseline, preserving sum=1 and max 5pp move.
  const deviation = Math.max(...candidate.map((n,i) => Math.abs(n-e.baseline[i])));
  const scale = Math.min(1, 0.05 / (deviation || 1));
  candidate = candidate.map((n,i) => e.baseline[i] + (n-e.baseline[i])*scale) as Mix;
  const prior = previous ?? e.baseline;
  const movement = Math.max(...candidate.map((n,i) => Math.abs(n-prior[i])));
  const step = Math.min(1, 0.01 / (movement || 1));
  candidate = candidate.map((n,i) => prior[i] + (n-prior[i])*step) as Mix;
  return { candidate, confidence, reason: "shadow_candidate_only", peerCount: cohort.length };
}
