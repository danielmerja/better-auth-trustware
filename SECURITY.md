# Security policy

This plugin decides when a payment counts as paid and who has access, so security reports are taken seriously.

## Reporting

Please **do not open a public issue** for a vulnerability. Report it privately through the repository's "Report a vulnerability" (GitHub private security advisory) option, or contact the maintainers directly. Include:

- what you found and the impact (for example: credit without payment, access without payment, cross-account data exposure),
- steps or a failing test to reproduce,
- the plugin and Better Auth versions.

You can expect an acknowledgement within a few days. Please give us reasonable time to ship a fix before disclosing.

## In scope

- Crediting an invoice that wasn't paid, or twice
- Redirecting funds away from the configured settlement wallet
- Reading or acting on another account's invoices, payments or subscriptions
- Granting access beyond what a subscription or purchase allows
- Bypassing the reconcile endpoint's secret

## Out of scope

- Bugs in Trustware, Better Auth or wallets themselves
- Funds lost by sending them outside a route this plugin created
- Denial of service by an authenticated account within configured rate limits

## Known limitation

The plugin has not yet been exercised against the live Trustware API. See "Verification status" in the README, and use `verifyPayment` to confirm transfers on-chain if you want certainty before crediting.
