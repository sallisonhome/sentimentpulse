type IconProps = { className?: string };

function HomeIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <path d="M3 12l9-9 9 9" />
      <path d="M5 10v10a1 1 0 001 1h12a1 1 0 001-1V10" />
    </svg>
  );
}
function ChatIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}
function PulseIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
function PinIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
function ChartIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 4 4 5-5" />
    </svg>
  );
}
function DeckIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 9h18M9 4v14" />
    </svg>
  );
}
function LayersIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

type NavItem = {
  href: string;
  label: string;
  Icon: (p: IconProps) => JSX.Element;
  external?: boolean; // cross-app — full page nav
};

const apps: NavItem[] = [
  { href: "/", label: "Suite Home", Icon: HomeIcon, external: true },
  { href: "/sentiment/", label: "SentimentPulse", Icon: ChatIcon, external: true },
  { href: "/signal/", label: "SignalPulse", Icon: PulseIcon, external: true },
  { href: "/trips/", label: "Trip & Meeting Tracker", Icon: PinIcon, external: true },
  { href: "/genrepulse/", label: "Genre Pulse", Icon: ChartIcon, external: true },
  { href: "/gtm/", label: "GTM Studio", Icon: DeckIcon, external: false }, // active app
];

export function Sidebar() {
  return (
    <aside className="hidden md:flex flex-col w-[240px] shrink-0 h-screen sticky top-0 bg-[#0b0e13] border-r border-border">
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-border">
        <div className="w-8 h-8 rounded-md bg-accent-glow border border-accent/30 text-accent flex items-center justify-center">
          <LayersIcon className="w-4 h-4" />
        </div>
        <div className="leading-tight">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-dim">
            Saber Interactive
          </div>
          <div className="text-[13px] font-semibold text-ink">
            Intelligence Suite
          </div>
        </div>
      </div>

      <nav className="flex-1 px-2 py-4 overflow-y-auto">
        <div className="px-2.5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-dim">
          Apps
        </div>
        {apps.map((a) => {
          const active = a.href === "/gtm/";
          const cls = active
            ? "flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] font-medium bg-accent-glow text-accent border border-accent/25"
            : "flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] font-medium text-muted hover:text-ink hover:bg-surface transition-colors";
          return (
            <a
              key={a.href}
              href={a.href}
              className={cls}
              // Cross-app links break out of the hash router. The GTM link
              // (active) just re-renders home.
            >
              <a.Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{a.label}</span>
            </a>
          );
        })}
      </nav>

      <div className="px-4 py-3.5 border-t border-border text-[11px] text-dim">
        GTM Studio · Phase 2
      </div>
    </aside>
  );
}
