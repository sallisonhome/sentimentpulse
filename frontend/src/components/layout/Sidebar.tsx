import { NavLink, useSearchParams } from 'react-router-dom'
import { LayoutDashboard, FileText, TrendingUp, MessageSquare, Settings, ArrowRightLeft, Home } from 'lucide-react'
import { cn } from '../../lib/utils'

const NAV_ITEMS = [
  { to: '/',        label: 'Dashboard',   icon: LayoutDashboard, end: true },
  { to: '/summary', label: 'Summary',     icon: FileText },
  { to: '/topics',  label: 'Topics',      icon: TrendingUp },
  { to: '/posts',   label: 'Posts',       icon: MessageSquare },
  { to: '/settings',label: 'Settings',    icon: Settings },
]

export default function Sidebar() {
  // v0021 (2026-08-19): preserve the ?game=<id> URL param when navigating
  // between side-nav routes so the user stays anchored on the title they
  // selected from the top-bar dropdown. Prior version passed a bare `to`
  // string like "/summary", which dropped every query param on the
  // Dashboard→Summary→Posts route change. That left the URL without
  // ?game=<id>, which then made AppContext's URL→state useEffect null out
  // selectedGameId, which then made TopBar's fallback logic (`if
  // selectedGameId == null`) reset to the FIRST title in the dropdown
  // — exactly the awful UX the user reported.
  //
  // Preserving *all* current search params (not just game=) is
  // intentional: it also carries period, filters, etc. across routes so
  // a user viewing "Aliens FE2" on the monthly period lands on Summary
  // for the same title without losing their period selection.
  const [searchParams] = useSearchParams()
  const search = searchParams.toString()
  const suffix = search ? `?${search}` : ''

  return (
    <aside className="flex w-56 flex-col border-r bg-card px-3 py-4">
      <div className="mb-6 px-2">
        <h1 className="text-lg font-bold tracking-tight">SentimentPulse</h1>
        <p className="text-xs text-muted-foreground">Game Publisher Intelligence</p>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={`${to}${suffix}`}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t pt-3 space-y-1">
        <a
          href="/signal/"
          className="flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <ArrowRightLeft className="h-4 w-4" />
          SignalPulse
        </a>
        <a
          href="/trips/"
          className="flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <ArrowRightLeft className="h-4 w-4" />
          Trip Tracker
        </a>
        <a
          href="/genrepulse/"
          className="flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <ArrowRightLeft className="h-4 w-4" />
          Genre Pulse
        </a>
        <a
          href="/gtm/"
          className="flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <ArrowRightLeft className="h-4 w-4" />
          GTM Studio
        </a>
        <a
          href="/"
          className="flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <Home className="h-4 w-4" />
          Suite Home
        </a>
      </div>
    </aside>
  )
}
