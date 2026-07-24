import { Link } from 'react-router-dom'

/**
 * Global app footer. Mirrors the howmanyareplaying.com pattern: quiet, one
 * horizontal row, with the primary link being the Changelog page. Sits at
 * the bottom of every routed page inside AppShell.
 *
 * Added 2026-07-24 alongside the /changelog route + CHANGELOG.md source file.
 */
export default function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="border-t bg-background/80 px-6 py-3 text-xs text-muted-foreground">
      <div className="flex items-center justify-between gap-4">
        <span>SentimentPulse · © {year}</span>
        <nav className="flex items-center gap-4">
          <Link
            to="/changelog"
            className="hover:text-foreground transition-colors"
          >
            Changelog
          </Link>
        </nav>
      </div>
    </footer>
  )
}
