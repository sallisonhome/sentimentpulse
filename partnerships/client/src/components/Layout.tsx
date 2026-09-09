import { Link, useLocation } from "wouter";
import type { ReactNode } from "react";

function PartnershipsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function DashboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}

// Cross-app switcher — same "Saber Suite" section every other app in the
// suite ships (SignalPulse, Promo Calendar, etc.), minus this app itself.
// Icons/paths copied verbatim from those apps' shells for visual parity.
const SUITE_APPS: { label: string; href: string; icon: JSX.Element }[] = [
  {
    label: "Suite Home",
    href: "/",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12L12 3l9 9M5 10v10h14V10" />
      </svg>
    ),
  },
  {
    label: "SentimentPulse",
    href: "/sentiment/",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
  },
  {
    label: "SignalPulse",
    href: "/signal/",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
  },
  {
    label: "Genre Pulse",
    href: "/genrepulse/",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18" />
      </svg>
    ),
  },
  {
    label: "Trip & Meeting Tracker",
    href: "/trips/",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
    ),
  },
  {
    label: "GTM Studio",
    href: "/gtm/",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 3H7a2 2 0 00-2 2v14l7-3 7 3V5a2 2 0 00-2-2z" />
      </svg>
    ),
  },
  {
    label: "Promo Calendar",
    href: "/promo/",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M3 10h18M8 2v4M16 2v4" />
      </svg>
    ),
  },
];

export default function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const isDashboard = location === "/" || location === "";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon" aria-hidden>
            <PartnershipsIcon />
          </div>
          <div>
            <div className="brand-sub">Saber Suite</div>
            <div className="brand-name">Publishing Partnerships</div>
          </div>
        </div>

        <div className="nav-section-label">Views</div>
        <Link href="/">
          <a className={`nav-item${isDashboard ? " active" : ""}`} data-testid="link-dashboard">
            <DashboardIcon />
            <span>Dashboard</span>
          </a>
        </Link>

        <div className="nav-section-label" style={{ marginTop: "1.25rem" }}>
          Saber Suite
        </div>
        {SUITE_APPS.map((app) => (
          <a key={app.href} className="nav-item cross-app" href={app.href}>
            {app.icon}
            <span>{app.label}</span>
          </a>
        ))}

        <div className="sidebar-footer">Confidential — Do Not Share</div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            <strong>{isDashboard ? "Dashboard" : "Title Detail"}</strong>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
