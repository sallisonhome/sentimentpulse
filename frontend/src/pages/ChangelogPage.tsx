import { useMemo } from 'react'
// Vite's `?raw` import loads the file at build time as a string. Keeping the
// changelog as a plain markdown file at the project root means we can edit it
// like any other doc — no CMS, no API, no DB row per entry.
// The file is symlinked (or copied at build time) into the frontend so Vite
// can resolve it; see vite.config.ts.
import changelogSource from '../CHANGELOG.md?raw'

type EntryKind = 'New' | 'Improved' | 'Fixed' | 'Other'

interface Entry {
  kind: EntryKind
  title: string
  body: string
}

interface DateGroup {
  date: string
  entries: Entry[]
}

/**
 * Parse the CHANGELOG.md structure. Format (matches howmanyareplaying.com):
 *
 *   # SentimentPulse Changelog
 *   ...intro prose (ignored)...
 *   ## <Date>
 *   - <Kind>
 *
 *     ### <Title>
 *
 *     <Body paragraph, one or more lines>
 *   ## <Next Date>
 *   ...
 *
 * Kind is one of: New, Improved, Fixed. Anything else falls back to "Other".
 * The parser is intentionally forgiving: extra blank lines, mixed spacing,
 * and multi-paragraph bodies all work.
 */
function parseChangelog(src: string): DateGroup[] {
  const lines = src.split(/\r?\n/)
  const groups: DateGroup[] = []
  let currentGroup: DateGroup | null = null
  let currentEntry: Entry | null = null
  let bodyBuffer: string[] = []

  const flushBody = () => {
    if (currentEntry && bodyBuffer.length) {
      currentEntry.body = bodyBuffer.join('\n').trim()
      bodyBuffer = []
    }
  }
  const flushEntry = () => {
    flushBody()
    if (currentEntry && currentGroup) {
      currentGroup.entries.push(currentEntry)
    }
    currentEntry = null
    bodyBuffer = []
  }
  const flushGroup = () => {
    flushEntry()
    if (currentGroup) groups.push(currentGroup)
    currentGroup = null
  }

  for (const raw of lines) {
    // Trim leading whitespace too. The changelog format nests entries
    // under their bullet so `### Title` and body lines are indented with
    // two spaces. Without lstrip'ing, the regexes below (anchored with
    // ^) never matched and every entry rendered as a bare badge with no
    // title or body. Fixed 2026-07-25.
    const line = raw.trim()
    // ## <Date> — new date group (must NOT match ###)
    const dateMatch = /^##\s+(?!#)(.+?)\s*$/.exec(line)
    if (dateMatch) {
      flushGroup()
      currentGroup = { date: dateMatch[1], entries: [] }
      continue
    }
    // - <Kind> — start a new entry within the group
    const kindMatch = /^-\s+(New|Improved|Fixed|Other)\s*$/.exec(line)
    if (kindMatch && currentGroup) {
      flushEntry()
      currentEntry = { kind: kindMatch[1] as EntryKind, title: '', body: '' }
      continue
    }
    // ### <Title>
    const titleMatch = /^###\s+(.+?)\s*$/.exec(line)
    if (titleMatch && currentEntry) {
      flushBody()
      currentEntry.title = titleMatch[1]
      continue
    }
    // # <Top-level title> (single #) — ignored; assumed to be the file header.
    // Skip ONLY when it's a real level-1 heading (# followed by space, not
    // ## or ###); ## and ### are handled above.
    if (/^#\s+/.test(line) && !line.startsWith('##')) continue
    // Anything else: accumulate as body if we're inside an entry
    if (currentEntry && currentEntry.title) {
      bodyBuffer.push(raw)
    }
  }
  flushGroup()
  return groups
}

const KIND_STYLES: Record<EntryKind, string> = {
  New: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 ring-1 ring-emerald-500/20',
  Improved: 'bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300 ring-1 ring-sky-500/20',
  Fixed: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 ring-1 ring-amber-500/20',
  Other: 'bg-muted text-muted-foreground ring-1 ring-border',
}

export default function ChangelogPage() {
  const groups = useMemo(() => parseChangelog(changelogSource), [])

  return (
    <div className="mx-auto max-w-3xl px-2 py-4">
      <header className="mb-8 border-b pb-6">
        <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="mt-2 text-muted-foreground">
          A running log of what changed in SentimentPulse — new features, improvements, and fixes.
        </p>
      </header>

      <div className="space-y-10">
        {groups.map((group) => (
          <section key={group.date}>
            <h2 className="mb-4 text-lg font-semibold text-muted-foreground">
              {group.date}
            </h2>
            <ul className="space-y-6">
              {group.entries.map((entry, i) => (
                <li key={`${group.date}-${i}`} className="rounded-lg border bg-card p-5">
                  <div className="mb-2 flex items-center gap-3">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${KIND_STYLES[entry.kind]}`}>
                      {entry.kind}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold leading-snug">
                    {entry.title}
                  </h3>
                  {entry.body && (
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
                      {entry.body}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground">No changelog entries yet.</p>
      )}
    </div>
  )
}
