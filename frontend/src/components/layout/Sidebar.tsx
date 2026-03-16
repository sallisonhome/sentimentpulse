import { NavLink } from 'react-router-dom'
import { LayoutDashboard, FileText, TrendingUp, MessageSquare, Settings } from 'lucide-react'
import { cn } from '../../lib/utils'

const NAV_ITEMS = [
  { to: '/',        label: 'Dashboard',   icon: LayoutDashboard, end: true },
  { to: '/summary', label: 'Summary',     icon: FileText },
  { to: '/topics',  label: 'Topics',      icon: TrendingUp },
  { to: '/posts',   label: 'Posts',       icon: MessageSquare },
  { to: '/settings',label: 'Settings',    icon: Settings },
]

export default function Sidebar() {
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
            to={to}
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
    </aside>
  )
}
