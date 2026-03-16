import { FileText } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'

interface ExecutiveSummaryCardProps {
  text: string | null
}

export default function ExecutiveSummaryCard({ text }: ExecutiveSummaryCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" />
          Executive Summary
        </CardTitle>
      </CardHeader>
      <CardContent>
        {text ? (
          <div className="space-y-3 text-sm leading-relaxed text-foreground">
            {text.split(/\n\n+/).map((para, i) => (
              <p key={i}>{para.trim()}</p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            No summary available. This is generated automatically after each ingestion run.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
