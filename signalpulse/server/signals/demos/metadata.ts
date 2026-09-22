/**
 * Batched Store Browse metadata. Live-verified 2026-09-22:
 * type 1 = demo; type 0 = game; type 6 = software.
 * Unlike appdetails (which calls some utilities "game"), this distinguishes
 * Soundpad/3DMark parents correctly. Cache is per run, never cross-day.
 */
interface StoreItem {
  id: number;
  appid?: number;
  success: number;
  type?: number;
  name?: string;
  visible?: boolean;
  is_free?: boolean;
  tagids?: number[];
  related_items?: { parent_appid?: number };
  release?: { steam_release_date?: number; is_coming_soon?: boolean };
}
// Verified against IStoreService/GetTagList on 2026-09-22. Broad genre
// tags, not a claim to reproduce the publisher's appdetails genre field.
const GENRE_TAGS: Record<number, string> = {
  9: "Strategy", 19: "Action", 21: "Adventure", 122: "RPG", 128: "Massively Multiplayer",
  492: "Indie", 597: "Casual", 599: "Simulation", 699: "Racing", 701: "Sports",
  1625: "Platformer", 1662: "Survival", 1664: "Puzzle", 1667: "Horror",
  1716: "Roguelike", 1774: "Shooter",
};
export interface VerifiedDemo { name: string; genre: string | null; releaseDate: string }
export type DemoVerification = { demo: VerifiedDemo | null; error?: string };
export type DemoVerifier = ReturnType<typeof createDemoVerifier>;

export function createDemoVerifier(delayMs = 250) {
  const cache = new Map<string, StoreItem | Error>();
  async function load(ids: string[]) {
    const missing = Array.from(new Set(ids)).filter(id => !cache.has(id));
    for (let offset = 0; offset < missing.length; offset += 50) {
      const batch = missing.slice(offset, offset + 50);
      try {
        const url = new URL("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/");
        url.searchParams.set("input_json", JSON.stringify({
          ids: batch.map(id => ({ appid: Number(id) })),
          context: { language: "english", country_code: "US" },
          data_request: { include_basic_info: true, include_release: true, include_tag_count: 100 },
        }));
        const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`Steam metadata HTTP ${response.status}`);
        const body = await response.json() as { response?: { store_items?: StoreItem[] } };
        if (!Array.isArray(body.response?.store_items)) throw new Error("Steam metadata response changed");
        for (const id of batch) {
          const item = body.response.store_items.find(item => String(item.id) === id);
          cache.set(id, item && Number.isInteger(item.success)
            ? item : new Error(`Steam metadata missing app ${id}`));
        }
      } catch (error) {
        for (const id of batch) cache.set(id, error instanceof Error ? error : new Error(String(error)));
      }
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  function eligibleDemo(item: StoreItem) {
    const release = item.release?.steam_release_date;
    return item.success === 1 && item.type === 1 && item.visible === true && item.is_free === true &&
      item.release?.is_coming_soon !== true && typeof release === "number" &&
      release > 0 && release <= Date.now() / 1000 &&
      Number.isSafeInteger(item.related_items?.parent_appid) && item.related_items!.parent_appid! > 0 &&
      item.related_items!.parent_appid !== item.appid;
  }
  return {
    async verify(ids: string[]): Promise<Map<string, DemoVerification>> {
      await load(ids);
      const parents = ids.flatMap(id => {
        const item = cache.get(id);
        return item && !(item instanceof Error) && eligibleDemo(item)
          ? [String(item.related_items!.parent_appid)] : [];
      });
      await load(parents);
      const out = new Map<string, DemoVerification>();
      for (const id of ids) {
        const item = cache.get(id)!;
        if (item instanceof Error) { out.set(id, { demo: null, error: item.message }); continue; }
        if (!eligibleDemo(item)) { out.set(id, { demo: null }); continue; }
        const parent = cache.get(String(item.related_items!.parent_appid))!;
        if (parent instanceof Error) { out.set(id, { demo: null, error: parent.message }); continue; }
        const validParent = parent.success === 1 && parent.type === 0;
        const demoGenres = (item.tagids ?? []).flatMap(tag => GENRE_TAGS[tag] ? [GENRE_TAGS[tag]] : []);
        const genres = demoGenres.length ? demoGenres
          : (parent.tagids ?? []).flatMap(tag => GENRE_TAGS[tag] ? [GENRE_TAGS[tag]] : []);
        out.set(id, { demo: validParent ? {
          name: item.name || `Steam demo ${id}`,
          genre: Array.from(new Set(genres)).sort().join(", ") || null,
          releaseDate: new Date(item.release!.steam_release_date! * 1000).toISOString().slice(0, 10),
        } : null });
      }
      return out;
    },
  };
}
