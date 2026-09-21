/**
 * Storefront SKU identity outranks enrichment. A base game must never acquire
 * the identity of a similarly named update, expansion, sequel or spin-off.
 * Strip packaging/platform noise only; never strip arbitrary subtitles.
 */
export function identityName(name: string): string {
  let value = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[™®℗℠]/g, "").replace(/[‘’]/g, "'")
    .replace(/δ/g, "delta").replace(/[–—]/g, "-")
    .replace(/\s+/g, " ").trim();
  const suffix = /(?:\s*[:(\-]\s*|\s+)(?:(?:the )?(?:digital |premium |super )?(?:deluxe|ultimate|standard|complete|gold|premium|definitive)(?: edition)?|edition|ps4\s*(?:&|and)\s*ps5|ps[45](?: version)?|xbox one\s*(?:&|and)\s*xbox series x[|/]s|xbox series x[|/]s|xbox one|pc|windows|steam)\)?$/i;
  for (let i = 0; i < 8; i++) {
    const next = value.replace(suffix, "").trim();
    if (!next || next === value) break;
    value = next;
  }
  const roman: Record<string,string> = {ii:"2",iii:"3",iv:"4",v:"5",vi:"6",vii:"7",viii:"8",ix:"9",x:"10",xi:"11",xii:"12",xiii:"13",xiv:"14",xv:"15",xvi:"16"};
  return value.replace(/^the\s+/, "").replace(/\b(?:xvi|xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii)\b/g, token=>roman[token])
    .replace(/[^a-z0-9]/g, "");
}

export function metadataMatchesStorefront(storeName: string | null | undefined, name: string | null | undefined): boolean {
  // Lack of storefront evidence is not evidence of a mismatch.
  if (!storeName?.trim() || !name?.trim()) return true;
  return identityName(storeName) === identityName(name);
}

/** Regional rows share the same estimate; prefer a priced row, count once. */
export function uniquePlatformTitles<T extends { titleId: number; platform: string; msrpUsdCents: number | null }>(rows: T[]): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.platform}:${row.titleId}`;
    const previous = unique.get(key);
    if (!previous || (previous.msrpUsdCents == null && row.msrpUsdCents != null)) unique.set(key, row);
  }
  return Array.from(unique.values());
}
