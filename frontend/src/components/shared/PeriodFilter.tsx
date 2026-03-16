import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import type { Period } from '../../types'

const PERIODS: { value: Period; label: string }[] = [
  { value: 'weekly',    label: '7d'  },
  { value: 'monthly',   label: '30d' },
  { value: 'quarterly', label: '90d' },
  { value: 'lifetime',  label: 'All' },
]

interface PeriodFilterProps {
  value: Period
  onChange: (p: Period) => void
}

export default function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  return (
    <Tabs value={value} onValueChange={v => onChange(v as Period)}>
      <TabsList>
        {PERIODS.map(p => (
          <TabsTrigger key={p.value} value={p.value}>
            {p.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
