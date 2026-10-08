// PS5 storefront names must be English on the US board. The PlayStation category grid can return a
// product's Japanese name (Dynasty Warriors 3 returned 真・三國無双２ with 猛将伝 Remastered) while the
// en-us product page shows the English title. The leaderboards join Steam, PS5 and Xbox by the
// normalized name, so a non-Latin PS5 name keeps the PS5 row out of its family and forces a
// console-exclusive estimate. Rule: reviewed SKU name first, then the en-us product page title,
// and the grid name is kept when neither is available (never an invented name).
export const REVIEWED_PS5_ENGLISH_NAMES: ReadonlyMap<string, string> = new Map<string, string>([
  ["JP0106-PPSA32935_00-DW3CEREMASTERED0", "DYNASTY WARRIORS 3: Complete Edition Remastered"],
  ["JP0106-PPSA32935_00-DW3CEREDDXE00000", "DYNASTY WARRIORS 3: Complete Edition Remastered Digital Deluxe Edition"],
]);

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff66-\uff9f]/;
export const hasCjk = (s: string | null | undefined): boolean => !!s && CJK.test(s);

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));

/** The en-us product page <title> is the English store name. Null when absent or still CJK. */
export function parsePsStoreTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = decode(m[1]).replace(/\s*\|\s*PlayStation.*$/i, "").replace(/\s+/g, " ").trim();
  return t && !hasCjk(t) ? t : null;
}

export type PsHtmlFetcher = (productId: string) => Promise<string>;
const defaultFetcher: PsHtmlFetcher = async (productId) => {
  const res = await fetch(`https://store.playstation.com/en-us/product/${encodeURIComponent(productId)}`, {
    headers: { "Accept-Language": "en-US", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

type Named = { productId: string; name: string | null; editions?: Array<{ productId: string; name: string | null }> };

export async function resolvePs5EnglishName(productId: string, name: string | null, fetcher: PsHtmlFetcher = defaultFetcher): Promise<string | null> {
  if (!hasCjk(name)) return name;
  const reviewed = REVIEWED_PS5_ENGLISH_NAMES.get(productId);
  if (reviewed) return reviewed;
  try { return parsePsStoreTitle(await fetcher(productId)) ?? name; } catch { return name; }
}

/** Mutates grid rows (base and edition names) so non-Latin names become English. Returns the count changed. */
export async function applyPs5EnglishNames(rows: Named[], log: (m: string) => void, fetcher: PsHtmlFetcher = defaultFetcher): Promise<number> {
  let changed = 0;
  const fix = async (r: { productId: string; name: string | null }) => {
    if (!hasCjk(r.name)) return;
    const next = await resolvePs5EnglishName(r.productId, r.name, fetcher);
    if (next && next !== r.name) { log(`ps5 english name: ${r.productId} "${r.name}" -> "${next}"`); r.name = next; changed++; }
    else log(`ps5 english name: ${r.productId} still non-Latin ("${r.name}"), no English source`);
  };
  for (const r of rows) { await fix(r); for (const e of r.editions ?? []) await fix(e); }
  return changed;
}
