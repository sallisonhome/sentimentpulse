/**
 * v0021 (2026-08-19) — AppContext URL → state override rule tests.
 *
 * Prior bug: switching from Dashboard to Summary via the side nav dropped
 * ?game=<id> from the URL. AppContext's URL→state useEffect then saw
 * gameParam=null and cleared selectedGameId, which triggered TopBar's
 * auto-select-latest fallback and silently reset the user to the FIRST
 * title in the dropdown.
 *
 * Fix:
 *   1. Sidebar always preserves the current search string when navigating.
 *   2. resolveUrlGameOverride() only replaces state when the URL supplies
 *      a NEW valid game id. Missing / invalid params leave state alone.
 *
 * These tests lock in rule #2. The Sidebar change is covered by manual
 * inspection (it's a one-liner: `to={`${to}${suffix}`}`).
 */
import { describe, it, expect } from 'vitest'
import { resolveUrlGameOverride } from '../AppContext'

describe('resolveUrlGameOverride', () => {
  it('deep-link: no current state, URL has a valid game → adopt it', () => {
    expect(resolveUrlGameOverride('42', null)).toBe(42)
  })

  it('browser back/forward: URL has a valid game different from current → adopt it', () => {
    expect(resolveUrlGameOverride('99', 42)).toBe(99)
  })

  it('URL matches current state → no-op', () => {
    expect(resolveUrlGameOverride('42', 42)).toBe(42)
  })

  it('SAFETY NET: URL param is null and state has a game → KEEP state', () => {
    // This is the exact bug: bare nav drops ?game= and old logic would
    // null out selectedGameId, triggering the TopBar fallback.
    expect(resolveUrlGameOverride(null, 42)).toBe(42)
  })

  it('SAFETY NET: URL param is empty string and state has a game → KEEP state', () => {
    expect(resolveUrlGameOverride('', 42)).toBe(42)
  })

  it('SAFETY NET: URL param is non-numeric garbage and state has a game → KEEP state', () => {
    expect(resolveUrlGameOverride('notanumber', 42)).toBe(42)
  })

  it('SAFETY NET: URL param is "NaN" literal → KEEP state (defensive)', () => {
    // The old code did `Number("NaN")` → NaN, `Number.isFinite(NaN)` → false,
    // which used to fall through to setting state to null. Now falls back to current.
    expect(resolveUrlGameOverride('NaN', 42)).toBe(42)
  })

  it('SAFETY NET: URL param is Infinity → KEEP state (defensive)', () => {
    expect(resolveUrlGameOverride('Infinity', 42)).toBe(42)
  })

  it('no current state AND URL param missing → still null', () => {
    // Legit first-load state before user has ever picked a game.
    // TopBar's fallback effect will pick the latest game.
    expect(resolveUrlGameOverride(null, null)).toBe(null)
  })

  it('no current state AND URL param invalid → still null', () => {
    expect(resolveUrlGameOverride('foo', null)).toBe(null)
  })

  it('handles decimal in URL by adopting truncated? No — Number("42.5") is finite so adopt', () => {
    // Not a realistic case (game_id is always an int) but we should be
    // consistent: Number.isFinite(42.5) === true so we adopt 42.5.
    // The type union in AppContextValue is number so this is safe;
    // downstream hooks use it as an opaque id and never math on it.
    expect(resolveUrlGameOverride('42.5', null)).toBe(42.5)
  })

  it('zero is a valid game id (defensive)', () => {
    // We don't ship game_id=0 in production but the guard should be
    // consistent — Number.isFinite(0) === true and 0 !== null so adopt.
    expect(resolveUrlGameOverride('0', null)).toBe(0)
  })

  it('negative numbers are technically finite → adopt (backend will 404)', () => {
    // Edge case: if a bad URL has ?game=-5 we adopt it and let the API
    // layer 404. That's better UX than silently ignoring — the user sees
    // a clear "game not found" instead of being punted to another title.
    expect(resolveUrlGameOverride('-5', null)).toBe(-5)
  })
})
