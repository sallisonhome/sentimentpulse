import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { ThemeProvider } from "@/components/theme-provider";
import NotFound from "@/pages/not-found";
import EventListPage from "@/pages/event-list";
import EventDetailPage from "@/pages/event-detail";
import MeetingDetailPage from "@/pages/meeting-detail";
import DashboardPage from "@/pages/dashboard";
import PerplexityAttribution from "@/components/PerplexityAttribution";

function AppRouter() {
  return (
    <Router hook={useHashLocation}>
    <Switch>
      <Route path="/" component={EventListPage} />
      <Route path="/events" component={EventListPage} />
      <Route path="/events/:id" component={EventDetailPage} />
      <Route path="/meetings/:id" component={MeetingDetailPage} />
      <Route path="/dashboard" component={DashboardPage} />
      <Route component={NotFound} />
    </Switch>
    </Router>
  );
}

const sidebarStyle = {
  "--sidebar-width": "17rem",
  "--sidebar-width-icon": "3.5rem",
};

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <SidebarProvider style={sidebarStyle as React.CSSProperties}>
            <div className="flex h-screen w-full overflow-hidden">
              <AppSidebar />
              <div className="flex flex-col flex-1 min-w-0">
                <header className="flex items-center justify-between px-4 py-2 border-b bg-background/80 backdrop-blur-sm h-12 shrink-0">
                  <div className="flex items-center gap-2">
                    <SidebarTrigger data-testid="button-sidebar-toggle" className="text-muted-foreground" />
                    <div className="flex items-center gap-2 ml-1">
                      <EgsLogo />
                      <span className="font-semibold text-sm tracking-tight">Trip/Show & Partner Meeting Report Tracker</span>
                    </div>
                  </div>
                  <ThemeToggle />
                </header>
                <main className="flex-1 overflow-auto" data-testid="main-content">
                  <AppRouter />
                </main>
              </div>
            </div>
          </SidebarProvider>
          <Toaster />
          <PerplexityAttribution />
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function EgsLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-label="EGS Trip Tracker" xmlns="http://www.w3.org/2000/svg">
      <rect width="22" height="22" rx="5" fill="hsl(var(--primary))" />
      <path d="M4 7h9M4 11h6M4 15h9" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
      <circle cx="17" cy="11" r="3" stroke="white" strokeWidth="1.5"/>
      <path d="M15.5 11h3M17 9.5v3" stroke="white" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}
