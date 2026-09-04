import { useLocation } from "wouter";
import type { ReactNode } from "react";
import { getToday, todayHuman } from "../lib/today";
import { useAsync } from "../lib/hooks";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useTheme } from "./theme-provider";

type Icon = "calendar" | "titles" | "platforms" | "events" | "analytics" | "settings";

const ICONS: Record<Icon, string> = {
  calendar: "M8 2v3M16 2v3M3 9h18M5 5h14a2 2 0 012 2v13a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z",
  titles: "M4 6h16M4 12h16M4 18h10",
  platforms: "M6 3v18M18 3v18M3 6h18M3 18h18",
  events: "M12 2l2.9 6 6.6.6-5 4.4 1.5 6.5L12 16l-6 3.5L7.5 13l-5-4.4L9.1 8z",
  analytics: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
};

interface NavDef {
  label: string;
  icon: Icon;
  path: string;
  matcher: (loc: string) => boolean;
  count?: string;
}

function NavIcon({ name }: { name: Icon }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function Shell({
  active,
  crumbs,
  children,
}: {
  active: Icon;
  crumbs?: BreadcrumbItem[];
  children: ReactNode;
}) {
  const [, navigate] = useLocation();
  const today = getToday();
  const me = useAsync(() => api.me(), []);
  const cals = useAsync(() => api.calendars(), []);

  const eventsCount = cals.data?.calendars.find((c) => c.id === "saber")?.active_upload?.events_count;
  const totalCampaigns = cals.data?.calendars.find((c) => c.id === "saber")?.active_upload?.campaigns_count;
  const lastSynced = cals.data?.calendars.find((c) => c.id === "saber")?.active_upload?.uploaded_at;

  const nav: NavDef[] = [
    { label: "Calendar", icon: "calendar", path: "/", matcher: (l) => l === "/" || l.startsWith("/?") },
    { label: "Titles", icon: "titles", path: "/titles", matcher: (l) => l.startsWith("/titles"), count: "6" },
    { label: "Platforms", icon: "platforms", path: "/platforms", matcher: (l) => l.startsWith("/platforms"), count: "3" },
    { label: "Events", icon: "events", path: "/events", matcher: (l) => l.startsWith("/events"), count: eventsCount != null ? String(Math.min(999, eventsCount)) : "" },
    { label: "Analytics", icon: "analytics", path: "/analytics", matcher: (l) => l.startsWith("/analytics") },
    { label: "Settings", icon: "settings", path: "/settings", matcher: (l) => l.startsWith("/settings") },
  ];

  const initial = me.data?.email ? me.data.email.trim().charAt(0).toUpperCase() : "·";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <path d="M3 10h18M8 2v4M16 2v4" />
            </svg>
          </div>
          <div>
            <div className="brand-name">Promo Calendar</div>
            <div className="brand-sub">Saber Suite</div>
          </div>
        </div>

        <div className="nav-section-label">Views</div>
        {nav.map((n) => {
          const isActive = n.icon === active;
          return (
            <a
              key={n.label}
              className={`nav-item${isActive ? " active" : ""}`}
              href={`#${n.path}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(n.path);
              }}
            >
              <NavIcon name={n.icon} />
              <span>{n.label}</span>
              {n.count ? <span className="count">{n.count}</span> : null}
            </a>
          );
        })}

        <div className="nav-section-label" style={{ marginTop: "1.25rem" }}>Saber Suite</div>
        <a className="nav-item cross-app" href="/">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12L12 3l9 9M5 10v10h14V10" />
          </svg>
          <span>Suite Home</span>
        </a>
        <a className="nav-item cross-app" href="/sentiment/">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          <span>SentimentPulse</span>
        </a>
        <a className="nav-item cross-app" href="/signal/">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <span>SignalPulse</span>
        </a>
        <a className="nav-item cross-app" href="/trips/">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          <span>Trip &amp; Meeting Tracker</span>
        </a>
        <a className="nav-item cross-app" href="/gtm/">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3H7a2 2 0 00-2 2v14l7-3 7 3V5a2 2 0 00-2-2z" />
          </svg>
          <span>GTM Studio</span>
        </a>
        <a className="nav-item cross-app" href="/partnerships/">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 17l2 2a1 1 0 003-3" />
            <path d="M14 14l2.5 2.5a1 1 0 003-3l-3.88-3.88a3 3 0 00-4.24 0l-.88.88a1 1 0 01-1.42 0l-2.62-2.62a1 1 0 010-1.42l1.5-1.5a3 3 0 014.24 0L14 7" />
            <path d="M2 15l3.5 3.5a1 1 0 003-3l-3.5-3.5a1 1 0 00-1.42 0L2 13.58a1 1 0 000 1.42z" />
          </svg>
          <span>Publishing Partnerships</span>
        </a>

        <div className="sidebar-footer">
          <div className="row">
            <span>Data source</span>
            <span>{totalCampaigns != null ? `${totalCampaigns.toLocaleString()} campaigns` : "—"}</span>
          </div>
          <div className="row">
            <span>Last synced</span>
            <span title={lastSynced || ""}>{lastSynced ? fmtDateTime(lastSynced) : "—"}</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            {crumbs && crumbs.length > 0 ? (
              crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return (
                  <span key={i}>
                    {i > 0 ? <span className="sep">·</span> : null}
                    {last ? (
                      <strong>{c.label}</strong>
                    ) : c.href ? (
                      <a
                        href={`#${c.href}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(c.href!);
                        }}
                      >
                        {c.label}
                      </a>
                    ) : (
                      c.label
                    )}
                  </span>
                );
              })
            ) : null}
          </div>
          <div className="top-right">
            <div className="today">Today · <em>{todayHuman(today)}</em></div>
            <ThemeToggle />
            <div className="avatar" title={me.data?.email || "anonymous"}>{initial}</div>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? (
        // Sun icon
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        // Moon icon
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
