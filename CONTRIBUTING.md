# Contributing

Thanks for helping. This plugin moves money, so the bar for changes to payment and access logic is high. Read [docs/DESIGN.md](./docs/DESIGN.md) first.

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test        # needs Node 22.5+ (the Better Auth test harness uses node:sqlite)
pnpm build
```

## Ground rules

1. **The client never decides money.** No amounts, destinations or statuses from request bodies. If you add an endpoint, add a test that a tampered body can't change the outcome.
2. **Anything that credits or fulfils must be idempotent** and guarded by a compare-and-set (`updateMany` returning 1), not a read-then-write.
3. **Don't trust Trustware's payload blindly.** Check it against what we requested before crediting. Unknown statuses are "in flight", never success.
4. **Access is derived from dates** (`resolveStatus`), so a stalled scheduler can't extend it.
5. **Tell the truth in the README.** If you change behaviour or find an assumption about Trustware is wrong, update "Verification status".
6. **Errors for customers are generic; detail goes to the logger.**

## Tests

Tests run real endpoints against SQLite through `better-auth/test`, with `createMockTrustware()` standing in for Trustware and a controllable clock (`t.tick(ms)`). Look at `test/helpers.ts`, then at `test/payments.test.ts` for the style.

- Add a failing test first for every bug.
- Money paths need a test for the happy path, a partial/duplicate/late variant, and a hostile variant.

If you have a Trustware API key, `pnpm live-check` probes the shapes we assume. Reports of what the real API returns are very welcome, especially the status payload.

## Pull requests

Keep them focused. Include: what changed, why, and how you tested it. Don't commit secrets; `.env` files are ignored.
