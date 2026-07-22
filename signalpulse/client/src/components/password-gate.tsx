import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, AlertCircle } from "lucide-react";

interface PasswordGateProps {
  onAuthenticated: () => void;
}

export function PasswordGate({ onAuthenticated }: PasswordGateProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // v1.1 (2026-07-22): relative path so fetch honors the /signal/
      // base path in production. Absolute '/api/...' 404s at nginx.
      const res = await fetch("./api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        sessionStorage.setItem("sp_authenticated", "true");
        onAuthenticated();
      } else {
        setError("Invalid password. Please try again.");
        setPassword("");
      }
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [password, onAuthenticated]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-4">
            <svg viewBox="0 0 32 32" width="32" height="32" fill="none" className="text-primary">
              <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
              <circle cx="16" cy="16" r="9" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
              <circle cx="16" cy="16" r="4" fill="currentColor" />
              <path d="M16 2 L16 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M16 24 L16 30" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M2 16 L8 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M24 16 L30 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div className="flex items-baseline justify-center gap-1.5 mb-1">
            <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">Saber</span>
            <span className="text-lg font-semibold tracking-tight text-foreground">SignalPulse</span>
          </div>
          <p className="text-sm text-muted-foreground">Enter password to continue</p>
        </div>

        {/* Password Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pl-10 h-11"
              autoFocus
              autoComplete="off"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button
            type="submit"
            className="w-full h-11"
            disabled={!password || loading}
          >
            {loading ? "Verifying..." : "Sign In"}
          </Button>
        </form>
      </div>
    </div>
  );
}
