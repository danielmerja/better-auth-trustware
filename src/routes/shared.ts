import { APIError } from "@better-auth/core/error";
import * as z from "zod";
import { statusGrantsAccess } from "../core/access";
import type { Billing } from "../core/billing";
import { reconcile } from "../core/reconcile";
import { invoices, subscriptions, type Ctx } from "../core/store";
import { TRUSTWARE_ERROR_CODES as E } from "../error-codes";
import { assertReferenceAccess } from "../middleware";
import type { AuthorizeReferenceAction, TrustwareInvoice, TrustwareSubscription } from "../types";

export const intervalSchema = z.enum(["day", "week", "month", "year"]);
export const customerTypeSchema = z.enum(["user", "organization"]);

/** Refresh an account's billing state before showing it: poll in-flight payments, issue renewals, apply lapses. */
export async function refreshReference(ctx: Ctx, billing: Billing, referenceId: string): Promise<void> {
  if (!billing.lazyReconcile) return;
  try {
    await reconcile(ctx, billing, { referenceId });
  } catch (error) {
    ctx.context.logger.error("[better-auth-trustware] lazy reconcile failed", error);
  }
}

/** Load an invoice and confirm the caller may act on its account. */
export async function loadInvoiceFor(
  ctx: Ctx,
  billing: Billing,
  invoiceId: string,
  action: AuthorizeReferenceAction,
): Promise<TrustwareInvoice> {
  const invoice = await invoices.get(ctx, invoiceId);
  if (!invoice) throw APIError.from("NOT_FOUND", E.INVOICE_NOT_FOUND);
  try {
    await assertReferenceAccess(ctx, billing.options, {
      referenceId: invoice.referenceId,
      customerType: invoice.customerType,
      action,
    });
  } catch (error) {
    // Someone else's invoice looks exactly like one that doesn't exist.
    if (error instanceof APIError) throw APIError.from("NOT_FOUND", E.INVOICE_NOT_FOUND);
    throw error;
  }
  return invoice;
}

/**
 * Pick the subscription an action applies to: the one named by `subscriptionId`
 * (which must belong to the account), otherwise the account's current one.
 */
export async function findSubscription(
  ctx: Ctx,
  billing: Billing,
  args: { referenceId: string; subscriptionId?: string; includeIncomplete?: boolean },
): Promise<TrustwareSubscription> {
  if (args.subscriptionId) {
    const sub = await subscriptions.get(ctx, args.subscriptionId);
    if (!sub || sub.referenceId !== args.referenceId) throw APIError.from("BAD_REQUEST", E.SUBSCRIPTION_NOT_FOUND);
    return sub;
  }
  const all = await subscriptions.forReference(ctx, args.referenceId);
  for (const sub of all) {
    if (statusGrantsAccess((await billing.resolve(sub)).status)) return sub;
  }
  const incomplete = args.includeIncomplete ? all.find((s) => s.status === "incomplete") : undefined;
  if (!incomplete) throw APIError.from("BAD_REQUEST", E.SUBSCRIPTION_NOT_FOUND);
  return incomplete;
}
