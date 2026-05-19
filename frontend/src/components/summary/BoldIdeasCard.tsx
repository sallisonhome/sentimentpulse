import { Lightbulb } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'

interface BoldIdeasCardProps {
  ideas: string[]
}

/**
 * Renders the "Bold Ideas to Consider" card.
 *
 * Only rendered when `ideas` is non-empty — the parent checks before mounting.
 * Visual treatment: amber/gold border to distinguish it from standard cards.
 */
export default function BoldIdeasCard({ ideas }: BoldIdeasCardProps) {
  if (!ideas.length) return null

  return (
    <Card className="border-amber-400 dark:border-amber-500 shadow-amber-100 dark:shadow-amber-900/20">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base text-amber-700 dark:text-amber-400">
          <Lightbulb className="h-4 w-4 fill-amber-300 stroke-amber-500 dark:fill-amber-600 dark:stroke-amber-400" />
          Bold Ideas to Consider
        </CardTitle>
        <p className="text-xs text-muted-foreground">Suggested by AI based on community signals</p>
      </CardHeader>
      <CardContent>
        <ol className="space-y-4 text-sm leading-relaxed">
          {ideas.map((idea, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40 text-xs font-bold text-amber-700 dark:text-amber-400 select-none">
                {i + 1}
              </span>
              <span className="pt-0.5">{idea}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
