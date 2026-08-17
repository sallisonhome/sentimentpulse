/**
 * Aggregation logic behind PostsBySourceCard.
 *
 * v0.2 (2026-08-17): the aggregate now MUST match the "Total Posts" KPI
 * (which counts posts only, not Reddit comments). These tests lock that
 * contract in place: `.total` is the sum of the VolumePoint.total field,
 * `.bySource` covers post-level sources only, and `.redditComments` is
 * exposed separately for the context row.
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
  it('sums per-day rows across every post-level source', () => {
    const out = aggregateVolumeBySource([
      point({ steam_forum: 100, reddit: 50, bluesky: 10, total: 160 }),
      point({ steam_forum: 200, reddit: 60, bluesky: 20, total: 280 }),
    ])
    expect(out.bySource.steam_forum).toBe(300)
    expect(out.bySource.reddit).toBe(110)
    expect(out.bySource.bluesky).toBe(30)
    expect(out.bySource.dtf).toBe(0)
    expect(out.bySource.steam_review).toBe(0)
    expect(out.total).toBe(440)          // sum of VolumePoint.total across days
    expect(out.redditComments).toBe(0)
  })

  it('surfaces reddit_comment separately WITHOUT adding it to the total', () => {
    // This is the exact bug v0.2 fixes. Total must not include comments —
    // the backend's Total Posts KPI does not count them and the two must
    // agree or the card is misleading.
    const out = aggregateVolumeBySource([
      point({ steam_forum: 10, reddit: 20, reddit_comment: 500, bluesky: 5, total: 35 }),
    ])
    expect(out.total).toBe(35)                       // matches Total Posts KPI
    expect(out.redditComments).toBe(500)             // context row
    expect(out.bySource.reddit).toBe(20)             // Reddit row is posts only
    // Reddit comments must not appear inside bySource under any key.
    // (SourceKey is a compile-time union that no longer includes it, but
    // this runtime check catches a future regression that widens the union
    // without touching the aggregation.)
    expect(Object.keys(out.bySource)).not.toContain('reddit_comment')
  })

  it('treats missing optional fields (reddit_comment, dtf) as 0', () => {
    // Older backend responses may omit these — component and helper must
    // not throw or NaN.
    const legacy = {
      day: '2026-01-01', steam_review: 0, steam_forum: 10, reddit: 5, bluesky: 2, total: 17,
    } as VolumePoint
    const out = aggregateVolumeBySource([legacy])
    expect(out.total).toBe(17)
    expect(out.redditComments).toBe(0)
    expect(out.bySource.dtf).toBe(0)
    expect(out.bySource.steam_forum).toBe(10)
  })

  it('returns all-zero aggregate for an empty period', () => {
    const out = aggregateVolumeBySource([])
    expect(out.total).toBe(0)
    expect(out.redditComments).toBe(0)
    expect(out.bySource.steam_forum).toBe(0)
    expect(out.bySource.reddit).toBe(0)
    expect(out.bySource.bluesky).toBe(0)
    expect(out.bySource.dtf).toBe(0)
    expect(out.bySource.steam_review).toBe(0)
  })

  it('reconciles with the real Hellraiser 90d sample (Total Posts = 3,270)', () => {
    // Numbers pulled 2026-08-17 from
    //   GET /api/games/21/dashboard?period=quarterly
    // sentiment_today.total = 3,270 (the "Total Posts" KPI)
    // sum of VolumePoint.total across 90 days = 3,270 (MUST match)
    // sum of all six source columns = 5,392 (the v0.1 bug — do NOT show this)
    // reddit_comment aggregate = 2,122 (surfaced as context row, not summed).
    //
    // Simulate one day carrying the full period aggregate:
    const days: VolumePoint[] = [
      point({
        steam_forum:    336,
        reddit:         2309,
        reddit_comment: 2122,
        bluesky:        618,
        dtf:            7,
        steam_review:   0,
        total:          3270,      // MATCHES sentiment_today.total
      }),
    ]
    const out = aggregateVolumeBySource(days)
    expect(out.total).toBe(3270)                     // ← matches Total Posts KPI
    expect(out.redditComments).toBe(2122)
    expect(out.bySource.reddit).toBe(2309)
    expect(out.bySource.steam_forum).toBe(336)
    expect(out.bySource.bluesky).toBe(618)
    expect(out.bySource.dtf).toBe(7)
    expect(out.bySource.steam_review).toBe(0)
    // Post-level source sum must NOT equal 5,392.
    const bySourceSum = Object.values(out.bySource).reduce((a, b) => a + b, 0)
    expect(bySourceSum).toBe(3270)                   // 336 + 2309 + 618 + 7 + 0
    expect(bySourceSum).not.toBe(5392)               // v0.1 regression guard
  })
})
