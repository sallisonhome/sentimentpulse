/** Discovery evidence and current-run collection health are different gates. */
export function discoveryHealth(result: {
  steam: { paid: number; preservedPaid: number; unknown: number };
  xbox: { paid: number };
  ps: { paid: number };
}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const eligible = result.steam.paid + result.steam.preservedPaid;
  if (eligible < 80) errors.push(`expected >=80 evidenced Steam paid candidates, got ${eligible} (fresh=${result.steam.paid}, preserved=${result.steam.preservedPaid})`);
  if (result.xbox.paid < 80) errors.push(`expected >=80 Xbox paid titles, got ${result.xbox.paid}`);
  if (result.ps.paid < 90) errors.push(`expected >=90 PS5 paid titles, got ${result.ps.paid}`);
  if (result.steam.unknown) warnings.push(`Steam metadata degraded: ${result.steam.unknown} unknown responses; ${result.steam.preservedPaid} existing paid base candidates retained, not newly verified. Unknown new SKUs remain excluded.`);
  return { errors, warnings };
}

export interface CollectionCounts {
  ingested: number;
  failed: number;
  skipped?: number;
}

/** Never use yesterday's snapshots or a single historical seed as success. */
export function collectionHealth(platforms: Record<string, CollectionCounts>) {
  const errors: string[] = [], warnings: string[] = [];
  for (const platform of ["steam", "xbox", "ps5"]) {
    const result = platforms[platform];
    if (!result || !Number.isInteger(result.ingested) || result.ingested <= 0) {
      errors.push(`${platform}: no fresh observations in this invocation`);
      continue;
    }
    const total = result.ingested + result.failed;
    if (result.failed < 0 || !Number.isInteger(result.failed) || result.ingested / total < 0.8) {
      errors.push(`${platform}: fresh coverage below 80% (${result.ingested}/${total})`);
    } else if (result.failed > 0) {
      warnings.push(`${platform}: ${result.failed} failed requests; ${result.ingested} fresh observations. Failed titles retain prior data.`);
    }
    if (result.skipped) warnings.push(`${platform}: ${result.skipped} explicit storefront no-data responses (not counted as fresh observations)`);
  }
  return { errors, warnings };
}
