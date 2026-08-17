/**
 * NetSentimentChart period-window filter — regression tests.
 *
 * BUG (2026-08-17 v0.4): the chart intersected annotations against the
 * X-axis `date_label` strings (e.g. "Aug 17"), which have no year. A
 * Steam Sale PLS milestone from 2022-08-17 would render on the 90-day
 * view alongside a 2026-08-17 trend point because both formatted to the
 * same "Aug 17" label. User reported "many PLS tags associated with
 * Steam sales in other years 202x-2025 when nothing should be more than
 * 90 days in the past".
 *
 * Fix: intersect on the raw ISO YYYY-MM-DD dates via
 * `buildVisibleIsoDateSet` + `filterAnnotationsToWindow`.
 *
 * These tests exercise the pure helpers directly so they don't need a
 * DOM. If either helper is weakened to a display string in the future,
 * these tests fail.
 */
import { describe, it, expect } from 'vitest'
import {
  buildVisibleIsoDateSet,
  filterAnnotationsToWindow,
} from '../NetSentimentChart'

// A 90-day WWZ window that ENDS today. Use fixed dates so the test is
// deterministic year-over-year. Include Aug 17 2026 as the anchor day so
// the cross-year regression is precise: a 2022-08-17 milestone must be
// dropped even though it shares the "Aug 17" display label.
const WINDOW_ISO_DATES = [
  '2026-05-20', '2026-06-15', '2026-07-04',
  '2026-08-11', '2026-08-15', '2026-08-16', '2026-08-17',
]

const trendPoints = WINDOW_ISO_DATES.map(d => ({ summary_date: d }))

describe('buildVisibleIsoDateSet', () => {
  it('returns a set of the full ISO dates, not day-month labels', () => {
    const s = buildVisibleIsoDateSet(trendPoints)
    // The set must contain full YYYY-MM-DD strings so cross-year
    // annotation dates cannot collide with in-window trend points.
    expect(s.has('2026-08-17')).toBe(true)
    expect(s.has('Aug 17')).toBe(false)
    expect(s.size).toBe(WINDOW_ISO_DATES.length)
  })
})

describe('filterAnnotationsToWindow (PLS / user annotations)', () => {
  it('DROPS a same-month-day milestone from an out-of-window year', () => {
    // Regression case: Steam Summer Sale 2022-08-17 must not render on
    // the 90-day window that ends 2026-08-17. In v0.3 this rendered
    // because "Aug 17" matched "Aug 17".
    const s = buildVisibleIsoDateSet(trendPoints)
    const annotations = [
      { id: 'pls-1', event_date: '2022-08-17', name: 'Steam Summer Sale 2022' },
      { id: 'pls-2', event_date: '2023-08-17', name: 'Steam Summer Sale 2023' },
      { id: 'pls-3', event_date: '2024-08-17', name: 'Steam Summer Sale 2024' },
      { id: 'pls-4', event_date: '2025-08-17', name: 'Steam Summer Sale 2025' },
    ]
    const filtered = filterAnnotationsToWindow(annotations, s)
    expect(filtered).toEqual([])
  })

  it('KEEPS an in-window milestone whose day-month coincides with an out-of-window year', () => {
    const s = buildVisibleIsoDateSet(trendPoints)
    const annotations = [
      { id: 'pls-1', event_date: '2022-08-17', name: 'Steam Summer Sale 2022' }, // drop
      { id: 'pls-2', event_date: '2026-08-17', name: 'Steam Autumn Sale 2026' }, // keep
      { id: 'pls-3', event_date: '2026-08-11', name: 'Publisher Sale 2026'  },   // keep
      { id: 'pls-4', event_date: '2025-08-11', name: 'Publisher Sale 2025'  },   // drop
    ]
    const filtered = filterAnnotationsToWindow(annotations, s)
    expect(filtered.map(a => a.id)).toEqual(['pls-2', 'pls-3'])
  })

  it('DROPS a milestone that lands between visible days (gap in window)', () => {
    // 2026-05-21 is a legit "recent" date but not on the window's day
    // set (which is a sparse projection of only days with trend data).
    // The annotation should be dropped so no marker points at a day the
    // X-axis doesn't have.
    const s = buildVisibleIsoDateSet(trendPoints)
    const annotations = [
      { id: 'pls-1', event_date: '2026-05-21', name: 'Off-window recent day' },
    ]
    expect(filterAnnotationsToWindow(annotations, s)).toEqual([])
  })

  it('is safe for null / undefined annotation lists (empty [] fallback)', () => {
    const s = buildVisibleIsoDateSet(trendPoints)
    expect(filterAnnotationsToWindow(null, s)).toEqual([])
    expect(filterAnnotationsToWindow(undefined, s)).toEqual([])
  })

  it('preserves the input ordering (chronology is set upstream in usePlsMilestones)', () => {
    const s = buildVisibleIsoDateSet(trendPoints)
    const annotations = [
      { id: 'pls-A', event_date: '2026-08-17', name: 'A' },
      { id: 'pls-B', event_date: '2026-05-20', name: 'B' },
      { id: 'pls-C', event_date: '2026-06-15', name: 'C' },
    ]
    // Filter must not resort — chronology is decided by the hook.
    expect(filterAnnotationsToWindow(annotations, s).map(a => a.id))
      .toEqual(['pls-A', 'pls-B', 'pls-C'])
  })
})

describe('90-day window contract (integration-shape)', () => {
  it('a real 4-year PLS history reduces to only the current-window subset', () => {
    // Mirrors the exact WWZ scenario from the user report: a game with
    // recurring annual Steam Sale milestones going back to 2022 shows
    // ONLY the 2026 entries on the 90-day window.
    const s = buildVisibleIsoDateSet(trendPoints)
    const fourYearsOfSales = [
      // 2022
      { id: '1',  event_date: '2022-05-20', name: 'Steam Sale 2022 Q2' },
      { id: '2',  event_date: '2022-08-17', name: 'Steam Sale 2022 Q3' },
      // 2023
      { id: '3',  event_date: '2023-05-20', name: 'Steam Sale 2023 Q2' },
      { id: '4',  event_date: '2023-08-17', name: 'Steam Sale 2023 Q3' },
      // 2024
      { id: '5',  event_date: '2024-05-20', name: 'Steam Sale 2024 Q2' },
      { id: '6',  event_date: '2024-08-17', name: 'Steam Sale 2024 Q3' },
      // 2025
      { id: '7',  event_date: '2025-05-20', name: 'Steam Sale 2025 Q2' },
      { id: '8',  event_date: '2025-08-17', name: 'Steam Sale 2025 Q3' },
      // 2026 (in window)
      { id: '9',  event_date: '2026-05-20', name: 'Steam Sale 2026 Q2' },
      { id: '10', event_date: '2026-08-17', name: 'Steam Sale 2026 Q3' },
    ]
    const filtered = filterAnnotationsToWindow(fourYearsOfSales, s)
    expect(filtered.map(a => a.id)).toEqual(['9', '10'])
    expect(filtered.every(a => a.event_date.startsWith('2026-'))).toBe(true)
  })
})
