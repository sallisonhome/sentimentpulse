import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Drop-in replacement for the shared `<Table>` wrapper that adds a second,
 * slim horizontal scrollbar pinned above the table -- in sync with the
 * table's own native scrollbar below it.
 *
 * Why: wide leaderboards (many stat columns) force a horizontal scrollbar
 * that only appears at the very bottom of a long list of rows. On a
 * hundred-row leaderboard that scrollbar is effectively unreachable
 * without scrolling all the way down first. Mirroring it in a thin strip
 * right under the column headers lets a user scroll sideways without
 * leaving the top of the table.
 *
 * Renders the exact DOM shape the shared `Table` component produces for
 * its scroll region (`<div class="relative w-full overflow-auto">
 * <table>...</table></div>`), so swapping `<Table>` for this component
 * with the same `TableHeader`/`TableBody` children is a drop-in change.
 */
export function DualScrollTable({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  // Guards against the two onScroll handlers ping-ponging: setting one
  // side's scrollLeft fires that side's own scroll event, which would
  // otherwise immediately re-fire back at the side that triggered it.
  const syncSource = useRef<"top" | "bottom" | null>(null);

  useEffect(() => {
    const table = tableRef.current;
    const container = bottomRef.current;
    if (!table || !container) return;
    const measure = () => {
      setContentWidth(table.scrollWidth);
      setContainerWidth(container.clientWidth);
    };
    measure();
    // ResizeObserver reacts to row/column count changes (data loading in,
    // sort changes, window resize) without needing a React dependency --
    // it watches the actual rendered box, which is what determines
    // whether horizontal overflow exists.
    const ro = new ResizeObserver(measure);
    ro.observe(table);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const handleTopScroll = () => {
    if (syncSource.current === "bottom") {
      syncSource.current = null;
      return;
    }
    if (!topRef.current || !bottomRef.current) return;
    syncSource.current = "top";
    bottomRef.current.scrollLeft = topRef.current.scrollLeft;
  };

  const handleBottomScroll = () => {
    if (syncSource.current === "top") {
      syncSource.current = null;
      return;
    }
    if (!topRef.current || !bottomRef.current) return;
    syncSource.current = "bottom";
    topRef.current.scrollLeft = bottomRef.current.scrollLeft;
  };

  // Only reserve space for the top strip once the table actually
  // overflows -- otherwise it's a dead sliver of empty space on boards
  // narrow enough to fit without scrolling.
  const showTopScrollbar = contentWidth > containerWidth + 1;

  return (
    <div>
      <div
        ref={topRef}
        onScroll={handleTopScroll}
        className="overflow-x-auto overflow-y-hidden"
        style={{ height: showTopScrollbar ? 14 : 0 }}
        aria-hidden="true"
        data-testid="scrollbar-table-top"
      >
        <div style={{ width: contentWidth, height: 1 }} />
      </div>
      <div
        ref={bottomRef}
        onScroll={handleBottomScroll}
        className={cn("relative w-full overflow-auto", className)}
      >
        <table ref={tableRef} className="w-full caption-bottom text-sm">
          {children}
        </table>
      </div>
    </div>
  );
}
