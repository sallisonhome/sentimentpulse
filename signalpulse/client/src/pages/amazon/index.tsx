/**
 * Amazon Retail landing (`/amazon` and `/amazon/:section`).
 *
 * Six sub-tabs: Charts / Buy Box / Reviews / Movers / Search SOV /
 * New Releases. Only "Charts" is fully wired; the others are scaffolded
 * tables that hit their live endpoints so the plumbing is verifiable
 * end-to-end (Phase 2 will polish those UIs).
 *
 * The section is driven by the URL segment so a deep-link like
 * /amazon/buybox opens the right tab and a copy-paste survives a reload.
 */
import { useLocation } from "wouter";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import AmazonCharts from "./charts";
import AmazonBuyBox from "./buybox";
import AmazonReviews from "./reviews";
import AmazonMovers from "./movers";
import AmazonSearchSov from "./search-sov";
import AmazonNewReleases from "./new-releases";

const AMAZON_SECTIONS = ["charts", "buybox", "reviews", "movers", "search-sov", "new-releases"] as const;
type Section = typeof AMAZON_SECTIONS[number];

function normalize(section: string | undefined): Section {
  if (section && (AMAZON_SECTIONS as readonly string[]).includes(section)) return section as Section;
  return "charts";
}

function BigAmazonSmile({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 32" width="64" height="32" fill="none" className={className} aria-label="Amazon">
      <path d="M6 20 Q32 34 58 20" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path d="M53 17 L58 20 L53 23" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

interface AmazonIndexProps {
  params?: { section?: string };
}

export default function AmazonIndex({ params }: AmazonIndexProps) {
  const [, navigate] = useLocation();
  const section = normalize(params?.section);

  function handleTabChange(value: string) {
    if (value === "charts") navigate("/amazon");
    else navigate(`/amazon/${value}`);
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <div style={{ color: "#C0553A" }}>
          <BigAmazonSmile />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Amazon Retail</h1>
          <p className="text-xs text-muted-foreground">Saber Intelligence Suite — daily bestseller charts, Buy Box monitor, reviews pulse, and competitive search share</p>
        </div>
      </div>

      <Tabs value={section} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="charts" data-testid="tab-amazon-charts">Charts</TabsTrigger>
          <TabsTrigger value="buybox" data-testid="tab-amazon-buybox">Buy Box</TabsTrigger>
          <TabsTrigger value="reviews" data-testid="tab-amazon-reviews">Reviews</TabsTrigger>
          <TabsTrigger value="movers" data-testid="tab-amazon-movers">Movers</TabsTrigger>
          <TabsTrigger value="search-sov" data-testid="tab-amazon-searchsov">Search SOV</TabsTrigger>
          <TabsTrigger value="new-releases" data-testid="tab-amazon-newreleases">New Releases</TabsTrigger>
        </TabsList>
        <TabsContent value="charts"      className="pt-4"><AmazonCharts /></TabsContent>
        <TabsContent value="buybox"      className="pt-4"><AmazonBuyBox /></TabsContent>
        <TabsContent value="reviews"     className="pt-4"><AmazonReviews /></TabsContent>
        <TabsContent value="movers"      className="pt-4"><AmazonMovers /></TabsContent>
        <TabsContent value="search-sov"  className="pt-4"><AmazonSearchSov /></TabsContent>
        <TabsContent value="new-releases" className="pt-4"><AmazonNewReleases /></TabsContent>
      </Tabs>
    </div>
  );
}
