import { mergeSchema } from "better-auth/db";
import type { TrustwareOptions } from "./types";

const now = () => new Date();

export const TRUSTWARE_SCHEMA = {
  trustwareSubscription: {
    fields: {
      referenceId: { type: "string", required: true, index: true },
      customerType: { type: "string", required: true, defaultValue: "user" },
      plan: { type: "string", required: true },
      billingInterval: { type: "string", required: true },
      status: { type: "string", required: true, defaultValue: "incomplete", index: true },
      periodStart: { type: "date", required: false },
      periodEnd: { type: "date", required: false },
      trialStart: { type: "date", required: false },
      trialEnd: { type: "date", required: false },
      cancelAtPeriodEnd: { type: "boolean", required: false, defaultValue: false },
      canceledAt: { type: "date", required: false },
      endedAt: { type: "date", required: false },
      endedReason: { type: "string", required: false },
      pendingPlan: { type: "string", required: false },
      pendingInterval: { type: "string", required: false },
      seats: { type: "number", required: false },
      createdAt: { type: "date", required: true, defaultValue: now },
      updatedAt: { type: "date", required: true, defaultValue: now, onUpdate: now },
    },
  },
  trustwareInvoice: {
    fields: {
      referenceId: { type: "string", required: true, index: true },
      customerType: { type: "string", required: true, defaultValue: "user" },
      subscriptionId: { type: "string", required: false, index: true },
      kind: { type: "string", required: true },
      status: { type: "string", required: true, defaultValue: "open", index: true },
      description: { type: "string", required: false },
      plan: { type: "string", required: false },
      billingInterval: { type: "string", required: false },
      productId: { type: "string", required: false },
      amountCents: { type: "number", required: true },
      creditCents: { type: "number", required: true, defaultValue: 0 },
      currency: { type: "string", required: true, defaultValue: "USD" },
      amountPaidUnits: { type: "string", required: true, defaultValue: "0" },
      periodStart: { type: "date", required: false },
      periodEnd: { type: "date", required: false },
      dueAt: { type: "date", required: false },
      expiresAt: { type: "date", required: false },
      paidAt: { type: "date", required: false },
      fulfilled: { type: "boolean", required: true, defaultValue: false },
      metadata: { type: "string", required: false },
      createdAt: { type: "date", required: true, defaultValue: now },
      updatedAt: { type: "date", required: true, defaultValue: now, onUpdate: now },
    },
  },
  trustwarePayment: {
    fields: {
      invoiceId: { type: "string", required: true, index: true },
      referenceId: { type: "string", required: true, index: true },
      intentId: { type: "string", required: true, unique: true },
      status: { type: "string", required: true, defaultValue: "created", index: true },
      fromChain: { type: "string", required: true },
      fromToken: { type: "string", required: true },
      fromAddress: { type: "string", required: true },
      fromAmount: { type: "string", required: true },
      toChain: { type: "string", required: true },
      toToken: { type: "string", required: true },
      toAddress: { type: "string", required: true },
      expectedUnits: { type: "string", required: true },
      creditedUnits: { type: "string", required: true, defaultValue: "0" },
      credited: { type: "boolean", required: true, defaultValue: false },
      sourceTxHash: { type: "string", required: false },
      destTxHash: { type: "string", required: false },
      provider: { type: "string", required: false },
      errorCode: { type: "string", required: false },
      nextPollAt: { type: "date", required: false },
      lastPolledAt: { type: "date", required: false },
      createdAt: { type: "date", required: true, defaultValue: now },
      updatedAt: { type: "date", required: true, defaultValue: now, onUpdate: now },
    },
  },
} as const;

export function getSchema(options: TrustwareOptions) {
  const base: Record<string, unknown> = { ...TRUSTWARE_SCHEMA };
  // Without subscriptions there is nothing to subscribe to, so keep the table out of migrations.
  if (!options.subscription?.enabled) delete base.trustwareSubscription;
  return mergeSchema(base as any, options.schema as any);
}

/** Internal model keys. Always use these with the adapter, never table names. */
export const MODEL = {
  subscription: "trustwareSubscription",
  invoice: "trustwareInvoice",
  payment: "trustwarePayment",
} as const;
