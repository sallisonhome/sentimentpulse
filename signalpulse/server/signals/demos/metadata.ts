/**
 * Batched Store Browse metadata. Live-verified 2026-09-22:
 * type 1 = demo; type 0 = game; type 6 = software.
 * Unlike appdetails (which calls some utilities "game"), this distinguishes
 * Soundpad/3DMark parents correctly. Cache is per run, never cross-day.
 */
import { isFriendsPassSku, NAMED_PASS_ALIASES, type SkuKind } from "./friends-pass-identity";
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
export interface VerifiedDemo {
  name: string; genre: string | null; releaseDate: string | null;
  availabilitySource: "metadata_release" | "store_download";
  availabilitySourceUrl: string | null;
  availabilityCheckedAt: string;
}
export type DemoVerification = { demo: VerifiedDemo | null; error?: string; reason?: string };
export type DemoVerifier = ReturnType<typeof createDemoVerifier>;

export function createDemoVerifier(delayMs = 250, kind: SkuKind = "demo") {
  const cache = new Map<string, StoreItem | Error>();
  const pageCache = new Map<string, Promise<{ html: string; url: string }>>();
  async function downloadOffer(appId: string, parentId: string) {
    if (!pageCache.has(parentId)) pageCache.set(parentId, (async () => {
      const url = `https://store.steampowered.com/app/${parentId}/?cc=US&l=english`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000),
        headers: { Cookie: "birthtime=631152001; lastagecheckage=1-January-1990; mature_content=1" } });
      if (!response.ok) throw new Error(`Steam availability HTTP ${response.status}`);
      const final = new URL(response.url || url);
      if (final.origin !== "https://store.steampowered.com" || !final.pathname.startsWith(`/app/${parentId}/`)) {
        throw new Error("Demo availability page redirected outside the verified parent");
      }
      const html = await response.text();
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      return { html, url: final.href };
    })());
    const page = await pageCache.get(parentId)!;
    if (hasExactDemoDownload(page.html, appId, kind === "friends_pass")) return page.url;
    if (kind === "friends_pass" && appId === parentId) {
      // Some free pass clients are type=game with is_free omitted. Require
      // a real free-license offer for a package belonging to this exact SKU.
      // Packages can grant the full game's runtime; this is availability
      // evidence ONLY, never permission to read parent reviews/CCU/downloads.
      const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=US&l=english`,
        { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Pass details HTTP ${response.status}`);
      const json = await response.json() as any;
      const details = json[appId];
      if (details?.success !== true || String(details.data?.steam_appid) !== appId) {
        throw new Error("Pass details identity unavailable");
      }
      if (hasFreePassPackage(page.html, details.data.packages ?? [])) return page.url;
    }
    if (/agecheck|agegate_birthday_selector|captcha/i.test(page.html)) throw new Error("Availability page gated; retaining previous status");
    return null;
  }
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
  function eligibleIdentity(item: StoreItem) {
    if (kind === "friends_pass") return item.success === 1 && [0,1].includes(item.type ?? -1) &&
      item.visible === true && item.release?.is_coming_soon !== true && isFriendsPassSku(String(item.id),item.name ?? "") &&
      (!NAMED_PASS_ALIASES[String(item.id)] || item.related_items?.parent_appid === NAMED_PASS_ALIASES[String(item.id)].parent) &&
      (item.type === 0 || (item.is_free === true && Number.isSafeInteger(item.related_items?.parent_appid) &&
        item.related_items!.parent_appid! > 0 && item.related_items!.parent_appid !== item.appid));
    return item.success === 1 && item.type === 1 && item.visible === true && item.is_free === true &&
      item.release?.is_coming_soon !== true &&
      Number.isSafeInteger(item.related_items?.parent_appid) && item.related_items!.parent_appid! > 0 &&
      item.related_items!.parent_appid !== item.appid;
  }
  return {
    async verify(ids: string[]): Promise<Map<string, DemoVerification>> {
      await load(ids);
      const parents = ids.flatMap(id => {
        const item = cache.get(id);
        return item && !(item instanceof Error) && eligibleIdentity(item) && item.type === 1
          ? [String(item.related_items!.parent_appid)] : [];
      });
      await load(parents);
      const out = new Map<string, DemoVerification>();
      for (const id of ids) {
        const item = cache.get(id)!;
        if (item instanceof Error) { out.set(id, { demo: null, error: item.message }); continue; }
        if (!eligibleIdentity(item)) { out.set(id, { demo: null, reason: "identity_or_availability" }); continue; }
        if (kind === "demo" && isFriendsPassSku(id,item.name ?? "")) {
          out.set(id, { demo: null, reason: "friend_pass_review_required" }); continue;
        }
        const parent = item.type === 0 ? item : cache.get(String(item.related_items!.parent_appid))!;
        if (parent instanceof Error) { out.set(id, { demo: null, error: parent.message }); continue; }
        const validParent = parent.success === 1 && parent.type === 0;
        if (!validParent) { out.set(id, { demo: null, reason: "non_game_parent" }); continue; }
        const release = item.release?.steam_release_date;
        const validDate = typeof release === "number" && release > 0 && release <= Date.now() / 1000;
        let availabilitySourceUrl: string | null = null;
        if (!validDate || kind === "friends_pass") {
          try {
            availabilitySourceUrl = await downloadOffer(id, String(parent.id));
            if (!availabilitySourceUrl && kind === "friends_pass" && item.type === 1) availabilitySourceUrl = await downloadOffer(id, id);
          }
          catch (error) {
            out.set(id, { demo: null, error: error instanceof Error ? error.message : String(error) }); continue;
          }
          if (!availabilitySourceUrl) {
            out.set(id, { demo: null, reason: "date_unverified_no_download_offer" }); continue;
          }
        }
        const demoGenres = (item.tagids ?? []).flatMap(tag => GENRE_TAGS[tag] ? [GENRE_TAGS[tag]] : []);
        const genres = demoGenres.length ? demoGenres
          : (parent.tagids ?? []).flatMap(tag => GENRE_TAGS[tag] ? [GENRE_TAGS[tag]] : []);
        out.set(id, { demo: validParent ? {
          name: item.name || `Steam demo ${id}`,
          genre: Array.from(new Set(genres)).sort().join(", ") || null,
          releaseDate: validDate ? new Date(release! * 1000).toISOString().slice(0, 10) : null,
          availabilitySource: availabilitySourceUrl ? "store_download" : "metadata_release",
          availabilitySourceUrl,
          availabilityCheckedAt: new Date().toISOString(),
        } : null });
      }
      return out;
    },
  };
}

/** Only a download action bound to this exact demo counts. Text mentions,
 * unrelated/parent installs, script examples and age-gate pages do not.
 */
export function hasExactDemoDownload(html: string, appId: string, allowGame = false): boolean {
  if (!/^[1-9]\d*$/.test(appId)) return false;
  const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const match of Array.from(clean.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi))) {
    const attrs = match[1];
    if (/aria-hidden\s*=\s*["']true|display\s*:\s*none/i.test(attrs)) continue;
    const label = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!/^(download(?: demo)?|install demo|play demo)$/i.test(label) && !(allowGame && /^(play game|play now|install)$/i.test(label))) continue;
    const href = attrs.match(/\bhref\s*=\s*(["'])([\s\S]*?)\1/i)?.[2]
      ?.replace(/&quot;|&#34;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();
    if (!href) continue;
    if (href === `steam://install/${appId}` ||
      new RegExp(`^javascript:\\s*ShowGotSteamModal\\(\\s*['"]steam://install/${appId}['"]\\s*,`, "i").test(href)) return true;
    if (allowGame && (href === `steam://run/${appId}` ||
      new RegExp(`^javascript:\\s*ShowGotSteamModal\\(\\s*['"]steam://run/${appId}['"]\\s*,`, "i").test(href))) return true;
  }
  return false;
}

export function hasFreePassPackage(html: string, packageIds: number[]): boolean {
  const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<!--[\s\S]*?-->/gi, "");
  for (const id of packageIds.filter(id => Number.isSafeInteger(id) && id > 0)) {
    const form = new RegExp(`<form\\b(?=[^>]*\\bname=["']add_to_cart_${id}["'])(?=[^>]*\\baction=["']https://store\\.steampowered\\.com/freelicense/addfreelicense/["'])[^>]*>[\\s\\S]*?</form>`, "i");
    if (form.test(clean) && new RegExp(`href=["']javascript:addToCart\\(\\s*${id}\\s*\\);?["']`, "i").test(clean)) return true;
  }
  return false;
}
