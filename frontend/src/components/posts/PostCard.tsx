import { useState } from 'react'
import { ExternalLink, ChevronDown, ChevronUp, ThumbsUp } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { Card, CardContent } from '../ui/card'
import SentimentBadge from '../shared/SentimentBadge'
import { sourceLabel, truncate } from '../../lib/utils'
import { cn } from '../../lib/utils'
import type { RawPost, Source } from '../../types'

const SOURCE_COLORS: Record<Source, string> = {
  steam_review: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  steam_forum:  'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  reddit:       'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
}

const BODY_PREVIEW_LEN = 240

interface PostCardProps {
  post: RawPost
}

export default function PostCard({ post }: PostCardProps) {
  const [expanded, setExpanded] = useState(false)
  const body = post.body ?? ''
  const needsExpand = body.length > BODY_PREVIEW_LEN

  const displayDate = post.post_date
    ? format(parseISO(post.post_date), 'MMM d, yyyy')
    : format(parseISO(post.collected_at), 'MMM d, yyyy') + ' (collected)'

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-4 space-y-2">
        {/* Header row */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', SOURCE_COLORS[post.source])}>
            {sourceLabel(post.source)}
          </span>
          {post.sentiment_info && (
            <SentimentBadge sentiment={post.sentiment_info.sentiment} />
          )}
          <span className="ml-auto text-xs text-muted-foreground">{displayDate}</span>
        </div>

        {/* Title */}
        {post.title && (
          <p className="font-medium leading-snug">{post.title}</p>
        )}

        {/* Body */}
        {body && (
          <div className="text-sm text-muted-foreground leading-relaxed">
            <p>
              {expanded || !needsExpand ? body : truncate(body, BODY_PREVIEW_LEN)}
            </p>
            {needsExpand && (
              <button
                className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                onClick={() => setExpanded(v => !v)}
              >
                {expanded
                  ? <><ChevronUp className="h-3 w-3" /> Show less</>
                  : <><ChevronDown className="h-3 w-3" /> Show more</>
                }
              </button>
            )}
          </div>
        )}

        {/* Footer row */}
        <div className="flex items-center gap-3 pt-1 text-xs text-muted-foreground">
          {post.author && <span>@{post.author}</span>}
          {post.upvotes > 0 && (
            <span className="flex items-center gap-1">
              <ThumbsUp className="h-3 w-3" />
              {post.upvotes.toLocaleString()}
            </span>
          )}
          {post.sentiment_info && (
            <span>
              Score: {post.sentiment_info.sentiment_score.toFixed(3)}
            </span>
          )}
          {post.sentiment_info?.topics?.length ? (
            <span className="truncate max-w-xs">
              Topics: {post.sentiment_info.topics.join(', ')}
            </span>
          ) : null}
          {post.url && (
            <a
              href={post.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto flex items-center gap-1 text-primary hover:underline"
            >
              View original <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
