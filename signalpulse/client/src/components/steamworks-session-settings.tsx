// ─── Steamworks Session Cookie settings block (v3.1, 2026-08-11) ────────
//
// Renders a card on the Settings page for pasting the user's logged-in
// Steamworks session cookie (raw "Cookie: ..." header value from browser
// DevTools). Used by the portal fetcher for products whose CSV export
// path returns empty (Focus-published titles like Space Marine 2).

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Cookie, CheckCircle2, XCircle, Trash2, Beaker } from "lucide-react";

interface SessionInfo {
  configured: boolean;
  loggedInAs?: string | null;
  lastVerifiedAt?: string | null;
  lastVerifiedResult?: string | null;
  cookiePreview?: string;
  cookieByteLength?: number;
  updatedAt?: string;
}

export function SteamworksSessionSettings() {
  const qc = useQueryClient();
  const [cookieValue, setCookieValue] = useState("");
  // Individual cookie fields — fastest way to grab from DevTools Application
  // tab since document.cookie in Console cannot see HttpOnly cookies like
  // steamLoginSecure.
  const [cookieMode, setCookieMode] = useState<"fields" | "raw">("fields");
  const [sessionid, setSessionid] = useState("");
  const [steamCountry, setSteamCountry] = useState("");
  const [steamLoginSecure, setSteamLoginSecure] = useState("");
  const [browserid, setBrowserid] = useState("");
  const [loggedInAs, setLoggedInAs] = useState("");
  const [testResult, setTestResult] = useState<any>(null);
  const [testAppId, setTestAppId] = useState("2183900"); // SM2 default

  // Assemble the header string from individual fields.
  const assembleCookieString = () => {
    const parts: string[] = [];
    if (sessionid.trim()) parts.push(`sessionid=${sessionid.trim()}`);
    if (steamLoginSecure.trim()) parts.push(`steamLoginSecure=${steamLoginSecure.trim()}`);
    if (steamCountry.trim()) parts.push(`steamCountry=${steamCountry.trim()}`);
    if (browserid.trim()) parts.push(`browserid=${browserid.trim()}`);
    return parts.join("; ");
  };

  const { data: session } = useQuery<SessionInfo>({
    queryKey: ["/api/steam/session"],
  });

  useEffect(() => {
    if (session?.loggedInAs) setLoggedInAs(session.loggedInAs);
  }, [session?.loggedInAs]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const finalCookieValue = cookieMode === "fields" ? assembleCookieString() : cookieValue.trim();
      if (!finalCookieValue) throw new Error("Nothing to save");
      const resp = await fetch("./api/steam/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookieValue: finalCookieValue, loggedInAs: loggedInAs.trim() || null }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      return resp.json();
    },
    onSuccess: () => {
      setCookieValue("");
      setSessionid("");
      setSteamCountry("");
      setSteamLoginSecure("");
      setBrowserid("");
      qc.invalidateQueries({ queryKey: ["/api/steam/session"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const resp = await fetch("./api/steam/session", { method: "DELETE" });
      if (!resp.ok) throw new Error(await resp.text());
      return resp.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/steam/session"] });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      // Test with a 1-day window (yesterday) so it's a small fetch
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      // Find product by steamAppId (naive — we don't have a lookup endpoint)
      const productsResp = await fetch("./api/products");
      const products = await productsResp.json();
      const targetAppId = Number(testAppId);
      const product = products.find((p: any) => Number(p.steamAppId) === targetAppId);
      if (!product) throw new Error(`No product found with steamAppId=${testAppId}`);

      const resp = await fetch("./api/steam/portal/test-fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, dateStart: yesterday, dateEnd: yesterday }),
      });
      const data = await resp.json();
      return data;
    },
    onSuccess: (data) => {
      setTestResult(data);
      qc.invalidateQueries({ queryKey: ["/api/steam/session"] });
    },
    onError: (err: any) => {
      setTestResult({ ok: false, error: err.message });
    },
  });

  const verifiedOk = session?.lastVerifiedResult === "ok";
  const verifiedFail = session?.lastVerifiedResult && session.lastVerifiedResult !== "ok";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cookie className="h-5 w-5" />
          Steamworks Session Cookie
        </CardTitle>
        <CardDescription>
          Used to fetch sales data from Steamworks partner pages for titles where the
          CSV export is empty (e.g. Space Marine 2, published by Focus Entertainment).
          The cookie stays on the droplet and is never shown in full after save.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current status */}
        {session?.configured && (
          <div className="rounded border p-3 bg-muted/30 space-y-1">
            <div className="text-xs font-medium flex items-center gap-2">
              {verifiedOk ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> :
               verifiedFail ? <XCircle className="w-4 h-4 text-red-600" /> :
               <Cookie className="w-4 h-4 text-muted-foreground" />}
              Configured: {session.cookiePreview} ({session.cookieByteLength} bytes)
            </div>
            {session.loggedInAs && (
              <div className="text-xs text-muted-foreground">
                Logged in as: {session.loggedInAs}
              </div>
            )}
            {session.lastVerifiedAt && (
              <div className="text-xs text-muted-foreground">
                Last verified: {new Date(session.lastVerifiedAt).toLocaleString()} · {session.lastVerifiedResult}
              </div>
            )}
            <div className="pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (confirm("Delete the stored Steamworks session cookie? Portal fetches will stop working until you paste a new one.")) {
                    deleteMutation.mutate();
                  }
                }}
                className="h-7 text-xs gap-1"
              >
                <Trash2 className="w-3 h-3" /> Remove stored cookie
              </Button>
            </div>
          </div>
        )}

        {/* Instructions */}
        <div className="text-xs text-muted-foreground space-y-1 border-l-2 pl-3">
          <div className="font-medium text-foreground">How to grab your cookie:</div>
          <ol className="list-decimal ml-4 space-y-0.5">
            <li>Log in to <code className="text-[10px]">partner.steampowered.com</code> in Chrome/Edge.</li>
            <li>Open DevTools (F12) → <strong>Application</strong> tab (click » overflow if hidden).</li>
            <li>Left sidebar: <strong>Storage</strong> → <strong>Cookies</strong> → click <code className="text-[10px]">https://partner.steampowered.com</code>.</li>
            <li>Find the rows named <code className="text-[10px]">sessionid</code>, <code className="text-[10px]">steamLoginSecure</code>, and <code className="text-[10px]">steamCountry</code>. Double-click each Value cell to select it, then Ctrl+C.</li>
            <li>Paste each value into its own field below. Save. (Note: <code className="text-[10px]">document.cookie</code> in Console will NOT work because steamLoginSecure is HttpOnly.)</li>
          </ol>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-2 text-xs">
          <Button
            variant={cookieMode === "fields" ? "default" : "outline"}
            size="sm"
            onClick={() => setCookieMode("fields")}
            className="h-7 text-xs"
            data-testid="button-mode-fields"
          >
            Individual fields (recommended)
          </Button>
          <Button
            variant={cookieMode === "raw" ? "default" : "outline"}
            size="sm"
            onClick={() => setCookieMode("raw")}
            className="h-7 text-xs"
            data-testid="button-mode-raw"
          >
            Raw Cookie header
          </Button>
        </div>

        {/* Cookie entry — individual fields */}
        {cookieMode === "fields" && (
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="cookie-sessionid" className="text-xs">
                sessionid <span className="text-muted-foreground">(short, ~24 chars)</span>
              </Label>
              <Input
                id="cookie-sessionid"
                type="password"
                value={sessionid}
                onChange={(e) => setSessionid(e.target.value)}
                placeholder="e.g. 8f2a5b3c9d1e4f6a..."
                className="h-8 text-xs font-mono"
                data-testid="input-sessionid"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cookie-loginsecure" className="text-xs">
                steamLoginSecure <span className="text-muted-foreground">(long, the important one)</span>
              </Label>
              <Input
                id="cookie-loginsecure"
                type="password"
                value={steamLoginSecure}
                onChange={(e) => setSteamLoginSecure(e.target.value)}
                placeholder="e.g. 76561198...%7C%7C..."
                className="h-8 text-xs font-mono"
                data-testid="input-loginsecure"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cookie-country" className="text-xs">
                steamCountry <span className="text-muted-foreground">(optional but recommended)</span>
              </Label>
              <Input
                id="cookie-country"
                value={steamCountry}
                onChange={(e) => setSteamCountry(e.target.value)}
                placeholder="e.g. US%7C..."
                className="h-8 text-xs font-mono"
                data-testid="input-country"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cookie-browserid" className="text-xs">
                browserid <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="cookie-browserid"
                value={browserid}
                onChange={(e) => setBrowserid(e.target.value)}
                placeholder="e.g. 3123456789..."
                className="h-8 text-xs font-mono"
                data-testid="input-browserid"
              />
            </div>
            {sessionid && steamLoginSecure && (
              <div className="text-[10px] text-muted-foreground">
                Will assemble to: <code>sessionid=...; steamLoginSecure=...{steamCountry ? "; steamCountry=..." : ""}{browserid ? "; browserid=..." : ""}</code> ({assembleCookieString().length} bytes)
              </div>
            )}
          </div>
        )}

        {/* Cookie entry — raw mode */}
        {cookieMode === "raw" && (
          <div className="space-y-2">
            <Label htmlFor="cookie-value" className="text-xs">Cookie header value (whole string)</Label>
            <textarea
              id="cookie-value"
              value={cookieValue}
              onChange={(e) => setCookieValue(e.target.value)}
              placeholder="steamLoginSecure=76561...; sessionid=abc123; steamCountry=US%7C...; ..."
              className="w-full min-h-[80px] p-2 text-xs font-mono border rounded resize-y bg-background"
              data-testid="input-steamworks-cookie"
            />
            <div className="text-[10px] text-muted-foreground">
              {cookieValue.length} bytes. Must include steamLoginSecure to authenticate.
            </div>
          </div>
        )}

        {/* Save row (shared) */}
        <div className="grid grid-cols-2 gap-2 items-end">
          <div>
            <Label htmlFor="logged-in-as" className="text-xs">Your login (optional, for reference)</Label>
            <Input
              id="logged-in-as"
              value={loggedInAs}
              onChange={(e) => setLoggedInAs(e.target.value)}
              placeholder="sabersteve3"
              className="h-8 text-xs"
            />
          </div>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={
              saveMutation.isPending ||
              (cookieMode === "fields" ? !(sessionid.trim() && steamLoginSecure.trim()) : !cookieValue.trim())
            }
            size="sm"
            className="h-8 text-xs"
            data-testid="button-save-cookie"
          >
            {saveMutation.isPending ? "Saving..." : "Save cookie"}
          </Button>
        </div>
        {saveMutation.isError && (
          <div className="text-xs text-red-600">Save failed: {(saveMutation.error as any)?.message}</div>
        )}
        {saveMutation.isSuccess && (
          <div className="text-xs text-emerald-600">Saved. Run a test fetch below to verify.</div>
        )}

        {/* Test fetch */}
        {session?.configured && (
          <div className="border-t pt-3 space-y-2">
            <Label className="text-xs flex items-center gap-2">
              <Beaker className="w-3 h-3" /> Test fetch (yesterday, one product)
            </Label>
            <div className="flex gap-2">
              <Input
                value={testAppId}
                onChange={(e) => setTestAppId(e.target.value)}
                placeholder="Steam App ID"
                className="h-8 text-xs flex-1"
              />
              <Button
                onClick={() => { setTestResult(null); testMutation.mutate(); }}
                disabled={testMutation.isPending || !testAppId.trim()}
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                data-testid="button-test-fetch"
              >
                {testMutation.isPending ? "Fetching..." : "Test fetch"}
              </Button>
            </div>
            {testResult && (
              <div className={`text-xs rounded border p-2 space-y-1 ${
                testResult.ok ? "bg-emerald-500/5 border-emerald-500/50" : "bg-red-500/5 border-red-500/50"
              }`}>
                {testResult.ok ? (
                  <>
                    <div className="font-medium">
                      Fetch OK · HTTP {testResult.httpStatus} · {testResult.htmlBytes?.toLocaleString()} bytes
                    </div>
                    {testResult.parsed && (
                      <div className="text-[10px] space-y-0.5">
                        <div>App: {testResult.parsed.appName ?? "(name not parsed)"}</div>
                        <div>Lifetime Steam units: {testResult.parsed.lifetimeSteamUnits?.toLocaleString() ?? "?"}</div>
                        <div>Lifetime Steam revenue net: ${testResult.parsed.lifetimeSteamRevenueNetUsd?.toLocaleString() ?? "?"}</div>
                        <div>Lifetime DLC units: {testResult.parsed.lifetimeTotalDlcUnits?.toLocaleString() ?? "?"}</div>
                        <div>Period Steam units: {testResult.parsed.periodSteamUnits?.toLocaleString() ?? "?"}</div>
                        <div>Period Steam revenue: ${testResult.parsed.periodSteamRevenueUsd?.toLocaleString() ?? "?"}</div>
                        <div>Period DLC units: {testResult.parsed.periodDlcUnits?.toLocaleString() ?? "?"}</div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="font-medium">Fetch failed · HTTP {testResult.httpStatus ?? "?"}</div>
                    <div className="text-[10px]">{testResult.error}</div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
