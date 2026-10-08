/**
 * Steam's three demo browser tabs, verified against their live network
 * requests on 2026-09-22. Internal storefront contract, not a public API.
 * Parse changing event/section IDs from the hub; never bake them in.
 * Pure module: safe to probe without opening SQLite or starting schedulers.
 */
export const DEMO_FEEDS = {
  top: "dailyactiveuserdemo",
  new: "recentlyreleased",
  trending: "contenthub_newandtrending",
} as const;
export type DemoFeed = keyof typeof DEMO_FEEDS;
export const DEMO_FEED_LIMIT = 500;
export const DEMO_NEW_FEED_MAX = 2000;
const PAGE_SIZE = 50;
export const DEMOS_HUB_URL = "https://store.steampowered.com/demos/";

export async function fetchSteamText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SignalPulseBot/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Steam HTTP ${response.status}`);
  return response.text();
}

function attribute(html: string, name: string): unknown {
  const text = html.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  if (!text) throw new Error(`Steam demos hub missing ${name}`);
  return JSON.parse(text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&"));
}

export function parseDemoFeedContext(html: string) {
  const event = attribute(html, "data-event") as { ANNOUNCEMENT_GID?: string };
  const groups = attribute(html, "data-groupvanityinfo") as Array<{ clanAccountID?: number; vanity_url?: string }>;
  const clan = groups.find(group => group.vanity_url === "store_contenthubs")?.clanAccountID;
  const marker = findBrowserMarker(html);
  if (!clan || !/^\d+$/.test(event.ANNOUNCEMENT_GID ?? "") || !marker) {
    throw new Error("Steam demos hub configuration changed");
  }
  return { clan: String(clan), announcement: event.ANNOUNCEMENT_GID!, section: marker.section, tab: marker.tab };
}

/**
 * The hub renders one `data-browser_<flavor>_<start>_<count>_<section>_<tab...>=`
 * attribute per item-browser tab. Steam moved the default tab from
 * new-and-trending (`..._888_7_`) to all (`..._8_*_*_*_0`) on 2026-10-08, which
 * broke an exact-name match. The feed endpoint ignores both ids (verified live),
 * so any browser marker is enough; prefer new-and-trending when it exists so the
 * old layout resolves exactly as before. Event and group ids stay mandatory.
 */
function findBrowserMarker(html: string): { section: string; tab: string } | null {
  const markers = Array.from(html.matchAll(/data-browser_([a-z]+(?:_[a-z]+)*)_\d+_\d+_(\d+)_([^\s="]*)=/g));
  const marker = markers.find(m => m[1] === "contenthub_newandtrending") ?? markers[0];
  if (!marker) return null;
  const tab = marker[3].split("_").filter(token => /^\d+$/.test(token)).pop() ?? "0";
  return { section: marker[2], tab };
}

export function demoFeedUrl(context: ReturnType<typeof parseDemoFeedContext>, feed: DemoFeed, start: number) {
  const params = new URLSearchParams({
    cc: "US", l: "english", clanAccountID: context.clan,
    clanAnnouncementGID: context.announcement, flavor: DEMO_FEEDS[feed],
    strFacetFilter: "", start: String(start), count: String(PAGE_SIZE),
    tabuniqueid: context.tab, sectionuniqueid: context.section,
    return_capsules: "true", origin: "https://store.steampowered.com",
    strContentHubType: "demos", bContentHubDiscountedOnly: "false",
    strTabFilter: "", bRequestFacetCounts: "true", bUseCreatorHomeApps: "false", bAllowDemos: "false",
  });
  return `https://store.steampowered.com/saleaction/ajaxgetsaledynamicappquery?${params}`;
}

export interface DemoFeedPage {
  entries: Array<{ appId: string; rank: number }>;
  totalMatches: number;
  scannedSlots: number;
  stopReason: "end" | "bounded" | "bootstrap" | "watermark" | "safety_cap";
}

export async function fetchDemoFeed(
  context: ReturnType<typeof parseDemoFeedContext>,
  feed: DemoFeed,
  read = fetchSteamText,
  previousHead: ReadonlySet<string> = new Set(),
): Promise<DemoFeedPage> {
  const entries: DemoFeedPage["entries"] = [];
  const seen = new Set<string>();
  let totalMatches = 0;
  let scannedSlots = 0;
  let stopReason: DemoFeedPage["stopReason"] = feed === "new" ? "bootstrap" : "bounded";
  const catchUp = feed === "new" && previousHead.size > 0;
  const maxSlots = catchUp ? DEMO_NEW_FEED_MAX : DEMO_FEED_LIMIT;
  const matchedHead = new Set<string>();
  let overlapAt: number | null = null;
  for (let start = 0; start < maxSlots; start += PAGE_SIZE) {
    const data = JSON.parse(await read(demoFeedUrl(context, feed, start)));
    if (data.success !== 1 || !Array.isArray(data.appids) ||
        !Number.isSafeInteger(data.match_count) || data.match_count < 0 ||
        data.appids.some((id: unknown) => !/^[1-9]\d*$/.test(String(id)))) {
      throw new Error(`Invalid Steam ${feed} feed response`);
    }
    totalMatches = data.match_count;
    scannedSlots = start + data.appids.length;
    if (data.appids.length === 0 && start < totalMatches) {
      throw new Error(`Steam ${feed} feed unexpectedly empty at offset ${start}`);
    }
    let added = 0;
    for (const [offset, id] of data.appids.slice(0, PAGE_SIZE).entries()) {
      const appId = String(id);
      if (previousHead.has(appId)) matchedHead.add(appId);
      if (!seen.has(appId)) {
        entries.push({ appId, rank: start + offset + 1 });
        seen.add(appId);
        added++;
      }
    }
    if (data.appids.length && !added) throw new Error(`Steam ${feed} pagination repeated a page`);
    if (data.possible_has_more === false || start + data.appids.length >= totalMatches) {
      stopReason = "end"; break;
    }
    if (data.appids.length < PAGE_SIZE) throw new Error(`Steam ${feed} feed returned a short page`);
    // Match at least 25 of the previous head IDs, then read one full extra
    // page. Persistent future-date entries alone cannot satisfy this watermark.
    if (overlapAt === null && matchedHead.size >= Math.min(25, previousHead.size)) overlapAt = scannedSlots;
    if (catchUp && scannedSlots >= DEMO_FEED_LIMIT && overlapAt !== null && scannedSlots >= overlapAt + PAGE_SIZE) {
      stopReason = "watermark"; break;
    }
    if (catchUp && scannedSlots >= maxSlots) stopReason = "safety_cap";
  }
  return { entries, totalMatches, scannedSlots, stopReason };
}
