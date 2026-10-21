import type { GenericEndpointContext, Where } from "better-auth";
import { MODEL } from "../schema";
import type {
  Awaitable,
  TrustwareInvoice,
  TrustwarePayment,
  TrustwareSubscription,
} from "../types";

export type Ctx = GenericEndpointContext;

const eq = (field: string, value: unknown): Where => ({ field, value: value as any });

/** Run a user-supplied callback without letting its failure undo money that already moved. */
export async function runHook(ctx: Ctx, label: string, fn: (() => Awaitable<unknown>) | undefined): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch (error) {
    ctx.context.logger.error(`[better-auth-trustware] ${label} callback threw`, error);
  }
}

// ---------- subscriptions ----------

export const subscriptions = {
  get: (ctx: Ctx, id: string) =>
    ctx.context.adapter.findOne<TrustwareSubscription>({ model: MODEL.subscription, where: [eq("id", id)] }),

  forReference: (ctx: Ctx, referenceId: string) =>
    ctx.context.adapter.findMany<TrustwareSubscription>({
      model: MODEL.subscription,
      where: [eq("referenceId", referenceId)],
      sortBy: { field: "createdAt", direction: "desc" },
    }),

  create: (ctx: Ctx, data: Omit<TrustwareSubscription, "id" | "createdAt" | "updatedAt">) =>
    ctx.context.adapter.create<Record<string, any>, TrustwareSubscription>({
      model: MODEL.subscription,
      data: { ...data, createdAt: new Date(), updatedAt: new Date() },
    }),

  update: (ctx: Ctx, id: string, update: Partial<TrustwareSubscription>) =>
    ctx.context.adapter.update<TrustwareSubscription>({
      model: MODEL.subscription,
      where: [eq("id", id)],
      update: { ...update, updatedAt: new Date() },
    }),

  /** Subscriptions that can still change state on their own (renew, lapse, end). */
  live: (ctx: Ctx, referenceId?: string) =>
    ctx.context.adapter.findMany<TrustwareSubscription>({
      model: MODEL.subscription,
      where: [
        { field: "status", operator: "in", value: ["active", "trialing", "past_due"] },
        ...(referenceId ? [eq("referenceId", referenceId)] : []),
      ],
      limit: 500,
    }),
};

// ---------- invoices ----------

export const invoices = {
  get: (ctx: Ctx, id: string) =>
    ctx.context.adapter.findOne<TrustwareInvoice>({ model: MODEL.invoice, where: [eq("id", id)] }),

  forReference: (ctx: Ctx, referenceId: string, opts: { limit?: number; status?: TrustwareInvoice["status"] } = {}) =>
    ctx.context.adapter.findMany<TrustwareInvoice>({
      model: MODEL.invoice,
      where: [eq("referenceId", referenceId), ...(opts.status ? [eq("status", opts.status)] : [])],
      sortBy: { field: "createdAt", direction: "desc" },
      limit: opts.limit ?? 100,
    }),

  forSubscription: (ctx: Ctx, subscriptionId: string, status?: TrustwareInvoice["status"]) =>
    ctx.context.adapter.findMany<TrustwareInvoice>({
      model: MODEL.invoice,
      where: [eq("subscriptionId", subscriptionId), ...(status ? [eq("status", status)] : [])],
      sortBy: { field: "createdAt", direction: "desc" },
      limit: 200,
    }),

  create: (ctx: Ctx, data: Omit<TrustwareInvoice, "id" | "createdAt" | "updatedAt">) =>
    ctx.context.adapter.create<Record<string, any>, TrustwareInvoice>({
      model: MODEL.invoice,
      data: { ...data, createdAt: new Date(), updatedAt: new Date() },
    }),

  update: (ctx: Ctx, id: string, update: Partial<TrustwareInvoice>) =>
    ctx.context.adapter.update<TrustwareInvoice>({
      model: MODEL.invoice,
      where: [eq("id", id)],
      update: { ...update, updatedAt: new Date() },
    }),

  /**
   * Atomic compare-and-set on status. Returns true only for the single caller
   * whose update matched, which is how concurrent settlers avoid double fulfilment.
   */
  transition: async (
    ctx: Ctx,
    id: string,
    from: TrustwareInvoice["status"][],
    update: Partial<TrustwareInvoice>,
  ) =>
    (await ctx.context.adapter.updateMany({
      model: MODEL.invoice,
      where: [eq("id", id), { field: "status", operator: "in", value: from }],
      update: { ...update, updatedAt: new Date() },
    })) === 1,

  open: (ctx: Ctx, referenceId?: string) =>
    ctx.context.adapter.findMany<TrustwareInvoice>({
      model: MODEL.invoice,
      where: [eq("status", "open"), ...(referenceId ? [eq("referenceId", referenceId)] : [])],
      limit: 500,
    }),

  paidUnfulfilled: (ctx: Ctx, referenceId?: string) =>
    ctx.context.adapter.findMany<TrustwareInvoice>({
      model: MODEL.invoice,
      where: [eq("status", "paid"), eq("fulfilled", false), ...(referenceId ? [eq("referenceId", referenceId)] : [])],
      limit: 500,
    }),
};

// ---------- payments ----------

export const payments = {
  get: (ctx: Ctx, id: string) =>
    ctx.context.adapter.findOne<TrustwarePayment>({ model: MODEL.payment, where: [eq("id", id)] }),

  byIntent: (ctx: Ctx, intentId: string) =>
    ctx.context.adapter.findOne<TrustwarePayment>({ model: MODEL.payment, where: [eq("intentId", intentId)] }),

  byTxHash: (ctx: Ctx, txHash: string) =>
    ctx.context.adapter.findOne<TrustwarePayment>({ model: MODEL.payment, where: [eq("sourceTxHash", txHash)] }),

  forInvoice: (ctx: Ctx, invoiceId: string) =>
    ctx.context.adapter.findMany<TrustwarePayment>({
      model: MODEL.payment,
      where: [eq("invoiceId", invoiceId)],
      sortBy: { field: "createdAt", direction: "asc" },
      limit: 100,
    }),

  create: (ctx: Ctx, data: Omit<TrustwarePayment, "id" | "createdAt" | "updatedAt">) =>
    ctx.context.adapter.create<Record<string, any>, TrustwarePayment>({
      model: MODEL.payment,
      data: { ...data, createdAt: new Date(), updatedAt: new Date() },
    }),

  update: (ctx: Ctx, id: string, update: Partial<TrustwarePayment>) =>
    ctx.context.adapter.update<TrustwarePayment>({
      model: MODEL.payment,
      where: [eq("id", id)],
      update: { ...update, updatedAt: new Date() },
    }),

  /** Claim the right to credit a payment. Exactly one caller gets true. */
  claimCredit: async (ctx: Ctx, id: string, update: Partial<TrustwarePayment>) =>
    (await ctx.context.adapter.updateMany({
      model: MODEL.payment,
      where: [eq("id", id), eq("credited", false)],
      update: { ...update, credited: true, updatedAt: new Date() },
    })) === 1,

  inFlight: (ctx: Ctx, referenceId?: string) =>
    ctx.context.adapter.findMany<TrustwarePayment>({
      model: MODEL.payment,
      where: [
        { field: "status", operator: "in", value: ["submitted", "bridging"] },
        ...(referenceId ? [eq("referenceId", referenceId)] : []),
      ],
      limit: 500,
    }),

  abandonUnsubmitted: (ctx: Ctx, invoiceId: string) =>
    ctx.context.adapter.updateMany({
      model: MODEL.payment,
      where: [eq("invoiceId", invoiceId), eq("status", "created")],
      update: { status: "abandoned", updatedAt: new Date() },
    }),
};
