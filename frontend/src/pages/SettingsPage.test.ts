import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SourceHealthRow, degradedSources, retryNotice } from './SettingsPage'
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
