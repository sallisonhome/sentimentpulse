import { storage } from "./storage";
import { generateDefaultMilestones } from "./pls-generator";

export function seedDatabase(): void {
  // Check if already seeded
  const existing = storage.getAllProducts();
  if (existing.length > 0) return;

  // ─── Product 1: Saber-published title with full realistic data ─────────────

  const product1 = storage.createProduct({
    title: "Warhammer 40,000: Space Marine 2",
    publisher: "Saber Interactive",
    isSaberPublished: true,
    platforms: JSON.stringify(["PC (Steam)", "PS5", "Xbox"]),
    playerFormat: "multiplayer",
    genre: "Action Adventure",
    releaseDate: "2026-09-09",
    targetRetailPriceUsd: 59.99,
    perPlatformPricing: null,
    steamAppId: "2183900",
    forecastMode: "auto_generate",
  });

  // Generate PLS milestones
  generateDefaultMilestones(product1.id, product1.releaseDate, product1.playerFormat);

  // Set actual dates on milestones that have "happened"
  const milestones1 = storage.getPlsMilestones(product1.id);

  const announce = milestones1.find(m => m.name === "Announce");
  if (announce) storage.updatePlsMilestone(announce.id, { actualDate: "2025-09-10" });

  const pageLive = milestones1.find(m => m.name === "Product Page Live");
  if (pageLive) storage.updatePlsMilestone(pageLive.id, { actualDate: "2025-09-15" });

  const teaser = milestones1.find(m => m.name === "First Teaser / World Premiere Video");
  if (teaser) storage.updatePlsMilestone(teaser.id, { actualDate: "2025-09-10" });

  const trailer1 = milestones1.find(m => m.name === "Official Trailer 1");
  if (trailer1) storage.updatePlsMilestone(trailer1.id, { actualDate: "2026-03-09" });

  // Prepurchase Start: set to a past date so dummy data shows active prepurchase tracking
  const prepurchaseStart = milestones1.find(m => m.name === "Prepurchase Start");
  if (prepurchaseStart) storage.updatePlsMilestone(prepurchaseStart.id, { actualDate: "2026-01-15" });

  // Add press beats with actual dates
  storage.createPlsMilestone({
    productId: product1.id,
    category: "press_coverage",
    name: "Game Awards Reveal",
    targetDate: "2025-12-10",
    actualDate: "2025-12-12",
    isDefault: false,
    sortOrder: 20,
  });

  storage.createPlsMilestone({
    productId: product1.id,
    category: "press_coverage",
    name: "IGN Exclusive Preview",
    targetDate: "2026-03-15",
    actualDate: "2026-03-18",
    isDefault: false,
    sortOrder: 21,
  });

  // ─── Steam Wishlist Data: 7 months, with spikes at milestone events ─────────
  // Starts Sep 15, 2025 (product page live) → present (~Mar 30, 2026)
  const wlStartDate = new Date("2025-09-15");
  const today = new Date("2026-03-30");
  let steamWlCum = 0;

  // Milestone spike dates for wishlists
  const wlSpikeDates: Record<string, number> = {
    "2025-09-15": 15000,  // Product page live — initial surge
    "2025-09-16": 12000,  // Day 2 of announce hype
    "2025-09-17": 8000,   // Trailing
    "2025-12-12": 25000,  // Game Awards reveal — big spike
    "2025-12-13": 18000,  // Day 2 Game Awards
    "2025-12-14": 10000,  // Trailing
    "2026-03-09": 20000,  // Official Trailer 1 drop
    "2026-03-10": 14000,  // Day 2 trailer
    "2026-03-18": 12000,  // IGN preview article
    "2026-03-19": 8000,   // Trailing from IGN
  };

  for (let d = new Date(wlStartDate); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const spikeBonus = wlSpikeDates[dateStr] || 0;
    // Base daily adds: ~1500-3500 organic, trending up over time
    const daysSinceStart = Math.floor((d.getTime() - wlStartDate.getTime()) / 86400000);
    const baseDelta = Math.round(1500 + Math.random() * 2000 + (daysSinceStart * 5));
    const delta = baseDelta + spikeBonus;
    steamWlCum += delta;
    storage.addSteamWishlist({
      productId: product1.id,
      date: dateStr,
      cumulativeCount: steamWlCum,
      dailyDelta: delta,
      source: "api",
    });
  }

  // ─── Steam Pre-Purchase Data: from prepurchase start date ───────────────────
  const steamPreStart = new Date("2026-01-15");
  let steamPreCum = 0;

  const steamPreSpikeDates: Record<string, number> = {
    "2026-01-15": 3000,   // Prepurchase launch day
    "2026-01-16": 2200,   // Day 2
    "2026-03-09": 4500,   // Official Trailer 1 spike
    "2026-03-10": 3000,   // Trailing
    "2026-03-18": 2500,   // IGN preview spike
  };

  for (let d = new Date(steamPreStart); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const spikeBonus = steamPreSpikeDates[dateStr] || 0;
    const daysSinceStart = Math.floor((d.getTime() - steamPreStart.getTime()) / 86400000);
    const baseDelta = Math.round(200 + Math.random() * 400 + (daysSinceStart * 1.5));
    const delta = baseDelta + spikeBonus;
    steamPreCum += delta;
    storage.addSteamPrepurchase({
      productId: product1.id,
      date: dateStr,
      cumulativeCount: steamPreCum,
      dailyDelta: delta,
      source: "api",
    });
  }

  // ─── PS5 Wishlist Data: 7 months, with spikes at events ────────────────────
  const ps5WlStartDate = new Date("2025-09-15");
  let ps5WlCum = 0;

  const ps5WlSpikeDates: Record<string, number> = {
    "2025-09-15": 12000,
    "2025-09-16": 9000,
    "2025-12-12": 20000,
    "2025-12-13": 14000,
    "2026-03-09": 16000,
    "2026-03-10": 10000,
    "2026-03-18": 9000,
  };

  for (let d = new Date(ps5WlStartDate); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const spikeBonus = ps5WlSpikeDates[dateStr] || 0;
    const daysSinceStart = Math.floor((d.getTime() - ps5WlStartDate.getTime()) / 86400000);
    const baseDelta = Math.round(1200 + Math.random() * 1800 + (daysSinceStart * 4));
    const delta = baseDelta + spikeBonus;
    ps5WlCum += delta;
    storage.addPs5Wishlist({
      productId: product1.id,
      date: dateStr,
      cumulativeCount: ps5WlCum,
      dailyDelta: delta,
      source: "api",
    });
  }

  // ─── PS5 Pre-Purchase Data: from prepurchase start date ─────────────────────
  const ps5PreStart = new Date("2026-01-15");
  let ps5PreCum = 0;

  const ps5PreSpikeDates: Record<string, number> = {
    "2026-01-15": 5000,   // Prepurchase launch day — PS5 sees bigger pre-order spike
    "2026-01-16": 3800,   // Day 2
    "2026-01-17": 2500,   // Trailing
    "2026-03-09": 6000,   // Official Trailer 1 spike
    "2026-03-10": 4000,   // Trailing
    "2026-03-18": 3500,   // IGN preview spike
    "2026-03-19": 2000,   // Trailing
  };

  for (let d = new Date(ps5PreStart); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const spikeBonus = ps5PreSpikeDates[dateStr] || 0;
    const daysSinceStart = Math.floor((d.getTime() - ps5PreStart.getTime()) / 86400000);
    // PS5 prepurchase runs higher than Steam — console players pre-order more aggressively
    const baseDelta = Math.round(350 + Math.random() * 500 + (daysSinceStart * 2));
    const delta = baseDelta + spikeBonus;
    ps5PreCum += delta;
    storage.addPs5Prepurchase({
      productId: product1.id,
      date: dateStr,
      cumulativeCount: ps5PreCum,
      dailyDelta: delta,
      source: "api",
    });
  }

  // ─── YouTube Tracking Data ─────────────────────────────────────────────────
  if (teaser) {
    const ytLink1 = storage.addYoutubeLink({
      milestoneId: teaser.id,
      youtubeVideoId: "dQw4w9WxGcQ",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WxGcQ",
      channelName: "Saber Interactive",
      videoTitle: "Warhammer 40K: Space Marine 2 — Official World Premiere Trailer",
      isOfficial: true,
    });

    const ytLink2 = storage.addYoutubeLink({
      milestoneId: teaser.id,
      youtubeVideoId: "L_jWHffIx5E",
      youtubeUrl: "https://www.youtube.com/watch?v=L_jWHffIx5E",
      channelName: "IGN",
      videoTitle: "Space Marine 2 World Premiere Trailer | Game Awards 2025",
      isOfficial: false,
    });

    const ytLink3 = storage.addYoutubeLink({
      milestoneId: teaser.id,
      youtubeVideoId: "YbJOTdZBX1g",
      youtubeUrl: "https://www.youtube.com/watch?v=YbJOTdZBX1g",
      channelName: "Skill Up",
      videoTitle: "Space Marine 2 Looks INCREDIBLE — My Reaction & Analysis",
      isOfficial: false,
    });

    // 30 days of YouTube view data from announce date
    const ytBaseDate = new Date("2025-09-10");
    let v1Cum = 0;
    let v2Cum = 0;
    let v3Cum = 0;
    for (let i = 0; i < 30; i++) {
      const date = new Date(ytBaseDate);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().split("T")[0];

      const d1 = i === 0 ? 450000 : Math.round(320000 * Math.exp(-0.12 * i) + 5000 + Math.random() * 8000);
      v1Cum += d1;
      storage.addYoutubeVideoDaily({ youtubeLinkId: ytLink1.id, date: dateStr, cumulativeViews: v1Cum, dailyDelta: d1 });

      const d2 = i === 0 ? 380000 : Math.round(220000 * Math.exp(-0.13 * i) + 3000 + Math.random() * 6000);
      v2Cum += d2;
      storage.addYoutubeVideoDaily({ youtubeLinkId: ytLink2.id, date: dateStr, cumulativeViews: v2Cum, dailyDelta: d2 });

      const d3 = i === 0 ? 120000 : Math.round(95000 * Math.exp(-0.14 * i) + 2000 + Math.random() * 4000);
      v3Cum += d3;
      storage.addYoutubeVideoDaily({ youtubeLinkId: ytLink3.id, date: dateStr, cumulativeViews: v3Cum, dailyDelta: d3 });
    }
  }

  // ─── Product 2: Saber co-op title ──────────────────────────────────────────

  const product2 = storage.createProduct({
    title: "Expeditions: A New Earth",
    publisher: "Saber Interactive",
    isSaberPublished: true,
    platforms: JSON.stringify(["PC (Steam)", "PS5"]),
    playerFormat: "co_op",
    genre: "Survival Craft",
    releaseDate: "2026-11-15",
    targetRetailPriceUsd: 49.99,
    perPlatformPricing: null,
    steamAppId: "2451200",
    forecastMode: "auto_generate",
  });

  generateDefaultMilestones(product2.id, product2.releaseDate, product2.playerFormat);

  const m2 = storage.getPlsMilestones(product2.id);
  const ann2 = m2.find(m => m.name === "Announce");
  if (ann2) storage.updatePlsMilestone(ann2.id, { actualDate: "2025-12-10" });

  // Steam wishlist from announce date
  const exp2Start = new Date("2025-12-10");
  let sw2Cum = 0;
  for (let d = new Date(exp2Start); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const daysSinceStart = Math.floor((d.getTime() - exp2Start.getTime()) / 86400000);
    const spikeBonus = daysSinceStart === 0 ? 8000 : daysSinceStart === 1 ? 5000 : 0;
    const baseDelta = Math.round(600 + Math.random() * 800 + (daysSinceStart * 2));
    sw2Cum += baseDelta + spikeBonus;
    storage.addSteamWishlist({
      productId: product2.id,
      date: dateStr,
      cumulativeCount: sw2Cum,
      dailyDelta: baseDelta + spikeBonus,
      source: "api",
    });
  }

  // PS5 wishlist from announce date
  let ps5Cum2 = 0;
  for (let d = new Date(exp2Start); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const daysSinceStart = Math.floor((d.getTime() - exp2Start.getTime()) / 86400000);
    const spikeBonus = daysSinceStart === 0 ? 6000 : daysSinceStart === 1 ? 3500 : 0;
    const baseDelta = Math.round(500 + Math.random() * 700 + (daysSinceStart * 1.5));
    ps5Cum2 += baseDelta + spikeBonus;
    storage.addPs5Wishlist({
      productId: product2.id,
      date: dateStr,
      cumulativeCount: ps5Cum2,
      dailyDelta: baseDelta + spikeBonus,
      source: "api",
    });
  }

  // ─── Product 2: Prepurchase Data ──────────────────────────────────────────
  // Prepurchase starts later for product 2 — Feb 15, 2026
  const m2Pre = storage.getPlsMilestones(product2.id);
  const preStart2 = m2Pre.find(m => m.name === "Prepurchase Start");
  if (preStart2) storage.updatePlsMilestone(preStart2.id, { actualDate: "2026-02-15" });

  // Steam prepurchase for product 2
  const steamPre2Start = new Date("2026-02-15");
  let steamPre2Cum = 0;
  for (let d = new Date(steamPre2Start); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const daysSinceStart = Math.floor((d.getTime() - steamPre2Start.getTime()) / 86400000);
    const spikeBonus = daysSinceStart === 0 ? 1500 : daysSinceStart === 1 ? 800 : 0;
    const baseDelta = Math.round(100 + Math.random() * 200 + (daysSinceStart * 0.8));
    steamPre2Cum += baseDelta + spikeBonus;
    storage.addSteamPrepurchase({
      productId: product2.id,
      date: dateStr,
      cumulativeCount: steamPre2Cum,
      dailyDelta: baseDelta + spikeBonus,
      source: "api",
    });
  }

  // PS5 prepurchase for product 2
  const ps5Pre2Start = new Date("2026-02-15");
  let ps5Pre2Cum = 0;
  for (let d = new Date(ps5Pre2Start); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const daysSinceStart = Math.floor((d.getTime() - ps5Pre2Start.getTime()) / 86400000);
    const spikeBonus = daysSinceStart === 0 ? 2500 : daysSinceStart === 1 ? 1500 : 0;
    const baseDelta = Math.round(200 + Math.random() * 300 + (daysSinceStart * 1.2));
    ps5Pre2Cum += baseDelta + spikeBonus;
    storage.addPs5Prepurchase({
      productId: product2.id,
      date: dateStr,
      cumulativeCount: ps5Pre2Cum,
      dailyDelta: baseDelta + spikeBonus,
      source: "api",
    });
  }

  console.log("Database seeded with 2 sample products (realistic data with event spikes, prepurchase active).");
}
