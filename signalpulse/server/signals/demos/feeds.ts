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
export const DEMO_FEED_LIMIT = 100;
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
  const section = html.match(/data-browser_contenthub_newandtrending_\d+_\d+_(\d+)_(\d+)_/);
  if (!clan || !/^\d+$/.test(event.ANNOUNCEMENT_GID ?? "") || !section) {
    throw new Error("Steam demos hub configuration changed");
  }
  return { clan: String(clan), announcement: event.ANNOUNCEMENT_GID!, section: section[1], tab: section[2] };
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
}

export async function fetchDemoFeed(
  context: ReturnType<typeof parseDemoFeedContext>,
  feed: DemoFeed,
  read = fetchSteamText,
): Promise<DemoFeedPage> {
  const entries: DemoFeedPage["entries"] = [];
  const seen = new Set<string>();
  let totalMatches = 0;
  for (let start = 0; start < DEMO_FEED_LIMIT; start += PAGE_SIZE) {
    const data = JSON.parse(await read(demoFeedUrl(context, feed, start)));
    if (data.success !== 1 || !Array.isArray(data.appids) ||
        !Number.isSafeInteger(data.match_count) || data.match_count < 0 ||
        data.appids.some((id: unknown) => !/^[1-9]\d*$/.test(String(id)))) {
      throw new Error(`Invalid Steam ${feed} feed response`);
    }
    totalMatches = data.match_count;
    if (data.appids.length === 0 && start < totalMatches) {
      throw new Error(`Steam ${feed} feed unexpectedly empty at offset ${start}`);
    }
    let added = 0;
    for (const [offset, id] of data.appids.slice(0, PAGE_SIZE).entries()) {
      const appId = String(id);
      if (!seen.has(appId)) {
        entries.push({ appId, rank: start + offset + 1 });
        seen.add(appId);
        added++;
      }
    }
    if (data.appids.length && !added) throw new Error(`Steam ${feed} pagination repeated a page`);
    if (data.possible_has_more === false || start + data.appids.length >= totalMatches) break;
    if (data.appids.length < PAGE_SIZE) throw new Error(`Steam ${feed} feed returned a short page`);
  }
  return { entries, totalMatches };
}
