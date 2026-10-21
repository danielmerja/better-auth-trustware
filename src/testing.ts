import { TrustwareApiError } from "./trustware/api";
import type {
  TrustwareApi,
  TrustwareIntentStatus,
  TrustwareQuote,
  TrustwareQuoteRequest,
  TrustwareRouteRequest,
  TrustwareRouteResult,
  TrustwareStatus,
  TrustwareToken,
} from "./trustware/types";

export const NATIVE_EVM_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** A small default token list: ETH and USDC on Ethereum and Base. */
export const MOCK_TOKENS: TrustwareToken[] = [
  { chainId: "1", address: NATIVE_EVM_TOKEN, symbol: "ETH", decimals: 18, usdPrice: 3000 },
  { chainId: "1", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, usdPrice: 1 },
  { chainId: "8453", address: NATIVE_EVM_TOKEN, symbol: "ETH", decimals: 18, usdPrice: 3000 },
  { chainId: "8453", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6, usdPrice: 1 },
];

export interface MockIntent {
  id: string;
  request: TrustwareRouteRequest;
  status: TrustwareIntentStatus;
  sourceTxHash?: string;
  destTxHash?: string;
  /** What the destination actually received. Defaults to the quoted amount. */
  settledAmount?: bigint;
  landedAmountVerified?: boolean;
  /** Overrides, to simulate a misreporting provider. */
  reportedToAddress?: string;
  reportedToChain?: string;
  reportedMetadata?: Record<string, unknown>;
}

export interface MockTrustware extends TrustwareApi {
  intents: Map<string, MockIntent>;
  calls: { quote: number; route: number; receipt: number; status: number; tokens: number };
  /** Mark an intent as settled. `toAmount` defaults to the amount the quote guaranteed. */
  settle(intentId: string, options?: { toAmount?: bigint; landedAmountVerified?: boolean }): void;
  bridge(intentId: string): void;
  fail(intentId: string): void;
  /** Make the next call to `method` throw. */
  failNext(method: keyof MockTrustware["calls"], error?: Error): void;
  /** Make the next success report a different destination, to test integrity checks. */
  misreport(intentId: string, report: { toAddress?: string; toChain?: string; metadata?: Record<string, unknown> }): void;
}

/**
 * An in-memory stand-in for the Trustware API that behaves linearly: a quote
 * returns `fromAmount * price` minus a flat fee, and intents move through
 * pending -> submitted -> success when you drive them. Pass it as the
 * `trustware` option to test your integration without an API key.
 */
export function createMockTrustware(
  options: { tokens?: TrustwareToken[]; feeBps?: number; destDecimals?: number } = {},
): MockTrustware {
  const tokens = options.tokens ?? MOCK_TOKENS;
  const feeBps = BigInt(options.feeBps ?? 30);
  const intents = new Map<string, MockIntent>();
  const calls = { quote: 0, route: 0, receipt: 0, status: 0, tokens: 0 };
  const pendingErrors = new Map<string, Error>();
  let counter = 0;

  const maybeThrow = (method: string) => {
    const error = pendingErrors.get(method);
    if (error) {
      pendingErrors.delete(method);
      throw error;
    }
  };

  const find = (chainId: string, address: string) =>
    tokens.find(
      (t) => t.chainId === chainId && (t.address === address || t.address.toLowerCase() === address.toLowerCase()),
    );

  function price(request: TrustwareQuoteRequest) {
    const from = find(request.fromChain, request.fromToken);
    if (!from?.usdPrice) {
      throw new TrustwareApiError("no route", {
        status: 404,
        code: "no_route_available",
        providers: [{ name: "mock", outcome: "declined", code: "pair_unsupported" }],
      });
    }
    const to = find(request.toChain, request.toToken);
    const destDecimals = to?.decimals ?? options.destDecimals ?? 6;
    const fromAmount = BigInt(request.fromAmount);
    const priceScaled = BigInt(Math.round(from.usdPrice * 1e12));
    const gross = (fromAmount * priceScaled * 10n ** BigInt(destDecimals)) / (10n ** BigInt(from.decimals) * 10n ** 12n);
    const toAmount = gross - (gross * feeBps) / 10_000n;
    const slippageBps = BigInt(Math.round((request.slippage ?? 1) * 100));
    const toAmountMin = toAmount - (toAmount * slippageBps) / 10_000n;
    return {
      from,
      estimate: {
        fromAmount: request.fromAmount,
        toAmount: toAmount.toString(),
        toAmountMin: toAmountMin.toString(),
      },
    };
  }

  const mock: MockTrustware = {
    intents,
    calls,

    async quote(request): Promise<TrustwareQuote> {
      calls.quote += 1;
      maybeThrow("quote");
      return { estimate: price(request).estimate };
    },

    async route(request): Promise<TrustwareRouteResult> {
      calls.route += 1;
      maybeThrow("route");
      const { from, estimate } = price(request);
      counter += 1;
      const id = `intent_${counter}`;
      intents.set(id, { id, request, status: "pending" });
      const native = from.address.toLowerCase() === NATIVE_EVM_TOKEN.toLowerCase();
      return {
        intentId: id,
        route: {
          estimate,
          provider: "mock",
          execution: {
            transaction: {
              to: "0x000000000000000000000000000000000000dEaD",
              data: "0x",
              value: native ? request.fromAmount : "0",
            },
            approvals: native
              ? []
              : [
                  {
                    chainId: request.fromChain,
                    tokenAddress: from.address,
                    spender: "0x000000000000000000000000000000000000dEaD",
                    amount: request.fromAmount,
                  },
                ],
          },
        },
      };
    },

    async receipt(intentId, txHash) {
      calls.receipt += 1;
      maybeThrow("receipt");
      const intent = intents.get(intentId);
      if (!intent) throw new TrustwareApiError("unknown intent", { status: 404 });
      intent.sourceTxHash = txHash;
      if (intent.status === "pending") intent.status = "submitted";
    },

    async status(intentId): Promise<TrustwareStatus> {
      calls.status += 1;
      maybeThrow("status");
      const intent = intents.get(intentId);
      if (!intent) throw new TrustwareApiError("unknown intent", { status: 404 });
      const { request } = intent;
      const base: TrustwareStatus = {
        intentId,
        status: intent.status,
        sourceTxHash: intent.sourceTxHash,
        raw: {},
      };
      if (intent.status === "pending") return base;
      const success = intent.status === "success";
      return {
        ...base,
        fromAddress: request.fromAddress,
        toAddress: intent.reportedToAddress ?? request.toAddress,
        fromChainId: request.fromChain,
        toChainId: intent.reportedToChain ?? request.toChain,
        destTxHash: intent.destTxHash,
        toAmount: success ? (intent.settledAmount ?? BigInt(price(request).estimate.toAmountMin)) : undefined,
        landedAmountVerified: success ? intent.landedAmountVerified : undefined,
        provider: "mock",
        metadata: intent.reportedMetadata ?? request.metadata,
      };
    },

    async tokens({ chainId }) {
      calls.tokens += 1;
      maybeThrow("tokens");
      return tokens.filter((t) => t.chainId === chainId);
    },

    async validate() {
      return { valid: true, status: "active" };
    },

    settle(intentId, opts = {}) {
      const intent = must(intentId);
      intent.status = "success";
      intent.destTxHash = `0xdest${intentId.replace(/\D/g, "").padStart(60, "0")}`;
      if (opts.toAmount !== undefined) intent.settledAmount = opts.toAmount;
      if (opts.landedAmountVerified !== undefined) intent.landedAmountVerified = opts.landedAmountVerified;
    },
    bridge(intentId) {
      must(intentId).status = "bridging";
    },
    fail(intentId) {
      must(intentId).status = "failed";
    },
    failNext(method, error) {
      pendingErrors.set(method, error ?? new TrustwareApiError("mock outage", { status: 503 }));
    },
    misreport(intentId, report) {
      const intent = must(intentId);
      if (report.toAddress) intent.reportedToAddress = report.toAddress;
      if (report.toChain) intent.reportedToChain = report.toChain;
      if (report.metadata) intent.reportedMetadata = report.metadata;
    },
  };

  function must(intentId: string) {
    const intent = intents.get(intentId);
    if (!intent) throw new Error(`Unknown mock intent ${intentId}`);
    return intent;
  }

  return mock;
}
