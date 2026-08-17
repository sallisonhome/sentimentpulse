/**
 * Aggregation logic behind PostsBySourceCard.
 *
 * We test the pure aggregation helper — the component itself is thin
 * markup + Tailwind, and this project doesn't ship @testing-library/react
 * so we can't render. If DOM rendering tests are needed later, add
 * `@testing-library/react` and `@testing-library/jest-dom` first.
 */
import { describe, it, expect } from 'vitest'
import { aggregateVolumeBySource } from '../PostsBySourceCard'
import type { VolumePoint } from '../../../types'

function point(overrides: Partial<VolumePoint> = {}): VolumePoint {
  return {
    day:            '2026-08-10',
    steam_review:   0,
    steam_forum:    0,
    reddit:         0,
    reddit_comment: 0,
    bluesky:        0,
    dtf:            0,
    total:          0,
    ...overrides,
  }
}

describe('aggregateVolumeBySource', () => {
  it('sums per-day rows across every source', () => {
    const out = aggregateVolumeBySource([
      point({ steam_forum: 100, reddit: 50, bluesky: 10 }),
      point({ steam_forum: 200, reddit: 60, bluesky: 20 }),
    ])
    expect(out.steam_forum).toBe(300)
    expect(out.reddit).toBe(110)
    expect(out.bluesky).toBe(30)
    expect(out.reddit_comment).toBe(0)
    expect(out.dtf).toBe(0)
    expect(out.steam_review).toBe(0)
  })

  it('treats missing optional fields (reddit_comment, dtf) as 0', () => {
    // Older backend responses may omit these — component and helper must
    // not throw or NaN.
    const legacy = {
      day: '2026-01-01', steam_review: 0, steam_forum: 10, reddit: 5, bluesky: 2, total: 17,
    } as VolumePoint
    const out = aggregateVolumeBySource([legacy])
    expect(out.reddit_comment).toBe(0)
    expect(out.dtf).toBe(0)
    expect(out.steam_forum).toBe(10)
  })

  it('returns all-zero aggregate for an empty period', () => {
    const out = aggregateVolumeBySource([])
    expect(out.steam_forum).toBe(0)
    expect(out.reddit).toBe(0)
    expect(out.reddit_comment).toBe(0)
    expect(out.bluesky).toBe(0)
    expect(out.dtf).toBe(0)
    expect(out.steam_review).toBe(0)
  })

  it('handles a real Rideshare 7-day sample without loss', () => {
    // Numbers pulled 2026-08-17 from
    //   GET /api/games/144/dashboard?period=weekly
    // (7 daily points aggregate to 372+302+297+108+3+0 = 1082 total).
    const days: VolumePoint[] = [
      point({ steam_forum: 29, reddit: 10, reddit_comment: 8,  bluesky: 17, dtf: 0, total: 64  }),
      point({ steam_forum: 60, reddit: 40, reddit_comment: 40, bluesky: 15, dtf: 1, total: 156 }),
      point({ steam_forum: 55, reddit: 50, reddit_comment: 50, bluesky: 18, dtf: 1, total: 174 }),
      point({ steam_forum: 62, reddit: 55, reddit_comment: 55, bluesky: 20, dtf: 0, total: 192 }),
      point({ steam_forum: 60, reddit: 52, reddit_comment: 52, bluesky: 16, dtf: 1, total: 181 }),
      point({ steam_forum: 55, reddit: 48, reddit_comment: 48, bluesky: 12, dtf: 0, total: 163 }),
      point({ steam_forum: 51, reddit: 47, reddit_comment: 44, bluesky: 10, dtf: 0, total: 152 }),
    ]
    const out = aggregateVolumeBySource(days)
    expect(out.steam_forum).toBe(372)
    expect(out.reddit).toBe(302)
    expect(out.reddit_comment).toBe(297)
    expect(out.bluesky).toBe(108)
    expect(out.dtf).toBe(3)
    expect(out.steam_review).toBe(0)
    const total = Object.values(out).reduce((a, b) => a + b, 0)
    expect(total).toBe(1082)
  })
})
