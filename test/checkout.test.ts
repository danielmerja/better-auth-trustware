import { describe, expect, it, vi } from "vitest";
import { DAY, expectApiError, PLANS, setup } from "./helpers";

describe("checkout: subscriptions", () => {
  it("creates an incomplete subscription and an open invoice", async () => {
    const t = await setup({ checkoutUrl: (invoice) => `https://app.test/pay/${invoice.id}` });
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });

    expect(res.subscription).toMatchObject({ plan: "pro", billingInterval: "month", status: "incomplete" });
    expect(res.invoice).toMatchObject({
      kind: "subscription_create",
      status: "open",
      amountCents: 2000,
      currency: "USD",
      amountDueUnits: "20000000",
      remainingUnits: "20000000",
      settlement: { chainId: "8453", tokenSymbol: "USDC", tokenDecimals: 6 },
    });
    expect(res.checkoutUrl).toBe(`https://app.test/pay/${res.invoice!.id}`);
    // Nothing is granted before payment.
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(false);
  });

  it("honors the requested interval and rejects unavailable ones", async () => {
    const t = await setup();
    const yearly = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro", interval: "year" } });
    expect(yearly.invoice?.amountCents).toBe(20000);

    const t2 = await setup();
    await expectApiError(
      t2.auth.api.trustwareCheckout({ headers: t2.headers, body: { plan: "basic", interval: "year" } }),
      "PLAN_INTERVAL_NOT_AVAILABLE",
    );
  });

  it("rejects unknown plans and ambiguous requests", async () => {
    const t = await setup();
    await expectApiError(t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "nope" } }), "PLAN_NOT_FOUND");
    await expect(t.auth.api.trustwareCheckout({ headers: t.headers, body: {} as any })).rejects.toBeDefined();
    await expect(
      t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro", productId: "x" } }),
    ).rejects.toBeDefined();
  });

  it("starts a free trial with no invoice, once per account", async () => {
    const onTrialStart = vi.fn();
    const t = await setup({ subscription: { enabled: true, plans: PLANS, onTrialStart } });
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "trial" } });

    expect(res.invoice).toBeNull();
    expect(res.subscription).toMatchObject({ status: "trialing", plan: "trial" });
    expect(new Date(res.subscription!.trialEnd!).getTime() - t.clock.now.getTime()).toBe(7 * DAY);
    expect(onTrialStart).toHaveBeenCalledOnce();
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(true);

    // Cancel, then try the trial plan again: no second trial.
    await t.auth.api.trustwareCancelSubscription({ headers: t.headers, body: { immediately: true } });
    const again = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "trial" } });
    expect(again.subscription?.status).toBe("incomplete");
    expect(again.invoice?.amountCents).toBe(1000);
    expect(onTrialStart).toHaveBeenCalledOnce();
  });

  it("activates free plans immediately and still calls onSubscriptionComplete", async () => {
    const onSubscriptionComplete = vi.fn();
    const t = await setup({ subscription: { enabled: true, plans: PLANS, onSubscriptionComplete } });
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "free" } });
    expect(res.invoice).toBeNull();
    expect(res.subscription?.status).toBe("active");
    expect(onSubscriptionComplete).toHaveBeenCalledOnce();
    expect(onSubscriptionComplete.mock.calls[0][0].invoice).toBeUndefined();
  });

  it("blocks a second subscription while one is active", async () => {
    const t = await setup();
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });
    await t.pay(res.invoice!.id);
    await expectApiError(
      t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "basic" } }),
      "ALREADY_SUBSCRIBED",
    );
  });

  it("replaces a half-finished checkout instead of duplicating it", async () => {
    const t = await setup();
    const first = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });
    const second = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "basic" } });

    const stale = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: first.invoice!.id } });
    expect(stale.status).toBe("void");
    expect(second.invoice?.status).toBe("open");
    const subs = await t.auth.api.trustwareListSubscriptions({ headers: t.headers });
    expect(subs.map((s) => s.plan)).toEqual(["basic"]);
  });

  it("requires a verified email when configured", async () => {
    const t = await setup({ subscription: { enabled: true, plans: PLANS, requireEmailVerification: true } });
    const other = await t.createUser("unverified");
    await expectApiError(
      t.auth.api.trustwareCheckout({ headers: other.headers, body: { plan: "pro" } }),
      "EMAIL_VERIFICATION_REQUIRED",
    );
  });

  it("rejects plan checkouts when subscriptions are disabled", async () => {
    const t = await setup({ subscription: undefined, products: [{ id: "book", name: "Book", amountCents: 900 }] });
    await expectApiError(
      t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } }),
      "SUBSCRIPTIONS_NOT_ENABLED",
    );
    // Subscription endpoints aren't registered at all.
    expect((t.auth.api as any).trustwareCancelSubscription).toBeUndefined();
  });

  it("validates plan config up front", async () => {
    await expect(setup({ subscription: { enabled: true, plans: [{ name: "x", prices: { month: 9.99 } }] } })).rejects.toThrow(
      /integer number of US cents/,
    );
    await expect(
      setup({ subscription: { enabled: true, plans: [{ name: "x", prices: {} }, ] } }),
    ).rejects.toThrow(/at least one price/);
    await expect(
      setup({
        subscription: {
          enabled: true,
          plans: [
            { name: "a", prices: { month: 1 } },
            { name: "A", prices: { month: 1 } },
          ],
        },
      }),
    ).rejects.toThrow(/Duplicate/);
    await expect(setup({ settlement: { chainId: "8453", tokenAddress: "0x1", tokenDecimals: 6, address: "" } })).rejects.toThrow(
      /settlement/,
    );
    // Neither an apiKey nor a client: fail at startup, not on the first payment.
    await expect(setup({ trustware: undefined as any })).rejects.toThrow(/apiKey/);
  });
});

describe("checkout: one-time products", () => {
  const products = [
    { id: "ebook", name: "E-book", amountCents: 900, features: ["ebook"] },
    { id: "pass", name: "7-day pass", amountCents: 300, features: ["pass"], accessDays: 7 },
  ];

  it("sells a product and unlocks its features for life", async () => {
    const onInvoicePaid = vi.fn();
    const t = await setup({ products, onInvoicePaid });
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { productId: "ebook", metadata: { gift: false } } });
    expect(res.subscription).toBeNull();
    expect(res.invoice).toMatchObject({ kind: "one_time", amountCents: 900, productId: "ebook", metadata: { gift: false } });

    await t.pay(res.invoice!.id);
    const access = await t.auth.api.trustwareGetAccess({ headers: t.headers });
    expect(access).toMatchObject({ hasAccess: true, reason: "purchase", features: ["ebook"] });
    expect(onInvoicePaid).toHaveBeenCalledOnce();
    expect(onInvoicePaid.mock.calls[0][0].product.id).toBe("ebook");

    t.tick(400 * DAY);
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(true);
  });

  it("expires timed products", async () => {
    const t = await setup({ products });
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { productId: "pass" } });
    await t.pay(res.invoice!.id);
    expect((await t.auth.api.trustwareCheckAccess({ headers: t.headers, query: { feature: "pass" } })).allowed).toBe(true);
    t.tick(8 * DAY);
    expect((await t.auth.api.trustwareCheckAccess({ headers: t.headers, query: { feature: "pass" } })).allowed).toBe(false);
  });

  it("rejects unknown products", async () => {
    const t = await setup({ products });
    await expectApiError(t.auth.api.trustwareCheckout({ headers: t.headers, body: { productId: "nope" } }), "PRODUCT_NOT_FOUND");
  });
});

describe("pricing page data", () => {
  it("lists public plans without a session and hides hidden ones", async () => {
    const t = await setup({
      subscription: {
        enabled: true,
        plans: [...PLANS, { name: "internal", prices: { month: 1 }, hidden: true }],
      },
      products: [{ id: "book", name: "Book", amountCents: 900 }],
    });
    const res = await t.auth.api.trustwareListPlans();
    expect(res.plans.map((p) => p.name)).toEqual(["basic", "pro", "trial", "free"]);
    expect(res.plans.find((p) => p.name === "trial")?.trialDays).toBe(7);
    expect(res.products).toHaveLength(1);
    expect(res.settlement).toMatchObject({ chainId: "8453", tokenSymbol: "USDC" });
    // The merchant wallet is deliberately not part of the public catalog.
    expect(JSON.stringify(res)).not.toContain("0x1111");
  });
});
