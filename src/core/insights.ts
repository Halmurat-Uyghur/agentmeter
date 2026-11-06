// Insights (D32; design note O2, rules I2 and I3 only). Pure: they read only
// fields a UsageRecord already keeps, so the privacy surface is unchanged.
// Every rule needs logged AIU, is computed from per-call records only (session
// totals have no per-call data) and never claims a saving.
import type { Insight, InsightsView, SessionSummary, UsageRecord } from "./types";

/** Sessions whose late calls cost this many times their early ones are flagged (D24). */
export const GROWTH_FLAG = 3;

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

export type PromptConvention = "included" | "separate";

/**
 * Whether a model's `input` already includes cached tokens, inferred per model:
 * "separate" once any call has cacheRead + cacheWrite > input (impossible if
 * input included them), else "included". A wrong "included" only makes I3 fire less.
 */
export function promptConventions(records: UsageRecord[]): Map<string, PromptConvention> {
  return scanCalls(records).conventions;
}

function promptTokens(r: UsageRecord, convention: PromptConvention | undefined): number {
  const t = r.tokens;
  return convention === "separate" ? (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : (t.input ?? 0);
}

/**
 * One pass over every call record: the prompt convention per model, and the
 * key of each session's first call (the lowest sequence, else the earliest timestamp).
 */
function scanCalls(records: UsageRecord[]): { conventions: Map<string, PromptConvention>; firsts: Set<string> } {
  const conventions = new Map<string, PromptConvention>();
  const first = new Map<string, UsageRecord>();
  const before = (a: UsageRecord, b: UsageRecord) =>
    a.sequence !== undefined && b.sequence !== undefined ? a.sequence < b.sequence : a.timestampMs < b.timestampMs;
  for (const r of records) {
    if (r.kind !== "call") continue;
    if (r.model !== undefined) {
      const t = r.tokens;
      const cached = (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
      if (t.input !== undefined && cached > t.input) conventions.set(r.model, "separate");
      else if (!conventions.has(r.model)) conventions.set(r.model, "included");
    }
    const cur = first.get(r.sessionId);
    if (!cur || before(r, cur)) first.set(r.sessionId, r);
  }
  const firsts = new Set<string>();
  for (const r of first.values()) firsts.add(r.key);
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
  };
}

/** I3: low cache reuse on a model, over the month's eligible calls; the costliest model wins. */
function cacheReuse(monthRecords: UsageRecord[], allRecords: UsageRecord[], monthNano: number): Insight | undefined {
  const { conventions, firsts } = scanCalls(allRecords);
  const byModel = new Map<string, { calls: number; sessions: Set<string>; cacheRead: number; prompt: number; nano: number; priced: number; tokens: number }>();
  for (const r of monthRecords) {
    if (r.kind !== "call" || r.model === undefined || firsts.has(r.key)) continue;
    if (r.tokens.input === undefined || r.tokens.cacheRead === undefined) continue;
    const prompt = promptTokens(r, conventions.get(r.model));
    if (prompt < CACHE_MIN_PROMPT) continue;
    let g = byModel.get(r.model);
    if (!g) {
      g = { calls: 0, sessions: new Set(), cacheRead: 0, prompt: 0, nano: 0, priced: 0, tokens: 0 };
      byModel.set(r.model, g);
    }
    g.calls++;
    g.sessions.add(r.sessionId);
    g.cacheRead += r.tokens.cacheRead;
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
      g.calls >= CACHE_MIN_CALLS &&
      g.sessions.size >= CACHE_MIN_SESSIONS &&
      g.prompt / g.calls >= CACHE_MIN_MEAN_PROMPT &&
      share < CACHE_LOW_SHARE &&
      g.priced > 0 &&
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
 * and each session's first call; `monthNanoAiu` the month's logged AIU.
 */
export function computeInsights(o: {
  sessions: SessionSummary[];
  monthRecords: UsageRecord[];
  allRecords: UsageRecord[];
  monthNanoAiu: number;
}): InsightsView {
  const items = [contextGrowth(o.sessions, o.monthNanoAiu), cacheReuse(o.monthRecords, o.allRecords, o.monthNanoAiu)]
    .filter((x): x is Insight => x !== undefined)
    .sort((a, b) => b.nanoAiu - a.nanoAiu || a.id.localeCompare(b.id));
  return {
    items,
    coverage: {
      callSessions: o.sessions.filter((s) => !s.sessionTotal).length,
      totalsOnlySessions: o.sessions.filter((s) => s.sessionTotal).length,
    },
  };
}
