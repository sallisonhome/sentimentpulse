import { rawSqlite } from "../../storage";
import { fetchSteamText } from "./feeds";
import { createDemoVerifier } from "./metadata";
import { isFriendsPassName, isFriendsPassSku, NAMED_PASS_ALIASES } from "./friends-pass-identity";
import { upsertDiscoveredDemo } from "./discovery";
import { runDemosReviewHistoryCollector } from "./runner";
import { runDemosCcuCollector } from "./ccu";
import { computeDemoWindowEstimates } from "./estimator";

export const PASS_SEARCH_TERMS = ["friend's pass", "friends pass", "friend pass", "friendspass"];
export const PASS_SEARCH_CAP = 5000;
const PAGE_SIZE = 100;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function readSearch(url: string) {
  try { return await fetchSteamText(url); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes("429")) throw error;
    await sleep(30_000);
    return fetchSteamText(url);
  }
}

/** Exhaust each public US/English search, not just the first 100 results.
 * Results include unrelated paid games/DLC; only named pass clients become
 * candidates. A safety cap or changed contract is a visible incomplete run.
 */
export async function discoverFriendsPassIds(read = fetchSteamText, delayMs = 250) {
  const ids = new Set<string>();
  const queries: Array<{ term: string; scanned: number; total: number }> = [];
  try {
  for (const term of PASS_SEARCH_TERMS) {
    const seenPages = new Set<string>();
    let scanned = 0, total = 0, complete = false;
    for (let start = 0; start < PASS_SEARCH_CAP; start += PAGE_SIZE) {
      const url = new URL("https://store.steampowered.com/search/results/");
      url.search = new URLSearchParams({ term, start: String(start), count: String(PAGE_SIZE),
        infinite: "1", cc: "US", l: "english", ignore_preferences: "1", ndl: "1" }).toString();
      const body = JSON.parse(await read(url.href));
      total = Number(body.total_count);
      if (![1,true].includes(body.success) || !Number.isSafeInteger(total) || total < 0 ||
          typeof body.results_html !== "string") throw new Error(`Invalid Friends Pass search response: ${term}`);
      const anchors = Array.from(body.results_html.matchAll(/<a\b([^>]*\bclass=["'][^"']*\bsearch_result_row\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)) as RegExpMatchArray[];
      const fingerprint = anchors.map(a => a[1]).join("|");
      if (anchors.length && seenPages.has(fingerprint)) throw new Error(`Friends Pass search repeated a page: ${term}`);
      seenPages.add(fingerprint);
      for (const row of anchors) {
        const id = row[1].match(/\bdata-ds-appid=["']([1-9]\d*)["']/i)?.[1];
        const title = row[2].match(/<span\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "";
        if (id && isFriendsPassName(title.replace(/<[^>]*>/g, ""))) ids.add(id);
      }
      scanned = start + anchors.length;
      if (scanned >= total) { complete = true; break; }
      if (anchors.length < PAGE_SIZE) throw new Error(`Friends Pass search short page at ${start}: ${term}`);
      if (delayMs > 0) await sleep(delayMs);
    }
    if (!complete) throw new Error(`Friends Pass search incomplete at ${PASS_SEARCH_CAP} slots: ${term}`);
    queries.push({ term, scanned, total });
  }
  return { ids: Array.from(ids), queries, error: null as string | null };
  } catch (error) {
    return { ids: Array.from(ids), queries, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runFriendsPassDiscovery(delayMs = 250) {
  const attemptedAt = new Date().toISOString();
  const result = { candidates: 0, eligible: 0, added: 0, excluded: 0, failed: 0,
    error: null as string | null, failureSample: [] as Array<{appId:string;reason:string}>, scanned: 0 };
  const known = rawSqlite.prepare("SELECT steam_app_id,name,sku_kind FROM demo_titles").all() as Array<{steam_app_id:string;name:string;sku_kind:string}>;
  // Reclassify legacy pass rows before either demo or pass metrics are read.
  // Keep IDs and history intact; no destructive migration or parent joins.
  for (const row of known) if (isFriendsPassSku(row.steam_app_id,row.name)) rawSqlite.prepare(
    "UPDATE demo_titles SET sku_kind='friends_pass' WHERE steam_app_id=?").run(row.steam_app_id);
  const candidates = new Set([...Object.keys(NAMED_PASS_ALIASES),
    ...known.filter(r => r.sku_kind === "friends_pass" || isFriendsPassSku(r.steam_app_id,r.name)).map(r => r.steam_app_id)]);
  try {
    const found = await discoverFriendsPassIds(readSearch, delayMs > 0 ? Math.max(1500,delayMs) : 0);
    found.ids.forEach(id => candidates.add(id));
    result.error = found.error;
    result.scanned = found.queries.reduce((sum, q) => sum + q.scanned, 0);
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  result.candidates = candidates.size;
  const checks = await createDemoVerifier(delayMs, "friends_pass").verify(Array.from(candidates));
  const eligible = new Set<string>();
  for (const id of Array.from(candidates)) {
    const check = checks.get(id)!;
    if (check.error) {
      result.failed++;
      if (result.failureSample.length < 10) result.failureSample.push({appId:id,reason:check.error});
    } else if (check.demo) {
      if (!known.some(row => row.steam_app_id === id)) result.added++;
      upsertDiscoveredDemo({ steamAppId: id, ...check.demo, skuKind: "friends_pass", discoveredVia: "steam_friends_pass_search" });
      eligible.add(id);
    } else {
      result.excluded++;
      rawSqlite.prepare(`UPDATE demo_titles SET is_active=0,deactivated_at=?,availability_checked_at=?
        WHERE steam_app_id=? AND sku_kind='friends_pass'`).run(attemptedAt, attemptedAt, id);
    }
  }
  result.eligible = eligible.size;
  if (result.failed) result.error = [result.error, `${result.failed} pass availability checks failed; previous status retained`].filter(Boolean).join("; ");
  rawSqlite.prepare(`INSERT INTO demo_discovery_feeds
    (feed,last_attempt_at,last_success_at,error,candidate_count,eligible_count,total_matches,scanned_slots,stop_reason)
    VALUES ('friends_pass',?,?,?,?,?,?,?,?)
    ON CONFLICT(feed) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
      last_success_at=CASE WHEN excluded.error IS NULL THEN excluded.last_success_at ELSE demo_discovery_feeds.last_success_at END,
      error=excluded.error,candidate_count=excluded.candidate_count,eligible_count=excluded.eligible_count,
      total_matches=excluded.total_matches,scanned_slots=excluded.scanned_slots,stop_reason=excluded.stop_reason`)
    .run(attemptedAt, result.error ? null : new Date().toISOString(), result.error, result.candidates,
      result.eligible, result.scanned, result.scanned, result.error ? "incomplete" : "end");
  return { result, eligible };
}

let running = false;
/** Same function for daily refresh and one-time pass-only history backfill.
 * Never calls Saber actuals, paid ingestion or license-count collectors.
 */
export async function runFriendsPassPipeline(delayMs = 250) {
  if (running) throw new Error("Friends Pass refresh already running");
  running = true;
  try {
    const { result: discovery, eligible } = await runFriendsPassDiscovery(delayMs);
    const reviewHistory = await runDemosReviewHistoryCollector(delayMs, eligible);
    const ccu = await runDemosCcuCollector(delayMs, eligible);
    const estimates = computeDemoWindowEstimates(undefined, eligible);
    return { ok: !discovery.error && !reviewHistory.failed && !ccu.failed, discovery, reviewHistory, ccu, estimates };
  } finally { running = false; }
}
