import { organization } from "better-auth/plugins/organization";
import { describe, expect, it, vi } from "vitest";
import { trustware } from "../src";
import { createMockTrustware, NATIVE_EVM_TOKEN } from "../src/testing";
import { expectApiError, MERCHANT, PAYER, PLANS, setup, TX_HASH } from "./helpers";

const payBody = (invoiceId: string) => ({ invoiceId, fromChain: "1", fromToken: NATIVE_EVM_TOKEN, fromAddress: PAYER });

async function unauthorized(promise: Promise<unknown>) {
  const error: any = await promise.then(
    () => undefined,
    (e) => e,
  );
  expect(error, "expected the call to reject").toBeDefined();
  expect(error.status).toBe("UNAUTHORIZED");
}

describe("authentication", () => {
  it("requires a session everywhere except the public plan list", async () => {
    const t = await setup();
    const { api } = t.auth;
    await unauthorized(api.trustwareCheckout({ body: { plan: "pro" } }));
    await unauthorized(api.trustwareGetAccess({}));
    await unauthorized(api.trustwareCheckAccess({}));
    await unauthorized(api.trustwareBillingOverview({}));
    await unauthorized(api.trustwareListInvoices({}));
    await unauthorized(api.trustwareListSubscriptions({}));
    await unauthorized(api.trustwareGetInvoice({ query: { id: "x" } }));
    await unauthorized(api.trustwareInvoiceStatus({ query: { id: "x" } }));
    await unauthorized(api.trustwarePayInvoice({ body: payBody("x") }));
    await unauthorized(api.trustwareSubmitReceipt({ body: { paymentId: "x", txHash: TX_HASH } }));
    await unauthorized(api.trustwareCancelSubscription({ body: {} }));
    await unauthorized(api.trustwareChangeSubscription({ body: { plan: "pro" } }));
    await unauthorized(api.trustwareRestoreSubscription({ body: {} }));
    await expect(api.trustwareListPlans()).resolves.toBeDefined();
  });
});

describe("isolation between accounts", () => {
  it("hides one user's invoices, payments and subscription from another", async () => {
    const t = await setup();
    const mallory = await t.createUser("mallory");
    const mine = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });
    const prepared = await t.auth.api.trustwarePayInvoice({ headers: t.headers, body: payBody(mine.invoice!.id) });

    const id = mine.invoice!.id;
    await expectApiError(t.auth.api.trustwareGetInvoice({ headers: mallory.headers, query: { id } }), "INVOICE_NOT_FOUND");
    await expectApiError(t.auth.api.trustwareInvoiceStatus({ headers: mallory.headers, query: { id } }), "INVOICE_NOT_FOUND");
    await expectApiError(t.auth.api.trustwarePayInvoice({ headers: mallory.headers, body: payBody(id) }), "INVOICE_NOT_FOUND");
    await expectApiError(
      t.auth.api.trustwareSubmitReceipt({ headers: mallory.headers, body: { paymentId: prepared.paymentId, txHash: TX_HASH } }),
      "INVOICE_NOT_FOUND",
    );
    // A real invoice and a made-up one are indistinguishable.
    await expectApiError(t.auth.api.trustwareGetInvoice({ headers: mallory.headers, query: { id: "does-not-exist" } }), "INVOICE_NOT_FOUND");

    // Mallory's own views are empty, and Mallory can't cancel Alice's subscription.
    expect(await t.auth.api.trustwareListInvoices({ headers: mallory.headers })).toEqual([]);
    expect(await t.auth.api.trustwareListSubscriptions({ headers: mallory.headers })).toEqual([]);
    await expectApiError(t.auth.api.trustwareCancelSubscription({ headers: mallory.headers, body: {} }), "SUBSCRIPTION_NOT_FOUND");
    expect(t.mock.calls.receipt).toBe(0);
  });

  it("rejects a referenceId that isn't yours unless authorizeReference approves", async () => {
    const t = await setup();
    const mallory = await t.createUser("mallory2");
    const me = (await t.auth.api.getSession({ headers: t.headers }))!.user.id;
    await expectApiError(
      t.auth.api.trustwareListInvoices({ headers: mallory.headers, query: { referenceId: me } }),
      "REFERENCE_ID_NOT_ALLOWED",
    );
    await expectApiError(
      t.auth.api.trustwareCheckout({ headers: mallory.headers, body: { plan: "pro", referenceId: me } }),
      "REFERENCE_ID_NOT_ALLOWED",
    );
    await expectApiError(
      t.auth.api.trustwareGetAccess({ headers: mallory.headers, query: { referenceId: me } }),
      "REFERENCE_ID_NOT_ALLOWED",
    );
  });

  it("calls authorizeReference with the action being attempted", async () => {
    const authorizeReference = vi.fn(async () => true);
    const t = await setup({ authorizeReference });
    const agent = await t.createUser("agent");
    const me = (await t.auth.api.getSession({ headers: t.headers }))!.user.id;
    const res = await t.auth.api.trustwareCheckout({ headers: agent.headers, body: { plan: "pro", referenceId: me } });
    expect(res.invoice?.referenceId).toBe(me);
    await t.auth.api.trustwareGetInvoice({ headers: agent.headers, query: { id: res.invoice!.id } });
    await t.auth.api.trustwareGetAccess({ headers: agent.headers, query: { referenceId: me } });
    const actions = authorizeReference.mock.calls.map((c) => (c as any)[0].action);
    expect(actions).toEqual(["create-checkout", "view-billing", "check-access"]);
    expect((authorizeReference.mock.calls[0] as any)[0].referenceId).toBe(me);
  });

  it("denies when authorizeReference says no", async () => {
    const t = await setup({ authorizeReference: async () => false });
    const other = await t.createUser("other2");
    const me = (await t.auth.api.getSession({ headers: t.headers }))!.user.id;
    await unauthorized(t.auth.api.trustwareCheckout({ headers: other.headers, body: { plan: "pro", referenceId: me } }));
  });
});

describe("organizations", () => {
  const members = new Set<string>();
  const orgOptions = () => ({
    organization: { enabled: true },
    authorizeReference: async ({ user, referenceId }: any) => referenceId === "org_1" && members.has(user.id),
  });

  it("is off unless enabled", async () => {
    const t = await setup();
    await expectApiError(
      t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro", customerType: "organization", referenceId: "org_1" } }),
      "ORGANIZATION_SUBSCRIPTION_NOT_ENABLED",
    );
  });

  it("needs authorizeReference once enabled", async () => {
    const t = await setup({ organization: { enabled: true } });
    await expectApiError(
      t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro", customerType: "organization", referenceId: "org_1" } }),
      "AUTHORIZE_REFERENCE_REQUIRED",
    );
  });

  it("needs a reference id when there is no active organization", async () => {
    const t = await setup(orgOptions());
    await expectApiError(
      t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro", customerType: "organization" } }),
      "ORGANIZATION_REFERENCE_ID_REQUIRED",
    );
  });

  it("bills the organization, lets members manage it, and keeps outsiders out", async () => {
    const t = await setup(orgOptions());
    const member = await t.createUser("member");
    const outsider = await t.createUser("outsider");
    members.add(member.id);

    const body = { plan: "pro", customerType: "organization" as const, referenceId: "org_1" };
    await unauthorized(t.auth.api.trustwareCheckout({ headers: outsider.headers, body }));
    await unauthorized(t.auth.api.trustwareCheckout({ headers: t.headers, body })); // signed in, but not a member

    const res = await t.auth.api.trustwareCheckout({ headers: member.headers, body });
    expect(res.invoice).toMatchObject({ referenceId: "org_1", customerType: "organization" });

    // Members can pay and see it...
    const prepared = await t.auth.api.trustwarePayInvoice({ headers: member.headers, body: payBody(res.invoice!.id) });
    await t.auth.api.trustwareSubmitReceipt({ headers: member.headers, body: { paymentId: prepared.paymentId, txHash: TX_HASH } });
    t.mock.settle(prepared.intentId);
    t.tick(30_000);
    const paid = await t.auth.api.trustwareInvoiceStatus({ headers: member.headers, query: { id: res.invoice!.id } });
    expect(paid.status).toBe("paid");

    const access = await t.auth.api.trustwareGetAccess({
      headers: member.headers,
      query: { customerType: "organization", referenceId: "org_1" },
    });
    expect(access).toMatchObject({ hasAccess: true, plan: "pro" });

    // ...the member's personal account is unaffected...
    expect((await t.auth.api.trustwareGetAccess({ headers: member.headers })).hasAccess).toBe(false);
    // ...and outsiders can't see it.
    await expectApiError(t.auth.api.trustwareGetInvoice({ headers: outsider.headers, query: { id: res.invoice!.id } }), "INVOICE_NOT_FOUND");
    await unauthorized(
      t.auth.api.trustwareGetAccess({ headers: outsider.headers, query: { customerType: "organization", referenceId: "org_1" } }),
    );
    // A member can cancel the organization's subscription.
    const canceled = await t.auth.api.trustwareCancelSubscription({
      headers: member.headers,
      body: { customerType: "organization", referenceId: "org_1" },
    });
    expect(canceled.subscription.cancelAtPeriodEnd).toBe(true);
  });

});

describe("organizations with the organization plugin", () => {
  it("bills the session's active organization by default, gated by real membership", async () => {
    const t = await setup(
      {
        organization: { enabled: true },
        // The check the docs recommend: the caller must belong to the organization.
        authorizeReference: async ({ user, referenceId }, ctx) =>
          !!(await ctx.context.adapter.findOne({
            model: "member",
            where: [
              { field: "organizationId", value: referenceId },
              { field: "userId", value: user.id },
            ],
          })),
      },
      { plugins: [organization()] },
    );
    const api = t.auth.api as any;
    const org = await api.createOrganization({ headers: t.headers, body: { name: "Acme", slug: "acme" } });
    await api.setActiveOrganization({ headers: t.headers, body: { organizationId: org.id } });

    // No referenceId: it resolves from the session.
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro", customerType: "organization" } });
    expect(res.invoice).toMatchObject({ referenceId: org.id, customerType: "organization" });

    const outsider = await t.createUser("not-a-member");
    await unauthorized(
      t.auth.api.trustwareGetAccess({ headers: outsider.headers, query: { customerType: "organization", referenceId: org.id } }),
    );
    await expectApiError(t.auth.api.trustwareGetInvoice({ headers: outsider.headers, query: { id: res.invoice!.id } }), "INVOICE_NOT_FOUND");
  });
});

describe("the customer can't make themselves paid", () => {
  it("does not credit a payment that Trustware hasn't confirmed, however often it's submitted", async () => {
    const t = await setup();
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } });
    const prepared = await t.pay(res.invoice!.id, { settle: false });
    for (let i = 0; i < 5; i += 1) {
      t.tick(30_000);
      const view = await t.auth.api.trustwareInvoiceStatus({ headers: t.headers, query: { id: res.invoice!.id } });
      expect(view.status).toBe("open");
    }
    expect((await t.auth.api.trustwareGetAccess({ headers: t.headers })).hasAccess).toBe(false);
    expect(prepared.intentId).toBeTruthy();
  });

  it("ignores client-supplied amounts, destinations and statuses", async () => {
    const t = await setup();
    const res = await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro", priceCents: 1, amountCents: 1 } as any });
    expect(res.invoice?.amountCents).toBe(2000);
    const prepared = await t.auth.api.trustwarePayInvoice({
      headers: t.headers,
      body: { ...payBody(res.invoice!.id), status: "success", creditedUnits: "99999999", toAddress: "0xevil" } as any,
    });
    const intent = t.mock.intents.get(prepared.intentId)!;
    expect(intent.request.toAddress).toBe(MERCHANT);
    const view = await t.auth.api.trustwareGetInvoice({ headers: t.headers, query: { id: res.invoice!.id } });
    expect(view.status).toBe("open");
    expect(view.payments![0].creditedUnits).toBe("0");
  });

  it("can't use a free-plan checkout to dodge paying for a paid one", async () => {
    const t = await setup();
    await t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "free" } });
    await expectApiError(
      t.auth.api.trustwareCheckout({ headers: t.headers, body: { plan: "pro" } }),
      "ALREADY_SUBSCRIBED",
    );
    // Moving off the free plan goes through an invoice like anything else.
    const change = await t.auth.api.trustwareChangeSubscription({ headers: t.headers, body: { plan: "pro" } });
    expect(change.invoice?.status).toBe("open");
    expect(change.subscription.plan).toBe("free");
  });
});

describe("plugin wiring", () => {
  it("rate-limits the endpoints that fan out to Trustware", () => {
    const plugin = trustware({
      trustware: createMockTrustware(),
      settlement: { chainId: "8453", tokenAddress: "0x1", tokenDecimals: 6, address: MERCHANT },
      subscription: { enabled: true, plans: PLANS },
    });
    const limited = (path: string) => plugin.rateLimit.some((r) => r.pathMatcher(path));
    expect(limited("/trustware/invoice/pay")).toBe(true);
    expect(limited("/trustware/payment/receipt")).toBe(true);
    expect(limited("/trustware/invoice/status")).toBe(true);
    expect(limited("/trustware/checkout")).toBe(true);
    expect(limited("/trustware/plans")).toBe(false);
  });

  it("namespaces everything under /trustware so it can sit beside other billing plugins", () => {
    const plugin = trustware({
      trustware: createMockTrustware(),
      settlement: { chainId: "8453", tokenAddress: "0x1", tokenDecimals: 6, address: MERCHANT },
      subscription: { enabled: true, plans: PLANS },
    });
    const paths = Object.values(plugin.endpoints)
      .map((e: any) => e.path)
      .filter(Boolean);
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.every((p: string) => p.startsWith("/trustware/"))).toBe(true);
    // Only the schema this plugin owns, all prefixed so it can't collide with Stripe's `subscription`.
    expect(Object.keys(plugin.schema).sort()).toEqual(["trustwareInvoice", "trustwarePayment", "trustwareSubscription"]);
  });

  it("keeps the reconcile hooks off the client: one is server-only, one is HTTP-with-secret and hidden", () => {
    const plugin = trustware({
      trustware: createMockTrustware(),
      settlement: { chainId: "8453", tokenAddress: "0x1", tokenDecimals: 6, address: MERCHANT },
      subscription: { enabled: true, plans: PLANS },
    });
    const server: any = plugin.endpoints.trustwareReconcile;
    const http: any = plugin.endpoints.trustwareReconcileHttp;
    expect(server.path).toBeUndefined(); // path-less: only reachable through auth.api
    expect(http.path).toBe("/trustware/reconcile");
    expect(http.options.metadata.scope).toBe("server"); // routed, but not offered to client code
  });

  it("omits the subscription table when subscriptions are disabled", () => {
    const plugin = trustware({
      trustware: createMockTrustware(),
      settlement: { chainId: "8453", tokenAddress: "0x1", tokenDecimals: 6, address: MERCHANT },
      products: [{ id: "x", name: "X", amountCents: 100 }],
    });
    expect(Object.keys(plugin.schema).sort()).toEqual(["trustwareInvoice", "trustwarePayment"]);
  });
});
