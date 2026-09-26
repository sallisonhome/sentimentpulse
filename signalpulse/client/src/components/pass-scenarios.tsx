import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import type { PassScenarioResult, PassScenarioTitle } from "@shared/pass-scenarios";

const number = (n: number) => Math.round(n).toLocaleString();
function months(first: string, last: string) {
  const out: string[] = [];
  for (let d = new Date(`${first}-01T00:00:00Z`); d.toISOString().slice(0,7) <= last; d.setUTCMonth(d.getUTCMonth()+1))
    out.push(d.toISOString().slice(0,7));
  return out;
}
const selectClass = "h-11 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground";

/** Separate from measured catalog rows, ranking windows and actuals. */
export function PassScenarios() {
  const [title, setTitle] = useState<PassScenarioTitle>("lords");
  const [from, setFrom] = useState("2026-06");
  const [through, setThrough] = useState("2026-08");
  const [attribution, setAttribution] = useState("0.5");
  const [hosts, setHosts] = useState("0.5");
  const lords = title === "lords";
  const params = new URLSearchParams({title,from,through,...(lords ? {attribution,hosts} : {})});
  const url = `/api/demos/pass-scenarios?${params}`;
  const result = useQuery<PassScenarioResult>({
    queryKey: [url], queryFn: async () => (await apiRequest("GET",url)).json(),
    staleTime: Infinity, retry: false,
  });
  const data = result.data;
  const monthOptions = months(data?.availableFrom ?? (lords ? "2025-05" : "2024-06"), data?.availableThrough ?? "2026-08");
  return <section className="rounded-md border border-border bg-card p-4 space-y-4" aria-labelledby="pass-scenario-heading"
    data-testid="pass-scenarios">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h2 id="pass-scenario-heading" className="text-lg font-semibold">Qualified pass-use scenarios</h2>
        <p className="text-sm text-muted-foreground">Historical planning inputs, not measured users or downloads.</p>
        <p className="text-xs text-muted-foreground" data-testid="pass-scenario-cutoff">
          Saved data through August 2026 · independent of leaderboard filters · not updated daily
        </p>
      </div>
      {data && !result.isFetching && <Button asChild variant="outline" size="sm">
        <a href={`./api/demos/pass-scenarios?${params}&format=csv`} download data-testid="export-pass-scenario">
          Export selected scenario CSV
        </a>
      </Button>}
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-xs space-y-1">Title
        <select aria-label="Scenario title" data-testid="pass-scenario-title" value={title} className={selectClass}
          onChange={e=>{setTitle(e.target.value as PassScenarioTitle);setFrom("2026-06");setThrough("2026-08");}}>
          <option value="lords">Lords of the Fallen</option>
          <option value="it-takes-two">It Takes Two</option>
        </select>
      </label>
      <label className="text-xs space-y-1">From month
        <select aria-label="Scenario from month" value={from} className={selectClass}
          onChange={e=>{setFrom(e.target.value);if(e.target.value>through)setThrough(e.target.value);}}>
          {monthOptions.map(m=><option key={m}>{m}</option>)}
        </select>
      </label>
      <label className="text-xs space-y-1">Through month
        <select aria-label="Scenario through month" value={through} className={selectClass}
          onChange={e=>{setThrough(e.target.value);if(e.target.value<from)setFrom(e.target.value);}}>
          {monthOptions.map(m=><option key={m}>{m}</option>)}
        </select>
      </label>
    </div>
    {lords && <fieldset className="rounded-md bg-muted/30 p-3 grid gap-3 sm:grid-cols-2">
      <legend className="px-1 text-xs font-medium">Lords planning assumptions, not fitted coefficients</legend>
      <label className="text-xs space-y-1">Share of net uplift assigned to the pass
        <select aria-label="Pass attribution" value={attribution} onChange={e=>setAttribution(e.target.value)} className={selectClass}>
          <option value="0">0%: no attribution</option><option value="0.25">25%</option>
          <option value="0.5">50%: illustrative reference</option><option value="0.75">75%</option>
          <option value="1">100%: pass-led scenario</option>
        </select>
      </label>
      <label className="text-xs space-y-1">Additional owner activity per guest
        <select aria-label="Incremental hosts per guest" value={hosts} onChange={e=>setHosts(e.target.value)} className={selectClass}>
          <option value="0">0: owner would already be playing</option>
          <option value="0.5">0.5: illustrative reference</option><option value="1">1: one additional owner per guest</option>
        </select>
      </label>
    </fieldset>}
    {result.isPending && <p role="status" className="text-sm text-muted-foreground">Loading saved scenario…</p>}
    {result.isError && <div role="alert" className="text-sm space-y-2">
      <p>Could not load this scenario. No missing values have been replaced with zero.</p>
      <Button variant="outline" size="sm" onClick={()=>result.refetch()}>Retry scenario</Button>
    </div>}
    {data && <div className="space-y-4" aria-busy={result.isFetching}>
      <div className="flex flex-wrap gap-x-10 gap-y-4 border-y border-border py-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{data.metricLabel}</p>
          <p className="text-xl font-semibold tabular-nums" data-testid="pass-scenario-estimate">{number(data.summary.estimateAvgCcu)}</p>
          <p className="text-xs text-muted-foreground">Confidence: {data.confidence.replace("_"," ")} · not observed</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Sensitivity range, not a confidence interval</p>
          <p className="text-xl font-semibold tabular-nums" data-testid="pass-scenario-range">
            {number(data.summary.sensitivityLowAvgCcu)} to {number(data.summary.sensitivityHighAvgCcu)}
          </p>
          <p className="text-xs text-muted-foreground">Includes alternative assumptions, not just the selected coefficients</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Scenario player-hours in selected months</p>
          <p className="text-xl font-semibold tabular-nums" data-testid="pass-scenario-hours">{number(data.summary.estimatedPlayerHours)}</p>
          <p className="text-xs text-muted-foreground">{data.selectedFrom} through {data.selectedThrough} · {data.summary.months} complete months</p>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {lords
          ? "Estimate = positive excess above the selected baseline × assumed pass attribution ÷ (1 + additional owners per guest). This is incremental guest-equivalent activity, not all pass participants."
          : "Estimate = combined main and legacy-client activity × 26.1% historical pass-client share. Transfer after the May 2024 client migration is unvalidated. Legacy activity is included once."}
      </p>
      <div className="h-64 w-full min-w-0" role="img" aria-label={`${data.name}: monthly scenario and sensitivity bounds; exact values in the table below`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.points} margin={{top:10,right:12,bottom:0,left:0}}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="month" tick={{fontSize:12}} minTickGap={30} />
            <YAxis width={55} tick={{fontSize:12}} tickFormatter={n=>number(n)} domain={[0,"auto"]} />
            <Tooltip formatter={(value:number)=>number(value)} contentStyle={{background:"hsl(var(--background))",borderColor:"hsl(var(--border))",fontSize:12}} />
            <Legend wrapperStyle={{fontSize:12}} />
            <Line name="Scenario" dataKey="estimateAvgCcu" stroke="hsl(var(--primary))" strokeWidth={2} dot={data.points.length<10} isAnimationActive={false} />
            <Line name="Sensitivity low" dataKey="sensitivityLowAvgCcu" stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" dot={false} isAnimationActive={false} />
            <Line name="Sensitivity high" dataKey="sensitivityHighAvgCcu" stroke="hsl(var(--muted-foreground))" strokeDasharray="7 4" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details data-testid="pass-scenario-details">
        <summary className="cursor-pointer text-sm py-2">Assumptions, sources and monthly values</summary>
        <ul className="list-disc pl-5 text-xs leading-5 space-y-1">
          {data.caveats.map(c=><li key={c}>{c}</li>)}
        </ul>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs my-3">
          {data.sources.map(s=><a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">{s.label}</a>)}
        </div>
        <div className="overflow-x-auto" role="region" aria-label="Monthly scenario values" tabIndex={0}>
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-left border-b border-border">
              {["Month","Scenario avg CCU","Low","High","Scenario player-hours"].map(h=><th className="p-2 whitespace-nowrap" key={h}>{h}</th>)}
            </tr></thead>
            <tbody>{data.points.map(p=><tr key={p.month} className="border-b border-border/50">
              {[p.month,number(p.estimateAvgCcu),number(p.sensitivityLowAvgCcu),number(p.sensitivityHighAvgCcu),number(p.estimatedPlayerHours)]
                .map((v,i)=><td key={i} className="p-2 whitespace-nowrap">{v}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-3">Method {data.methodVersion} · snapshot {data.snapshotDate}.
          {" "}Read-only API and CSV preserve the assumptions. Excluded from actuals, rankings and totals; no automatic downstream application.</p>
      </details>
    </div>}
  </section>;
}
