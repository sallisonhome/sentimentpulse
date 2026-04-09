import { cn } from "@/lib/utils";
import { TrendingUp, Minus, TrendingDown } from "lucide-react";

type Sentiment = "positive" | "neutral" | "negative";

interface SentimentBadgeProps {
  sentiment: Sentiment;
  size?: "sm" | "md";
  showIcon?: boolean;
  className?: string;
}

const config: Record<Sentiment, { label: string; icon: React.ElementType; classes: string; dotClass: string }> = {
  positive: {
    label: "Positive",
    icon: TrendingUp,
    classes: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
    dotClass: "bg-emerald-500",
  },
  neutral: {
    label: "Neutral",
    icon: Minus,
    classes: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
    dotClass: "bg-amber-500",
  },
  negative: {
    label: "Negative",
    icon: TrendingDown,
    classes: "bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
    dotClass: "bg-red-500",
  },
};

export function SentimentBadge({ sentiment, size = "md", showIcon = true, className }: SentimentBadgeProps) {
  const c = config[sentiment];
  const Icon = c.icon;
  return (
    <span
      data-testid={`badge-sentiment-${sentiment}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-medium",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs",
        c.classes,
        className
      )}
    >
      {showIcon && <Icon className={size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5"} />}
      {c.label}
    </span>
  );
}

export function SentimentDot({ sentiment, className }: { sentiment: Sentiment; className?: string }) {
  return (
    <span
      className={cn("inline-block rounded-full w-2 h-2 shrink-0", config[sentiment].dotClass, className)}
      title={config[sentiment].label}
    />
  );
}

export function SentimentBar({ pos, neu, neg }: { pos: number; neu: number; neg: number }) {
  const total = pos + neu + neg;
  if (total === 0) return <span className="text-xs text-muted-foreground">No meetings</span>;
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex h-1.5 rounded-full overflow-hidden bg-muted w-20">
        {pos > 0 && <div className="bg-emerald-500 h-full" style={{ width: `${(pos / total) * 100}%` }} />}
        {neu > 0 && <div className="bg-amber-500 h-full" style={{ width: `${(neu / total) * 100}%` }} />}
        {neg > 0 && <div className="bg-red-500 h-full" style={{ width: `${(neg / total) * 100}%` }} />}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{total} mtg{total !== 1 ? "s" : ""}</span>
    </div>
  );
}
