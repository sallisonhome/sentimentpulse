/**
 * Amazon Retail — Buy Box monitor (scaffold).
 *
 * Table of every tracked ASIN with the latest scraped Buy Box state:
 * price, seller, whether Amazon is holding the Buy Box, Prime flag,
 * stock status, and current main BSR. Phase 2 will add color coding,
 * delta-vs-yesterday, and a "Buy Box lost" alert.
 */
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface BuyBoxRow {
  productId: number;
  title: string | null;
  platform: string;
  asin: string;
  isSwitch2: boolean;
  snapshotDate: string | null;
  buyboxPrice: number | null;
  buyboxSeller: string | null;
  buyboxIsAmazon: boolean | null;
  isPrime: boolean | null;
  stockStatus: string | null;
  mainBsr: number | null;
}

export default function AmazonBuyBox() {
  const { data, isLoading } = useQuery<{ rows: BuyBoxRow[] }>({
    queryKey: ["/api/amazon/buybox"],
  });
  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return <Card className="p-8 text-center text-xs text-muted-foreground">No tracked ASINs yet — add ASIN mappings to populate the Buy Box grid.</Card>;
  }
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead className="w-[80px]">Platform</TableHead>
            <TableHead className="w-[100px]">ASIN</TableHead>
            <TableHead className="w-[80px] text-right">Price</TableHead>
            <TableHead>Buy Box Seller</TableHead>
            <TableHead className="w-[80px]">Prime</TableHead>
            <TableHead className="w-[120px]">Stock</TableHead>
            <TableHead className="w-[80px] text-right">BSR</TableHead>
            <TableHead className="w-[100px]">As of</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.asin} data-testid={`row-buybox-${r.asin}`}>
              <TableCell className="text-xs font-medium">
                <a href={`#/amazon/product/${r.asin}`} className="hover:underline">{r.title ?? r.asin}</a>
              </TableCell>
              <TableCell className="text-xs uppercase">
                {r.platform}{r.isSwitch2 ? " 2" : ""}
              </TableCell>
              <TableCell className="text-[10px] tabular-nums text-muted-foreground">{r.asin}</TableCell>
              <TableCell className="text-xs tabular-nums text-right">{r.buyboxPrice != null ? `$${r.buyboxPrice.toFixed(2)}` : "—"}</TableCell>
              <TableCell className="text-xs">
                {r.buyboxSeller ?? "—"}
                {r.buyboxIsAmazon && <Badge variant="secondary" className="ml-2 text-[10px]">Amazon</Badge>}
              </TableCell>
              <TableCell>{r.isPrime ? <Badge variant="secondary">Prime</Badge> : <span className="text-[10px] text-muted-foreground">—</span>}</TableCell>
              <TableCell className="text-xs">{r.stockStatus ?? "—"}</TableCell>
              <TableCell className="text-xs tabular-nums text-right">{r.mainBsr != null ? `#${r.mainBsr.toLocaleString()}` : "—"}</TableCell>
              <TableCell className="text-[10px] tabular-nums text-muted-foreground">{r.snapshotDate ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
