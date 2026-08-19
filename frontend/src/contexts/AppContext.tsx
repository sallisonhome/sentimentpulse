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

// v0022 (2026-08-19): the ONLY things that change the active title are
//   (a) an explicit dropdown selection from the top-bar picker, or
//   (b) clicking a competitor legend entry on the parent's Post Volume
//       by Title chart.
// Everything else — side-nav clicks, hard reloads, deep links, browser
// back/forward, external redirects, hash changes — leaves the title
// alone.  Both (a) and (b) route through the same setSelectedGameId
// setter defined below, which persists to localStorage.  Nothing else
// mutates the title state.
//
// Prior versions (v0021 and earlier) tried to keep the title in the
// URL query string, which was fragile: any nav that dropped ?game=<id>
// (external home link, hard reload, a route change that forgot to
// preserve search) reset selectedGameId to null, which then fired
// TopBar's auto-select-latest-game fallback and snapped every user
// to the newest title.  That kept happening no matter how many code
// paths we patched.
//
// localStorage is the right primitive: bound to one browser, persists
// across everything, cleared by the user via devtools or by picking a
// different title from the dropdown.
const SELECTED_GAME_KEY = 'sp.selectedGameId'

function readStoredGameId(): number | null {
  try {
    const v = localStorage.getItem(SELECTED_GAME_KEY)
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function writeStoredGameId(id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(SELECTED_GAME_KEY)
    else localStorage.setItem(SELECTED_GAME_KEY, String(id))
  } catch { /* ignore — private mode / storage disabled */ }
}

export function AppProvider({ children }: { children: ReactNode }) {
  // Initial load precedence (highest wins):
  //   1. localStorage — the user's persisted dropdown selection.
  //   2. ?game=<id> in the URL — supports deep links / bookmarks.
  //   3. null — TopBar's auto-select-latest fallback will pick a default.
  //
  // Once mounted, ONLY step 1 (dropdown) can change the value.  The URL
  // param is NOT observed on subsequent navigations, so a side-nav
  // click that drops ?game= cannot reset the title.  This is
  // intentional per the 2026-08-19 requirement:
  //   "never switch to other titles unless the user selects them from
  //    the drop down".
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedGameId, setSelectedGameIdState] = useState<number | null>(() => {
    const stored = readStoredGameId()
    if (stored != null) return stored
    const gp = searchParams.get('game')
    const parsed = gp ? Number(gp) : null
    return Number.isFinite(parsed as number) ? parsed : null
  })

  const setSelectedGameId = useCallback((id: number | null) => {
    // The dropdown handler is the ONLY caller that should ever pass a
    // new id.  Persist to localStorage so the choice survives reloads
    // and external navigation, and also mirror to the URL query param
    // for deep-linking and share-a-link scenarios.  URL is one-way
    // (state → URL); we do NOT read URL → state after mount, so a
    // stripped-out ?game= cannot clear state.
    setSelectedGameIdState(id)
    writeStoredGameId(id)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (id == null) next.delete('game')
      else next.set('game', String(id))
      return next
    }, { replace: true })
    // { replace: true } so the dropdown selection doesn't stack a new
    // history entry — keeps browser back/forward tied to route changes
    // instead of title switches (which used to cause a back-button UX
    // where users had to press back N times to escape N title changes).
  }, [setSearchParams])

  // Cross-tab sync: if the user changes the title in a second tab,
  // reflect it here too.  Storage events don't fire in the tab that
  // did the write, so this is safe from feedback loops.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== SELECTED_GAME_KEY) return
      const stored = readStoredGameId()
      setSelectedGameIdState(stored)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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
