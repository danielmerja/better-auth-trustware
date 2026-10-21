import { resolveStatus } from "../core/access";
import type { Billing } from "../core/billing";
import { paidUnits, requiredUnits } from "../core/invoices";
import type {
  SubscriptionStatus,
  TrustwareInvoice,
  TrustwarePayment,
  TrustwarePlan,
  TrustwareSubscription,
} from "../types";

export function paymentView(payment: TrustwarePayment) {
  return {
    id: payment.id,
    invoiceId: payment.invoiceId,
    intentId: payment.intentId,
    status: payment.status,
    fromChain: payment.fromChain,
    fromToken: payment.fromToken,
    fromAddress: payment.fromAddress,
    fromAmount: payment.fromAmount,
    expectedUnits: payment.expectedUnits,
    creditedUnits: payment.creditedUnits,
    sourceTxHash: payment.sourceTxHash ?? null,
    destTxHash: payment.destTxHash ?? null,
    errorCode: payment.errorCode ?? null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

export function invoiceView(billing: Billing, invoice: TrustwareInvoice, payments?: TrustwarePayment[]) {
  const required = requiredUnits(billing, invoice);
  const paid = paidUnits(invoice);
  const remaining = invoice.status === "open" && required > paid ? required - paid : 0n;
  const s = billing.options.settlement;
  let metadata: unknown = null;
  if (invoice.metadata) {
    try {
      metadata = JSON.parse(invoice.metadata);
    } catch {
      metadata = null;
    }
  }
  return {
    id: invoice.id,
    referenceId: invoice.referenceId,
    customerType: invoice.customerType,
    subscriptionId: invoice.subscriptionId ?? null,
    kind: invoice.kind,
    status: invoice.status,
    description: invoice.description ?? null,
    plan: invoice.plan ?? null,
    billingInterval: invoice.billingInterval ?? null,
    productId: invoice.productId ?? null,
    amountCents: invoice.amountCents,
    creditCents: invoice.creditCents,
    currency: invoice.currency,
    amountDueUnits: required.toString(),
    amountPaidUnits: paid.toString(),
    remainingUnits: remaining.toString(),
    settlement: {
      chainId: s.chainId,
      tokenAddress: s.tokenAddress,
      tokenSymbol: s.tokenSymbol ?? null,
      tokenDecimals: s.tokenDecimals,
      address: s.address,
    },
    periodStart: invoice.periodStart ?? null,
    periodEnd: invoice.periodEnd ?? null,
    dueAt: invoice.dueAt ?? null,
    expiresAt: invoice.expiresAt ?? null,
    paidAt: invoice.paidAt ?? null,
    createdAt: invoice.createdAt,
    checkoutUrl: invoice.status === "open" ? (billing.options.checkoutUrl?.(invoice) ?? null) : null,
    metadata,
    ...(payments ? { payments: payments.map(paymentView) } : {}),
  };
}

export function subscriptionView(billing: Billing, sub: TrustwareSubscription, plan?: TrustwarePlan) {
  const resolved = resolveStatus(sub, billing.now(), billing.graceDays, {
    free: plan?.prices[sub.billingInterval] === 0,
  });
  return {
    id: sub.id,
    referenceId: sub.referenceId,
    customerType: sub.customerType,
    plan: sub.plan,
    billingInterval: sub.billingInterval,
    status: resolved.status as SubscriptionStatus,
    storedStatus: sub.status,
    periodStart: sub.periodStart ?? null,
    periodEnd: sub.periodEnd ?? null,
    trialStart: sub.trialStart ?? null,
    trialEnd: sub.trialEnd ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: sub.canceledAt ?? null,
    endedAt: sub.endedAt ?? null,
    endedReason: sub.endedReason ?? null,
    pendingPlan: sub.pendingPlan ?? null,
    pendingInterval: sub.pendingInterval ?? null,
    seats: sub.seats ?? null,
    graceEndsAt: resolved.graceEndsAt,
    limits: plan?.limits ?? {},
    features: plan?.features ?? [],
    createdAt: sub.createdAt,
  };
}
