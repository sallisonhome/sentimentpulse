import {useState} from "react";
import {Link} from "wouter";
import {useQuery} from "@tanstack/react-query";
import {Card} from "@/components/ui/card";
import {Button} from "@/components/ui/button";
import {Badge} from "@/components/ui/badge";
import {Skeleton} from "@/components/ui/skeleton";
import {apiRequest} from "@/lib/queryClient";
import type {ArchivedDemosResponse} from "@shared/demo-detail";

const number=(n:number|null)=>n===null?"Not available":n.toLocaleString("en-US",{maximumFractionDigits:1});
const date=(s:string|null)=>s?.slice(0,10)??"Not recorded";
type Sort="name"|"release"|"deactivated"|"downloads"|"reviews"|"peak";

export default function ArchivedDemos(){
  const [search,setSearch]=useState(""),[genre,setGenre]=useState("");
  const [sort,setSort]=useState<Sort>("deactivated"),[direction,setDirection]=useState<"asc"|"desc">("desc");
  const [offset,setOffset]=useState(0),[limit,setLimit]=useState(50);
  const query=useQuery<ArchivedDemosResponse>({
    queryKey:["/api/demos/archive",{search,genre,sort,direction,offset,limit}],
    queryFn:async({signal})=>{
      const params=new URLSearchParams({search,genre,sort,direction,offset:String(offset),limit:String(limit)});
      const response=await apiRequest("GET",`/api/demos/archive?${params}`);
      if(signal.aborted)throw new Error("Request cancelled");
      return response.json();
    },retry:false,
  });
  const changeSort=(key:Sort)=>{setSort(key);setDirection(sort===key&&direction==="desc"?"asc":"desc");setOffset(0);};
  const headings:Array<[Sort,string]>=[["name","Demo"],["release","Demo release"],["deactivated","Retirement detected"],
    ["downloads","Recorded LTD downloads"],["reviews","Last total reviews"],["peak","Observed peak CCU"]];
  return <div className="p-4 md:p-6 max-w-[1760px] mx-auto space-y-5 min-w-0" data-testid="page-archived-demos">
    <header><h1 className="text-2xl font-semibold">Steam Demos & Friends Pass</h1>
      <p className="text-sm text-muted-foreground mt-1">Retired from the store, still tracked. Browse their dated observations and history.</p></header>
    <nav className="flex flex-wrap gap-2" aria-label="SKU category">
      <Button variant="outline" asChild><Link href="/demos-leaderboard">Demos</Link></Button>
      <Button variant="outline" asChild><Link href="/demos-leaderboard?kind=friends_pass">Friends Pass</Link></Button>
      <Button asChild><Link href="/demos-leaderboard/archive" aria-current="page">Archived demos</Link></Button>
    </nav>
    <Card className="p-4 space-y-2">
      <h2 className="font-semibold text-base">Retirement changes availability, not tracking</h2>
      <p className="text-sm text-muted-foreground leading-6">Daily source checks continue for these demos, and they remain in the main
        metric views. Top Demos and New Releases only show available demos. Open a title to inspect its history;
        unavailable sources retain their last good observations rather than becoming zero.</p>
      <p className="text-xs text-muted-foreground">Saber downloads use Steamworks actuals; non-Saber records are provisional estimates.
        Dates are UTC. Retirement detected is when SignalPulse recorded inactivity, not a verified publisher removal time.
        Recorded model totals keep their original multiplier; the main leaderboard uses the current trial.</p>
    </Card>
    <div className="flex flex-wrap gap-4 items-center">
      <label className="text-sm flex items-center gap-2">Search
        <input type="search" value={search} maxLength={120} placeholder="Demo name or App ID"
          onChange={e=>{setSearch(e.target.value);setOffset(0);}} className="h-9 w-48 max-w-full rounded-md border bg-background px-2"
          data-testid="archive-search"/></label>
      <label className="text-sm flex items-center gap-2">Genre
        <select value={genre} onChange={e=>{setGenre(e.target.value);setOffset(0);}}
          className="h-9 max-w-60 rounded-md border bg-background px-2" data-testid="archive-genre">
          <option value="">All genres</option>{Array.from(new Set([...(query.data?.genres??[]),...(genre?[genre]:[])]))
            .map(g=><option key={g} value={g}>{g}</option>)}</select></label>
      <label className="text-sm flex items-center gap-2">Show
        <select value={limit} onChange={e=>{setLimit(Number(e.target.value));setOffset(0);}}
          className="h-9 rounded-md border bg-background px-2">
          {[50,100,250].map(n=><option key={n} value={n}>{n} rows</option>)}</select></label>
    </div>
    {query.isPending&&<Skeleton className="h-64 w-full"/>}
    {query.isError&&<Card className="p-5 space-y-3" role="alert">
      <p>Archived demos could not be loaded. No records have been changed.</p>
      <Button variant="outline" onClick={()=>query.refetch()}>Try again</Button></Card>}
    {query.data&&<>
      <p className="text-xs text-muted-foreground" aria-live="polite">{query.data.total} archived demos match your filters.</p>
      <p className="text-xs text-muted-foreground sm:hidden">Swipe the table horizontally to see dates and metrics.</p>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto" role="region" aria-label="Archived demos table, scroll horizontally for all metrics" tabIndex={0}>
          <table className="w-full text-sm text-right min-w-[1060px]">
            <thead className="bg-muted/40"><tr>
              {headings.map(([key,label])=><th key={key} className={`px-4 py-3 font-medium ${key==="name"?"text-left":""}`}
                aria-sort={sort===key?direction==="asc"?"ascending":"descending":"none"}>
                <button onClick={()=>changeSort(key)} className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Sort by ${label}`}>{label} <span aria-hidden="true">{sort===key?direction==="asc"?"↑":"↓":"↕"}</span></button>
              </th>)}<th className="px-4 py-3 font-medium">Data as of</th>
            </tr></thead>
            <tbody>{query.data.demos.map(d=><tr key={d.appId} className="border-t align-top hover:bg-muted/20">
              <td className="px-4 py-4 text-left min-w-72 max-w-sm">
                <Link href={`/demos-leaderboard/${d.appId}`} className="font-medium hover:underline focus-visible:ring-2">{d.name}</Link>
                <div className="mt-2"><Badge variant="secondary">{d.isSaber?"Saber actuals · retired":"Retired · still tracked"}</Badge></div>
                <p className="mt-2 text-xs text-muted-foreground">{d.genre??"Genre unavailable"} · App {d.appId}</p>
              </td>
              <td className="px-4 py-4 whitespace-nowrap">{date(d.releaseDate)}</td>
              <td className="px-4 py-4 whitespace-nowrap">{date(d.deactivatedAt)}</td>
              <td className="px-4 py-4 tabular-nums">{number(d.downloads)}
                <p className="text-xs text-muted-foreground mt-1">{d.isSaber?"Steamworks actual":"Recorded model"}</p></td>
              <td className="px-4 py-4 tabular-nums">{number(d.reviews)}</td>
              <td className="px-4 py-4 tabular-nums">{number(d.peak)}</td>
              <td className="px-4 py-4 whitespace-nowrap">{date(d.snapshotAsOf)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {!query.data.demos.length&&<div className="p-8 text-center space-y-3">
          <p>No archived demos match these filters.</p><Button variant="outline" onClick={()=>{setSearch("");setGenre("");setOffset(0);}}>Clear filters</Button>
        </div>}
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <p>{query.data.total?`${query.data.offset+1}–${query.data.offset+query.data.demos.length} of ${query.data.total}`:"No matching records"}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={!query.data.offset} onClick={()=>setOffset(Math.max(0,query.data!.offset-limit))}>Previous</Button>
          <Button size="sm" variant="outline" disabled={!query.data.hasMore} onClick={()=>setOffset(query.data!.offset+limit)}>Next</Button>
        </div>
      </div>
    </>}
  </div>;
}
