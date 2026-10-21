import { APIError } from "@better-auth/core/error";
import { TRUSTWARE_ERROR_CODES as E } from "../error-codes";
import type {
  BillingInterval,
  CustomerType,
  TrustwareInvoice,
  TrustwarePlan,
  TrustwareSubscription,
} from "../types";
import { statusGrantsAccess } from "./access";
import type { Billing } from "./billing";
import { addDays, addInterval } from "./intervals";
import { createInvoice, priceFor, voidOpenInvoices } from "./invoices";
import { prorateCents } from "./money";
import { runHook, subscriptions, type Ctx } from "./store";

export interface CheckoutResult {
  subscription: TrustwareSubscription | null;
  invoice: TrustwareInvoice | null;
}

export const INTERVAL_LABEL: Record<BillingInterval, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

function pickInterval(plan: TrustwarePlan, requested?: BillingInterval): BillingInterval {
  if (requested) {
    if (plan.prices[requested] === undefined) throw APIError.from("BAD_REQUEST", E.PLAN_INTERVAL_NOT_AVAILABLE);
    return requested;
  }
  const preferred: BillingInterval[] = ["month", "year", "week", "day"];
  const found = preferred.find((i) => plan.prices[i] !== undefined);
  if (!found) throw APIError.from("BAD_REQUEST", E.PLAN_INTERVAL_NOT_AVAILABLE);
  return found;
}

/** Start a subscription: free trial, free plan, or the first invoice. */
export async function startSubscription(
  ctx: Ctx,
  billing: Billing,
  args: {
    referenceId: string;
    customerType: CustomerType;
    plan: TrustwarePlan;
    interval?: BillingInterval;
    seats?: number;
  },
): Promise<CheckoutResult> {
  const { referenceId, customerType, plan } = args;
  const interval = pickInterval(plan, args.interval);
  const price = plan.prices[interval] as number;
  const now = billing.now();

  const existing = await subscriptions.forReference(ctx, referenceId);
  for (const sub of existing) {
    const { status } = await billing.resolve(sub);
    if (statusGrantsAccess(status)) throw APIError.from("BAD_REQUEST", E.ALREADY_SUBSCRIBED);
  }
  // A half-finished checkout is replaced, not duplicated.
  for (const sub of existing) {
    if (sub.status === "incomplete") {
      await voidOpenInvoices(ctx, sub.id);
      await subscriptions.update(ctx, sub.id, { status: "incomplete_expired", endedAt: now });
    }
  }

  const trialEligible = !!plan.freeTrial && plan.freeTrial.days > 0 && !existing.some((s) => s.trialStart);
  const base = {
    referenceId,
    customerType,
    plan: plan.name,
    billingInterval: interval,
    cancelAtPeriodEnd: false,
    seats: args.seats ?? null,
  };

  if (trialEligible) {
    const trialEnd = addDays(now, plan.freeTrial!.days);
    const subscription = await subscriptions.create(ctx, {
      ...base,
      status: "trialing",
      periodStart: now,
      periodEnd: trialEnd,
      trialStart: now,
      trialEnd,
    });
    await runHook(ctx, "onTrialStart", () => billing.options.subscription?.onTrialStart?.({ subscription, plan }, ctx));
    return { subscription, invoice: null };
  }

  if (price === 0) {
    const subscription = await subscriptions.create(ctx, {
      ...base,
      status: "active",
      periodStart: now,
      periodEnd: addInterval(now, interval),
    });
    await runHook(ctx, "onSubscriptionComplete", () =>
      billing.options.subscription?.onSubscriptionComplete?.({ subscription, plan }, ctx),
    );
    return { subscription, invoice: null };
  }

  const subscription = await subscriptions.create(ctx, { ...base, status: "incomplete" });
  const invoice = await createInvoice(ctx, billing, {
    referenceId,
    customerType,
    kind: "subscription_create",
    subscriptionId: subscription.id,
    plan: plan.name,
    billingInterval: interval,
    amountCents: price,
    description: `${plan.displayName ?? plan.name} (${INTERVAL_LABEL[interval]})`,
  });
  return { subscription, invoice };
}

/**
 * Move an active subscription to another plan or interval, either now (prorated
 * credit against the new price, fresh period) or at the end of the current period.
 */
export async function changeSubscription(
  ctx: Ctx,
  billing: Billing,
  args: {
    subscription: TrustwareSubscription;
    plan: TrustwarePlan;
    interval?: BillingInterval;
    scheduleAtPeriodEnd?: boolean;
  },
): Promise<CheckoutResult> {
  const { subscription: sub, plan } = args;
  const now = billing.now();
  const resolved = (await billing.resolve(sub)).status;
  if (resolved !== "active" && resolved !== "trialing") {
    throw APIError.from("BAD_REQUEST", E.SUBSCRIPTION_NOT_ACTIVE);
  }
  const interval = pickInterval(plan, args.interval ?? (plan.prices[sub.billingInterval] !== undefined ? sub.billingInterval : undefined));
  if (plan.name === sub.plan && interval === sub.billingInterval) {
    throw APIError.from("BAD_REQUEST", E.NO_CHANGE_REQUESTED);
  }
  const newPrice = plan.prices[interval] as number;

  if (args.scheduleAtPeriodEnd) {
    // Open renewal invoices carry the old price; void them so the next one uses the new plan.
    await voidOpenInvoices(ctx, sub.id, ["subscription_renewal", "plan_change"]);
    const updated = await subscriptions.update(ctx, sub.id, {
      pendingPlan: plan.name,
      pendingInterval: interval,
      cancelAtPeriodEnd: false,
    });
    return { subscription: updated ?? sub, invoice: null };
  }

  if (resolved === "trialing") {
    // Changing plans mid-trial is free; the first invoice at trial end uses the new plan.
    await voidOpenInvoices(ctx, sub.id, ["subscription_renewal", "plan_change"]);
    const updated = await subscriptions.update(ctx, sub.id, {
      plan: plan.name,
      billingInterval: interval,
      pendingPlan: null,
      pendingInterval: null,
    });
    await runHook(ctx, "onSubscriptionUpdate", () =>
      billing.options.subscription?.onSubscriptionUpdate?.({ subscription: updated ?? sub, plan, previousPlan: sub.plan }, ctx),
    );
    return { subscription: updated ?? sub, invoice: null };
  }

  const currentPlan = await billing.getPlan(sub.plan);
  const currentPrice = priceFor(currentPlan, sub.billingInterval) ?? 0;
  const periodStart = sub.periodStart ? new Date(sub.periodStart).getTime() : now.getTime();
  const periodEnd = sub.periodEnd ? new Date(sub.periodEnd).getTime() : now.getTime();
  const credit =
    billing.proration === "prorate" ? prorateCents(currentPrice, periodEnd - now.getTime(), periodEnd - periodStart) : 0;
  const amountCents = Math.max(0, newPrice - credit);

  await voidOpenInvoices(ctx, sub.id, ["subscription_renewal", "plan_change"]);

  if (amountCents === 0) {
    // The credit covers the new plan: switch immediately, no invoice.
    const updated = await subscriptions.update(ctx, sub.id, {
      plan: plan.name,
      billingInterval: interval,
      status: "active",
      periodStart: now,
      periodEnd: addInterval(now, interval),
      pendingPlan: null,
      pendingInterval: null,
      cancelAtPeriodEnd: false,
    });
    await runHook(ctx, "onSubscriptionUpdate", () =>
      billing.options.subscription?.onSubscriptionUpdate?.({ subscription: updated ?? sub, plan, previousPlan: sub.plan }, ctx),
    );
    return { subscription: updated ?? sub, invoice: null };
  }

  const invoice = await createInvoice(ctx, billing, {
    referenceId: sub.referenceId,
    customerType: sub.customerType,
    kind: "plan_change",
    subscriptionId: sub.id,
    plan: plan.name,
    billingInterval: interval,
    amountCents,
    creditCents: credit,
    description: `Change to ${plan.displayName ?? plan.name} (${interval})`,
  });
  return { subscription: sub, invoice };
}

/** Cancel at period end (default) or right away. Non-custodial: nothing is refunded automatically. */
export async function cancelSubscription(
  ctx: Ctx,
  billing: Billing,
  args: { subscription: TrustwareSubscription; immediately?: boolean },
): Promise<TrustwareSubscription> {
  const { subscription: sub } = args;
  const now = billing.now();
  const resolved = (await billing.resolve(sub)).status;
  const plan = await billing.getPlan(sub.plan);

  if (resolved === "incomplete") {
    await voidOpenInvoices(ctx, sub.id);
    const updated = await subscriptions.update(ctx, sub.id, {
      status: "incomplete_expired",
      endedAt: now,
      endedReason: "canceled",
    });
    return updated ?? sub;
  }
  if (resolved !== "active" && resolved !== "trialing" && resolved !== "past_due") {
    throw APIError.from("BAD_REQUEST", E.SUBSCRIPTION_NOT_ACTIVE);
  }

  await voidOpenInvoices(ctx, sub.id);

  if (args.immediately || resolved === "past_due") {
    const updated =
      (await subscriptions.update(ctx, sub.id, {
        status: "canceled",
        cancelAtPeriodEnd: false,
        canceledAt: now,
        endedAt: now,
        endedReason: "canceled",
        pendingPlan: null,
        pendingInterval: null,
      })) ?? sub;
    await runHook(ctx, "onSubscriptionCancel", () => billing.options.subscription?.onSubscriptionCancel?.({ subscription: updated, plan }, ctx));
    await runHook(ctx, "onSubscriptionEnded", () =>
      billing.options.subscription?.onSubscriptionEnded?.({ subscription: updated, plan, reason: "canceled" }, ctx),
    );
    return updated;
  }

  const updated =
    (await subscriptions.update(ctx, sub.id, {
      cancelAtPeriodEnd: true,
      canceledAt: now,
      pendingPlan: null,
      pendingInterval: null,
    })) ?? sub;
  await runHook(ctx, "onSubscriptionCancel", () => billing.options.subscription?.onSubscriptionCancel?.({ subscription: updated, plan }, ctx));
  return updated;
}

/** Undo a pending cancellation or scheduled plan change. */
export async function restoreSubscription(
  ctx: Ctx,
  billing: Billing,
  args: { subscription: TrustwareSubscription },
): Promise<TrustwareSubscription> {
  const { subscription: sub } = args;
  const resolved = (await billing.resolve(sub)).status;
  if (resolved !== "active" && resolved !== "trialing" && resolved !== "past_due") {
    throw APIError.from("BAD_REQUEST", E.SUBSCRIPTION_NOT_ACTIVE);
  }
  if (!sub.cancelAtPeriodEnd && !sub.pendingPlan) {
    throw APIError.from("BAD_REQUEST", E.SUBSCRIPTION_NOT_PENDING_CHANGE);
  }
  const updated = await subscriptions.update(ctx, sub.id, {
    cancelAtPeriodEnd: false,
    canceledAt: null,
    pendingPlan: null,
    pendingInterval: null,
  });
  return updated ?? sub;
}
