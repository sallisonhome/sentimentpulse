import { Inbox } from 'lucide-react'

interface EmptyStateProps {
  title?: string
  description?: string
}

export default function EmptyState({
  title = 'No data yet',
  description = 'Run an ingestion to populate data.',
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
      <Inbox className="h-10 w-10" />
      <p className="text-base font-medium">{title}</p>
      <p className="text-sm">{description}</p>
    </div>
  )
}
