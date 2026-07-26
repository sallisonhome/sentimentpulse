import { useState } from 'react'
import { CalendarPlus, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  useTimelineEvents,
  useAddTimelineEvent,
  useDeleteTimelineEvent,
} from '../../hooks/useTimelineEvents'

/**
 * TimelineEventsEditor — the "+ event" widget for a single game inside its
 * settings card. Modeled after SignalPulse's PLS milestone add flow:
 *   - Compact list of existing events (date + name + × delete)
 *   - Inline "+ Add event" form (date picker + name input + Save)
 *
 * Rendered ONLY when the surrounding card knows this game is part of a
 * parent/competitor group. The parent's GameSettingsCard passes
 * `competitorCount` — the editor never appears on standalone Saber
 * titles with no competitors. This mirrors the server-side scope guard
 * in routers/timeline_events.py (which returns 409 for standalone
 * games) so the UI matches the API.
 *
 * Events created here appear as vertical ReferenceLine markers on the
 * Post Volume by Title chart, in the color of the game they belong to.
 */
export default function TimelineEventsEditor({
  gameId,
  gameName,
}: {
  gameId: number
  gameName: string
}) {
  const { data: events, isLoading } = useTimelineEvents(gameId)
  const addEvent = useAddTimelineEvent(gameId)
  const removeEvent = useDeleteTimelineEvent(gameId)

  const [showForm, setShowForm] = useState(false)
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const canSave = date.trim().length === 10 && name.trim().length > 0

  async function handleSave() {
    setError(null)
    if (!canSave) return
    try {
      await addEvent.mutateAsync({ event_date: date, name: name.trim() })
      setDate('')
      setName('')
      setShowForm(false)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(err.response?.data?.detail || err.message || 'Failed to add event')
    }
  }

  async function handleDelete(eventId: number) {
    try {
      await removeEvent.mutateAsync(eventId)
    } catch {
      /* no-op — the list will refresh from the invalidation regardless */
    }
  }

  return (
    <div className="rounded-md border border-border/60 bg-background/30 px-3 py-2 text-xs">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-medium uppercase tracking-wide text-muted-foreground">
          Timeline events
        </span>
        {!showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            <CalendarPlus className="h-3 w-3" />
            + Event
          </button>
        )}
      </div>

      {/* Existing events */}
      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : events && events.length > 0 ? (
        <ul className="mb-1 flex flex-col gap-0.5">
          {events.map(ev => (
            <li key={ev.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-foreground">
                <span className="mr-1.5 tabular-nums text-muted-foreground">
                  {ev.event_date}
                </span>
                {ev.name}
              </span>
              <button
                type="button"
                onClick={() => handleDelete(ev.id)}
                aria-label={`Delete event: ${ev.name}`}
                className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !showForm && (
          <p className="text-muted-foreground">
            No events yet. Add one to mark it on the Post Volume by Title chart for {gameName}.
          </p>
        )
      )}

      {/* Add form */}
      {showForm && (
        <div className="mt-1.5 flex flex-col gap-1.5 rounded-sm bg-background/60 px-2 py-2">
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
            <Label htmlFor={`event-date-${gameId}`} className="text-[11px]">
              Date
            </Label>
            <Input
              id={`event-date-${gameId}`}
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="h-7 text-xs"
            />
            <Label htmlFor={`event-name-${gameId}`} className="text-[11px]">
              What
            </Label>
            <Input
              id={`event-name-${gameId}`}
              type="text"
              placeholder="e.g. BTS Trailer, PSN release, dev livestream…"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={120}
              className="h-7 text-xs"
            />
          </div>
          {error && (
            <p className="text-[11px] text-destructive">{error}</p>
          )}
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[11px]"
              onClick={() => {
                setShowForm(false)
                setDate('')
                setName('')
                setError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-6 text-[11px]"
              disabled={!canSave || addEvent.isPending}
              onClick={handleSave}
            >
              {addEvent.isPending ? 'Saving…' : 'Add event'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
