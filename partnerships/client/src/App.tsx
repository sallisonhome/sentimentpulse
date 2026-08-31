import { Route, Router, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import ProductDetail from "./pages/ProductDetail";
import NotFound from "./pages/NotFound";

// Wouter with hash-based routing so this SPA works cleanly under the
// `/partnerships/` nginx alias without needing history-mode rewrites.
export default function App() {
  return (
    <Router hook={useHashLocation}>
      <Layout>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/titles/:id">
            {(params) => <ProductDetail productId={Number(params.id)} />}
          </Route>
          <Route component={NotFound} />
        </Switch>
      </Layout>
    </Router>
  );
}
