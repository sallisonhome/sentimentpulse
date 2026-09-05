// Sales by Country — SignalPulse top-nav page (v3.30, 2026-09-05).
//
// Comp A layout + Comp B sortable columns (as chosen 2026-09-05):
//   - Hero: full-width D3 choropleth on world-atlas TopoJSON, with hover
//     tooltip showing units / revenue / % / ASP for the hovered country.
//   - Below: full-width sortable table (flag, country, units, revenue, ASP,
//     % of total with inline bar). Click any header to sort.
//   - Above map: date-range chips (30d default, 90d, 6mo, 1yr, LTD, custom)
//     and KPI strip (Revenue, Units, ASP, Top country).
//
// Data source: /api/sales-by-country/aggregate — sums every product with a
// steamAppId. Server prefers day-level rows over month-level when they
// overlap, so filters are honest even during the backfill transition.
//
// Numeric-ISO country ids match the world-atlas 110m TopoJSON `id` field
// (three-digit strings). The API returns ISO2 (US, DE, ...) which we map to
// numeric ISO via ISO2_TO_ISO_N below for the map join.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryObject } from "topojson-specification";
import type { Feature, FeatureCollection } from "geojson";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ChevronUp, ChevronDown, ChevronsUpDown, Globe2 } from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────

type RangeKey = "30d" | "90d" | "180d" | "365d" | "ltd" | "custom";

interface CountryRow {
  country_iso: string;
  country_name: string;
  units: number;
  revenue_usd: number;
  asp_usd: number;
  pct_of_total: number;
}
interface AggregateResponse {
  since: string | null;
  until: string | null;
  products_included: number;
  total_units: number;
  total_revenue_usd: number;
  asp_usd: number;
  countries_count: number;
  countries: CountryRow[];
  per_product: Array<{ product_id: number; product_title: string; total_revenue_usd: number; total_units: number }>;
}

// ─── ISO2 → numeric ISO map for the world-atlas join ───────────────────────
// Small enough to inline. Coverage: every country/region Steam actually
// reports on. Numeric codes are ISO 3166-1 numeric; padded to 3 chars.
const ISO2_TO_ISO_N: Record<string, string> = {
  AD:"020",AE:"784",AF:"004",AG:"028",AI:"660",AL:"008",AM:"051",AO:"024",AQ:"010",AR:"032",AS:"016",AT:"040",AU:"036",AW:"533",AX:"248",AZ:"031",
  BA:"070",BB:"052",BD:"050",BE:"056",BF:"854",BG:"100",BH:"048",BI:"108",BJ:"204",BL:"652",BM:"060",BN:"096",BO:"068",BQ:"535",BR:"076",BS:"044",BT:"064",BV:"074",BW:"072",BY:"112",BZ:"084",
  CA:"124",CC:"166",CD:"180",CF:"140",CG:"178",CH:"756",CI:"384",CK:"184",CL:"152",CM:"120",CN:"156",CO:"170",CR:"188",CU:"192",CV:"132",CW:"531",CX:"162",CY:"196",CZ:"203",
  DE:"276",DJ:"262",DK:"208",DM:"212",DO:"214",DZ:"012",
  EC:"218",EE:"233",EG:"818",EH:"732",ER:"232",ES:"724",ET:"231",
  FI:"246",FJ:"242",FK:"238",FM:"583",FO:"234",FR:"250",
  GA:"266",GB:"826",GD:"308",GE:"268",GF:"254",GG:"831",GH:"288",GI:"292",GL:"304",GM:"270",GN:"324",GP:"312",GQ:"226",GR:"300",GS:"239",GT:"320",GU:"316",GW:"624",GY:"328",
  HK:"344",HM:"334",HN:"340",HR:"191",HT:"332",HU:"348",
  ID:"360",IE:"372",IL:"376",IM:"833",IN:"356",IO:"086",IQ:"368",IR:"364",IS:"352",IT:"380",
  JE:"832",JM:"388",JO:"400",JP:"392",
  KE:"404",KG:"417",KH:"116",KI:"296",KM:"174",KN:"659",KP:"408",KR:"410",KW:"414",KY:"136",KZ:"398",
  LA:"418",LB:"422",LC:"662",LI:"438",LK:"144",LR:"430",LS:"426",LT:"440",LU:"442",LV:"428",LY:"434",
  MA:"504",MC:"492",MD:"498",ME:"499",MF:"663",MG:"450",MH:"584",MK:"807",ML:"466",MM:"104",MN:"496",MO:"446",MP:"580",MQ:"474",MR:"478",MS:"500",MT:"470",MU:"480",MV:"462",MW:"454",MX:"484",MY:"458",MZ:"508",
  NA:"516",NC:"540",NE:"562",NF:"574",NG:"566",NI:"558",NL:"528",NO:"578",NP:"524",NR:"520",NU:"570",NZ:"554",
  OM:"512",
  PA:"591",PE:"604",PF:"258",PG:"598",PH:"608",PK:"586",PL:"616",PM:"666",PN:"612",PR:"630",PS:"275",PT:"620",PW:"585",PY:"600",
  QA:"634",
  RE:"638",RO:"642",RS:"688",RU:"643",RW:"646",
  SA:"682",SB:"090",SC:"690",SD:"729",SE:"752",SG:"702",SH:"654",SI:"705",SJ:"744",SK:"703",SL:"694",SM:"674",SN:"686",SO:"706",SR:"740",SS:"728",ST:"678",SV:"222",SX:"534",SY:"760",SZ:"748",
  TC:"796",TD:"148",TF:"260",TG:"768",TH:"764",TJ:"762",TK:"772",TL:"626",TM:"795",TN:"788",TO:"776",TR:"792",TT:"780",TV:"798",TW:"158",TZ:"834",
  UA:"804",UG:"800",UM:"581",US:"840",UY:"858",UZ:"860",
  VA:"336",VC:"670",VE:"862",VG:"092",VI:"850",VN:"704",VU:"548",
  WF:"876",WS:"882",
  YE:"887",YT:"175",
  ZA:"710",ZM:"894",ZW:"716",
};

// Flag emoji from ISO2 (regional indicator symbols)
function flagOf(iso2: string): string {
  if (!iso2 || iso2.length !== 2) return "";
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (iso2.charCodeAt(0) - 65)) +
         String.fromCodePoint(A + (iso2.charCodeAt(1) - 65));
}

// ─── Formatting helpers ────────────────────────────────────────────────────
function fmtUSD(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtUSDFull(n: number): string {
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtInt(n: number): string {
  return n.toLocaleString();
}
function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

// ─── Date-range helpers ────────────────────────────────────────────────────
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function rangeFor(key: RangeKey, customSince?: string, customUntil?: string): { since?: string; until?: string; label: string } {
  const today = new Date();
  const untilStr = isoDate(today);
  const daysBack = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return isoDate(d);
  };
  switch (key) {
    case "30d":  return { since: daysBack(30),  until: untilStr, label: "Last 30 days" };
    case "90d":  return { since: daysBack(90),  until: untilStr, label: "Last 90 days" };
    case "180d": return { since: daysBack(180), until: untilStr, label: "Last 6 months" };
    case "365d": return { since: daysBack(365), until: untilStr, label: "Last 1 year" };
    case "ltd":  return { since: undefined,     until: undefined, label: "Lifetime to date" };
    case "custom":
      return {
        since: customSince,
        until: customUntil,
        label: customSince && customUntil ? `${customSince} → ${customUntil}` : "Custom range",
      };
  }
}

// ─── Color scale ───────────────────────────────────────────────────────────
// 6-stop teal ramp (matches Comp A). Buckets by revenue.
const SCALE = ["#d9eaea", "#a8d6d6", "#6fbfbf", "#3fa1a1", "#1e7d7d", "#0a5252"];
const NO_DATA = "hsl(var(--muted))";
function colorFor(rev: number | null | undefined, max: number): string {
  if (rev == null || rev <= 0 || max <= 0) return NO_DATA;
  const t = Math.min(1, rev / max);
  const idx = Math.min(SCALE.length - 1, Math.floor(t * SCALE.length));
  return SCALE[idx];
}

// ─── Sortable table state ──────────────────────────────────────────────────
type SortKey = "country" | "units" | "revenue" | "asp" | "pct";
type SortDir = "asc" | "desc";

// ─── World map component ───────────────────────────────────────────────────
interface WorldMapProps {
  rows: CountryRow[];
  totalRevenue: number;
  height?: number;
}

function useWorldTopo() {
  const [topo, setTopo] = useState<Topology | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Base URL matches vite `base: /signal/`.
    fetch(`${import.meta.env.BASE_URL}world-atlas-110m.json`)
      .then(r => r.json())
      .then((t: Topology) => { if (!cancelled) setTopo(t); })
      .catch(() => { /* leave null; the map area shows a friendly fallback */ });
    return () => { cancelled = true; };
  }, []);
  return topo;
}

function WorldMap({ rows, totalRevenue, height = 420 }: WorldMapProps) {
  const topo = useWorldTopo();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<{ x: number; y: number; iso_n: string; name: string } | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Precompute row lookup keyed by numeric ISO (padded to 3 chars).
  const byIsoN = useMemo(() => {
    const m = new Map<string, CountryRow>();
    for (const r of rows) {
      const n = ISO2_TO_ISO_N[r.country_iso];
      if (n) m.set(n, r);
    }
    return m;
  }, [rows]);
  const maxRev = useMemo(() => rows.reduce((mx, r) => Math.max(mx, r.revenue_usd), 0), [rows]);

  const features = useMemo<Feature[]>(() => {
    if (!topo || !topo.objects || !topo.objects.countries) return [];
    try {
      // Prefer passing the geometry-object directly, but fall back to the
      // key-lookup form if the direct form ever misbehaves in a future
      // topojson-client release.
      const geomObj = topo.objects.countries as GeometryObject;
      const raw = feature(topo, geomObj) as unknown as FeatureCollection | Feature;
      // topojson-client returns a Feature if the object is a single geometry,
      // or a FeatureCollection if it's a GeometryCollection. Handle both.
      if (raw && (raw as FeatureCollection).features) return (raw as FeatureCollection).features;
      if (raw && (raw as Feature).geometry) return [raw as Feature];
      return [];
    } catch (err) {
      // Non-fatal: leave the map empty and log for debugging.
      // eslint-disable-next-line no-console
      console.warn("[SalesByCountry] world-atlas parse failed", err);
      return [];
    }
  }, [topo]);

  const projection = useMemo(() => {
    const p = geoNaturalEarth1();
    if (features.length > 0) {
      p.fitSize([width, height], { type: "FeatureCollection", features } as FeatureCollection);
    }
    return p;
  }, [features, width, height]);

  const pathGen = useMemo(() => geoPath(projection), [projection]);

  const hoverRow = hover ? byIsoN.get(hover.iso_n) ?? null : null;

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {!topo && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          <Skeleton className="h-full w-full" />
        </div>
      )}
      {topo && (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full">
          <g>
            {features.map((f) => {
              const idRaw = String((f as { id?: string | number }).id ?? "");
              const isoN = idRaw.padStart(3, "0");
              const row = byIsoN.get(isoN);
              const fill = colorFor(row?.revenue_usd, maxRev);
              return (
                <path
                  key={idRaw}
                  d={pathGen(f) ?? ""}
                  fill={fill}
                  stroke="hsl(var(--background))"
                  strokeWidth={0.4}
                  onMouseEnter={(e) => {
                    const rect = wrapRef.current?.getBoundingClientRect();
                    const name = (f.properties as { name?: string } | null)?.name ?? "Unknown";
                    setHover({
                      x: e.clientX - (rect?.left ?? 0),
                      y: e.clientY - (rect?.top ?? 0),
                      iso_n: isoN,
                      name,
                    });
                  }}
                  onMouseMove={(e) => {
                    const rect = wrapRef.current?.getBoundingClientRect();
                    setHover((h) => h ? {
                      ...h,
                      x: e.clientX - (rect?.left ?? 0),
                      y: e.clientY - (rect?.top ?? 0),
                    } : h);
                  }}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: row ? "pointer" : "default" }}
                />
              );
            })}
          </g>
        </svg>
      )}
      {/* Legend */}
      <div className="absolute bottom-2 left-2 flex items-center gap-1 text-[10px] text-muted-foreground pointer-events-none">
        <span>low</span>
        {SCALE.map((c) => (
          <span key={c} style={{ background: c, width: 18, height: 8, display: "inline-block" }} />
        ))}
        <span>high</span>
        <span style={{ background: NO_DATA, width: 18, height: 8, display: "inline-block", marginLeft: 8 }} />
        <span>no data</span>
      </div>
      {/* Tooltip */}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-md min-w-[200px]"
          style={{
            left: Math.min(hover.x + 12, (wrapRef.current?.clientWidth ?? 720) - 220),
            top: hover.y + 12,
          }}
        >
          <div className="font-semibold mb-1">
            {hoverRow ? `${flagOf(hoverRow.country_iso)} ${hover.name}` : hover.name}
          </div>
          {hoverRow ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground tabular-nums">
              <span>Units</span><span className="text-right text-foreground">{fmtInt(hoverRow.units)}</span>
              <span>Revenue</span><span className="text-right text-foreground">{fmtUSDFull(hoverRow.revenue_usd)}</span>
              <span>% of total</span><span className="text-right text-foreground">{(hoverRow.pct_of_total * 100).toFixed(2)}%</span>
              <span>ASP</span><span className="text-right text-foreground">${hoverRow.asp_usd.toFixed(2)}</span>
            </div>
          ) : (
            <div className="text-muted-foreground">No sales in this period</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sortable table ────────────────────────────────────────────────────────
interface CountryTableProps {
  rows: CountryRow[];
  topRevenue: number;
}
function CountryTable({ rows, topRevenue }: CountryTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filter, setFilter] = useState("");

  const sorted = useMemo(() => {
    const filtered = filter.trim()
      ? rows.filter((r) => r.country_name.toLowerCase().includes(filter.toLowerCase()) || r.country_iso.toLowerCase().includes(filter.toLowerCase()))
      : rows;
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case "country": av = a.country_name; bv = b.country_name; break;
        case "units":   av = a.units;        bv = b.units; break;
        case "asp":     av = a.asp_usd;      bv = b.asp_usd; break;
        case "pct":     av = a.pct_of_total; bv = b.pct_of_total; break;
        case "revenue":
        default:        av = a.revenue_usd;  bv = b.revenue_usd; break;
      }
      const cmp = typeof av === "string" ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "desc" ? -cmp : cmp;
    });
    return arr;
  }, [rows, filter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(key); setSortDir(key === "country" ? "asc" : "desc"); }
  };
  const SortIcon = ({ active, dir }: { active: boolean; dir: SortDir }) =>
    !active ? <ChevronsUpDown className="ml-1 h-3 w-3 inline text-muted-foreground/40" />
      : dir === "desc" ? <ChevronDown className="ml-1 h-3 w-3 inline" />
                       : <ChevronUp className="ml-1 h-3 w-3 inline" />;

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-3">
        <div className="text-xs text-muted-foreground">
          {sorted.length} of {rows.length} countries {filter && `matching "${filter}"`}
        </div>
        <Input
          placeholder="Filter countries…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs h-8 text-xs"
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("country")}>
              Country <SortIcon active={sortKey === "country"} dir={sortDir} />
            </TableHead>
            <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("units")}>
              Units <SortIcon active={sortKey === "units"} dir={sortDir} />
            </TableHead>
            <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("revenue")}>
              Revenue <SortIcon active={sortKey === "revenue"} dir={sortDir} />
            </TableHead>
            <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("asp")}>
              ASP <SortIcon active={sortKey === "asp"} dir={sortDir} />
            </TableHead>
            <TableHead className="text-right cursor-pointer select-none w-[180px]" onClick={() => toggleSort("pct")}>
              % of total <SortIcon active={sortKey === "pct"} dir={sortDir} />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r) => {
            const barPct = topRevenue > 0 ? (r.revenue_usd / topRevenue) * 100 : 0;
            return (
              <TableRow key={r.country_iso}>
                <TableCell className="text-lg leading-none py-1">{flagOf(r.country_iso)}</TableCell>
                <TableCell className="font-medium py-1">{r.country_name}</TableCell>
                <TableCell className="text-right tabular-nums py-1">{fmtInt(r.units)}</TableCell>
                <TableCell className="text-right tabular-nums py-1">{fmtUSDFull(r.revenue_usd)}</TableCell>
                <TableCell className="text-right tabular-nums py-1">${r.asp_usd.toFixed(2)}</TableCell>
                <TableCell className="text-right tabular-nums py-1">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-24 h-1.5 bg-muted rounded-sm overflow-hidden">
                      <div className="h-full bg-primary/50" style={{ width: `${Math.min(100, barPct)}%` }} />
                    </div>
                    <span className="w-12 text-right">{fmtPct(r.pct_of_total)}</span>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Range chip control ────────────────────────────────────────────────────
interface RangeChipsProps {
  value: RangeKey;
  onChange: (k: RangeKey) => void;
  customSince: string;
  customUntil: string;
  onCustomChange: (since: string, until: string) => void;
}
function RangeChips({ value, onChange, customSince, customUntil, onCustomChange }: RangeChipsProps) {
  const items: Array<{ k: RangeKey; label: string }> = [
    { k: "30d",  label: "30d" },
    { k: "90d",  label: "90d" },
    { k: "180d", label: "6mo" },
    { k: "365d", label: "1yr" },
    { k: "ltd",  label: "LTD" },
    { k: "custom", label: "Custom" },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {items.map((it) => (
        <Button
          key={it.k}
          size="sm"
          variant={value === it.k ? "default" : "outline"}
          className="h-7 px-3 text-xs"
          onClick={() => onChange(it.k)}
        >
          {it.label}
        </Button>
      ))}
      {value === "custom" && (
        <div className="flex items-center gap-2 ml-2">
          <Input type="date" value={customSince} onChange={(e) => onCustomChange(e.target.value, customUntil)} className="h-7 text-xs w-[140px]" />
          <span className="text-xs text-muted-foreground">→</span>
          <Input type="date" value={customUntil} onChange={(e) => onCustomChange(customSince, e.target.value)} className="h-7 text-xs w-[140px]" />
        </div>
      )}
    </div>
  );
}

// ─── KPI strip ─────────────────────────────────────────────────────────────
function KpiStrip({ data }: { data: AggregateResponse | undefined }) {
  const top = data?.countries?.[0];
  const cells: Array<{ lab: string; val: string }> = data ? [
    { lab: "Revenue",     val: fmtUSD(data.total_revenue_usd) },
    { lab: "Units",       val: fmtInt(data.total_units) },
    { lab: "ASP",         val: `$${data.asp_usd.toFixed(2)}` },
    { lab: "Top country", val: top ? `${flagOf(top.country_iso)} ${top.country_iso} · ${fmtPct(top.pct_of_total)}` : "—" },
  ] : Array.from({ length: 4 }, () => ({ lab: "", val: "" }));
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border rounded-md overflow-hidden">
      {cells.map((c, i) => (
        <div key={i} className="bg-card p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{c.lab || <Skeleton className="h-3 w-16" />}</div>
          <div className="text-lg font-semibold tabular-nums mt-1">{c.val || <Skeleton className="h-6 w-24 mt-1" />}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────
export default function SalesByCountryPage() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("30d");
  const [customSince, setCustomSince] = useState<string>("");
  const [customUntil, setCustomUntil] = useState<string>("");

  const range = rangeFor(rangeKey, customSince, customUntil);

  const queryEnabled = rangeKey !== "custom" || (!!customSince && !!customUntil);

  const { data, isLoading, error } = useQuery<AggregateResponse>({
    queryKey: ["sales-by-country-aggregate", range.since ?? "", range.until ?? ""],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (range.since) p.set("since", range.since);
      if (range.until) p.set("until", range.until);
      const res = await fetch(`/signal/api/sales-by-country/aggregate?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: queryEnabled,
    staleTime: 5 * 60 * 1000,
  });

  const rows = data?.countries ?? [];
  const topRevenue = rows[0]?.revenue_usd ?? 0;

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Globe2 className="h-4 w-4 text-primary" />
          <h1 className="text-xl font-semibold">Sales by Country</h1>
        </div>
        <div className="text-xs text-muted-foreground">
          {range.label}
          {data && (
            <> · {data.countries_count} countries · {fmtInt(data.total_units)} units · {fmtUSD(data.total_revenue_usd)} revenue · {data.products_included} products</>
          )}
        </div>
      </div>

      <RangeChips
        value={rangeKey}
        onChange={setRangeKey}
        customSince={customSince}
        customUntil={customUntil}
        onCustomChange={(s, u) => { setCustomSince(s); setCustomUntil(u); }}
      />

      {error && (
        <Card className="p-4 border-destructive/50 text-destructive text-xs">
          Failed to load sales data: {(error as Error).message}
        </Card>
      )}

      <KpiStrip data={data} />

      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-2 border-b text-xs text-muted-foreground flex items-center justify-between">
          <span>Global distribution — hover any country</span>
          {isLoading && <span className="text-[10px]">loading…</span>}
        </div>
        <div className="bg-muted/20">
          <WorldMap rows={rows} totalRevenue={data?.total_revenue_usd ?? 0} />
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-3">
          <div className="text-sm font-semibold">Country breakdown</div>
          <div className="text-xs text-muted-foreground">Sortable — click any column header. Type in the filter box to search by country name or ISO2 code.</div>
        </div>
        {isLoading && rows.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">
            No country data ingested for this range yet. If the monthly backfill hasn't run for these dates, try widening to LTD or check the ingestion status in Settings.
          </div>
        ) : (
          <CountryTable rows={rows} topRevenue={topRevenue} />
        )}
      </Card>
    </div>
  );
}
