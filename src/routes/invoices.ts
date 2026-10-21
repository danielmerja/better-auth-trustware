import { createAuthEndpoint } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import * as z from "zod";
import type { Billing } from "../core/billing";
import { preparePayment, refreshPayment, submitReceipt } from "../core/payments";
import { invoices, payments } from "../core/store";
import { TRUSTWARE_ERROR_CODES as E } from "../error-codes";
import { referenceMiddleware, trustwareSessionMiddleware } from "../middleware";
import { customerTypeSchema, loadInvoiceFor, refreshReference } from "./shared";
import { invoiceView, paymentView } from "./views";

export const listInvoices = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/invoice/list",
    {
      method: "GET",
      query: z
        .object({
          referenceId: z.string().optional(),
          customerType: customerTypeSchema.optional(),
          status: z.enum(["open", "paid", "expired", "void"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .optional(),
      metadata: { openapi: { operationId: "trustwareListInvoices" } },
      use: [trustwareSessionMiddleware, referenceMiddleware(billing.options, "view-billing")],
    },
    async (ctx) => {
      const { referenceId } = ctx.context;
      await refreshReference(ctx, billing, referenceId);
      const rows = await invoices.forReference(ctx, referenceId, {
        status: ctx.query?.status,
        limit: ctx.query?.limit,
      });
      return ctx.json(rows.map((invoice) => invoiceView(billing, invoice)));
    },
  );

export const getInvoice = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/invoice/get",
    {
      method: "GET",
      query: z.object({ id: z.string() }),
      metadata: { openapi: { operationId: "trustwareGetInvoice" } },
      use: [trustwareSessionMiddleware],
    },
    async (ctx) => {
      const invoice = await loadInvoiceFor(ctx, billing, ctx.query.id, "view-billing");
      return ctx.json(invoiceView(billing, invoice, await payments.forInvoice(ctx, invoice.id)));
    },
  );

/**
 * Create a Trustware route that pays an invoice. The response carries the
 * transaction (and any token approvals) the payer's wallet must sign.
 */
export const payInvoice = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/invoice/pay",
    {
      method: "POST",
      body: z.object({
        invoiceId: z.string(),
        /** Trustware chain id the payer is sending from. */
        fromChain: z.string().min(1).max(64),
        /** Token contract, mint or native denom on that chain. */
        fromToken: z.string().min(1).max(128),
        fromAddress: z.string().min(1).max(128),
      }),
      metadata: { openapi: { operationId: "trustwarePayInvoice" } },
      use: [trustwareSessionMiddleware],
    },
    async (ctx) => {
      const invoice = await loadInvoiceFor(ctx, billing, ctx.body.invoiceId, "pay-invoice");
      const { payment, route } = await preparePayment(ctx, billing, {
        invoice,
        fromChain: ctx.body.fromChain,
        fromToken: ctx.body.fromToken,
        fromAddress: ctx.body.fromAddress,
      });
      return ctx.json({
        paymentId: payment.id,
        intentId: payment.intentId,
        invoice: invoiceView(billing, invoice),
        transaction: route.execution.transaction,
        approvals: route.execution.approvals ?? [],
        estimate: route.estimate,
        provider: route.provider ?? null,
      });
    },
  );

/** Tell Trustware the payer broadcast the transaction so it starts tracking settlement. */
export const submitPaymentReceipt = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/payment/receipt",
    {
      method: "POST",
      body: z.object({ paymentId: z.string(), txHash: z.string().min(1).max(200) }),
      metadata: { openapi: { operationId: "trustwareSubmitReceipt" } },
      use: [trustwareSessionMiddleware],
    },
    async (ctx) => {
      const payment = await payments.get(ctx, ctx.body.paymentId);
      if (!payment) throw APIError.from("NOT_FOUND", E.PAYMENT_NOT_FOUND);
      const invoice = await loadInvoiceFor(ctx, billing, payment.invoiceId, "pay-invoice");
      const submitted = await submitReceipt(ctx, billing, { payment, txHash: ctx.body.txHash });
      const settled = await refreshPayment(ctx, billing, submitted);
      const fresh = (await invoices.get(ctx, invoice.id)) ?? invoice;
      return ctx.json({ payment: paymentView(settled), invoice: invoiceView(billing, fresh) });
    },
  );

/**
 * Poll an invoice. Asks Trustware about any in-flight payment (respecting its
 * suggested poll time), credits settled ones, and returns the current state.
 */
export const getInvoiceStatus = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/invoice/status",
    {
      method: "GET",
      query: z.object({ id: z.string() }),
      metadata: { openapi: { operationId: "trustwareInvoiceStatus" } },
      use: [trustwareSessionMiddleware],
    },
    async (ctx) => {
      const invoice = await loadInvoiceFor(ctx, billing, ctx.query.id, "view-billing");
      for (const payment of await payments.forInvoice(ctx, invoice.id)) {
        if (payment.status === "submitted" || payment.status === "bridging") {
          await refreshPayment(ctx, billing, payment);
        }
      }
      const fresh = (await invoices.get(ctx, invoice.id)) ?? invoice;
      const list = await payments.forInvoice(ctx, invoice.id);
      return ctx.json(invoiceView(billing, fresh, list));
    },
  );
