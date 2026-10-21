# Changelog

## 0.1.0

Initial release.

- Plans, subscriptions, one-time products and invoices, with USD pricing settled in a stablecoin through Trustware.
- Checkout, route creation, receipt submission and server-side settlement polling.
- Renewal invoices, grace periods, trials, free plans, prorated plan changes, scheduled changes, cancel and restore.
- Access control endpoints (`access`, `access/check`) with plan features and limits.
- Organization billing through `authorizeReference`.
- `reconcile` heartbeat, server-only and as a bearer-protected HTTP hook.
- Client plugin and `waitForInvoice` helper; `better-auth-trustware/testing` mock.

Not yet verified against the live Trustware API. See README "Verification status".
