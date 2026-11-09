// "Explain the money" (v0.6 Phase 1): pure aggregations over call records for the
// session ledger (1.1), prompts and the agent calls they triggered (1.2), cache figures
// (1.3) and the tool-definition share of input (1.5). They read only numbers and the
// fixed enums a UsageRecord keeps; session totals have no per-call data and are skipped.
//
// Token semantics (Phase 0 probe, 46 of 46 records): input = uncached + cache read +
// cache write; reasoning is inside output; toolTokenCount is part of input. A model whose
// records show cached > input is taken as reporting input apart from the cache (the
// per-model inference of Insights), and its input is then the uncached part. That
// inference is Copilot's only: Claude Code and Codex input is normalized at ingestion to
// include the cache (D47), even when a Copilot model shares the id (review finding #8).
import type { PromptConvention } from "./insights";
import { BUILT_IN_TOOLS, countTokens, promptOf, toolGroup } from "./store";
import type { CacheStats, CallRow, LastPrompt, Metric, ModelCache, PromptStats, SessionDetail, ToolOverhead, ToolOverheadGroup, UsageRecord } from "./types";

/** Calls a session ledger keeps in a snapshot (the newest ones); older calls are counted, not listed. */
export const DETAIL_ROWS = 200;

type Conventions = ReadonlyMap<string, PromptConvention>;

function emptyMetric(): Metric {
  return { sum: 0, reported: 0, missing: 0 };
}

function add(m: Metric, v: number | undefined): void {
  if (v === undefined) m.missing++;
  else {
    m.sum += v;
    m.reported++;
  }
}

/** Input not read from or written to the cache; undefined when it cannot be derived. */
export function uncachedOf(r: UsageRecord, conventions: Conventions): number | undefined {
  const t = r.tokens;
  if (t.input === undefined) return undefined;
  if (r.source === "copilot" && r.model !== undefined && conventions.get(r.model) === "separate") return t.input;
  if (t.cacheRead === undefined || t.cacheWrite === undefined) return undefined;
  return Math.max(0, t.input - t.cacheRead - t.cacheWrite);
}

/** Calls in session order: by sequence when both have one, else by time. */
function bySessionOrder(a: UsageRecord, b: UsageRecord): number {
  if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.timestampMs - b.timestampMs || a.key.localeCompare(b.key);
}

function groupBySession(calls: UsageRecord[]): Map<string, UsageRecord[]> {
  const out = new Map<string, UsageRecord[]>();
  for (const r of calls) {
    if (r.kind !== "call") continue;
    const g = out.get(r.sessionId);
    if (g) g.push(r);
    else out.set(r.sessionId, [r]);
  }
  for (const g of out.values()) g.sort(bySessionOrder);
  return out;
}

interface Chain {
  atMs: number;
  agentCalls: number;
  nano: number;
  priced: boolean;
  tokens: number;
  tokensKnown: boolean;
}

/** Prompt chains of one session's calls (already in session order). */
function chainsOf(calls: UsageRecord[], acc: { notLinked: number; unknown: number }): Chain[] {
  const chains: Chain[] = [];
  let open: Chain | undefined;
  const join = (c: Chain, r: UsageRecord) => {
    if (r.nanoAiu === undefined) c.priced = false;
    else c.nano += r.nanoAiu;
    // A call that logged only one side leaves the chain's tokens incomplete (as store.countTokens):
    // such a prompt is left out of the average rather than counted short.
    if (r.tokens.input === undefined || r.tokens.output === undefined) c.tokensKnown = false;
    c.tokens += (r.tokens.input ?? 0) + (r.tokens.output ?? 0);
  };
  for (const r of calls) {
    if (r.initiator === "user") {
      open = { atMs: r.timestampMs, agentCalls: 0, nano: 0, priced: true, tokens: 0, tokensKnown: true };
      chains.push(open);
      join(open, r);
    } else if (r.initiator === "agent" && open) {
      open.agentCalls++;
      join(open, r);
    } else if (r.initiator === undefined) acc.unknown++;
    else acc.notLinked++;
  }
  return chains;
}

/** Prompts and the agent calls they triggered, over call records of any sessions. */
export function promptStats(calls: UsageRecord[]): PromptStats {
  const acc = { notLinked: 0, unknown: 0 };
  const out: PromptStats = { prompts: 0, agentCalls: 0, notLinked: 0, unknown: 0, nanoAiu: emptyMetric(), tokens: emptyMetric() };
  for (const recs of groupBySession(calls).values()) {
    for (const c of chainsOf(recs, acc)) {
      out.prompts++;
      out.agentCalls += c.agentCalls;
      add(out.nanoAiu, c.priced ? c.nano : undefined);
      add(out.tokens, c.tokensKnown ? c.tokens : undefined);
    }
  }
  out.notLinked = acc.notLinked;
  out.unknown = acc.unknown;
  return out;
}

/** The newest prompt chain among `calls` (one session's records), or undefined. */
export function lastPrompt(calls: UsageRecord[]): LastPrompt | undefined {
  const recs = calls.filter((r) => r.kind === "call").sort(bySessionOrder);
  const c = chainsOf(recs, { notLinked: 0, unknown: 0 }).at(-1);
  if (!c) return undefined;
  return { atMs: c.atMs, agentCalls: c.agentCalls, ...(c.priced && { nanoAiu: c.nano }), ...(c.tokensKnown && { tokens: c.tokens }) };
}

function emptyCache(): CacheStats {
  return { prompt: emptyMetric(), cacheRead: emptyMetric(), uncachedNano: emptyMetric(), atReadRateNano: emptyMetric(), pairedUncachedNano: emptyMetric(), cacheReadNano: emptyMetric(), cacheWriteNano: emptyMetric() };
}

function addCache(c: CacheStats, r: UsageRecord, conventions: Conventions): void {
  add(c.prompt, promptOf(r, conventions));
  add(c.cacheRead, r.tokens.cacheRead);
  const tc = r.typeCost;
  // The uncached-input cost is known whenever the call has a per-type split; the
  // comparison at the cache-read rate pairs both figures over the same calls.
  const paired = tc?.inputAtReadRate !== undefined;
  add(c.uncachedNano, tc?.input);
  add(c.atReadRateNano, paired ? tc!.inputAtReadRate : undefined);
  add(c.pairedUncachedNano, paired ? tc!.input : undefined);
  add(c.cacheReadNano, tc?.cacheRead);
  add(c.cacheWriteNano, tc?.cacheWrite);
}

/** Cache figures over call records (session totals skipped). */
export function cacheStats(calls: UsageRecord[], conventions: Conventions): CacheStats {
  const c = emptyCache();
  for (const r of calls) if (r.kind === "call") addCache(c, r, conventions);
  return c;
}

/** Cache figures per model, costliest uncached input first (then by prompt tokens, then id). */
export function modelCacheStats(calls: UsageRecord[], conventions: Conventions): ModelCache[] {
  const by = new Map<string, ModelCache>();
  for (const r of calls) {
    if (r.kind !== "call" || r.model === undefined) continue;
    let c = by.get(r.model);
    if (!c) {
      c = { model: r.model, ...emptyCache() };
      by.set(r.model, c);
    }
    addCache(c, r, conventions);
  }
  return [...by.values()].sort((a, b) => b.uncachedNano.sum - a.uncachedNano.sum || b.prompt.sum - a.prompt.sum || a.model.localeCompare(b.model));
}

/** Tool-definition tokens as a share of input, over call records, with per-group rows. */
export function toolOverhead(calls: UsageRecord[], conventions: Conventions): ToolOverhead {
  const out: ToolOverhead = { calls: 0, missing: 0, toolTokens: 0, input: 0, availableTools: emptyMetric(), groups: [] };
  const groups = new Map<string, ToolOverheadGroup>();
  const bump = (kind: ToolOverheadGroup["kind"], name: string, tt: number, input: number) => {
    const key = `${kind}|${name}`;
    let g = groups.get(key);
    if (!g) {
      g = { kind, name, calls: 0, toolTokens: 0, input: 0 };
      groups.set(key, g);
    }
    g.calls++;
    g.toolTokens += tt;
    g.input += input;
  };
  for (const r of calls) {
    if (r.kind !== "call") continue;
    add(out.availableTools, r.availableTools);
    const input = promptOf(r, conventions);
    if (r.toolTokens === undefined || input === undefined) {
      out.missing++;
      continue;
    }
    // A logged figure above input would break "part of input": clamp, never add on top.
    const tt = Math.min(r.toolTokens, input);
    out.calls++;
    out.toolTokens += tt;
    out.input += input;
    const used = new Set<string>();
    for (const name of Object.keys(r.tools ?? {})) used.add(BUILT_IN_TOOLS[r.source].has(name) ? "builtIn|" : `added|${toolGroup(name)}`);
    if (used.size === 0) bump("none", "", tt, input);
    for (const u of used) {
      const bar = u.indexOf("|");
      bump(u.slice(0, bar) as ToolOverheadGroup["kind"], u.slice(bar + 1), tt, input);
    }
  }
  out.groups = [...groups.values()].sort((a, b) => b.toolTokens - a.toolTokens || b.calls - a.calls || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return out;
}

function rowOf(r: UsageRecord, conventions: Conventions): CallRow {
  const t = r.tokens;
  const row: CallRow = { timestampMs: r.timestampMs };
  if (r.model !== undefined) row.model = r.model;
  if (r.initiator !== undefined) row.initiator = r.initiator;
  if (r.finishReason !== undefined) row.finishReason = r.finishReason;
  const uncached = uncachedOf(r, conventions);
  if (uncached !== undefined) row.uncached = uncached;
  if (t.cacheRead !== undefined) row.cacheRead = t.cacheRead;
  if (t.cacheWrite !== undefined) row.cacheWrite = t.cacheWrite;
  if (t.output !== undefined) row.output = t.output;
  if (t.reasoning !== undefined) row.reasoning = t.reasoning;
  const prompt = promptOf(r, conventions);
  if (prompt !== undefined) row.prompt = prompt;
  if (r.toolTokens !== undefined) row.toolTokens = r.toolTokens;
  if (r.nanoAiu !== undefined) row.nanoAiu = r.nanoAiu;
  return row;
}

/**
 * The ledger of session `sessionId` over `records` (the session's records in scope).
 * At most `limit` rows, the newest ones, oldest first; older calls are counted in `omitted`.
 */
export function sessionDetail(sessionId: string, records: UsageRecord[], conventions: Conventions, limit = DETAIL_ROWS): SessionDetail {
  const calls = records.filter((r) => r.kind === "call" && r.sessionId === sessionId).sort(bySessionOrder);
  const nanoAiu = emptyMetric();
  const tokens = emptyMetric();
  for (const r of calls) {
    add(nanoAiu, r.nanoAiu);
    countTokens(tokens, r);
  }
  const kept = calls.slice(Math.max(0, calls.length - limit));
  const totalsOnly = calls.length === 0 && records.some((r) => r.kind === "sessionTotal" && r.sessionId === sessionId);
  return {
    sessionId,
    calls: calls.length,
    rows: kept.map((r) => rowOf(r, conventions)),
    omitted: calls.length - kept.length,
    ...(totalsOnly && { sessionTotal: true }),
    nanoAiu,
    tokens,
    prompts: promptStats(calls),
    cache: cacheStats(calls, conventions),
    tools: toolOverhead(calls, conventions),
  };
}
