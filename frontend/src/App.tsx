import { Routes, Route, Navigate } from 'react-router-dom'
import AppShell from './components/layout/AppShell'
import DashboardPage from './pages/DashboardPage'
import SummaryPage from './pages/SummaryPage'
import TopicsPage from './pages/TopicsPage'
import PostsPage from './pages/PostsPage'
import SettingsPage from './pages/SettingsPage'
import ChangelogPage from './pages/ChangelogPage'

// NOTE: <BrowserRouter> lives in main.tsx now (2026-07-26) because
// AppProvider uses useSearchParams() to sync the selected game with
// the URL — that hook has to render inside a Router context, so
// AppProvider is nested inside the Router at the top of the tree.

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="summary" element={<SummaryPage />} />
        <Route path="topics" element={<TopicsPage />} />
        <Route path="posts" element={<PostsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        {/* v2026-07-24: standalone changelog page linked from the footer */}
        <Route path="changelog" element={<ChangelogPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
