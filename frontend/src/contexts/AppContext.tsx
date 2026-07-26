import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Period } from '../types'

interface AppContextValue {
  selectedGameId: number | null
  setSelectedGameId: (id: number | null) => void
  period: Period
  setPeriod: (p: Period) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  // Sync selectedGameId with the URL query param `?game=<id>` so:
  //   1. The browser back button correctly returns to the previously
  //      selected game (2026-07-26 fix). Prior version stored selection
  //      only in React state so browser back skipped over game switches
  //      and jumped to whatever page preceded the current one
  //      (typically /settings, since that's where competitors are added).
  //   2. Deep links like /?game=138 land on that game's dashboard on a
  //      fresh reload without a picker‑open step.
  const [searchParams, setSearchParams] = useSearchParams()
  const gameParam = searchParams.get('game')
  const urlGameId = gameParam ? Number(gameParam) : null
  const [selectedGameId, setSelectedGameIdState] = useState<number | null>(
    Number.isFinite(urlGameId as number) ? urlGameId : null,
  )

  // When the URL param changes (browser back/forward, external navigation),
  // update the state to match.
  useEffect(() => {
    const parsed = gameParam ? Number(gameParam) : null
    if (parsed !== selectedGameId) {
      setSelectedGameIdState(Number.isFinite(parsed as number) ? parsed : null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameParam])

  const setSelectedGameId = useCallback((id: number | null) => {
    setSelectedGameIdState(id)
    // Update the URL without recording a redundant history entry when
    // the game didn't actually change (handled by useSearchParams's own
    // no-op guard when the same string is passed).
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (id == null) next.delete('game')
      else next.set('game', String(id))
      return next
    })
  }, [setSearchParams])

  const [period, setPeriod] = useState<Period>('today')

  // Persist period selection across page reloads
  useEffect(() => {
    const valid: Period[] = ['today', 'weekly', 'monthly', 'quarterly', 'lifetime']
    const stored = localStorage.getItem('sp_period') as Period | null
    if (stored && valid.includes(stored)) setPeriod(stored)
  }, [])

  const handleSetPeriod = (p: Period) => {
    setPeriod(p)
    localStorage.setItem('sp_period', p)
  }

  return (
    <AppContext.Provider value={{ selectedGameId, setSelectedGameId, period, setPeriod: handleSetPeriod }}>
      {children}
    </AppContext.Provider>
  )
}

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useAppContext must be used within AppProvider')
  return ctx
}
