/**
 * Amazon ASIN Pins editor.
 *
 * Renders one row per SignalPulse product; each row has PS5 / Xbox / Switch /
 * Switch 2 cells but ONLY for platforms that product actually lists in its
 * SignalPulse `platforms` array (source of truth). Empty cells for hidden
 * platforms so the layout stays aligned.
 *
 * Each cell shows the current pinned ASIN (with an "auto" badge if the
 * pin was auto-discovered) and lets the user paste an Amazon URL or raw
 * ASIN to overwrite it. Save writes to POST /api/amazon/asin-map with
 * isAuto=false (so the tightened auto-discovery won't clobber it next run).
 *
 * A "Reset auto pins" action at the top wipes every isAuto=true pin
 * (Saber + competitors). Use after cleaning up the mapping table.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Package, RotateCcw, Loader2, ExternalLink } from "lucide-react";

interface Product {
  id: number;
  title: string;
  platforms: string; // JSON array string
}

interface AsinMapRow {
  id: number;
  productId: number;
  platform: "ps5" | "xbox" | "switch";
  asin: string;
  isAuto: boolean;
  isActive: boolean;
  isSwitch2: boolean;
  matchScore: number | null;
}

// Extract an ASIN from a raw string. Accepts a bare ASIN ("B0CVSDJNKS"),
// an Amazon URL (any /dp/<asin> or /gp/product/<asin> pattern), or noisy
// text that contains one. Returns null if nothing matches.
function extractAsin(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // /dp/ASIN or /gp/product/ASIN
  const urlMatch = s.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  // Bare 10-char ASIN (must start with B for physical goods, but allow any
  // 10-char alnum to be safe).
  if (/^[A-Z0-9]{10}$/i.test(s)) return s.toUpperCase();
  // Anywhere in the string
  const anywhere = s.match(/\b([A-Z0-9]{10})\b/);
  if (anywhere) return anywhere[1].toUpperCase();
  return null;
}

type PlatformCell = "ps5" | "xbox" | "switch" | "switch2";

// Which platform cells should show for a given product, keyed off the
// SignalPulse product.platforms array. Cells for hidden platforms are
// rendered as an empty grid slot so alignment stays.
function platformsForProduct(platformsJson: string): Record<PlatformCell, boolean> {
  let list: string[] = [];
  try {
    const parsed = JSON.parse(platformsJson ?? "[]");
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    // ignore
  }
  const anyPs5 = list.some((x) => /ps5|playstation\s*5/i.test(x));
  const anyXbox = list.some((x) => /xbox/i.test(x));
  const anySwitch1 = list.some((x) => /\bswitch\b/i.test(x) && !/switch\s*2/i.test(x));
  const anySwitch2 = list.some((x) => /switch\s*2/i.test(x));
  return {
    ps5: anyPs5,
    xbox: anyXbox,
    switch: anySwitch1,
    switch2: anySwitch2,
  };
}

// The ASIN-map storage model uses platform=switch + isSwitch2 flag for
// Switch 2 pins. This helper picks the pin (if any) for a given product +
// display cell from the flat pin list.
function findPin(pins: AsinMapRow[], productId: number, cell: PlatformCell): AsinMapRow | null {
  if (cell === "switch2") {
    return pins.find((p) => p.productId === productId && p.platform === "switch" && p.isSwitch2 && p.isActive) ?? null;
  }
  if (cell === "switch") {
    return pins.find((p) => p.productId === productId && p.platform === "switch" && !p.isSwitch2 && p.isActive) ?? null;
  }
  return pins.find((p) => p.productId === productId && p.platform === cell && p.isActive) ?? null;
}

export function AmazonAsinPins() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const { data: products } = useQuery<Product[]>({ queryKey: ["/api/products"] });
  const { data: pinsResp, isLoading: pinsLoading } = useQuery<{ rows: AsinMapRow[] }>({
    queryKey: ["/api/amazon/asin-map"],
  });
  const pins = pinsResp?.rows ?? [];

  const saveMutation = useMutation({
    mutationFn: async (args: { productId: number; cell: PlatformCell; asin: string }) => {
      const platform = args.cell === "switch2" ? "switch" : args.cell;
      const isSwitch2 = args.cell === "switch2";
      return apiRequest("POST", "/api/amazon/asin-map", {
        productId: args.productId,
        platform,
        asin: args.asin,
        isSwitch2,
        isAuto: false,
        isActive: true,
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (pinId: number) => {
      return apiRequest("DELETE", `/api/amazon/asin-map/${pinId}`, undefined);
    },
  });

  const clearAutoMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/amazon/asin-map/auto-clear", {});
    },
    onSuccess: async (resp: any) => {
      const body = await resp.json().catch(() => ({}));
      toast({
        title: "Auto pins cleared",
        description: `Removed ${body.deletedSaberPins ?? 0} Saber + ${body.deletedCompetitorPins ?? 0} competitor auto-discovered pins.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/amazon/asin-map"] });
    },
    onError: () => {
      toast({ title: "Reset failed", description: "Could not clear auto pins.", variant: "destructive" });
    },
  });

  const keyFor = (productId: number, cell: PlatformCell) => `${productId}|${cell}`;

  const handleSave = async (productId: number, productTitle: string, cell: PlatformCell) => {
    const draftKey = keyFor(productId, cell);
    const raw = drafts[draftKey] ?? "";
    const asin = extractAsin(raw);
    if (!asin) {
      toast({
        title: "Invalid ASIN",
        description: "Paste an Amazon URL (e.g. amazon.com/dp/B0XXXXXXXX) or a raw 10-char ASIN.",
        variant: "destructive",
      });
      return;
    }
    setSaving((s) => ({ ...s, [draftKey]: true }));
    try {
      await saveMutation.mutateAsync({ productId, cell, asin });
      toast({ title: "Saved", description: `${productTitle} · ${cellLabel(cell)} → ${asin}` });
      setDrafts((d) => { const next = { ...d }; delete next[draftKey]; return next; });
      queryClient.invalidateQueries({ queryKey: ["/api/amazon/asin-map"] });
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message ?? String(err), variant: "destructive" });
    } finally {
      setSaving((s) => { const next = { ...s }; delete next[draftKey]; return next; });
    }
  };

  const handleClear = async (pinId: number, productTitle: string, cellName: string) => {
    try {
      await deleteMutation.mutateAsync(pinId);
      toast({ title: "Pin removed", description: `${productTitle} · ${cellName}` });
      queryClient.invalidateQueries({ queryKey: ["/api/amazon/asin-map"] });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err?.message ?? String(err), variant: "destructive" });
    }
  };

  // Sort products alphabetically; guarantees stable layout.
  const sortedProducts = useMemo(() => {
    return (products ?? []).slice().sort((a, b) => a.title.localeCompare(b.title));
  }, [products]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
              <Package className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Amazon ASIN Pins</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                One ASIN per SignalPulse title per platform. Paste an Amazon URL or raw ASIN. Only platforms in each title's SignalPulse card are shown.
              </CardDescription>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirm("Wipe every auto-discovered pin (Saber + competitors)? Manual pins are kept.")) {
                clearAutoMutation.mutate();
              }
            }}
            disabled={clearAutoMutation.isPending}
            className="h-8 text-xs"
          >
            {clearAutoMutation.isPending ? (
              <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3 mr-1.5" />
            )}
            Reset auto pins
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {pinsLoading || !products ? (
          <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>
        ) : sortedProducts.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">No products yet.</div>
        ) : (
          <div className="space-y-3">
            {sortedProducts.map((product) => {
              const show = platformsForProduct(product.platforms);
              const anyShown = show.ps5 || show.xbox || show.switch || show.switch2;
              return (
                <div key={product.id} className="rounded-lg border p-3 space-y-2">
                  <div className="text-sm font-medium truncate">{product.title}</div>
                  {!anyShown ? (
                    <div className="text-xs text-muted-foreground">No PS5, Xbox, Switch, or Switch 2 SKU listed in SignalPulse for this title.</div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
                      {(["ps5", "xbox", "switch", "switch2"] as PlatformCell[]).map((cell) => {
                        if (!show[cell]) {
                          return <div key={cell} className="hidden lg:block" />;
                        }
                        const pin = findPin(pins, product.id, cell);
                        const draftKey = keyFor(product.id, cell);
                        const draft = drafts[draftKey] ?? "";
                        const isSaving = !!saving[draftKey];
                        return (
                          <div key={cell} className="rounded-md border bg-muted/30 p-2 space-y-1.5">
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{cellLabel(cell)}</span>
                              {pin?.isAuto && <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">auto</Badge>}
                            </div>
                            {pin ? (
                              <div className="flex items-center gap-1 text-[11px] font-mono">
                                <a
                                  href={`https://www.amazon.com/dp/${pin.asin}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="truncate hover:underline text-foreground"
                                >
                                  {pin.asin}
                                </a>
                                <ExternalLink className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleClear(pin.id, product.title, cellLabel(cell))}
                                  className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive ml-auto"
                                >
                                  ×
                                </Button>
                              </div>
                            ) : (
                              <div className="text-[11px] text-muted-foreground italic">Not pinned</div>
                            )}
                            <div className="flex gap-1">
                              <Input
                                placeholder="Paste Amazon URL or ASIN"
                                value={draft}
                                onChange={(e) => setDrafts((d) => ({ ...d, [draftKey]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === "Enter") handleSave(product.id, product.title, cell); }}
                                className="h-7 text-[11px] font-mono"
                                data-testid={`input-asin-${product.id}-${cell}`}
                              />
                              <Button
                                size="sm"
                                onClick={() => handleSave(product.id, product.title, cell)}
                                disabled={!draft || isSaving}
                                className="h-7 text-[11px] px-2"
                                data-testid={`button-save-asin-${product.id}-${cell}`}
                              >
                                {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function cellLabel(cell: PlatformCell): string {
  switch (cell) {
    case "ps5": return "PS5";
    case "xbox": return "Xbox";
    case "switch": return "Switch";
    case "switch2": return "Switch 2";
  }
}
