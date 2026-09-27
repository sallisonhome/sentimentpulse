import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, ExternalLink, RefreshCw } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip } from "recharts";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { GameMediaCarousel } from "@/components/ccu-pdp-section";
import { apiRequest } from "@/lib/queryClient";
import { demoHistoryCsv, type DemoDetail as Detail, type DemoHistoryPoint, type DemoRange, type DemoMediaResponse } from "@shared/demo-detail";

const fmt=(n:number|null|undefined)=>n==null?"Not available":n.toLocaleString("en-US",{maximumFractionDigits:1});
const tableNumber=(n:number|null)=>n==null?"—":fmt(n);
const windowLabel:Record<string,string>={d7:"7 days",d30:"30 days",d90:"90 days",m12:"12 months",ltd:"Lifetime"};
type Metric="dailyDownloads"|"lifetimeDownloads"|"reportedDownloadsToDate"|"netLifetimeChange"|"reviewsAdded"|"totalReviews"|"positivePercent"|"ccuPeak"|"ccuLatest";

function HistoryChart({rows,metric,title,note,bars=false}:{
  rows:DemoHistoryPoint[];metric:Metric;title:string;note:string;bars?:boolean;
}){
  const points=rows.filter(r=>r[metric]!=null),Chart=bars?BarChart:LineChart;
  return <Card className="p-4 min-w-0">
    <h2 className="text-sm font-semibold">{title}</h2>
    <p className="text-xs text-muted-foreground mt-1 min-h-9 leading-5">{note}</p>
    {!points.length?<div className="h-60 flex items-center justify-center text-sm text-muted-foreground text-center px-4">
      No observations in this range. Missing history is not zero.
    </div>:<div className="h-60 mt-3" data-testid={`demo-chart-${metric}`}>
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={rows} margin={{top:8,right:12,bottom:4,left:0}}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false}/>
          <XAxis dataKey="date" minTickGap={40} tick={{fontSize:12,fill:"hsl(var(--muted-foreground))"}}
            tickFormatter={d=>d.slice(5)} padding={{left:10,right:16}}/>
          <YAxis width={55} allowDecimals={metric==="positivePercent"}
            domain={metric==="positivePercent"?[0,100]:[points.some(p=>p[metric]!<0)?"auto":0,"auto"]}
            tick={{fontSize:12,fill:"hsl(var(--muted-foreground))"}}
            tickFormatter={n=>metric==="positivePercent"?`${n}%`:Intl.NumberFormat("en",{notation:"compact",maximumFractionDigits:1}).format(n)}/>
          <Tooltip labelFormatter={d=>`${d}`} formatter={(v:number)=>[`${fmt(v)}${metric==="positivePercent"?"%":""}`,title]}
            contentStyle={{background:"hsl(var(--card))",borderColor:"hsl(var(--border))",borderRadius:8,fontSize:12}}/>
          {bars?<Bar dataKey={metric} fill="#38a8c9" maxBarSize={28} isAnimationActive={false}/>
            :<Line dataKey={metric} type="linear" stroke="#38a8c9" strokeWidth={2} connectNulls={false}
              dot={{r:points.length===1?5:2}} activeDot={{r:5}} isAnimationActive={false}/>}
        </Chart>
      </ResponsiveContainer>
    </div>}
    {points.length===1&&<p className="text-xs text-muted-foreground">One observed point. A trend requires more daily observations.</p>}
  </Card>;
}

export default function DemoDetail(){
  const {appId}=useParams<{appId:string}>();
  const [range,setRange]=useState<DemoRange>("30");
  const [downloadMode,setDownloadMode]=useState<"daily"|"lifetime"|"reported"|"change">("daily");
  const [reviewMode,setReviewMode]=useState<"daily"|"lifetime"|"sentiment">("daily");
  const [ccuMode,setCcuMode]=useState<"peak"|"latest">("peak");
  useEffect(()=>setDownloadMode("daily"),[appId]);
  const detail=useQuery<Detail>({queryKey:["/api/demos/titles",appId,range],
    queryFn:async()=>(await apiRequest("GET",`/api/demos/titles/${appId}?days=${range}`)).json(),retry:false});
  const media=useQuery<DemoMediaResponse>({queryKey:["/api/demos/titles",appId,"media"],
    queryFn:async()=>(await apiRequest("GET",`/api/demos/titles/${appId}/media`)).json(),
    enabled:!!detail.data,retry:false});
  const data=detail.data,art=media.data?.media,archived=!!data?.archived;
  const downloadMetric=downloadMode==="lifetime"?"lifetimeDownloads":downloadMode==="reported"?"reportedDownloadsToDate":downloadMode==="change"?"netLifetimeChange":"dailyDownloads";
  const downloadTitle=downloadMetric==="reportedDownloadsToDate"?"Reported downloads through date"
    :downloadMetric==="netLifetimeChange"?"Net change in observed lifetime totals"
    :downloadMetric==="lifetimeDownloads"
    ? data?.isSaber?"Observed lifetime downloads":"Recorded lifetime download estimates"
    : data?.isSaber?"Daily demo downloads · Steamworks actuals":"Estimated daily downloads";
  const downloadNote=downloadMetric==="reportedDownloadsToDate"
    ? "Steamworks report from its 2000-01-01 baseline through each date, retrieved later. Not a snapshot observed on that past date and not a sum of daily reports."
    :downloadMetric==="netLifetimeChange"
    ? "Difference between consecutive comparable lifetime observations. This includes reporting revisions and is not the single-day download report."
    :downloadMetric==="lifetimeDownloads"
    ? "One recorded total per observation date. Historical estimates retain their original model; no invented past totals."
    : data?.isSaber
      ? "Direct single-day Steamworks report for this demo App ID, on the source report’s calendar date. Reports may be revised; they need not sum to the cumulative report."
      : `Own-demo daily reviews × ${data?.multiplier??130}, provisional. Valve histogram buckets take priority; reconciled recovered review-creation dates fill older gaps. Not measured downloads or a CCU-based count.`;
  const exportCsv=()=>{
    if(!data)return;
    const url=URL.createObjectURL(new Blob([demoHistoryCsv(data)],{type:"text/csv;charset=utf-8"}));
    const a=document.createElement("a");a.href=url;a.download=`steam-demo-${appId}-${data.start}-${data.end}.csv`;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const visibleRows=data?.rows.filter(r=>Object.entries(r).some(([key,value])=>key!=="date"&&value!==null))??[];
  return <div className="p-4 md:p-6 space-y-5 min-w-0 max-w-[1600px] mx-auto pb-12" data-testid="page-demo-detail">
    <Link href={archived?"/demos-leaderboard/archive":"/demos-leaderboard"} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4"/>{archived?"Archived demos":"Steam demos"}
    </Link>
    {detail.error&&<Card className="p-6" role="alert"><h1 className="text-xl font-semibold">Demo history unavailable</h1>
      <p className="text-sm text-muted-foreground mt-2">{detail.error.message.startsWith("404")
        ? "This App ID is not a tracked demo. Friends Passes do not have demo detail pages."
        : data ? "The reload failed. Previously loaded data is shown below; please try again."
          : "The stored history could not be loaded. Please try again or return to the demo leaderboard."}</p>
      <Button variant="outline" className="mt-4" onClick={()=>detail.refetch()}>Try again</Button></Card>}
    {detail.isPending&&!detail.error&&<><Skeleton className="h-36 w-full"/><Skeleton className="h-80 w-full"/></>}
    {data&&<>
      <header className="flex flex-col sm:flex-row gap-4">
        {art?.coverId&&<img src={`https://images.igdb.com/igdb/image/upload/t_cover_big/${art.coverId}.jpg`}
          alt={`${art.name??data.name} IGDB cover`} className="w-24 h-32 object-cover rounded-md bg-muted shrink-0"
          onError={e=>{e.currentTarget.style.display="none";}}/>}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold break-words">{data.name}</h1>
            <Badge variant="outline">{data.isSaber?"Saber actuals":"Non-Saber estimates"}</Badge>
            {archived&&<Badge variant="secondary">Retired · still tracked</Badge>}
          </div>
          <p className="text-sm text-muted-foreground mt-2">Steam demo App ID {data.appId} · {data.genre??"Genre unavailable"}</p>
          <p className="text-xs text-muted-foreground mt-1">Demo release: {data.releaseDate??"Unverified"} · First tracked: {data.firstSeenAt.slice(0,10)}</p>
          {archived&&<p className="text-xs text-muted-foreground mt-1">Retirement detected: {data.deactivatedAt?.replace("T"," ").slice(0,16)??"Date not recorded"}{data.deactivatedAt?" UTC":""}
            {` · Latest stored evidence: ${data.snapshotAsOf??"Not available"}`}</p>}
          <a className="inline-flex items-center gap-1 text-sm hover:underline mt-3"
            href={`https://store.steampowered.com/app/${data.appId}/`} target="_blank" rel="noreferrer">{archived?"Original Steam page (may be unavailable)":"Demo on Steam"}<ExternalLink className="h-3.5 w-3.5"/></a>
        </div>
        <div className="flex items-start gap-2 shrink-0">
          <Button variant="outline" size="sm" aria-label="Reload stored history" disabled={detail.isFetching}
            onClick={()=>{detail.refetch();media.refetch();}}><RefreshCw className="h-4 w-4"/></Button>
          <Button size="sm" disabled={detail.isFetching||!!detail.error} onClick={exportCsv}><Download className="h-4 w-4 mr-2"/>CSV</Button>
        </div>
      </header>

      <section aria-label="Latest recorded metrics" className="grid grid-cols-1 min-[450px]:grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          {label:data.latest.observedMinimum?"Observed minimum, not an estimate":data.isSaber?"Lifetime demo downloads":"Lifetime estimated downloads",
            value:fmt(data.latest.downloads),note:data.isSaber?`Steamworks · ${data.latest.actualsAsOf?.slice(0,10)??"Not observed"}`
              :data.latest.observedMinimum?"Concurrency exceeded the review model":"Own-demo review model · provisional"},
          {label:"Last recorded review total",value:fmt(data.latest.reviews),note:data.latest.positivePercent==null?"Own-demo reviews only":`${fmt(data.latest.positivePercent)}% positive · own demo`},
          {label:"Latest sampled CCU",value:fmt(data.latest.ccu),note:data.latest.ccuObservedAt?`${data.latest.ccuObservedAt.replace("T"," ").slice(0,16)} UTC`:"No observation"},
          {label:"Peak observed CCU",value:fmt(data.latest.peak),note:"Highest stored sample, not continuous monitoring"},
        ].map(k=><Card key={k.label} className="p-4 min-w-0"><p className="text-xs text-muted-foreground">{k.label}</p>
          <p className="text-2xl font-semibold tabular-nums mt-2">{k.value}</p><p className="text-xs text-muted-foreground mt-2">{k.note}</p></Card>)}
      </section>
      {data.isSaber&&(data.latest.actualsRefreshFailed||data.latest.actualsStale)&&<p role="status" className="text-sm text-amber-700 dark:text-amber-400">
        Steamworks actuals are {data.latest.actualsRefreshFailed?"from the last successful refresh; the latest refresh failed":"stale or unavailable"}. Missing reports are not zero.
      </p>}
      {data.latest.observedMinimum&&<p className="text-sm text-amber-700 dark:text-amber-400">
        The headline is a concurrency-based lower bound. History below shows the review model as recorded, not that lower bound.
      </p>}
      {archived&&<Card className="p-4 text-sm text-muted-foreground" data-testid="demo-archive-notice">
        This demo is retired from public availability but remains tracked on the daily schedule.
        If Steam no longer supplies a usable signal, its last good observations stay dated; missing data is not zero.
        {" "}The retirement date records SignalPulse’s detection, not the publisher’s exact removal time.</Card>}

      <section aria-label="Daily history" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-base font-semibold">Day-by-day history</h2>
            <p className="text-xs text-muted-foreground mt-1">{data.isSaber?"Downloads use Steamworks report dates; review/CCU dates are UTC":"Review and CCU dates are UTC"} · Headline cards show latest available observations</p></div>
          <div className="flex flex-wrap gap-1" aria-label="History range">
            {(["7","30","90","365","all"] as DemoRange[]).map(r=><Button key={r} size="sm" aria-pressed={range===r}
              variant={range===r?"secondary":"outline"} onClick={()=>setRange(r)}>{r==="all"?"All history":r==="365"?"12 months":`${r} days`}</Button>)}
          </div>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="demo-history-range">{data.start} through {data.end} · {data.firstHistoryDate?`Earliest retained history: ${data.firstHistoryDate}`:"History not yet available"}
          {detail.isFetching?" · Loading…":""}</p>
        {<div className="flex flex-wrap gap-2" aria-label="Download history mode">
          <Button size="sm" variant={downloadMode==="daily"?"secondary":"outline"} aria-pressed={downloadMode==="daily"} onClick={()=>setDownloadMode("daily")}>Daily downloads</Button>
          {data.isSaber&&<Button size="sm" variant={downloadMode==="reported"?"secondary":"outline"} aria-pressed={downloadMode==="reported"} onClick={()=>setDownloadMode("reported")}>Reported through date</Button>}
          <Button size="sm" variant={downloadMode==="lifetime"?"secondary":"outline"} aria-pressed={downloadMode==="lifetime"} onClick={()=>setDownloadMode("lifetime")}>Observed lifetime</Button>
          {data.isSaber&&<Button size="sm" variant={downloadMode==="change"?"secondary":"outline"} aria-pressed={downloadMode==="change"} onClick={()=>setDownloadMode("change")}>Net LTD change</Button>}
        </div>}
        <HistoryChart rows={data.rows} metric={downloadMetric} title={downloadTitle} note={downloadNote} bars={downloadMetric==="dailyDownloads"||downloadMetric==="netLifetimeChange"}/>
        <Card className="p-4 text-xs text-muted-foreground space-y-2" data-testid="demo-history-coverage">
          <h3 className="text-sm font-semibold text-foreground">History coverage</h3>
          <p>{data.isSaber?`${data.historyCoverage.dailyReportDays} daily actual reports · ${data.historyCoverage.cumulativeReportDays} date-bounded cumulative reports · `:""}
            {data.historyCoverage.histogramDays} retained review histogram dates · {data.historyCoverage.recoveredReviewDays} reconciled recovered review dates.
            {" "}Counts cover retained history, not just the selected range.</p>
          {!data.historyCoverage.jobs.length&&<p>Historical recovery has not been run for this title. Daily source checks continue; a blank is unavailable, not zero.</p>}
          {data.historyCoverage.jobs.map(j=><p key={j.kind}>
            {j.kind==="downloads"?"Steamworks backfill":"Review-date recovery"}: {j.status==="complete"?"complete within requested scope":j.status==="mismatch"?"counts disagree; recovered estimates withheld":j.status==="error"?"source unavailable; checkpoint retained":j.status==="running"?"partially collected; more batches needed":"not yet processed"}
            {` · ${j.startDate} to ${j.endDate}`}</p>)}
          {data.historyCoverage.checks.filter(c=>c.error).map(c=><p key={c.source} role="status">{c.error} · Last attempt {c.attemptedAt.slice(0,10)}</p>)}
          <p>Recovered reviews represent currently retrievable reviews by creation date, not past observed totals. Original lifetime snapshots and unavailable past CCU are never manufactured.</p>
        </Card>
        {<div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="space-y-3 min-w-0">
            <div className="flex flex-wrap gap-1" aria-label="Review history mode">
              {(["daily","lifetime","sentiment"] as const).map(m=><Button key={m} size="sm" aria-pressed={reviewMode===m}
                variant={reviewMode===m?"secondary":"outline"} onClick={()=>setReviewMode(m)}>{m==="daily"?"Daily reviews":m==="lifetime"?"Total reviews":"Positive %"}</Button>)}
            </div>
            <HistoryChart rows={data.rows} metric={reviewMode==="daily"?"reviewsAdded":reviewMode==="lifetime"?"totalReviews":"positivePercent"}
              title={reviewMode==="daily"?"Daily Steam reviews":reviewMode==="lifetime"?"Observed lifetime reviews":"Observed positive review share"}
              note={reviewMode==="daily"?"Own-demo day-grain histogram buckets, with reconciled review-creation dates used only where a histogram day is missing. Today may be partial; weekly/monthly rollups are never prorated."
                :reviewMode==="lifetime"?"Retained review-count inputs and new lifetime review observations for this demo. No backdated cumulative totals."
                  :"Captured lifetime positive share for this demo. Sentiment snapshot retention starts with this release; older percentages are not reconstructed."}
              bars={reviewMode==="daily"}/>
          </div>
          <div className="space-y-3 min-w-0">
            <div className="flex flex-wrap gap-1" aria-label="CCU history mode">
              <Button size="sm" variant={ccuMode==="peak"?"secondary":"outline"} aria-pressed={ccuMode==="peak"} onClick={()=>setCcuMode("peak")}>Daily sampled peak</Button>
              <Button size="sm" variant={ccuMode==="latest"?"secondary":"outline"} aria-pressed={ccuMode==="latest"} onClick={()=>setCcuMode("latest")}>Last daily sample</Button>
            </div>
            <HistoryChart rows={data.rows} metric={ccuMode==="peak"?"ccuPeak":"ccuLatest"} title={ccuMode==="peak"?"Daily peak observed CCU":"Last CCU observation per day"}
              note="Own-demo concurrent players. Daily sampling does not establish the true 24-hour peak or unique players; a measured zero is retained."/>
          </div>
        </div>}
      </section>

      <Card className="p-4 space-y-3">
        <h2 className="text-base font-semibold">Daily records</h2>
        <p className="text-xs text-muted-foreground">Daily actuals and reported-through-date totals use Steamworks report dates; observed lifetime totals use capture dates.
          Reviews use activity dates. These series need not reconcile by addition. Blank cells mean unavailable, not zero; CSV preserves sources and retrieval timestamps.</p>
        <p className="text-xs text-muted-foreground sm:hidden">Swipe the table to see all metrics.</p>
        <div className="overflow-auto max-h-96" tabIndex={0} role="region" aria-label="Demo daily records">
          <table className="w-full text-xs whitespace-nowrap text-right">
            <thead className="sticky top-0 z-20 bg-card"><tr className="border-b">
              {["Date",data.isSaber?"Daily actual downloads":"Est. daily downloads",...(data.isSaber?["Reported through date","Net LTD change"]:[]),data.isSaber?"Observed LTD actual":"Recorded LTD estimate",
                "Daily reviews","+ reviews","− reviews","Total reviews","Positive %","Last CCU","Peak sample","Samples","Review-day source"].map((h,i)=><th key={h} className={`p-3 font-medium ${i===0?"text-left sticky left-0 bg-card z-20":""}`}>{h}</th>)}
            </tr></thead>
            <tbody>{[...visibleRows].reverse().map(r=><tr key={r.date} className="border-b border-border/50">
              <td className="p-3 text-left sticky left-0 bg-card">{r.date}</td>
              {[r.dailyDownloads,...(data.isSaber?[r.reportedDownloadsToDate,r.netLifetimeChange]:[]),r.lifetimeDownloads,r.reviewsAdded,r.positiveAdded,r.negativeAdded,r.totalReviews,r.positivePercent,r.ccuLatest,r.ccuPeak,r.ccuSamples]
                .map((n,i)=><td key={i} className="p-3 tabular-nums">{tableNumber(n)}{i===(data.isSaber?8:6)&&n!=null?"%":""}</td>)}
              <td className="p-3 text-muted-foreground">{r.reviewActivitySource==="steam:appreviews:created-date"?"Recovered creation dates":r.reviewActivitySource?"Steam histogram":"Not available"}</td>
            </tr>)}</tbody>
          </table>
          {!visibleRows.length&&<p className="py-8 text-center text-sm text-muted-foreground">No daily records in this range.</p>}
        </div>
      </Card>
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">Latest stored period totals and methodology</summary>
        <div className="overflow-x-auto mt-3"><table className="text-sm w-full text-left"><thead><tr className="border-b">
          <th className="p-2">Window</th><th className="p-2">Downloads</th><th className="p-2">Observed</th><th className="p-2">Source / model</th>
        </tr></thead><tbody>{data.latestWindows.map(w=><tr key={w.window} className="border-b border-border/50">
          <td className="p-2">{windowLabel[w.window]??w.window}</td><td className="p-2 tabular-nums">{fmt(w.downloads)}</td>
          <td className="p-2">{w.asOf?.slice(0,10)??"Unavailable"}</td><td className="p-2 break-words">{w.source}</td>
        </tr>)}</tbody></table></div>
        <p className="text-xs text-muted-foreground mt-3 leading-5">Rolling 7/30/90-day totals are not daily downloads.
          Non-Saber daily estimates use the current {data.multiplier??130}× trial; recorded lifetime estimates retain their historical model.
          Steamworks actuals are from the demo App ID’s Downloads by Region report, not complimentary licenses or parent-game purchases.
          Its definition counts demo users with recorded playtime or demo preloads. Daily source checks continue even after retirement.
          Reload reads stored data; it does not trigger ingestion.</p>
      </details>
      <Card className="p-4 space-y-4">
        <div><h2 className="text-base font-semibold">Game details & media</h2>
          <p className="text-xs text-muted-foreground mt-1">{art
            ? `IGDB · ${art.scope==="parent"?"Parent-game metadata and media, not demo-specific":"Exact demo match"} · Steam App ID ${art.matchedAppId}`
            :"Exact Steam identity matching only; no fuzzy title substitutions."}</p></div>
        {media.isPending&&<Skeleton className="h-24 w-full"/>}
        {(media.error||media.data?.status==="unavailable")&&<p role="status" className="text-sm text-muted-foreground">IGDB is temporarily unavailable{art?"; showing cached media":""}. Demo statistics are unaffected.</p>}
        {media.data?.status==="no_match"&&<p className="text-sm text-muted-foreground">No verified IGDB match was found for this demo or its verified parent game.</p>}
        {art&&<>
          {media.data?.stale&&<p className="text-xs text-muted-foreground">Cached media · last successful fetch {media.data.fetchedAt?.slice(0,10)}</p>}
          <p className="text-sm leading-relaxed max-w-4xl">{art.summary??"No IGDB description available."}</p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 text-sm">
            {[["Developer",art.developers?.join(", ")],["Publisher",art.publishers?.join(", ")],["IGDB genres",art.genres?.join(", ")],
              [art.scope==="parent"?"Parent-game release":"IGDB release",art.releaseDate]].map(([label,value])=><div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1">{value||"Unavailable"}</dd></div>)}
          </dl>
          <GameMediaCarousel media={art}/>
        </>}
      </Card>
    </>}
  </div>;
}
