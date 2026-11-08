// The extension's only network call, and only when a non-USD currency is
// chosen: one GET for the daily USD reference rate (European Central Bank,
// via frankfurter.dev). The request carries just the currency code; no usage
// data, paths or identifiers are sent. The privacy gates allow fetch in this
// file alone and pin it to RATE_URL.
import { parseRate } from "../core/currency";
import type { Currency } from "../core/types";

export const RATE_URL = "https://api.frankfurter.dev/v1/latest";
const TIMEOUT_MS = 10_000;
/** The reply is about 80 bytes; anything past this is refused before parsing (v0.7). */
export const MAX_RATE_BYTES = 4096;

/** Today's rate for `code` per 1 USD; throws with a short code on failure. */
export async function fetchUsdRate(code: string): Promise<Currency> {
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("BAD_CODE");
  const res = await fetch(`${RATE_URL}?base=USD&symbols=${code}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_RATE_BYTES) throw new Error("BAD_RESPONSE");
  const text = await res.text();
  if (text.length > MAX_RATE_BYTES) throw new Error("BAD_RESPONSE");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("BAD_RESPONSE");
  }
  const rate = parseRate(json, code);
  if (!rate) throw new Error("BAD_RESPONSE");
  return rate;
}
