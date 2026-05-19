import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import type { MonthlySummary } from '../../types'

interface PeriodSelectorProps {
  months: MonthlySummary[]
  selectedKey: string           // e.g. "2024-4"
  onChange: (key: string) => void
}

/**
 * Segmented control listing available calendar months, newest first.
 *
 * Each item shows the month_label (e.g. "April 2026").
 * Key format: `${period_year}-${period_month}` for predictable identity.
 */
export function monthKey(year: number, month: number): string {
  return `${year}-${month}`
}

export default function PeriodSelector({
  months,
  selectedKey,
  onChange,
}: PeriodSelectorProps) {
  if (!months.length) return null

  return (
    <Tabs value={selectedKey} onValueChange={onChange}>
      <TabsList className="flex flex-wrap h-auto gap-1 bg-muted p-1">
        {months.map(m => {
          const key = monthKey(m.period_year, m.period_month)
          return (
            <TabsTrigger
              key={key}
              value={key}
              className="whitespace-nowrap text-xs sm:text-sm"
            >
              {m.month_label}
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
