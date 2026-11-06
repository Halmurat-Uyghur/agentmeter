// Pure helpers for the optional display currency. Estimated cost is always
// computed in USD; a chosen currency only converts it for display, at the
// daily reference rate fetched by src/vscode/exchangeRate.ts.
import type { Currency } from "./types";

export const DEFAULT_CURRENCY = "USD";

/** Currencies offered in the picker; any other ISO code in settings also works if the rate source has it. */
export const CURRENCIES: [string, string][] = [
  ["USD", "US dollar (no conversion, no network)"],
  ["CAD", "Canadian dollar"],
  ["EUR", "Euro"],
  ["GBP", "British pound"],
  ["AUD", "Australian dollar"],
  ["NZD", "New Zealand dollar"],
  ["JPY", "Japanese yen"],
  ["CHF", "Swiss franc"],
  ["INR", "Indian rupee"],
  ["CNY", "Chinese yuan"],
  ["SGD", "Singapore dollar"],
  ["HKD", "Hong Kong dollar"],
  ["SEK", "Swedish krona"],
  ["NOK", "Norwegian krone"],
  ["DKK", "Danish krone"],
  ["MXN", "Mexican peso"],
  ["BRL", "Brazilian real"],
  ["KRW", "South Korean won"],
];

/** A three-letter upper-case code, else USD. */
export function cleanCurrencyCode(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_CURRENCY;
  const c = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : DEFAULT_CURRENCY;
}

/** Reads `{ base: "USD", date, rates: { CODE: n } }`; undefined when anything is off. */
export function parseRate(json: unknown, code: string): Currency | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as { base?: unknown; date?: unknown; rates?: unknown };
  if (o.base !== "USD" || typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return undefined;
  if (!o.rates || typeof o.rates !== "object") return undefined;
  const rate = (o.rates as Record<string, unknown>)[code];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1e6) return undefined;
  return { code, rate, date: o.date };
}

/** Converts a range entered in `cur` to USD (the unit every comparison uses). */
export function rangeToUsd<R extends { min?: number; max?: number } | undefined>(range: R, cur: Currency | undefined): R {
  if (!range || !cur) return range;
  const out: { min?: number; max?: number } = {};
  if (range.min !== undefined) out.min = range.min / cur.rate;
  if (range.max !== undefined) out.max = range.max / cur.rate;
  return out as R;
}
