import { parseBaseUnits } from "../core/money";
import type {
  TrustwareApi,
  TrustwareIntentStatus,
  TrustwareProviderOutcome,
  TrustwareQuote,
  TrustwareQuoteRequest,
  TrustwareRouteRequest,
  TrustwareRouteResult,
  TrustwareStatus,
  TrustwareToken,
  TrustwareValidateResult,
} from "./types";

export const DEFAULT_TRUSTWARE_BASE_URL = "https://api.trustware.io";

export class TrustwareApiError extends Error {
  readonly name = "TrustwareApiError";
  constructor(
    message: string,
    readonly details: {
      /** HTTP status, or 0 for network errors and timeouts. */
      status: number;
      /** Machine code from Trustware, e.g. `no_route_available`. */
      code?: string;
      requestId?: string;
      providers?: TrustwareProviderOutcome[];
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
  }

  get status() {
    return this.details.status;
  }
  get code() {
    return this.details.code;
  }
  /** True when retrying later could succeed (network, 5xx, 429), as opposed to a request that will never route. */
  get transient() {
    const { status, code } = this.details;
    if (code === "providers_failed") return true;
    return status === 0 || status === 429 || status >= 500;
  }
}

export interface CreateTrustwareApiOptions {
  apiKey: string;
  baseUrl?: string;
  /** Custom fetch, e.g. for tests or proxies. Defaults to the global one. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 20 000. */
  timeoutMs?: number;
  /** How many times to retry a 429 using `Retry-After`. Default 2. */
  maxRateLimitRetries?: number;
}

const MAX_RETRY_WAIT_MS = 10_000;

export function createTrustwareApi(options: CreateTrustwareApiOptions): TrustwareApi {
  if (!options.apiKey) throw new Error("[better-auth-trustware] `apiKey` is required to call the Trustware API");
  const baseUrl = (options.baseUrl ?? DEFAULT_TRUSTWARE_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRetries = options.maxRateLimitRetries ?? 2;

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          method,
          headers: {
            "X-API-Key": options.apiKey,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new TrustwareApiError(
          `Trustware request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { status: 0 },
        );
      }

      const requestId = response.headers.get("x-request-id") ?? undefined;
      const text = await response.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (response.ok) return json as T;

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (response.status === 429 && attempt < maxRetries) {
        attempt += 1;
        await sleep(Math.min((retryAfter ?? 1) * 1000, MAX_RETRY_WAIT_MS));
        continue;
      }

      throw new TrustwareApiError(
        (typeof json?.error === "string" && json.error) || `Trustware responded with HTTP ${response.status}`,
        {
          status: response.status,
          code: typeof json?.code === "string" ? json.code : undefined,
          requestId: requestId ?? (typeof json?.requestId === "string" ? json.requestId : undefined),
          providers: Array.isArray(json?.providers) ? json.providers : undefined,
          retryAfterSeconds: retryAfter,
        },
      );
    }
  }

  return {
    async quote(req: TrustwareQuoteRequest): Promise<TrustwareQuote> {
      const res = await request<{ data: TrustwareQuote }>("POST", "/api/v1/routes/quote", req);
      if (!res?.data?.estimate) throw malformed("quote");
      return res.data;
    },

    async route(req: TrustwareRouteRequest): Promise<TrustwareRouteResult> {
      const res = await request<{ data: TrustwareRouteResult }>("POST", "/api/v1/routes/route", req);
      if (!res?.data?.intentId || !res.data.route?.execution?.transaction) throw malformed("route");
      return res.data;
    },

    async receipt(intentId: string, txHash: string): Promise<void> {
      await request("POST", `/api/v1/route-intent/${encodeURIComponent(intentId)}/receipt`, { txHash });
    },

    async status(intentId: string): Promise<TrustwareStatus> {
      const res = await request<{ data: unknown }>(
        "GET",
        `/api/v1/route-intent/${encodeURIComponent(intentId)}/status`,
      );
      if (!res?.data || typeof (res.data as { status?: unknown }).status !== "string") throw malformed("status");
      return normalizeStatus(intentId, res.data);
    },

    async tokens({ chainId }: { chainId: string }): Promise<TrustwareToken[]> {
      const tokens: TrustwareToken[] = [];
      let cursor: string | undefined;
      // The tokens endpoint paginates as soon as any query parameter is present.
      for (let page = 0; page < 50; page += 1) {
        const query = new URLSearchParams({ chainId, limit: "500" });
        if (cursor) query.set("cursor", cursor);
        const res = await request<unknown>("GET", `/api/v1/routes/tokens?${query}`);
        const { items, nextCursor } = readTokenPage(res);
        for (const item of items) {
          const token = normalizeToken(item, chainId);
          if (token) tokens.push(token);
        }
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      return tokens;
    },

    async validate(): Promise<TrustwareValidateResult> {
      return request<TrustwareValidateResult>("GET", "/api/v1/sdk/validate");
    },
  };
}

function malformed(what: string) {
  return new TrustwareApiError(`Trustware returned an unexpected ${what} response`, { status: 502 });
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const KNOWN_STATUSES = new Set<TrustwareIntentStatus>(["pending", "submitted", "bridging", "success", "failed"]);

/**
 * Trustware's status payload uses snake_case. We read both spellings so a
 * future switch to camelCase doesn't silently break settlement. An unknown
 * status is treated as still in flight; only an explicit `success` ever
 * credits money.
 */
export function normalizeStatus(intentId: string, raw: unknown): TrustwareStatus {
  const r = (raw ?? {}) as Record<string, any>;
  const pick = (...keys: string[]) => {
    for (const key of keys) if (r[key] !== undefined && r[key] !== null) return r[key];
    return undefined;
  };
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  const rawStatus = String(pick("status") ?? "pending").toLowerCase();
  const status: TrustwareIntentStatus = KNOWN_STATUSES.has(rawStatus as TrustwareIntentStatus)
    ? (rawStatus as TrustwareIntentStatus)
    : "submitted";
  const nextPoll = pick("next_poll_at", "nextPollAt");
  const nextPollAt = nextPoll ? new Date(nextPoll) : undefined;
  const verified = pick("landed_amount_verified", "landedAmountVerified");
  const metadata = pick("metadata");

  return {
    intentId: str(pick("intent_id", "intentId")) ?? intentId,
    status,
    sourceTxHash: str(pick("source_tx_hash", "sourceTxHash")),
    destTxHash: str(pick("dest_tx_hash", "destTxHash")),
    fromAddress: str(pick("from_address", "fromAddress")),
    toAddress: str(pick("to_address", "toAddress")),
    fromChainId: str(pick("from_chain_id", "fromChainId")),
    toChainId: str(pick("to_chain_id", "toChainId")),
    toAmount: parseBaseUnits(pick("to_amount_wei", "toAmountWei", "to_amount", "toAmount")),
    landedAmountVerified: typeof verified === "boolean" ? verified : undefined,
    provider: str(pick("routing_provider", "routingProvider", "provider")),
    nextPollAt: nextPollAt && !Number.isNaN(nextPollAt.getTime()) ? nextPollAt : undefined,
    metadata: metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : undefined,
    raw,
  };
}

function readTokenPage(res: unknown): { items: unknown[]; nextCursor?: string } {
  const root = res as any;
  const data = root?.data ?? root;
  const items: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.tokens)
      ? data.tokens
      : Array.isArray(data?.items)
        ? data.items
        : [];
  const cursor =
    data?.nextCursor ?? data?.next_cursor ?? root?.nextCursor ?? root?.next_cursor ?? root?.meta?.nextCursor;
  return { items, nextCursor: typeof cursor === "string" && cursor ? cursor : undefined };
}

function normalizeToken(item: unknown, fallbackChainId: string): TrustwareToken | undefined {
  const t = item as Record<string, any>;
  if (!t || typeof t.address !== "string" || typeof t.decimals !== "number") return undefined;
  const price = typeof t.usdPrice === "number" ? t.usdPrice : Number(t.usdPrice);
  return {
    address: t.address,
    chainId: String(t.chainId ?? fallbackChainId),
    symbol: String(t.symbol ?? ""),
    name: typeof t.name === "string" ? t.name : undefined,
    decimals: t.decimals,
    usdPrice: Number.isFinite(price) && price > 0 ? price : undefined,
    logoURI: typeof t.logoURI === "string" ? t.logoURI : undefined,
  };
}
