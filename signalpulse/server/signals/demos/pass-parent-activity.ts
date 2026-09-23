import { rawSqlite } from "../../storage";
import { loadDemoCatalog, type CatalogDemo } from "./catalog";
import { fetchCurrentPlayers } from "./ccu";
import { hasExactDemoDownload } from "./metadata";
import { SHARED_RUNTIME_PASS_REFERENCES } from "../../../shared/friends-pass-reference";
import type { ActivityWindow } from "../../../shared/pass-parent-activity";
import { computePassParentActivity, validPair, type ActivityMapping, type ActivityPair } from "./pass-parent-model";

const sharedIds = new Set(SHARED_RUNTIME_PASS_REFERENCES.map(r => r.storeAppId));
// Official pass descriptions identify these named parent titles. Reviewed
// identity exceptions, never fuzzy name matching or runtime assumptions.
const CURATED_PARENTS: Record<string, { id: string; name: string; evidence: string }> = {
  "1377150": { id: "1335790", name: "Operation: Tango", evidence: "https://clever-plays.com/operation-tango/faq/" },
  "2477230": { id: "1096140", name: "Timemelters", evidence: "https://store.steampowered.com/app/2477230/Timemelters__Friend_Pass/" },
};
async function readJson(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Steam identity HTTP ${r.status}`);
  return r.json() as Promise<any>;
}
async function details(appId: string) {
  const body = await readJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=US&l=english`);
  if (body[appId]?.success !== true || String(body[appId]?.data?.steam_appid) !== appId)
    throw new Error("Steam identity unavailable");
  return body[appId].data;
}
export async function verifyPassParent(appId: string): Promise<ActivityMapping> {
  const empty: ActivityMapping = { status: "unverified", parent_app_id: null, parent_name: null,
    evidence_url: null, verified_at: null };
  if (sharedIds.has(appId)) return { ...empty, status: "shared_runtime" };
  const own = await details(appId);
  const parentId = own.type === "demo" ? String(own.fullgame?.appid ?? "") : CURATED_PARENTS[appId]?.id;
  if (!parentId || !/^[1-9]\d*$/.test(parentId) || parentId === appId) return empty;
  const parent = await details(parentId);
  if (parent.type !== "game" || (CURATED_PARENTS[appId] && parent.name !== CURATED_PARENTS[appId].name)) return empty;
  // A free package is insufficient: require an explicit launch of this own App ID.
  // Try the pass then parent page; age-gate/transport failures abstain.
  for (const pageId of [appId, parentId]) {
    const url = `https://store.steampowered.com/app/${pageId}/?cc=US&l=english`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000),
      headers: { Cookie: "birthtime=631152001; lastagecheckage=1-January-1990; mature_content=1" } });
    if (!r.ok) throw new Error(`Steam runtime HTTP ${r.status}`);
    if (!new URL(r.url).pathname.startsWith(`/app/${pageId}/`)) continue;
    if (hasExactDemoDownload(await r.text(), appId, true)) return {
      status: "verified", parent_app_id: parentId, parent_name: parent.name,
      evidence_url: CURATED_PARENTS[appId]?.evidence ?? `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=US&l=english`,
      verified_at: new Date().toISOString(),
    };
  }
  return empty;
}
/** Both requests begin together; record their real request/receipt timestamps.
 * Upstream caching means these are paired API observations, not exact instants.
 */
export async function collectPair(passId: string, parentId: string,
  read = fetchCurrentPlayers, clock = () => new Date().toISOString()): Promise<ActivityPair> {
  const timed = async (id: string) => {
    const requested = clock(), ccu = await read(id), received = clock();
    if (!Number.isSafeInteger(ccu) || ccu! < 0) throw new Error("CCU unavailable or invalid");
    return { requested, received, ccu: ccu! };
  };
  const [pass, parent] = await Promise.all([timed(passId), timed(parentId)]);
  const pair: ActivityPair = { parent_app_id: parentId, captured_at: pass.received > parent.received ? pass.received : parent.received,
    pass_requested_at: pass.requested, pass_received_at: pass.received,
    parent_requested_at: parent.requested, parent_received_at: parent.received,
    pass_ccu: pass.ccu, parent_ccu: parent.ccu };
  if (!validPair(pair)) throw new Error("Paired CCU timing outside synchronization limits");
  return pair;
}
export async function runPassParentActivityCollector(delayMs = 250, eligibleAppIds?: ReadonlySet<string>,
  verify = verifyPassParent, collect = collectPair) {
  const titles = loadDemoCatalog("friends_pass").filter(d => !eligibleAppIds || eligibleAppIds.has(d.steam_app_id));
  const result = { attempted: titles.length, succeeded: 0, unavailable: 0, failed: 0,
    failureSample: [] as Array<{appId: string; reason: string}> };
  for (const title of titles) {
    const attempted = new Date().toISOString();
    try {
      const mapping = sharedIds.has(title.steam_app_id)
        ? { status: "shared_runtime", parent_app_id: null, parent_name: null, evidence_url: null, verified_at: null } as ActivityMapping
        : await verify(title.steam_app_id);
      // Collect before committing mapping+pair so API readers never see a new
      // verified mapping paired with a failed or incomplete current collection.
      const pair = mapping.status === "verified" && mapping.parent_app_id
        ? await collect(title.steam_app_id, mapping.parent_app_id) : null;
      if (pair && (!validPair(pair) || pair.parent_app_id !== mapping.parent_app_id)) throw new Error("Invalid pair identity/timing");
      rawSqlite.transaction(() => {
        rawSqlite.prepare(`INSERT INTO pass_parent_mappings
          (demo_title_id,status,parent_app_id,parent_name,evidence_url,verified_at,last_attempt_at,last_error)
          VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(demo_title_id) DO UPDATE SET
          status=excluded.status,parent_app_id=excluded.parent_app_id,parent_name=excluded.parent_name,
          evidence_url=excluded.evidence_url,verified_at=excluded.verified_at,last_attempt_at=excluded.last_attempt_at,last_error=NULL`)
          .run(title.id,mapping.status,mapping.parent_app_id,mapping.parent_name,mapping.evidence_url,mapping.verified_at,attempted);
        if (pair) rawSqlite.prepare(`INSERT INTO pass_parent_ccu_pairs
          (demo_title_id,parent_app_id,captured_at,pass_requested_at,pass_received_at,parent_requested_at,parent_received_at,pass_ccu,parent_ccu)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(title.id,pair.parent_app_id,pair.captured_at,pair.pass_requested_at,pair.pass_received_at,
            pair.parent_requested_at,pair.parent_received_at,pair.pass_ccu,pair.parent_ccu);
      })();
      if (pair) result.succeeded++; else result.unavailable++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      rawSqlite.prepare(`INSERT INTO pass_parent_mappings(demo_title_id,status,last_attempt_at,last_error)
        VALUES (?,'failed',?,?) ON CONFLICT(demo_title_id) DO UPDATE SET
        status='failed',last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error`).run(title.id,attempted,reason);
      result.failed++;
      if (result.failureSample.length < 10) result.failureSample.push({ appId: title.steam_app_id, reason });
    }
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve,delayMs));
  }
  return result;
}
export function loadPassParentActivity(titles: CatalogDemo[], window: ActivityWindow) {
  const now = Date.now(), since = new Date(now - 62 * 86400_000).toISOString();
  return new Map(titles.map(title => {
    let mapping = rawSqlite.prepare("SELECT * FROM pass_parent_mappings WHERE demo_title_id=?").get(title.id) as ActivityMapping | undefined;
    if (sharedIds.has(title.steam_app_id)) mapping = { status: "shared_runtime",
      parent_app_id: null, parent_name: null, evidence_url: null, verified_at: null };
    const pairs = rawSqlite.prepare(`SELECT * FROM pass_parent_ccu_pairs
      WHERE demo_title_id=? AND captured_at>=? ORDER BY captured_at DESC LIMIT 5000`).all(title.id,since) as ActivityPair[];
    return [title.id, computePassParentActivity(mapping,pairs,window,now)];
  }));
}
