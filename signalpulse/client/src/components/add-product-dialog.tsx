import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { CalendarIcon, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { ALL_PLATFORMS, GENRES, PLAYER_FORMATS } from "@shared/schema";

interface AddProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editProduct?: any;
}

export function AddProductDialog({ open, onOpenChange, editProduct }: AddProductDialogProps) {
  const { toast } = useToast();
  const isEdit = !!editProduct;

  const [title, setTitle] = useState(editProduct?.title ?? "");
  const [publisher, setPublisher] = useState(editProduct?.publisher ?? "Saber Interactive");
  const [platforms, setPlatforms] = useState<string[]>(editProduct?.platforms ?? []);
  const [playerFormat, setPlayerFormat] = useState(editProduct?.playerFormat ?? "single_player");
  const [genre, setGenre] = useState(editProduct?.genre ?? "");
  const [releaseDate, setReleaseDate] = useState<Date | undefined>(
    editProduct?.releaseDate ? new Date(editProduct.releaseDate + "T00:00:00") : undefined
  );
  const [price, setPrice] = useState(editProduct?.targetRetailPriceUsd?.toString() ?? "59.99");
  const [steamAppId, setSteamAppId] = useState(editProduct?.steamAppId ?? "");
  const [perPlatformPricing, setPerPlatformPricing] = useState(false);
  const [platformPrices, setPlatformPrices] = useState<Record<string, string>>({});

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/products/${editProduct.id}`, data);
        return res.json();
      }
      const res = await apiRequest("POST", "/api/products", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      if (isEdit) {
        queryClient.invalidateQueries({ queryKey: ["/api/products", editProduct.id] });
      }
      toast({ title: isEdit ? "Product updated" : "Product created" });
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handlePlatformToggle = (platform: string) => {
    setPlatforms(prev =>
      prev.includes(platform)
        ? prev.filter(p => p !== platform)
        : [...prev, platform]
    );
  };

  const selectAllPlatforms = () => {
    setPlatforms([...ALL_PLATFORMS]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !genre || !releaseDate || platforms.length === 0) {
      toast({ title: "Missing fields", description: "Please fill in all required fields.", variant: "destructive" });
      return;
    }

    const data: any = {
      title,
      publisher,
      platforms,
      playerFormat,
      genre,
      releaseDate: format(releaseDate, "yyyy-MM-dd"),
      targetRetailPriceUsd: parseFloat(price) || null,
      steamAppId: steamAppId || null,
      // v3.26 (2026-08-19): manual forecast input removed — dynamic
      // forecasting (wishlist-driven pre-launch, actuals-driven once live)
      // is fully automatic and requires no setup-time forecast entry.
      perPlatformPricing: perPlatformPricing ? platformPrices : null,
    };

    createMutation.mutate(data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{isEdit ? "Edit Product" : "Add Product"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 mt-2">
          {/* Title */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Title *</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Game title"
              data-testid="input-title"
              className="h-9 text-sm"
            />
          </div>

          {/* Publisher */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Publisher</Label>
            <Input
              value={publisher}
              onChange={(e) => setPublisher(e.target.value)}
              placeholder="Saber Interactive"
              data-testid="input-publisher"
              className="h-9 text-sm"
            />
          </div>

          {/* Platforms */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Platforms *</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={selectAllPlatforms}
                className="h-6 text-[10px] text-primary"
              >
                Select All
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {ALL_PLATFORMS.map((p) => (
                <label
                  key={p}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs cursor-pointer transition-colors ${
                    platforms.includes(p)
                      ? "bg-primary/10 border-primary/30 text-primary"
                      : "bg-card border-border text-muted-foreground hover:border-primary/20"
                  }`}
                >
                  <Checkbox
                    checked={platforms.includes(p)}
                    onCheckedChange={() => handlePlatformToggle(p)}
                    className="h-3 w-3"
                  />
                  {p}
                </label>
              ))}
            </div>
          </div>

          {/* Player Format + Genre row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Player Format *</Label>
              <Select value={playerFormat} onValueChange={setPlayerFormat}>
                <SelectTrigger className="h-9 text-sm" data-testid="select-player-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAYER_FORMATS.map(f => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Genre *</Label>
              <Select value={genre} onValueChange={setGenre}>
                <SelectTrigger className="h-9 text-sm" data-testid="select-genre">
                  <SelectValue placeholder="Select genre" />
                </SelectTrigger>
                <SelectContent>
                  {GENRES.map(g => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Release Date */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Release Date *</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full h-9 text-sm justify-start text-left font-normal"
                  data-testid="button-release-date"
                >
                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                  {releaseDate ? format(releaseDate, "MMM d, yyyy") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={releaseDate}
                  onSelect={setReleaseDate}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Price */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Target Retail Price (USD)</Label>
            <Input
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="59.99"
              data-testid="input-price"
              className="h-9 text-sm"
            />
          </div>

          {/* Steam App ID */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Steam App ID</Label>
            <Input
              value={steamAppId}
              onChange={(e) => setSteamAppId(e.target.value)}
              placeholder="e.g. 2183900"
              data-testid="input-steam-app-id"
              className="h-9 text-sm"
            />
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="h-8 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={createMutation.isPending}
              className="h-8 text-xs"
              data-testid="button-submit-product"
            >
              {createMutation.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {isEdit ? "Save Changes" : "Create Product"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
