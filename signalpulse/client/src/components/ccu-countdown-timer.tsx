// ─── CCU Poll Countdown Timer (Phase 6, 2026-09-08) ─────────────────────────
//
// Ported from howmanyareplaying/frontend/src/components/ui/CountdownTimer.jsx
// — same tick-in second animation, same "Refreshing…" state at zero,
// restyled with Tailwind to match SignalPulse's existing component
// conventions instead of a standalone CSS module.
//
// Deviates from the HMAP original: HMAP re-derives `nextPollAt` client-side
// as `lastUpdatedAt + 60min`. SignalPulse's `/api/leaderboards/ccu/poll-state`
// already computes `nextPollAt` server-side (`getCcuPollStateSummary` in
// server/leaderboards.ts), so this component consumes that ISO timestamp
// directly rather than re-deriving it — one less place client and server
// clocks/logic can drift apart.
//
// `onRefetch` fires once when the timer hits zero so the caller can
// re-query the leaderboard + poll-state without the user reloading.

import { useEffect, useRef, useState } from "react";

function getSecondsRemaining(nextPollAt: string | null): number | null {
  if (!nextPollAt) return null;
  return Math.max(0, Math.floor((new Date(nextPollAt).getTime() - Date.now()) / 1000));
}

export function CcuCountdownTimer({
  nextPollAt,
  onRefetch,
}: {
  nextPollAt: string | null;
  onRefetch?: () => void;
}) {
  const [seconds, setSeconds] = useState<number | null>(() => getSecondsRemaining(nextPollAt));
  const onRefetchRef = useRef(onRefetch);
  const secsRef = useRef<HTMLSpanElement | null>(null);
  onRefetchRef.current = onRefetch;

  useEffect(() => {
    setSeconds(getSecondsRemaining(nextPollAt));
  }, [nextPollAt]);

  useEffect(() => {
    if (seconds === null) return;
    const id = setInterval(() => {
      setSeconds((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          if (prev === 1) onRefetchRef.current?.();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [nextPollAt]);

  // Restart the seconds tick-in animation on every change. Double rAF
  // ensures a fresh paint frame after React's DOM commit.
  useEffect(() => {
    const el = secsRef.current;
    if (!el) return;
    el.classList.remove("ccu-countdown-tick");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.add("ccu-countdown-tick");
      });
    });
  }, [seconds]);

  if (seconds === 0) {
    return (
      <div
        className="flex flex-col items-end gap-0.5"
        title="Time until next CCU refresh"
        data-testid="ccu-countdown-timer"
      >
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Next update in</span>
        <span className="text-xs text-muted-foreground">Refreshing&hellip;</span>
      </div>
    );
  }

  const m = seconds === null ? "--" : String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = seconds === null ? "--" : String(seconds % 60).padStart(2, "0");

  return (
    <div
      className="flex flex-col items-end gap-0.5"
      title="Time until next CCU refresh"
      data-testid="ccu-countdown-timer"
    >
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Next update in</span>
      <span className="text-lg font-bold tabular-nums font-mono tracking-wide text-primary">
        <span className="opacity-75">{m}:</span>
        <span ref={secsRef} className="ccu-countdown-tick inline-block">
          {s}
        </span>
      </span>
      <style>{`
        @keyframes ccu-countdown-tick-in {
          0%   { opacity: 0.1; transform: translateY(-8px); }
          60%  { opacity: 1;   transform: translateY(1px);  }
          100% { opacity: 1;   transform: translateY(0);    }
        }
        .ccu-countdown-tick {
          animation: ccu-countdown-tick-in 0.35s ease-out forwards;
        }
      `}</style>
    </div>
  );
}
