import type {
  DashboardRow,
  Opportunity,
  OpportunityBucket,
  PdpPayload,
  PhysicalRetailPartner,
  CollectorsEditionItem,
} from "@shared/schema";
import { listTitles, getTitle } from "./signalpulse-read";
import {
  listAllOpportunities,
  listCEItems,
  listOpportunities,
  listRetailPartners,
} from "./storage";

/**
 * Build the dashboard: one row per SignalPulse title that has AT LEAST ONE
 * non-flagged opportunity, retail partner, or CE item. Titles with nothing
 * tracked are suppressed per spec ("If a game has none of these things set
 * up in this tool then there currently is no Publishing Partnerships for
 * that title and nothing should surface").
 */
export function buildDashboard(): DashboardRow[] {
  const titles = listTitles();
  const opps = listAllOpportunities();
  const partners = listRetailPartners();
  const ceItems = listCEItems();

  // Index by product
  const oppsByProduct = new Map<number, Opportunity[]>();
  for (const o of opps) {
    const arr = oppsByProduct.get(o.productId) ?? [];
    arr.push(o);
    oppsByProduct.set(o.productId, arr);
  }
  const partnersByProduct = new Map<number, PhysicalRetailPartner[]>();
  for (const p of partners) {
    const arr = partnersByProduct.get(p.productId) ?? [];
    arr.push(p);
    partnersByProduct.set(p.productId, arr);
  }
  const ceByProduct = new Map<number, CollectorsEditionItem[]>();
  for (const i of ceItems) {
    const arr = ceByProduct.get(i.productId) ?? [];
    arr.push(i);
    ceByProduct.set(i.productId, arr);
  }

  const rows: DashboardRow[] = [];
  for (const t of titles) {
    const o = oppsByProduct.get(t.id) ?? [];
    const p = partnersByProduct.get(t.id) ?? [];
    const ce = ceByProduct.get(t.id) ?? [];
    if (o.length === 0 && p.length === 0 && ce.length === 0) continue;

    const revenue = o.filter((x) => x.category === "Revenue");
    const marketing = o.filter((x) => x.category === "Marketing");

    const securedRevenue = revenue.filter((x) => x.state === "Secured");
    const inDiscussionRevenue = revenue.filter((x) => x.state === "In Negotiation");
    const marketingSecured = marketing.filter((x) => x.state === "Secured");
    const marketingInDiscussion = marketing.filter((x) => x.state === "In Negotiation");

    rows.push({
      title: t,
      securedRevenueCount: securedRevenue.length,
      securedRevenueUsd: sum(securedRevenue.map((x) => x.revenueUsd ?? 0)),
      inDiscussionRevenueCount: inDiscussionRevenue.length,
      inDiscussionRevenueUsd: sum(inDiscussionRevenue.map((x) => x.revenueUsd ?? 0)),
      marketingSecuredCount: marketingSecured.length,
      marketingInDiscussionCount: marketingInDiscussion.length,
      largeMarketingCount: marketing.filter((x) => x.marketingImpact === "Large").length,
      physicalRetailPartners: p.map((x) =>
        x.partnerName === "Other" && x.partnerNameOther
          ? x.partnerNameOther
          : x.partnerName,
      ),
      physicalRetailMgUsd: sum(p.map((x) => x.mgAmountUsd)),
    });
  }

  return rows;
}

/**
 * Build the per-title PDP payload: quadrants, ring chart, header total.
 */
export function buildPdp(productId: number): PdpPayload | null {
  const t = getTitle(productId);
  if (!t) return null;

  const opps = listOpportunities(productId);
  const partners = listRetailPartners(productId);
  const ceItems = listCEItems(productId);

  const bucket = (b: OpportunityBucket) => opps.filter((o) => o.bucket === b);

  const incremental = bucket("IncrementalRevenue");
  const ce = bucket("CollectorsEdition");
  const marketing = bucket("MarketingOpportunity");

  // Header total: all Secured revenue $ across every source that contributes
  // hard revenue — Incremental Revenue Secured, CE Secured (their MG counts),
  // Physical Retail MG Secured, and any Marketing rows the user marked with
  // a marketingValueUsd (rare, spec allows for it).
  const securedIncrementalUsd = sum(
    incremental.filter((o) => o.state === "Secured").map((o) => o.revenueUsd ?? 0),
  );
  const securedCeUsd = sum(
    ce.filter((o) => o.state === "Secured").map((o) => o.revenueUsd ?? 0),
  );
  const securedRetailUsd = sum(
    partners.filter((p) => p.state === "Secured").map((p) => p.mgAmountUsd ?? 0),
  );
  const securedMarketingUsd = sum(
    marketing
      .filter((o) => o.state === "Secured")
      .map((o) => o.marketingValueUsd ?? 0),
  );
  const totalSecuredRevenueUsd =
    securedIncrementalUsd + securedCeUsd + securedRetailUsd + securedMarketingUsd;

  return {
    title: t,
    totalSecuredRevenueUsd,
    ringChart: [
      { bucket: "PhysicalRetail", label: "Physical Retail", usd: securedRetailUsd },
      { bucket: "IncrementalRevenue", label: "Incremental Revenue", usd: securedIncrementalUsd },
      { bucket: "CollectorsEdition", label: "Collectors Editions", usd: securedCeUsd },
      { bucket: "MarketingOpportunity", label: "Marketing Opportunities", usd: securedMarketingUsd },
    ],
    quadrants: {
      physicalRetail: {
        secured: partners.filter((p) => p.state === "Secured"),
        inDiscussion: partners.filter((p) => p.state === "In Negotiation"),
      },
      incrementalRevenue: {
        secured: incremental.filter((o) => o.state === "Secured"),
        inDiscussion: incremental.filter((o) => o.state === "In Negotiation"),
      },
      collectorsEditions: {
        secured: ce.filter((o) => o.state === "Secured"),
        inDiscussion: ce.filter((o) => o.state === "In Negotiation"),
        items: ceItems,
      },
      marketingOpportunities: {
        secured: marketing.filter((o) => o.state === "Secured"),
        inDiscussion: marketing.filter((o) => o.state === "In Negotiation"),
      },
    },
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + (b || 0), 0);
}
