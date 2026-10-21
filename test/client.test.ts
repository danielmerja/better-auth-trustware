import { describe, expect, it } from "vitest";
import { waitForInvoice } from "../src/client";
import { NATIVE_EVM_TOKEN } from "../src/testing";
import { DAY, PAYER, setup, TX_HASH } from "./helpers";

describe("client plugin", () => {
  it("drives a whole purchase through the typed client with the right HTTP methods", async () => {
    const t = await setup();
    const fetchOptions = { headers: t.headers };
    const { trustware } = t.client;

    // Public pricing data, no session.
    const plans = await trustware.plans();
    expect(plans.error).toBeNull();
    expect(plans.data!.plans.map((p) => p.name)).toContain("pro");

    const checkout = await trustware.checkout({ plan: "pro", fetchOptions });
    expect(checkout.error).toBeNull();
    const invoiceId = checkout.data!.invoice!.id;

    const pay = await trustware.invoice.pay({
      invoiceId,
      fromChain: "1",
      fromToken: NATIVE_EVM_TOKEN,
      fromAddress: PAYER,
      fetchOptions,
    });
    expect(pay.error).toBeNull();
    expect(pay.data!.transaction).toBeDefined();

    const receipt = await trustware.payment.receipt({ paymentId: pay.data!.paymentId, txHash: TX_HASH, fetchOptions });
    expect(receipt.data!.payment.status).toBe("submitted");

    t.mock.settle(pay.data!.intentId);
    t.tick(30_000);
    const status = await trustware.invoice.status({ query: { id: invoiceId }, fetchOptions });
    expect(status.data!.status).toBe("paid");

    const access = await trustware.access({ fetchOptions });
    expect(access.data).toMatchObject({ hasAccess: true, plan: "pro" });
    const check = await trustware.access.check({ query: { feature: "export" }, fetchOptions });
    expect(check.data).toMatchObject({ allowed: true, feature: "export" });
    const denied = await trustware.access.check({ query: { feature: "teleport" }, fetchOptions });
    expect(denied.data!.allowed).toBe(false);

    const overview = await trustware.billing({ fetchOptions });
    expect(overview.data!.subscriptions).toHaveLength(1);

    const list = await trustware.invoice.list({ fetchOptions });
    expect(list.data).toHaveLength(1);

    // Bodyless POSTs must be sent as POST, not GET.
    const cancel = await trustware.subscription.cancel({ fetchOptions });
    expect(cancel.error).toBeNull();
    expect(cancel.data!.subscription.cancelAtPeriodEnd).toBe(true);
    const restore = await trustware.subscription.restore({ fetchOptions });
    expect(restore.error).toBeNull();
    expect(restore.data!.subscription.cancelAtPeriodEnd).toBe(false);

    const subs = await trustware.subscription.list({ fetchOptions });
    expect(subs.data![0].plan).toBe("pro");
  });

  it("returns typed error codes to the client", async () => {
    const t = await setup();
    const res = await t.client.trustware.checkout({ plan: "nope", fetchOptions: { headers: t.headers } });
    expect(res.data).toBeNull();
    expect(res.error?.code).toBe("PLAN_NOT_FOUND");
    expect(res.error?.status).toBe(400);

    const anon = await t.client.trustware.checkout({ plan: "pro" });
    expect(anon.error?.status).toBe(401);
  });
});

describe("waitForInvoice", () => {
  async function openInvoice() {
    const t = await setup();
    const checkout = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });
    const prepared = await t.pay(checkout.invoice!.id, { settle: false });
    // Each poll, a little time passes so Trustware's poll schedule lets the next one through.
    const adapter = {
      trustware: {
        invoice: {
          status: (args: { query: { id: string } }) => {
            t.tick(15_000);
            return t.client.trustware.invoice.status({ ...args, fetchOptions: { headers: t.headers } });
          },
        },
      },
    };
    return { t, adapter, invoiceId: checkout.invoice!.id, intentId: prepared.intentId };
  }

  it("resolves once the invoice is paid and reports progress", async () => {
    const { t, adapter, invoiceId, intentId } = await openInvoice();
    const seen: string[] = [];
    setTimeout(() => t.mock.settle(intentId), 30);
    const done = await waitForInvoice(adapter, invoiceId, {
      intervalMs: 10,
      timeoutMs: 5_000,
      onUpdate: (invoice) => seen.push(invoice.status),
    });
    expect(done.status).toBe("paid");
    expect(seen[0]).toBe("open");
    expect(seen.at(-1)).toBe("paid");
  });

  it("times out when nothing settles", async () => {
    const { adapter, invoiceId } = await openInvoice();
    await expect(waitForInvoice(adapter, invoiceId, { intervalMs: 10, timeoutMs: 40 })).rejects.toThrow(/Timed out/);
  });

  it("stops when aborted", async () => {
    const { adapter, invoiceId } = await openInvoice();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(waitForInvoice(adapter, invoiceId, { intervalMs: 10, timeoutMs: 5_000, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("surfaces server errors instead of looping forever", async () => {
    const failing = {
      trustware: { invoice: { status: async () => ({ data: null, error: { message: "nope" } }) } },
    };
    await expect(waitForInvoice(failing, "x", { intervalMs: 5 })).rejects.toThrow("nope");
  });
});

describe("free plans", () => {
  it("survive a long scheduler outage and catch up to the current period", async () => {
    const t = await setup({ advanced: { lazyReconcile: false } });
    await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "free" } });
    t.tick(100 * DAY); // no reconcile for months: a paid plan would be long dead

    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(true);
    const report = await t.auth.api.trustwareReconcile({ body: {} });
    expect(report.subscriptionsEnded).toBe(0);

    const [sub] = await t.auth.api.trustwareListSubscriptions({ headers: t.headers });
    expect(sub.status).toBe("active");
    expect(new Date(sub.periodStart!).toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(new Date(sub.periodEnd!).toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
