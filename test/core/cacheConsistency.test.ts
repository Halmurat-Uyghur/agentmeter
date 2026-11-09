// One cache share everywhere: session rows, the dashboard ring, session detail, Cache by model
// and the low-cache-reuse insight pair prompt tokens and cache reads over the same records
// (those that reported both), so one session or model never shows two shares.
import { describe, expect, it } from "vitest";
import { cacheStats, modelCacheStats, sessionDetail } from "../../src/core/explain";
import { computeInsights } from "../../src/core/insights";
import { cacheRing } from "../../src/core/panel/dashboard";
import { modelCacheCard, sessionDetailCard } from "../../src/core/panel/explain";
import { sessionSummaries, UsageStore } from "../../src/core/store";
import type { Metric, Snapshot, UsageRecord, ViewOptions } from "../../src/core/types";

const T0 = new Date(2026, 10, 5, 10).getTime();
const NONE = new Map();
const view = { unit: "cost" } as unknown as ViewOptions;

function rec(i: number, cacheRead: number | undefined, o: Partial<UsageRecord> = {}, input = 1000): UsageRecord {
  return {
    key: `u${o.sessionId ?? "s1"}-${i}`,
    keySource: "usageId",
    kind: "call",
    source: "copilot",
    sessionId: "s1",
    folderId: "s1",
    timestampMs: T0 + i * 60_000,
    sequence: i,
    model: "model-a",
    tokens: { input, output: 10, ...(cacheRead !== undefined && { cacheRead }) },
    nanoAiu: 1e9,
    ...o,
  };
}

/** 10 calls of 1000 input tokens; 5 of them also logged 900 cache reads. */
function scenario(): UsageRecord[] {
  return Array.from({ length: 10 }, (_, i) => rec(i, i % 2 === 0 ? 900 : undefined));
}

const share = (prompt: Metric, cacheRead: Metric) => Math.round((100 * cacheRead.sum) / prompt.sum);

function snap(month: Record<string, unknown>): Snapshot {
  return { generatedAtMs: T0, health: { partial: false }, month: { monthStartMs: new Date(2026, 10, 1).getTime(), isCurrent: true, ...month } } as unknown as Snapshot;
}

describe("cache share consistency across views", () => {
  it("summary, dashboard ring, session detail and Cache by model all read 90* from 5 of 10 records", () => {
    const recs = scenario();
    const store = new UsageStore();
    for (const r of recs) store.add(r, "a.jsonl");

    const summary = sessionSummaries(store, 0, Infinity)[0]!;
    const detail = sessionDetail("s1", recs, NONE);
    const byModel = modelCacheStats(recs, NONE)[0]!;
    const month = cacheStats(recs, NONE);

    for (const [prompt, cacheRead] of [
      [summary.input!, summary.cacheRead!],
      [detail.cache.prompt, detail.cache.cacheRead],
      [byModel.prompt, byModel.cacheRead],
      [month.prompt, month.cacheRead],
    ] as const) {
      expect(prompt).toEqual({ sum: 5000, reported: 5, missing: 5 });
      expect(cacheRead).toEqual({ sum: 4500, reported: 5, missing: 5 });
      expect(share(prompt, cacheRead)).toBe(90);
    }

    const ring = cacheRing(snap({ cache: { prompt: summary.input, cacheRead: summary.cacheRead } }));
    expect(ring).toContain(">90*<");
    expect(ring).toContain("from 5 of 10 records");

    const detailHtml = sessionDetailCard(snap({ detail }), view);
    expect(detailHtml).toMatch(/90 in 100<span class="star"/);
    expect(detailHtml).not.toContain("45 in 100");
    expect(detailHtml).toContain("from 5 of 10 records that reported both");

    const modelsHtml = modelCacheCard(snap({ cacheCost: month, modelCache: [byModel] }));
    expect(modelsHtml).toMatch(/90 in 100<span class="star"/);
    expect(modelsHtml).not.toContain("45 in 100");
    expect(modelsHtml).toContain("from 5 of 10 records that reported both");
    // visible text only (command links URL-encode their arguments)
    for (const html of [ring, detailHtml, modelsHtml]) expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/%/);
  });

  it("the low-cache-reuse insight uses the same paired share as Cache by model", () => {
    // 6 sessions x 10 calls of 30K input; half logged 9K cache reads (paired share 0.3),
    // the other half none (an unpaired share would read 0.15).
    const recs: UsageRecord[] = [];
    for (const sid of ["a", "b", "c", "d", "e", "f"]) {
      for (let i = 0; i < 10; i++) recs.push(rec(i, i % 2 === 0 ? 9_000 : undefined, { sessionId: sid, folderId: sid, nanoAiu: 0.1 * 1e11 }, 30_000));
    }
    const store = new UsageStore();
    for (const r of recs) store.add(r, "a.jsonl");
    const sessions = sessionSummaries(store, 0, Infinity, 50);
    const totals = store.totals(() => true)!;
    const v = computeInsights({ sessions, monthRecords: recs, allRecords: recs, monthNanoAiu: totals.nanoAiu.sum });
    const i = v.items.find((x) => x.id === "cache-reuse");
    if (!i || i.id !== "cache-reuse") throw new Error("cache-reuse insight did not fire");
    const byModel = modelCacheStats(recs, NONE)[0]!;
    expect(byModel.cacheRead.sum / byModel.prompt.sum).toBeCloseTo(0.3);
    expect(i.share).toBeCloseTo(byModel.cacheRead.sum / byModel.prompt.sum);
  });
});
