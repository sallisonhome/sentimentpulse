import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SourceHealthRow, circuitNotice, degradedSources, retryNotice } from './SettingsPage'
import type { IngestStatus } from '../types'

describe('source completeness is visible independently of fetched volume', () => {
  it('renders partial and retained fetched count, never green ok', () => {
    const html = renderToStaticMarkup(React.createElement(SourceHealthRow, {
      label: 'Reddit', health: 'partial', fetched: 25153,
    }))
    expect(html).toContain('partial (some reads incomplete)')
    expect(html).toContain('25,153')
    expect(html).not.toContain('text-green')
  })
  it('flags partial Reddit and YouTube in the source banner', () => {
    const flags = degradedSources({
      reddit_health: 'partial', youtube_health: 'partial', bluesky_health: 'ok',
    } as IngestStatus)
    expect(flags).toEqual(['Reddit (partial)', 'YouTube (partial)'])
  })
  it('keeps ordinary successful sources green', () => {
    const html = renderToStaticMarkup(React.createElement(SourceHealthRow, {
      label: 'Reddit', health: 'ok', fetched: 123,
    }))
    expect(html).toContain('text-green')
    expect(html).not.toContain('incomplete')
  })
})

describe('scheduled retry visibility (2026-10-06)', () => {
  it('names the attempt and the previous failure while a retry runs', () => {
    const msg = retryNotice({
      is_running: true, attempt: 2, max_attempts: 4,
      prior_attempt_status: 'error',
      prior_attempt_error: 'Fatal ingestion error: (sqlite3.OperationalError) database is locked',
    } as IngestStatus)
    expect(msg).toBe('Retrying: attempt 2 of 4. Previous attempt: error ' +
      '(Fatal ingestion error: (sqlite3.OperationalError) database is locked)')
  })
  it('stays quiet for a first attempt or an idle service', () => {
    expect(retryNotice({ is_running: true, attempt: 1 } as IngestStatus)).toBeNull()
    expect(retryNotice({ is_running: false, attempt: 3 } as IngestStatus)).toBeNull()
    expect(retryNotice({ is_running: true } as IngestStatus)).toBeNull()
  })
})

describe('Reddit provider circuit breaker visibility (2026-10-10)', () => {
  it('names the provider, the skipped count and the cursor promise while running', () => {
    const msg = circuitNotice({
      is_running: true,
      reddit_circuit: {
        arctic_shift: {
          state: 'open', trips: 1, short_circuited: 1234, consecutive_failures: 5,
          opened_at: '2026-10-10T09:51:00+00:00', last_error: 'ReadTimeout',
        },
      },
    } as unknown as IngestStatus)
    expect(msg).toBe('Reddit provider outage during this run: Arctic Shift unreachable ' +
      '(1,234 request(s) skipped, last error ReadTimeout). ' +
      'Cursors were not advanced; the next run retries.')
  })
  it('reports a mid-run recovery after the run finished', () => {
    const msg = circuitNotice({
      is_running: false,
      reddit_circuit: {
        arctic_shift: {
          state: 'closed', trips: 1, short_circuited: 12, consecutive_failures: 0,
          opened_at: '2026-10-10T09:51:00+00:00', last_error: 'HTTP 522',
        },
      },
    } as unknown as IngestStatus)
    expect(msg).toContain('during the last run: Arctic Shift recovered (12 request(s) skipped')
  })
  it('stays quiet when no breaker tripped or the field is absent', () => {
    expect(circuitNotice({ is_running: true, reddit_circuit: {} } as unknown as IngestStatus)).toBeNull()
    expect(circuitNotice({ is_running: false } as IngestStatus)).toBeNull()
  })
})
