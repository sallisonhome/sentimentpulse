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

/**
 * v0021 (2026-08-19) exported for direct unit-testing.
 *
 * Decide whether the URL's game= query param should override the current
 * in-memory selectedGameId. Rules:
 *   * If the URL param is a valid finite number DIFFERENT from current
 *     state — return that number (deep-link / browser back/forward).
 *   * If the URL has NO param, or an invalid one — keep current state.
 *     This is the safety net for the Dashboard→Summary bug where a bare
 *     NavLink dropped the query string and used to null out the game.
 *   * If the URL param matches current state — no-op (return current).
 */
export function resolveUrlGameOverride(
  gameParam: string | null,
  current: number | null,
): number | null {
  const parsed = gameParam != null && gameParam !== '' ? Number(gameParam) : null
  if (parsed != null && Number.isFinite(parsed) && parsed !== current) {
    return parsed
  }
  return current
}

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
  //
  // v0021 (2026-08-19) safety net: only sync URL → state when the URL
  // carries a VALID game id. If the URL loses ?game=<id> for any reason
  // (a stray relative navigation, a redirect, a third-party link into a
  // page without the param), do NOT clear state — that used to make
  // TopBar's fallback silently reset the user to the FIRST title in the
  // dropdown. The Sidebar was fixed to always preserve the query string,
  // but this guard makes the reset impossible even if a new nav path
  // regresses.
  //
  // Deep links still work: fresh page loads read from the URL param
  // via the useState initializer above, before this effect ever runs.
  useEffect(() => {
    const next = resolveUrlGameOverride(gameParam, selectedGameId)
    if (next !== selectedGameId) {
      setSelectedGameIdState(next)
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
