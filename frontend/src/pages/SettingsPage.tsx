import { useState } from 'react'
import { useAllGames } from '../hooks/useGames'
import { usePublisher } from '../hooks/usePublisher'
import { useIngestStatus, useTriggerIngest } from '../hooks/useIngest'
import {
  useAddDigestRecipient,
  useDeleteDigestRecipient,
  useDigestRecipients,
  useToggleDigestRecipient,
} from '../hooks/useDigestRecipients'
import GameSettingsCard from '../components/settings/GameSettingsCard'
import EmptyState from '../components/shared/EmptyState'
import SkeletonCard from '../components/shared/SkeletonCard'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Switch } from '../components/ui/switch'
import { Separator } from '../components/ui/separator'
import { relativeTime } from '../lib/utils'
import { RefreshCw, CheckCircle, XCircle, AlertTriangle, EyeOff, KeyRound, Mail, Trash2, ExternalLink } from 'lucide-react'
import type { IngestStatus } from '../types'

// Render a single source's health line.  Covers ok / degraded / failed /
// silent / skipped — values produced by the backend per-source verdict
// machinery in services/ingestor.py.
function SourceHealthRow(props: {
  label: string
  health?: string
  fetched?: number
  retries?: number
}) {
  const { label, health, fetched = 0, retries = 0 } = props
  if (!health || health === 'unknown') return null
  const retryWord = retries === 1 ? 'retry' : 'retries'
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 pt-1">
      <span className="font-medium">{label}:</span>
      {health === 'ok' && (
        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
          <CheckCircle className="h-3 w-3" /> ok
        </span>
      )}
      {health === 'degraded' && (
        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" /> degraded (recovered after {retries} {retryWord})
        </span>
      )}
      {health === 'failed' && (
        <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
          <XCircle className="h-3 w-3" /> failed (0 posts after {retries} {retryWord})
        </span>
      )}
      {health === 'silent' && (
        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
          <EyeOff className="h-3 w-3" /> silent (≥90% drop vs prior‑7d baseline)
        </span>
      )}
      {health === 'auth_broken' && (
        <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
          <KeyRound className="h-3 w-3" /> auth broken (rotate app password / re-auth account)
        </span>
      )}
      {health === 'skipped' && (
        <span className="text-muted-foreground">skipped (not eligible this run)</span>
      )}
      {health === 'ok' && (
        <span className="text-muted-foreground">· {fetched.toLocaleString()} fetched</span>
      )}
    </p>
  )
}

// Compute a list of source labels whose health indicates a regression we
// want to surface as a top-of-card amber banner.
function degradedSources(status: IngestStatus): string[] {
  const out: string[] = []
  const check = (label: string, health?: string) => {
    if (health === 'failed' || health === 'silent' || health === 'auth_broken') {
      out.push(`${label} (${health})`)
    }
  }
  check('Reddit', status.reddit_health)
  check('Bluesky', status.bluesky_health)
  check('Steam reviews', status.steam_review_health)
  check('Steam forums', status.steam_forum_health)
  return out
}

export default function SettingsPage() {
  const { data: publisher, isLoading: pubLoading }   = usePublisher()
  const { data: games,     isLoading: gamesLoading } = useAllGames()
  const { data: ingestStatus }                       = useIngestStatus()
  const triggerIngest = useTriggerIngest()

  if (pubLoading || gamesLoading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <SkeletonCard lines={3} />
        <SkeletonCard lines={5} />
        <SkeletonCard lines={4} />
      </div>
    )
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <h2 className="text-2xl font-bold">Settings</h2>

      {/* ── Publisher ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Publisher</h3>
        {publisher ? (
          <p className="text-base font-medium">{publisher.name}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No publisher found. Set the <code className="rounded bg-muted px-1">PUBLISHER_NAME</code> environment
            variable and restart the backend.
          </p>
        )}
      </section>

      <Separator />

      {/* ── Ingestion ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Ingestion</h3>
        {ingestStatus && (
          <div className="rounded-md border p-4 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  {ingestStatus.is_running ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />
                  ) : ingestStatus.last_run_status === 'success' ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : ingestStatus.last_run_status === 'partial_failure' ? (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  ) : ingestStatus.last_run_status === 'partial' ? (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  ) : ingestStatus.last_run_status ? (
                    <XCircle className="h-4 w-4 text-red-500" />
                  ) : null}
                  <span className="font-medium">
                    {ingestStatus.is_running
                      ? 'Running…'
                      : ingestStatus.last_run_status === 'partial_failure'
                        ? 'Partial failure'
                        : ingestStatus.last_run_status === 'partial'
                          ? 'Partial'
                          : ingestStatus.last_run_status
                            ? ingestStatus.last_run_status.charAt(0).toUpperCase() + ingestStatus.last_run_status.slice(1)
                            : 'Never run'}
                  </span>
                </div>
                <p className="text-muted-foreground">
                  Last run: {relativeTime(ingestStatus.last_run_at)} &middot;
                  Next: {relativeTime(ingestStatus.next_run_at)}
                </p>
                <p className="text-muted-foreground">
                  Posts collected (lifetime): {ingestStatus.posts_collected.toLocaleString()} &middot;
                  Games processed: {ingestStatus.games_processed}
                </p>

                {/* Per-source health — Reddit, Bluesky, Steam reviews, Steam forums */}
                <SourceHealthRow
                  label="Reddit"
                  health={ingestStatus.reddit_health}
                  fetched={ingestStatus.reddit_fetched_total}
                  retries={ingestStatus.reddit_retries}
                />
                <SourceHealthRow
                  label="Bluesky"
                  health={ingestStatus.bluesky_health}
                  fetched={ingestStatus.bluesky_fetched_total}
                  retries={ingestStatus.bluesky_retries}
                />
                <SourceHealthRow
                  label="Steam reviews"
                  health={ingestStatus.steam_review_health}
                  fetched={ingestStatus.steam_review_fetched_total}
                />
                <SourceHealthRow
                  label="Steam forums"
                  health={ingestStatus.steam_forum_health}
                  fetched={ingestStatus.steam_forum_fetched_total}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={ingestStatus.is_running || triggerIngest.isPending}
                onClick={() => triggerIngest.mutate()}
              >
                <RefreshCw className={`mr-2 h-3.5 w-3.5 ${ingestStatus.is_running ? 'animate-spin' : ''}`} />
                Run now
              </Button>
            </div>

            {/* Amber banner for failed or silent sources — hardened against
                future regressions per the Gap 2 + Gap 3 work. */}
            {(() => {
              const flagged = degradedSources(ingestStatus)
              if (flagged.length === 0) return null
              return (
                <div className="mt-2 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4 mt-0.5 flex-none" />
                  <div>
                    <p className="font-medium">Source regression detected</p>
                    <p>
                      {flagged.join(', ')} — investigate before next cron. Silent
                      sources fetched but persisted &lt;10% of their prior‑7d
                      baseline; failed sources fetched 0 posts after retries.
                    </p>
                  </div>
                </div>
              )
            })()}

            {ingestStatus.last_run_errors.length > 0 && (
              <div className="mt-2 rounded bg-destructive/10 p-2">
                <p className="text-xs font-medium text-destructive mb-1">Last run errors:</p>
                <ul className="space-y-0.5 text-xs text-destructive">
                  {ingestStatus.last_run_errors.map((e, i) => <li key={i}>• {e}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <Separator />

      {/* Digest Recipients */}
      <DigestRecipientsSection />

      <Separator />

      {/* Games ──────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Games</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Toggle games on/off to control which titles appear in the main dashboard dropdown.
            Data is preserved for hidden games.
          </p>
        </div>

        {!games?.length ? (
          <EmptyState
            title="No games found"
            description="Games will appear here after the first successful ingestion."
          />
        ) : (
          <div className="space-y-3">
            {games.map(g => (
              <GameSettingsCard key={g.id} game={g} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ── Digest Recipients section ───────────────────────────────────────────────
// Lets the operator add/remove/toggle email addresses that receive the
// weekly Monday 07:00 ET executive digest and the monthly 1st-of-month
// digest.  Recipient list is the only digest config exposed in the UI;
// the 8 priority titles and send schedule are fixed in backend code.
function DigestRecipientsSection() {
  const { data: recipients, isLoading } = useDigestRecipients()
  const addRecipient = useAddDigestRecipient()
  const deleteRecipient = useDeleteDigestRecipient()
  const toggleRecipient = useToggleDigestRecipient()
  const [emailInput, setEmailInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const email = emailInput.trim()
    if (!email) return
    try {
      await addRecipient.mutateAsync(email)
      setEmailInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add recipient')
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Digest Email Recipients
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Email addresses that receive the weekly (Mondays 07:00 ET) and monthly
          (1st of month, 07:00 ET) executive digests covering the eight priority
          Saber titles, with sentiment ratio, summary, recommendations, and big ideas.
        </p>
      </div>

      {/* Preview links — lets you QA the rendered HTML without a live send */}
      <div className="flex flex-wrap gap-2 text-xs">
        <a
          href="/api/digest/preview/weekly"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" /> Preview weekly
        </a>
        <a
          href="/api/digest/preview/monthly"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" /> Preview monthly
        </a>
      </div>

      {/* Add new recipient */}
      <form onSubmit={handleAdd} className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="someone@example.com"
          value={emailInput}
          onChange={e => setEmailInput(e.target.value)}
          disabled={addRecipient.isPending}
          className="flex-1"
        />
        <Button type="submit" disabled={addRecipient.isPending || !emailInput.trim()}>
          <Mail className="mr-2 h-4 w-4" />
          {addRecipient.isPending ? 'Adding…' : 'Add recipient'}
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* List */}
      {isLoading ? (
        <SkeletonCard lines={2} />
      ) : !recipients?.length ? (
        <EmptyState
          title="No recipients yet"
          description="Add at least one email address above to start receiving the executive digest."
        />
      ) : (
        <div className="space-y-2">
          {recipients.map(r => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-3 rounded border bg-card p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.email}</p>
                <p className="text-xs text-muted-foreground">
                  Added {relativeTime(r.created_at)} · {r.is_active ? 'active' : 'paused (won’t receive emails)'}
                </p>
              </div>
              <Switch
                checked={r.is_active}
                onCheckedChange={(checked) =>
                  toggleRecipient.mutate({ id: r.id, is_active: checked })
                }
                aria-label={`Toggle ${r.email}`}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (confirm(`Remove ${r.email} from the digest?`)) {
                    deleteRecipient.mutate(r.id)
                  }
                }}
                aria-label={`Remove ${r.email}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
