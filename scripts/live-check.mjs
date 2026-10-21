#!/usr/bin/env node
/**
 * Read-only check of the Trustware API shapes this plugin assumes. It validates
 * your key, lists a chain's tokens and requests one quote. It does NOT create a
 * route, so no intent is created and no money can move.
 *
 *   pnpm build
 *   TRUSTWARE_API_KEY=... LIVE_FROM_CHAIN=1 LIVE_FROM_TOKEN=0x... LIVE_FROM_ADDRESS=0x... \
 *   LIVE_TO_CHAIN=8453 LIVE_TO_TOKEN=0x... LIVE_TO_ADDRESS=0x... pnpm live-check
 */
import { createTrustwareApi } from "../dist/index.js";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return value;
};

const apiKey = env("TRUSTWARE_API_KEY");
const baseUrl = process.env.TRUSTWARE_BASE_URL ?? "https://api.trustware.io";
const fromChain = env("LIVE_FROM_CHAIN");
const fromToken = env("LIVE_FROM_TOKEN");
const fromAddress = env("LIVE_FROM_ADDRESS");
const toChain = env("LIVE_TO_CHAIN");
const toToken = env("LIVE_TO_TOKEN");
const toAddress = env("LIVE_TO_ADDRESS");
const fromAmount = process.env.LIVE_FROM_AMOUNT ?? "1000000000000000"; // 0.001 of an 18-decimal token

const api = createTrustwareApi({ apiKey, baseUrl });
let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? "  ok " : " FAIL"}  ${message}`);
  if (!ok) failures += 1;
};

console.log("\n1. API key");
try {
  const v = await api.validate();
  check(v.valid === true, `valid=${v.valid} status=${v.status ?? "?"}`);
} catch (e) {
  check(false, `validate failed: ${e.message}`);
}

console.log("\n2. Tokens (raw page shape, then parsed)");
try {
  const raw = await fetch(`${baseUrl}/api/v1/routes/tokens?chainId=${encodeURIComponent(fromChain)}&limit=5`, {
    headers: { "X-API-Key": apiKey },
  }).then((r) => r.json());
  const topKeys = Object.keys(raw ?? {});
  const dataKeys = raw?.data && !Array.isArray(raw.data) ? Object.keys(raw.data) : [];
  console.log(`      top-level keys: ${topKeys.join(", ") || "(none)"}`);
  if (dataKeys.length) console.log(`      data keys: ${dataKeys.join(", ")}`);
  console.log("      -> make sure a next-page cursor, if any, is one of: data.nextCursor, data.next_cursor, nextCursor, next_cursor, meta.nextCursor");
  const tokens = await api.tokens({ chainId: fromChain });
  check(tokens.length > 0, `parsed ${tokens.length} tokens on chain ${fromChain}`);
  const wanted = tokens.find((t) => t.address.toLowerCase() === fromToken.toLowerCase());
  check(!!wanted, `source token ${fromToken} is in the list${wanted ? ` (${wanted.symbol}, ${wanted.decimals} decimals)` : ""}`);
  check(!!wanted?.usdPrice, `source token has a usdPrice${wanted?.usdPrice ? ` (${wanted.usdPrice})` : ""}. Without it, invoices can't be sized`);
} catch (e) {
  check(false, `tokens failed: ${e.message}`);
}

console.log("\n3. Quote");
try {
  const q = await api.quote({ fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, toAddress, slippage: 1 });
  console.log(`      estimate: ${JSON.stringify(q.estimate)}`);
  check(/^\d+$/.test(String(q.estimate.toAmountMin)), "estimate.toAmountMin is an integer base-unit string");
  check(/^\d+$/.test(String(q.estimate.toAmount)), "estimate.toAmount is an integer base-unit string");
} catch (e) {
  check(false, `quote failed (${e.status ?? "?"} ${e.code ?? ""}): ${e.message}`);
}

console.log(
  "\nNot checked here, because it needs a real route: the status payload (`to_amount_wei`, `landed_amount_verified`, echoed `metadata`).\n" +
    "Make one small real payment and compare the `raw` field of a status response with src/trustware/api.ts normalizeStatus().\n",
);
process.exit(failures ? 1 : 0);
