import { createTrustwareApi } from "../trustware/api";
import type { TrustwareApi, TrustwareToken } from "../trustware/types";
import type {
  BillingInterval,
  TrustwareOptions,
  TrustwarePlan,
  TrustwareProduct,
  TrustwareSubscription,
} from "../types";
import { type ResolvedStatus, resolveStatus } from "./access";
import { isBillingInterval } from "./intervals";

const TOKEN_CACHE_TTL_MS = 5 * 60_000;

export interface Billing {
  options: TrustwareOptions;
  api: TrustwareApi;
  now(): Date;
  graceDays: number;
  leadDays: number;
  proration: "prorate" | "none";
  slippage: number;
  invoiceExpiryHours: number;
  toleranceBps: number;
  overpaymentThresholdBps: number;
  lazyReconcile: boolean;
  getPlans(): Promise<TrustwarePlan[]>;
  getPlan(name: string | null | undefined): Promise<TrustwarePlan | undefined>;
  getProducts(): Promise<TrustwareProduct[]>;
  getProduct(id: string | null | undefined): Promise<TrustwareProduct | undefined>;
  /** Look up a source token (with price and decimals) on a chain. Cached for a few minutes. */
  getToken(chainId: string, address: string): Promise<TrustwareToken | undefined>;
  /** The status a subscription has right now, accounting for its plan being free. */
  resolve(sub: TrustwareSubscription): Promise<ResolvedStatus>;
}

export function createBilling(options: TrustwareOptions): Billing {
  validateSettlement(options);
  const api =
    options.trustware ??
    (options.apiKey
      ? createTrustwareApi({ apiKey: options.apiKey, baseUrl: options.baseUrl })
      : undefined);
  if (!api) {
    throw new Error("[better-auth-trustware] Provide `apiKey` (or a custom `trustware` client) in the plugin options.");
  }
  if (options.subscription?.enabled && !options.subscription.plans) {
    throw new Error("[better-auth-trustware] `subscription.plans` is required when subscriptions are enabled.");
  }
  if (Array.isArray(options.subscription?.plans)) normalizePlans(options.subscription.plans);

  const tokenCache = new Map<string, { at: number; tokens: TrustwareToken[] }>();

  const getPlans = async () => {
    const source = options.subscription?.plans;
    if (!source) return [];
    return normalizePlans(typeof source === "function" ? await source() : source);
  };
  const getProducts = async () => {
    const source = options.products;
    if (!source) return [];
    const list = typeof source === "function" ? await source() : source;
    for (const p of list) {
      if (!p.id) throw new Error("[better-auth-trustware] Every product needs an `id`.");
      assertCents(p.amountCents, `product "${p.id}" amountCents`);
    }
    return list;
  };

  const now = options.advanced?.now ?? (() => new Date());
  const graceDays = options.subscription?.gracePeriodDays ?? 3;
  const getPlan = async (name: string | null | undefined) => {
    if (!name) return undefined;
    const wanted = name.toLowerCase();
    return (await getPlans()).find((p) => p.name === wanted);
  };

  return {
    options,
    api,
    now,
    graceDays,
    leadDays: options.subscription?.renewalLeadDays ?? 3,
    proration: options.subscription?.proration ?? "prorate",
    slippage: options.slippage ?? 1,
    invoiceExpiryHours: options.invoice?.expiryHours ?? 24,
    toleranceBps: options.invoice?.underpaymentToleranceBps ?? 0,
    overpaymentThresholdBps: options.invoice?.overpaymentThresholdBps ?? 100,
    lazyReconcile: options.advanced?.lazyReconcile ?? true,
    getPlans,
    getPlan,
    getProducts,
    async getProduct(id) {
      if (!id) return undefined;
      return (await getProducts()).find((p) => p.id === id);
    },
    async resolve(sub) {
      const plan = await getPlan(sub.plan);
      return resolveStatus(sub, now(), graceDays, { free: plan?.prices[sub.billingInterval] === 0 });
    },
    async getToken(chainId, address) {
      const cached = tokenCache.get(chainId);
      let tokens = cached && Date.now() - cached.at < TOKEN_CACHE_TTL_MS ? cached.tokens : undefined;
      if (!tokens) {
        tokens = await api.tokens({ chainId });
        tokenCache.set(chainId, { at: Date.now(), tokens });
      }
      return tokens.find((t) => sameAddress(t.address, address));
    },
  };
}

/** EVM addresses compare case-insensitively; everything else (Solana mints etc.) is case-sensitive. */
export function sameAddress(a: string, b: string): boolean {
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function validateSettlement(options: TrustwareOptions) {
  const s = options.settlement;
  if (!s || !s.chainId || !s.tokenAddress || !s.address) {
    throw new Error("[better-auth-trustware] `settlement` needs chainId, tokenAddress and address.");
  }
  if (!Number.isInteger(s.tokenDecimals) || s.tokenDecimals < 0 || s.tokenDecimals > 36) {
    throw new Error("[better-auth-trustware] `settlement.tokenDecimals` must be an integer between 0 and 36.");
  }
}

function assertCents(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`[better-auth-trustware] ${label} must be a non-negative integer number of US cents.`);
  }
}

function normalizePlans(plans: TrustwarePlan[]): TrustwarePlan[] {
  const seen = new Set<string>();
  return plans.map((plan) => {
    const name = plan.name?.toLowerCase();
    if (!name) throw new Error("[better-auth-trustware] Every plan needs a `name`.");
    if (seen.has(name)) throw new Error(`[better-auth-trustware] Duplicate plan name "${name}".`);
    seen.add(name);
    const intervals = Object.keys(plan.prices ?? {});
    if (intervals.length === 0) throw new Error(`[better-auth-trustware] Plan "${name}" needs at least one price.`);
    for (const interval of intervals) {
      if (!isBillingInterval(interval)) {
        throw new Error(`[better-auth-trustware] Plan "${name}" has unknown interval "${interval}".`);
      }
      assertCents(plan.prices[interval as BillingInterval] as number, `plan "${name}" ${interval} price`);
    }
    return { ...plan, name };
  });
}
