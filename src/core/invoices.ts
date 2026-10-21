import { MODEL } from "../schema";
import type {
  BillingInterval,
  CustomerType,
  InvoiceKind,
  TrustwareInvoice,
  TrustwarePlan,
  TrustwareSubscription,
} from "../types";
import type { Billing } from "./billing";
import { addInterval } from "./intervals";
import { centsToBaseUnits } from "./money";
import { invoices, payments, runHook, subscriptions, type Ctx } from "./store";

export function requiredUnits(billing: Billing, invoice: Pick<TrustwareInvoice, "amountCents">): bigint {
  return centsToBaseUnits(invoice.amountCents, billing.options.settlement.tokenDecimals);
}

export function paidUnits(invoice: Pick<TrustwareInvoice, "amountPaidUnits">): bigint {
  try {
    return BigInt(invoice.amountPaidUnits || "0");
  } catch {
    return 0n;
  }
}

export function priceFor(plan: TrustwarePlan | undefined, interval: BillingInterval | null | undefined) {
  if (!plan || !interval) return undefined;
  return plan.prices[interval];
}

export interface NewInvoice {
  referenceId: string;
  customerType: CustomerType;
  kind: InvoiceKind;
  subscriptionId?: string;
  plan?: string;
  billingInterval?: BillingInterval;
  productId?: string;
  amountCents: number;
  creditCents?: number;
  description?: string;
  periodStart?: Date;
  periodEnd?: Date;
  dueAt?: Date;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export async function createInvoice(ctx: Ctx, billing: Billing, input: NewInvoice): Promise<TrustwareInvoice> {
  const now = billing.now();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + billing.invoiceExpiryHours * 3_600_000);
  const invoice = await invoices.create(ctx, {
    referenceId: input.referenceId,
    customerType: input.customerType,
    subscriptionId: input.subscriptionId ?? null,
    kind: input.kind,
    status: "open",
    description: input.description ?? null,
    plan: input.plan ?? null,
    billingInterval: input.billingInterval ?? null,
    productId: input.productId ?? null,
    amountCents: input.amountCents,
    creditCents: input.creditCents ?? 0,
    currency: "USD",
    amountPaidUnits: "0",
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    dueAt: input.dueAt ?? expiresAt,
    expiresAt,
    paidAt: null,
    fulfilled: false,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });

  const subscription = input.subscriptionId ? await subscriptions.get(ctx, input.subscriptionId) : null;
  const plan = await billing.getPlan(input.plan ?? subscription?.plan);
  await runHook(ctx, "onInvoiceCreated", () =>
    billing.options.onInvoiceCreated?.(
      { invoice, subscription: subscription ?? undefined, plan },
      ctx,
    ),
  );
  return invoice;
}

/** Void open invoices tied to a subscription, optionally only some kinds. */
export async function voidOpenInvoices(
  ctx: Ctx,
  subscriptionId: string,
  kinds?: InvoiceKind[],
): Promise<number> {
  const open = await invoices.forSubscription(ctx, subscriptionId, "open");
  let voided = 0;
  for (const invoice of open) {
    if (kinds && !kinds.includes(invoice.kind)) continue;
    if (await invoices.transition(ctx, invoice.id, ["open"], { status: "void" })) voided += 1;
  }
  return voided;
}

/** Mark an open invoice expired. A first invoice that expires also ends its still-incomplete subscription. */
export async function expireInvoice(ctx: Ctx, invoice: TrustwareInvoice): Promise<void> {
  if (!(await invoices.transition(ctx, invoice.id, ["open"], { status: "expired" }))) return;
  if (invoice.kind === "subscription_create" && invoice.subscriptionId) {
    const sub = await subscriptions.get(ctx, invoice.subscriptionId);
    if (sub?.status === "incomplete") {
      await subscriptions.update(ctx, sub.id, { status: "incomplete_expired", endedAt: new Date() });
    }
  }
}

interface Applied {
  subscription?: TrustwareSubscription | null;
  event?: "complete" | "renewed" | "updated";
  previousPlan?: string;
}

/**
 * Turn a paid invoice into its effect (activate, extend, switch plan). Idempotent:
 * only the caller that flips `fulfilled` false -> true does the work, and a failure
 * flips it back so the next reconcile retries.
 */
export async function fulfillInvoice(ctx: Ctx, billing: Billing, invoiceId: string): Promise<void> {
  const claimed = await ctx.context.adapter.updateMany({
    model: MODEL.invoice,
    where: [
      { field: "id", value: invoiceId },
      { field: "status", value: "paid" },
      { field: "fulfilled", value: false },
    ],
    update: { fulfilled: true, updatedAt: new Date() },
  });
  if (claimed !== 1) return;

  const invoice = await invoices.get(ctx, invoiceId);
  if (!invoice) return;

  let applied: Applied;
  try {
    applied = await applyInvoice(ctx, billing, invoice);
  } catch (error) {
    await invoices.update(ctx, invoiceId, { fulfilled: false });
    ctx.context.logger.error(`[better-auth-trustware] Failed to fulfil invoice ${invoiceId}; it will be retried`, error);
    throw error;
  }

  const plan = await billing.getPlan(applied.subscription?.plan ?? invoice.plan);
  const product = await billing.getProduct(invoice.productId);
  const sub = billing.options.subscription;

  await runHook(ctx, "onInvoicePaid", async () =>
    billing.options.onInvoicePaid?.(
      {
        invoice,
        payments: await payments.forInvoice(ctx, invoice.id),
        subscription: applied.subscription ?? undefined,
        plan,
        product,
      },
      ctx,
    ),
  );

  if (!applied.subscription) return;
  const data = { subscription: applied.subscription, plan };
  if (applied.event === "complete") {
    await runHook(ctx, "onSubscriptionComplete", () => sub?.onSubscriptionComplete?.({ ...data, invoice }, ctx));
  } else if (applied.event === "renewed") {
    await runHook(ctx, "onSubscriptionRenewed", () => sub?.onSubscriptionRenewed?.({ ...data, invoice }, ctx));
  }
  if (applied.previousPlan && applied.previousPlan !== applied.subscription.plan) {
    await runHook(ctx, "onSubscriptionUpdate", () =>
      sub?.onSubscriptionUpdate?.({ ...data, previousPlan: applied.previousPlan!, invoice }, ctx),
    );
  }
}

async function applyInvoice(ctx: Ctx, billing: Billing, invoice: TrustwareInvoice): Promise<Applied> {
  if (invoice.kind === "one_time" || !invoice.subscriptionId) return {};

  const sub = await subscriptions.get(ctx, invoice.subscriptionId);
  if (!sub) {
    ctx.context.logger.warn(
      `[better-auth-trustware] Invoice ${invoice.id} was paid but subscription ${invoice.subscriptionId} no longer exists`,
    );
    return {};
  }
  if (sub.status === "canceled" && sub.endedReason === "canceled") {
    // The customer ended this subscription on purpose. Their late payment can't revive it.
    ctx.context.logger.error(
      `[better-auth-trustware] Invoice ${invoice.id} was paid after subscription ${sub.id} was canceled by the customer. Refund it manually.`,
    );
    return { subscription: sub };
  }

  const now = billing.now();
  const plan = invoice.plan ?? sub.plan;
  const interval = (invoice.billingInterval ?? sub.billingInterval) as BillingInterval;
  const revived = { endedAt: null, endedReason: null } as const;

  let update: Partial<TrustwareSubscription>;
  let event: Applied["event"];

  switch (invoice.kind) {
    case "subscription_create": {
      update = {
        plan,
        billingInterval: interval,
        status: "active",
        periodStart: now,
        periodEnd: addInterval(now, interval),
        cancelAtPeriodEnd: false,
        ...revived,
      };
      event = "complete";
      break;
    }
    case "subscription_renewal": {
      // Paying early extends from the current end; paying late starts a fresh period now.
      const currentEnd = sub.periodEnd ? new Date(sub.periodEnd) : null;
      const base = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
      update = {
        plan,
        billingInterval: interval,
        status: "active",
        periodStart: base,
        periodEnd: addInterval(base, interval),
        pendingPlan: null,
        pendingInterval: null,
        ...revived,
      };
      event = sub.status === "trialing" ? "complete" : "renewed";
      break;
    }
    case "plan_change": {
      update = {
        plan,
        billingInterval: interval,
        status: "active",
        periodStart: now,
        periodEnd: addInterval(now, interval),
        pendingPlan: null,
        pendingInterval: null,
        cancelAtPeriodEnd: false,
        ...revived,
      };
      event = "updated";
      break;
    }
    default:
      return {};
  }

  const updated = await subscriptions.update(ctx, sub.id, update);
  return { subscription: updated ?? { ...sub, ...update }, event, previousPlan: sub.plan };
}
