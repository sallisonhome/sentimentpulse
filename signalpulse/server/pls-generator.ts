import { storage } from "./storage";

/**
 * Generate default PLS milestones for a new product.
 * Target dates are calculated from the release date per spec Section 4.1-4.4.
 */
export function generateDefaultMilestones(productId: number, releaseDate: string, playerFormat: string): void {
  const release = new Date(releaseDate);

  function offsetMonths(months: number): string {
    const d = new Date(release);
    d.setMonth(d.getMonth() - months);
    return d.toISOString().split("T")[0];
  }

  function offsetWeeks(weeks: number): string {
    const d = new Date(release);
    d.setDate(d.getDate() - weeks * 7);
    return d.toISOString().split("T")[0];
  }

  // Core milestones
  storage.createPlsMilestone({
    productId,
    category: "core",
    name: "Announce",
    targetDate: offsetMonths(12),
    isDefault: true,
    sortOrder: 1,
  });

  storage.createPlsMilestone({
    productId,
    category: "core",
    name: "Product Page Live",
    targetDate: offsetMonths(12),
    isDefault: true,
    sortOrder: 2,
  });

  storage.createPlsMilestone({
    productId,
    category: "core",
    name: "Prepurchase Start",
    targetDate: offsetMonths(3),
    isDefault: true,
    sortOrder: 3,
  });

  // Video milestones
  storage.createPlsMilestone({
    productId,
    category: "video",
    name: "First Teaser / World Premiere Video",
    targetDate: offsetMonths(12),
    isDefault: true,
    sortOrder: 10,
  });

  storage.createPlsMilestone({
    productId,
    category: "video",
    name: "Official Trailer 1",
    targetDate: offsetMonths(6),
    isDefault: true,
    sortOrder: 11,
  });

  storage.createPlsMilestone({
    productId,
    category: "video",
    name: "Launch Trailer",
    targetDate: offsetWeeks(2),
    isDefault: true,
    sortOrder: 12,
  });

  // Demo & Beta milestones
  storage.createPlsMilestone({
    productId,
    category: "demo_beta",
    name: "Game Demo",
    targetDate: offsetWeeks(8),
    isDefault: true,
    sortOrder: 30,
  });

  // Only generate beta milestones if multiplayer
  if (playerFormat === "multiplayer") {
    storage.createPlsMilestone({
      productId,
      category: "demo_beta",
      name: "Closed Beta",
      targetDate: offsetWeeks(6),
      isDefault: true,
      sortOrder: 31,
    });

    storage.createPlsMilestone({
      productId,
      category: "demo_beta",
      name: "Open Beta",
      targetDate: offsetWeeks(4),
      isDefault: true,
      sortOrder: 32,
    });
  }
}
