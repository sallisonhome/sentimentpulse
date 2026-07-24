import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import Footer from './Footer'
import { useIngestAutoRefresh } from '../../hooks/useIngest'

export default function AppShell() {
  // Auto-refresh all data when an ingestion run finishes
  useIngestAutoRefresh()

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
        {/* v2026-07-24: global footer with clickable Changelog link */}
        <Footer />
      </div>
    </div>
  )
}
