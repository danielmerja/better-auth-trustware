import { describe, expect, it } from "vitest";
import {
  activePurchases,
  resolveStatus,
  statusGrantsAccess,
  summarizeAccess,
} from "../src/core/access";
import { addDays, addInterval } from "../src/core/intervals";
import {
  centsToBaseUnits,
  estimateFromAmount,
  mulDivCeil,
  parseBaseUnits,
  prorateCents,
  requiredAfterTolerance,
} from "../src/core/money";
import type { TrustwareInvoice, TrustwareSubscription } from "../src/types";

describe("money", () => {
  it("parses base units strictly", () => {
    expect(parseBaseUnits("123")).toBe(123n);
    expect(parseBaseUnits(" 42 ")).toBe(42n);
    expect(parseBaseUnits(7)).toBe(7n);
    expect(parseBaseUnits(10n)).toBe(10n);
    expect(parseBaseUnits("1.5")).toBeUndefined();
    expect(parseBaseUnits("-1")).toBeUndefined();
    expect(parseBaseUnits(-1)).toBeUndefined();
    expect(parseBaseUnits(1.5)).toBeUndefined();
    expect(parseBaseUnits("0x10")).toBeUndefined();
    expect(parseBaseUnits(undefined)).toBeUndefined();
    expect(parseBaseUnits(null)).toBeUndefined();
    // A float past 2^53 has already lost precision; refuse it rather than credit a guess.
    expect(parseBaseUnits(1e21)).toBeUndefined();
  });

  it("converts cents to stablecoin base units", () => {
    expect(centsToBaseUnits(2000, 6)).toBe(20_000_000n);
    expect(centsToBaseUnits(1, 6)).toBe(10_000n);
    expect(centsToBaseUnits(2000, 18)).toBe(20n * 10n ** 18n);
    expect(centsToBaseUnits(2000, 2)).toBe(2000n);
    // Fewer than 2 decimals can't represent a cent exactly: round up so we never under-charge.
    expect(centsToBaseUnits(150, 1)).toBe(15n);
    expect(centsToBaseUnits(151, 1)).toBe(16n);
    expect(centsToBaseUnits(150, 0)).toBe(2n);
    expect(() => centsToBaseUnits(-1, 6)).toThrow();
    expect(() => centsToBaseUnits(1.5, 6)).toThrow();
    expect(() => centsToBaseUnits(1, 99)).toThrow();
  });

  it("does ceiling division on BigInt", () => {
    expect(mulDivCeil(10n, 1n, 3n)).toBe(4n);
    expect(mulDivCeil(9n, 1n, 3n)).toBe(3n);
    expect(() => mulDivCeil(1n, 1n, 0n)).toThrow();
  });

  it("applies underpayment tolerance", () => {
    expect(requiredAfterTolerance(1_000_000n, 0)).toBe(1_000_000n);
    expect(requiredAfterTolerance(1_000_000n, 100)).toBe(990_000n);
    expect(requiredAfterTolerance(1_000_000n, 99_999)).toBe(0n);
  });

  it("estimates a source amount from a USD price", () => {
    // $20 of a $3000, 18-decimal token with a 2.5% buffer = 0.006833.. -> rounded up to micro-tokens.
    expect(estimateFromAmount({ requiredUsd: 20, usdPrice: 3000, decimals: 18, bufferBps: 250 })).toBe(
      6_834_000_000_000_000n,
    );
    // 6-decimal stablecoin
    expect(estimateFromAmount({ requiredUsd: 20, usdPrice: 1, decimals: 6, bufferBps: 0 })).toBe(20_000_000n);
    // Coarser than micro-tokens rounds up
    expect(estimateFromAmount({ requiredUsd: 1, usdPrice: 1, decimals: 2, bufferBps: 0 })).toBe(100n);
    // Tiny price expressed in scientific notation
    expect(estimateFromAmount({ requiredUsd: 1, usdPrice: 9.35818822286e-8, decimals: 18, bufferBps: 0 })).toBeGreaterThan(0n);
    expect(() => estimateFromAmount({ requiredUsd: 1, usdPrice: 0, decimals: 6, bufferBps: 0 })).toThrow();
    expect(() => estimateFromAmount({ requiredUsd: 1, usdPrice: Number.NaN, decimals: 6, bufferBps: 0 })).toThrow();
  });

  it("prorates without ever over-crediting", () => {
    expect(prorateCents(3000, 15, 30)).toBe(1500);
    expect(prorateCents(1000, 1, 3)).toBe(333);
    expect(prorateCents(1000, 100, 30)).toBe(1000); // clamped to a full period
    expect(prorateCents(1000, 0, 30)).toBe(0);
    expect(prorateCents(0, 10, 30)).toBe(0);
    expect(prorateCents(1000, 10, 0)).toBe(0);
  });
});

describe("intervals", () => {
  const d = (s: string) => new Date(s);
  it("clamps month math to the end of the target month", () => {
    expect(addInterval(d("2026-01-31T10:00:00Z"), "month").toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addInterval(d("2028-01-31T10:00:00Z"), "month").toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(addInterval(d("2026-03-31T00:00:00Z"), "month").toISOString()).toBe("2026-04-30T00:00:00.000Z");
    expect(addInterval(d("2026-12-15T00:00:00Z"), "month").toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });
  it("handles years, weeks and days", () => {
    expect(addInterval(d("2028-02-29T00:00:00Z"), "year").toISOString()).toBe("2029-02-28T00:00:00.000Z");
    expect(addInterval(d("2026-01-01T00:00:00Z"), "week").toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(addInterval(d("2026-01-31T00:00:00Z"), "day").toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(addInterval(d("2026-01-01T00:00:00Z"), "month", 3).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
  it("does not mutate its input", () => {
    const start = d("2026-01-31T00:00:00Z");
    addInterval(start, "month");
    expect(start.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });
});

describe("resolveStatus", () => {
  const now = new Date("2026-02-10T00:00:00Z");
  const sub = (over: Partial<TrustwareSubscription>) =>
    ({ status: "active", periodEnd: new Date("2026-02-15T00:00:00Z"), cancelAtPeriodEnd: false, ...over }) as TrustwareSubscription;

  it("stays active inside the paid period", () => {
    expect(resolveStatus(sub({}), now, 3).status).toBe("active");
    expect(resolveStatus(sub({ status: "trialing" }), now, 3).status).toBe("trialing");
  });
  it("is past_due inside the grace window and canceled after it", () => {
    const ended = sub({ periodEnd: new Date("2026-02-08T00:00:00Z") });
    const r = resolveStatus(ended, now, 3);
    expect(r.status).toBe("past_due");
    expect(r.graceEndsAt?.toISOString()).toBe("2026-02-11T00:00:00.000Z");
    expect(resolveStatus(ended, new Date("2026-02-11T00:00:01Z"), 3).status).toBe("canceled");
    expect(resolveStatus(ended, now, 0).status).toBe("canceled");
  });
  it("ends immediately at period end when cancellation was requested", () => {
    const s = sub({ periodEnd: new Date("2026-02-09T00:00:00Z"), cancelAtPeriodEnd: true });
    expect(resolveStatus(s, now, 3).status).toBe("canceled");
  });
  it("leaves terminal and pre-payment states alone", () => {
    for (const status of ["canceled", "incomplete", "incomplete_expired"] as const) {
      expect(resolveStatus(sub({ status, periodEnd: null }), now, 3).status).toBe(status);
    }
  });
  it("grants access only while active, trialing or past_due", () => {
    expect(["active", "trialing", "past_due"].every((s) => statusGrantsAccess(s as any))).toBe(true);
    expect(["incomplete", "incomplete_expired", "canceled"].some((s) => statusGrantsAccess(s as any))).toBe(false);
  });
});

describe("access summary", () => {
  const now = new Date("2026-02-10T00:00:00Z");
  const plans = [
    { name: "pro", prices: { month: 2000 }, features: ["export"], limits: { projects: 20 } },
    { name: "basic", prices: { month: 500 }, features: ["basic"], limits: { projects: 3 } },
  ];
  const sub = (over: Partial<TrustwareSubscription>) =>
    ({
      id: "s1",
      plan: "pro",
      status: "active",
      periodEnd: new Date("2026-03-01T00:00:00Z"),
      cancelAtPeriodEnd: false,
      ...over,
    }) as TrustwareSubscription;
  const invoice = (over: Partial<TrustwareInvoice>) =>
    ({ id: "i1", kind: "one_time", status: "paid", productId: "ebook", paidAt: new Date("2026-02-01T00:00:00Z"), ...over }) as TrustwareInvoice;
  const products = [
    { id: "ebook", name: "E-book", amountCents: 900, features: ["ebook"] },
    { id: "pass", name: "30d pass", amountCents: 900, features: ["pass"], accessDays: 30 },
  ];
  const base = { plans, products, now, graceDays: 3, invoices: [] as TrustwareInvoice[] };

  it("returns no access without a subscription or purchase", () => {
    const a = summarizeAccess({ ...base, subscriptions: [] });
    expect(a).toMatchObject({ hasAccess: false, reason: "none", status: "none", plan: null });
  });
  it("grants the plan's features and limits", () => {
    const a = summarizeAccess({ ...base, subscriptions: [sub({})] });
    expect(a).toMatchObject({ hasAccess: true, reason: "subscription", plan: "pro", features: ["export"], limits: { projects: 20 } });
  });
  it("keeps access during grace and reports when it ends", () => {
    const lapsed = sub({ periodEnd: new Date("2026-02-09T00:00:00Z") });
    const a = summarizeAccess({ ...base, subscriptions: [lapsed] });
    expect(a).toMatchObject({ hasAccess: true, reason: "grace_period", status: "past_due" });
    expect(a.graceEndsAt?.toISOString()).toBe("2026-02-12T00:00:00.000Z");
  });
  it("revokes access after the grace window", () => {
    const dead = sub({ periodEnd: new Date("2026-02-01T00:00:00Z") });
    const a = summarizeAccess({ ...base, subscriptions: [dead] });
    expect(a).toMatchObject({ hasAccess: false, status: "canceled", plan: null, limits: {} });
  });
  it("prefers the best subscription when several exist", () => {
    const old = sub({ id: "old", plan: "basic", status: "canceled" });
    const a = summarizeAccess({ ...base, subscriptions: [old, sub({ id: "new" })] });
    expect(a.subscriptionId).toBe("new");
  });
  it("merges one-time purchases and expires timed ones", () => {
    const lifetime = invoice({});
    const expired = invoice({ id: "i2", productId: "pass", paidAt: new Date("2026-01-01T00:00:00Z") });
    const live = invoice({ id: "i3", productId: "pass", paidAt: new Date("2026-02-05T00:00:00Z") });
    expect(activePurchases([lifetime, expired, live], products, now).map((p) => p.invoiceId)).toEqual(["i1", "i3"]);
    const a = summarizeAccess({ ...base, subscriptions: [sub({})], invoices: [lifetime, live] });
    expect(a.features.sort()).toEqual(["ebook", "export", "pass"]);
    const onlyPurchase = summarizeAccess({ ...base, subscriptions: [], invoices: [lifetime] });
    expect(onlyPurchase).toMatchObject({ hasAccess: true, reason: "purchase" });
  });
  it("ignores unpaid or unknown-product invoices", () => {
    const a = activePurchases([invoice({ status: "open" }), invoice({ productId: "gone" }), invoice({ kind: "subscription_renewal" })], products, now);
    expect(a).toEqual([]);
  });
  it("addDays works on plain dates", () => {
    expect(addDays(new Date("2026-01-01T00:00:00Z"), 3).toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });
});
