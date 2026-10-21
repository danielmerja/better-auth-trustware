import { addDays } from "./intervals";
import type {
  AccessSummary,
  SubscriptionStatus,
  TrustwareInvoice,
  TrustwarePlan,
  TrustwareProduct,
  TrustwareSubscription,
} from "../types";

export interface ResolvedStatus {
  status: SubscriptionStatus;
  graceEndsAt: Date | null;
}

/**
 * The status a subscription *actually* has right now, derived from its dates.
 * Stored status only changes when `reconcile` runs, but access decisions must
 * not depend on a cron having fired, so everything reads through this.
 */
export function resolveStatus(
  sub: Pick<TrustwareSubscription, "status" | "periodEnd" | "cancelAtPeriodEnd">,
  now: Date,
  graceDays: number,
  opts: { free?: boolean } = {},
): ResolvedStatus {
  const stored = sub.status;
  if (stored === "canceled" || stored === "incomplete" || stored === "incomplete_expired") {
    return { status: stored, graceEndsAt: null };
  }
  // A free plan has nothing to renew, so a late scheduler must never lapse it.
  if (opts.free && stored === "active" && !sub.cancelAtPeriodEnd) return { status: stored, graceEndsAt: null };
  const periodEnd = sub.periodEnd ? new Date(sub.periodEnd) : null;
  if (!periodEnd || now.getTime() <= periodEnd.getTime()) {
    return { status: stored, graceEndsAt: null };
  }
  if (sub.cancelAtPeriodEnd) return { status: "canceled", graceEndsAt: null };
  const graceEndsAt = addDays(periodEnd, graceDays);
  if (now.getTime() <= graceEndsAt.getTime()) return { status: "past_due", graceEndsAt };
  return { status: "canceled", graceEndsAt: null };
}

export function statusGrantsAccess(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

const STATUS_RANK: Record<SubscriptionStatus, number> = {
  active: 4,
  trialing: 3,
  past_due: 2,
  incomplete: 1,
  incomplete_expired: 0,
  canceled: 0,
};

export interface PurchaseGrant {
  productId: string;
  invoiceId: string;
  features: string[];
  expiresAt: Date | null;
}

/** Paid one-time invoices that still unlock something. */
export function activePurchases(
  invoices: TrustwareInvoice[],
  products: TrustwareProduct[],
  now: Date,
): PurchaseGrant[] {
  const grants: PurchaseGrant[] = [];
  for (const invoice of invoices) {
    if (invoice.kind !== "one_time" || invoice.status !== "paid" || !invoice.productId) continue;
    const product = products.find((p) => p.id === invoice.productId);
    if (!product) continue;
    let expiresAt: Date | null = null;
    if (product.accessDays && invoice.paidAt) {
      expiresAt = addDays(new Date(invoice.paidAt), product.accessDays);
      if (expiresAt.getTime() < now.getTime()) continue;
    }
    grants.push({
      productId: product.id,
      invoiceId: invoice.id,
      features: product.features ?? [],
      expiresAt,
    });
  }
  return grants;
}

export function summarizeAccess(args: {
  subscriptions: TrustwareSubscription[];
  plans: TrustwarePlan[];
  invoices: TrustwareInvoice[];
  products: TrustwareProduct[];
  now: Date;
  graceDays: number;
}): AccessSummary {
  const { subscriptions, plans, invoices, products, now, graceDays } = args;

  const resolved = subscriptions
    .map((sub) => ({
      sub,
      ...resolveStatus(sub, now, graceDays, {
        free: plans.find((p) => p.name === sub.plan)?.prices[sub.billingInterval] === 0,
      }),
    }))
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
  const best = resolved[0];
  const entitled = best && statusGrantsAccess(best.status) ? best : undefined;
  const plan = entitled ? plans.find((p) => p.name === entitled.sub.plan) : undefined;
  const purchases = activePurchases(invoices, products, now);

  const features = new Set<string>(plan?.features ?? []);
  for (const purchase of purchases) for (const f of purchase.features) features.add(f);

  const hasAccess = !!entitled || purchases.length > 0;
  const reason: AccessSummary["reason"] = entitled
    ? entitled.status === "past_due"
      ? "grace_period"
      : "subscription"
    : purchases.length > 0
      ? "purchase"
      : "none";

  const shown = entitled ?? best;
  return {
    hasAccess,
    reason,
    status: shown ? shown.status : "none",
    plan: entitled ? entitled.sub.plan : null,
    subscriptionId: entitled ? entitled.sub.id : null,
    features: [...features],
    limits: { ...(plan?.limits ?? {}) },
    periodEnd: shown?.sub.periodEnd ? new Date(shown.sub.periodEnd) : null,
    graceEndsAt: entitled?.graceEndsAt ?? null,
    cancelAtPeriodEnd: shown?.sub.cancelAtPeriodEnd ?? false,
    purchases,
  };
}
