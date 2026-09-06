/**
 * Amazon Retail — New Releases (scaffold).
 *
 * Rainforest's per-platform "new releases" chart, latest snapshot only.
 * Useful for spotting fresh competitive launches within the first days
 * on Amazon before they crack the main bestseller chart.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

const PLATFORMS = [
  { slug: "ps5", label: "PlayStation 5" },
  { slug: "xbox", label: "Xbox Series X|S" },
  { slug: "switch", label: "Nintendo Switch" },
] as const;

interface NewReleaseRow {
  rank: number;
  asin: string;
  title: string;
  imageUrl: string | null;
  price: number | null;
  rating: number | null;
  ratingsTotal: number | null;
}

export default function AmazonNewReleases() {
  const [platform, setPlatform] = useState<string>("ps5");
  const { data, isLoading } = useQuery<{ snapshotDate: string | null; platform: string; rows: NewReleaseRow[] }>({
    queryKey: [`/api/amazon/new-releases/${platform}`],
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-md border border-border p-0.5">
          {PLATFORMS.map((p) => (
            <button
              key={p.slug}
              onClick={() => setPlatform(p.slug)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${platform === p.slug ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
              data-testid={`button-newreleases-platform-${p.slug}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-muted-foreground tabular-nums">{data?.snapshotDate ?? "—"}</div>
      </div>
      {isLoading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : !data || data.rows.length === 0 ? (
        <Card className="p-8 text-center text-xs text-muted-foreground">No new-release snapshot yet for {platform}.</Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50px] text-right">#</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="w-[100px]">ASIN</TableHead>
                <TableHead className="w-[80px] text-right">Price</TableHead>
                <TableHead className="w-[80px] text-right">Rating</TableHead>
                <TableHead className="w-[80px] text-right">Reviews</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.asin} data-testid={`row-newrelease-${platform}-${r.asin}`}>
                  <TableCell className="text-xs tabular-nums text-right">{r.rank}</TableCell>
                  <TableCell className="text-xs font-medium">
                    <a href={`#/amazon/product/${r.asin}`} className="hover:underline">{r.title}</a>
                  </TableCell>
                  <TableCell className="text-[10px] tabular-nums text-muted-foreground">{r.asin}</TableCell>
                  <TableCell className="text-xs tabular-nums text-right">{r.price != null ? `$${r.price.toFixed(2)}` : "—"}</TableCell>
                  <TableCell className="text-xs tabular-nums text-right">{r.rating != null ? `★ ${r.rating.toFixed(1)}` : "—"}</TableCell>
                  <TableCell className="text-xs tabular-nums text-right">{r.ratingsTotal != null ? r.ratingsTotal.toLocaleString() : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
