// Estimated cost for Claude Code and Codex calls (v0.10). Neither tool logs a cost, so a call's
// cost is estimated from its logged token counts at the provider's public API list price for
// its model. The result is stored in the record's `nanoAiu` field, the unit Copilot's logged
// cost uses (1 USD = 1e11 nano-AIU), so every total, table and chart adds it up the same way.
// Copilot records are never repriced: their cost is logged.
//
// Sources, checked 2026-11-08: platform.claude.com/docs/en/about-claude/pricing and
// developers.openai.com/api/docs/pricing (standard tier). Prices are applied to every month in
// the history window as they stand on that date.
import type { Source, Tokens, UsageRecord } from "./types";

export const PRICES_AS_OF = "2026-11-08";

/** USD per million tokens. */
export interface Rate {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface Price extends Rate {
  /** a higher rate for a call whose prompt is longer than `above` tokens */
  long?: { above: number } & Rate;
}

const r = (input: number, cacheWrite: number, cacheRead: number, output: number): Rate => ({ input, cacheRead, cacheWrite, output });

// Claude Code writes its prompt cache with the 1-hour lifetime (all but 0.3 per cent of cache-write tokens on
// the development machine, 2026-11-08), so cache writes are priced at the 1-hour rate (2× input).
const CLAUDE: Record<string, Price> = {
  "claude-fable-5-1": r(10, 20, 0.25, 50),
  "claude-mythos-5-1": r(10, 20, 0.25, 50),
  "claude-fable-5": r(10, 20, 1, 50),
  "claude-mythos-5": r(10, 20, 1, 50),
  "claude-opus-5-5": r(4, 8, 0.2, 20),
  "claude-opus-5": r(5, 10, 0.5, 25),
  "claude-opus-4-8": r(5, 10, 0.5, 25),
  "claude-opus-4-7": r(5, 10, 0.5, 25),
  "claude-opus-4-6": r(5, 10, 0.5, 25),
  "claude-opus-4-5": r(5, 10, 0.5, 25),
  "claude-opus-4-1": r(15, 30, 1.5, 75),
  "claude-opus-4": r(15, 30, 1.5, 75),
  "claude-sonnet-5-5": r(2, 4, 0.1, 10),
  "claude-sonnet-5": r(2, 4, 0.2, 10),
  "claude-sonnet-4-6": r(3, 6, 0.3, 15),
  "claude-sonnet-4-5": r(3, 6, 0.3, 15),
  "claude-sonnet-4": r(3, 6, 0.3, 15),
  "claude-haiku-5-5": { ...r(0.1, 0.2, 0.01, 0.5), long: { above: 100_000, ...r(0.5, 1, 0.05, 2.5) } },
  "claude-haiku-4-5": r(1, 2, 0.1, 5),
};

// OpenAI lists a 30-minute and a 12-hour cache-write rate; the 30-minute one is used. A call
// whose prompt is over 272K tokens is priced at the long-context rate where one is listed.
const LONG = 272_000;
const OPENAI: Record<string, Price> = {
  "gpt-6-astra": { ...r(10, 12.5, 1, 50), long: { above: LONG, ...r(20, 25, 2, 75) } },
  "gpt-6.1-sol": { ...r(2, 2.5, 0.1, 10), long: { above: LONG, ...r(4, 5, 0.2, 15) } },
  "gpt-6.1-terra": { ...r(1, 1.25, 0.05, 5), long: { above: LONG, ...r(2, 2.5, 0.1, 7.5) } },
  "gpt-6-luna": { ...r(0.1, 0.125, 0.01, 0.5), long: { above: LONG, ...r(0.2, 0.25, 0.02, 0.75) } },
  "gpt-6-sol": { ...r(2, 2.5, 0.2, 10), long: { above: LONG, ...r(4, 5, 0.4, 15) } },
  "gpt-6-cyber": r(20, 25, 2, 100),
  "gpt-6-rosalind": { ...r(15, 18.75, 1.5, 75), long: { above: LONG, ...r(30, 37.5, 3, 112.5) } },
  "gpt-5.6-sol": { ...r(4, 5, 0.4, 20), long: { above: LONG, ...r(8, 10, 0.8, 30) } },
  "gpt-5.6-terra": { ...r(2, 2.5, 0.2, 12), long: { above: LONG, ...r(4, 5, 0.4, 18) } },
  "gpt-5.6-luna": { ...r(0.2, 0.25, 0.02, 1.2), long: { above: LONG, ...r(0.4, 0.5, 0.04, 1.8) } },
  "gpt-5.6-cyber": r(12.5, 15.625, 1.25, 75),
  "gpt-5.5": { ...r(5, 5, 0.5, 30), long: { above: LONG, ...r(10, 10, 1, 45) } },
  "gpt-5.5-cyber": r(12.5, 12.5, 1.25, 75),
  "gpt-5.4": { ...r(2.5, 2.5, 0.25, 15), long: { above: LONG, ...r(5, 5, 0.5, 22.5) } },
  "gpt-5.4-mini": r(0.75, 0.75, 0.075, 4.5),
  "gpt-5.4-nano": r(0.2, 0.2, 0.02, 1.25),
  "gpt-5.3-codex": r(1.75, 1.75, 0.175, 14),
  "gpt-5.2": r(1.75, 1.75, 0.175, 14),
  "gpt-5.1": r(1.25, 1.25, 0.125, 10),
  "gpt-5": r(1.25, 1.25, 0.125, 10),
  "gpt-5-mini": r(0.25, 0.25, 0.025, 2),
  "gpt-5-nano": r(0.05, 0.05, 0.005, 0.4),
};

const TABLE: Partial<Record<Source, Record<string, Price>>> = { "claude-code": CLAUDE, codex: OPENAI };

/** A trailing release date ("-20251001", "-2026-08-01") is not part of the price key. */
const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/** The list price of `model` for `source`, or undefined (Copilot, an unknown model, no model).
 * Only exact table keys match (after a trailing date is dropped), never a prefix: an unknown
 * variant stays unpriced rather than borrowing a sibling's price. */
export function priceOf(source: Source, model: string | undefined): Price | undefined {
  const table = TABLE[source];
  if (!table || model === undefined) return undefined;
  const key = model.toLowerCase().replace(DATED, "");
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** True when every token count, reasoning included, is absent or 0: such a call costs nothing whatever its model. */
function noTokens(t: Tokens): boolean {
  return !t.input && !t.output && !t.cacheRead && !t.cacheWrite && !t.reasoning;
}

/**
 * Estimated cost of a Claude Code or Codex record in nano-AIU (1 USD = 1e11), or undefined when
 * the model has no price, input or output was not logged, or (`cumulative`) a session total is
 * past the model's long-context threshold. Tokens follow the one convention (D47): `input` includes cache reads,
 * and for Claude Code also cache writes; reasoning is inside output. Codex logs cache writes
 * apart from input, so they are not taken out of it.
 */
export function estimateNanoAiu(rec: Pick<UsageRecord, "source" | "model" | "tokens">, o: { cumulative?: boolean } = {}): number | undefined {
  if (rec.source === "copilot") return undefined;
  const t = rec.tokens;
  if (noTokens(t)) return 0;
  // Without both input and output the cost cannot be established: unknown, never a smaller
  // figure that looks complete (review #1). Reasoning is inside output, so it never stands in for it.
  if (t.input === undefined || t.output === undefined) return undefined;
  const p = priceOf(rec.source, rec.model);
  if (!p) return undefined;
  const read = t.cacheRead ?? 0;
  const write = t.cacheWrite ?? 0;
  const input = t.input ?? 0;
  const uncached = Math.max(0, input - read - (rec.source === "claude-code" ? write : 0));
  const prompt = rec.source === "claude-code" ? input : input + write;
  // A cumulative total (a Codex session total) is many prompts: past the long-context threshold
  // it cannot tell which of them were long, so its cost is unknown (review #2).
  if (o.cumulative && p.long && prompt > p.long.above) return undefined;
  const rate: Rate = p.long && prompt > p.long.above ? p.long : p;
  const usd = (uncached * rate.input + read * rate.cacheRead + write * rate.cacheWrite + (t.output ?? 0) * rate.output) / 1e6;
  const nano = Math.round(usd * 1e11);
  return Number.isSafeInteger(nano) ? nano : undefined;
}
