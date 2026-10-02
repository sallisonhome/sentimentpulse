import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { formatDelta, truncate, relativeTime, sourceLabel, periodToDays } from '../utils'

// ── formatDelta ───────────────────────────────────────────────────────────────

describe('formatDelta', () => {
  it('formats a positive delta with leading +', () => {
    expect(formatDelta(0.035)).toBe('+3.5%')
  })

  it('formats a negative delta without leading +', () => {
    expect(formatDelta(-0.12)).toBe('-12.0%')
  })

  it('formats zero as +0.0%', () => {
    expect(formatDelta(0)).toBe('+0.0%')
  })

  it('returns N/A for null', () => {
    expect(formatDelta(null)).toBe('N/A')
  })

  it('returns N/A for undefined', () => {
    expect(formatDelta(undefined)).toBe('N/A')
  })
})

// ── truncate ──────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns string unchanged when shorter than maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('returns string unchanged when equal to maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('truncates and appends ellipsis when longer than maxLen', () => {
    expect(truncate('hello world', 5)).toBe('hello…')
  })

  it('returns empty string for null', () => {
    expect(truncate(null, 10)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(truncate(undefined, 10)).toBe('')
  })

  it('returns empty string for empty string', () => {
    expect(truncate('', 10)).toBe('')
  })
})

// ── relativeTime ──────────────────────────────────────────────────────────────

describe('relativeTime', () => {
  it('returns Never for null', () => {
    expect(relativeTime(null)).toBe('Never')
  })

  it('returns Never for undefined', () => {
    expect(relativeTime(undefined)).toBe('Never')
  })

  it('returns Just now for timestamps less than 1 minute ago', () => {
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString()
    expect(relativeTime(thirtySecondsAgo)).toBe('Just now')
  })

  it('returns Xm ago for timestamps within the last hour', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(relativeTime(fiveMinutesAgo)).toBe('5m ago')
  })

  it('returns Xh ago for timestamps within the last day', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
    expect(relativeTime(threeHoursAgo)).toBe('3h ago')
  })

  it('returns Xd ago for timestamps older than 24 hours', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()
    expect(relativeTime(twoDaysAgo)).toBe('2d ago')
  })

  // 2026-10-02: Settings "Next:" showed "Just now" for a run 21h away.
  it('formats future timestamps as "in X" rather than Just now', () => {
    const offset = 60_000 * 0.5 // keep strictly inside each bucket
    expect(relativeTime(new Date(Date.now() + 30_000).toISOString())).toBe('in <1m')
    expect(relativeTime(new Date(Date.now() + 5 * 60_000 + offset).toISOString())).toBe('in 5m')
    expect(relativeTime(new Date(Date.now() + 21 * 3_600_000 + offset).toISOString())).toBe('in 21h')
    expect(relativeTime(new Date(Date.now() + 2 * 86_400_000 + offset).toISOString())).toBe('in 2d')
  })

  it('returns Never for an unparseable timestamp', () => {
    expect(relativeTime('not-a-date')).toBe('Never')
  })

  it('handles the live ET-offset next_run_at shape', () => {
    const next = new Date(Date.now() + 21 * 3_600_000 + 30_000)
    const iso = next.toISOString().replace('Z', '+00:00')
    expect(relativeTime(iso)).toBe('in 21h')
  })
})

// ── sourceLabel ───────────────────────────────────────────────────────────────

describe('sourceLabel', () => {
  it('maps steam_review', () => {
    expect(sourceLabel('steam_review')).toBe('Steam Review')
  })

  it('maps steam_forum', () => {
    expect(sourceLabel('steam_forum')).toBe('Steam Forum')
  })

  it('maps reddit', () => {
    expect(sourceLabel('reddit')).toBe('Reddit')
  })

  it('maps dtf', () => {
    expect(sourceLabel('dtf')).toBe('DTF')
  })

  it('maps bluesky', () => {
    expect(sourceLabel('bluesky')).toBe('Bluesky')
  })

  it('returns the raw string for unknown sources', () => {
    expect(sourceLabel('unknown_source')).toBe('unknown_source')
  })
})

// ── periodToDays ──────────────────────────────────────────────────────────────

describe('periodToDays', () => {
  it('returns 7 for weekly', () => {
    expect(periodToDays('weekly')).toBe(7)
  })

  it('returns 30 for monthly', () => {
    expect(periodToDays('monthly')).toBe(30)
  })

  it('returns 90 for quarterly', () => {
    expect(periodToDays('quarterly')).toBe(90)
  })

  it('returns null for lifetime', () => {
    expect(periodToDays('lifetime')).toBeNull()
  })
})
