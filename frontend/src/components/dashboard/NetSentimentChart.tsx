/**
 * NetSentimentChart — daily net sentiment line with overlay annotations.
 *
 * v2 (2026-08-17): now merges two annotation streams:
 *   1. User-authored TimelineEvents (existing, unchanged)
 *   2. PLS milestones from SignalPulse (new)
 *
 * PLS milestones are matched to the current game by Steam App ID and only
 * rendered when the game has a corresponding SignalPulse product. Because
 * the marker density can get noisy on titles with many trailers/press
 * beats, there's a per-user localStorage toggle in the header.
 *
 * Period filtering: both annotation streams filter against the visible
 * X-axis labels, so the selected period selector (Today / 7d / 30d / 90d /
 * All) already controls what's shown — no per-event date math needed.
 */
import { useState } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  type TooltipProps,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import type { NetSentimentPoint } from '../../types'
import { useAppContext } from '../../contexts/AppContext'
import { useTimelineEvents } from '../../hooks/useTimelineEvents'
import { useGameDetail } from '../../hooks/useGames'
import {
  usePlsMilestones,
  metaFor as plsMetaFor,
  type PlsAnnotation,
} from '../../hooks/usePlsMilestones'

interface NetSentimentChartProps {
  data: NetSentimentPoint[]
}

// ── Toggle persistence ──────────────────────────────────────────────────
// Store the PLS-visible preference in localStorage so it survives page
// reloads and stays consistent across game switches. Wrapped in
// try/catch because storage can be disabled (private-browsing edge case).
const PLS_TOGGLE_KEY = 'sp.chart.showPlsMilestones'
function loadPlsToggle(): boolean {
  try {
    const v = localStorage.getItem(PLS_TOGGLE_KEY)
    // Default ON — user asked for the milestones by default. They can
    // hide them per-browser without needing to opt back in each session.
    return v == null ? true : v === '1'
  } catch { return true }
}
function savePlsToggle(on: boolean) {
  try { localStorage.setItem(PLS_TOGGLE_KEY, on ? '1' : '0') } catch { /* no-op */ }
}

// ── Unified in-window annotation shape ─────────────────────────────────
// Both TimelineEvents and PlsAnnotations are collapsed into this shape
// before we render markers and the compact list. `dot_color` is what the
// marker uses; PLS uses category color, user events keep the historical
// amber (#f59e0b) so nothing regresses for existing users.
export interface WindowAnnotation {
  key:        string
  date_label: string
  event_date: string
  name:       string
  dot_color:  string
  category_label: string
  source:     'user' | 'pls'
}

export const USER_EVENT_COLOR = '#f59e0b'

// ── Pure filter helper (exported for tests) ─────────────────────────────
//
// Take a list of trend points (whose `summary_date` is the ISO YYYY-MM-DD
// of the days actually rendered on the X axis) and return the set of ISO
// dates that annotations may attach to. This is the single source of
// truth for "is this event in the visible window", and it must NEVER be
// weakened to a display-format string — doing so re-introduces the
// cross-year collision bug (2026-08-17 v0.4).
export function buildVisibleIsoDateSet(
  data: { summary_date: string }[],
): Set<string> {
  return new Set(data.map(d => d.summary_date))
}

// Filter an annotation list down to the subset whose `event_date` (also
// ISO YYYY-MM-DD) falls within the visible-date set. Preserves ordering.
export function filterAnnotationsToWindow<
  T extends { event_date: string },
>(annotations: T[] | null | undefined, visibleIsoDates: Set<string>): T[] {
  if (!annotations) return []
  return annotations.filter(a => visibleIsoDates.has(a.event_date))
}

export default function NetSentimentChart({ data }: NetSentimentChartProps) {
  const { selectedGameId } = useAppContext()

  // User-authored timeline events (unchanged from v1).
  const { data: events } = useTimelineEvents(selectedGameId)

  // PLS milestones: need the game's steam_app_id to look up its
  // SignalPulse product, which useGameDetail supplies.
  const { data: gameDetail } = useGameDetail(selectedGameId)
  const { data: plsRaw } = usePlsMilestones(gameDetail?.steam_app_id)
  const [showPls, setShowPls] = useState<boolean>(loadPlsToggle)

  const formatted = data.map(d => ({
    ...d,
    date_label: format(parseISO(d.summary_date), 'MMM d'),
    net_pct: parseFloat((d.net_sentiment * 100).toFixed(1)),
  }))

  // Only render markers on days that actually exist on the X axis. The
  // trend data already reflects the selected period (today / 7d / 30d /
  // 90d / all), so intersecting with its dates gives us automatic period
  // filtering for BOTH annotation streams — no separate math.
  //
  // BUG FIX (2026-08-17 v0.4): We previously intersected on `date_label`
  // (e.g. "Aug 17"), which has NO YEAR. That meant a Steam Sale milestone
  // from 2022-08-17 collided with a data point on 2026-08-17 and rendered
  // on the 90-day view even though it was 4 years out of window. User
  // reported "many PLS tags associated with Steam sales in other years
  // 202x-2025 when nothing should be more than 90 days in the past".
  // Fix: intersect on the ISO YYYY-MM-DD `summary_date` / `event_date`
  // instead. `date_label` is still used AFTER the filter to position the
  // marker on Recharts' categorical X-axis (see ReferenceLine below).
  //
  // The `buildVisibleIsoDateSet` / `filterAnnotationsToWindow` helpers
  // are exported so tests can lock in this contract without needing to
  // render the whole chart.
  const visibleIsoDates = buildVisibleIsoDateSet(data)

  const userAnnotations: WindowAnnotation[] =
    filterAnnotationsToWindow(events, visibleIsoDates).map(ev => ({
      key:            `user-${ev.id}`,
      event_date:     ev.event_date,
      date_label:     format(parseISO(ev.event_date), 'MMM d'),
      name:           ev.name,
      dot_color:      USER_EVENT_COLOR,
      category_label: 'Timeline',
      source:         'user' as const,
    }))

  const plsAnnotations: WindowAnnotation[] = !showPls || !plsRaw
    ? []
    : filterAnnotationsToWindow(plsRaw, visibleIsoDates).map((m: PlsAnnotation) => {
        const meta = plsMetaFor(m.category)
        return {
          key:            m.id,
          event_date:     m.event_date,
          date_label:     format(parseISO(m.event_date), 'MMM d'),
          name:           m.name + (m.is_planned ? ' (planned)' : ''),
          dot_color:      meta.color,
          category_label: meta.label,
          source:         'pls' as const,
        }
      })

  const inWindowEvents: WindowAnnotation[] = [
    ...userAnnotations,
    ...plsAnnotations,
  ].sort((a, b) => a.event_date.localeCompare(b.event_date))

  // Only offer the PLS toggle when the game actually has any PLS data —
  // hiding the switch prevents users from wondering why the toggle
  // doesn't do anything on games without a SignalPulse product.
  const hasPlsData = (plsRaw?.length ?? 0) > 0

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between space-y-0 pb-2">
        <CardTitle className="text-base">Net Sentiment Trend</CardTitle>
        {hasPlsData && (
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
            data-testid="pls-milestones-toggle"
          >
            <input
              type="checkbox"
              className="h-3 w-3 cursor-pointer accent-current"
              checked={showPls}
              onChange={e => {
                setShowPls(e.target.checked)
                savePlsToggle(e.target.checked)
              }}
            />
            <span>PLS milestones</span>
          </label>
        )}
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={formatted} margin={{ top: 4, right: 16, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="date_label"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={v => `${v}%`}
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="4 4" />
            <Tooltip content={<NetSentimentTooltip events={inWindowEvents} />} />
            <Line
              type="monotone"
              dataKey="net_pct"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            {/* Event markers — dashed vertical lines colored by source
                (user events keep the historical amber; PLS milestones use
                their category color from usePlsMilestones.PLS_CATEGORY_META). */}
            {inWindowEvents.map(ev => (
              <ReferenceLine
                key={ev.key}
                x={ev.date_label}
                stroke={ev.dot_color}
                strokeDasharray="4 3"
                strokeWidth={1.5}
                strokeOpacity={0.85}
                ifOverflow="visible"
                isFront
                label={{ value: '●', position: 'top', fill: ev.dot_color, fontSize: 10 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>

        {/* Compact event list under the chart. Combines both sources with
            a per-row color dot so users can see at a glance which is a
            user event vs a PLS milestone. Only shown when there is at
            least one in-window annotation, so most dashboards stay
            uncluttered. */}
        {inWindowEvents.length > 0 && (
          <div className="mt-3 border-t border-border/60 pt-2">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Timeline events in this window
            </p>
            <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-2">
              {inWindowEvents.map(ev => (
                <li
                  key={ev.key}
                  className="flex items-baseline gap-1.5"
                  data-testid={`chart-event-${ev.key}`}
                >
                  <span aria-hidden style={{ color: ev.dot_color }}>●</span>
                  <span className="tabular-nums text-muted-foreground">{ev.event_date}</span>
                  <span className="truncate" title={ev.name}>{ev.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function NetSentimentTooltip({
  active,
  payload,
  events,
}: TooltipProps<number, string> & { events: WindowAnnotation[] }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as NetSentimentPoint & { date_label: string; net_pct: number }
  // Any event whose date matches the currently-hovered X label surfaces
  // in the tooltip so users see WHY the sentiment moved on that day.
  const dayEvents = events.filter(ev => ev.date_label === d.date_label)
  return (
    <div className="rounded-md border bg-popover p-3 text-xs shadow-md">
      <p className="font-semibold mb-1">{d.date_label}</p>
      <p>Net sentiment: <span className={d.net_pct >= 0 ? 'text-green-600' : 'text-red-600'}>{d.net_pct >= 0 ? '+' : ''}{d.net_pct}%</span></p>
      <p className="text-muted-foreground mt-1">
        +{d.positive_count} / -{d.negative_count} / ~{d.neutral_count} &nbsp;({d.total} total)
      </p>
      {dayEvents.length > 0 && (
        <div className="mt-1.5 border-t border-border/60 pt-1.5 space-y-0.5">
          {dayEvents.map(ev => (
            <p key={ev.key} className="flex items-baseline gap-1">
              <span aria-hidden style={{ color: ev.dot_color }}>●</span>
              <span className="font-medium">{ev.name}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {ev.category_label}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
