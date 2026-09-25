/** Read-only, fail-closed coordination for nonurgent monthly discovery. */
export async function sentimentIngestionIdle(
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const r = await fetcher("http://127.0.0.1:8000/api/ingest/status", {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return false;
    const body = await r.json();
    return body.is_running === false;
  } catch {
    return false;
  }
}
