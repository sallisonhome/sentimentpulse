// Dashboard "On Promo Now" summary card.
//
// Lists every Saber title currently on promo (across all platforms) with
// the combined single-line badge next to the title. Sorted alphabetically
// by title. Empty state shows a short explainer + a link to the Promo
// Calendar itself.
//
// Data source: /api/onpromo/all — one shared fetch, no per-title fan-out.
// The route already omits titles with zero active promos, so the card
// renders either N entries or the empty state, never a placeholder row.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Flame, ExternalLink } from "lucide-react";
import { OnPromoBadge } from "@/components/OnPromoBadge";

interface OnPromoAllResponse {
  [steamAppId: string]: { platform: string; end_date: string }[];
}

interface ProductLite {
  id: number;
  title: string;
  steamAppId?: string | null;
}

export interface OnPromoNowCardProps {
  // Products list from the Dashboard's existing `/api/products` query —
  // reused so we can resolve steamAppId → title without another network
  // hop. Passing it as a prop keeps the card cheap and prevents a
  // dangling query when products are still loading.
  products: ProductLite[] | undefined;
}

// Prod-vs-dev Promo Calendar UI URL. In production the Promo Calendar SPA
// is mounted at `/promo/`; in local dev it's typically on port 5003 but
// the "Open Promo Calendar" button is a nice-to-have there — the same
// `/promo/` relative link works in the deployed build and is a harmless
// 404 locally.
const PROMO_CALENDAR_URL = "/promo/";

export function OnPromoNowCard({ products }: OnPromoNowCardProps) {
  const { data: promos, isLoading } = useQuery<OnPromoAllResponse>({
    queryKey: ["/api/onpromo/all"],
    // Match the server-side cache. Keeping this in step means opening the
    // dashboard doesn't force a fresh fan-out to the promo backend for
    // every navigation.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  // Build the row list: pair each on-promo AppID with its SignalPulse
  // title, drop AppIDs SignalPulse doesn't know about (defensive — the
  // mapping table SHOULD only contain known titles, but a stale server
  // deploy vs a fresh client is worth guarding against), and sort by
  // title A→Z.
  const rows = useMemo(() => {
    if (!promos || !products) return [];
    const byAppId = new Map<string, ProductLite>();
    for (const p of products) {
      if (p.steamAppId) byAppId.set(String(p.steamAppId), p);
    }
    const items: { productId: number; title: string; steamAppId: string; promos: OnPromoAllResponse[string] }[] = [];
    for (const [appId, entries] of Object.entries(promos)) {
      const product = byAppId.get(appId);
      if (!product) continue;
      items.push({ productId: product.id, title: product.title, steamAppId: appId, promos: entries });
    }
    items.sort((a, b) => a.title.localeCompare(b.title));
    return items;
  }, [promos, products]);

  return (
    <Card className="p-4" data-testid="card-on-promo-now">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Flame className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          <h3 className="text-sm font-semibold">On Promo Now</h3>
        </div>
        <a
          href={PROMO_CALENDAR_URL}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="link-open-promo-calendar"
        >
          Open Promo Calendar
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-4/5" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground py-2">
          No titles currently on promo — check back after the next scheduled sale window.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.productId}
              className="flex items-center gap-3 flex-wrap"
              data-testid={`row-on-promo-${row.productId}`}
            >
              <span className="text-sm font-medium min-w-0 truncate">{row.title}</span>
              <OnPromoBadge
                promos={row.promos}
                size="sm"
                testId={`badge-on-promo-dashboard-${row.productId}`}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
