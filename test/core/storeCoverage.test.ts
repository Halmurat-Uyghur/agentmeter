// Review #4: every view keeps the "*" a missing token figure earns, as the headline does,
// and the cache-read share pairs prompt tokens and cache reads of the same records.
import { describe, expect, it } from "vitest";
import { formatCount } from "../../src/core/format";
import { cacheRing } from "../../src/core/panel/dashboard";
import { addMetrics, projectSummaries, recentProjects, sessionSummaries, toolSummaries, UsageStore } from "../../src/core/store";
import type { Metric, Snapshot, Tokens, UsageRecord } from "../../src/core/types";

const T0 = Date.parse("2026-11-05T14:30:00.000Z");
const all = () => true;
function rec(key: string, tokens: Tokens, o: Partial<UsageRecord> = {}): UsageRecord {
  return { key, keySource: "usageId", kind: "call", source: "copilot", sessionId: "s1", folderId: "f1", timestampMs: T0, model: "model-a", tokens, tools: { bash: 1 }, nanoAiu: 1e9, ...o };
}

describe("token coverage in summaries (review #4)", () => {
  it("an input-only record reads 100* in projects, sessions and tools, as in the headline", () => {
    const s = new UsageStore();
    s.add(rec("u1", { input: 100 }), "a.jsonl");
    const t = s.totals(all)!;
    expect(formatCount(addMetrics(t.input, t.output))).toBe("100*");
    expect(formatCount(projectSummaries(s, 0, Infinity, (r) => r.folderId)[0]!.tokens)).toBe("100*");
    const recent = recentProjects(s, 0, 0, (r) => r.folderId);
    expect(formatCount(recent.today[0]!.tokens)).toBe("100*");
    expect(formatCount(recent.last7[0]!.tokens)).toBe("100*");
    expect(formatCount(sessionSummaries(s, 0, Infinity)[0]!.tokens)).toBe("100*");
    expect(formatCount(toolSummaries(s, 0, Infinity)[0]!.tokens)).toBe("100*");
  });

  it("complete records keep no star, and a record with neither side reads as missing", () => {
    const s = new UsageStore();
    s.add(rec("u1", { input: 100, output: 20 }), "a.jsonl");
    expect(formatCount(sessionSummaries(s, 0, Infinity)[0]!.tokens)).toBe("120");
    s.add(rec("u2", { cacheRead: 5 }), "a.jsonl");
    expect(sessionSummaries(s, 0, Infinity)[0]!.tokens).toEqual({ sum: 120, reported: 1, missing: 1 });
  });
});

describe("cache share over matching records (review #4)", () => {
  it("sums prompt tokens and cache reads only over records that reported both", () => {
    const s = new UsageStore();
    for (let i = 0; i < 5; i++) s.add(rec(`r${i}`, { input: 1000, output: 10, cacheRead: 900 }), "a.jsonl");
    for (let i = 0; i < 5; i++) s.add(rec(`n${i}`, { input: 1000, output: 10 }), "a.jsonl");
    const x = sessionSummaries(s, 0, Infinity)[0]!;
    // Before: 4500 cache reads over 10000 prompt tokens (45 in 100) from different coverage.
    expect(x.input).toEqual({ sum: 5000, reported: 5, missing: 5 });
    expect(x.cacheRead).toEqual({ sum: 4500, reported: 5, missing: 5 });
  });

  const m = (sum: number, reported: number, missing = 0): Metric => ({ sum, reported, missing });
  const snap = (cache: { prompt: Metric; cacheRead: Metric }) =>
    ({ month: { monthStartMs: new Date(2026, 10, 1).getTime(), isCurrent: true, cache } }) as unknown as Snapshot;

  it("the ring stars a partly supported share and says how many records support it", () => {
    const html = cacheRing(snap({ prompt: m(5000, 5, 5), cacheRead: m(4500, 5, 5) }));
    expect(html).toContain(">90*<");
    expect(html).toContain("from 5 of 10 records");
    expect(html).toContain("90* in 100 prompt tokens were cache reads, from 5 of 10 records that reported both.");
    expect(html).not.toMatch(/%/);
  });

  it("a fully supported share stays unstarred with no coverage line", () => {
    const html = cacheRing(snap({ prompt: m(10_000, 4), cacheRead: m(6_100, 4) }));
    expect(html).toContain(">61<");
    expect(html).not.toContain("records");
  });
});
