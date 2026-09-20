/** Portrait assets are not interchangeable with store headers or hero banners. */
const cache = new Map<string, { expires: number; value: string | null }>();
const pending = new Map<string, Promise<string | null>>();

export function steamPortraitFromItem(item: any, appId: string): string | null {
  if (String(item?.appid) !== appId || item?.success !== 1) return null;
  const asset = item.assets?.library_capsule_2x || item.assets?.library_capsule;
  // Paths are returned by Steam; do not guess the asset's hash or filename.
  if (typeof asset !== "string" || !/^[a-zA-Z0-9_./-]+$/.test(asset) || asset.includes("..")) return null;
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/${asset}`;
}

export async function steamPortrait(appId: string): Promise<string | null> {
  if (!/^\d+$/.test(appId)) return null;
  const hit = cache.get(appId);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (pending.has(appId)) return pending.get(appId)!;
  const request = (async () => {
    let value: string | null = null;
    try {
      const url = new URL("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/");
      url.searchParams.set("input_json", JSON.stringify({
        ids: [{ appid: Number(appId) }], context: { language: "english", country_code: "US" },
        data_request: { include_assets: true },
      }));
      const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
      if (response.ok) {
        const body = await response.json() as any;
        value = steamPortraitFromItem(body.response?.store_items?.[0], appId);
      }
    } catch { /* No header fallback: missing portrait is safer than wrong art. */ }
    if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
    cache.set(appId, { value, expires: Date.now() + (value ? 86400000 : 300000) });
    return value;
  })();
  pending.set(appId, request);
  try { return await request; } finally { pending.delete(appId); }
}
