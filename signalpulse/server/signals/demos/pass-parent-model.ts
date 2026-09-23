import { ACTIVITY_GATES as G, type ActivityWindow, type PassParentActivity } from "../../../shared/pass-parent-activity";

export interface ActivityMapping {
  status: "verified" | "unverified" | "shared_runtime" | "failed";
  parent_app_id: string | null; parent_name: string | null;
  evidence_url: string | null; verified_at: string | null;
}
export interface ActivityPair {
  parent_app_id: string; captured_at: string;
  pass_requested_at: string; pass_received_at: string;
  parent_requested_at: string; parent_received_at: string;
  pass_ccu: number; parent_ccu: number;
}
const DAY = 86_400_000;
export function validPair(p: ActivityPair): boolean {
  const times = [p.pass_requested_at, p.pass_received_at, p.parent_requested_at, p.parent_received_at].map(Date.parse);
  const [ps, pe, bs, be] = times;
  return times.every(Number.isFinite) && Number.isSafeInteger(p.pass_ccu) && p.pass_ccu >= 0 &&
    Number.isSafeInteger(p.parent_ccu) && p.parent_ccu >= 0 &&
    pe >= ps && be >= bs && Math.max(pe, be) - Math.min(ps, bs) <= G.maxRequestMs &&
    Math.abs(ps - bs) <= G.maxSkewMs && Math.abs(pe - be) <= G.maxSkewMs &&
    Date.parse(p.captured_at) === Math.max(pe, be);
}
/** Sampled daily observations, NEVER an integral, player-hours, downloads or conversion.
 * Periods use one pair/day in the existing 03:00 Eastern collection slot.
 * Off-schedule manual checks update latest only, without biasing period weights.
 */
export function computePassParentActivity(mapping: ActivityMapping | undefined, pairs: ActivityPair[],
  window: ActivityWindow, now = Date.now()): PassParentActivity {
  const days = window === "d7" ? 7 : window === "d30" ? 30 : 0;
  const end = Math.floor(now / DAY) * DAY, start = end - days * DAY;
  const out: PassParentActivity = { status: "unverified", window, ratio: null, sharePercent: null,
    changePercentagePoints: null, parentAppId: mapping?.parent_app_id ?? null,
    parentName: mapping?.parent_name ?? null, evidenceUrl: mapping?.evidence_url ?? null,
    verifiedAt: mapping?.verified_at ?? null, sampledAt: null, passCcu: null, parentCcu: null,
    skewMs: null, sampleDays: 0, requiredDays: Math.ceil(days * G.minDayCoverage),
    periodStart: days ? new Date(start).toISOString() : null,
    periodEnd: days ? new Date(end).toISOString() : null };
  if (!mapping || mapping.status !== "verified") {
    out.status = mapping?.status === "failed" ? "failed" : mapping?.status === "shared_runtime" ? "shared_runtime" : "unverified";
    return out;
  }
  if (!mapping.parent_app_id || !mapping.verified_at || !Number.isFinite(Date.parse(mapping.verified_at))) return out;
  if (now - Date.parse(mapping.verified_at) > G.maxAgeHours * 3600_000 || Date.parse(mapping.verified_at) > now) {
    out.status = "stale"; return out;
  }
  const valid = pairs.filter(p => p.parent_app_id === mapping.parent_app_id && validPair(p) &&
    Date.parse(p.captured_at) <= now).sort((a,b) => a.captured_at.localeCompare(b.captured_at));
  const latest = valid.at(-1);
  if (!latest) { out.status = "no_samples"; return out; }
  out.sampledAt = latest.captured_at;
  out.skewMs = Math.max(Math.abs(Date.parse(latest.pass_requested_at)-Date.parse(latest.parent_requested_at)),
    Math.abs(Date.parse(latest.pass_received_at)-Date.parse(latest.parent_received_at)));
  if (now - Date.parse(latest.captured_at) > G.maxAgeHours * 3600_000) { out.status = "stale"; return out; }
  if (!days) {
    out.passCcu = latest.pass_ccu; out.parentCcu = latest.parent_ccu; out.sampleDays = 1;
  } else {
    const byDay = new Map<string, ActivityPair>();
    for (const pair of valid) {
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" })
        .format(new Date(pair.captured_at)));
      // Daily scheduler starts at 03:00; allow its sequential pipeline to finish by 05:00.
      if (hour < 3 || hour >= 5) continue;
      const date = pair.captured_at.slice(0,10);
      if (!byDay.has(date)) byDay.set(date, pair); // duplicates never overweight a day
    }
    const summarize = (from: number, to: number) => {
      const selected = Array.from(byDay.values()).filter(p => Date.parse(p.captured_at) >= from && Date.parse(p.captured_at) < to);
      return { count: selected.length, pass: selected.reduce((s,p) => s+p.pass_ccu,0),
        parent: selected.reduce((s,p) => s+p.parent_ccu,0) };
    };
    const current = summarize(start,end);
    out.sampleDays = current.count;
    if (current.count < out.requiredDays) { out.status = "insufficient_history"; return out; }
    out.passCcu = current.pass / current.count; out.parentCcu = current.parent / current.count;
    const prior = summarize(start-days*DAY,start);
    if (prior.count >= out.requiredDays && prior.parent/prior.count >= G.minParentCcu &&
        current.parent/current.count >= G.minParentCcu)
      out.changePercentagePoints = 100 * (current.pass/current.parent - prior.pass/prior.parent);
  }
  if (out.parentCcu! < G.minParentCcu) { out.status = "low_parent"; return out; }
  out.status = "available"; out.ratio = out.passCcu! / out.parentCcu!;
  out.sharePercent = 100 * out.passCcu! / (out.passCcu! + out.parentCcu!);
  return out;
}
