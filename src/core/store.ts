// In-memory, deduplicating aggregation of UsageRecords. A record seen in
// several files counts once; it is dropped only when every file that held it
// has been reset. Metrics keep "not reported" apart from zero. A session's
// totals from session.shutdown are hidden while the same session, or the same
// session folder, has any per-call record, so no session is counted twice (D29).
// Call records and session totals live in separate key namespaces, and each
// source has its own (D40). USD metrics count Copilot records only (D46).

import type { PromptConvention } from "./insights";
import type { Activity, Counts, DayStats, DayTotals, GroupSummary, Metric, MonthSummary, SessionSummary, Source, ToolSummary, Totals, UsageRecord } from "./types";

export const UNKNOWN_MODEL = "(unknown model)";

interface Entry {
  record: UsageRecord;
  /** file → folderId of the file; a call key counts as held by every folder here (D29) */
  files: Map<string, string>;
}

function holds(e: Entry, folderId: string): boolean {
  for (const f of e.files.values()) if (f === folderId) return true;
  return false;
}

function emptyMetric(): Metric {
  return { sum: 0, reported: 0, missing: 0 };
}

function emptyCounts(): Counts {
  return {
    records: 0,
    calls: 0,
    callsMissing: 0,
    sessionTotals: 0,
    input: emptyMetric(),
    output: emptyMetric(),
    cacheRead: emptyMetric(),
    cacheWrite: emptyMetric(),
    reasoning: emptyMetric(),
    durationMs: emptyMetric(),
    nanoAiu: emptyMetric(),
    callNanoAiu: emptyMetric(),
  };
}

/** A Totals whose byModel has no prototype, so a log-supplied model id can never
 * resolve to Object.prototype (D28). */
function emptyTotals(): Totals {
  return { ...emptyCounts(), byModel: Object.create(null) as Record<string, Counts> };
}

function count(m: Metric, v: number | undefined): void {
  if (v === undefined) {
    m.missing += 1;
  } else {
    m.sum += v;
    m.reported += 1;
  }
}

/** Model calls a record stands for: 1 for a call, requests.count (or 0) for a session total. */
export function callsOf(r: UsageRecord): number {
  return r.kind === "sessionTotal" ? (r.calls ?? 0) : 1;
}

/** 1 for a session total that did not log requests.count, else 0. */
function callsMissingOf(r: UsageRecord): number {
  return r.kind === "sessionTotal" && r.calls === undefined ? 1 : 0;
}

/** Only Copilot logs cost: other sources' records neither report nor miss USD (D46). */
function pricedSource(r: UsageRecord): boolean {
  return r.source === "copilot";
}

/** Bumps the per-source record count in `m` (a prototype-free map). */
function bumpSource(m: Partial<Record<Source, number>>, s: Source): void {
  m[s] = (m[s] ?? 0) + 1;
}

function accumulate(c: Counts, r: UsageRecord): void {
  c.records += 1;
  c.calls += callsOf(r);
  c.callsMissing += callsMissingOf(r);
  const priced = pricedSource(r);
  if (r.kind === "sessionTotal") c.sessionTotals += 1;
  else if (priced) count(c.callNanoAiu, r.nanoAiu);
  count(c.input, r.tokens.input);
  count(c.output, r.tokens.output);
  count(c.cacheRead, r.tokens.cacheRead);
  count(c.cacheWrite, r.tokens.cacheWrite);
  count(c.reasoning, r.tokens.reasoning);
  count(c.durationMs, r.durationMs);
  if (priced) count(c.nanoAiu, r.nanoAiu);
  bumpSource((c.sources ??= Object.create(null) as Partial<Record<Source, number>>), r.source);
}

/** Adds `r` to `totals`, its model and its source. */
function accumulateTotals(totals: Totals, r: UsageRecord): void {
  accumulate(totals, r);
  accumulate((totals.byModel[r.model ?? UNKNOWN_MODEL] ??= emptyCounts()), r);
  const bySource = (totals.bySource ??= Object.create(null) as Partial<Record<Source, Counts>>);
  accumulate((bySource[r.source] ??= emptyCounts()), r);
}

/** Store key of a record: call keys and session-total keys never share a namespace,
 * so a log-supplied usageId can never equal (and drop) a "shutdown:…" key (N10), and
 * an id from one source's log can never equal another source's (D40). */
function entryKey(r: UsageRecord): string {
  return `${r.kind === "call" ? "c" : "t"}|${r.source}|${r.key}`;
}

/** Fields a later line of the same call in the same file replaces (D42 repeats). */
const REPEAT_FIELDS = [
  "tokens", "timestampMs", "model", "finishReason", "sequence", "durationMs", "nanoAiu", "typeCost", "initiator", "toolTokens", "availableTools",
] as const satisfies readonly (keyof UsageRecord)[];

/** At most this many tool names per record. */
const MAX_TOOL_NAMES = 64;

/** `r` with the repeat fields of `next` and the tool counts of both, summed per name. */
function mergeRepeat(r: UsageRecord, next: UsageRecord): UsageRecord {
  const out: UsageRecord = { ...r };
  const o = out as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  for (const f of REPEAT_FIELDS) {
    if (n[f] === undefined) delete o[f];
    else o[f] = n[f];
  }
  if (next.tools !== undefined) {
    const tools: Record<string, number> = Object.create(null);
    for (const [name, k] of Object.entries(r.tools ?? {})) tools[name] = k;
    let names = Object.keys(tools).length;
    for (const [name, k] of Object.entries(next.tools)) {
      if (tools[name] !== undefined) tools[name] += k;
      else if (names < MAX_TOOL_NAMES) {
        tools[name] = k;
        names++;
      }
    }
    out.tools = tools;
  }
  return out;
}

function bump(m: Map<string, number>, id: string, by: 1 | -1): void {
  const n = (m.get(id) ?? 0) + by;
  if (n > 0) m.set(id, n);
  else m.delete(id);
}

export class UsageStore {
  private readonly entries = new Map<string, Entry>();
  /** sessionId → call records held; a session in here hides its session totals */
  private readonly callsPerSession = new Map<string, number>();
  /** folderId → call keys held by its files; a folder in here hides its session totals,
   * whatever sessionId its call records carry (a resumed, forked or copied session) */
  private readonly callsPerFolder = new Map<string, number>();
  /** folderId → store keys of its current session-total records */
  private readonly totalKeys = new Map<string, string[]>();

  /** Returns whether the store changed. A key already known from another file counts once
   * (`file` is still recorded for it); a later call line of the same key in the same file
   * replaces the record's figures and adds its tools (D42 repeats). */
  add(r: UsageRecord, file: string): boolean {
    const key = entryKey(r);
    const existing = this.entries.get(key);
    if (existing && r.kind === "call" && existing.files.has(file)) {
      const merged = mergeRepeat(existing.record, r);
      if (JSON.stringify(merged) === JSON.stringify(existing.record)) return false;
      existing.record = merged;
      return true;
    }
    if (existing) {
      // A copied folder delivers the same key: that folder holds it too (D29).
      if (r.kind === "call" && !existing.files.has(file) && !holds(existing, r.folderId)) bump(this.callsPerFolder, r.folderId, 1);
      if (!existing.files.has(file)) existing.files.set(file, r.folderId);
      return false;
    }
    this.entries.set(key, { record: r, files: new Map([[file, r.folderId]]) });
    if (r.kind === "call") {
      bump(this.callsPerSession, r.sessionId, 1);
      bump(this.callsPerFolder, r.folderId, 1);
    }
    return true;
  }

  /**
   * Replaces folder `folderId`'s session totals with `records` (held by `file`):
   * the last shutdown line wins and totals are never summed. Returns whether
   * anything changed.
   */
  setSessionTotals(folderId: string, file: string, records: UsageRecord[]): boolean {
    const old = this.totalKeys.get(folderId) ?? [];
    const same =
      old.length === records.length &&
      records.every((r, i) => {
        const e = this.entries.get(old[i]!);
        return e !== undefined && entryKey(r) === old[i] && e.files.size === 1 && e.files.has(file) && JSON.stringify(e.record) === JSON.stringify(r);
      });
    if (same) return false;
    for (const key of old) this.entries.delete(key);
    const keys: string[] = [];
    for (const r of records) {
      const key = entryKey(r);
      if (r.kind !== "sessionTotal" || this.entries.has(key)) continue;
      this.entries.set(key, { record: r, files: new Map([[file, folderId]]) });
      keys.push(key);
    }
    if (keys.length > 0) this.totalKeys.set(folderId, keys);
    else this.totalKeys.delete(folderId);
    return true;
  }

  /** Forgets `file`; records no other file holds are deleted. A folder stops holding a
   * call key once none of its files does. */
  resetFile(file: string): void {
    for (const [key, entry] of this.entries) {
      const folderId = entry.files.get(file);
      if (folderId === undefined) continue;
      entry.files.delete(file);
      const r = entry.record;
      if (r.kind === "call" && !holds(entry, folderId)) bump(this.callsPerFolder, folderId, -1);
      if (entry.files.size === 0) {
        this.entries.delete(key);
        if (r.kind === "call") {
          bump(this.callsPerSession, r.sessionId, -1);
        } else {
          const keys = this.totalKeys.get(r.folderId)?.filter((k) => k !== key) ?? [];
          if (keys.length > 0) this.totalKeys.set(r.folderId, keys);
          else this.totalKeys.delete(r.folderId);
        }
      }
    }
  }

  /** A call record always counts; a session total only while neither its session nor its
   * folder has a call record (review 1: sourceSessionId may differ from the folder). */
  private visible(r: UsageRecord): boolean {
    return r.kind === "call" || (!this.callsPerSession.has(r.sessionId) && !this.callsPerFolder.has(r.folderId));
  }

  /** Session ids with at least one visible session-total record. */
  sessionTotalSessions(): Set<string> {
    const out = new Set<string>();
    for (const keys of this.totalKeys.values()) {
      for (const key of keys) {
        const r = this.entries.get(key)?.record;
        if (r && this.visible(r)) out.add(r.sessionId);
      }
    }
    return out;
  }

  /** Aggregates matching records; undefined iff none match. */
  totals(filter: (r: UsageRecord) => boolean): Totals | undefined {
    const totals = emptyTotals();
    for (const { record } of this.entries.values()) {
      if (!this.visible(record) || !filter(record)) continue;
      accumulateTotals(totals, record);
    }
    return totals.records === 0 ? undefined : totals;
  }

  /** One pass: aggregates each record into bucket `bucket(r)` (0..n-1, or
   * undefined to skip). Entries are undefined for buckets with no record. */
  totalsByBucket(n: number, bucket: (r: UsageRecord) => number | undefined): (Totals | undefined)[] {
    const out: (Totals | undefined)[] = new Array(n).fill(undefined);
    for (const { record } of this.entries.values()) {
      if (!this.visible(record)) continue;
      const i = bucket(record);
      if (i === undefined || i < 0 || i >= n) continue;
      accumulateTotals((out[i] ??= emptyTotals()), record);
    }
    return out;
  }

  /** Calls `fn` for every visible record, in no particular order, without building an array. */
  each(fn: (r: UsageRecord) => void): void {
    for (const { record } of this.entries.values()) if (this.visible(record)) fn(record);
  }

  /** Every record matching `filter`, in no particular order. */
  records(filter: (r: UsageRecord) => boolean): UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const { record } of this.entries.values()) if (this.visible(record) && filter(record)) out.push(record);
    return out;
  }

  /** folderId → newest timestampMs over all records. */
  latest(): Map<string, number> {
    const out = new Map<string, number>();
    for (const { record } of this.entries.values()) {
      if (!this.visible(record)) continue;
      const prev = out.get(record.folderId);
      if (prev === undefined || record.timestampMs > prev) {
        out.set(record.folderId, record.timestampMs);
      }
    }
    return out;
  }
}

/** Combines two metrics: sums add; reported and missing take the larger side. */
export function addMetrics(a: Metric, b: Metric): Metric {
  return {
    sum: a.sum + b.sum,
    reported: Math.max(a.reported, b.reported),
    missing: Math.max(a.missing, b.missing),
  };
}

/** Local midnight at the start of `now`'s local day (DST-safe). */
export function localDayStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Next local midnight after `now` (DST-safe; never adds a fixed 24h). */
export function nextLocalMidnight(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

/** Local midnight on the 1st of `now`'s month (D10 window start). */
export function localMonthStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/** One entry per local day from the 1st of the month through today; `totals`
 * stays undefined for a day with no record ("—" in the panel, never 0). Today's
 * bucket has no upper bound, matching the Today figure (clock-skewed records). */
export function byLocalDay(store: UsageStore, now: Date): DayTotals[] {
  return daysOfMonth(store, localMonthStart(now), now.getDate(), true);
}

/** Days 1..`lastDay` of the month starting at `monthStartMs`. With `openEnd`
 * the last bucket has no upper bound; otherwise records after the month are skipped. */
export function daysOfMonth(store: UsageStore, monthStartMs: number, lastDay: number, openEnd: boolean, keep: (r: UsageRecord) => boolean = ALL): DayTotals[] {
  const first = new Date(monthStartMs);
  const starts: number[] = [];
  for (let d = 1; d <= lastDay; d++) {
    starts.push(new Date(first.getFullYear(), first.getMonth(), d).getTime());
  }
  const end = openEnd ? Number.POSITIVE_INFINITY : new Date(first.getFullYear(), first.getMonth(), lastDay + 1).getTime();
  const buckets = store.totalsByBucket(starts.length, (r) => {
    if (r.timestampMs < starts[0]! || r.timestampMs >= end || !keep(r)) return undefined;
    let i = starts.length - 1;
    while (i > 0 && r.timestampMs < starts[i]!) i--;
    return i;
  });
  return starts.map((dayStartMs, i) => {
    const totals = buckets[i];
    return totals === undefined ? { dayStartMs } : { dayStartMs, totals };
  });
}

/** Local month starts, oldest first: the `n` months ending with `now`'s month. */
export function monthStarts(now: Date, n: number): number[] {
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(now.getFullYear(), now.getMonth() - i, 1).getTime());
  return out;
}

/** Totals per month for `starts` (oldest first); the newest month has no upper bound. */
export function byMonth(store: UsageStore, starts: number[], keep: (r: UsageRecord) => boolean = ALL): MonthSummary[] {
  const buckets = store.totalsByBucket(starts.length, (r) => {
    if (starts.length === 0 || r.timestampMs < starts[0]! || !keep(r)) return undefined;
    let i = starts.length - 1;
    while (i > 0 && r.timestampMs < starts[i]!) i--;
    return i;
  });
  return starts.map((monthStartMs, i) => {
    const totals = buckets[i];
    return totals === undefined ? { monthStartMs } : { monthStartMs, totals };
  });
}

const GROWTH_SPAN = 5;
const ALL = () => true;

export const NO_PROJECT = "(no project)";

/** Input + output of one record, or undefined when neither was reported. */
function recordTokens(r: UsageRecord): number | undefined {
  return r.tokens.input === undefined && r.tokens.output === undefined ? undefined : (r.tokens.input ?? 0) + (r.tokens.output ?? 0);
}

function byCost<T extends { name: string; nanoAiu: Metric; tokens: Metric }>(a: T, b: T): number {
  return b.nanoAiu.sum - a.nanoAiu.sum || b.tokens.sum - a.tokens.sum || a.name.localeCompare(b.name);
}

function emptyGroup(name: string): GroupSummary {
  return { name, sessions: 0, calls: 0, tokens: emptyMetric(), nanoAiu: emptyMetric(), sources: Object.create(null) as Partial<Record<Source, number>> };
}

/** Per-project totals for records in [fromMs, toMs) that pass `keep`, costliest first. */
export function projectSummaries(
  store: UsageStore,
  fromMs: number,
  toMs: number,
  projectOf: (r: UsageRecord) => string,
  keep: (r: UsageRecord) => boolean = ALL,
): GroupSummary[] {
  const groups = new Map<string, { s: GroupSummary; ids: Set<string> }>();
  for (const r of store.records((x) => x.timestampMs >= fromMs && x.timestampMs < toMs && keep(x))) {
    const name = projectOf(r);
    let g = groups.get(name);
    if (!g) {
      g = { s: emptyGroup(name), ids: new Set() };
      groups.set(name, g);
    }
    g.ids.add(r.sessionId);
    g.s.calls += callsOf(r);
    if (callsMissingOf(r) > 0) g.s.callsMissing = (g.s.callsMissing ?? 0) + 1;
    count(g.s.tokens, recordTokens(r));
    if (pricedSource(r)) count(g.s.nanoAiu, r.nanoAiu);
    bumpSource(g.s.sources!, r.source);
  }
  return [...groups.values()].map(({ s, ids }) => ({ ...s, sessions: ids.size })).sort(byCost);
}

/**
 * Per-project totals for today (from `todayStartMs`, open-ended like Today) and the last 7
 * days (from `last7StartMs`, open-ended), in one pass, never filtered (A1). Costliest first.
 * `sessionTotals` counts session-total rows and is absent when 0.
 */
export function recentProjects(
  store: UsageStore,
  last7StartMs: number,
  todayStartMs: number,
  projectOf: (r: UsageRecord) => string,
): { today: GroupSummary[]; last7: GroupSummary[] } {
  type Acc = { s: GroupSummary; ids: Set<string> };
  const week = new Map<string, Acc>();
  const day = new Map<string, Acc>();
  const add = (into: Map<string, Acc>, name: string, r: UsageRecord, tok: number | undefined) => {
    let g = into.get(name);
    if (!g) {
      g = { s: emptyGroup(name), ids: new Set() };
      into.set(name, g);
    }
    g.ids.add(r.sessionId);
    g.s.calls += callsOf(r);
    if (callsMissingOf(r) > 0) g.s.callsMissing = (g.s.callsMissing ?? 0) + 1;
    if (r.kind === "sessionTotal") g.s.sessionTotals = (g.s.sessionTotals ?? 0) + 1;
    count(g.s.tokens, tok);
    if (pricedSource(r)) count(g.s.nanoAiu, r.nanoAiu);
    bumpSource(g.s.sources!, r.source);
  };
  store.each((r) => {
    if (r.timestampMs < last7StartMs) return;
    const name = projectOf(r);
    const tok = recordTokens(r);
    add(week, name, r, tok);
    if (r.timestampMs >= todayStartMs) add(day, name, r, tok);
  });
  const done = (m: Map<string, Acc>) => [...m.values()].map(({ s, ids }) => ({ ...s, sessions: ids.size })).sort(byCost);
  return { today: done(day), last7: done(week) };
}

/** Each source's own tools (D52); anything else (MCP servers, extensions, skills' tools) is "added".
 * Codex tools are not counted in 0.8, so its set is empty. */
export const BUILT_IN_TOOLS: Record<Source, ReadonlySet<string>> = {
  copilot: new Set([
    "bash", "read_bash", "write_bash", "stop_bash", "list_bash", "view", "edit", "create", "str_replace_editor",
    "rg", "grep", "glob", "task", "task_complete", "rename_chat", "report_intent", "skill", "think",
    "update_todo", "fetch", "web_fetch", "web_search", "read_agent", "list_agents",
  ]),
  "claude-code": new Set([
    "Bash", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "LS", "Task", "Agent", "WebFetch", "WebSearch",
    "TodoWrite", "TodoRead", "NotebookEdit", "NotebookRead", "Skill", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode",
    "KillShell", "BashOutput", "SlashCommand",
  ]),
  codex: new Set(),
};

/** Server or plugin an added tool belongs to, from its name (D27): "server/tool",
 * "mcp__server__tool", else the part before the first "-" or "_". */
export function toolGroup(name: string): string {
  const slash = name.indexOf("/");
  if (slash > 0) return name.slice(0, slash);
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (mcp) return mcp[1]!;
  const m = /^([A-Za-z0-9.]+)[-_]/.exec(name);
  return m ? m[1]! : name;
}

/** Per-tool totals for records in [fromMs, toMs) that pass `keep`, costliest first. */
export function toolSummaries(
  store: UsageStore,
  fromMs: number,
  toMs: number,
  keep: (r: UsageRecord) => boolean = ALL,
): ToolSummary[] {
  const tools = new Map<string, ToolSummary>();
  for (const r of store.records((x) => x.timestampMs >= fromMs && x.timestampMs < toMs && x.tools !== undefined && keep(x))) {
    for (const [name, uses] of Object.entries(r.tools!)) {
      let t = tools.get(name);
      if (!t) {
        t = { name, builtIn: false, uses: 0, calls: 0, tokens: emptyMetric(), nanoAiu: emptyMetric(), sources: Object.create(null) as Partial<Record<Source, number>> };
        tools.set(name, t);
      }
      // built in when any source that used it ships it (D52)
      if (BUILT_IN_TOOLS[r.source].has(name)) t.builtIn = true;
      t.uses += uses;
      t.calls++;
      count(t.tokens, recordTokens(r));
      if (pricedSource(r)) count(t.nanoAiu, r.nanoAiu);
      bumpSource(t.sources!, r.source);
    }
  }
  return [...tools.values()].sort(byCost);
}

/** Prompt tokens of a record: input, plus cached tokens when its Copilot model reports them
 * apart (N4). Every other source's input already includes cached tokens (D47). */
export function promptOf(r: UsageRecord, conventions: ReadonlyMap<string, PromptConvention>): number | undefined {
  const t = r.tokens;
  if (t.input === undefined) return undefined;
  return r.source === "copilot" && r.model !== undefined && conventions.get(r.model) === "separate" ? t.input + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : t.input;
}

/**
 * Per-session summaries for records in [fromMs, toMs), costliest first, at most `limit`.
 * `conventions` (from insights' promptConventions) says per model whether input already
 * includes cached tokens; a model not in it is taken as "included".
 */
export function sessionSummaries(
  store: UsageStore,
  fromMs: number,
  toMs: number,
  limit = 10,
  keep: (r: UsageRecord) => boolean = ALL,
  conventions: ReadonlyMap<string, PromptConvention> = new Map(),
): SessionSummary[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const r of store.records((x) => x.timestampMs >= fromMs && x.timestampMs < toMs && keep(x))) {
    const g = groups.get(r.sessionId);
    if (g) g.push(r);
    else groups.set(r.sessionId, [r]);
  }
  const out: SessionSummary[] = [];
  for (const [sessionId, recs] of groups) {
    recs.sort((a, b) => a.timestampMs - b.timestampMs || (a.sequence ?? 0) - (b.sequence ?? 0));
    const tokens = emptyMetric();
    const nanoAiu = emptyMetric();
    const input = emptyMetric();
    const cacheRead = emptyMetric();
    const models = new Map<string, number>();
    let calls = 0;
    let callsMissing = 0;
    let firstMs = Number.POSITIVE_INFINITY;
    for (const r of recs) {
      count(tokens, recordTokens(r));
      if (pricedSource(r)) count(nanoAiu, r.nanoAiu);
      count(input, promptOf(r, conventions));
      count(cacheRead, r.tokens.cacheRead);
      calls += callsOf(r);
      callsMissing += callsMissingOf(r);
      // A session total's start is the sessionStartTime Copilot logged with it (N9).
      firstMs = Math.min(firstMs, r.startedMs ?? r.timestampMs);
      // A session total without requests.count still names its model (N1).
      if (r.model !== undefined) models.set(r.model, (models.get(r.model) ?? 0) + Math.max(callsOf(r), callsMissingOf(r)));
    }
    let topModel: string | undefined;
    let best = 0;
    for (const [m, n] of [...models].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (n > best) {
        best = n;
        topModel = m;
      }
    }
    // Growth compares calls; a session total is one figure, not a call.
    const priced = recs.filter((r) => r.kind === "call" && r.nanoAiu !== undefined).map((r) => r.nanoAiu!);
    let growth: number | undefined;
    let excessNanoAiu: number | undefined;
    if (priced.length >= 2 * GROWTH_SPAN) {
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const early = mean(priced.slice(0, GROWTH_SPAN));
      const late = mean(priced.slice(-GROWTH_SPAN));
      if (early > 0) {
        growth = late / early;
        excessNanoAiu = priced.slice(GROWTH_SPAN).reduce((a, x) => a + Math.max(0, x - early), 0);
      }
    }
    const sessionTotal = recs.every((r) => r.kind === "sessionTotal");
    out.push({
      sessionId,
      folderId: recs[0]!.folderId,
      source: recs[0]!.source,
      firstMs,
      lastMs: recs.at(-1)!.timestampMs,
      calls,
      ...(callsMissing > 0 && { callsMissing }),
      ...(topModel !== undefined && { topModel }),
      tokens,
      nanoAiu,
      ...(growth !== undefined && { growth }),
      ...(sessionTotal && { sessionTotal }),
      input,
      cacheRead,
      ...(excessNanoAiu !== undefined && { excessNanoAiu }),
    });
  }
  out.sort((a, b) => b.nanoAiu.sum - a.nanoAiu.sum || b.tokens.sum - a.tokens.sum || a.sessionId.localeCompare(b.sessionId));
  return out.slice(0, limit);
}

/**
 * Per-day headline figures from the local day of `fromMs` through `todayStartMs`, one
 * pass, never filtered (A2). Only days with a record are listed. Like Today, the last
 * day has no upper bound; records before `fromMs` are skipped.
 */
export function dailyActivity(store: UsageStore, fromMs: number, todayStartMs: number): Activity {
  const first = new Date(fromMs);
  const starts: number[] = [];
  for (let d = 0; ; d++) {
    const t = new Date(first.getFullYear(), first.getMonth(), first.getDate() + d).getTime();
    if (t > todayStartMs && starts.length > 0) break;
    starts.push(t);
  }
  const n = starts.length;
  const acc: ({ input: Metric; output: Metric; nanoAiu: Metric; calls: number; callsMissing: number; sessionTotals: number; ids: Set<string> } | undefined)[] = new Array(n);
  store.each((r) => {
    const ts = r.timestampMs;
    if (ts < starts[0]!) return;
    // the last day start at or before ts (binary search; the window may hold 730 days)
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= ts) lo = mid;
      else hi = mid - 1;
    }
    const a = (acc[lo] ??= { input: emptyMetric(), output: emptyMetric(), nanoAiu: emptyMetric(), calls: 0, callsMissing: 0, sessionTotals: 0, ids: new Set() });
    count(a.input, r.tokens.input);
    count(a.output, r.tokens.output);
    if (pricedSource(r)) count(a.nanoAiu, r.nanoAiu);
    a.calls += callsOf(r);
    a.callsMissing += callsMissingOf(r);
    if (r.kind === "sessionTotal") a.sessionTotals += 1;
    a.ids.add(r.sessionId);
  });
  const days: DayStats[] = [];
  for (let i = 0; i < n; i++) {
    const a = acc[i];
    if (!a) continue;
    days.push({
      dayStartMs: starts[i]!,
      tokens: addMetrics(a.input, a.output),
      nanoAiu: a.nanoAiu,
      calls: a.calls,
      callsMissing: a.callsMissing,
      sessionTotals: a.sessionTotals,
      sessions: a.ids.size,
    });
  }
  return { fromMs: starts[0]!, days };
}

/** Local midnight `days` days before `now`'s local day (DST-safe). */
export function localDaysBefore(now: Date, days: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
}

/** 0 for no value or zero; otherwise 1–4 in quarters of `max`. */
export function heatLevel(value: number | undefined, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value === undefined || value <= 0 || !(max > 0)) return 0;
  return Math.min(4, Math.max(1, Math.ceil((4 * value) / max))) as 1 | 2 | 3 | 4;
}

/** Colour family for a model chip; prefix match on the lower-cased id. */
export function modelFamily(model: string): "claude" | "gpt" | "gemini" | "other" {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "claude";
  if (m.startsWith("gpt") || /^o\d/.test(m)) return "gpt";
  if (m.startsWith("gemini")) return "gemini";
  return "other";
}
