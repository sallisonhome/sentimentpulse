import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppShell from './components/layout/AppShell'
import DashboardPage from './pages/DashboardPage'
import SummaryPage from './pages/SummaryPage'
import TopicsPage from './pages/TopicsPage'
import PostsPage from './pages/PostsPage'
import SettingsPage from './pages/SettingsPage'

// Keep in sync with vite.config.ts `base` and the Nginx `/sentiment/` location.
// Without this, deep links like /sentiment/summary fail because BrowserRouter
// sees the full path, matches no route, and falls through to the * catchall.
const BASENAME = '/sentiment'

export default function App() {
  return (
    <BrowserRouter basename={BASENAME}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="summary" element={<SummaryPage />} />
          <Route path="topics" element={<TopicsPage />} />
          <Route path="posts" element={<PostsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
