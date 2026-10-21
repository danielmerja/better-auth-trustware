# Design

This is the reasoning behind the plugin, for contributors. Usage lives in the README.

## The problem

Better Auth's payment plugins (Stripe, Polar, Creem, Chargebee, Autumn, Dodo) sit on top of a provider that already owns customers, subscriptions, invoices, checkout and webhooks. They sync that state into the app's database.

Trustware owns none of that. From its docs it is a non-custodial cross-chain routing layer: ask for a quote, get a route, the payer signs it from their own wallet, submit the transaction hash, poll status. There are no subscriptions, customers, hosted checkout or webhooks. So this plugin is the billing engine, and Trustware is only the payment rail.

## Core decisions

**Source of truth is our database.** Three models: `trustwareSubscription`, `trustwareInvoice`, `trustwarePayment`. Plans and products live in config (or an async function).

**An invoice is a fixed USD amount; a payment is one Trustware intent.** An invoice can receive several payments (partial payments accumulate; the last one that covers the amount flips it to `paid`). The destination is always a USD stablecoin, so `1 token == $1` and no price oracle is needed on our side.

**Sizing the source amount.** Trustware quotes from a *source* amount, but we owe a fixed *destination* amount. We start from the source token's `usdPrice` (from `GET /routes/tokens`) plus a buffer, then correct by the quote's `toAmountMin` until it covers the remainder without overshooting by more than ~1%. The route is only accepted if its guaranteed minimum covers what is owed.

**No webhooks, so we poll, and everything is idempotent.** `reconcile` polls in-flight payments, repairs half-applied state, expires invoices, issues renewal invoices and moves lapsed subscriptions along. It runs on a schedule, on demand, and lazily when an account reads its billing. Each step is safe to repeat.

**Renewals are invoices.** Crypto is push payment. `renewalLeadDays` before a period ends we issue a renewal invoice; if it's unpaid at the period end the subscription is `past_due` for `gracePeriodDays`, then ends. Paying early extends from the current end (no lost days); paying late starts a fresh period from the payment date.

**Access is computed, not stored.** `resolveStatus` derives the effective status from dates. A late or dead scheduler can't extend a lapsed customer's access. Free plans are exempt, because they have nothing to renew.

**Exactly-once crediting.** Two compare-and-set transitions guard money: `payment.credited` false -> true, and `invoice.status` open|expired -> paid. `invoice.fulfilled` guards the subscription effects and is rolled back on failure so reconcile retries. App callbacks run after state is persisted, and their failures never undo it.

## Trust boundaries

| Source | Trusted for |
| --- | --- |
| Our config | destination chain/token/wallet, prices |
| Trustware status `success` | that a route completed, **after** destination/chain/metadata match what we requested |
| Trustware `to_amount_wei` | the credited amount, unless `verifyPayment` overrides |
| The browser | nothing about money. Only which invoice, and where funds come from |

`verifyPayment` is the escape hatch for apps that want on-chain confirmation before crediting.

## Things deliberately not done (yet)

- Deposit-address routes (pay from an exchange). Trustware documents the existence of `POST /routes/deposit-address` but not its request/response, so there is nothing safe to build on.
- Refunds, coupons, tax, seats, usage metering.
- Automatic recurring pulls. Trustware lists smart accounts with programmable permissions as "coming soon"; that is the likely route to real auto-renewal.
- Pagination in `reconcile` beyond 500 rows per table.

## Unverified against the live API

Written from public docs, not exercised live. Inferred: the tokens pagination envelope; the semantics of `to_amount_wei` and `landed_amount_verified`; that `metadata` is echoed in status under that key. `scripts/live-check.mjs` is a read-only probe for the first two; the third needs one real payment.

## Layout

```
src/
  index.ts            plugin factory
  client.ts           client plugin + waitForInvoice
  testing.ts          in-memory Trustware for tests
  schema.ts           models
  types.ts            options and records
  middleware.ts       session + referenceId authorization
  core/
    billing.ts        resolved config, plans/products, token cache
    access.ts         effective status and access summary
    invoices.ts       create / fulfil / expire
    payments.ts       prepare route, receipt, poll, credit
    subscriptions.ts  start / change / cancel / restore
    reconcile.ts      the heartbeat
    money.ts          BigInt amount maths
    intervals.ts      calendar maths
    store.ts          adapter queries, compare-and-set helpers
  routes/             endpoints, grouped by concern
  trustware/          REST client and types
```
