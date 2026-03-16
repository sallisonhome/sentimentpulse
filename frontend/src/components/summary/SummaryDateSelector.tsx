import { format, parseISO } from 'date-fns'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { formatDelta } from '../../lib/utils'
import type { DailySummary } from '../../types'

interface SummaryDateSelectorProps {
  summaries: DailySummary[]
  selectedId: number
  onChange: (id: number) => void
}

export default function SummaryDateSelector({ summaries, selectedId, onChange }: SummaryDateSelectorProps) {
  return (
    <Select value={String(selectedId)} onValueChange={v => onChange(Number(v))}>
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Select date…" />
      </SelectTrigger>
      <SelectContent>
        {summaries.map((s, idx) => {
          const label = format(parseISO(s.summary_date), 'EEE, MMM d yyyy')
          const delta = formatDelta(s.sentiment_trend_delta)
          const isLatest = idx === 0
          return (
            <SelectItem key={s.id} value={String(s.id)}>
              <span className="flex items-center gap-2">
                {label}
                {isLatest && <span className="text-xs text-muted-foreground">(latest)</span>}
                <span className={`ml-auto text-xs tabular-nums ${
                  s.sentiment_trend_delta == null ? 'text-muted-foreground'
                  : s.sentiment_trend_delta >= 0   ? 'text-green-600'
                  : 'text-red-600'
                }`}>{delta}</span>
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
