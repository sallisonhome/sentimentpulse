/**
 * usePlsMilestones — pure logic tests.
 *
 * We test the helpers that don't need React (findProductBySteamAppId,
 * metaFor). The React Query wrappers around fetch are trivial and would
 * need @testing-library/react + MSW to test properly, which this project
 * doesn't ship. Coverage priorities:
 *   • The Steam App ID join lookup is null-safe for unmatched games.
 *   • Category metadata falls back for unknown categories (defensive
 *     against SignalPulse adding a new category tomorrow).
 */
import { describe, it, expect } from 'vitest'
import {
  findProductBySteamAppId,
  metaFor,
  PLS_CATEGORY_META,
  PLS_CATEGORY_DEFAULT,
  type SignalPulseProduct,
} from '../usePlsMilestones'

// v0.2 regression fixture (2026-08-17): live SignalPulse serializes
// steamAppId as a STRING. Keep these as strings in the fixture so the
// tests exercise the real wire shape and would have caught the original
// bug — in v0.1 we used numbers here, which passed `===` locally but
// silently no-matched against production.
const products: SignalPulseProduct[] = [
  { id: 3,  title: 'Space Marine 2',            publisher: 'Focus x Saber', steamAppId: '2183900' },
  { id: 7,  title: "Clive Barker's Hellraiser", publisher: 'Saber',         steamAppId: '1551980' },
  { id: 12, title: 'Rideshare Stimulator',      publisher: 'Saber',         steamAppId: '2366590' },
  { id: 99, title: 'Legacy product',            publisher: 'Saber',         steamAppId: null      },
]

describe('findProductBySteamAppId', () => {
  it('matches a numeric SentimentPulse id against a string SignalPulse id', () => {
    // The exact type mismatch from the v0.1 bug: SentimentPulse's
    // steam_app_id comes in as a JS number, SignalPulse's steamAppId
    // comes in as a string. Strict `===` returned false, so the toggle
    // never appeared. This test locks in the type-coercion behavior.
    const p = findProductBySteamAppId(products, 2366590)
    expect(p?.id).toBe(12)
    expect(p?.title).toBe('Rideshare Stimulator')
  })

  it('also matches when both sides are strings', () => {
    expect(findProductBySteamAppId(products, '1551980')?.id).toBe(7)
  })

  it('returns undefined for an unmatched Steam App ID', () => {
    // Most SentimentPulse games (DLC, cosmetic packs, competitors) will
    // NOT have a SignalPulse product — this must not throw and must
    // signal "no match" cleanly so the chart hides the PLS toggle.
    expect(findProductBySteamAppId(products, 999999)).toBeUndefined()
  })

  it('returns undefined when the game has no steam_app_id at all', () => {
    expect(findProductBySteamAppId(products, null)).toBeUndefined()
    expect(findProductBySteamAppId(products, undefined)).toBeUndefined()
  })

  it('returns undefined when the products list is not loaded yet', () => {
    expect(findProductBySteamAppId(undefined, 2366590)).toBeUndefined()
  })

  it('does not match a product whose steamAppId is null', () => {
    // Guard against a subtle bug where `p.steamAppId === null` could
    // match a lookup where the game's steam_app_id was also null.
    expect(findProductBySteamAppId(products, null)).toBeUndefined()
    // And it must not match a null-steamAppId product on any numeric input.
    expect(findProductBySteamAppId(products, 0)).toBeUndefined()
  })
})

describe('metaFor', () => {
  it('returns the specific metadata for known categories', () => {
    expect(metaFor('core')).toBe(PLS_CATEGORY_META.core)
    expect(metaFor('video')).toBe(PLS_CATEGORY_META.video)
    expect(metaFor('press_coverage')).toBe(PLS_CATEGORY_META.press_coverage)
    expect(metaFor('demo_beta')).toBe(PLS_CATEGORY_META.demo_beta)
    expect(metaFor('promotion')).toBe(PLS_CATEGORY_META.promotion)
  })

  it('gives the promotion (Steam Sale / Next Fest) category its own distinct color', () => {
    // Regression guard: promotion milestones were rendering with the brown
    // default fallback (same as truly-unknown categories) instead of a
    // color of their own. Must be distinct from every other known category
    // AND from the default fallback color.
    const promo = metaFor('promotion')
    expect(promo).not.toBe(PLS_CATEGORY_DEFAULT)
    expect(promo.color).not.toBe(PLS_CATEGORY_DEFAULT.color)
    const otherColors = [
      PLS_CATEGORY_META.core.color,
      PLS_CATEGORY_META.video.color,
      PLS_CATEGORY_META.press_coverage.color,
      PLS_CATEGORY_META.demo_beta.color,
    ]
    expect(otherColors).not.toContain(promo.color)
  })

  it('falls back to the default for unknown categories', () => {
    // SignalPulse could add a category tomorrow (e.g. 'streamer_beat').
    // The chart must degrade gracefully: use the default meta + brown
    // color so the marker still renders and can be identified.
    expect(metaFor('streamer_beat')).toBe(PLS_CATEGORY_DEFAULT)
    expect(metaFor('')).toBe(PLS_CATEGORY_DEFAULT)
  })
})
