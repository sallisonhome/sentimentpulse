import { useState } from 'react'
import { subDays, format } from 'date-fns'
import { useAppContext } from '../contexts/AppContext'
import { usePosts } from '../hooks/usePosts'
import { periodToDays } from '../lib/utils'
import PostFilters from '../components/posts/PostFilters'
import PostCard from '../components/posts/PostCard'
import Pagination from '../components/posts/Pagination'
import EmptyState from '../components/shared/EmptyState'
import SkeletonCard from '../components/shared/SkeletonCard'
import ErrorBoundary from '../components/shared/ErrorBoundary'
import type { Sentiment, Source } from '../types'

const PAGE_SIZE = 20

export default function PostsPage() {
  const { selectedGameId, period } = useAppContext()

  const [page, setPage]           = useState(1)
  const [sentiment, setSentiment] = useState<Sentiment | 'all'>('all')
  const [source, setSource]       = useState<Source | 'all'>('all')
  const [search, setSearch]       = useState('')

  function resetPage() { setPage(1) }

  // Derive date_from from the global period filter
  const days = periodToDays(period)
  const date_from = days ? format(subDays(new Date(), days), 'yyyy-MM-dd') : undefined

  const { data, isLoading, error } = usePosts(selectedGameId, {
    page,
    page_size: PAGE_SIZE,
    sentiment: sentiment === 'all' ? undefined : sentiment,
    source:    source    === 'all' ? undefined : source,
    search:    search    || undefined,
    date_from,
  })

  if (!selectedGameId) {
    return <EmptyState title="No game selected" description="Select a game from the top bar." />
  }

  return (
    <ErrorBoundary>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold">Raw Posts</h2>
            {data && (
              <p className="text-sm text-muted-foreground">
                {data.total.toLocaleString()} post{data.total !== 1 ? 's' : ''} · {period}
              </p>
            )}
          </div>
        </div>

        <PostFilters
          sentiment={sentiment}
          source={source}
          search={search}
          onSentimentChange={v => { setSentiment(v); resetPage() }}
          onSourceChange={v    => { setSource(v);    resetPage() }}
          onSearchChange={v    => { setSearch(v);    resetPage() }}
        />

        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} lines={3} />)}
          </div>
        )}

        {error && <EmptyState title="Failed to load posts" description={error.message} />}

        {!isLoading && !error && data?.items.length === 0 && (
          <EmptyState
            title="No posts match your filters"
            description="Try adjusting the sentiment, source, search term, or time period."
          />
        )}

        {!isLoading && !error && data && data.items.length > 0 && (
          <>
            <div className="space-y-3">
              {data.items.map(post => <PostCard key={post.id} post={post} />)}
            </div>

            <Pagination
              page={data.page}
              totalPages={data.total_pages}
              total={data.total}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </ErrorBoundary>
  )
}
