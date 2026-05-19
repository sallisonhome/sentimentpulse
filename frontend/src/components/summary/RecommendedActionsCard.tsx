import { Lightbulb } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'

interface RecommendedActionsCardProps {
  text: string | null
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DESIGN REVERT FLAG
 *
 * To revert to the previous "wall of paragraphs" rendering, set the constant
 * below to `false` and rebuild the frontend. No other file changes required.
 *
 * New (true):  Numbered teal chips · inline-bolded topic labels · generous
 *              vertical rhythm · subtle dividers between items · full-foreground
 *              typography optimized for scanning.
 * Old (false): Original chevron-bulleted muted paragraphs.
 * ───────────────────────────────────────────────────────────────────────────── */
const POLISH_V1 = true

/**
 * Inline-format a single action line: render **bold** markdown spans as <strong>
 * with the primary accent. Everything else is plain text. Returns React nodes.
 *
 * We intentionally do NOT do full markdown — only the **bold** pattern that the
 * LLM reliably produces around topic labels. Anything more would invite XSS
 * concerns and over-styling.
 */
function formatInline(text: string): React.ReactNode[] {
  // Split on **bold** spans, keeping the delimiters via captured group
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong
          key={i}
          className="font-semibold text-foreground"
        >
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <span key={i}>{part}</span>
  })
}

/**
 * Parse the raw recommendations text into a list of action items.
 *
 * Recognizes:
 *   - "1. ..." / "1) ..." numbered items
 *   - "- ..." / "* ..." / "• ..." bulleted items
 *   - Plain paragraphs as fallback
 *
 * Multi-line numbered items (rare but possible) are joined into one item.
 */
function parseActions(raw: string): string[] {
  const lines = raw.split('\n').map(l => l.trim())
  const items: string[] = []
  let current = ''

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed) items.push(trimmed)
    current = ''
  }

  for (const line of lines) {
    if (!line) {
      // Blank line → boundary between items
      flush()
      continue
    }
    const isNumberedStart = /^\d+[.)]\s/.test(line)
    const isBulletStart = /^[-*•]\s/.test(line)
    if (isNumberedStart || isBulletStart) {
      flush()
      current = line.replace(/^\d+[.)]\s*/, '').replace(/^[-*•]\s*/, '')
    } else {
      // Continuation of previous item, or a standalone paragraph
      current = current ? `${current} ${line}` : line
    }
  }
  flush()
  return items
}

export default function RecommendedActionsCard({ text }: RecommendedActionsCardProps) {
  // Render nothing when the backend signals "nothing to recommend" — either by
  // returning null, returning an empty/whitespace-only string, or returning
  // content that parses to zero actions. The parent grid auto-flows the
  // Executive Summary card to full width.
  if (!text || !text.trim()) return null
  const actions = parseActions(text)
  if (actions.length === 0) return null

  if (!POLISH_V1) {
    // ── Legacy rendering (kept for one-flag revert) ──────────────────────────
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4" />
            Recommended Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            {actions.map((a, i) => (
              <p key={i} className="leading-relaxed text-muted-foreground">
                {formatInline(a)}
              </p>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  // ── Polished rendering (current default) ───────────────────────────────────
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="h-4 w-4 text-primary" />
          Recommended Actions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="divide-y divide-border/60">
          {actions.map((action, i) => (
            <li
              key={i}
              className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
            >
              <span
                aria-hidden="true"
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular-nums select-none"
              >
                {i + 1}
              </span>
              <p className="text-sm leading-relaxed text-foreground">
                {formatInline(action)}
              </p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
