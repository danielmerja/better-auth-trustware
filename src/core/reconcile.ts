import type { TrustwareInvoice, TrustwareSubscription } from "../types";
import type { Billing } from "./billing";
import { addDays, addInterval, DAY_MS } from "./intervals";
import { createInvoice, expireInvoice, fulfillInvoice, voidOpenInvoices } from "./invoices";
import { applyCredit, refreshPayment } from "./payments";
import { invoices, payments, runHook, subscriptions, type Ctx } from "./store";

export interface ReconcileReport {
  paymentsPolled: number;
  paymentsCredited: number;
  invoicesRepaired: number;
  invoicesExpired: number;
  renewalsInvoiced: number;
  subscriptionsPastDue: number;
  subscriptionsEnded: number;
  errors: number;
}

/**
 * Trustware has no webhooks, so this is the heartbeat of the plugin. It
 *  1. polls in-flight payments and credits settled ones,
 *  2. repairs invoices whose payment landed but whose effects didn't apply,
 *  3. expires stale invoices,
 *  4. issues renewal invoices ahead of each period end, and
 *  5. moves lapsed subscriptions to past_due and then ended.
 *
 * Every step is idempotent, so it is safe to run from a cron, on demand, and
 * lazily when a customer opens their billing page. Pass `referenceId` to scope
 * it to one account.
 */
export async function reconcile(
  ctx: Ctx,
  billing: Billing,
  scope: { referenceId?: string } = {},
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    paymentsPolled: 0,
    paymentsCredited: 0,
    invoicesRepaired: 0,
    invoicesExpired: 0,
    renewalsInvoiced: 0,
    subscriptionsPastDue: 0,
    subscriptionsEnded: 0,
    errors: 0,
  };
  const guard = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      report.errors += 1;
      ctx.context.logger.error(`[better-auth-trustware] reconcile: ${label} failed`, error);
    }
  };

  // 1. in-flight payments
  for (const payment of await payments.inFlight(ctx, scope.referenceId)) {
    await guard(`poll ${payment.intentId}`, async () => {
      report.paymentsPolled += 1;
      const after = await refreshPayment(ctx, billing, payment);
      if (after.credited && !payment.credited) report.paymentsCredited += 1;
    });
  }

  // 2. repair invoices
  for (const invoice of await invoices.paidUnfulfilled(ctx, scope.referenceId)) {
    await guard(`fulfil ${invoice.id}`, async () => {
      await fulfillInvoice(ctx, billing, invoice.id);
      report.invoicesRepaired += 1;
    });
  }

  // 3. open invoices: recover crashed credits, then expire stale ones
  const now = billing.now();
  for (const invoice of await invoices.open(ctx, scope.referenceId)) {
    await guard(`invoice ${invoice.id}`, async () => {
      const related = await payments.forInvoice(ctx, invoice.id);
      if (related.some((p) => p.credited)) {
        const after = await applyCredit(ctx, billing, invoice.id);
        if (after?.status === "paid") {
          report.invoicesRepaired += 1;
          return;
        }
      }
      const expired = invoice.expiresAt && new Date(invoice.expiresAt).getTime() < now.getTime();
      const inFlight = related.some((p) => p.status === "submitted" || p.status === "bridging");
      if (expired && !inFlight) {
        await expireInvoice(ctx, invoice);
        report.invoicesExpired += 1;
      }
    });
  }

  // 4 + 5. subscriptions
  if (billing.options.subscription?.enabled) {
    for (const sub of await subscriptions.live(ctx, scope.referenceId)) {
      await guard(`subscription ${sub.id}`, () => reconcileSubscription(ctx, billing, sub, report));
    }
  }
  return report;
}

async function reconcileSubscription(
  ctx: Ctx,
  billing: Billing,
  sub: TrustwareSubscription,
  report: ReconcileReport,
): Promise<void> {
  const now = billing.now();
  const resolved = await billing.resolve(sub);
  const plan = await billing.getPlan(sub.plan);
  const hooks = billing.options.subscription;

  if (resolved.status === "canceled") {
    const byCustomer = sub.cancelAtPeriodEnd;
    const periodEnd = sub.periodEnd ? new Date(sub.periodEnd) : now;
    const updated =
      (await subscriptions.update(ctx, sub.id, {
        status: "canceled",
        endedAt: byCustomer ? periodEnd : addDays(periodEnd, billing.graceDays),
        endedReason: byCustomer ? "canceled" : "non_payment",
        pendingPlan: null,
        pendingInterval: null,
      })) ?? sub;
    await voidOpenInvoices(ctx, sub.id);
    report.subscriptionsEnded += 1;
    await runHook(ctx, "onSubscriptionEnded", () =>
      hooks?.onSubscriptionEnded?.({ subscription: updated, plan, reason: byCustomer ? "canceled" : "non_payment" }, ctx),
    );
    return;
  }

  if (sub.cancelAtPeriodEnd) return;

  const renewal = await ensureRenewalInvoice(ctx, billing, sub, report);
  // A free plan just rolled into its next period; the status we resolved above is stale.
  if (renewal.rolledOver) return;

  if (resolved.status === "past_due" && sub.status !== "past_due") {
    const updated = (await subscriptions.update(ctx, sub.id, { status: "past_due" })) ?? sub;
    report.subscriptionsPastDue += 1;
    await runHook(ctx, "onSubscriptionPastDue", () =>
      hooks?.onSubscriptionPastDue?.({ subscription: updated, plan, invoice: renewal.invoice ?? undefined }, ctx),
    );
  }
}

/** Issue the invoice for the next period once we're inside the lead window. At most one stays open per subscription. */
async function ensureRenewalInvoice(
  ctx: Ctx,
  billing: Billing,
  sub: TrustwareSubscription,
  report: ReconcileReport,
): Promise<{ invoice: TrustwareInvoice | null; rolledOver: boolean }> {
  const none = { invoice: null, rolledOver: false };
  if (!sub.periodEnd) return none;
  const now = billing.now();
  const periodEnd = new Date(sub.periodEnd);
  const periodStart = sub.periodStart ? new Date(sub.periodStart) : now;

  const lead = Math.min(billing.leadDays * DAY_MS, Math.max(0, periodEnd.getTime() - periodStart.getTime()) / 2);
  if (now.getTime() < periodEnd.getTime() - lead) return none;

  const open = await invoices.forSubscription(ctx, sub.id, "open");
  const existing = open.find((i) => i.kind === "subscription_renewal");
  if (existing) return { invoice: existing, rolledOver: false };

  const targetName = sub.pendingPlan ?? sub.plan;
  const interval = sub.pendingInterval ?? sub.billingInterval;
  const plan = await billing.getPlan(targetName);
  const price = plan?.prices[interval];
  if (!plan || price === undefined) {
    ctx.context.logger.error(
      `[better-auth-trustware] Cannot renew subscription ${sub.id}: plan "${targetName}" (${interval}) is no longer configured`,
    );
    return none;
  }

  if (price === 0) {
    // Free plans roll over without an invoice. After an outage, catch up to the period containing "now".
    if (now.getTime() < periodEnd.getTime()) return none;
    let start = periodEnd;
    let end = addInterval(start, interval);
    while (end.getTime() <= now.getTime()) {
      start = end;
      end = addInterval(start, interval);
    }
    await subscriptions.update(ctx, sub.id, {
      plan: plan.name,
      billingInterval: interval,
      status: "active",
      periodStart: start,
      periodEnd: end,
      pendingPlan: null,
      pendingInterval: null,
    });
    return { invoice: null, rolledOver: true };
  }

  const nextStart = periodEnd.getTime() > now.getTime() ? periodEnd : now;
  const invoice = await createInvoice(ctx, billing, {
    referenceId: sub.referenceId,
    customerType: sub.customerType,
    kind: "subscription_renewal",
    subscriptionId: sub.id,
    plan: plan.name,
    billingInterval: interval,
    amountCents: price,
    description: `${plan.displayName ?? plan.name} renewal`,
    periodStart: nextStart,
    periodEnd: addInterval(nextStart, interval),
    dueAt: periodEnd,
    expiresAt: addDays(periodEnd, billing.graceDays),
  });
  report.renewalsInvoiced += 1;
  return { invoice, rolledOver: false };
}
