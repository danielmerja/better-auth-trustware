import type { BillingInterval } from "../types";

export const DAY_MS = 86_400_000;

/**
 * Add `count` billing intervals to a date in UTC. Month and year math clamps to
 * the end of the target month (Jan 31 + 1 month = Feb 28/29), the way card
 * billing systems behave.
 */
export function addInterval(date: Date, interval: BillingInterval, count = 1): Date {
  const next = new Date(date.getTime());
  switch (interval) {
    case "day":
      next.setUTCDate(next.getUTCDate() + count);
      return next;
    case "week":
      next.setUTCDate(next.getUTCDate() + 7 * count);
      return next;
    case "month":
      return addMonths(next, count);
    case "year":
      return addMonths(next, 12 * count);
  }
}

function addMonths(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const target = new Date(date.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "day" || value === "week" || value === "month" || value === "year";
}
