// In-memory, deduplicating aggregation of UsageRecords. A record seen in
// several files counts once; it is dropped only when every file that held it
// has been reset. Metrics keep "not reported" apart from zero.

import type { Counts, DayTotals, Metric, MonthSummary, SessionSummary, Totals, UsageRecord } from "./types";

export const UNKNOWN_MODEL = "(unknown model)";

interface Entry {
  record: UsageRecord;
  files: Set<string>;
}

function emptyMetric(): Metric {
  return { sum: 0, reported: 0, missing: 0 };
}

function emptyCounts(): Counts {
  return {
    records: 0,
    input: emptyMetric(),
    output: emptyMetric(),
    cacheRead: emptyMetric(),
    cacheWrite: emptyMetric(),
    reasoning: emptyMetric(),
    durationMs: emptyMetric(),
    nanoAiu: emptyMetric(),
  };
}

function count(m: Metric, v: number | undefined): void {
  if (v === undefined) {
    m.missing += 1;
  } else {
    m.sum += v;
    m.reported += 1;
  }
}

function accumulate(c: Counts, r: UsageRecord): void {
  c.records += 1;
  count(c.input, r.tokens.input);
  count(c.output, r.tokens.output);
  count(c.cacheRead, r.tokens.cacheRead);
  count(c.cacheWrite, r.tokens.cacheWrite);
  count(c.reasoning, r.tokens.reasoning);
  count(c.durationMs, r.durationMs);
  count(c.nanoAiu, r.nanoAiu);
}

export class UsageStore {
  private readonly entries = new Map<string, Entry>();

  /** Returns false if the key was already known; `file` is still recorded for it. */
  add(r: UsageRecord, file: string): boolean {
    const existing = this.entries.get(r.key);
    if (existing) {
      existing.files.add(file);
      return false;
    }
    this.entries.set(r.key, { record: r, files: new Set([file]) });
    return true;
  }

  /** Forgets `file`; records no other file holds are deleted. */
  resetFile(file: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.files.delete(file) && entry.files.size === 0) {
        this.entries.delete(key);
      }
    }
  }

  /** Aggregates matching records; undefined iff none match. */
  totals(filter: (r: UsageRecord) => boolean): Totals | undefined {
    const totals: Totals = { ...emptyCounts(), byModel: {} };
    for (const { record } of this.entries.values()) {
      if (!filter(record)) continue;
      accumulate(totals, record);
      const model = record.model ?? UNKNOWN_MODEL;
      const perModel = (totals.byModel[model] ??= emptyCounts());
      accumulate(perModel, record);
    }
    return totals.records === 0 ? undefined : totals;
  }

  /** One pass: aggregates each record into bucket `bucket(r)` (0..n-1, or
   * undefined to skip). Entries are undefined for buckets with no record. */
  totalsByBucket(n: number, bucket: (r: UsageRecord) => number | undefined): (Totals | undefined)[] {
    const out: (Totals | undefined)[] = new Array(n).fill(undefined);
    for (const { record } of this.entries.values()) {
      const i = bucket(record);
      if (i === undefined || i < 0 || i >= n) continue;
      const totals = (out[i] ??= { ...emptyCounts(), byModel: {} });
      accumulate(totals, record);
      const model = record.model ?? UNKNOWN_MODEL;
      accumulate((totals.byModel[model] ??= emptyCounts()), record);
    }
    return out;
  }

  /** Every record matching `filter`, in no particular order. */
  records(filter: (r: UsageRecord) => boolean): UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const { record } of this.entries.values()) if (filter(record)) out.push(record);
    return out;
  }

  /** folderId → newest timestampMs over all records. */
  latest(): Map<string, number> {
    const out = new Map<string, number>();
    for (const { record } of this.entries.values()) {
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
export function daysOfMonth(store: UsageStore, monthStartMs: number, lastDay: number, openEnd: boolean): DayTotals[] {
  const first = new Date(monthStartMs);
  const starts: number[] = [];
  for (let d = 1; d <= lastDay; d++) {
    starts.push(new Date(first.getFullYear(), first.getMonth(), d).getTime());
  }
  const end = openEnd ? Number.POSITIVE_INFINITY : new Date(first.getFullYear(), first.getMonth(), lastDay + 1).getTime();
  const buckets = store.totalsByBucket(starts.length, (r) => {
    if (r.timestampMs < starts[0]! || r.timestampMs >= end) return undefined;
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
export function byMonth(store: UsageStore, starts: number[]): MonthSummary[] {
  const buckets = store.totalsByBucket(starts.length, (r) => {
    if (starts.length === 0 || r.timestampMs < starts[0]!) return undefined;
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

/** Per-session summaries for records in [fromMs, toMs), costliest first, at most `limit`. */
export function sessionSummaries(store: UsageStore, fromMs: number, toMs: number, limit = 10): SessionSummary[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const r of store.records((x) => x.timestampMs >= fromMs && x.timestampMs < toMs)) {
    const g = groups.get(r.sessionId);
    if (g) g.push(r);
    else groups.set(r.sessionId, [r]);
  }
  const out: SessionSummary[] = [];
  for (const [sessionId, recs] of groups) {
    recs.sort((a, b) => a.timestampMs - b.timestampMs || (a.sequence ?? 0) - (b.sequence ?? 0));
    const tokens = emptyMetric();
    const nanoAiu = emptyMetric();
    const models = new Map<string, number>();
    for (const r of recs) {
      const t = r.tokens.input === undefined && r.tokens.output === undefined ? undefined : (r.tokens.input ?? 0) + (r.tokens.output ?? 0);
      count(tokens, t);
      count(nanoAiu, r.nanoAiu);
      if (r.model !== undefined) models.set(r.model, (models.get(r.model) ?? 0) + 1);
    }
    let topModel: string | undefined;
    let best = 0;
    for (const [m, n] of [...models].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (n > best) {
        best = n;
        topModel = m;
      }
    }
    const priced = recs.filter((r) => r.nanoAiu !== undefined).map((r) => r.nanoAiu!);
    let growth: number | undefined;
    if (priced.length >= 2 * GROWTH_SPAN) {
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const early = mean(priced.slice(0, GROWTH_SPAN));
      const late = mean(priced.slice(-GROWTH_SPAN));
      if (early > 0) growth = late / early;
    }
    out.push({
      sessionId,
      firstMs: recs[0]!.timestampMs,
      lastMs: recs.at(-1)!.timestampMs,
      calls: recs.length,
      ...(topModel !== undefined && { topModel }),
      tokens,
      nanoAiu,
      ...(growth !== undefined && { growth }),
    });
  }
  out.sort((a, b) => b.nanoAiu.sum - a.nanoAiu.sum || b.tokens.sum - a.tokens.sum || a.sessionId.localeCompare(b.sessionId));
  return out.slice(0, limit);
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
