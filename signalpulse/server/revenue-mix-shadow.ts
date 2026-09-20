import type Database from "better-sqlite3";
import { MIX_VERSION, MIX_PLATFORMS, proposeMix, type Evidence, type Mix } from "./revenue-mix-model";

export function ensureMixSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS revenue_mix_shadow_daily (
    family_key TEXT NOT NULL, window TEXT NOT NULL, as_of_date TEXT NOT NULL,
    model_version TEXT NOT NULL, evidence_json TEXT NOT NULL, result_json TEXT NOT NULL,
    PRIMARY KEY(family_key, window, as_of_date, model_version)
  )`);
}
export function mixMode(db: Database.Database): "off" | "shadow" {
  const setting = db.prepare("SELECT value FROM app_settings WHERE key='revenue_mix_mode'").get() as any;
  // No active mode exists in v1. Unsupported values fail closed.
  return setting == null || setting.value === "shadow" ? "shadow" : "off";
}
export function mixStatus(db: Database.Database) {
  const mode = mixMode(db);
  const audit = db.prepare(`SELECT MAX(as_of_date) asOfDate, COUNT(*) rows
    FROM revenue_mix_shadow_daily WHERE model_version=? AND as_of_date=
    (SELECT MAX(as_of_date) FROM revenue_mix_shadow_daily WHERE model_version=?)`).get(MIX_VERSION,MIX_VERSION);
  return { mode, version: MIX_VERSION, applied: false, audit, note: mode === "shadow"
    ? "Learning platform revenue mix over time: SignalPulse is evaluating sustained rating accumulation per title family against platform and cohort norms. Shadow calibration only; published revenue shares still use the baseline model."
    : "Adaptive revenue-share calibration is off. Published revenue shares use the baseline model." };
}

/** Additive audit only. Called at startup and after the existing daily estimator. */
export function runMixShadow(db: Database.Database, familyKey: (name: string) => string,
  protectedTitle: (name: string) => boolean, baseline: Mix, now = new Date()) {
  ensureMixSchema(db);
  if (mixMode(db) === "off") return { mode: "off", rows: 0 };
  const date = now.toISOString().slice(0,10);
  const day = (s: string) => Math.floor(Date.parse(s.slice(0,10)) / 86400000);
  const today = day(date);
  const skus = db.prepare(`SELECT p.title_id id,p.platform,p.msrp_usd_cents price,p.is_gamepass gp,
    p.is_manual_override manual,
    CASE WHEN p.platform='xbox' THEN x.name WHEN i.match_confidence='low' THEN i.store_name ELSE COALESCE(i.name,i.store_name) END name,
    CASE WHEN i.match_confidence='low' THEN i.store_release_date ELSE COALESCE(i.release_date,i.store_release_date) END released,
    EXISTS(SELECT 1 FROM title_multiplier_overrides o WHERE o.title_id=p.title_id AND o.effective_from<=?) overridden,
    EXISTS(SELECT 1 FROM revenue_calibration_anchors a WHERE a.title_id=p.title_id) anchored
    FROM platform_sku_map p LEFT JOIN console_title_igdb i ON i.title_id=p.title_id
    LEFT JOIN xbox_title_cache x ON p.platform='xbox' AND x.big_id=p.external_sku
    WHERE p.sku_role='base' AND p.business_model='paid' AND p.platform IN ('steam','ps5','xbox')`).all(now.toISOString()) as any[];
  const signals = db.prepare(`SELECT title_id id,platform,capture_date date,rating_count count
    FROM store_rating_signal_daily WHERE capture_date>=date(?,'-367 days')
    AND capture_date<=? AND rating_count IS NOT NULL AND (window_label IS NULL OR window_label='ltd')
    ORDER BY capture_date`).all(date, date+"T23:59:59.999Z") as any[];
  const history = new Map<string, any[]>();
  for (const s of signals) { const k = `${s.id}|${s.platform}`; const a = history.get(k) ?? []; a.push(s); history.set(k,a); }
  const families = new Map<string, any[]>();
  for (const sku of skus) {
    const key = familyKey(sku.name ?? ""); if (!key) continue;
    const a = families.get(key) ?? [];
    // Editions carrying the same platform/title signal must not be added together.
    if (!a.some(s => s.id === sku.id && s.platform === sku.platform)) a.push(sku);
    families.set(key,a);
  }
  const insert = db.prepare(`INSERT OR REPLACE INTO revenue_mix_shadow_daily
    (family_key,window,as_of_date,model_version,evidence_json,result_json) VALUES(?,?,?,?,?,?)`);
  let written = 0;
  const transaction = db.transaction(() => {
    for (const [window, days] of [["d7",7],["d30",30],["d90",90],["m12",365],["ltd",28]] as const) {
      const evidence: Evidence[] = [];
      for (const [key, members] of Array.from(families.entries())) {
        const e: Evidence = { key, cohort: "", baseline, blocks: [[0,0,0],[0,0,0]] };
        const ages = members.map(s => today - day(s.released ?? ""));
        const steam = members.find(s => s.platform === "steam");
        const age = steam ? today-day(steam.released ?? "") : NaN;
        e.cohort = `${age<=30?"launch":age<=180?"recent":"catalog"}:${(steam?.price??0)>=4000?"premium":"budget"}`;
        if (members.length !== 3 || !MIX_PLATFORMS.every(p => members.some(s => s.platform===p))) e.blocked = "ambiguous_or_incomplete_platform_family";
        else if (members.some(s => s.gp || s.manual || s.overridden || s.anchored) || protectedTitle(members[0].name)) e.blocked = "protected_or_subscription_family";
        else if (ages.some(a => !Number.isFinite(a) || a < days) || Math.max(...ages)-Math.min(...ages)>7) e.blocked = "young_unknown_or_staggered_release";
        for (const [pi, platform] of Array.from(MIX_PLATFORMS.entries())) {
          const sku = members.find(s => s.platform === platform);
          if (!sku) continue;
          const h = (history.get(`${sku.id}|${platform}`) ?? []).filter(s => day(s.date)>=today-days);
          // Require every daily observation, not synthetic interpolation or bootstrap.
          const unique = new Map(h.map(s => [day(s.date), s.count]));
          const counts = Array.from({length:days+1},(_,i) => unique.get(today-days+i));
          if (counts.some(c => !Number.isFinite(c))) { e.blocked ??= "missing_or_stale_daily_history"; continue; }
          const values = counts as number[];
          const deltas = values.slice(1).map((v,i) => v-values[i]);
          const total = deltas.reduce((a,b) => a+b,0);
          // Batch/backfill/reset guard. Promotions not flagged upstream cannot
          // be reliably identified from ratings alone; active mode stays unavailable.
          if (deltas.some(v=>v<0) || Math.max(...deltas)>Math.max(50,total*0.5)) e.blocked ??= "rating_reset_or_batch_spike";
          const midpoint = Math.floor(days/2);
          e.blocks[0][pi] = values[midpoint]-values[0];
          e.blocks[1][pi] = values[days]-values[midpoint];
        }
        evidence.push(e);
      }
      for (const e of evidence) {
        // Strictly previous day: repeated same-day execution cannot compound caps.
        const previous = db.prepare(`SELECT result_json result FROM revenue_mix_shadow_daily
          WHERE family_key=? AND window=? AND as_of_date=date(?,'-1 day') AND model_version=?`).get(e.key,window,date,MIX_VERSION) as any;
        const result = proposeMix(e,evidence,previous ? JSON.parse(previous.result).candidate : undefined);
        insert.run(e.key,window,date,MIX_VERSION,JSON.stringify({...e,evidenceDays:days,lifetimeEvidenceIsRecent:window==="ltd"}),JSON.stringify(result));
        written++;
      }
    }
  });
  transaction();
  return { mode:"shadow", rows:written };
}
