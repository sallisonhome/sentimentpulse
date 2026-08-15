import { Link, useLocation } from "wouter";
import { useTheme } from "./theme-provider";
import { useQuery } from "@tanstack/react-query";
import { Sun, Moon, Plus, Gamepad2, ChevronLeft, ChevronRight, Activity, Settings, LogOut, ArrowRightLeft, Home, Trophy, AlertTriangle, Inbox as InboxIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useState } from "react";

interface LayoutProps {
  children: React.ReactNode;
  onAddProduct?: () => void;
}

function SignalPulseLogo() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" fill="none" aria-label="SignalPulse logo" className="shrink-0">
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
      <circle cx="16" cy="16" r="9" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      <circle cx="16" cy="16" r="4" fill="currentColor" />
      <path d="M16 2 L16 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M16 24 L16 30" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M2 16 L8 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M24 16 L30 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Layout({ children, onAddProduct }: LayoutProps) {
  const { theme, toggleTheme } = useTheme();
  const [location] = useLocation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const { data: products } = useQuery<any[]>({
    queryKey: ["/api/products"],
  });

  // Proactive Steam cookie-expiry banner (app-wide, every page) — the
  // Settings page already shows a passive status card, but that's only
  // seen if someone navigates there. Polling here means the banner shows
  // up without requiring a page reload once the cookie actually expires.
  const { data: steamSession } = useQuery<{ isExpired?: boolean; alertSentAt?: string | null }>({
    queryKey: ["/api/steam/session"],
    refetchInterval: 5 * 60 * 1000,
  });

  // v3.21 (2026-08-15): inbound-email unread badge for the sidebar Inbox link.
  const { data: inboxUnread } = useQuery<{ unread: number }>({
    queryKey: ["inbox-unread-count"],
    queryFn: async () => {
      const r = await fetch("/api/inbound/unread-count");
      if (!r.ok) return { unread: 0 };
      return r.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  return (
    <div className="h-full grid" style={{
      gridTemplateColumns: sidebarCollapsed ? "60px 1fr" : "260px 1fr",
      gridTemplateRows: "56px 1fr",
      transition: "grid-template-columns 200ms ease",
    }}>
      {/* Top Nav */}
      <header className="col-span-2 flex items-center justify-between px-4 border-b bg-card z-20">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-primary">
            <SignalPulseLogo />
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">Saber</span>
              <span className="text-sm font-semibold tracking-tight">SignalPulse</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                data-testid="button-theme-toggle"
                className="h-8 w-8"
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle {theme === "dark" ? "light" : "dark"} mode</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* Sidebar */}
      <aside className="row-start-2 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b border-sidebar-border">
          {!sidebarCollapsed && (
            <span className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/60">Products</span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="h-7 w-7 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent shrink-0"
          >
            {sidebarCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {!sidebarCollapsed && (
          <div className="p-2">
            <Button
              size="sm"
              onClick={onAddProduct}
              className="w-full justify-start gap-2 h-8 text-xs"
              data-testid="button-add-product-sidebar"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Product
            </Button>
          </div>
        )}
        {sidebarCollapsed && (
          <div className="p-2 flex justify-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  onClick={onAddProduct}
                  className="h-8 w-8"
                  data-testid="button-add-product-sidebar-collapsed"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Add Product</TooltipContent>
            </Tooltip>
          </div>
        )}

        <ScrollArea className="flex-1">
          <nav className="p-2 space-y-0.5">
            <Link href="/">
              <div
                className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors ${
                  location === "/" || location === ""
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                }`}
                data-testid="link-leaderboards"
              >
                <Trophy className="h-3.5 w-3.5 shrink-0" />
                {!sidebarCollapsed && <span>Leaderboards</span>}
              </div>
            </Link>
            <Link href="/dashboard">
              <div
                className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors ${
                  location === "/dashboard"
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                }`}
                data-testid="link-dashboard"
              >
                <Activity className="h-3.5 w-3.5 shrink-0" />
                {!sidebarCollapsed && <span>Dashboard</span>}
              </div>
            </Link>
            {products?.map((p: any) => {
              const isActive = location === `/products/${p.id}`;
              return (
                <Link key={p.id} href={`/products/${p.id}`}>
                  <div
                    className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors ${
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                    }`}
                    data-testid={`link-product-${p.id}`}
                  >
                    <Gamepad2 className="h-3.5 w-3.5 shrink-0" />
                    {!sidebarCollapsed && (
                      <span className="truncate">{p.title}</span>
                    )}
                  </div>
                </Link>
              );
            })}
          </nav>
        </ScrollArea>

        {/* Bottom section: App switching + Settings + Sign Out */}
        <div className="border-t border-sidebar-border p-2 space-y-0.5">
          <a
            href="/sentiment/"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
          >
            <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
            {!sidebarCollapsed && <span>SentimentPulse</span>}
          </a>
          <a
            href="/trips/"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
          >
            <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
            {!sidebarCollapsed && <span>Trip Tracker</span>}
          </a>
          <a
            href="/genrepulse/"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
          >
            <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
            {!sidebarCollapsed && <span>Genre Pulse</span>}
          </a>
          <a
            href="/gtm/"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
          >
            <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
            {!sidebarCollapsed && <span>GTM Studio</span>}
          </a>
          <a
            href="/"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
          >
            <Home className="h-3.5 w-3.5 shrink-0" />
            {!sidebarCollapsed && <span>Suite Home</span>}
          </a>
          <Link href="/inbox">
            <div
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors ${
                location === "/inbox"
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
              }`}
              data-testid="link-inbox"
            >
              <InboxIcon className="h-3.5 w-3.5 shrink-0" />
              {!sidebarCollapsed && (
                <span className="flex items-center gap-1.5 flex-1">
                  <span>Inbox</span>
                  {(inboxUnread?.unread ?? 0) > 0 && (
                    <span
                      className="ml-auto inline-flex items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold text-destructive-foreground min-w-[18px]"
                      data-testid="inbox-badge"
                    >
                      {inboxUnread!.unread}
                    </span>
                  )}
                </span>
              )}
            </div>
          </Link>
          <Link href="/settings">
            <div
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors ${
                location === "/settings"
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
              }`}
              data-testid="link-settings"
            >
              <Settings className="h-3.5 w-3.5 shrink-0" />
              {!sidebarCollapsed && <span>Settings</span>}
            </div>
          </Link>
          <button
            onClick={async () => {
              // Phase 2 (2026-08-13): also revoke the saber-auth session if
              // present, so signing out here signs out of the whole suite
              // (not just this app's client-side gate).
              try {
                const cfg = (window as unknown as {
                  __saberAuth?: { config?: { logoutUrl?: string } };
                }).__saberAuth?.config;
                const url = cfg?.logoutUrl || "/auth/api/logout";
                await fetch(url, { method: "POST", credentials: "include" });
              } catch {
                // best-effort; legacy sign-out still applies below
              }
              sessionStorage.removeItem("sp_authenticated");
              try { localStorage.removeItem("suite_authenticated"); } catch {}
              window.location.reload();
            }}
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs cursor-pointer transition-colors w-full text-left text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
            data-testid="button-sign-out"
          >
            <LogOut className="h-3.5 w-3.5 shrink-0" />
            {!sidebarCollapsed && <span>Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="row-start-2 overflow-y-auto overscroll-contain bg-background">
        {steamSession?.isExpired && (
          <Link href="/settings">
            <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-xs font-medium cursor-pointer hover:bg-red-700 transition-colors">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Steamworks session cookie expired — sales data has stopped updating. Click to reconnect in Settings.</span>
            </div>
          </Link>
        )}
        {children}
      </main>
    </div>
  );
}
