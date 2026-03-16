import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import type { Period } from '../types'

interface AppContextValue {
  selectedGameId: number | null
  setSelectedGameId: (id: number | null) => void
  period: Period
  setPeriod: (p: Period) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null)
  const [period, setPeriod] = useState<Period>('weekly')

  // Persist period selection across page reloads
  useEffect(() => {
    const stored = localStorage.getItem('sp_period') as Period | null
    if (stored) setPeriod(stored)
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
