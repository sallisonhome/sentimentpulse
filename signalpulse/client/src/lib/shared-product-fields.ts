// v3.35 (2026-08-20): fields that GET /api/products (dashboard list) and
// GET /api/products/:id (PDP) compute identically -- same name, same shape,
// same underlying storage lookups. This is deliberately scoped to WISHLIST
// AND PS5 PREPURCHASE COUNTS ONLY (per explicit direction) -- the exact
// numbers the reported bug was about. It intentionally excludes forecast
// and revenue fields (steamFirstMonthForecast, steamRevenueSplit,
// gmvFactor, observedSteamAspRatio, launchForecastSnapshot,
// forecastScenarios) -- those are not part of this fix and must not be
// forced into sync by it.
//
// - steamWishlistSummary: the Steam wishlist summary object (dayOverDayDelta,
//   latestDate, isStale, lifetimeNet) -- this is the exact "1 day count"
//   field the reported bug was about.
// - latestSteamWishlistCount: Steam lifetime/cumulative wishlist count.
// - latestPs5WishlistCount / latestPs5PrepurchaseCount: PS5 wishlist and
//   prepurchase counts. These are null/unpopulated unless a PlayStation
//   partner API key is configured and that ingestion source is actually
//   pulling data -- syncing them here is a no-op for products that don't
//   have PlayStation data, and correctly propagates it for ones that do.
//
// Root cause this exists to fix: the dashboard's list query and the PDP's
// detail query are two independently-cached entries. Before this fix,
// staleTime: Infinity meant whichever one loaded first could sit stale
// indefinitely while the other page fetched fresh data -- e.g. a dashboard
// tab left open across the daily 07:00 UTC ingestion cron kept showing
// yesterday's wishlist delta. Each query now has a bounded staleTime, and
// on every successful fetch this list of fields is pushed into the OTHER
// query's cache entry (if it already exists), so neither page can lag
// behind wishlist/prepurchase data the other has already fetched.
export const SHARED_WISHLIST_FIELDS = [
  "steamWishlistSummary",
  "latestSteamWishlistCount",
  "latestPs5WishlistCount",
  "latestPs5PrepurchaseCount",
] as const;

// Bounds worst-case client-side staleness to 5 minutes, matching the fact
// that ingestion only runs once daily -- no need to poll. Combined with
// refetchOnWindowFocus, a tab regains freshness the moment it's refocused.
export const PRODUCT_QUERY_STALE_TIME_MS = 5 * 60 * 1000;
