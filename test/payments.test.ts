import { describe, expect, it, vi } from "vitest";
import { NATIVE_EVM_TOKEN } from "../src/testing";
import { TrustwareApiError } from "../src/trustware/api";
import { BASE_USDC, DAY, expectApiError, MERCHANT, PAYER, setup, TX_HASH } from "./helpers";

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

async function checkoutPro(t: Awaited<ReturnType<typeof setup>>) {
  const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });
  return res.invoice!;
}

const payBody = (invoiceId: string, over: Record<string, unknown> = {}) => ({
  invoiceId,
  fromChain: "1",
  fromToken: NATIVE_EVM_TOKEN,
  fromAddress: PAYER,
  ...over,
});

describe("preparing a payment", () => {
  it("sizes the source amount so the guaranteed minimum covers the invoice without big overshoot", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const res = await t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id) });

    const min = BigInt(res.estimate.toAmountMin);
    expect(min).toBeGreaterThanOrEqual(20_000_000n);
    expect(min).toBeLessThanOrEqual((20_000_000n * 10_100n) / 10_000n);
    expect(res.transaction).toMatchObject({ to: expect.any(String) });
    expect(res.approvals).toEqual([]); // native ETH needs no allowance
    expect(res.invoice.status).toBe("open");
  });

  it("returns token approvals for ERC-20 sources", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const res = await t.auth.api.trustwarePayInvoice({
      headers: t.headers,
      body: payBody(invoice.id, { fromToken: USDC_MAINNET.toLowerCase() }),
    });
    expect(res.approvals).toHaveLength(1);
    expect(BigInt(res.estimate.toAmountMin)).toBeGreaterThanOrEqual(20_000_000n);
  });

  it("always routes to the merchant, whatever the client sends", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const res = await t.auth.api.trustwarePayInvoice({
      headers: t.headers,
      body: payBody(invoice.id, { toAddress: "0xevil", toChain: "1", toToken: "0xevil", amount: "1", fromAmount: "1" }) as any,
    });
    const sent = t.mock.intents.get(res.intentId)!.request;
    expect(sent).toMatchObject({ toChain: "8453", toToken: BASE_USDC, toAddress: MERCHANT });
    expect(sent.metadata).toMatchObject({ invoiceId: invoice.id, integration: "better-auth-trustware" });
  });

  it("rejects tokens and chains Trustware can't price", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    await expectApiError(
      t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id, { fromToken: "0xunknown" }) }),
      "SOURCE_TOKEN_NOT_SUPPORTED",
    );
    await expectApiError(
      t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id, { fromChain: "999999" }) }),
      "SOURCE_TOKEN_NOT_SUPPORTED",
    );
  });

  it("maps provider outages to a retryable error without leaving a payment behind", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    t.mock.failNext("quote");
    await expectApiError(
      t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id) }),
      "PAYMENT_PROVIDER_UNAVAILABLE",
    );
    t.mock.failNext("route");
    await expectApiError(
      t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id) }),
      "PAYMENT_PROVIDER_UNAVAILABLE",
    );
    const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(view.payments).toEqual([]);
    expect(view.status).toBe("open");
  });

  it("keeps screening and other 4xx failures opaque", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    t.mock.failNext("quote", new TrustwareApiError("address blocked by OFAC", { status: 403, code: "aml_blocked" }));
    const error: any = await t.auth.api
      .trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id) })
      .then(() => undefined, (e) => e);
    expect(error.body.code).toBe("PAYMENT_QUOTE_FAILED");
    expect(JSON.stringify(error.body)).not.toMatch(/OFAC|aml/i);
  });

  it("abandons earlier unsubmitted attempts when a new one is prepared", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const first = await t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id) });
    const second = await t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id) });
    const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    const status = (id: string) => view.payments!.find((p) => p.id === id)!.status;
    expect(status(first.paymentId)).toBe("abandoned");
    expect(status(second.paymentId)).toBe("created");
  });

  it("refuses to pay invoices that are expired, paid or void", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    t.tick(25 * 3_600_000);
    await expectApiError(
      t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id) }),
      "INVOICE_NOT_PAYABLE",
    );
    const fresh = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(fresh.status).toBe("expired");
  });
});

describe("receipts", () => {
  it("validates, de-duplicates and refuses to reuse transaction hashes", async () => {
    const t = await setup();
    const a = await checkoutPro(t);
    const prepared = await t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(a.id) });

    await expectApiError(
      t.auth.api.trustwareSubmitReceipt({ headers: t.headers, body: { paymentId: prepared.paymentId, txHash: "nope" } }),
      "INVALID_TRANSACTION_HASH",
    );
    await expectApiError(
      t.auth.api.trustwareSubmitReceipt({ headers: t.headers, body: { paymentId: "missing", txHash: TX_HASH } }),
      "PAYMENT_NOT_FOUND",
    );

    const ok = await t.auth.api.trustwareSubmitReceipt({ headers: t.headers, body: { paymentId: prepared.paymentId, txHash: TX_HASH } });
    expect(ok.payment).toMatchObject({ status: "submitted", sourceTxHash: TX_HASH });
    // Resubmitting the same hash is a no-op; a different one is refused.
    const again = await t.auth.api.trustwareSubmitReceipt({ headers: t.headers, body: { paymentId: prepared.paymentId, txHash: TX_HASH } });
    expect(again.payment.sourceTxHash).toBe(TX_HASH);
    expect(t.mock.calls.receipt).toBe(1);
    await expectApiError(
      t.auth.api.trustwareSubmitReceipt({ headers: t.headers, body: { paymentId: prepared.paymentId, txHash: `0x${"c".repeat(64)}` } }),
      "PAYMENT_ALREADY_SUBMITTED",
    );

    // The same transaction can't pay a second invoice.
    const other = await t.createUser("other");
    const second = await t.auth.api.trustwareCheckout({ headers: other.headers, body: { plan: "basic" } });
    const p2 = await t.auth.api.trustwarePayInvoice({ headers: other.headers, body: payBody(second.invoice!.id) });
    await expectApiError(
      t.auth.api.trustwareSubmitReceipt({ headers: other.headers, body: { paymentId: p2.paymentId, txHash: TX_HASH } }),
      "PAYMENT_ALREADY_SUBMITTED",
    );
  });

  it("surfaces a provider outage on receipt without marking the payment submitted", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(invoice.id) });
    t.mock.failNext("receipt");
    await expectApiError(
      t.auth.api.trustwareSubmitReceipt({ headers: t.headers, body: { paymentId: prepared.paymentId, txHash: TX_HASH } }),
      "PAYMENT_PROVIDER_UNAVAILABLE",
    );
    const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(view.payments![0]).toMatchObject({ status: "created", sourceTxHash: null });
    // Retrying works.
    await t.auth.api.trustwareSubmitReceipt({ headers: t.headers, body: { paymentId: prepared.paymentId, txHash: TX_HASH } });
  });
});

describe("settlement", () => {
  it("credits the invoice once and activates the subscription", async () => {
    const onInvoicePaid = vi.fn();
    const onSubscriptionComplete = vi.fn();
    const t = await setup({
      onInvoicePaid,
      subscription: { enabled: true, plans: (await import("./helpers")).PLANS, onSubscriptionComplete },
    });
    const invoice = await checkoutPro(t);
    await t.pay(invoice.id);

    const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("paid");
    expect(BigInt(view.amountPaidUnits)).toBeGreaterThanOrEqual(20_000_000n);
    expect(view.payments![0]).toMatchObject({ status: "success" });
    expect(view.payments![0].destTxHash).toBeTruthy();

    const [sub] = await t.auth.api.trustwareListSubscriptions({ headers: t.headers });
    expect(sub.status).toBe("active");
    expect(new Date(sub.periodEnd!).toISOString()).toBe("2026-02-01T00:00:30.000Z");
    expect(onInvoicePaid).toHaveBeenCalledOnce();
    expect(onSubscriptionComplete).toHaveBeenCalledOnce();
  });

  it("fulfils exactly once under concurrent polling", async () => {
    const onInvoicePaid = vi.fn();
    const onSubscriptionComplete = vi.fn();
    const t = await setup({
      onInvoicePaid,
      subscription: { enabled: true, plans: (await import("./helpers")).PLANS, onSubscriptionComplete },
    });
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    t.mock.settle(prepared.intentId);
    t.tick(30_000);

    await Promise.all(
      Array.from({ length: 6 }, () => t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } })),
    );
    expect(onInvoicePaid).toHaveBeenCalledTimes(1);
    expect(onSubscriptionComplete).toHaveBeenCalledTimes(1);
    const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("paid");
    expect(view.payments!.filter((p) => p.status === "success")).toHaveLength(1);
  });

  it("respects Trustware's poll schedule instead of hammering the API", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    const before = t.mock.calls.status;
    await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(t.mock.calls.status).toBe(before); // nextPollAt is still in the future
    t.tick(10_000);
    await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(t.mock.calls.status).toBe(before + 1);
    expect(prepared.intentId).toBeTruthy();
  });

  it("tracks bridging and leaves the invoice open until success", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    t.mock.bridge(prepared.intentId);
    t.tick(30_000);
    const view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("open");
    expect(view.payments![0].status).toBe("bridging");
  });

  it("accepts a partial payment, then a top-up sized for what's left", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    await t.pay(invoice.id, { toAmount: 8_000_000n });

    let view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(view).toMatchObject({ status: "open", amountPaidUnits: "8000000", remainingUnits: "12000000" });
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(false);

    const topUp = await t.pay(invoice.id);
    // The second route only needs to cover the remaining $12.
    expect(BigInt(topUp.estimate.toAmountMin)).toBeGreaterThanOrEqual(12_000_000n);
    expect(BigInt(topUp.estimate.toAmountMin)).toBeLessThan(13_000_000n);
    view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("paid");
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(true);
  });

  it("flags overpayment for a manual refund", async () => {
    const onOverpayment = vi.fn();
    const t = await setup({ onOverpayment });
    const invoice = await checkoutPro(t);
    await t.pay(invoice.id, { toAmount: 25_000_000n });
    expect(onOverpayment).toHaveBeenCalledOnce();
    expect(onOverpayment.mock.calls[0][0].excessUnits).toBe(5_000_000n);
    const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("paid");
  });

  it("reports money that arrives for an already-paid invoice as overpayment", async () => {
    const onOverpayment = vi.fn();
    const t = await setup({ onOverpayment });
    const invoice = await checkoutPro(t);
    // Two payments in flight at once; both settle.
    const a = await t.pay(invoice.id, { settle: false });
    const b = await t.pay(invoice.id, { settle: false });
    t.mock.settle(a.intentId);
    t.tick(30_000);
    await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    t.mock.settle(b.intentId);
    t.tick(30_000);
    await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(onOverpayment).toHaveBeenCalledOnce();
    expect(onOverpayment.mock.calls[0][0].excessUnits).toBeGreaterThanOrEqual(20_000_000n);
  });

  it("treats near-complete payments as paid within the configured tolerance", async () => {
    const t = await setup({ invoice: { underpaymentToleranceBps: 100 } });
    const invoice = await checkoutPro(t);
    await t.pay(invoice.id, { toAmount: 19_900_000n }); // 99.5%
    expect((await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } })).status).toBe("paid");

    const t2 = await setup({ invoice: { underpaymentToleranceBps: 100 } });
    const invoice2 = await checkoutPro(t2);
    await t2.pay(invoice2.id, { toAmount: 19_700_000n }); // 98.5%
    expect((await t2.auth.api.trustwareGetInvoice({ headers: t2.headers, query: { id: invoice2.id } })).status).toBe("open");
  });

  it("records a failed payment, tells the app, and lets the customer retry", async () => {
    const onPaymentFailed = vi.fn();
    const t = await setup({ onPaymentFailed });
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    t.mock.fail(prepared.intentId);
    t.tick(30_000);
    const view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("open");
    expect(view.payments![0]).toMatchObject({ status: "failed", errorCode: "trustware_failed" });
    expect(onPaymentFailed).toHaveBeenCalledOnce();

    await t.pay(invoice.id);
    expect((await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } })).status).toBe("paid");
  });

  it("survives a Trustware outage while polling and settles on the next poll", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    t.mock.settle(prepared.intentId);
    t.mock.failNext("status");
    t.tick(30_000);
    const during = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(during.status).toBe("open");
    expect(during.payments![0].status).toBe("submitted");
    t.tick(30_000);
    const after = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(after.status).toBe("paid");
  });

  it("fails a payment whose intent Trustware no longer knows", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    t.mock.intents.delete(prepared.intentId);
    t.tick(30_000);
    const view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(view.payments![0]).toMatchObject({ status: "failed", errorCode: "intent_not_found" });
  });

  it("refuses to credit when Trustware reports a different destination", async () => {
    for (const report of [{ toAddress: "0xattacker" }, { toChain: "1" }, { metadata: { invoiceId: "someone-elses" } }]) {
      const t = await setup();
      const invoice = await checkoutPro(t);
      const prepared = await t.pay(invoice.id, { settle: false });
      t.mock.misreport(prepared.intentId, report);
      t.mock.settle(prepared.intentId);
      t.tick(30_000);
      const view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
      expect(view.status).toBe("open");
      expect(view.payments![0]).toMatchObject({ status: "failed", errorCode: "destination_mismatch", creditedUnits: "0" });
      expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(false);
    }
  });

  it("matches EVM destination addresses case-insensitively", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    t.mock.misreport(prepared.intentId, { toAddress: MERCHANT.toUpperCase().replace("0X", "0x") });
    t.mock.settle(prepared.intentId);
    t.tick(30_000);
    const view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("paid");
  });

  it("waits when Trustware hasn't verified the landed amount, then credits once it has", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    t.mock.settle(prepared.intentId, { landedAmountVerified: false });
    t.tick(30_000);
    let view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("open");
    expect(view.payments![0]).toMatchObject({ status: "bridging", errorCode: "landing_unverified", creditedUnits: "0" });

    t.mock.settle(prepared.intentId, { landedAmountVerified: true });
    t.tick(120_000);
    view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("paid");
  });

  describe("verifyPayment hook", () => {
    it("can reject a payment", async () => {
      const verifyPayment = vi.fn(async () => false);
      const t = await setup({ verifyPayment });
      const invoice = await checkoutPro(t);
      await t.pay(invoice.id);
      expect(verifyPayment).toHaveBeenCalledOnce();
      const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
      expect(view.status).toBe("open");
      expect(view.payments![0]).toMatchObject({ status: "failed", errorCode: "verification_failed" });
    });

    it("can credit an amount it verified on-chain, and overrides the unverified-landing guard", async () => {
      const t = await setup({ verifyPayment: async () => ({ creditedUnits: 20_000_000n }) });
      const invoice = await checkoutPro(t);
      const prepared = await t.pay(invoice.id, { settle: false });
      t.mock.settle(prepared.intentId, { landedAmountVerified: false, toAmount: 1n });
      t.tick(30_000);
      const view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
      expect(view.status).toBe("paid");
      expect(view.payments![0].creditedUnits).toBe("20000000");
    });

    it("receives the invoice, payment and Trustware status", async () => {
      const verifyPayment = vi.fn(async () => true);
      const t = await setup({ verifyPayment });
      const invoice = await checkoutPro(t);
      await t.pay(invoice.id);
      const args = (verifyPayment.mock.calls[0] as unknown[])[0] as any;
      expect(args.invoice.id).toBe(invoice.id);
      expect(args.payment.intentId).toMatch(/^intent_/);
      expect(args.status.status).toBe("success");
    });
  });

  it("rejects a zero-amount settlement", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    t.mock.settle(prepared.intentId, { toAmount: 0n });
    t.tick(30_000);
    const view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(view.payments![0]).toMatchObject({ status: "failed", errorCode: "zero_amount" });
  });

  it("swallows a throwing app callback instead of undoing a settled payment", async () => {
    const t = await setup({
      onInvoicePaid: async () => {
        throw new Error("your webhook is down");
      },
    });
    const invoice = await checkoutPro(t);
    await t.pay(invoice.id);
    expect((await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } })).status).toBe("paid");
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(true);
  });
});

describe("late and in-flight payments", () => {
  it("expires an unpaid first invoice and ends the incomplete subscription", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    t.tick(25 * 3_600_000);
    const report = await t.auth.api.trustwareReconcile({ body: {} });
    expect(report.invoicesExpired).toBe(1);
    const [sub] = await t.auth.api.trustwareListSubscriptions({ headers: t.headers, query: { includeEnded: true } });
    expect(sub.status).toBe("incomplete_expired");
    expect((await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } })).status).toBe("expired");
  });

  it("does not expire an invoice while a payment for it is still in flight, and honors it when it lands", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });

    t.tick(26 * 3_600_000); // past the invoice's expiry
    const report = await t.auth.api.trustwareReconcile({ body: {} });
    expect(report.invoicesExpired).toBe(0);

    t.mock.settle(prepared.intentId);
    t.tick(60_000);
    const settled = await t.auth.api.trustwareReconcile({ body: {} });
    expect(settled.paymentsCredited).toBe(1);
    const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("paid");
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(true);
  });

  it("still credits money that lands after the invoice already expired", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    // Force the invoice to expire out from under the in-flight payment.
    await t.db.update({ model: "trustwareInvoice", where: [{ field: "id", value: invoice.id }], update: { status: "expired" } });
    await t.db.update({
      model: "trustwareSubscription",
      where: [{ field: "referenceId", value: (await t.auth.api.trustwareListSubscriptions({ headers: t.headers }))[0].referenceId }],
      update: { status: "incomplete_expired" },
    });
    t.mock.settle(prepared.intentId);
    t.tick(60_000);
    await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } });
    expect(view.status).toBe("paid");
    const access = await t.auth.api.trustwareGetAccess({ headers: t.headers });
    expect(access).toMatchObject({ hasAccess: true, plan: "pro" });
  });

  it("repairs a payment that was credited but never applied to its invoice", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    // Simulate a crash between claiming the credit and updating the invoice.
    await t.db.update({
      model: "trustwarePayment",
      where: [{ field: "intentId", value: prepared.intentId }],
      update: { status: "success", credited: true, creditedUnits: "20500000" },
    });
    const report = await t.auth.api.trustwareReconcile({ body: {} });
    expect(report.invoicesRepaired).toBeGreaterThanOrEqual(1);
    expect((await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: invoice.id } })).status).toBe("paid");
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).plan).toBe("pro");
  });

  it("keeps a settled payment settled when applying its effects fails, then finishes on the next reconcile", async () => {
    const t = await setup({ advanced: { lazyReconcile: false } }); // so we can see the in-between state
    const invoice = await checkoutPro(t);
    const prepared = await t.pay(invoice.id, { settle: false });
    t.mock.settle(prepared.intentId);
    t.tick(30_000);

    // Make the subscription write fail once, as a database blip would.
    const adapter: any = (await t.auth.$context).adapter;
    const original = adapter.update.bind(adapter);
    let failed = false;
    adapter.update = async (args: any) => {
      if (!failed && args.model === "trustwareSubscription") {
        failed = true;
        throw new Error("connection reset");
      }
      return original(args);
    };

    // The customer is not shown an error for a payment that worked.
    const view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: invoice.id } });
    expect(failed).toBe(true);
    expect(view.status).toBe("paid");
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(false);

    adapter.update = original;
    const report = await t.auth.api.trustwareReconcile({ body: {} });
    expect(report.invoicesRepaired).toBe(1);
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).plan).toBe("pro");
  });

  it("re-applies a paid invoice whose effects never ran", async () => {
    const t = await setup();
    const invoice = await checkoutPro(t);
    await t.db.update({
      model: "trustwareInvoice",
      where: [{ field: "id", value: invoice.id }],
      update: { status: "paid", paidAt: t.clock.now, fulfilled: false, amountPaidUnits: "20000000" },
    });
    await t.auth.api.trustwareReconcile({ body: {} });
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).plan).toBe("pro");
  });
});

describe("misc", () => {
  it("reports unused constants so the test file stays honest", () => {
    expect(DAY).toBe(86_400_000);
    expect(USDC_MAINNET).toHaveLength(42);
  });
});
