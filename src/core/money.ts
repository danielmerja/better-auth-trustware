/**
 * Money helpers. All USD amounts are integer cents. All on-chain amounts are
 * base-unit strings parsed into BigInt, never floats.
 */

/** Parse a base-unit amount from a Trustware payload. Returns undefined for anything that isn't a non-negative integer. */
export function parseBaseUnits(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value >= 0n ? value : undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return undefined;
    // Beyond 2^53 a JS number has already lost precision, so refuse it.
    if (!Number.isSafeInteger(value)) return undefined;
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

/** USD cents -> destination-token base units, assuming 1 token == 1 USD (a USD stablecoin). */
export function centsToBaseUnits(cents: number, decimals: number): bigint {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError("cents must be a non-negative integer");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError("decimals must be an integer between 0 and 36");
  }
  const c = BigInt(cents);
  if (decimals >= 2) return c * 10n ** BigInt(decimals - 2);
  const divisor = 10n ** BigInt(2 - decimals);
  return (c + divisor - 1n) / divisor;
}

/** ceil(a * num / den) for non-negative BigInts. */
export function mulDivCeil(a: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError("denominator must be positive");
  return (a * num + den - 1n) / den;
}

/**
 * Smallest amount, tolerance applied, that counts as "fully paid".
 * `toleranceBps` of 100 means an invoice is settled at 99% of the amount due.
 */
export function requiredAfterTolerance(required: bigint, toleranceBps: number): bigint {
  if (toleranceBps <= 0) return required;
  const bps = BigInt(Math.min(Math.floor(toleranceBps), 10_000));
  return (required * (10_000n - bps)) / 10_000n;
}

/**
 * First-guess source amount (base units) needed to deliver `requiredUsd`
 * dollars, given the source token's USD price. Quotes refine it afterwards.
 */
export function estimateFromAmount(args: {
  requiredUsd: number;
  usdPrice: number;
  decimals: number;
  bufferBps: number;
}): bigint {
  const { requiredUsd, usdPrice, decimals, bufferBps } = args;
  if (!(usdPrice > 0) || !Number.isFinite(usdPrice)) throw new RangeError("usdPrice must be a positive number");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError("invalid decimals");
  const tokens = (requiredUsd / usdPrice) * (1 + bufferBps / 10_000);
  // Work in micro-tokens so we stay inside safe-integer range, then scale to base units.
  const micro = BigInt(Math.ceil(tokens * 1e6));
  if (decimals >= 6) return micro * 10n ** BigInt(decimals - 6);
  const divisor = 10n ** BigInt(6 - decimals);
  return (micro + divisor - 1n) / divisor;
}

/** Cents credit for the unused part of a billing period, rounded down so we never over-credit. */
export function prorateCents(priceCents: number, remainingMs: number, periodMs: number): number {
  if (priceCents <= 0 || periodMs <= 0 || remainingMs <= 0) return 0;
  const ratio = Math.min(1, remainingMs / periodMs);
  return Math.floor(priceCents * ratio);
}
