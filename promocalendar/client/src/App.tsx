import { Router, Route, Switch, useParams } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import CalendarPage from "./pages/CalendarPage";
import TitlesPage from "./pages/TitlesPage";
import TitleDetailPage from "./pages/TitleDetailPage";
import { PlatformsIndex, PlatformDetail } from "./pages/PlatformsPage";
import EventsPage from "./pages/EventsPage";
import EventDetailPage from "./pages/EventDetailPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import SettingsPage from "./pages/SettingsPage";
import { Shell } from "./components/Shell";
import { ThemeProvider } from "./components/theme-provider";

function TitleRoute() {
  const { code } = useParams<{ code: string }>();
  return <TitleDetailPage code={decodeURIComponent(code)} />;
}
function PlatformRoute() {
  const { platform } = useParams<{ platform: string }>();
  return <PlatformDetail platform={decodeURIComponent(platform)} />;
}
function EventRoute() {
  const { key } = useParams<{ key: string }>();
  return <EventDetailPage eventKey={key} />;
}

function NotFound() {
  return (
    <Shell active="calendar" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Not found" }]}>
      <div className="empty">
        <h3>Page not found</h3>
        <p>Try the sidebar to navigate.</p>
      </div>
    </Shell>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Router hook={useHashLocation}>
        <Switch>
          <Route path="/" component={CalendarPage} />
          <Route path="/titles" component={TitlesPage} />
          <Route path="/titles/:code" component={TitleRoute} />
          <Route path="/platforms" component={PlatformsIndex} />
          <Route path="/platforms/:platform" component={PlatformRoute} />
          <Route path="/events" component={EventsPage} />
          <Route path="/events/:key" component={EventRoute} />
          <Route path="/analytics" component={AnalyticsPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route component={NotFound} />
        </Switch>
      </Router>
    </ThemeProvider>
  );
}
