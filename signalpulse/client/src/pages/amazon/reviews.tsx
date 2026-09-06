/**
 * Amazon Retail — Reviews Pulse (scaffold).
 *
 * For every tracked ASIN: current rating and total reviews, plus deltas
 * over the last 7 and 30 days sourced from historical amazon_product_daily
 * rows. Phase 2 will layer in verified-purchase share and sentiment.
 */
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

interface ReviewsRow {
  productId: number;
  title: string | null;
  asin: string;
  platform: string;
  ratingsTotal: number | null;
  ratingsDelta7d: number | null;
  ratingsDelta30d: number | null;
  rating: number | null;
}

function Delta({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground">—</span>;
  if (v === 0) return <span className="text-muted-foreground">·</span>;
  const sign = v > 0 ? "+" : "";
  return <span className="tabular-nums">{sign}{v.toLocaleString()}</span>;
}

export default function AmazonReviews() {
  const { data, isLoading } = useQuery<{ rows: ReviewsRow[] }>({
    queryKey: ["/api/amazon/reviews-pulse"],
  });
  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return <Card className="p-8 text-center text-xs text-muted-foreground">No tracked ASINs yet.</Card>;
  }
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead className="w-[80px]">Platform</TableHead>
            <TableHead className="w-[100px]">ASIN</TableHead>
            <TableHead className="w-[80px] text-right">Rating</TableHead>
            <TableHead className="w-[100px] text-right">Reviews</TableHead>
            <TableHead className="w-[100px] text-right">+ / 7d</TableHead>
            <TableHead className="w-[100px] text-right">+ / 30d</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.asin} data-testid={`row-reviews-${r.asin}`}>
              <TableCell className="text-xs font-medium">
                <a href={`#/amazon/product/${r.asin}`} className="hover:underline">{r.title ?? r.asin}</a>
              </TableCell>
              <TableCell className="text-xs uppercase">{r.platform}</TableCell>
              <TableCell className="text-[10px] tabular-nums text-muted-foreground">{r.asin}</TableCell>
              <TableCell className="text-xs tabular-nums text-right">{r.rating != null ? `★ ${r.rating.toFixed(1)}` : "—"}</TableCell>
              <TableCell className="text-xs tabular-nums text-right">{r.ratingsTotal != null ? r.ratingsTotal.toLocaleString() : "—"}</TableCell>
              <TableCell className="text-xs text-right"><Delta v={r.ratingsDelta7d} /></TableCell>
              <TableCell className="text-xs text-right"><Delta v={r.ratingsDelta30d} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
