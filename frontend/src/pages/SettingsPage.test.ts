import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SourceHealthRow, degradedSources } from './SettingsPage'
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
