import { APIError } from "@better-auth/core/error";
import { TRUSTWARE_ERROR_CODES as E } from "../error-codes";
import { TrustwareApiError } from "../trustware/api";
import type { TrustwareRouteResult, TrustwareStatus } from "../trustware/types";
import type { TrustwareInvoice, TrustwarePayment } from "../types";
import { type Billing, sameAddress } from "./billing";
import { expireInvoice, fulfillInvoice, paidUnits, requiredUnits } from "./invoices";
import { estimateFromAmount, mulDivCeil, parseBaseUnits, requiredAfterTolerance } from "./money";
import { invoices, payments, runHook, type Ctx } from "./store";

const MAX_QUOTE_ATTEMPTS = 4;
/** Safety margin applied while sizing so rounding and price drift don't leave the invoice a few units short. */
const SIZING_MARGIN_BPS = 30n;
/** Never accept a sized quote that overshoots what's owed by more than this (when a tighter fit is reachable). */
const MAX_OVERSHOOT_BPS = 100n;
/** How soon to poll again when Trustware doesn't suggest a time. */
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const TX_HASH = /^(0x)?[0-9A-Za-z]{32,128}$/;

/** Translate a Trustware failure into an API error that is safe to show to a customer. */
export function mapTrustwareError(ctx: Ctx, error: unknown): never {
  if (error instanceof APIError) throw error;
  if (error instanceof TrustwareApiError) {
    ctx.context.logger.warn(
      `[better-auth-trustware] Trustware ${error.status}${error.code ? ` ${error.code}` : ""} (request ${error.details.requestId ?? "n/a"}): ${error.message}`,
    );
    const declines = new Set((error.details.providers ?? []).map((p) => p.code).filter(Boolean));
    if (declines.has("amount_too_low") || declines.has("insufficient_liquidity")) {
      throw APIError.from("BAD_REQUEST", E.AMOUNT_TOO_LOW_FOR_ROUTE);
    }
    if (error.code === "no_route_available") throw APIError.from("BAD_REQUEST", E.NO_ROUTE_AVAILABLE);
    if (error.transient) throw APIError.from("SERVICE_UNAVAILABLE", E.PAYMENT_PROVIDER_UNAVAILABLE);
    // Screening failures and other 4xx are deliberately opaque to the customer.
    throw APIError.from("BAD_REQUEST", E.PAYMENT_QUOTE_FAILED);
  }
  throw error;
}

export interface PreparedPayment {
  payment: TrustwarePayment;
  route: TrustwareRouteResult["route"];
}

/**
 * Create a Trustware route that pays (part of) an invoice.
 *
 * The destination chain, token and wallet always come from server config. The
 * caller only chooses where the money comes from, so a tampered request can't
 * redirect funds, and a route is only accepted if its guaranteed minimum covers
 * what is still owed.
 */
export async function preparePayment(
  ctx: Ctx,
  billing: Billing,
  args: { invoice: TrustwareInvoice; fromChain: string; fromToken: string; fromAddress: string },
): Promise<PreparedPayment> {
  const { settlement } = billing.options;
  const { invoice } = args;
  const now = billing.now();

  if (invoice.status !== "open") throw APIError.from("BAD_REQUEST", E.INVOICE_NOT_PAYABLE);
  if (invoice.expiresAt && new Date(invoice.expiresAt).getTime() <= now.getTime()) {
    await expireInvoice(ctx, invoice);
    throw APIError.from("BAD_REQUEST", E.INVOICE_NOT_PAYABLE);
  }
  const remaining = requiredUnits(billing, invoice) - paidUnits(invoice);
  if (remaining <= 0n) throw APIError.from("BAD_REQUEST", E.INVOICE_NOT_PAYABLE);

  let token;
  try {
    token = await billing.getToken(args.fromChain, args.fromToken);
  } catch (error) {
    mapTrustwareError(ctx, error);
  }
  if (!token || !token.usdPrice) throw APIError.from("BAD_REQUEST", E.SOURCE_TOKEN_NOT_SUPPORTED);

  const base = {
    fromChain: args.fromChain,
    fromToken: token.address,
    fromAddress: args.fromAddress,
    toChain: settlement.chainId,
    toToken: settlement.tokenAddress,
    toAddress: settlement.address,
    slippage: billing.slippage,
  };

  let fromAmount = estimateFromAmount({
    requiredUsd: Number(remaining) / 10 ** settlement.tokenDecimals,
    usdPrice: token.usdPrice,
    decimals: token.decimals,
    bufferBps: Math.round(billing.slippage * 100) + 150,
  });
  if (fromAmount <= 0n) fromAmount = 1n;

  try {
    fromAmount = await sizeSourceAmount(billing, base, fromAmount, remaining);

    const routed = await billing.api.route({
      ...base,
      fromAmount: fromAmount.toString(),
      fromAmountUSD: (Number(remaining) / 10 ** settlement.tokenDecimals).toFixed(2),
      metadata: { invoiceId: invoice.id, referenceId: invoice.referenceId, integration: "better-auth-trustware" },
    });

    const guaranteed = parseBaseUnits(routed.route.estimate.toAmountMin);
    if (guaranteed === undefined || guaranteed < remaining) {
      throw APIError.from("BAD_REQUEST", E.AMOUNT_TOO_LOW_FOR_ROUTE);
    }

    await payments.abandonUnsubmitted(ctx, invoice.id);
    const payment = await payments.create(ctx, {
      invoiceId: invoice.id,
      referenceId: invoice.referenceId,
      intentId: routed.intentId,
      status: "created",
      fromChain: base.fromChain,
      fromToken: base.fromToken,
      fromAddress: base.fromAddress,
      fromAmount: fromAmount.toString(),
      toChain: base.toChain,
      toToken: base.toToken,
      toAddress: base.toAddress,
      expectedUnits: guaranteed.toString(),
      creditedUnits: "0",
      credited: false,
      sourceTxHash: null,
      destTxHash: null,
      provider: routed.route.provider ?? null,
      errorCode: null,
      nextPollAt: null,
      lastPolledAt: null,
    });
    return { payment, route: routed.route };
  } catch (error) {
    return mapTrustwareError(ctx, error);
  }
}

/**
 * Trustware quotes from a source amount, but an invoice is a fixed destination
 * amount. Start from the token's USD price, then correct using the quoted
 * `toAmountMin` until it covers what's owed without a big overshoot.
 */
async function sizeSourceAmount(
  billing: Billing,
  base: { fromChain: string; fromToken: string; fromAddress: string; toChain: string; toToken: string; toAddress: string; slippage: number },
  initial: bigint,
  remaining: bigint,
): Promise<bigint> {
  let fromAmount = initial;
  let covered: bigint | undefined;

  for (let attempt = 0; attempt < MAX_QUOTE_ATTEMPTS; attempt += 1) {
    const quote = await billing.api.quote({ ...base, fromAmount: fromAmount.toString() });
    const min = parseBaseUnits(quote.estimate.toAmountMin) ?? 0n;

    if (min >= remaining) {
      covered = fromAmount;
      if (min * 10_000n <= remaining * (10_000n + MAX_OVERSHOOT_BPS)) return fromAmount;
      // Covers the invoice but overshoots; trim once toward the target.
    }
    if (min === 0n) {
      fromAmount *= 2n;
      continue;
    }
    fromAmount = mulDivCeil(fromAmount, remaining * (10_000n + SIZING_MARGIN_BPS), min * 10_000n);
  }
  if (covered !== undefined) return covered;
  throw APIError.from("BAD_REQUEST", E.AMOUNT_TOO_LOW_FOR_ROUTE);
}

/** Tell Trustware the payer broadcast the transaction, and start tracking it. */
export async function submitReceipt(
  ctx: Ctx,
  billing: Billing,
  args: { payment: TrustwarePayment; txHash: string },
): Promise<TrustwarePayment> {
  const { payment } = args;
  const txHash = args.txHash.trim();
  if (!TX_HASH.test(txHash)) throw APIError.from("BAD_REQUEST", E.INVALID_TRANSACTION_HASH);

  if (payment.sourceTxHash) {
    if (payment.sourceTxHash === txHash) return payment;
    throw APIError.from("BAD_REQUEST", E.PAYMENT_ALREADY_SUBMITTED);
  }
  if (payment.status !== "created" && payment.status !== "abandoned") {
    throw APIError.from("BAD_REQUEST", E.PAYMENT_ALREADY_SUBMITTED);
  }
  // One transaction can only ever pay one payment.
  const existing = await payments.byTxHash(ctx, txHash);
  if (existing && existing.id !== payment.id) throw APIError.from("BAD_REQUEST", E.PAYMENT_ALREADY_SUBMITTED);

  try {
    await billing.api.receipt(payment.intentId, txHash);
  } catch (error) {
    mapTrustwareError(ctx, error);
  }
  const updated = await payments.update(ctx, payment.id, {
    status: "submitted",
    sourceTxHash: txHash,
    nextPollAt: null,
  });
  return updated ?? { ...payment, status: "submitted", sourceTxHash: txHash };
}

const TERMINAL: TrustwarePayment["status"][] = ["success", "failed", "abandoned"];

/**
 * Ask Trustware where a payment stands and, on success, credit the invoice.
 * Transient Trustware outages leave the payment untouched so the next poll retries.
 */
export async function refreshPayment(
  ctx: Ctx,
  billing: Billing,
  payment: TrustwarePayment,
  opts: { force?: boolean } = {},
): Promise<TrustwarePayment> {
  if (payment.credited || TERMINAL.includes(payment.status) || payment.status === "created") return payment;
  const now = billing.now();
  if (!opts.force && payment.nextPollAt && new Date(payment.nextPollAt).getTime() > now.getTime()) return payment;

  let status: TrustwareStatus;
  try {
    status = await billing.api.status(payment.intentId);
  } catch (error) {
    if (error instanceof TrustwareApiError && error.status === 404) {
      // Per Trustware's docs a 404 is terminal: the intent doesn't exist.
      return failPayment(ctx, billing, payment, "intent_not_found");
    }
    ctx.context.logger.warn(
      `[better-auth-trustware] Could not poll intent ${payment.intentId}: ${error instanceof Error ? error.message : error}`,
    );
    return payment;
  }

  const base = {
    lastPolledAt: now,
    nextPollAt: status.nextPollAt ?? new Date(now.getTime() + DEFAULT_POLL_INTERVAL_MS),
    sourceTxHash: status.sourceTxHash ?? payment.sourceTxHash ?? null,
    destTxHash: status.destTxHash ?? payment.destTxHash ?? null,
    provider: status.provider ?? payment.provider ?? null,
  };

  switch (status.status) {
    case "pending":
    case "submitted":
      return (await payments.update(ctx, payment.id, { ...base, status: "submitted" })) ?? payment;
    case "bridging":
      return (await payments.update(ctx, payment.id, { ...base, status: "bridging" })) ?? payment;
    case "failed":
      return failPayment(ctx, billing, { ...payment, ...base }, "trustware_failed");
    case "success":
      return settleSuccess(ctx, billing, { ...payment, ...base }, status);
  }
}

async function failPayment(
  ctx: Ctx,
  billing: Billing,
  payment: TrustwarePayment,
  errorCode: string,
): Promise<TrustwarePayment> {
  const updated =
    (await payments.update(ctx, payment.id, {
      status: "failed",
      errorCode,
      sourceTxHash: payment.sourceTxHash,
      destTxHash: payment.destTxHash,
      lastPolledAt: payment.lastPolledAt,
      nextPollAt: null,
    })) ?? { ...payment, status: "failed" as const, errorCode };
  const invoice = await invoices.get(ctx, payment.invoiceId);
  if (invoice) await runHook(ctx, "onPaymentFailed", () => billing.options.onPaymentFailed?.({ invoice, payment: updated }, ctx));
  return updated;
}

/** True when Trustware's report doesn't match the destination we asked for. */
function destinationMismatch(payment: TrustwarePayment, status: TrustwareStatus): string | undefined {
  if (status.toAddress && !sameAddress(status.toAddress, payment.toAddress)) return "toAddress";
  if (status.toChainId && status.toChainId !== payment.toChain) return "toChain";
  const metaInvoice = status.metadata?.invoiceId;
  if (metaInvoice !== undefined && String(metaInvoice) !== payment.invoiceId) return "invoiceId";
  return undefined;
}

async function settleSuccess(
  ctx: Ctx,
  billing: Billing,
  payment: TrustwarePayment,
  status: TrustwareStatus,
): Promise<TrustwarePayment> {
  const invoice = await invoices.get(ctx, payment.invoiceId);
  if (!invoice) return failPayment(ctx, billing, payment, "invoice_missing");

  const mismatch = destinationMismatch(payment, status);
  if (mismatch) {
    ctx.context.logger.error(
      `[better-auth-trustware] Refusing to credit intent ${payment.intentId}: ${mismatch} in Trustware's report does not match what we requested`,
    );
    return failPayment(ctx, billing, payment, "destination_mismatch");
  }

  let credited = status.toAmount ?? BigInt(payment.expectedUnits);

  const verify = billing.options.verifyPayment;
  if (verify) {
    const verdict = await verify({ invoice, payment, status }, ctx);
    if (verdict === false) return failPayment(ctx, billing, payment, "verification_failed");
    if (typeof verdict === "object") credited = verdict.creditedUnits;
  } else if (status.landedAmountVerified === false) {
    // Trustware says success but hasn't confirmed what arrived. Wait rather than guess.
    return (
      (await payments.update(ctx, payment.id, {
        status: "bridging",
        errorCode: "landing_unverified",
        lastPolledAt: payment.lastPolledAt,
        nextPollAt: new Date(billing.now().getTime() + 60_000),
      })) ?? payment
    );
  }
  if (credited <= 0n) return failPayment(ctx, billing, payment, "zero_amount");

  const won = await payments.claimCredit(ctx, payment.id, {
    status: "success",
    creditedUnits: credited.toString(),
    sourceTxHash: payment.sourceTxHash,
    destTxHash: payment.destTxHash,
    provider: payment.provider,
    lastPolledAt: payment.lastPolledAt,
    nextPollAt: null,
    errorCode: null,
  });
  const latest = (await payments.get(ctx, payment.id)) ?? payment;
  if (won) await applyCredit(ctx, billing, invoice.id, latest);
  return latest;
}

/**
 * Recompute what an invoice has received from its credited payments and, once
 * it's covered, flip it to paid exactly once and fulfil it. Safe to call repeatedly.
 */
export async function applyCredit(
  ctx: Ctx,
  billing: Billing,
  invoiceId: string,
  trigger?: TrustwarePayment,
): Promise<TrustwareInvoice | null> {
  const invoice = await invoices.get(ctx, invoiceId);
  if (!invoice) return null;

  const all = await payments.forInvoice(ctx, invoiceId);
  const received = all.filter((p) => p.credited).reduce((sum, p) => sum + BigInt(p.creditedUnits || "0"), 0n);
  const required = requiredUnits(billing, invoice);

  if (invoice.status === "paid" || invoice.status === "void") {
    // Money arrived for an invoice that can't use it. Surface it; refunds are the merchant's call.
    if (trigger) {
      await runHook(ctx, "onOverpayment", () =>
        billing.options.onOverpayment?.({ invoice, payment: trigger, excessUnits: BigInt(trigger.creditedUnits) }, ctx),
      );
    }
    if (invoice.status === "paid") await invoices.update(ctx, invoiceId, { amountPaidUnits: received.toString() });
    return invoice;
  }

  const covered = received >= requiredAfterTolerance(required, billing.toleranceBps);
  if (!covered) {
    return invoices.update(ctx, invoiceId, { amountPaidUnits: received.toString() });
  }

  const won = await invoices.transition(ctx, invoiceId, ["open", "expired"], {
    status: "paid",
    paidAt: billing.now(),
    amountPaidUnits: received.toString(),
  });
  const paid = (await invoices.get(ctx, invoiceId)) ?? invoice;
  if (!won) return paid;

  // Sizing a quote deliberately lands a little over; only report overshoot worth a refund.
  const excess = received - required;
  if (trigger && excess > 0n && excess * 10_000n > required * BigInt(billing.overpaymentThresholdBps)) {
    await runHook(ctx, "onOverpayment", () =>
      billing.options.onOverpayment?.({ invoice: paid, payment: trigger, excessUnits: excess }, ctx),
    );
  }
  try {
    await fulfillInvoice(ctx, billing, invoiceId);
  } catch {
    // The money is in and the invoice is paid; only its effects are pending. fulfillInvoice has
    // logged it and left the invoice unfulfilled, so the next reconcile completes it. Don't show
    // the customer an error for a payment that worked.
  }
  return (await invoices.get(ctx, invoiceId)) ?? paid;
}
