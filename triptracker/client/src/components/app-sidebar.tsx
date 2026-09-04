import { useState } from "react";
import { useHashLocation } from "wouter/use-hash-location";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel,
  SidebarGroupContent, SidebarMenu, SidebarMenuItem, SidebarMenuButton,
  SidebarHeader, SidebarFooter,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { IngestModal } from "@/components/ingest-modal";
import {
  CalendarDays, LayoutDashboard, Map, UploadCloud, ArrowRightLeft, Home, Handshake, Calendar
} from "lucide-react";

const navItems = [
  { title: "Events & Trips", url: "/events", icon: CalendarDays },
  { title: "Games & Topics", url: "/dashboard", icon: LayoutDashboard },
];

export function AppSidebar() {
  const [loc] = useHashLocation();
  const [ingestOpen, setIngestOpen] = useState(false);

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-primary flex items-center justify-center">
            <Map className="w-3.5 h-3.5 text-primary-foreground" />
          </div>
          <div>
            <p className="text-xs font-semibold leading-tight">Saber Interactive</p>
            <p className="text-xs text-muted-foreground leading-tight">Trip/Show & Partner Meetings</p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map(item => {
                const isActive = loc === item.url || (item.url === "/events" && loc === "/");
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild data-active={isActive}>
                      <a href={`#${item.url}`}>
                        <item.icon className="w-4 h-4" />
                        <span>{item.title}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-4 py-3 border-t space-y-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start"
          onClick={() => setIngestOpen(true)}
          data-testid="sidebar-button-upload-report"
        >
          <UploadCloud className="w-3.5 h-3.5 mr-2" />Upload Report
        </Button>
        <div className="border-t pt-2 space-y-1">
          <a href="/sentiment/" className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors rounded">
            <ArrowRightLeft className="w-3.5 h-3.5" />SentimentPulse
          </a>
          <a href="/signal/" className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors rounded">
            <ArrowRightLeft className="w-3.5 h-3.5" />SignalPulse
          </a>
          <a href="/genrepulse/" className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors rounded">
            <ArrowRightLeft className="w-3.5 h-3.5" />Genre Pulse
          </a>
          <a href="/gtm/" className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors rounded">
            <ArrowRightLeft className="w-3.5 h-3.5" />GTM Studio
          </a>
          <a href="/partnerships/" className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors rounded">
            <Handshake className="w-3.5 h-3.5" />Publishing Partnerships
          </a>
          <a href="/promo/" className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors rounded">
            <Calendar className="w-3.5 h-3.5" />Promo Calendar
          </a>
          <a href="/" className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors rounded">
            <Home className="w-3.5 h-3.5" />Suite Home
          </a>
        </div>
        <IngestModal open={ingestOpen} onOpenChange={setIngestOpen} />
      </SidebarFooter>
    </Sidebar>
  );
}
