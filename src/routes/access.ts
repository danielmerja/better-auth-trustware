import { createAuthEndpoint } from "@better-auth/core/api";
import * as z from "zod";
import { summarizeAccess } from "../core/access";
import type { Billing } from "../core/billing";
import { invoices, subscriptions, type Ctx } from "../core/store";
import { referenceMiddleware, trustwareSessionMiddleware } from "../middleware";
import type { AccessSummary } from "../types";
import { customerTypeSchema, refreshReference } from "./shared";
import { invoiceView, subscriptionView } from "./views";

export async function loadAccess(ctx: Ctx, billing: Billing, referenceId: string): Promise<AccessSummary> {
  const [subs, recent, plans, products] = await Promise.all([
    subscriptions.forReference(ctx, referenceId),
    invoices.forReference(ctx, referenceId, { status: "paid", limit: 200 }),
    billing.getPlans(),
    billing.getProducts(),
  ]);
  return summarizeAccess({
    subscriptions: subs,
    invoices: recent,
    plans,
    products,
    now: billing.now(),
    graceDays: billing.graceDays,
  });
}

const referenceQuery = {
  referenceId: z.string().optional(),
  customerType: customerTypeSchema.optional(),
};

/** Public pricing data: plans (minus hidden ones), products and where payments settle. */
export const listPlans = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/plans",
    { method: "GET", metadata: { openapi: { operationId: "trustwareListPlans" } } },
    async (ctx) => {
      const s = billing.options.settlement;
      const plans = (await billing.getPlans()).filter((p) => !p.hidden);
      const products = await billing.getProducts();
      return ctx.json({
        plans: plans.map((p) => ({
          name: p.name,
          displayName: p.displayName ?? null,
          description: p.description ?? null,
          prices: p.prices,
          limits: p.limits ?? {},
          features: p.features ?? [],
          group: p.group ?? null,
          trialDays: p.freeTrial?.days ?? null,
        })),
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description ?? null,
          amountCents: p.amountCents,
          features: p.features ?? [],
          accessDays: p.accessDays ?? null,
        })),
        settlement: {
          chainId: s.chainId,
          tokenAddress: s.tokenAddress,
          tokenSymbol: s.tokenSymbol ?? null,
          tokenDecimals: s.tokenDecimals,
        },
      });
    },
  );

/** What the account is entitled to right now. */
export const getAccess = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/access",
    {
      method: "GET",
      query: z.object(referenceQuery).optional(),
      metadata: { openapi: { operationId: "trustwareGetAccess" } },
      use: [trustwareSessionMiddleware, referenceMiddleware(billing.options, "check-access")],
    },
    async (ctx) => {
      const { referenceId } = ctx.context;
      await refreshReference(ctx, billing, referenceId);
      return ctx.json(await loadAccess(ctx, billing, referenceId));
    },
  );

/**
 * Check one feature (or just "any active access" when `feature` is omitted).
 * A feature passes if the plan lists it in `features`, or has a non-zero entry in `limits`.
 */
export const checkAccess = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/access/check",
    {
      method: "GET",
      query: z.object({ feature: z.string().optional(), ...referenceQuery }).optional(),
      metadata: { openapi: { operationId: "trustwareCheckAccess" } },
      use: [trustwareSessionMiddleware, referenceMiddleware(billing.options, "check-access")],
    },
    async (ctx) => {
      const { referenceId } = ctx.context;
      await refreshReference(ctx, billing, referenceId);
      const access = await loadAccess(ctx, billing, referenceId);
      const feature = ctx.query?.feature;
      const limit = feature === undefined ? undefined : access.limits[feature];
      const allowed =
        access.hasAccess &&
        (feature === undefined || access.features.includes(feature) || (limit !== undefined && limit !== 0));
      return ctx.json({
        allowed,
        feature: feature ?? null,
        limit: limit ?? null,
        plan: access.plan,
        status: access.status,
        reason: access.reason,
      });
    },
  );

/** Everything a billing page needs in one call. */
export const getBillingOverview = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/billing",
    {
      method: "GET",
      query: z.object(referenceQuery).optional(),
      metadata: { openapi: { operationId: "trustwareBillingOverview" } },
      use: [trustwareSessionMiddleware, referenceMiddleware(billing.options, "view-billing")],
    },
    async (ctx) => {
      const { referenceId } = ctx.context;
      await refreshReference(ctx, billing, referenceId);
      const [access, subs, recent, plans] = await Promise.all([
        loadAccess(ctx, billing, referenceId),
        subscriptions.forReference(ctx, referenceId),
        invoices.forReference(ctx, referenceId, { limit: 25 }),
        billing.getPlans(),
      ]);
      const subscriptionViews = subs
        .map((s) => subscriptionView(billing, s, plans.find((p) => p.name === s.plan)))
        .filter((v) => v.status !== "canceled" && v.status !== "incomplete_expired");
      return ctx.json({
        access,
        subscriptions: subscriptionViews,
        openInvoices: recent.filter((i) => i.status === "open").map((i) => invoiceView(billing, i)),
        invoices: recent.map((i) => invoiceView(billing, i)),
      });
    },
  );
