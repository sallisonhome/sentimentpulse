import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TopTopicsPanel from '../TopTopicsPanel'
import { TOPIC_PERIOD_MESSAGE, supportsTopics } from '../../../lib/topic-periods'

const fixture = vi.hoisted(() => ({ value: {} as any }))
vi.mock('../../../hooks/useDashboardTopics', () => ({
  useDashboardTopics: () => fixture.value,
}))

beforeEach(() => {
  fixture.value = { data: undefined, isLoading: true, error: null }
})

describe('Top Topics supported windows and partial rendering', () => {
  it.each(['quarterly', 'lifetime'] as const)('explains %s without analyzing', period => {
    const html = renderToStaticMarkup(React.createElement(TopTopicsPanel, { gameId: 24, period }))
    expect(html).toContain(TOPIC_PERIOD_MESSAGE)
    expect(html).not.toContain('Analyzing top topics')
    expect(html).not.toContain('role="tab"')
    expect(supportsTopics(period)).toBe(false)
  })
  it.each(['today', 'weekly', 'monthly'] as const)('supports %s', period => {
    expect(supportsTopics(period)).toBe(true)
  })
  it('does not hide completed negative topics while positive is pending', () => {
    fixture.value = {
      data: {
        status: 'refreshing',
        bucket_status: { positive: 'pending', negative: 'ready', neutral: 'ready' },
        positive: [], neutral: [],
        negative: [{ label: 'PC Performance', detail: 'Stuttering disrupts play.', volume: 6 }],
      }, isLoading: false, error: null,
    }
    const html = renderToStaticMarkup(React.createElement(TopTopicsPanel, { gameId: 24, period: 'monthly' }))
    expect(html).toContain('PC Performance')
    expect(html).toContain('Stuttering disrupts play.')
    expect(html).not.toContain('Analyzing top topics')
  })
  it('shows explicit error instead of permanent pending', () => {
    fixture.value = {
      data: { status: 'error', bucket_status: { negative: 'error' }, negative: [] },
      isLoading: false, error: null,
    }
    const html = renderToStaticMarkup(React.createElement(TopTopicsPanel, { gameId: 139, period: 'weekly' }))
    expect(html).toContain('Retrying automatically')
    expect(html).not.toContain('Analyzing top topics')
  })
})
