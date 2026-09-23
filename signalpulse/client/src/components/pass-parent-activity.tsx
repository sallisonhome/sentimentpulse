import { ACTIVITY_STATUS_LABELS, type PassParentActivity } from "@shared/pass-parent-activity";

export function PassParentActivityCell({ activity, hybrid }: { activity: PassParentActivity | null; hybrid: boolean }) {
  if (!activity) return <span className="text-xs text-muted-foreground">Awaiting paired sample</span>;
  const a = activity, latest = a.window === "latest";
  return <div className="text-right tabular-nums">
    {a.ratio !== null ? <>
      <span className="font-medium" title={`${a.ratio * 100}% as much observed activity in the pass as in the parent. Not conversion.`}>
        {a.ratio.toFixed(2)}×
      </span>
      <span className="block text-xs text-muted-foreground">{a.sharePercent!.toFixed(1)}% of combined activity</span>
      {a.changePercentagePoints !== null && <span className="block text-xs text-muted-foreground">
        {a.changePercentagePoints >= 0 ? "+" : ""}{a.changePercentagePoints.toFixed(1)} pp vs prior period
      </span>}
    </> : <span className="text-xs text-muted-foreground">{ACTIVITY_STATUS_LABELS[a.status]}</span>}
    {latest && a.passCcu !== null && a.parentCcu !== null && <span className="block text-xs text-muted-foreground">
      {a.passCcu.toLocaleString()} / {a.parentCcu.toLocaleString()} CCU
    </span>}
    {!latest && a.status !== "shared_runtime" && <span className="block text-xs text-muted-foreground">
      {a.sampleDays}/{a.window === "d7" ? 7 : 30} sampled days
    </span>}
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Evidence &amp; timing</summary>
      <div className="mt-2 space-y-1 text-left break-words">
        <div>{latest ? "Latest paired snapshot" : "Daily-sampled comparison"} · {hybrid ? "Demo + pass activity" : "Pass runtime activity"}</div>
        {a.parentAppId && <a className="block underline" href={`https://store.steampowered.com/app/${a.parentAppId}`}
          target="_blank" rel="noreferrer">Parent: {a.parentName ?? a.parentAppId}</a>}
        {a.passCcu !== null && a.parentCcu !== null && <div>
          {latest ? "Paired CCU" : "Mean sampled CCU"}: {a.passCcu.toLocaleString(undefined,{maximumFractionDigits:1})} pass /
          {" "}{a.parentCcu.toLocaleString(undefined,{maximumFractionDigits:1})} parent
        </div>}
        {a.sampledAt && <div>Latest pair: {new Date(a.sampledAt).toLocaleString()} ({a.skewMs} ms request/receipt skew)</div>}
        {a.periodStart && <div>UTC period: {a.periodStart.slice(0,10)} to {a.periodEnd!.slice(0,10)} (exclusive)</div>}
        {a.verifiedAt && <div>Identity checked: {new Date(a.verifiedAt).toLocaleString()}</div>}
        {a.evidenceUrl && <a className="block underline" href={a.evidenceUrl} target="_blank" rel="noreferrer">Parent identity evidence</a>}
        <div>Steam-only activity. Not unique players, owners, sales, or conversion. API cache times may differ.</div>
      </div>
    </details>
  </div>;
}
