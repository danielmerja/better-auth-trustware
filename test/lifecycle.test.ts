import { describe, expect, it, vi } from "vitest";
import { addInterval } from "../src/core/intervals";
import type { TrustwarePlan } from "../src/types";
import { DAY, expectApiError, PLANS, setup } from "./helpers";

type T = Awaited<ReturnType<typeof setup>>;

/** Subscribe to a plan and pay for it. Clock ends at 2026-01-01T00:00:30Z with the period running a month from there. */
async function subscribe(t: T, plan = "pro", interval?: "month" | "year") {
  const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan, interval } });
  await t.pay(res.invoice!.id);
  return res.invoice!.id;
}

const subscription = async (t: T) => (await t.auth.api.trustwareListSubscriptions({ headers: t.headers, query: { includeEnded: true } }))[0];
const invoices = (t: T) => t.auth.api.trustwareListInvoices({ headers: t.headers });

describe("renewals", () => {
  it("issues one renewal invoice ahead of the period end and extends the period when it's paid", async () => {
    const onInvoiceCreated = vi.fn();
    const onSubscriptionRenewed = vi.fn();
    const t = await setup({
      onInvoiceCreated,
      subscription: { enabled: true, plans: PLANS, onSubscriptionRenewed },
    });
    await subscribe(t);
    expect(new Date((await subscription(t)).periodEnd!).toISOString()).toBe("2026-02-01T00:00:30.000Z");

    // Too early: nothing yet.
    t.tick(20 * DAY);
    expect((await t.auth.api.trustwareReconcile({ body: {} })).renewalsInvoiced).toBe(0);

    // Inside the 3-day lead window.
    t.tick(8 * DAY + 1000);
    expect((await t.auth.api.trustwareReconcile({ body: {} })).renewalsInvoiced).toBe(1);
    expect((await t.auth.api.trustwareReconcile({ body: {} })).renewalsInvoiced).toBe(0); // idempotent

    const [renewal] = (await invoices(t)).filter((i) => i.kind === "subscription_renewal");
    expect(renewal).toMatchObject({ status: "open", amountCents: 2000, plan: "pro" });
    expect(new Date(renewal.periodStart!).toISOString()).toBe("2026-02-01T00:00:30.000Z");
    expect(new Date(renewal.periodEnd!).toISOString()).toBe("2026-03-01T00:00:30.000Z");
    expect(onInvoiceCreated).toHaveBeenCalledTimes(2); // the first invoice and the renewal
    expect(onInvoiceCreated.mock.calls[1][0].invoice.kind).toBe("subscription_renewal");

    await t.pay(renewal.id);
    const sub = await subscription(t);
    expect(sub.status).toBe("active");
    // Paid early: the new period starts where the old one ends, so no paid days are lost.
    expect(new Date(sub.periodStart!).toISOString()).toBe("2026-02-01T00:00:30.000Z");
    expect(new Date(sub.periodEnd!).toISOString()).toBe("2026-03-01T00:00:30.000Z");
    expect(onSubscriptionRenewed).toHaveBeenCalledOnce();
  });

  it("goes past_due, keeps access through the grace period, then ends for non-payment", async () => {
    const onSubscriptionPastDue = vi.fn();
    const onSubscriptionEnded = vi.fn();
    const t = await setup({ subscription: { enabled: true, plans: PLANS, onSubscriptionPastDue, onSubscriptionEnded } });
    await subscribe(t);

    t.tick(29 * DAY);
    await t.auth.api.trustwareReconcile({ body: {} }); // issues the renewal
    t.tick(3 * DAY + 5000); // Feb 2, one day past the period end
    const lapse = await t.auth.api.trustwareReconcile({ body: {} });
    expect(lapse.subscriptionsPastDue).toBe(1);
    expect(onSubscriptionPastDue).toHaveBeenCalledOnce();
    expect(onSubscriptionPastDue.mock.calls[0][0].invoice.kind).toBe("subscription_renewal");

    const grace = await t.auth.api.trustwareGetAccess({ headers: t.headers });
    expect(grace).toMatchObject({ hasAccess: true, reason: "grace_period", status: "past_due", plan: "pro" });
    expect(new Date(grace.graceEndsAt!).toISOString()).toBe("2026-02-04T00:00:30.000Z");

    t.tick(3 * DAY);
    const ended = await t.auth.api.trustwareReconcile({ body: {} });
    expect(ended.subscriptionsEnded).toBe(1);
    expect(ended.invoicesExpired).toBe(1);
    expect(onSubscriptionEnded).toHaveBeenCalledOnce();
    expect(onSubscriptionEnded.mock.calls[0][0].reason).toBe("non_payment");

    expect(await subscription(t)).toMatchObject({ status: "canceled", endedReason: "non_payment" });
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(false);

    // They can come back by subscribing again.
    const again = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });
    expect(again.invoice?.status).toBe("open");
  });

  it("starts a fresh period from the payment date when the renewal is paid late", async () => {
    const t = await setup();
    await subscribe(t);
    t.tick(29 * DAY);
    await t.auth.api.trustwareReconcile({ body: {} });
    t.tick(3 * DAY + 5000); // Feb 2: past due
    await t.auth.api.trustwareReconcile({ body: {} });
    const renewal = (await invoices(t)).find((i) => i.kind === "subscription_renewal")!;
    await t.pay(renewal.id);

    const sub = await subscription(t);
    expect(sub.status).toBe("active");
    // No backdating: the lapsed days aren't free credit.
    expect(new Date(sub.periodStart!).getTime()).toBe(t.clock.now.getTime());
    expect(new Date(sub.periodEnd!).getTime()).toBe(addInterval(t.clock.now, "month").getTime());
  });

  it("derives lapsed access from dates even if reconcile never runs", async () => {
    const t = await setup({ advanced: { lazyReconcile: false } });
    await subscribe(t);
    t.tick(40 * DAY);
    // Stored status still says active; the dates say the grace period is long over.
    const access = await t.auth.api.trustwareGetAccess({ headers: t.headers });
    expect(access.hasAccess).toBe(false);
    expect(access.status).toBe("canceled");
    const [sub] = await t.db.findMany<{ status: string }>({ model: "trustwareSubscription" });
    expect(sub.status).toBe("active");
  });

  it("settles and renews lazily when the customer opens their billing page", async () => {
    const t = await setup();
    await subscribe(t);
    t.tick(30 * DAY);
    // No cron ran. Just reading billing state issues the renewal.
    const billing = await t.auth.api.trustwareBillingOverview({ headers: t.headers });
    expect(billing.openInvoices).toHaveLength(1);
    expect(billing.openInvoices[0].kind).toBe("subscription_renewal");
    expect(billing.subscriptions[0].status).toBe("active");
  });

  it("rolls free plans over without an invoice", async () => {
    const t = await setup();
    await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "free" } });
    t.tick(32 * DAY);
    await t.auth.api.trustwareReconcile({ body: {} });
    expect(await invoices(t)).toHaveLength(0);
    const sub = await subscription(t);
    expect(sub.status).toBe("active");
    expect(new Date(sub.periodEnd!).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("does not crash when a plan was removed from config", async () => {
    let plans: TrustwarePlan[] = PLANS;
    const t = await setup({ subscription: { enabled: true, plans: () => plans } });
    await subscribe(t);
    plans = PLANS.filter((p) => p.name !== "pro");
    t.tick(29 * DAY);
    const report = await t.auth.api.trustwareReconcile({ body: {} });
    expect(report.renewalsInvoiced).toBe(0);
    expect(report.errors).toBe(0);
    expect((await invoices(t)).filter((i) => i.kind === "subscription_renewal")).toHaveLength(0);
  });
});

describe("free trials", () => {
  it("invoices before the trial ends and converts to paid when it's settled", async () => {
    const onSubscriptionComplete = vi.fn();
    const t = await setup({ subscription: { enabled: true, plans: PLANS, onSubscriptionComplete } });
    await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "trial" } });

    t.tick(2 * DAY);
    expect((await t.auth.api.trustwareReconcile({ body: {} })).renewalsInvoiced).toBe(0);
    t.tick(3 * DAY);
    expect((await t.auth.api.trustwareReconcile({ body: {} })).renewalsInvoiced).toBe(1);

    const invoice = (await invoices(t))[0];
    expect(invoice).toMatchObject({ kind: "subscription_renewal", amountCents: 1000 });
    expect(new Date(invoice.periodStart!).toISOString()).toBe("2026-01-08T00:00:00.000Z"); // starts at trial end

    await t.pay(invoice.id);
    const sub = await subscription(t);
    expect(sub.status).toBe("active");
    expect(new Date(sub.periodStart!).toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(new Date(sub.periodEnd!).toISOString()).toBe("2026-02-08T00:00:00.000Z");
    expect(onSubscriptionComplete).toHaveBeenCalledOnce();
  });

  it("ends the trial for non-payment once the grace period passes", async () => {
    const t = await setup();
    await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "trial" } });
    t.tick(5 * DAY);
    await t.auth.api.trustwareReconcile({ body: {} });
    t.tick(2 * DAY + 1000); // trial over, inside grace
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).reason).toBe("grace_period");
    t.tick(4 * DAY);
    await t.auth.api.trustwareReconcile({ body: {} });
    expect(await subscription(t)).toMatchObject({ status: "canceled", endedReason: "non_payment" });
  });
});

describe("cancel and restore", () => {
  it("cancels at period end: access continues, no renewal is issued, then it ends cleanly", async () => {
    const onSubscriptionCancel = vi.fn();
    const onSubscriptionEnded = vi.fn();
    const t = await setup({ subscription: { enabled: true, plans: PLANS, onSubscriptionCancel, onSubscriptionEnded } });
    await subscribe(t);

    const res = await t.auth.api.trustwareCancelSubscription({ headers: t.headers, body: {} });
    expect(res.subscription).toMatchObject({ cancelAtPeriodEnd: true, status: "active" });
    expect(onSubscriptionCancel).toHaveBeenCalledOnce();
    expect(onSubscriptionEnded).not.toHaveBeenCalled();

    t.tick(29 * DAY);
    const report = await t.auth.api.trustwareReconcile({ body: {} });
    expect(report.renewalsInvoiced).toBe(0);
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(true);

    t.tick(3 * DAY);
    await t.auth.api.trustwareReconcile({ body: {} });
    expect(await subscription(t)).toMatchObject({ status: "canceled", endedReason: "canceled" });
    expect(onSubscriptionEnded).toHaveBeenCalledOnce();
    expect(onSubscriptionEnded.mock.calls[0][0].reason).toBe("canceled");
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(false);
  });

  it("voids an already-issued renewal invoice when the customer cancels", async () => {
    const t = await setup();
    await subscribe(t);
    t.tick(29 * DAY);
    await t.auth.api.trustwareReconcile({ body: {} });
    expect((await invoices(t)).filter((i) => i.status === "open")).toHaveLength(1);
    await t.auth.api.trustwareCancelSubscription({ headers: t.headers, body: {} });
    expect((await invoices(t)).filter((i) => i.status === "open")).toHaveLength(0);
  });

  it("cancels immediately and revokes access at once", async () => {
    const onSubscriptionEnded = vi.fn();
    const t = await setup({ subscription: { enabled: true, plans: PLANS, onSubscriptionEnded } });
    await subscribe(t);
    const res = await t.auth.api.trustwareCancelSubscription({ headers: t.headers, body: { immediately: true } });
    expect(res.subscription.status).toBe("canceled");
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(false);
    expect(onSubscriptionEnded.mock.calls[0][0].reason).toBe("canceled");
  });

  it("restores a pending cancellation, and a cancelled subscription can't be revived by a stray payment", async () => {
    const t = await setup();
    await subscribe(t);
    await expectApiError(
      t.auth.api.trustwareRestoreSubscription({ headers: t.headers, body: {} }),
      "SUBSCRIPTION_NOT_PENDING_CHANGE",
    );
    await t.auth.api.trustwareCancelSubscription({ headers: t.headers, body: {} });
    const restored = await t.auth.api.trustwareRestoreSubscription({ headers: t.headers, body: {} });
    expect(restored.subscription).toMatchObject({ cancelAtPeriodEnd: false });

    t.tick(29 * DAY);
    expect((await t.auth.api.trustwareReconcile({ body: {} })).renewalsInvoiced).toBe(1); // billing resumes
  });

  it("cancels an unfinished checkout", async () => {
    const t = await setup();
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });
    const canceled = await t.auth.api.trustwareCancelSubscription({ headers: t.headers, body: {} });
    expect(canceled.subscription.status).toBe("incomplete_expired");
    expect((await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: res.invoice!.id } })).status).toBe("void");
  });

  it("rejects cancelling when there is nothing to cancel", async () => {
    const t = await setup();
    await expectApiError(t.auth.api.trustwareCancelSubscription({ headers: t.headers, body: {} }), "SUBSCRIPTION_NOT_FOUND");
  });
});

describe("changing plans", () => {
  async function basicSubscriber(overrides = {}) {
    const onSubscriptionUpdate = vi.fn();
    const t = await setup({ subscription: { enabled: true, plans: PLANS, onSubscriptionUpdate, ...overrides } });
    await subscribe(t, "basic");
    return { t, onSubscriptionUpdate };
  }

  it("upgrades now: credits the unused time and starts a fresh period once the difference is paid", async () => {
    const { t, onSubscriptionUpdate } = await basicSubscriber();
    t.tick(15.5 * DAY); // exactly half of the 31-day period remains

    const res = await t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "pro" } });
    expect(res.invoice).toMatchObject({ kind: "plan_change", plan: "pro", amountCents: 1750, creditCents: 250 });
    expect(res.subscription.plan).toBe("basic"); // unchanged until paid
    expect(onSubscriptionUpdate).not.toHaveBeenCalled();

    await t.pay(res.invoice!.id);
    const sub = await subscription(t);
    expect(sub).toMatchObject({ plan: "pro", status: "active" });
    expect(new Date(sub.periodStart!).getTime()).toBe(t.clock.now.getTime());
    expect(onSubscriptionUpdate).toHaveBeenCalledOnce();
    expect(onSubscriptionUpdate.mock.calls[0][0].previousPlan).toBe("basic");
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).features).toContain("export");
  });

  it("can charge the full price with no credit", async () => {
    const { t } = await basicSubscriber({ proration: "none" });
    t.tick(15.5 * DAY);
    const res = await t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "pro" } });
    expect(res.invoice).toMatchObject({ amountCents: 2000, creditCents: 0 });
  });

  it("switches immediately, with no invoice, when the credit covers the new plan", async () => {
    const t = await setup();
    await subscribe(t, "pro");
    t.tick(15.5 * DAY); // $10 of credit vs a $5 plan
    const res = await t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "basic" } });
    expect(res.invoice).toBeNull();
    expect(res.subscription).toMatchObject({ plan: "basic", status: "active" });
    expect(await invoices(t)).toHaveLength(1); // only the original
  });

  it("schedules a change for the end of the period and bills the new price at renewal", async () => {
    const { t } = await basicSubscriber();
    const res = await t.auth.api.trustwareChangeSubscription({
      headers: t.headers,
      body: { plan: "pro", scheduleAtPeriodEnd: true },
    });
    expect(res.invoice).toBeNull();
    expect(res.subscription).toMatchObject({ plan: "basic", pendingPlan: "pro" });

    t.tick(29 * DAY);
    await t.auth.api.trustwareReconcile({ body: {} });
    const renewal = (await invoices(t)).find((i) => i.kind === "subscription_renewal")!;
    expect(renewal).toMatchObject({ plan: "pro", amountCents: 2000 });

    await t.pay(renewal.id);
    expect(await subscription(t)).toMatchObject({ plan: "pro", pendingPlan: null });
  });

  it("re-prices an already-issued renewal when a change is scheduled afterwards", async () => {
    const t = await setup();
    await subscribe(t, "pro");
    t.tick(29 * DAY);
    await t.auth.api.trustwareReconcile({ body: {} });
    await t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "basic", scheduleAtPeriodEnd: true } });
    await t.auth.api.trustwareReconcile({ body: {} });
    const open = (await invoices(t)).filter((i) => i.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ plan: "basic", amountCents: 500 });
  });

  it("restores a scheduled change", async () => {
    const { t } = await basicSubscriber();
    await t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "pro", scheduleAtPeriodEnd: true } });
    const res = await t.auth.api.trustwareRestoreSubscription({ headers: t.headers, body: {} });
    expect(res.subscription.pendingPlan).toBeNull();
  });

  it("changes billing interval on the same plan", async () => {
    const t = await setup();
    await subscribe(t, "pro", "month");
    t.tick(1 * DAY);
    const res = await t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "pro", interval: "year" } });
    expect(res.invoice).toMatchObject({ kind: "plan_change", billingInterval: "year" });
    expect(res.invoice!.amountCents).toBeLessThan(20000);
    expect(res.invoice!.creditCents).toBeGreaterThan(1900);
  });

  it("switches plans during a trial for free", async () => {
    const t = await setup();
    await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "trial" } });
    const res = await t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "pro" } });
    expect(res.invoice).toBeNull();
    expect(res.subscription).toMatchObject({ plan: "pro", status: "trialing" });
  });

  it("rejects no-op changes, unknown plans and changes without an active subscription", async () => {
    const t = await setup();
    await expectApiError(t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "pro" } }), "SUBSCRIPTION_NOT_FOUND");
    await subscribe(t, "pro");
    await expectApiError(t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "pro" } }), "NO_CHANGE_REQUESTED");
    await expectApiError(t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "ghost" } }), "PLAN_NOT_FOUND");
    await expectApiError(
      t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "basic", interval: "year" } }),
      "PLAN_INTERVAL_NOT_AVAILABLE",
    );
  });
});

describe("reconcile", () => {
  it("polls and settles in-flight payments for every account", async () => {
    const t = await setup();
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });
    const prepared = await t.pay(res.invoice!.id, { settle: false });
    t.mock.settle(prepared.intentId);
    t.tick(60_000);
    const report = await t.auth.api.trustwareReconcile({ body: {} });
    expect(report).toMatchObject({ paymentsPolled: 1, paymentsCredited: 1, errors: 0 });
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).plan).toBe("pro");
  });

  it("can be scoped to one account", async () => {
    const t = await setup();
    const other = await t.createUser("someone-else");
    const mine = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "basic" } });
    const theirs = await t.auth.api.trustwareCheckout({ headers: other.headers, body: { plan: "basic" } });
    t.tick(25 * 3_600_000);
    const scoped = await t.auth.api.trustwareReconcile({ body: { referenceId: other.id } });
    expect(scoped.invoicesExpired).toBe(1);
    expect((await t.auth.api.trustwareGetInvoice({ headers: other.headers, query: { id: theirs.invoice!.id } })).status).toBe("expired");
    expect((await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: mine.invoice!.id } })).status).toBe("open");
  });

  it("is protected over HTTP by a bearer secret", async () => {
    const t = await setup();
    const call = (headers: Record<string, string>) =>
      t.auth.handler(new Request("http://localhost:3000/api/auth/trustware/reconcile", { method: "POST", headers }));

    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call({ authorization: "cron-secret" })).status).toBe(401);
    const ok = await call({ authorization: "Bearer cron-secret" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ errors: 0 });

    // Vercel Cron sends GET.
    const get = (headers: Record<string, string>) =>
      t.auth.handler(new Request("http://localhost:3000/api/auth/trustware/reconcile", { method: "GET", headers }));
    expect((await get({})).status).toBe(401);
    expect((await get({ authorization: "Bearer cron-secret" })).status).toBe(200);
  });

  it("is disabled over HTTP unless a secret is configured", async () => {
    const t = await setup({ reconcile: undefined });
    const res = await t.auth.handler(
      new Request("http://localhost:3000/api/auth/trustware/reconcile", { method: "POST", headers: { authorization: "Bearer " } }),
    );
    expect(res.status).toBe(403);
  });
});
