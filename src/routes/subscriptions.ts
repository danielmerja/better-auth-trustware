import { createAuthEndpoint } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import * as z from "zod";
import type { Billing } from "../core/billing";
import { createInvoice } from "../core/invoices";
import {
  cancelSubscription,
  changeSubscription,
  restoreSubscription,
  startSubscription,
} from "../core/subscriptions";
import { subscriptions } from "../core/store";
import { TRUSTWARE_ERROR_CODES as E } from "../error-codes";
import { referenceMiddleware, trustwareSessionMiddleware } from "../middleware";
import { customerTypeSchema, findSubscription, intervalSchema, refreshReference } from "./shared";
import { invoiceView, subscriptionView } from "./views";

const referenceFields = {
  referenceId: z.string().optional(),
  customerType: customerTypeSchema.optional(),
};

export const checkout = (billing: Billing) => {
  const { options } = billing;
  return createAuthEndpoint(
    "/trustware/checkout",
    {
      method: "POST",
      body: z
        .object({
          plan: z.string().optional(),
          interval: intervalSchema.optional(),
          productId: z.string().optional(),
          seats: z.number().int().positive().optional(),
          metadata: z.record(z.string(), z.any()).optional(),
          ...referenceFields,
        })
        .refine((b) => Boolean(b.plan) !== Boolean(b.productId), {
          message: "Provide exactly one of `plan` or `productId`",
        }),
      metadata: { openapi: { operationId: "trustwareCheckout" } },
      use: [trustwareSessionMiddleware, referenceMiddleware(options, "create-checkout")],
    },
    async (ctx) => {
      const { user } = ctx.context.session;
      const { referenceId, customerType } = ctx.context;
      await refreshReference(ctx, billing, referenceId);

      if (ctx.body.plan) {
        if (!options.subscription?.enabled) throw APIError.from("BAD_REQUEST", E.SUBSCRIPTIONS_NOT_ENABLED);
        if (options.subscription.requireEmailVerification && !user.emailVerified) {
          throw APIError.from("BAD_REQUEST", E.EMAIL_VERIFICATION_REQUIRED);
        }
        const plan = await billing.getPlan(ctx.body.plan);
        if (!plan) throw APIError.from("BAD_REQUEST", E.PLAN_NOT_FOUND);

        const result = await startSubscription(ctx, billing, {
          referenceId,
          customerType,
          plan,
          interval: ctx.body.interval,
          seats: ctx.body.seats,
        });
        const invoice = result.invoice ? invoiceView(billing, result.invoice) : null;
        return ctx.json({
          subscription: result.subscription ? subscriptionView(billing, result.subscription, plan) : null,
          invoice,
          checkoutUrl: invoice?.checkoutUrl ?? null,
        });
      }

      const product = await billing.getProduct(ctx.body.productId);
      if (!product) throw APIError.from("BAD_REQUEST", E.PRODUCT_NOT_FOUND);
      const invoice = await createInvoice(ctx, billing, {
        referenceId,
        customerType,
        kind: "one_time",
        productId: product.id,
        amountCents: product.amountCents,
        description: product.name,
        metadata: ctx.body.metadata,
      });
      const view = invoiceView(billing, invoice);
      return ctx.json({ subscription: null, invoice: view, checkoutUrl: view.checkoutUrl });
    },
  );
};

export const changeSubscriptionEndpoint = (billing: Billing) => {
  const { options } = billing;
  return createAuthEndpoint(
    "/trustware/subscription/change",
    {
      method: "POST",
      body: z.object({
        plan: z.string(),
        interval: intervalSchema.optional(),
        subscriptionId: z.string().optional(),
        /** Switch at the end of the current period instead of now. */
        scheduleAtPeriodEnd: z.boolean().optional(),
        ...referenceFields,
      }),
      metadata: { openapi: { operationId: "trustwareChangeSubscription" } },
      use: [trustwareSessionMiddleware, referenceMiddleware(options, "change-subscription")],
    },
    async (ctx) => {
      if (!options.subscription?.enabled) throw APIError.from("BAD_REQUEST", E.SUBSCRIPTIONS_NOT_ENABLED);
      const { referenceId } = ctx.context;
      await refreshReference(ctx, billing, referenceId);

      const plan = await billing.getPlan(ctx.body.plan);
      if (!plan) throw APIError.from("BAD_REQUEST", E.PLAN_NOT_FOUND);
      const sub = await findSubscription(ctx, billing, { referenceId, subscriptionId: ctx.body.subscriptionId });

      const result = await changeSubscription(ctx, billing, {
        subscription: sub,
        plan,
        interval: ctx.body.interval,
        scheduleAtPeriodEnd: ctx.body.scheduleAtPeriodEnd,
      });
      const invoice = result.invoice ? invoiceView(billing, result.invoice) : null;
      const current = result.subscription ?? sub;
      return ctx.json({
        subscription: subscriptionView(billing, current, await billing.getPlan(current.plan)),
        invoice,
        checkoutUrl: invoice?.checkoutUrl ?? null,
      });
    },
  );
};

export const cancelSubscriptionEndpoint = (billing: Billing) => {
  const { options } = billing;
  return createAuthEndpoint(
    "/trustware/subscription/cancel",
    {
      method: "POST",
      body: z.object({
        subscriptionId: z.string().optional(),
        /** End access now instead of at the end of the paid period. Nothing is refunded. */
        immediately: z.boolean().optional(),
        ...referenceFields,
      }),
      metadata: { openapi: { operationId: "trustwareCancelSubscription" } },
      use: [trustwareSessionMiddleware, referenceMiddleware(options, "cancel-subscription")],
    },
    async (ctx) => {
      if (!options.subscription?.enabled) throw APIError.from("BAD_REQUEST", E.SUBSCRIPTIONS_NOT_ENABLED);
      const { referenceId } = ctx.context;
      await refreshReference(ctx, billing, referenceId);
      const sub = await findSubscription(ctx, billing, {
        referenceId,
        subscriptionId: ctx.body.subscriptionId,
        includeIncomplete: true,
      });
      const updated = await cancelSubscription(ctx, billing, { subscription: sub, immediately: ctx.body.immediately });
      return ctx.json({ subscription: subscriptionView(billing, updated, await billing.getPlan(updated.plan)) });
    },
  );
};

export const restoreSubscriptionEndpoint = (billing: Billing) => {
  const { options } = billing;
  return createAuthEndpoint(
    "/trustware/subscription/restore",
    {
      method: "POST",
      body: z.object({ subscriptionId: z.string().optional(), ...referenceFields }),
      metadata: { openapi: { operationId: "trustwareRestoreSubscription" } },
      use: [trustwareSessionMiddleware, referenceMiddleware(options, "restore-subscription")],
    },
    async (ctx) => {
      if (!options.subscription?.enabled) throw APIError.from("BAD_REQUEST", E.SUBSCRIPTIONS_NOT_ENABLED);
      const { referenceId } = ctx.context;
      await refreshReference(ctx, billing, referenceId);
      const sub = await findSubscription(ctx, billing, { referenceId, subscriptionId: ctx.body.subscriptionId });
      const updated = await restoreSubscription(ctx, billing, { subscription: sub });
      return ctx.json({ subscription: subscriptionView(billing, updated, await billing.getPlan(updated.plan)) });
    },
  );
};

export const listSubscriptions = (billing: Billing) => {
  const { options } = billing;
  return createAuthEndpoint(
    "/trustware/subscription/list",
    {
      method: "GET",
      query: z
        .object({
          referenceId: z.string().optional(),
          customerType: customerTypeSchema.optional(),
          /** Include canceled and expired subscriptions. */
          includeEnded: z.coerce.boolean().optional(),
        })
        .optional(),
      metadata: { openapi: { operationId: "trustwareListSubscriptions" } },
      use: [trustwareSessionMiddleware, referenceMiddleware(options, "list-subscription")],
    },
    async (ctx) => {
      const { referenceId } = ctx.context;
      await refreshReference(ctx, billing, referenceId);
      const plans = await billing.getPlans();
      const rows = await subscriptions.forReference(ctx, referenceId);
      const views = rows
        .map((sub) => subscriptionView(billing, sub, plans.find((p) => p.name === sub.plan)))
        .filter((v) => ctx.query?.includeEnded || (v.status !== "canceled" && v.status !== "incomplete_expired"));
      return ctx.json(views);
    },
  );
};
