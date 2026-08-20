// v3.36 (2026-08-20): fields that GET /api/products (dashboard list) and
// GET /api/products/:id (PDP) compute identically -- same name, same shape,
// same underlying storage/forecast lookups -- kept in sync between the two
// React Query cache entries. Scoped to wishlist/PS5-prepurchase counts
// (per explicit direction) PLUS the Bull/Bear forecast-scenario fields
// that are directly derived from those same locked counts. It intentionally
// still excludes steamFirstMonthForecast, steamRevenueSplit, gmvFactor,
// and observedSteamAspRatio -- those remain out of scope for this fix.
//
// - steamWishlistSummary: the Steam wishlist summary object (dayOverDayDelta,
//   latestDate, isStale, lifetimeNet) -- this is the exact "1 day count"
//   field the original reported bug was about.
// - latestSteamWishlistCount: Steam lifetime/cumulative wishlist count.
// - latestPs5WishlistCount / latestPs5PrepurchaseCount: PS5 wishlist and
//   prepurchase counts. These are null/unpopulated unless a PlayStation
//   partner API key is configured and that ingestion source is actually
//   pulling data -- syncing them here is a no-op for products that don't
//   have PlayStation data, and correctly propagates it for ones that do.
// - launchForecastSnapshot: the LOCKED Dynamic Pre-Launch Forecast baseline
//   (server/routes.ts). Written once per product (idempotent upsert) by
//   the list endpoint; the PDP only reads it (storage.getLaunchForecastSnapshot).
//   Both endpoints read/produce the exact same DB row, so this field is
//   identical between them at any given server-side moment.
// - forecastScenarios: { bull, bear } Month-1 conversion scenario pair that
//   drives the page-level Bull/Bear toggle on both dashboard cards and the
//   PDP. Computed by the identical computeForecastScenarios(...) call in
//   both endpoints, fed by launchForecastSnapshot's locked inputs (or live
//   wishlist/PS5-prepurchase counts pre-release) -- so it's just as
//   deterministic server-side as the counts above, and needs the same
//   cross-cache sync to avoid the dashboard and PDP showing a stale vs.
//   fresh scenario pair for the same toggle position.
//
// Root cause this exists to fix: the dashboard's list query and the PDP's
// detail query are two independently-cached entries. Before this fix,
// staleTime: Infinity meant whichever one loaded first could sit stale
// indefinitely while the other page fetched fresh data -- e.g. a dashboard
// tab left open across the daily 07:00 UTC ingestion cron kept showing
// yesterday's wishlist delta, and (once that was fixed) a dashboard or PDP
// tab could still show a stale forecastScenarios/launchForecastSnapshot
// pair even after its wishlist count had already been patched fresh --
// because those two fields weren't part of the sync yet. Each query now has
// a bounded staleTime, and on every successful fetch this list of fields is
// pushed into the OTHER query's cache entry (if it already exists), so
// neither page can lag behind wishlist, prepurchase, or Bull/Bear forecast
// data the other has already fetched.
export const SHARED_WISHLIST_FIELDS = [
  "steamWishlistSummary",
  "latestSteamWishlistCount",
  "latestPs5WishlistCount",
  "latestPs5PrepurchaseCount",
  "launchForecastSnapshot",
  "forecastScenarios",
] as const;

// Bounds worst-case client-side staleness to 5 minutes, matching the fact
// that ingestion only runs once daily -- no need to poll. Combined with
// refetchOnWindowFocus, a tab regains freshness the moment it's refocused.
export const PRODUCT_QUERY_STALE_TIME_MS = 5 * 60 * 1000;
