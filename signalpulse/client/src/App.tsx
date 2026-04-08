import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import ProductDetail from "@/pages/product-detail";
import Settings from "@/pages/settings";
import NotFound from "@/pages/not-found";
import { useState } from "react";
import { AddProductDialog } from "@/components/add-product-dialog";

function AppRouter() {
  const [addProductOpen, setAddProductOpen] = useState(false);

  return (
    <Layout onAddProduct={() => setAddProductOpen(true)}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/products/:id" component={ProductDetail} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
      <AddProductDialog open={addProductOpen} onOpenChange={setAddProductOpen} />
    </Layout>
  );
}

function App() {
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
