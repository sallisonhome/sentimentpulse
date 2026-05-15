import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "./lib/hashLocation";
import { Sidebar } from "./components/Sidebar";
import { DeckThemeProvider } from "./lib/theme";
import { Home } from "./pages/Home";
import { Library } from "./pages/Library";
import { NewWizard } from "./pages/NewWizard";
import { Preview } from "./pages/Preview";
import { Download } from "./pages/Download";
import { Example } from "./pages/Example";
import { Admin } from "./pages/Admin";
import { NotFound } from "./pages/NotFound";

export default function App() {
  return (
    <DeckThemeProvider>
      <div className="flex min-h-screen bg-bg text-ink">
        <Sidebar />
        <main className="flex-1 min-w-0">
          <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-8">
            <Router hook={useHashLocation}>
              <Switch>
                <Route path="/" component={Home} />
                <Route path="/library" component={Library} />
                <Route path="/new" component={NewWizard} />
                <Route path="/preview/:sessionId" component={Preview} />
                <Route path="/decks/:deckId" component={Download} />
                <Route path="/example" component={Example} />
                <Route path="/admin" component={Admin} />
                <Route component={NotFound} />
              </Switch>
            </Router>
          </div>
        </main>
      </div>
    </DeckThemeProvider>
  );
}
