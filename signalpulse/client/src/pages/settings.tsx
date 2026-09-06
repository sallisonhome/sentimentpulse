import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Eye, EyeOff, Save, Check, KeyRound, Server, Shield, Youtube, Trash2, Gamepad2, AlertTriangle,
  Mail, Plus, Send, Loader2,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { SteamworksSessionSettings } from "@/components/steamworks-session-settings";
import { ManualIngestionControls } from "@/components/manual-ingestion-controls";

interface SettingRow {
  id: number;
  key: string;
  value: string;
  label: string;
  category: string;
  isSecret: boolean;
  isSet: boolean;
}

// Group settings into logical sections
const SECTIONS: { key: string; label: string; description: string; icon: React.ReactNode; settingKeys: string[] }[] = [
  {
    key: "steam",
    label: "Steam / Steamworks",
    description: "API credentials for pulling wishlist and pre-purchase data from the Steamworks Partner API.",
    icon: <Server className="h-5 w-5" />,
    settingKeys: ["steam_api_key", "steam_partner_id"],
  },
  {
    key: "sony",
    label: "Sony / PlayStation",
    description: "API credentials for pulling PS5 wishlist and pre-purchase data from the Sony Partner Portal.",
    icon: <KeyRound className="h-5 w-5" />,
    settingKeys: ["sony_api_key", "sony_partner_id"],
  },
  {
    key: "youtube",
    label: "YouTube Data API",
    description: "Google API key for tracking YouTube video view counts via the YouTube Data API v3.",
    icon: <Youtube className="h-5 w-5" />,
    settingKeys: ["youtube_api_key"],
  },
  {
    key: "perplexity",
    label: "Weekly Digest Narrative (Perplexity)",
    description: "Perplexity Sonar API key used to write the narrative paragraph under each Weekly Steam Leaderboard digest section. Leave unset to send the digest without narrative text.",
    icon: <KeyRound className="h-5 w-5" />,
    settingKeys: ["perplexity_api_key"],
  },
  {
    key: "igdb",
    label: "IGDB Hype Score (Twitch/IGDB)",
    description: "Twitch Client Credentials used to call the IGDB API directly for hype scores on every Wishlist Leaderboard title \u2014 the same key and calls howmanyareplaying.com uses internally. Leave unset to keep using the howmanyareplaying.com public Top 200 list (Saber titles outside that list won't get a hype score).",
    icon: <Gamepad2 className="h-5 w-5" />,
    settingKeys: ["twitch_client_id", "twitch_client_secret"],
  },
  {
    key: "rainforest",
    label: "Amazon Retail (Rainforest API)",
    description: "Rainforest API key powers the Amazon Retail app + Saber Amazon Leaderboard tab \u2014 nightly chart ingestion for PS5/Xbox/Switch, per-SKU Buy Box & Reviews Pulse, weekly Also-Bought recommendations, keyword Search SOV, and Movers/New-Releases feeds. Leave unset to disable all Amazon ingestion (the cron silently no-ops and the leaderboard shows an empty state).",
    icon: <KeyRound className="h-5 w-5" />,
    settingKeys: ["rainforest_api_key"],
  },
  {
    key: "security",
    label: "App Security",
    description: "Password required to access the application.",
    icon: <Shield className="h-5 w-5" />,
    settingKeys: ["app_password"],
  },
  {
    key: "email",
    label: "Weekly Digest (Resend)",
    description: "Resend API credentials used to send the weekly Steam Leaderboard digest email. Manage who receives it below.",
    icon: <Mail className="h-5 w-5" />,
    settingKeys: ["resend_api_key", "resend_from"],
  },
  {
    key: "email_inbound",
    label: "Inbox (Resend Inbound)",
    description: "Configure how howmanyareplaying.com receives inbound email. Every message is stored in the SignalPulse Inbox and forwarded to your personal address.",
    icon: <Mail className="h-5 w-5" />,
    settingKeys: [
      "resend_inbound_receiving_domain",
      "resend_inbound_signing_secret",
      "resend_inbound_forward_enabled",
      "resend_inbound_forward_to",
    ],
  },
];

function SettingField({ setting, onSaved }: { setting: SettingRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [saved, setSaved] = useState(false);
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (newValue: string) => {
      // v1.1 (2026-07-22): surface the real backend error instead of a
      // generic 'Failed to save' toast. Previously any non-2xx and any
      // network/parse failure collapsed into 'Failed to save setting.'
      // which made it impossible to diagnose live user reports.
      let res: Response;
      try {
        // v1.1 (2026-07-22): use relative path so the fetch respects
        // the /signal/ base path in production. Absolute '/api/...'
        // went to http://host/api/... which nginx 404s (the API is
        // mounted at /signal/api/... behind nginx).
        res = await fetch(`./api/settings/${setting.key}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: newValue }),
        });
      } catch (netErr: any) {
        throw new Error(`Network error: ${netErr?.message || "could not reach server"}`);
      }
      if (!res.ok) {
        // Try to pull { error: '...' } out of the response body for context.
        let detail = "";
        try {
          const body = await res.clone().json();
          if (body?.error) detail = ` — ${body.error}`;
          else if (typeof body === "string") detail = ` — ${body}`;
        } catch {
          try {
            const txt = await res.text();
            if (txt) detail = ` — ${txt.slice(0, 200)}`;
          } catch {}
        }
        throw new Error(`HTTP ${res.status}${detail}`);
      }
      try {
        return await res.json();
      } catch (parseErr: any) {
        throw new Error(`Server returned invalid JSON: ${parseErr?.message || "parse failed"}`);
      }
    },
    onSuccess: () => {
      toast({ title: "Saved", description: `${setting.label} updated successfully.` });
      setEditing(false);
      setValue("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    },
    onError: (err: any) => {
      const description = err?.message
        ? `Failed to save ${setting.label}: ${err.message}`
        : `Failed to save ${setting.label}.`;
      toast({ title: "Save failed", description, variant: "destructive" });
      // Also log to console for engineering diagnosis.
      // eslint-disable-next-line no-console
      console.error(`[settings save] ${setting.key} failed:`, err);
    },
  });

  const handleSave = () => {
    if (!value.trim()) return;
    mutation.mutate(value.trim());
  };

  const handleCancel = () => {
    setEditing(false);
    setValue("");
  };

  return (
    <div className="flex items-start gap-4 py-3">
      <div className="flex-1 min-w-0">
        <Label className="text-sm font-medium">{setting.label}</Label>
        <div className="text-xs text-muted-foreground mt-0.5 font-mono">{setting.key}</div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!editing ? (
          <>
            <div className="flex items-center gap-2">
              {setting.isSet ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-1 rounded-md">
                  <Check className="h-3 w-3" />
                  Configured
                </span>
              ) : (
                <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md">Not set</span>
              )}
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {setting.isSet ? "Change" : "Set"}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <div className="relative">
              <Input
                type={showValue ? "text" : "password"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={`Enter ${setting.label.toLowerCase()}`}
                className="w-64 pr-9 h-9 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                  if (e.key === "Escape") handleCancel();
                }}
              />
              <button
                type="button"
                onClick={() => setShowValue(!showValue)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!value.trim() || mutation.isPending}
              className="gap-1"
            >
              <Save className="h-3.5 w-3.5" />
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        )}

        {saved && !editing && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400 animate-in fade-in">Saved</span>
        )}
      </div>
    </div>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<SettingRow[]>({
    queryKey: ["/api/settings"],
  });

  const handleSaved = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
  };

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-48" />
          <div className="h-4 bg-muted rounded w-96" />
          <div className="h-40 bg-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage API keys and application configuration. Secret values are encrypted and never displayed after being saved.
        </p>
      </div>

      {SECTIONS.map((section) => {
        const sectionSettings = settings?.filter(s => section.settingKeys.includes(s.key)) || [];
        if (sectionSettings.length === 0) return null;

        return (
          <Card key={section.key}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
                  {section.icon}
                </div>
                <div>
                  <CardTitle className="text-base">{section.label}</CardTitle>
                  <CardDescription className="text-xs mt-0.5">{section.description}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {section.key === "email_inbound" && (
                <div className="mb-4 p-3 rounded-md bg-muted/50 border text-xs space-y-2">
                  <div className="font-medium">One-time DNS setup</div>
                  <div className="text-muted-foreground">
                    1. In Resend dashboard, go to <b>Emails → Receiving</b>. Add
                    the domain in <i>Receiving Domain</i> above (default:
                    howmanyareplaying.com) and copy the MX record Resend shows.
                  </div>
                  <div className="text-muted-foreground">
                    2. At your DNS provider add that MX record on the same
                    domain. Wait for Resend to mark it verified (usually
                    &lt;5 min).
                  </div>
                  <div className="text-muted-foreground">
                    3. In Resend, add a webhook for the
                    <code className="mx-1 px-1 py-0.5 bg-background rounded">email.received</code>
                    event pointing at:
                    <code className="ml-1 px-1 py-0.5 bg-background rounded break-all">
                      {typeof window !== "undefined" ? window.location.origin : ""}/api/webhooks/resend-inbound
                    </code>
                  </div>
                  <div className="text-muted-foreground">
                    4. Copy the webhook <b>Signing Secret</b> (starts with
                    <code className="mx-1 px-1 py-0.5 bg-background rounded">whsec_</code>)
                    into the field below. Once saved, all inbound email lands in the
                    <a href="/#/inbox" className="text-primary underline ml-1">Inbox</a>.
                  </div>
                </div>
              )}
              <div className="divide-y">
                {sectionSettings.map(setting => (
                  <SettingField key={setting.key} setting={setting} onSaved={handleSaved} />
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}

      <RecipientsManager />

      <ManualIngestionControls />

      <SteamworksSessionSettings />

      <ManageProducts />
    </div>
  );
}

// ─── Manage Products (Delete) ───────────────────────────────────────────────

function ManageProducts() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; title: string } | null>(null);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");

  const { data: products } = useQuery<any[]>({
    queryKey: ["/api/products"],
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ productId, password }: { productId: number; password: string }) => {
      // Verify password first
      // v1.1 (2026-07-22): relative path (see settings save comment).
      const authRes = await fetch("./api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!authRes.ok) {
        throw new Error("INVALID_PASSWORD");
      }
      // Delete the product
      await apiRequest("DELETE", `/api/products/${productId}`, undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      toast({ title: "Product deleted", description: `"${deleteTarget?.title}" has been permanently removed.` });
      setDeleteTarget(null);
      setConfirmPassword("");
      setPasswordError("");
    },
    onError: (err: any) => {
      if (err.message === "INVALID_PASSWORD") {
        setPasswordError("Incorrect password. Deletion cancelled.");
        setConfirmPassword("");
      } else {
        toast({ title: "Error", description: "Failed to delete product.", variant: "destructive" });
      }
    },
  });

  const handleDelete = () => {
    if (!deleteTarget || !confirmPassword) return;
    setPasswordError("");
    deleteMutation.mutate({ productId: deleteTarget.id, password: confirmPassword });
  };

  const handleClose = () => {
    setDeleteTarget(null);
    setConfirmPassword("");
    setPasswordError("");
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-destructive/10 text-destructive">
              <Trash2 className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Manage Products</CardTitle>
              <CardDescription className="text-xs mt-0.5">Delete products from the application. This action is permanent and requires password confirmation.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!products || products.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No products to manage.</p>
          ) : (
            <div className="divide-y">
              {products.map((product: any) => (
                <div key={product.id} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Gamepad2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{product.title}</div>
                      <div className="text-xs text-muted-foreground">{product.publisher} &middot; {product.genre}</div>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDeleteTarget({ id: product.id, title: product.title })}
                    className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30 shrink-0"
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) handleClose(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Product
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-1">
            <p className="text-sm text-muted-foreground">
              You are about to permanently delete <strong className="text-foreground">"{deleteTarget?.title}"</strong> and all its associated data (wishlists, forecasts, milestones, YouTube tracking).
            </p>
            <p className="text-sm text-muted-foreground">
              This cannot be undone. Enter the app password to confirm.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Password</Label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(""); }}
                placeholder="Enter app password"
                className="h-9 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleDelete();
                  if (e.key === "Escape") handleClose();
                }}
              />
              {passwordError && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {passwordError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={handleClose} className="h-8 text-xs">
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={!confirmPassword || deleteMutation.isPending}
                className="h-8 text-xs"
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete Permanently"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Weekly Digest Recipients (Phase 5 / §8.1) ──────────────────────────────
// Managed add/toggle/delete list for who receives the weekly Steam Leaderboard
// digest email, plus a manual "send test digest now" trigger so the whole
// pipeline can be verified without waiting for the real Monday 07:00 ET send.

interface LeaderboardEmailRecipient {
  id: number;
  email: string;
  label: string | null;
  isActive: boolean;
  createdAt: string;
}

function RecipientsManager() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newEmail, setNewEmail] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const { data: recipients, isLoading } = useQuery<LeaderboardEmailRecipient[]>({
    queryKey: ["/api/leaderboards/email-recipients"],
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/leaderboards/email-recipients"] });

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/leaderboards/email-recipients", {
        email: newEmail.trim(),
        label: newLabel.trim() || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Recipient added", description: `${newEmail.trim()} will receive the weekly digest.` });
      setNewEmail("");
      setNewLabel("");
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Failed to add recipient", description: err?.message || "Could not add recipient.", variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      await apiRequest("PATCH", `/api/leaderboards/email-recipients/${id}`, { isActive });
    },
    onSuccess: invalidate,
    onError: (err: any) => {
      toast({ title: "Failed to update recipient", description: err?.message || "Could not update recipient.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/leaderboards/email-recipients/${id}`, undefined);
    },
    onSuccess: () => {
      toast({ title: "Recipient removed" });
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Failed to remove recipient", description: err?.message || "Could not remove recipient.", variant: "destructive" });
    },
  });

  const testSendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("./api/leaderboards/email-recipients/test-send", { method: "POST" });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        // no body
      }
      if (!res.ok) {
        throw new Error(body?.reason || body?.error || `HTTP ${res.status}`);
      }
      return body;
    },
    onSuccess: (result: any) => {
      toast({
        title: "Test digest sent",
        description: result?.recipients
          ? `Sent to ${result.recipients} active recipient${result.recipients === 1 ? "" : "s"}.`
          : "Digest send completed.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Test digest not sent",
        description: err?.message || "Check that resend_api_key is set and at least one recipient is active.",
        variant: "destructive",
      });
    },
  });

  const handleAdd = () => {
    if (!newEmail.trim()) return;
    addMutation.mutate();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
              <Mail className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Weekly Digest Recipients</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Who receives the weekly Steam Leaderboard digest email (Mondays 07:00 America/New_York). Inactive recipients are skipped.
              </CardDescription>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => testSendMutation.mutate()}
            disabled={testSendMutation.isPending}
            className="gap-1.5 shrink-0"
          >
            {testSendMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send test digest now
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 pb-4">
          <Input
            type="email"
            placeholder="name@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className="h-9 text-sm max-w-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
          <Input
            type="text"
            placeholder="Label (optional)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="h-9 text-sm max-w-[10rem]"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={!newEmail.trim() || addMutation.isPending}
            className="gap-1 shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        {isLoading ? (
          <p className="text-xs text-muted-foreground py-2">Loading recipients...</p>
        ) : !recipients || recipients.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No recipients yet — add one above.</p>
        ) : (
          <div className="divide-y">
            {recipients.map((r) => (
              <div key={r.id} className="flex items-center justify-between py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{r.email}</div>
                  {r.label && <div className="text-xs text-muted-foreground">{r.label}</div>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={r.isActive}
                      onCheckedChange={(checked) => toggleMutation.mutate({ id: r.id, isActive: checked })}
                      disabled={toggleMutation.isPending}
                    />
                    <span className="text-xs text-muted-foreground w-12">{r.isActive ? "Active" : "Paused"}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => deleteMutation.mutate(r.id)}
                    disabled={deleteMutation.isPending}
                    className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
