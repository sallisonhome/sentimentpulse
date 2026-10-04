// Live probe of the deep-chart collectors (no database writes). Run from a scratch directory:
//   mkdir -p /tmp/probe && cd /tmp/probe && TSX_TSCONFIG_PATH=<repo>/signalpulse/tsconfig.json tsx <repo>/signalpulse/scripts/probe-deep-chart.ts
import { collectXboxChartIds, classifyXboxChart, collectPs5Chart, rerankPaidOnly, realXboxDeps } from "../server/signals/console/deepChart";
(async () => {
  let t = Date.now();
  const ids = await collectXboxChartIds(1000, realXboxDeps);
  console.log(`xbox ids=${ids.length} unique=${new Set(ids).size} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  t = Date.now();
  const ranked = rerankPaidOnly(await classifyXboxChart(ids, realXboxDeps));
  const by: Record<string, number> = {}; for (const r of ranked) by[r.businessModel] = (by[r.businessModel] ?? 0) + 1;
  console.log(`xbox classified in ${((Date.now() - t) / 1000).toFixed(1)}s`, JSON.stringify(by), "named", ranked.filter(r => r.name).length);
  console.log("xbox first 5:", JSON.stringify(ranked.slice(0, 5).map(r => [r.rawPosition, r.paidRank, r.businessModel, (r.name ?? "").slice(0, 28)])));
  console.log("xbox f2p rows:", JSON.stringify(ranked.filter(r => r.paidRank == null).map(r => [r.rawPosition, (r.name ?? "").slice(0, 28)])));
  const pr = ranked.filter(r => r.paidRank != null).map(r => r.paidRank!);
  console.log("xbox paid ranks dense:", pr.every((v, i) => v === i + 1), "max", pr[pr.length - 1]);
  t = Date.now();
  const ps = rerankPaidOnly(await collectPs5Chart(500));
  const pby: Record<string, number> = {}; for (const r of ps) pby[r.businessModel] = (pby[r.businessModel] ?? 0) + 1;
  console.log(`ps5 groups=${ps.length} in ${((Date.now() - t) / 1000).toFixed(1)}s`, JSON.stringify(pby));
  console.log("ps5 msrp null/zero groups:", ps.filter(r => r.msrpUsdCents == null).length, ps.filter(r => r.msrpUsdCents === 0).length);
  console.log("ps5 f2p rows:", JSON.stringify(ps.filter(r => r.paidRank == null).slice(0, 12).map(r => [r.rawPosition, (r.name ?? "").slice(0, 26)])));
  for (const k of [1, 50, 100, 101, 250, 400, ps.length]) { const r = ps[k - 1]; if (r) console.log(`ps5 #${k}`, r.paidRank, r.msrpUsdCents, (r.name ?? "").slice(0, 36)); }
  process.exit(0);
})().catch(e => { console.error("PROBE FAILED", e); process.exit(1); });
