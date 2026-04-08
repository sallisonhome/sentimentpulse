import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { CalendarIcon, Loader2 } from "lucide-react";
import { format } from "date-fns";

interface DataInputDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: string; // steamWishlist | steamPrepurchase | ps5Wishlist | ps5Prepurchase
  productId: number;
}

const TYPE_CONFIG: Record<string, { title: string; endpoint: string; queryKey: string }> = {
  steamWishlist: {
    title: "Steam Wishlist Count",
    endpoint: "steam/wishlists",
    queryKey: "steam-wishlists",
  },
  steamPrepurchase: {
    title: "Steam Pre-Purchase Count",
    endpoint: "steam/prepurchases",
    queryKey: "steam-prepurchases",
  },
  ps5Wishlist: {
    title: "PS5 Wishlist Count",
    endpoint: "ps5/wishlists",
    queryKey: "ps5-wishlists",
  },
  ps5Prepurchase: {
    title: "PS5 Pre-Purchase Count",
    endpoint: "ps5/prepurchases",
    queryKey: "ps5-prepurchases",
  },
};

export function DataInputDialog({ open, onOpenChange, type, productId }: DataInputDialogProps) {
  const { toast } = useToast();
  const config = TYPE_CONFIG[type];
  const [date, setDate] = useState<Date>(new Date());
  const [cumulativeCount, setCumulativeCount] = useState("");
  const [dailyDelta, setDailyDelta] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/products/${productId}/${config.endpoint}`, {
        date: format(date, "yyyy-MM-dd"),
        cumulativeCount: parseInt(cumulativeCount) || 0,
        dailyDelta: parseInt(dailyDelta) || 0,
        source: "manual",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/products", productId] });
      toast({ title: "Data recorded" });
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (!config) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Input {config.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full h-8 text-sm justify-start">
                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                  {format(date, "MMM d, yyyy")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={date} onSelect={(d) => d && setDate(d)} initialFocus />
              </PopoverContent>
            </Popover>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Cumulative Count (LTD)</Label>
            <Input
              type="number"
              value={cumulativeCount}
              onChange={(e) => setCumulativeCount(e.target.value)}
              placeholder="Total lifetime count"
              className="h-8 text-sm"
              data-testid="input-cumulative-count"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Daily Delta</Label>
            <Input
              type="number"
              value={dailyDelta}
              onChange={(e) => setDailyDelta(e.target.value)}
              placeholder="Change from previous day"
              className="h-8 text-sm"
              data-testid="input-daily-delta"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} className="h-7 text-xs">Cancel</Button>
            <Button
              size="sm"
              onClick={() => mutation.mutate()}
              disabled={!cumulativeCount || mutation.isPending}
              className="h-7 text-xs"
              data-testid="button-submit-data"
            >
              {mutation.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
