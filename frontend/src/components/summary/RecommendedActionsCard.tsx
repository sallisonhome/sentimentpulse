import { Lightbulb, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'

interface RecommendedActionsCardProps {
  text: string | null
}

/** Parse AI-generated action text into renderable lines.
 *  Splits on newlines; lines starting with -, *, •, or a number+dot
 *  become bullet items. Blank lines are skipped. */
function parseActions(raw: string): Array<{ type: 'bullet' | 'para'; text: string }> {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.map(line => {
    const isBullet = /^[-*•]|^\d+[.)]\s/.test(line)
    const text = line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '')
    return { type: isBullet ? 'bullet' : 'para', text }
  })
}

export default function RecommendedActionsCard({ text }: RecommendedActionsCardProps) {
  const actions = text ? parseActions(text) : []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="h-4 w-4" />
          Recommended Actions
        </CardTitle>
      </CardHeader>
      <CardContent>
        {actions.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No recommendations available yet.
          </p>
        ) : (
          <div className="space-y-2 text-sm">
            {actions.map((a, i) =>
              a.type === 'bullet' ? (
                <div key={i} className="flex items-start gap-2">
                  <ChevronRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                  <span className="leading-snug">{a.text}</span>
                </div>
              ) : (
                <p key={i} className="leading-relaxed text-muted-foreground">{a.text}</p>
              )
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
