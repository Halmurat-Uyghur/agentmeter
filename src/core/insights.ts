// Insights (D32; design note O2, rules I1, I2 and I3). Pure: they read only
// fields a UsageRecord already keeps, so the privacy surface is unchanged.
// Every rule needs logged AIU, is computed from per-call records only (session
// totals have no per-call data) and never claims a saving.
import { pairedCache } from "./store";
import type { Insight, InsightsView, SessionSummary, UsageRecord } from "./types";

/** Sessions whose late calls cost this many times their early ones are flagged (D24). */
export const GROWTH_FLAG = 3;
/** A flagged session's growth is put down to its context only when the prompt tokens of its
 * last 5 calls are at least this many times those of its first 5 (SessionSummary.inputGrowth). */
export const INPUT_GROWTH_FLAG = 2;

/** Whether `s`'s later calls cost more because their prompts grew, not only their price. */
export function contextGrew(s: { inputGrowth?: number }): boolean {
  return s.inputGrowth !== undefined && s.inputGrowth >= INPUT_GROWTH_FLAG;
}

/** What each of SessionSummary.growthCauses names in the panel's copy. */
export const GROWTH_CAUSE_TEXT: Record<"model" | "output" | "cache", string> = {
  model: "a switch to another model",
  output: "longer replies",
  cache: "fewer cache reads",
};

const NANO_PER_USD = 1e11;
/** Shared floors: the flagged AIU must reach $1.00 and 5 in 100 of the viewed month's AIU. */
const FLOOR_NANO = 1 * NANO_PER_USD;
const FLOOR_MONTH_SHARE = 0.05;
/** I2: a growing session must itself have cost at least $0.50. */
const GROWTH_SESSION_FLOOR_NANO = 0.5 * NANO_PER_USD;
/** I3 thresholds (O2). */
const CACHE_MIN_PROMPT = 4_096;
const CACHE_MIN_CALLS = 20;
const CACHE_MIN_SESSIONS = 3;
const CACHE_MIN_MEAN_PROMPT = 20_000;
const CACHE_LOW_SHARE = 0.6;

/** I1: a model's long-context price threshold in prompt tokens. Only entries GitHub's table
 * states explicitly; exact id after lower-casing, or with `prefix`, the id followed by the
 * end or a "-" / "." (so "grok-4-fast" matches "grok-4", "grok-40" does not). */
export interface LongContextEntry {
  id: string;
  prefix?: boolean;
  thresholdTokens: number;
}
// GitHub Docs "Models and pricing" (every model with a "Long context" row), checked
// 2026-11-08. Unknown ids never fire.
export const LONG_CONTEXT_THRESHOLDS: readonly LongContextEntry[] = [
  { id: "claude-haiku-5.5", thresholdTokens: 100_000 },
  { id: "gpt-5.6-luna", thresholdTokens: 200_000 },
  { id: "gpt-5.6-sol", thresholdTokens: 272_000 },
  { id: "gpt-5.6-terra", thresholdTokens: 272_000 },
  { id: "gpt-6-astra", thresholdTokens: 272_000 },
  { id: "gpt-6-luna", thresholdTokens: 272_000 },
  { id: "gpt-6-sol", thresholdTokens: 272_000 },
  { id: "gpt-6.1-sol", thresholdTokens: 272_000 },
  { id: "gpt-6.1-terra", thresholdTokens: 272_000 },
  { id: "grok-4", prefix: true, thresholdTokens: 200_000 },
];
/** I1 fires at 3 priced calls over the threshold whose AIU reaches $0.50 (no month-share floor).
 * Counting priced calls keeps the card's "these calls cost" true of the calls it counts. */
const LONG_MIN_CALLS = 3;
const LONG_FLOOR_NANO = 0.5 * NANO_PER_USD;

/** The long-context threshold of `model`, or undefined when the table has none. */
export function longContextThreshold(model: string): number | undefined {
  const m = model.toLowerCase();
  for (const e of LONG_CONTEXT_THRESHOLDS) {
    if (m === e.id) return e.thresholdTokens;
    if (e.prefix && m.startsWith(e.id) && /^[-.]/.test(m.slice(e.id.length))) return e.thresholdTokens;
  }
  return undefined;
}

export type PromptConvention = "included" | "separate";

/**
 * Whether a model's `input` already includes cached tokens, inferred per model from
 * Copilot calls only: "separate" once any call has cacheRead + cacheWrite > input
 * (impossible if input included them), else "included". A wrong "included" only makes
 * I3 fire less. Other sources' input always includes cached tokens (D47).
 */
export function promptConventions(records: UsageRecord[]): Map<string, PromptConvention> {
  return scanCalls(records).conventions;
}

function promptTokens(r: UsageRecord, convention: PromptConvention | undefined): number {
  const t = r.tokens;
  return r.source === "copilot" && convention === "separate" ? (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : (t.input ?? 0);
}

/** What the rules need from every call record read: the prompt convention per model, and
 * the key of each session's first call (the lowest sequence, else the earliest timestamp). */
export interface CallScan {
  conventions: Map<string, PromptConvention>;
  firsts: Set<string>;
}

/** A scan that `extendScan` can continue with later calls. */
export interface ScanState extends CallScan {
  /** each session's first call */
  first: Map<string, UsageRecord>;
  /** sessions with a call that carries a sequence number, and those of them that also have a call without one */
  sequenced: Set<string>;
  mixed: Set<string>;
}

/** One pass over every call record, in the order given (two calls of a session that tie keep the earlier one in that order). */
export function scanCalls(records: UsageRecord[]): ScanState {
  const conventions = new Map<string, PromptConvention>();
  const first = new Map<string, UsageRecord>();
  const sequenced = new Set<string>();
  const mixed = new Set<string>();
  const before = (a: UsageRecord, b: UsageRecord) =>
    a.sequence !== undefined && b.sequence !== undefined ? a.sequence < b.sequence : a.timestampMs < b.timestampMs;
  for (const r of records) {
    if (r.kind !== "call") continue;
    if (r.model !== undefined && r.source === "copilot") {
      const t = r.tokens;
      const cached = (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
      if (t.input !== undefined && cached > t.input) conventions.set(r.model, "separate");
      else if (!conventions.has(r.model)) conventions.set(r.model, "included");
    }
    const cur = first.get(r.sessionId);
    if (r.sequence !== undefined) {
      if (cur !== undefined && !sequenced.has(r.sessionId)) mixed.add(r.sessionId);
      sequenced.add(r.sessionId);
    } else if (sequenced.has(r.sessionId)) mixed.add(r.sessionId);
    if (!cur || before(r, cur)) first.set(r.sessionId, r);
  }
  const firsts = new Set<string>();
  for (const r of first.values()) firsts.add(r.key);
  return { conventions, firsts, first, sequenced, mixed };
}

/**
 * The scan of `earlier`'s calls and `later` together, without reading `earlier`'s calls again.
 * One pass over them all could meet them in another order than "earlier's, then later's", and
 * the first call of a session depends on that order when two of its calls tie, or when only
 * some of its calls carry a sequence number (a sequence orders two calls only if both have
 * one). In those cases the answer is not known from here: undefined, and the caller scans
 * every call. Otherwise the result is the one pass's own: a session's first call is the lower
 * of its two firsts, and a model's convention is "separate" if either side found it so.
 */
export function extendScan(earlier: ScanState, later: UsageRecord[]): CallScan | undefined {
  const next = scanCalls(later);
  const firsts = new Set(earlier.firsts);
  for (const [sessionId, b] of next.first) {
    const a = earlier.first.get(sessionId);
    if (a === undefined) {
      firsts.add(b.key);
      continue;
    }
    const sequenced = earlier.sequenced.has(sessionId);
    if (sequenced !== next.sequenced.has(sessionId) || earlier.mixed.has(sessionId) || next.mixed.has(sessionId)) return undefined;
    const x = sequenced ? a.sequence! : a.timestampMs;
    const y = sequenced ? b.sequence! : b.timestampMs;
    if (x === y) return undefined;
    if (y < x) {
      firsts.delete(a.key);
      firsts.add(b.key);
    }
  }
  const conventions = new Map(earlier.conventions);
  for (const [model, c] of next.conventions) if (c === "separate" || !conventions.has(model)) conventions.set(model, c);
  return { conventions, firsts };
}

function clearsFloors(nano: number, monthNano: number): boolean {
  return nano >= FLOOR_NANO && nano >= FLOOR_MONTH_SHARE * monthNano;
}

/** I2: sessions that grew costly (▲, at least $0.50), over every session of the month. */
function contextGrowth(sessions: SessionSummary[], monthNano: number): Insight | undefined {
  const flagged = sessions
    .filter((s) => !s.sessionTotal && s.growth !== undefined && s.growth >= GROWTH_FLAG && s.excessNanoAiu !== undefined)
    .filter((s) => s.nanoAiu.reported > 0 && s.nanoAiu.sum >= GROWTH_SESSION_FLOOR_NANO)
    .sort((a, b) => b.excessNanoAiu! - a.excessNanoAiu! || a.sessionId.localeCompare(b.sessionId));
  if (flagged.length === 0) return undefined;
  const excess = flagged.reduce((a, s) => a + s.excessNanoAiu!, 0);
  if (!clearsFloors(excess, monthNano)) return undefined;
  return {
    id: "context-growth",
    nanoAiu: excess,
    tokens: flagged.reduce((a, s) => a + s.tokens.sum, 0),
    calls: flagged.reduce((a, s) => a + s.calls, 0),
    sessions: flagged.length,
    top: flagged.slice(0, 3).map((s) => ({ sessionId: s.sessionId, ...(s.label !== undefined && { label: s.label }), growth: s.growth! })),
    // Per-session, not "any": one growing session must not speak for the others.
    inputGrew: flagged.every(contextGrew),
    inputGrewSessions: flagged.filter(contextGrew).length,
    inputUnmeasuredSessions: flagged.filter((s) => s.inputGrowth === undefined).length,
    // Where input was logged and did not grow: only the causes their own calls show.
    flatCauses: flatCauses(flagged.filter((s) => s.inputGrowth !== undefined && !contextGrew(s))),
  };
}

function flatCauses(flat: SessionSummary[]): { model: number; output: number; cache: number; unclear: number } {
  const out = { model: 0, output: 0, cache: 0, unclear: 0 };
  for (const s of flat) {
    if (s.growthCauses === undefined || s.growthCauses.length === 0) out.unclear++;
    else for (const c of s.growthCauses) out[c]++;
  }
  return out;
}

/** I1: calls past a model's long-context price threshold; the costliest model wins. */
function longContext(monthRecords: UsageRecord[], conventions: Map<string, PromptConvention>): Insight | undefined {
  const byModel = new Map<string, { threshold: number; calls: number; sessions: Set<string>; nano: number; priced: number; tokens: number; max: number }>();
  for (const r of monthRecords) {
    // Copilot calls only: other sources log no cost (D46), so their calls would inflate the
    // counts and the largest prompt without being part of the AIU the card states.
    if (r.source !== "copilot" || r.kind !== "call" || r.model === undefined || r.tokens.input === undefined) continue;
    const threshold = longContextThreshold(r.model);
    if (threshold === undefined) continue;
    const prompt = promptTokens(r, conventions.get(r.model));
    if (prompt <= threshold) continue;
    let g = byModel.get(r.model);
    if (!g) {
      g = { threshold, calls: 0, sessions: new Set(), nano: 0, priced: 0, tokens: 0, max: 0 };
      byModel.set(r.model, g);
    }
    g.calls++;
    g.sessions.add(r.sessionId);
    g.tokens += (r.tokens.input ?? 0) + (r.tokens.output ?? 0);
    g.max = Math.max(g.max, prompt);
    if (r.nanoAiu !== undefined) {
      g.nano += r.nanoAiu;
      g.priced++;
    }
  }
  let best: Insight | undefined;
  for (const [model, g] of [...byModel].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fires = g.priced >= LONG_MIN_CALLS && g.nano >= LONG_FLOOR_NANO;
    if (!fires || (best && best.nanoAiu >= g.nano)) continue;
    best = { id: "long-context", nanoAiu: g.nano, tokens: g.tokens, calls: g.calls, sessions: g.sessions.size, model, thresholdTokens: g.threshold, maxPromptTokens: g.max };
  }
  return best;
}

/** I3: low cache reuse on a model, over the month's eligible calls; the costliest model wins. */
function cacheReuse(monthRecords: UsageRecord[], scan: CallScan, monthNano: number): Insight | undefined {
  const { conventions, firsts } = scan;
  const byModel = new Map<string, { calls: number; sessions: Set<string>; cacheRead: number; prompt: number; nano: number; priced: number; tokens: number }>();
  for (const r of monthRecords) {
    // Copilot calls only (D46): an unpriced Claude Code or Codex call of the same model id
    // would lower the share without adding to the AIU, firing the card on calls it cannot price.
    if (r.source !== "copilot" || r.kind !== "call" || r.model === undefined || firsts.has(r.key)) continue;
    // Paired, like every other cache share: only calls that reported both figures.
    const pair = pairedCache(r, conventions);
    if (pair === undefined) continue;
    const prompt = pair.prompt;
    if (prompt < CACHE_MIN_PROMPT) continue;
    let g = byModel.get(r.model);
    if (!g) {
      g = { calls: 0, sessions: new Set(), cacheRead: 0, prompt: 0, nano: 0, priced: 0, tokens: 0 };
      byModel.set(r.model, g);
    }
    g.calls++;
    g.sessions.add(r.sessionId);
    g.cacheRead += pair.read;
    g.prompt += prompt;
    g.tokens += (r.tokens.input ?? 0) + (r.tokens.output ?? 0);
    if (r.nanoAiu !== undefined) {
      g.nano += r.nanoAiu;
      g.priced++;
    }
  }
  let best: Insight | undefined;
  for (const [model, g] of [...byModel].sort((a, b) => a[0].localeCompare(b[0]))) {
    const share = g.prompt > 0 ? g.cacheRead / g.prompt : 1;
    const fires =
      g.priced >= CACHE_MIN_CALLS && // priced calls, as I1: the stated cost covers the count
      g.sessions.size >= CACHE_MIN_SESSIONS &&
      g.prompt / g.calls >= CACHE_MIN_MEAN_PROMPT &&
      share < CACHE_LOW_SHARE &&
      clearsFloors(g.nano, monthNano);
    if (!fires || (best && best.nanoAiu >= g.nano)) continue;
    best = { id: "cache-reuse", nanoAiu: g.nano, tokens: g.tokens, calls: g.calls, sessions: g.sessions.size, model, share, meanPromptTokens: g.prompt / g.calls };
  }
  return best;
}

/**
 * Insights for the viewed month. `sessions` must be every session of the month
 * (not the displayed top rows); `monthRecords` the month's records with the
 * filters applied; `allRecords` every record read, for the prompt convention
 * and each session's first call (or `scan`, when the caller already has their
 * scan); `monthNanoAiu` the month's logged AIU.
 */
export function computeInsights(o: {
  sessions: SessionSummary[];
  monthRecords: UsageRecord[];
  allRecords?: UsageRecord[];
  scan?: CallScan;
  monthNanoAiu: number;
}): InsightsView {
  const scan = o.scan ?? scanCalls(o.allRecords ?? []);
  // Copilot sessions only, like the other two rules: other sources log no cost (D46), so their
  // estimated costs must neither fire the growth rule nor count in its coverage.
  const sessions = o.sessions.filter((s) => (s.source ?? "copilot") === "copilot");
  const items = [longContext(o.monthRecords, scan.conventions), contextGrowth(sessions, o.monthNanoAiu), cacheReuse(o.monthRecords, scan, o.monthNanoAiu)]
    .filter((x): x is Insight => x !== undefined)
    .sort((a, b) => b.nanoAiu - a.nanoAiu || a.id.localeCompare(b.id));
  return {
    items,
    coverage: {
      callSessions: sessions.filter((s) => !s.sessionTotal).length,
      totalsOnlySessions: sessions.filter((s) => s.sessionTotal).length,
    },
  };
}
