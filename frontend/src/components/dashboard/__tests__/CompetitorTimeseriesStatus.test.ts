import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CompetitorTimeseriesStatus } from '../CompetitorTimeseriesChart'

// 2026-10-17: the Post Volume by Title card used to render nothing while
// loading and on error, so a slow request right after the daily ingest
// looked like a missing chart.
describe('Post Volume by Title loading and error states', () => {
  it('shows the card title and a loading placeholder while loading', () => {
    const html = renderToStaticMarkup(React.createElement(CompetitorTimeseriesStatus, {
      state: 'loading', onRetry: () => {},
    }))
    expect(html).toContain('Post Volume by Title')
    expect(html).toContain('Loading post volume')
    expect(html).toContain('role="status"')
  })
  it('shows an error with a retry button when the request failed', () => {
    const html = renderToStaticMarkup(React.createElement(CompetitorTimeseriesStatus, {
      state: 'error', onRetry: () => {},
    }))
    expect(html).toContain('Post volume could not be loaded.')
    expect(html).toContain('Retry')
    expect(html).toContain('role="alert"')
  })
})
