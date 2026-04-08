import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, CalendarIcon, Video, Newspaper, Gamepad, Target, CheckCircle2, ChevronDown, ChevronRight, Youtube } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { format } from "date-fns";
import { useState } from "react";
import { YouTubeTrackingPanel } from "./youtube-tracking";

interface PLSSectionProps {
  productId: number;
  playerFormat: string;
}

export function PLSSection({ productId, playerFormat }: PLSSectionProps) {
  const { toast } = useToast();
  const [addDialog, setAddDialog] = useState<{ open: boolean; category: string }>({ open: false, category: "" });
  const [addName, setAddName] = useState("");
  const [addTargetDate, setAddTargetDate] = useState<Date | undefined>();

  const { data: milestones, isLoading } = useQuery<any[]>({
    queryKey: ["/api/products", productId, "/pls"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ milestoneId, data }: { milestoneId: number; data: any }) => {
      const res = await apiRequest("PATCH", `/api/products/${productId}/pls/${milestoneId}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/products", productId, "/pls"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (milestoneId: number) => {
      await apiRequest("DELETE", `/api/products/${productId}/pls/${milestoneId}`, undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/products", productId, "/pls"] });
      toast({ title: "Milestone deleted" });
    },
  });

  const addMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", `/api/products/${productId}/pls`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/products", productId, "/pls"] });
      setAddDialog({ open: false, category: "" });
      setAddName("");
      setAddTargetDate(undefined);
      toast({ title: "Milestone added" });
    },
  });

  if (isLoading) {
    return <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}</div>;
  }

  const coreMilestones = milestones?.filter(m => m.category === "core") ?? [];
  const videoMilestones = milestones?.filter(m => m.category === "video") ?? [];
  const pressMilestones = milestones?.filter(m => m.category === "press_coverage") ?? [];
  const demoBetaMilestones = milestones?.filter(m => m.category === "demo_beta") ?? [];

  const handleSetActualDate = (milestoneId: number, date: Date | undefined) => {
    if (!date) return;
    updateMutation.mutate({
      milestoneId,
      data: { actualDate: format(date, "yyyy-MM-dd") },
    });
  };

  const handleClearActualDate = (milestoneId: number) => {
    updateMutation.mutate({
      milestoneId,
      data: { actualDate: null },
    });
  };

  const handleAdd = () => {
    if (!addName) return;
    addMutation.mutate({
      category: addDialog.category,
      name: addName,
      targetDate: addTargetDate ? format(addTargetDate, "yyyy-MM-dd") : null,
      sortOrder: 50,
    });
  };

  const openAddDialog = (category: string) => {
    setAddDialog({ open: true, category });
    setAddName("");
    setAddTargetDate(undefined);
  };

  const getCategoryIcon = (cat: string) => {
    switch (cat) {
      case "core": return <Target className="h-3.5 w-3.5" />;
      case "video": return <Video className="h-3.5 w-3.5" />;
      case "press_coverage": return <Newspaper className="h-3.5 w-3.5" />;
      case "demo_beta": return <Gamepad className="h-3.5 w-3.5" />;
      default: return <Target className="h-3.5 w-3.5" />;
    }
  };

  return (
    <div className="space-y-5">
      {/* Core Milestones */}
      <MilestoneGroup
        title="Core Milestones"
        icon={<Target className="h-3.5 w-3.5 text-gray-500" />}
        milestones={coreMilestones}
        onSetActualDate={handleSetActualDate}
        onClearActualDate={handleClearActualDate}
        onDelete={deleteMutation.mutate}
        addButton={
          <Button
            variant="outline"
            size="sm"
            onClick={() => openAddDialog("core")}
            className="h-7 text-[10px] gap-1"
            data-testid="button-add-core"
          >
            <Plus className="h-3 w-3" /> Add Core Milestone
          </Button>
        }
      />

      {/* Videos */}
      <MilestoneGroup
        title="Videos"
        icon={<Video className="h-3.5 w-3.5 text-blue-500" />}
        milestones={videoMilestones}
        onSetActualDate={handleSetActualDate}
        onClearActualDate={handleClearActualDate}
        onDelete={deleteMutation.mutate}
        isVideoCategory={true}
        addButton={
          <Button
            variant="outline"
            size="sm"
            onClick={() => openAddDialog("video")}
            className="h-7 text-[10px] gap-1"
            data-testid="button-add-video"
          >
            <Plus className="h-3 w-3" /> Add Video
          </Button>
        }
      />

      {/* Press Coverage */}
      <MilestoneGroup
        title="Press Coverage / Beats"
        icon={<Newspaper className="h-3.5 w-3.5 text-green-500" />}
        milestones={pressMilestones}
        onSetActualDate={handleSetActualDate}
        onClearActualDate={handleClearActualDate}
        onDelete={deleteMutation.mutate}
        addButton={
          <Button
            variant="outline"
            size="sm"
            onClick={() => openAddDialog("press_coverage")}
            className="h-7 text-[10px] gap-1"
            data-testid="button-add-beat"
          >
            <Plus className="h-3 w-3" /> Add Major Coverage Beat
          </Button>
        }
        emptyMessage="No press coverage beats added yet."
      />

      {/* Demos & Betas */}
      <MilestoneGroup
        title="Demos & Betas"
        icon={<Gamepad className="h-3.5 w-3.5 text-orange-500" />}
        milestones={demoBetaMilestones}
        onSetActualDate={handleSetActualDate}
        onClearActualDate={handleClearActualDate}
        onDelete={deleteMutation.mutate}
        addButton={
          <Button
            variant="outline"
            size="sm"
            onClick={() => openAddDialog("demo_beta")}
            className="h-7 text-[10px] gap-1"
            data-testid="button-add-beta"
          >
            <Plus className="h-3 w-3" /> Add Beta/Demo
          </Button>
        }
      />

      {/* Add Milestone Dialog */}
      <Dialog open={addDialog.open} onOpenChange={(o) => setAddDialog({ ...addDialog, open: o })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              Add {addDialog.category === "core" ? "Core Milestone" : addDialog.category === "video" ? "Video" : addDialog.category === "press_coverage" ? "Coverage Beat" : "Beta/Demo"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder={
                  addDialog.category === "core" ? "e.g., Key Art Approved, Localization Complete" :
                  addDialog.category === "video" ? "e.g., Gameplay Reveal" :
                  addDialog.category === "press_coverage" ? "e.g., IGN Exclusive Preview" :
                  "e.g., Technical Beta"
                }
                className="h-8 text-sm"
                data-testid="input-milestone-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Target Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full h-8 text-sm justify-start">
                    <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                    {addTargetDate ? format(addTargetDate, "MMM d, yyyy") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={addTargetDate} onSelect={setAddTargetDate} initialFocus />
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setAddDialog({ open: false, category: "" })} className="h-7 text-xs">
                Cancel
              </Button>
              <Button size="sm" onClick={handleAdd} disabled={!addName || addMutation.isPending} className="h-7 text-xs" data-testid="button-submit-milestone">
                Add
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Milestone Group ────────────────────────────────────────────────────────

function MilestoneGroup({
  title, icon, milestones, onSetActualDate, onClearActualDate, onDelete, addButton, emptyMessage, isVideoCategory,
}: {
  title: string;
  icon: React.ReactNode;
  milestones: any[];
  onSetActualDate: (id: number, date: Date | undefined) => void;
  onClearActualDate: (id: number) => void;
  onDelete: (id: number) => void;
  addButton?: React.ReactNode;
  emptyMessage?: string;
  isVideoCategory?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        </div>
        {addButton}
      </div>

      {milestones.length === 0 && emptyMessage ? (
        <p className="text-xs text-muted-foreground/60 py-2">{emptyMessage}</p>
      ) : (
        <div className="space-y-1">
          {milestones.map((m) => (
            <VideoMilestoneRow
              key={m.id}
              milestone={m}
              onSetActualDate={onSetActualDate}
              onClearActualDate={onClearActualDate}
              onDelete={onDelete}
              isVideoCategory={isVideoCategory}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Video Milestone Row (with YouTube Tracking) ────────────────────────────

function VideoMilestoneRow({
  milestone, onSetActualDate, onClearActualDate, onDelete, isVideoCategory,
}: {
  milestone: any;
  onSetActualDate: (id: number, date: Date | undefined) => void;
  onClearActualDate: (id: number) => void;
  onDelete: (id: number) => void;
  isVideoCategory?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isCompleted = !!milestone.actualDate;

  return (
    <div data-testid={`milestone-${milestone.id}`}>
      <div
        className={`flex items-center gap-3 px-3 py-2 rounded-md text-xs transition-colors ${
          isCompleted ? "bg-green-50 dark:bg-green-950/20" : "bg-muted/30"
        } ${isVideoCategory ? "cursor-pointer hover:bg-muted/50" : ""}`}
        onClick={isVideoCategory ? () => setExpanded(!expanded) : undefined}
      >
        {/* Status icon */}
        <div className="shrink-0">
          {isCompleted ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <div className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30" />
          )}
        </div>

        {/* Expand arrow for video milestones */}
        {isVideoCategory && (
          <div className="shrink-0">
            {expanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </div>
        )}

        {/* Name */}
        <div className="flex-1 min-w-0">
          <span className={`font-medium ${isCompleted ? "text-green-700 dark:text-green-400" : ""}`}>
            {milestone.name}
          </span>
          {!milestone.isDefault && (
            <Badge variant="outline" className="ml-1.5 text-[9px] px-1 py-0 h-3.5 font-normal">Custom</Badge>
          )}
        </div>

        {/* Target date */}
        <div className="text-muted-foreground shrink-0 w-24 text-right">
          <span className="text-[10px] uppercase tracking-wide">Target</span>
          <div className="tabular-nums">{formatDate(milestone.targetDate)}</div>
        </div>

        {/* Actual date picker */}
        <div className="shrink-0 w-28 text-right" onClick={(e) => e.stopPropagation()}>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Actual</span>
          <Popover>
            <PopoverTrigger asChild>
              <button className="block w-full text-right tabular-nums hover:text-primary transition-colors cursor-pointer">
                {milestone.actualDate ? formatDate(milestone.actualDate) : (
                  <span className="text-muted-foreground/50">Set date</span>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={milestone.actualDate ? new Date(milestone.actualDate + "T00:00:00") : undefined}
                onSelect={(d) => onSetActualDate(milestone.id, d)}
                initialFocus
              />
              {milestone.actualDate && (
                <div className="px-3 pb-2">
                  <Button variant="ghost" size="sm" className="w-full h-7 text-xs text-destructive" onClick={() => onClearActualDate(milestone.id)}>
                    Clear Date
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Delete */}
        {!milestone.isDefault && (
          <div onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDelete(milestone.id)}
              className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
              data-testid={`button-delete-milestone-${milestone.id}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>

      {/* YouTube Tracking Panel (expanded for video milestones) */}
      {isVideoCategory && expanded && (
        <YouTubeTrackingPanel
          milestoneId={milestone.id}
          milestoneName={milestone.name}
        />
      )}
    </div>
  );
}
