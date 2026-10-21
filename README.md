# better-auth-trustware

Crypto payments, subscriptions, invoices and access control for [Better Auth](https://better-auth.com), settled through [Trustware](https://trustware.io).

> **Unofficial.** This is a community plugin. It is not made, endorsed or verified by Trustware or the Better Auth team. Read the code before you point real money at it.

Your customers pay from any wallet, on any chain, in any token Trustware can route. You receive a single USD stablecoin (for example USDC on Base) at your own wallet. Trustware never holds the funds, and neither does this plugin.

## How this differs from the Stripe plugin

Stripe, Polar and Creem own customers, subscriptions, invoices and a hosted checkout, and their Better Auth plugins mostly mirror that state into your database. **Trustware is different: it is a non-custodial cross-chain routing layer.** It has no subscriptions, no customers, no hosted checkout and (as of its current docs) no webhooks. So this plugin is the billing engine, and Trustware is the way each invoice gets paid:

| Concern | Stripe plugin | This plugin |
| --- | --- | --- |
| Plans, subscriptions, status | Stripe is the source of truth, mirrored via webhooks | Your database is the source of truth |
| Taking payment | Stripe Checkout (hosted page) | An invoice, paid by a Trustware route the customer signs in their wallet |
| Knowing a payment landed | Webhooks | Server-side polling of Trustware's status endpoint |
| Renewals | Stripe charges the card on file | The plugin issues a renewal invoice ahead of each period; the customer pays it |
| Failed renewals | Stripe retries the card | `past_due` with a grace period, then the subscription ends |
| Refunds | Stripe API | You send them yourself (non-custodial) |
| Billing portal | Hosted by Stripe | Data endpoints you build a page on (`billing`, `invoice/list`, ...) |

The consequence worth internalising: **crypto is push payment, so nothing renews itself.** Every renewal is an invoice the customer chooses to pay. The plugin handles issuing it, reminding you (via callbacks), the grace period, and cutting access if it goes unpaid.

## Install

```bash
pnpm add better-auth-trustware
```

Requires `better-auth` `^1.7.12`. You need a Trustware API key and a wallet address you control.

## Quick start

**Server** (`auth.ts`):

```ts
import { betterAuth } from "better-auth";
import { trustware } from "better-auth-trustware";

export const auth = betterAuth({
  // ...your database and auth config
  plugins: [
    trustware({
      apiKey: process.env.TRUSTWARE_API_KEY!,
      // Where money lands. Must be a USD stablecoin: 1 token is treated as $1.
      settlement: {
        chainId: "8453", // Base
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        address: process.env.MERCHANT_ADDRESS!, // your wallet
      },
      subscription: {
        enabled: true,
        plans: [
          {
            name: "pro",
            prices: { month: 2000, year: 20000 }, // USD cents
            features: ["export", "api"],
            limits: { projects: 20 },
            freeTrial: { days: 7 },
          },
        ],
      },
      reconcile: { secret: process.env.CRON_SECRET }, // lets a scheduler call the reconcile hook
    }),
  ],
});
```

**Client**:

```ts
import { createAuthClient } from "better-auth/client";
import { trustwareClient } from "better-auth-trustware/client";

export const authClient = createAuthClient({
  plugins: [trustwareClient({ subscription: true })],
});
```

**Create the tables**, then re-run this whenever you change the plugin config:

```bash
npx auth@latest migrate        # built-in adapter
npx auth@latest generate       # Drizzle / Prisma
```

This adds `trustwareSubscription`, `trustwareInvoice` and `trustwarePayment` (and no `trustwareSubscription` if subscriptions are off).

**Run the heartbeat.** Because Trustware has no webhooks, something has to poll it and issue renewals. Pick one:

- Do nothing. State refreshes lazily whenever a customer opens their billing page or checks access. Fine for a start.
- Hit the HTTP hook from a scheduler every few minutes (below). Recommended for production.

## The purchase flow

```
checkout ──► invoice (open) ──► pay ──► wallet signs ──► receipt ──► status … ──► invoice (paid) ──► active
```

1. `authClient.trustware.checkout({ plan: "pro" })` creates the subscription (`incomplete`) and an invoice.
2. `authClient.trustware.invoice.pay({ invoiceId, fromChain, fromToken, fromAddress })` asks Trustware for a route. The server fixes the destination and sizes the source amount so the route's guaranteed minimum covers what is owed. You get back a `transaction` and any token `approvals` to sign.
3. The customer's wallet signs them. You submit the transaction hash with `payment.receipt`.
4. Poll `invoice.status` (or use `waitForInvoice`). When Trustware reports `success` and the amounts check out, the invoice flips to `paid` exactly once and the subscription activates.

A checkout page with viem:

```ts
import { erc20Abi } from "viem";
import { waitForInvoice } from "better-auth-trustware/client";

const { data } = await authClient.trustware.checkout({ plan: "pro" });
const invoice = data!.invoice!;

const pay = await authClient.trustware.invoice.pay({
  invoiceId: invoice.id,
  fromChain: String(chain.id),
  fromToken: tokenAddress, // use 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE for the native coin
  fromAddress: account.address,
});
const { paymentId, transaction, approvals } = pay.data!;

for (const a of approvals) {
  const approveHash = await walletClient.writeContract({
    address: a.tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: "approve",
    args: [a.spender as `0x${string}`, BigInt(a.amount)],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
}

const txHash = await walletClient.sendTransaction({
  to: transaction.to as `0x${string}`,
  data: transaction.data as `0x${string}` | undefined,
  value: BigInt(transaction.value ?? 0),
});
// Submit the hash right away. It's how Trustware starts tracking the payment.
await authClient.trustware.payment.receipt({ paymentId, txHash });

const settled = await waitForInvoice(authClient, invoice.id, { onUpdate: (i) => console.log(i.status) });
```

If the customer closes the tab after broadcasting, they can come back and call `payment.receipt` for the same `paymentId` later. Underpaid invoices stay open, and the next `pay` call is sized for what remains.

The plugin only recognises payments made through a route it created with `invoice.pay`, because that is what ties a Trustware intent to an invoice and fixes the destination. Money sent to your settlement wallet some other way (including through Trustware's own widget or `@trustware/sdk`) is not matched to invoices. You can still use their signing helpers on the `transaction` and `approvals` this plugin returns.

## Renewals, lapses and the reconcile job

`reconcile` is idempotent and safe to run as often as you like. It:

1. polls in-flight payments and credits settled ones,
2. repairs invoices whose payment landed but whose effects didn't apply,
3. expires stale invoices,
4. issues a renewal invoice `renewalLeadDays` (default 3) before each period ends, and
5. moves unpaid subscriptions to `past_due`, then ends them after `gracePeriodDays` (default 3).

Run it from anywhere:

```ts
// your own code or an API route
await auth.api.trustwareReconcile({ body: {} });
```

```bash
# any scheduler, with reconcile.secret set (GET or POST)
curl -X POST https://your.app/api/auth/trustware/reconcile -H "Authorization: Bearer $CRON_SECRET"
```

On Vercel, set `CRON_SECRET` (Vercel sends it as a bearer token) and add a cron:

```json
{ "crons": [{ "path": "/api/auth/trustware/reconcile", "schedule": "*/10 * * * *" }] }
```

Access never depends on the scheduler: it is derived from the subscription's dates, so a late cron cannot give a lapsed customer extra time. Free plans (price 0) are the exception on purpose, because they have nothing to renew, and a scheduler outage never cancels them.

Know when to nudge customers with the callbacks:

```ts
trustware({
  // ...
  onInvoiceCreated: async ({ invoice, subscription }) => {
    if (invoice.kind === "subscription_renewal") await emailRenewalDue(subscription!.referenceId, invoice);
  },
  subscription: {
    enabled: true,
    plans,
    onSubscriptionPastDue: async ({ subscription, invoice }) => sendDunningEmail(subscription, invoice),
  },
});
```

## Access control

```ts
// Server: any feature check, e.g. in a route handler
const { allowed } = await auth.api.trustwareCheckAccess({
  headers: await headers(),
  query: { feature: "export" },
});
if (!allowed) return new Response("Upgrade required", { status: 402 });

// Everything the account is entitled to
const access = await auth.api.trustwareGetAccess({ headers: await headers() });
// { hasAccess, reason: "subscription" | "grace_period" | "purchase" | "none", status, plan,
//   features, limits, periodEnd, graceEndsAt, cancelAtPeriodEnd, purchases }
```

```ts
// Client
const { data } = await authClient.trustware.access.check({ query: { feature: "export" } });
```

A feature is allowed when the active plan lists it in `features`, or has a non-zero entry in `limits`. `limits` are returned so you can enforce numeric caps (`access.limits.projects`) in your own code. Access is granted while a subscription is `active`, `trialing` or `past_due` (inside the grace window), plus any unexpired one-time purchases.

## Managing subscriptions

```ts
await authClient.trustware.subscription.change({ plan: "enterprise" });                          // upgrade now, prorated
await authClient.trustware.subscription.change({ plan: "basic", scheduleAtPeriodEnd: true });    // downgrade at renewal
await authClient.trustware.subscription.cancel();                                                // at period end
await authClient.trustware.subscription.cancel({ immediately: true });                           // now, nothing refunded
await authClient.trustware.subscription.restore();                                               // undo a pending cancel or change
await authClient.trustware.billing();                                                            // subscriptions + open and recent invoices + access
await authClient.trustware.invoice.list();                                                       // billing history
```

An immediate plan change credits the unused part of the current period against the new price (`proration: "none"` turns that off), then starts a fresh period once the difference is paid. If the credit covers the new price the switch is instant with no invoice. Leftover credit is not carried as a balance, so prefer `scheduleAtPeriodEnd` for downgrades.

One-time purchases:

```ts
trustware({ /* ... */ products: [{ id: "pass-30", name: "30-day pass", amountCents: 900, features: ["pro"], accessDays: 30 }] });
await authClient.trustware.checkout({ productId: "pass-30" });
```

## Organizations

```ts
trustware({
  // ...
  organization: { enabled: true },
  authorizeReference: async ({ user, referenceId, action }, ctx) =>
    !!(await ctx.context.adapter.findOne({
      model: "member",
      where: [
        { field: "organizationId", value: referenceId },
        { field: "userId", value: user.id },
      ],
    })),
});

await authClient.trustware.checkout({ plan: "team", customerType: "organization" }); // uses the active organization
```

`authorizeReference` runs for every call that targets a reference other than the signed-in user's own id, and is told the `action` (`create-checkout`, `change-subscription`, `view-billing`, `pay-invoice`, ...) so you can restrict by role.

## Callbacks

| Option | Fires when |
| --- | --- |
| `onInvoiceCreated` | any invoice is created (first payment, renewal, plan change, purchase) |
| `onInvoicePaid` | an invoice is fully paid and applied |
| `onPaymentFailed` | Trustware reports a payment failed, or it failed verification |
| `onOverpayment` | more arrived than owed. Refund it yourself |
| `subscription.onTrialStart` | a free trial begins |
| `subscription.onSubscriptionComplete` | first payment lands, a trial converts, or a free plan starts |
| `subscription.onSubscriptionRenewed` | a renewal invoice is paid |
| `subscription.onSubscriptionUpdate` | the plan or interval changed |
| `subscription.onSubscriptionCancel` | the customer asked to cancel |
| `subscription.onSubscriptionPastDue` | a period ended with the renewal unpaid |
| `subscription.onSubscriptionEnded` | the subscription is over (`reason`: `canceled` or `non_payment`) |

Callbacks run after the database is updated. If one throws, the error is logged and the payment stays applied. Make them idempotent.

## API

Every endpoint is under `/api/auth/trustware/...`. Server calls are `auth.api.<name>`, client calls are `authClient.trustware.<path>`.

| Client | Server | Method + path |
| --- | --- | --- |
| `plans()` | `trustwareListPlans` | `GET /plans` (public) |
| `checkout()` | `trustwareCheckout` | `POST /checkout` |
| `subscription.change()` | `trustwareChangeSubscription` | `POST /subscription/change` |
| `subscription.cancel()` | `trustwareCancelSubscription` | `POST /subscription/cancel` |
| `subscription.restore()` | `trustwareRestoreSubscription` | `POST /subscription/restore` |
| `subscription.list()` | `trustwareListSubscriptions` | `GET /subscription/list` |
| `access()` | `trustwareGetAccess` | `GET /access` |
| `access.check()` | `trustwareCheckAccess` | `GET /access/check` |
| `billing()` | `trustwareBillingOverview` | `GET /billing` |
| `invoice.list()` | `trustwareListInvoices` | `GET /invoice/list` |
| `invoice.get()` | `trustwareGetInvoice` | `GET /invoice/get` |
| `invoice.pay()` | `trustwarePayInvoice` | `POST /invoice/pay` |
| `invoice.status()` | `trustwareInvoiceStatus` | `GET /invoice/status` |
| `payment.receipt()` | `trustwareSubmitReceipt` | `POST /payment/receipt` |
| (none) | `trustwareReconcile` | server only |
| (none) | `trustwareReconcileHttp` | `GET`/`POST /reconcile`, bearer secret |

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | | Trustware API key. Server only |
| `trustware` | | Your own client (tests, proxies). Overrides `apiKey` |
| `baseUrl` | `https://api.trustware.io` | |
| `settlement` | required | `chainId`, `tokenAddress`, `tokenDecimals`, `address`, `tokenSymbol?`. A USD stablecoin |
| `slippage` | `1` | Percent passed to Trustware |
| `subscription` | off | `enabled`, `plans` (array or async function), `requireEmailVerification`, `gracePeriodDays` (3), `renewalLeadDays` (3), `proration` (`prorate`), callbacks |
| `products` | none | One-time purchases (array or async function) |
| `authorizeReference` | | Required for organizations or acting on another reference |
| `organization.enabled` | `false` | |
| `invoice.expiryHours` | `24` | How long a first-payment or one-time invoice stays payable |
| `invoice.underpaymentToleranceBps` | `0` | Settle an invoice at this much less than owed |
| `invoice.overpaymentThresholdBps` | `100` | Smaller overshoot isn't reported to `onOverpayment` |
| `verifyPayment` | | Extra check before crediting (see Security) |
| `checkoutUrl` | | `(invoice) => url` surfaced on checkout responses |
| `reconcile.secret` | | Enables the HTTP reconcile hook |
| `schema` | | Rename tables and fields |
| `advanced.lazyReconcile` | `true` | Refresh state when an account reads its billing |

Plan prices are **integer US cents**. `name` is stored lowercase. Intervals are `day`, `week`, `month` and `year`; a plan can offer any of them.

## Security model

- **The client never decides money.** It cannot set an amount, a destination chain/token/wallet, or a status. The server builds every route with your `settlement` address, and refuses a route whose guaranteed minimum (`toAmountMin`) does not cover what is owed.
- **A payment is only credited when Trustware reports `success`** *and* the reported destination chain, address and invoice metadata match what the server requested. A mismatch fails the payment instead of crediting it.
- **Credit happens once.** Crediting and fulfilment use compare-and-set updates, so concurrent polls, retries and reconcile runs cannot double-grant.
- **One transaction pays one payment.** A transaction hash cannot be attached to a second payment.
- **Other people's invoices look like they don't exist** (404), and every endpoint that takes a `referenceId` goes through `authorizeReference`.
- **Screening failures stay opaque.** Trustware's AML/OFAC errors are mapped to a generic message; details go to your server log.
- **Rate limits** are registered for the endpoints that call Trustware (`checkout`, `invoice/pay`, `invoice/status`, `payment/receipt`). Better Auth enforces them on HTTP requests when rate limiting is enabled.
- **The reconcile HTTP hook is off unless you set a secret**, and compares it in constant time.

**Strongest defense: `verifyPayment`.** Trustware's own docs note that a route's status reflects its provider's aggregate result. If you want to be certain, confirm the transfer on-chain before crediting:

```ts
trustware({
  // ...
  verifyPayment: async ({ invoice, payment, status }) => {
    const received = await readUsdcTransferTo(payment.toAddress, status.destTxHash!); // your RPC code
    return received >= BigInt(payment.expectedUnits) ? { creditedUnits: received } : false;
  },
});
```

Trustware may report `success` before it has verified the landed amount (`landed_amount_verified: false`). Without `verifyPayment`, the plugin waits and keeps polling rather than crediting. With it, your hook decides.

## Testing without an API key

```ts
import { createMockTrustware } from "better-auth-trustware/testing";

const mock = createMockTrustware();
trustware({ trustware: mock, settlement, subscription });

// drive a payment through its states
mock.settle(intentId);                       // success
mock.settle(intentId, { toAmount: 8_000_000n }); // underpay
mock.bridge(intentId);
mock.fail(intentId);
mock.failNext("status");                     // simulate an outage on the next call
```

## Verification status

The plugin is covered by an automated suite (types, unit tests, and end-to-end flows against a real SQLite database through Better Auth's own test harness). **It has not been run against the live Trustware API.** It was written from [Trustware's public docs](https://docs.trustware.io), and a few shapes are inferred rather than documented:

- the pagination envelope of `GET /routes/tokens`,
- the meaning of `to_amount_wei` and `landed_amount_verified` in status responses,
- whether `metadata` is echoed in status responses under that key.

The code is defensive about each (see Security). Before you take real payments, run the live check and read its output:

```bash
pnpm build
TRUSTWARE_API_KEY=... LIVE_FROM_CHAIN=1 LIVE_FROM_TOKEN=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE \
LIVE_FROM_ADDRESS=0x... LIVE_TO_CHAIN=8453 LIVE_TO_TOKEN=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
LIVE_TO_ADDRESS=0x... pnpm live-check
```

Then make one small real payment end to end.

## Limitations

- **No automatic recurring charges.** Crypto can't be pulled. Renewal is an invoice the customer pays. (Trustware's smart accounts are listed as "coming soon"; permissioned recurring payments could build on that later.)
- **No deposit-address flow yet.** Payers sign a route from a connected wallet. Pay-from-an-exchange needs Trustware's deposit-address route, whose API isn't documented enough to build against.
- **Refunds, taxes, coupons, seat-based pricing and usage metering are not implemented.**
- **Stablecoin settlement only.** Invoices are USD; the destination token is assumed to be worth $1.
- Do not change `settlement.tokenAddress` or `tokenDecimals` while invoices are open.
- `reconcile` handles up to 500 in-flight items per table per run. Run it often rather than rarely.
- An immediate plan change that fully covers the new price resets the billing period and discards leftover credit.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/DESIGN.md](./docs/DESIGN.md). Security issues: [SECURITY.md](./SECURITY.md).

## Author

Created and maintained by [Daniel Merja](https://github.com/danielmerja).

## License

MIT
