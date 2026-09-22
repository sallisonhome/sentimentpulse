/** Verified live 2026-09-22: Downloads by Region -> all history -> Total
 * Downloads. Valve's definition includes users who recorded playtime or
 * preloaded. This is NOT app/details free licenses or lifetime unique users.
 * No storage imports: parser/transport can be tested without starting jobs.
 */
const HOST = "https://partner.steampowered.com";
export const DEMO_ACTUAL_WINDOWS = ["d7", "d30", "d90", "m12", "ltd"] as const;
export type ActualWindow = typeof DEMO_ACTUAL_WINDOWS[number];
export const DOWNLOAD_DEFINITION = "Downloads are made up of users who've recorded playtime, or pre-loaded, the title.";

function text(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&#0?39;|&apos;/gi, "'").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

function validateReport(html: string, expectedName: string) {
  const headings = Array.from(html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)).map(m => text(m[1]));
  if (!headings.includes(`Game: ${expectedName} - Downloads by Region`)) throw Error("Demo report identity not verified");
  if (!text(html).includes(DOWNLOAD_DEFINITION)) throw Error("Download metric definition not verified");
}

export function allHistoryReportUrl(html: string, appId: string, expectedName: string): string {
  validateReport(html, expectedName);
  const links = Array.from(html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi))
    .filter(m => text(m[2]).toLowerCase() === "all history");
  if (links.length !== 1) throw Error("All-history link missing or ambiguous");
  const url = new URL(links[0][1].replace(/&amp;/g, "&"), `${HOST}/nav_regions.php`);
  const p = url.searchParams;
  if (url.origin !== HOST || url.pathname !== "/nav_regions.php" || url.username || url.password ||
      p.getAll("appID").length !== 1 || p.get("appID") !== appId ||
      p.getAll("downloads").length !== 1 || p.get("downloads") !== "1" ||
      p.get("dateStart") !== "2000-01-01" || !/^\d{4}-\d{2}-\d{2}$/.test(p.get("dateEnd") ?? "")) {
    throw Error("All-history report scope not verified");
  }
  // Only forward the fixed contract's date and app parameters.
  const clean = new URL(`${HOST}/nav_regions.php`);
  for (const key of ["downloads", "appID", "dateStart", "dateEnd"]) clean.searchParams.set(key, p.get(key)!);
  return clean.href;
}

export function downloadWindowStart(window: ActualWindow, endDate: string): string {
  if (window === "ltd") return "2000-01-01";
  const days = { d7: 7, d30: 30, d90: 90, m12: 365 }[window];
  return new Date(Date.parse(`${endDate}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

export function parseDownloadReport(html: string, expectedName: string, startDate: string, endDate: string): number {
  validateReport(html, expectedName);
  if (startDate === "2000-01-01" && !/\blifetime sales shown\b/i.test(text(html))) throw Error("Lifetime scope not confirmed");
  const inputs = Array.from(html.matchAll(/<input\b[^>]*>/gi)).map(m => {
    const attrs = Object.fromEntries(Array.from(m[0].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)).map(a => [a[1].toLowerCase(), a[2]]));
    return attrs;
  });
  for (const [key, value] of [["dateStart", startDate], ["dateEnd", endDate]]) {
    const dates = inputs.filter(i => i.name === key);
    if (!dates.length || dates.some(i => i.value !== value)) throw Error("Report dates not confirmed");
  }
  const totals = Array.from(html.matchAll(/<div\b[^>]*>\s*Total Downloads:\s*((?:\d{1,3}(?:,\d{3})+|\d+))\s*<\/div>/gi));
  if (totals.length !== 1) throw Error("Total Downloads missing or ambiguous");
  const total = Number(totals[0][1].replace(/,/g, ""));
  if (!Number.isSafeInteger(total) || total < 0) throw Error("Invalid download total");
  return total;
}

export async function fetchDemoDownloadReports(appId: string, expectedName: string, cookieHeader: string,
  windows: readonly ActualWindow[] = DEMO_ACTUAL_WINDOWS) {
  if (!/^\d+$/.test(appId)) throw Error("Invalid demo identity");
  async function get(url: string) {
    const response = await fetch(url, {
      headers: { Cookie: cookieHeader, "User-Agent": "SignalPulse/1.0", "Accept-Language": "en-US" },
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) throw Error(`Steamworks HTTP ${response.status}`);
    return response.text();
  }
  const landing = await get(`${HOST}/nav_regions.php?downloads=1&appID=${appId}`);
  const sourceUrl = allHistoryReportUrl(landing, appId, expectedName);
  const reportEndDate = new URL(sourceUrl).searchParams.get("dateEnd")!;
  const reports = [];
  const failures: ActualWindow[] = [];
  for (const window of windows) {
    const reportStartDate = downloadWindowStart(window, reportEndDate);
    const url = new URL(sourceUrl);
    url.searchParams.set("dateStart", reportStartDate);
    try {
      const html = await get(url.href);
      reports.push({ window, downloads: parseDownloadReport(html, expectedName, reportStartDate, reportEndDate),
        reportStartDate, reportEndDate, sourceUrl: url.href, fetchedAt: new Date().toISOString() });
    } catch { failures.push(window); }
  }
  return { reports, failures };
}
