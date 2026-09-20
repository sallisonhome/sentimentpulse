/** Shared fail-closed header policy for individual and title-family PDPs. */
export function safeTitleMetadata(igdb: Record<string, any> | undefined, identityMismatch = false): Record<string, any> | null {
  if (!igdb) return null;
  const unsafe = igdb.matchConfidence === "low" || identityMismatch;
  const parse = (value: unknown): any[] => {
    try { const result = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(result) ? result : []; }
    catch { return []; }
  };
  return {
    ...igdb,
    igdbId: unsafe ? null : igdb.igdbId,
    slug: unsafe ? null : igdb.slug,
    name: unsafe ? (igdb.storeName || null) : (igdb.name || igdb.storeName),
    coverUrl: unsafe ? (igdb.storeHeaderImageUrl || null) : (igdb.coverUrl || igdb.storeHeaderImageUrl),
    releaseDate: unsafe ? (igdb.storeReleaseDate || null) : (igdb.releaseDate || igdb.storeReleaseDate),
    nameSource: unsafe ? "store" : (igdb.name ? "igdb" : "store"),
    summary: unsafe ? null : igdb.summary,
    artworkUrl: unsafe ? null : igdb.artworkUrl,
    rating: unsafe ? null : igdb.rating,
    ratingCount: unsafe ? null : igdb.ratingCount,
    ...Object.fromEntries(["screenshots", "genres", "themes", "platforms", "developers", "publishers"].flatMap(field => [
      [field, unsafe ? [] : parse(igdb[`${field}Json`])],
      [`${field}Json`, unsafe ? null : igdb[`${field}Json`]],
    ])),
  };
}
