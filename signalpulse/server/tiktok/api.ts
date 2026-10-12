/**
 * TikTok Pulse — EnsembleData API client.
 *
 * EnsembleData auth is `?token=<value>` in the query string, not a Bearer
 * header. Production hosts should source the token from a `custom-credentials`
 * entry (host: ensembledata.com, credential_type: query_param, auth_param_name:
 * token) so the credential proxy injects it; the `ED_TOKEN` env var is the
 * local-development fallback.
 *
 * Unit accounting: every response exposes `units_charged` (what this call
 * consumed) and `units_remaining` (what is left in the daily allowance). The
 * daily allowance resets at 00:00 UTC; failed calls caused by internal errors
 * are not charged.
 */

export interface EnsembleDataResponse<T = unknown> {
  data?: T;
  units_charged?: number;
  units_remaining?: number;
  detail?: string | Array<{ loc: unknown[]; msg: string; type: string }>;
}

export class EnsembleDataApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly unitsCharged: number,
  ) {
    super(message);
    this.name = "EnsembleDataApiError";
  }
}

export class EnsembleDataUnitBudgetError extends Error {
  constructor() {
    super("EnsembleData daily unit budget exhausted");
    this.name = "EnsembleDataUnitBudgetError";
  }
}

export interface EnsembleDataClientConfig {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signalTimeoutMs?: number;
}

/** Read the token from env in production; the proxy injects it elsewhere. */
export function ensembleTokenFromEnv(): string | null {
  const tok = (globalThis.process?.env?.ED_TOKEN ?? "").trim();
  return tok || null;
}

export class EnsembleDataClient {
  private readonly cfg: Required<Omit<EnsembleDataClientConfig, "token">> & { token: string };

  constructor(cfg: EnsembleDataClientConfig) {
    if (!cfg.token) throw new Error("EnsembleData token is required");
    this.cfg = {
      token: cfg.token,
      baseUrl: cfg.baseUrl ?? "https://ensembledata.com/apis",
      fetchImpl: cfg.fetchImpl ?? ((u, i) => fetch(u, i)),
      signalTimeoutMs: cfg.signalTimeoutMs ?? 30_000,
    };
  }

  private async call<T = unknown>(
    endpoint: string,
    params: Record<string, string | number | boolean | undefined | null>,
  ): Promise<EnsembleDataResponse<T>> {
    const qs = new URLSearchParams();
    qs.set("token", this.cfg.token);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    const url = `${this.cfg.baseUrl}${endpoint}?${qs.toString()}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.signalTimeoutMs);
    try {
      const res = await this.cfg.fetchImpl(url, {
        signal: ctl.signal,
        headers: { "User-Agent": "signalpulse-tiktok/1.0" },
      });
      const body = (await res.json()) as EnsembleDataResponse<T>;
      if (!res.ok) {
        if (res.status === 495 || /maximum requests limit/i.test(String(body.detail))) {
          throw new EnsembleDataUnitBudgetError();
        }
        const msg = typeof body.detail === "string"
          ? body.detail
          : (body.detail ?? []).map((d) => `${d.loc.join(".")}: ${d.msg}`).join("; ");
        throw new EnsembleDataApiError(msg || `HTTP ${res.status}`, res.status, body.units_charged ?? 0);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Hashtag search: 1 unit, ~20 posts per page. */
  async hashtagPosts(
    name: string,
    cursor: number = 0,
  ): Promise<EnsembleDataResponse<{ data: TikTokPost[]; cursor: number; nextCursor: number | null; hashtagId: string | null }>> {
    return this.call("/tt/hashtag/posts", { name, cursor });
  }

  /** Keyword search: 1 unit per 20 posts (10 with match_exactly). */
  async keywordSearch(
    name: string,
    opts: { cursor?: number; period?: number; sorting?: number; matchExactly?: boolean } = {},
  ): Promise<EnsembleDataResponse<{ data: TikTokPost[]; nextCursor: number | null }>> {
    return this.call("/tt/keyword/search", {
      name,
      cursor: opts.cursor ?? 0,
      period: opts.period ?? 180,
      sorting: opts.sorting ?? 0,
      match_exactly: opts.matchExactly ?? false,
    });
  }

  /** Post info: 2 units per post; returns full statistics. */
  async postInfo(url: string): Promise<EnsembleDataResponse<{ post: TikTokPost }>> {
    return this.call("/tt/post/info", { url });
  }

  /** Post comments: 1 unit per 30 comments; paginates with cursor. */
  async postComments(
    awemeId: string,
    cursor: number = 0,
  ): Promise<EnsembleDataResponse<{ comments: TikTokComment[]; cursor: number; nextCursor: number | null }>> {
    return this.call("/tt/post/comments", { aweme_id: awemeId, cursor });
  }
}

/** TikTok post object — fields we consume. */
export interface TikTokPost {
  aweme_id: string;
  desc: string;
  create_time: number;
  author?: { unique_id?: string; nickname?: string };
  statistics?: {
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
    download_count?: number;
    repost_count?: number;
    forward_count?: number;
    collect_count?: number;
  };
  music?: { id?: string; title?: string };
  video?: { duration?: number };
}

/** TikTok comment object — fields we consume. */
export interface TikTokComment {
  cid: string;
  text: string;
  create_time: number;
  aweme_id: string;
  digg_count?: number;
  reply_id?: string;
  reply_to_reply_id?: string;
  reply_comment_total?: number;
  user?: { unique_id?: string; nickname?: string };
  is_author_digged?: boolean;
}

export function buildTikTokUrl(author: string | null | undefined, awemeId: string): string {
  return `https://www.tiktok.com/@${author ?? "unknown"}/video/${awemeId}`;
}
