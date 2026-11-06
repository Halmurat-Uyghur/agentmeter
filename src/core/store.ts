// In-memory, deduplicating aggregation of UsageRecords. A record seen in
// several files counts once; it is dropped only when every file that held it
// has been reset. Metrics keep "not reported" apart from zero.

import type { Counts, DayTotals, Metric, Totals, UsageRecord } from "./types";

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
  const starts: number[] = [];
  for (let d = 1; d <= now.getDate(); d++) {
    starts.push(new Date(now.getFullYear(), now.getMonth(), d).getTime());
  }
  const buckets = store.totalsByBucket(starts.length, (r) => {
    if (r.timestampMs < starts[0]!) return undefined;
    let i = starts.length - 1;
    while (i > 0 && r.timestampMs < starts[i]!) i--;
    return i;
  });
  return starts.map((dayStartMs, i) => {
    const totals = buckets[i];
    return totals === undefined ? { dayStartMs } : { dayStartMs, totals };
  });
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
