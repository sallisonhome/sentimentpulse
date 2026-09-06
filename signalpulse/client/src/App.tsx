import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Leaderboards from "@/pages/leaderboards";
import ProductDetail from "@/pages/product-detail";
import Settings from "@/pages/settings";
import Inbox from "@/pages/inbox";
import SalesByCountry from "@/pages/sales-by-country";
import AmazonIndex from "@/pages/amazon";
import AmazonProductDetail from "@/pages/amazon/product-detail";
import NotFound from "@/pages/not-found";
import { useEffect, useState } from "react";
import { AddProductDialog } from "@/components/add-product-dialog";
import { bootstrapAuth, type AuthBootstrap } from "@/lib/saber-auth";

function AppRouter() {
  const [addProductOpen, setAddProductOpen] = useState(false);

  return (
    <Layout onAddProduct={() => setAddProductOpen(true)}>
      <Switch>
        <Route path="/" component={Leaderboards} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/products/:id" component={ProductDetail} />
        <Route path="/settings" component={Settings} />
        <Route path="/inbox" component={Inbox} />
        <Route path="/sales-by-country" component={SalesByCountry} />
        {/* Amazon Retail app: /amazon lands on Charts; /amazon/:section
            picks the other sub-tabs; /amazon/product/:asin drills in. */}
        <Route path="/amazon/product/:asin" component={AmazonProductDetail} />
        <Route path="/amazon/:section" component={AmazonIndex} />
        <Route path="/amazon" component={AmazonIndex} />
        <Route component={NotFound} />
      </Switch>
      <AddProductDialog open={addProductOpen} onOpenChange={setAddProductOpen} />
    </Layout>
  );
}

function App() {
  // Phase 2 (2026-08-13): saber-auth bootstrap. In AUTH_MODE=saber this may
  // redirect to /auth/login.html before we ever render. In "both" and
  // "legacy" modes we render regardless; the returned user (if any) is
  // stashed on window.__saberAuth for the layout header.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    bootstrapAuth().then((b: AuthBootstrap) => {
      if (cancelled) return;
      // Expose for the layout / settings pages without threading context
      // through every component.
      (window as unknown as { __saberAuth?: AuthBootstrap }).__saberAuth = b;
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    // Render nothing (not even a spinner) while auth bootstraps — this is
    // typically <100ms and prevents a UI flash before a possible redirect.
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <AppRouter />
          </Router>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
