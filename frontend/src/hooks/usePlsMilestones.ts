/**
 * PLS milestones fetched from SignalPulse for the current SentimentPulse game.
 *
 * Design (v0.1 2026-08-17)
 * ------------------------
 * The two apps run on the same droplet under nginx:
 *   SentimentPulse frontend is served from /
 *   SignalPulse   API is exposed at        /signal/api/*
 * so we can talk to SignalPulse straight from the browser — no CORS, no
 * auth, no backend proxy.
 *
 * Cross-app join key: **Steam App ID**. Every SentimentPulse game carries
 * `steam_app_id` and every SignalPulse product carries `steamAppId`. Match
 * on that instead of title (titles drift: "Space Marine 2" vs "Warhammer
 * 40,000: Space Marine 2 — Salamanders Champion Pack" would false-match on
 * substring).
 *
 * Not every SentimentPulse game has a SignalPulse product — SP tracks 146
 * items (many are DLC/cosmetic packs), SignalPulse tracks 14 base titles.
 * The hook returns an empty array for unmatched games so the caller can
 * cleanly hide the toggle when there is nothing to show.
 */
import { useQuery } from '@tanstack/react-query'

// ── SignalPulse response shapes (subset we actually consume) ──────────────

/**
 * SignalPulse serializes `steamAppId` as a STRING on the wire even though
 * SentimentPulse uses a numeric `steam_app_id`. Do NOT tighten this to
 * `number` — the raw payload really is a string (verified against the
 * live droplet 2026-08-17). See findProductBySteamAppId below for the
 * type-normalizing comparison that keeps this from silently no-matching.
 */
export interface SignalPulseProduct {
  id:          number
  title:       string
  publisher:   string
  steamAppId:  string | number | null
}

/**
 * PLS milestone as returned by GET /signal/api/products/:id/pls.
 * SignalPulse camelCases these; we keep the raw shape and adapt in a
 * derived selector below.
 *
 * Categories seen in production (2026-08-17): 'core', 'video',
 * 'press_coverage', 'demo_beta', 'promotion'. Extend `PLS_CATEGORY_META`
 * when a new category shows up so it gets a color/label instead of the
 * default.
 */
export interface SignalPulsePlsMilestone {
  id:         number
  productId:  number
  category:   string
  name:       string
  targetDate: string | null      // YYYY-MM-DD
  actualDate: string | null      // YYYY-MM-DD
  isDefault:  boolean
  sortOrder:  number
  deletedAt:  string | null
}

// ── Normalized shape consumed by the chart ────────────────────────────────
//
// We deliberately expose the SAME field names as the existing TimelineEvent
// contract (event_date, name) so the chart's rendering code can treat PLS
// milestones and user-authored timeline events uniformly — the chart just
// merges two arrays.

export interface PlsAnnotation {
  id:         string        // stringified to avoid collision with TimelineEvent numeric ids
  event_date: string        // YYYY-MM-DD (actualDate when present, else targetDate)
  name:       string
  category:   string        // raw category from SignalPulse
  is_planned: boolean       // true when only targetDate was available
  source:     'pls'         // discriminator vs user-authored events
}

// ── Category display metadata ─────────────────────────────────────────────
//
// Categories are surfaced to the user as color-coded dots in the chart
// tooltip and the per-day event list. Colors are picked from the design-
// foundations chart color sequence so they stay on-palette with the rest of
// the app. Keep the entries short and human-readable — they appear in the
// event list right next to milestone names.

export interface PlsCategoryMeta {
  label: string
  color: string
}

export const PLS_CATEGORY_META: Record<string, PlsCategoryMeta> = {
  core:           { label: 'Core',    color: '#20808D' }, // teal
  video:          { label: 'Video',   color: '#A84B2F' }, // terra/rust
  press_coverage: { label: 'Press',   color: '#944454' }, // mauve
  demo_beta:      { label: 'Demo',    color: '#FFC553' }, // gold
  // 2026-08-17: Steam Sale / Next Fest windows, batch-tagged across all
  // released titles. Olive keeps it distinct from the 4 categories above
  // (and from the brown default fallback) while staying within the
  // design-foundations chart color sequence (position 7).
  promotion:      { label: 'Sale',    color: '#848456' }, // olive
}
export const PLS_CATEGORY_DEFAULT: PlsCategoryMeta = {
  label: 'PLS',
  color: '#6E522B',                                       // brown fallback
}
export function metaFor(category: string): PlsCategoryMeta {
  return PLS_CATEGORY_META[category] ?? PLS_CATEGORY_DEFAULT
}

// ── Data layer ────────────────────────────────────────────────────────────

/**
 * Cross-app URL prefix. SignalPulse's API is mounted at /signal/api on the
 * same host. Using a bare relative URL makes local dev (Vite proxy) and
 * production (nginx) behave identically — no environment plumbing needed.
 *
 * If either app is ever moved to a different host, this is the one place
 * that has to change.
 */
const SIGNALPULSE_BASE = '/signal/api'

// One-off product list — cheap (~14 items, ~28 KB) and static enough to
// cache aggressively. Keyed on nothing since it's a global list. React
// Query dedupes callers automatically.
export function useSignalPulseProducts() {
  return useQuery<SignalPulseProduct[]>({
    queryKey: ['signalpulse-products'],
    queryFn: async () => {
      const r = await fetch(`${SIGNALPULSE_BASE}/products`)
      if (!r.ok) throw new Error(`SignalPulse /products failed: ${r.status}`)
      return r.json() as Promise<SignalPulseProduct[]>
    },
    // Product list changes rarely — 5 min cache is plenty. Nothing here is
    // time-sensitive (product creates happen from the SignalPulse admin UI).
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Find the SignalPulse product that maps to a given SentimentPulse steam
 * app id. Returns undefined when no matching product exists, which is
 * a valid state (most SentimentPulse games don't have a SignalPulse
 * product — DLC, cosmetics, competitor watchlist entries).
 *
 * v0.2 bug fix (2026-08-17): SentimentPulse returns steam_app_id as a
 * NUMBER (e.g. 1551980) while SignalPulse returns steamAppId as a
 * STRING (e.g. "1551980"). A strict `===` compared these and always
 * returned false, so the PLS toggle never rendered on the sentiment
 * chart. Normalize both sides to strings before comparing — strings
 * because Steam App IDs are identifiers, not quantities, so string
 * equality is the safer invariant even if SignalPulse ever emits a
 * non-numeric ID in the future.
 */
export function findProductBySteamAppId(
  products: SignalPulseProduct[] | undefined,
  steamAppId: number | string | null | undefined,
): SignalPulseProduct | undefined {
  if (!products || steamAppId == null || steamAppId === '') return undefined
  const needle = String(steamAppId)
  return products.find(p => p.steamAppId != null && String(p.steamAppId) === needle)
}

/**
 * Fetch and normalize PLS milestones for a SentimentPulse game.
 *
 * `steamAppId` is the game's Steam App ID (from Game.steam_app_id).
 * Returns:
 *   • { data: [] }     — no matching SignalPulse product OR product has no
 *                         milestones with dates. Chart won't render the toggle.
 *   • { data: [...] }  — annotations ready to merge into the chart.
 *
 * All returned annotations already have a resolved `event_date` (prefers
 * actualDate over targetDate) — callers don't need to know about the
 * SignalPulse schema.
 */
export function usePlsMilestones(steamAppId: number | null | undefined) {
  const productsQ = useSignalPulseProducts()
  const product   = findProductBySteamAppId(productsQ.data, steamAppId)

  return useQuery<PlsAnnotation[]>({
    // Product id in the key so switching games invalidates cleanly.
    queryKey: ['signalpulse-pls', product?.id ?? null],
    // Only run when we have a resolved product.
    enabled: product != null,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const r = await fetch(`${SIGNALPULSE_BASE}/products/${product!.id}/pls`)
      if (!r.ok) throw new Error(`SignalPulse /pls failed: ${r.status}`)
      const raw = (await r.json()) as SignalPulsePlsMilestone[]

      // Normalize:
      //   • Drop soft-deleted (SignalPulse already filters, but defensive).
      //   • Drop entries with no date on either field — nothing to plot.
      //   • Prefer actualDate; fall back to targetDate for future events.
      //   • Stringify id to avoid colliding with TimelineEvent numeric ids
      //     if a caller ever merges the two lists.
      const out: PlsAnnotation[] = []
      for (const m of raw) {
        if (m.deletedAt) continue
        const date = m.actualDate || m.targetDate
        if (!date) continue
        out.push({
          id:         `pls-${m.id}`,
          event_date: date,
          name:       m.name,
          category:   m.category,
          is_planned: !m.actualDate,   // only targetDate → future/planned
          source:     'pls',
        })
      }
      // Chronological ordering matches how the chart's TimelineEvent list
      // is rendered — old to new.
      out.sort((a, b) => a.event_date.localeCompare(b.event_date))
      return out
    },
  })
}
