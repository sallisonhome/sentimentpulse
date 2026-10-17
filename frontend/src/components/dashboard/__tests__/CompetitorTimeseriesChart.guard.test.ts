import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 2026-10-17 regression guard. The real chart component must render a
// visible card while its data loads and when the request fails, for any
// title that has competitors. It used to `return null` in both cases, so a
// slow request right after the daily ingest made the chart vanish.

const state: { ts: any; competitors: any } = { ts: {}, competitors: {} }

vi.mock('../../../hooks/useCompetitors', () => ({
  useCompetitorTimeseries: () => state.ts,
  useCompetitors: () => state.competitors,
}))
vi.mock('../../../hooks/usePlsMilestones', () => ({ usePlsMilestones: () => ({ data: [] }) }))
vi.mock('../../../contexts/AppContext', () => ({ useAppContext: () => ({ setSelectedGameId: () => {} }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {}, useLocation: () => ({ pathname: '/' }) }))

import CompetitorTimeseriesChart from '../CompetitorTimeseriesChart'

const render = () => renderToStaticMarkup(
  React.createElement(CompetitorTimeseriesChart, { parentId: 23, period: 'weekly' }))
const refetch = () => Promise.resolve()

describe('Post Volume by Title never silently disappears', () => {
  beforeEach(() => {
    state.competitors = { data: [{ id: 145 }] }
  })
  it('renders the loading placeholder while the first request is pending', () => {
    state.ts = { data: undefined, isLoading: true, isFetching: true, isError: false, refetch }
    const html = render()
    expect(html).toContain('Post Volume by Title')
    expect(html).toContain('role="status"')
  })
  it('renders the error card with Retry when the request failed', () => {
    state.ts = { data: undefined, isLoading: false, isFetching: false, isError: true, refetch }
    const html = render()
    expect(html).toContain('Post volume could not be loaded.')
    expect(html).toContain('Retry')
  })
  it('stays hidden only for titles with no competitors', () => {
    state.competitors = { data: [] }
    state.ts = { data: undefined, isLoading: true, isFetching: true, isError: false, refetch }
    expect(render()).toBe('')
    state.ts = { data: { games: [{ game_id: 23, is_parent: true }], timeseries: [], events: [] },
      isLoading: false, isFetching: false, isError: false, refetch }
    expect(render()).toBe('')
  })
})
