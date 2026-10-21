import type { GenericEndpointContext, InferOptionSchema, Session, User } from "better-auth";
import type { TrustwareApi, TrustwareStatus } from "./trustware/types";
import type { TRUSTWARE_SCHEMA } from "./schema";

export type Awaitable<T> = T | Promise<T>;

export type BillingInterval = "day" | "week" | "month" | "year";
export type CustomerType = "user" | "organization";

export type SubscriptionStatus =
  | "incomplete" // checkout started, first invoice not paid yet
  | "incomplete_expired" // first invoice expired unpaid
  | "trialing"
  | "active"
  | "past_due" // period ended, renewal unpaid, still inside the grace window
  | "canceled";

export type InvoiceStatus = "open" | "paid" | "expired" | "void";
export type InvoiceKind = "subscription_create" | "subscription_renewal" | "plan_change" | "one_time";
export type PaymentStatus = "created" | "submitted" | "bridging" | "success" | "failed" | "abandoned";

/** Amounts are integer US cents. */
export interface TrustwarePlan {
  /** Stored lowercase. */
  name: string;
  displayName?: string;
  description?: string;
  /** Price per billing interval in USD cents, e.g. `{ month: 2000, year: 20000 }`. */
  prices: Partial<Record<BillingInterval, number>>;
  /** Numeric limits returned to the client and used by access checks, e.g. `{ projects: 20 }`. */
  limits?: Record<string, number>;
  /** Feature keys this plan unlocks, used by access checks. */
  features?: string[];
  group?: string;
  /** One free trial per account. No invoice is issued until the trial ends. */
  freeTrial?: { days: number };
  /** Omit from the public plans list (still purchasable by name). */
  hidden?: boolean;
}

export interface TrustwareProduct {
  id: string;
  name: string;
  description?: string;
  /** USD cents. */
  amountCents: number;
  /** Features unlocked by this purchase. */
  features?: string[];
  /** How long the purchase unlocks `features`. Omit for lifetime access. */
  accessDays?: number;
}

/** Where payments land. Must be a USD stablecoin: 1 token is treated as 1 USD. */
export interface TrustwareSettlement {
  /** Trustware chain id, e.g. `"8453"` for Base. */
  chainId: string;
  /** Token contract, mint or native denom, e.g. USDC on that chain. */
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals: number;
  /** Your receiving wallet. The server always sends this as `toAddress`; clients can't change it. */
  address: string;
}

export type AuthorizeReferenceAction =
  | "create-checkout"
  | "change-subscription"
  | "cancel-subscription"
  | "restore-subscription"
  | "list-subscription"
  | "view-billing"
  | "pay-invoice"
  | "check-access";

export interface TrustwareSubscription {
  id: string;
  referenceId: string;
  customerType: CustomerType;
  plan: string;
  billingInterval: BillingInterval;
  status: SubscriptionStatus;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  trialStart?: Date | null;
  trialEnd?: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date | null;
  endedAt?: Date | null;
  endedReason?: string | null;
  pendingPlan?: string | null;
  pendingInterval?: BillingInterval | null;
  seats?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrustwareInvoice {
  id: string;
  referenceId: string;
  customerType: CustomerType;
  subscriptionId?: string | null;
  kind: InvoiceKind;
  status: InvoiceStatus;
  description?: string | null;
  plan?: string | null;
  billingInterval?: BillingInterval | null;
  productId?: string | null;
  /** Total due in USD cents, after any proration credit. */
  amountCents: number;
  /** Proration credit already netted out of `amountCents`. */
  creditCents: number;
  currency: "USD";
  /** Sum credited so far, destination-token base units. */
  amountPaidUnits: string;
  /** Period this invoice buys. */
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /** Pay by this time. Past it a subscription becomes past_due. */
  dueAt?: Date | null;
  /** After this the invoice can no longer be paid. */
  expiresAt?: Date | null;
  paidAt?: Date | null;
  /** Whether the subscription/purchase effects of a paid invoice were applied. */
  fulfilled: boolean;
  metadata?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrustwarePayment {
  id: string;
  invoiceId: string;
  referenceId: string;
  intentId: string;
  status: PaymentStatus;
  fromChain: string;
  fromToken: string;
  fromAddress: string;
  fromAmount: string;
  toChain: string;
  toToken: string;
  toAddress: string;
  /** Minimum the quote promised, base units. */
  expectedUnits: string;
  /** What Trustware settled, base units. "0" until success. */
  creditedUnits: string;
  credited: boolean;
  sourceTxHash?: string | null;
  destTxHash?: string | null;
  provider?: string | null;
  errorCode?: string | null;
  nextPollAt?: Date | null;
  lastPolledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrustwarePlanContext {
  subscription: TrustwareSubscription;
  plan?: TrustwarePlan;
}

export interface SubscriptionOptions {
  enabled: boolean;
  /** Static list, or a function that loads plans (e.g. from your database). */
  plans: TrustwarePlan[] | (() => Awaitable<TrustwarePlan[]>);
  requireEmailVerification?: boolean;
  /** Days of access kept after a period ends with its renewal unpaid. Default 3. */
  gracePeriodDays?: number;
  /** Issue the renewal invoice this many days before the period ends. Default 3. */
  renewalLeadDays?: number;
  /**
   * What an immediate plan change charges. `prorate` (default) credits the unused
   * part of the current period against the new price and starts a fresh period.
   * `none` charges the full new price with no credit.
   */
  proration?: "prorate" | "none";
  /**
   * First subscription payment, or trial -> paid. `invoice` is absent when a
   * subscription starts free (price 0).
   */
  onSubscriptionComplete?: (data: TrustwarePlanContext & { invoice?: TrustwareInvoice }, ctx: GenericEndpointContext) => Awaitable<void>;
  /** A renewal invoice was paid and the period was extended. */
  onSubscriptionRenewed?: (data: TrustwarePlanContext & { invoice: TrustwareInvoice }, ctx: GenericEndpointContext) => Awaitable<void>;
  /** Plan or interval changed. */
  onSubscriptionUpdate?: (data: TrustwarePlanContext & { previousPlan: string; invoice?: TrustwareInvoice }, ctx: GenericEndpointContext) => Awaitable<void>;
  /** The customer asked to cancel (immediately or at period end). */
  onSubscriptionCancel?: (data: TrustwarePlanContext, ctx: GenericEndpointContext) => Awaitable<void>;
  /** The subscription is over, either cancellation took effect or payment lapsed. */
  onSubscriptionEnded?: (data: TrustwarePlanContext & { reason: "canceled" | "non_payment" }, ctx: GenericEndpointContext) => Awaitable<void>;
  /** The period ended with the renewal unpaid. Good moment for a dunning email. */
  onSubscriptionPastDue?: (data: TrustwarePlanContext & { invoice?: TrustwareInvoice }, ctx: GenericEndpointContext) => Awaitable<void>;
  onTrialStart?: (data: TrustwarePlanContext, ctx: GenericEndpointContext) => Awaitable<void>;
}

export interface VerifyPaymentArgs {
  invoice: TrustwareInvoice;
  payment: TrustwarePayment;
  status: TrustwareStatus;
}

export interface TrustwareOptions {
  /** Trustware API key. Server-side only. */
  apiKey?: string;
  baseUrl?: string;
  /** Provide your own client (tests, proxies, `createMockTrustware()`). Overrides `apiKey`. */
  trustware?: TrustwareApi;
  settlement: TrustwareSettlement;
  /** Slippage percent passed to Trustware. Default 1. */
  slippage?: number;
  subscription?: SubscriptionOptions;
  /**
   * Gate access to a reference id that isn't the signed-in user's own id
   * (organizations, support tooling). Return true to allow. Required for
   * `customerType: "organization"`.
   */
  authorizeReference?: (
    data: { user: User & Record<string, any>; session: Session & Record<string, any>; referenceId: string; action: AuthorizeReferenceAction },
    ctx: GenericEndpointContext,
  ) => Awaitable<boolean>;
  /** One-time purchases. */
  products?: TrustwareProduct[] | (() => Awaitable<TrustwareProduct[]>);
  invoice?: {
    /** How long a first-payment or one-time invoice stays payable. Default 24. */
    expiryHours?: number;
    /**
     * Treat an invoice as paid when at least this much of it (in basis points) has
     * settled. Default 0 (exact). Raise it only if you accept rounding losses.
     */
    underpaymentToleranceBps?: number;
    /**
     * Report `onOverpayment` only when more than this many basis points over the amount
     * due arrived. Sizing a quote always lands slightly over, so small overshoot isn't
     * worth a refund. Default 100 (1%). Money arriving for an already-settled invoice is always reported.
     */
    overpaymentThresholdBps?: number;
  };
  /**
   * Extra check before money is credited, run once Trustware reports `success`.
   * Return false to reject, or `{ creditedUnits }` to credit a different amount.
   * Use it to confirm the transfer on-chain yourself, which is the strongest defense.
   */
  verifyPayment?: (args: VerifyPaymentArgs, ctx: GenericEndpointContext) => Awaitable<boolean | { creditedUnits: bigint }>;
  /** Return a page URL for paying an invoice. Surfaced as `checkoutUrl` when an invoice is created. */
  checkoutUrl?: (invoice: TrustwareInvoice) => string;
  onInvoiceCreated?: (data: { invoice: TrustwareInvoice; subscription?: TrustwareSubscription; plan?: TrustwarePlan }, ctx: GenericEndpointContext) => Awaitable<void>;
  onInvoicePaid?: (data: { invoice: TrustwareInvoice; payments: TrustwarePayment[]; subscription?: TrustwareSubscription; plan?: TrustwarePlan; product?: TrustwareProduct }, ctx: GenericEndpointContext) => Awaitable<void>;
  onPaymentFailed?: (data: { invoice: TrustwareInvoice; payment: TrustwarePayment }, ctx: GenericEndpointContext) => Awaitable<void>;
  /** More than the invoice was settled. Refunds are yours to send, since Trustware is non-custodial. */
  onOverpayment?: (data: { invoice: TrustwareInvoice; payment: TrustwarePayment; excessUnits: bigint }, ctx: GenericEndpointContext) => Awaitable<void>;
  /** Enable organization-scoped billing. Requires `subscription.authorizeReference`. */
  organization?: { enabled: boolean };
  /** Lets a scheduler call `POST /trustware/reconcile` with `Authorization: Bearer <secret>`. */
  reconcile?: { secret?: string };
  schema?: InferOptionSchema<typeof TRUSTWARE_SCHEMA>;
  advanced?: {
    /** Clock override, for tests. */
    now?: () => Date;
    /**
     * Settle in-flight payments and issue renewals for the signed-in account whenever
     * it reads its billing state. Default true. Disable if you run `reconcile` on a schedule.
     */
    lazyReconcile?: boolean;
  };
}

export interface AccessSummary {
  hasAccess: boolean;
  /** Why access is, or isn't, granted. */
  reason: "subscription" | "grace_period" | "purchase" | "none";
  status: SubscriptionStatus | "none";
  plan: string | null;
  subscriptionId: string | null;
  features: string[];
  limits: Record<string, number>;
  periodEnd: Date | null;
  /** Set while `status` is past_due: when access will be cut off. */
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  purchases: { productId: string; invoiceId: string; features: string[]; expiresAt: Date | null }[];
}
