import { getTestInstance } from "better-auth/test";
import { expect } from "vitest";
import { trustware } from "../src";
import { trustwareClient } from "../src/client";
import { createMockTrustware, NATIVE_EVM_TOKEN, type MockTrustware } from "../src/testing";
import type { TrustwareOptions, TrustwarePlan } from "../src/types";

export const MERCHANT = "0x1111111111111111111111111111111111111111";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PAYER = "0x2222222222222222222222222222222222222222";
export const TX_HASH = `0x${"a".repeat(64)}`;
export const DAY = 86_400_000;

export const PLANS: TrustwarePlan[] = [
  { name: "basic", prices: { month: 500 }, features: ["basic"], limits: { projects: 3 } },
  {
    name: "pro",
    displayName: "Pro",
    prices: { month: 2000, year: 20000 },
    features: ["basic", "export"],
    limits: { projects: 20, seats: 0 },
  },
  { name: "trial", prices: { month: 1000 }, freeTrial: { days: 7 }, features: ["basic"] },
  { name: "free", prices: { month: 0 }, features: ["basic"] },
];

export async function setup(overrides: Partial<TrustwareOptions> = {}, extra: { mock?: MockTrustware; plugins?: any[] } = {}) {
  const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
  const mock = extra.mock ?? createMockTrustware();
  const options: TrustwareOptions = {
    trustware: mock,
    settlement: { chainId: "8453", tokenAddress: BASE_USDC, tokenSymbol: "USDC", tokenDecimals: 6, address: MERCHANT },
    subscription: { enabled: true, plans: PLANS },
    reconcile: { secret: "cron-secret" },
    ...overrides,
    // Keep the controllable clock even when a test overrides other `advanced` settings.
    advanced: { now: () => clock.now, lazyReconcile: true, ...overrides.advanced },
  };

  const trustwarePlugin = trustware(options);
  const instance = await getTestInstance(
    // Extra plugins are added at runtime but kept out of the type so `auth.api` stays precisely typed for ours.
    { plugins: [trustwarePlugin, ...(extra.plugins ?? [])] as [typeof trustwarePlugin] },
    { clientOptions: { plugins: [trustwareClient({ subscription: true })] } },
  );
  const { headers } = await instance.signInWithTestUser();

  const tick = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };

  /** Prepare a payment from native ETH on mainnet, broadcast it, and settle it. */
  async function pay(
    invoiceId: string,
    opts: { settle?: boolean; toAmount?: bigint; token?: string; chain?: string; hash?: string } = {},
  ) {
    const prepared = await instance.auth.api.trustwarePayInvoice({
      headers,
      body: {
        invoiceId,
        fromChain: opts.chain ?? "1",
        fromToken: opts.token ?? NATIVE_EVM_TOKEN,
        fromAddress: PAYER,
      },
    });
    await instance.auth.api.trustwareSubmitReceipt({
      headers,
      body: { paymentId: prepared.paymentId, txHash: opts.hash ?? `0x${Math.random().toString(16).slice(2).padEnd(64, "b")}` },
    });
    if (opts.settle !== false) {
      mock.settle(prepared.intentId, opts.toAmount !== undefined ? { toAmount: opts.toAmount } : undefined);
      tick(30_000);
      await instance.auth.api.trustwareInvoiceStatus({ headers, query: { id: invoiceId } });
    }
    return prepared;
  }

  /** Sign up and sign in a second account, returning its session headers. */
  async function createUser(name: string) {
    const email = `${name}@example.com`;
    const created = await instance.auth.api.signUpEmail({ body: { email, password: "password123", name } });
    const { headers: userHeaders } = await instance.signInWithUser(email, "password123");
    return { headers: userHeaders, id: created.user.id };
  }

  return { ...instance, headers, mock, clock, tick, pay, createUser, options };
}

/** Assert a call rejects with a specific plugin or API error code. */
export async function expectApiError(promise: Promise<unknown>, code: string) {
  const error: any = await promise.then(
    () => undefined,
    (e) => e,
  );
  expect(error, `expected the call to reject with ${code}`).toBeDefined();
  expect(error.body?.code ?? error.code).toBe(code);
}
