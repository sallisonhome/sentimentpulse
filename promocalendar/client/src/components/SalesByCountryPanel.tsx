// Promo Calendar Sales-by-Country panel (v3.31, 2026-09-05).
//
// Renders a per-title country breakdown on the PDP. Fetches from
// SignalPulse via `GET /api/promo-support/sales-by-country?steam_app_id=…`,
// which is exposed unauthenticated over loopback + nginx (see
// signalpulse/server/saber-auth.ts EXEMPT_PATHS_READ_ONLY_CROSS_APP).
//
// UI matches the Promo Calendar's dark aesthetic (styled inline, no shadcn):
//   - Range chips (30d, 90d, 6mo, 1yr, LTD, Custom, optional "Last promo")
//   - KPI strip (Revenue, Units, ASP, Top country)
//   - Full-width D3 world choropleth on world-atlas TopoJSON with tooltip
//   - Sortable country table with inline percentage bar
//
// The "Last promo event" chip is the calendar's headline feature: when
// the title has at least one past campaign, the chip is present and
// pre-fills the range to that most-recent-ended event's window.

import { useEffect, useMemo, useRef, useState } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryObject } from "topojson-specification";
import type { Feature, FeatureCollection } from "geojson";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CountryRow {
  country_iso: string;
  country_name: string;
  units: number;
  revenue_usd: number;
  asp_usd: number;
  pct_of_total: number;
}
export interface SbcResponse {
  steam_app_id: number | null;
  product_id: number | null;
  since: string | null;
  until: string | null;
  total_units: number;
  total_revenue_usd: number;
  asp_usd: number;
  countries_count: number;
  countries: CountryRow[];
  found: boolean;
  // v3.33.3 (2026-09-05): base + DLC unit split from steam_sales_daily.
  base_units?: number;
  dlc_units?: number;
  base_revenue_usd?: number;
  dlc_revenue_usd?: number;
}

export interface LastPromoWindow {
  since: string;
  until: string;
  label: string; // e.g. "Steam · Autumn Sales · Oct 1 → Oct 8"
}

type RangeKey = "30d" | "90d" | "180d" | "365d" | "ltd" | "custom" | "last_promo";

// ─── Static maps + helpers ─────────────────────────────────────────────────

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

function flagOf(iso2: string): string {
  if (!iso2 || iso2.length !== 2) return "";
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (iso2.charCodeAt(0) - 65)) +
         String.fromCodePoint(A + (iso2.charCodeAt(1) - 65));
}

function fmtUSD(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtUSDFull(n: number): string {
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtInt(n: number): string { return n.toLocaleString(); }
function fmtPct(n: number): string { return (n * 100).toFixed(1) + "%"; }

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function rangeFor(
  key: RangeKey,
  today: string,
  customSince?: string,
  customUntil?: string,
  lastPromo?: LastPromoWindow | null,
): { since?: string; until?: string; label: string } {
  const t = new Date(today);
  const untilStr = today;
  const daysBack = (n: number) => {
    const d = new Date(t);
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
        label: customSince && customUntil ? `${customSince} → ${customUntil}` : "Custom",
      };
    case "last_promo":
      if (lastPromo) return { since: lastPromo.since, until: lastPromo.until, label: lastPromo.label };
      return { since: undefined, until: undefined, label: "Last promo (unavailable)" };
  }
}

const SCALE = ["#d9eaea", "#a8d6d6", "#6fbfbf", "#3fa1a1", "#1e7d7d", "#0a5252"];
const NO_DATA = "rgba(148,163,184,0.15)";
function colorFor(rev: number | null | undefined, max: number): string {
  if (rev == null || rev <= 0 || max <= 0) return NO_DATA;
  const t = Math.min(1, rev / max);
  const idx = Math.min(SCALE.length - 1, Math.floor(t * SCALE.length));
  return SCALE[idx];
}

// ─── World map ─────────────────────────────────────────────────────────────

function useWorldTopo(url: string) {
  const [topo, setTopo] = useState<Topology | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(url).then(r => r.json()).then((t: Topology) => {
      if (!cancelled) setTopo(t);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [url]);
  return topo;
}

interface WorldMapProps { rows: CountryRow[]; height?: number; }
function WorldMap({ rows, height = 340 }: WorldMapProps) {
  // BASE_URL is baked at build time; for Promo Calendar it's `/promo/`.
  const worldAtlasUrl = `${import.meta.env.BASE_URL}world-atlas-110m.json`;
  const topo = useWorldTopo(worldAtlasUrl);
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
      const geomObj = topo.objects.countries as GeometryObject;
      const raw = feature(topo, geomObj) as unknown as FeatureCollection | Feature;
      if (raw && (raw as FeatureCollection).features) return (raw as FeatureCollection).features;
      if (raw && (raw as Feature).geometry) return [raw as Feature];
      return [];
    } catch { return []; }
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
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height, background: "rgba(15,23,42,0.35)", borderRadius: 8, overflow: "hidden" }}>
      {!topo && <div style={{ padding: 24, color: "#94a3b8", fontSize: 12 }}>Loading map…</div>}
      {topo && (
        <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "100%" }}>
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
                  stroke="#0b1220"
                  strokeWidth={0.4}
                  onMouseEnter={(e) => {
                    const rect = wrapRef.current?.getBoundingClientRect();
                    const name = (f.properties as { name?: string } | null)?.name ?? "Unknown";
                    setHover({ x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0), iso_n: isoN, name });
                  }}
                  onMouseMove={(e) => {
                    const rect = wrapRef.current?.getBoundingClientRect();
                    setHover((h) => h ? { ...h, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) } : h);
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
      <div style={{ position: "absolute", bottom: 6, left: 8, display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#94a3b8", pointerEvents: "none" }}>
        <span>low</span>
        {SCALE.map(c => <span key={c} style={{ background: c, width: 18, height: 8, display: "inline-block" }} />)}
        <span>high</span>
        <span style={{ background: NO_DATA, width: 18, height: 8, display: "inline-block", marginLeft: 8 }} />
        <span>no data</span>
      </div>
      {/* Tooltip */}
      {hover && (
        <div style={{
          position: "absolute", pointerEvents: "none", zIndex: 10,
          left: Math.min(hover.x + 12, (wrapRef.current?.clientWidth ?? 720) - 220),
          top: hover.y + 12,
          background: "#0f172a", border: "1px solid #334155", borderRadius: 6,
          padding: "8px 10px", fontSize: 12, color: "#e2e8f0", minWidth: 200,
          boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {hoverRow ? `${flagOf(hoverRow.country_iso)} ${hover.name}` : hover.name}
          </div>
          {hoverRow ? (
            <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "0 12px", color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
              <span>Units</span><span style={{ textAlign: "right", color: "#e2e8f0" }}>{fmtInt(hoverRow.units)}</span>
              <span>Revenue</span><span style={{ textAlign: "right", color: "#e2e8f0" }}>{fmtUSDFull(hoverRow.revenue_usd)}</span>
              <span>% of total</span><span style={{ textAlign: "right", color: "#e2e8f0" }}>{(hoverRow.pct_of_total * 100).toFixed(2)}%</span>
              <span>ASP</span><span style={{ textAlign: "right", color: "#e2e8f0" }}>${hoverRow.asp_usd.toFixed(2)}</span>
            </div>
          ) : (
            <div style={{ color: "#94a3b8" }}>No sales in this period</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sortable table ────────────────────────────────────────────────────────

type SortKey = "country" | "units" | "revenue" | "asp" | "pct";
type SortDir = "asc" | "desc";

function CountryTable({ rows, topRevenue }: { rows: CountryRow[]; topRevenue: number }) {
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filter, setFilter] = useState("");

  const sorted = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f ? rows.filter(r => r.country_name.toLowerCase().includes(f) || r.country_iso.toLowerCase().includes(f)) : rows;
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case "country": av = a.country_name; bv = b.country_name; break;
        case "units":   av = a.units;        bv = b.units; break;
        case "asp":     av = a.asp_usd;      bv = b.asp_usd; break;
        case "pct":     av = a.pct_of_total; bv = b.pct_of_total; break;
        default:        av = a.revenue_usd;  bv = b.revenue_usd; break;
      }
      const cmp = typeof av === "string" ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "desc" ? -cmp : cmp;
    });
    return arr;
  }, [rows, filter, sortKey, sortDir]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) setSortDir(d => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(k); setSortDir(k === "country" ? "asc" : "desc"); }
  };
  const arrow = (k: SortKey) => sortKey === k ? (sortDir === "desc" ? " ↓" : " ↑") : "";
  const th = (label: string, k: SortKey, align: "left" | "right" = "right") => (
    <th onClick={() => toggle(k)} style={{
      cursor: "pointer", userSelect: "none",
      padding: "8px 10px", fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em",
      color: "#94a3b8", fontWeight: 600, textAlign: align, borderBottom: "1px solid #1e293b",
      position: "sticky", top: 0, background: "#0b1220", zIndex: 1,
    }}>{label}{arrow(k)}</th>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12 }}>
        <div style={{ fontSize: 12, color: "#94a3b8" }}>
          {sorted.length} of {rows.length} countries{filter && ` matching "${filter}"`}
        </div>
        <input
          type="text"
          placeholder="Filter countries…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            background: "#0b1220", border: "1px solid #334155", borderRadius: 6,
            padding: "6px 10px", fontSize: 12, color: "#e2e8f0", maxWidth: 220, width: "100%",
          }}
        />
      </div>
      <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid #1e293b", borderRadius: 6 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, color: "#e2e8f0" }}>
          <thead>
            <tr>
              <th style={{ width: 28, background: "#0b1220", position: "sticky", top: 0, zIndex: 1, borderBottom: "1px solid #1e293b" }} />
              {th("Country", "country", "left")}
              {th("Units", "units")}
              {th("Revenue", "revenue")}
              {th("ASP", "asp")}
              {th("% of total", "pct")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const barPct = topRevenue > 0 ? (r.revenue_usd / topRevenue) * 100 : 0;
              return (
                <tr key={r.country_iso} style={{ borderBottom: "1px solid #1e293b" }}>
                  <td style={{ padding: "6px 10px", fontSize: 16 }}>{flagOf(r.country_iso)}</td>
                  <td style={{ padding: "6px 10px", fontWeight: 500 }}>{r.country_name}</td>
                  <td style={{ padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtInt(r.units)}</td>
                  <td style={{ padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtUSDFull(r.revenue_usd)}</td>
                  <td style={{ padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>${r.asp_usd.toFixed(2)}</td>
                  <td style={{ padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                      <div style={{ width: 90, height: 6, background: "#1e293b", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${Math.min(100, barPct)}%`, height: "100%", background: "#3fa1a1" }} />
                      </div>
                      <span style={{ width: 42, textAlign: "right" }}>{fmtPct(r.pct_of_total)}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main panel ────────────────────────────────────────────────────────────

export interface SalesByCountryPanelProps {
  steamAppId: number;
  today: string;
  // When set, adds a "Last promo event" chip that pre-fills the window
  // to that event's dates and label. Auto-selected as the initial range
  // if provided.
  lastPromo?: LastPromoWindow | null;
}
export function SalesByCountryPanel({ steamAppId, today, lastPromo }: SalesByCountryPanelProps) {
  // Default: "last_promo" if we have one, otherwise 90d.
  const [rangeKey, setRangeKey] = useState<RangeKey>(lastPromo ? "last_promo" : "90d");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  const [data, setData] = useState<SbcResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = rangeFor(rangeKey, today, customSince, customUntil, lastPromo);
  const enabled = rangeKey !== "custom" || (!!customSince && !!customUntil);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    p.set("steam_app_id", String(steamAppId));
    if (spec.since) p.set("since", spec.since);
    if (spec.until) p.set("until", spec.until);
    fetch(`/signal/api/promo-support/sales-by-country?${p.toString()}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((body: SbcResponse) => { if (!cancelled) setData(body); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [steamAppId, spec.since, spec.until, enabled]);

  const chip = (k: RangeKey, label: string) => (
    <button
      key={k}
      onClick={() => setRangeKey(k)}
      style={{
        padding: "5px 11px", fontSize: 12, fontWeight: 600,
        border: "1px solid " + (rangeKey === k ? "#3fa1a1" : "#334155"),
        background: rangeKey === k ? "#3fa1a1" : "transparent",
        color: rangeKey === k ? "#0b1220" : "#94a3b8",
        borderRadius: 999, cursor: "pointer",
      }}
    >{label}</button>
  );

  const top = data?.countries?.[0];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {lastPromo && chip("last_promo", lastPromo.label)}
        {chip("30d", "30d")}
        {chip("90d", "90d")}
        {chip("180d", "6mo")}
        {chip("365d", "1yr")}
        {chip("ltd", "LTD")}
        {chip("custom", "Custom")}
        {rangeKey === "custom" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
            <input type="date" value={customSince} onChange={(e) => setCustomSince(e.target.value)}
              style={{ background: "#0b1220", border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", color: "#e2e8f0", fontSize: 12 }} />
            <span style={{ color: "#94a3b8", fontSize: 12 }}>→</span>
            <input type="date" value={customUntil} onChange={(e) => setCustomUntil(e.target.value)}
              style={{ background: "#0b1220", border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", color: "#e2e8f0", fontSize: 12 }} />
          </div>
        )}
        <div style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>{spec.label}</div>
      </div>

      {error && (
        <div style={{ padding: 10, borderRadius: 6, border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5", fontSize: 12 }}>
          Failed to load: {error}
        </div>
      )}

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1, background: "#1e293b", borderRadius: 6, overflow: "hidden" }}>
        {[
          { lab: "Revenue", val: data ? fmtUSD(data.total_revenue_usd) : "—" },
          {
            lab: (data && (data.base_units != null || data.dlc_units != null))
              ? "Units (Base / DLC)"
              : "Units",
            val: data
              ? (data.base_units != null || data.dlc_units != null)
                  ? `${fmtInt(data.base_units ?? 0)} / ${fmtInt(data.dlc_units ?? 0)}`
                  : fmtInt(data.total_units)
              : "—",
          },
          { lab: "ASP", val: data ? `$${data.asp_usd.toFixed(2)}` : "—" },
          { lab: "Top country", val: top ? `${flagOf(top.country_iso)} ${top.country_iso} · ${fmtPct(top.pct_of_total)}` : "—" },
        ].map((c, i) => (
          <div key={i} style={{ background: "#0f172a", padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600 }}>{c.lab}</div>
            <div style={{ fontSize: 18, color: "#e2e8f0", fontWeight: 600, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{c.val}</div>
          </div>
        ))}
      </div>

      <WorldMap rows={data?.countries ?? []} height={340} />

      {loading && (!data || data.countries.length === 0) ? (
        <div style={{ padding: 24, color: "#94a3b8", fontSize: 12, textAlign: "center" }}>Loading country data…</div>
      ) : !data || data.countries.length === 0 ? (
        <div style={{ padding: 24, color: "#94a3b8", fontSize: 12, textAlign: "center" }}>
          No country data ingested for this range yet. Try widening to LTD.
        </div>
      ) : (
        <CountryTable rows={data.countries} topRevenue={data.countries[0]?.revenue_usd ?? 0} />
      )}
    </div>
  );
}
