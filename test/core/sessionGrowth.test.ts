// Review #7: session growth compares the cost of early and later calls; only input-token
// growth puts it down to a growing context.
import { describe, expect, it } from "vitest";
import { computeInsights, contextGrew } from "../../src/core/insights";
import { growthAction } from "../../src/core/panel/insights";
import { renderPanelHtml } from "../../src/core/panelHtml";
import { sessionSummaries, UsageStore } from "../../src/core/store";
import type { Health, Snapshot, UsageRecord } from "../../src/core/types";

const T0 = new Date(2026, 10, 5, 10).getTime();
function session(price: (i: number) => number, input: (i: number) => number, model: (i: number) => string = () => "m"): UsageStore {
  const s = new UsageStore();
  for (let i = 0; i < 10; i++) {
    const r: UsageRecord = { key: `u${i}`, keySource: "usageId", kind: "call", source: "copilot", sessionId: "s1", folderId: "s1", timestampMs: T0 + i * 60_000, model: model(i), tokens: { input: input(i), output: 100 }, nanoAiu: price(i) };
    s.add(r, "a.jsonl");
  }
  return s;
}
const health: Health = { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0 };

function render(store: UsageStore, section: "sessions" | "insights"): string {
  const sessions = sessionSummaries(store, 0, Infinity, 50);
  const recs = store.records(() => true);
  const totals = store.totals(() => true)!;
  const insights = computeInsights({ sessions, monthRecords: recs, allRecords: recs, monthNanoAiu: totals.nanoAiu.sum });
  const s = {
    generatedAtMs: T0 + 3_600_000, dayStartMs: new Date(2026, 10, 5).getTime(), sessions: [], health,
    month: { monthStartMs: new Date(2026, 10, 1).getTime(), isCurrent: true, days: [], sessions, projects: [], tools: [], totals, insights },
    history: [], activity: { fromMs: new Date(2026, 10, 1).getTime(), days: [] },
  } as unknown as Snapshot;
  return renderPanelHtml(s, "x", undefined, section);
}

describe("session growth wording (review #7)", () => {
  it("a 4x costlier model with unchanged tokens says later calls became more expensive, not that the context grew", () => {
    const store = session((i) => (i < 5 ? 1e11 : 4e11), () => 1000, (i) => (i < 5 ? "cheap" : "dear"));
    const x = sessionSummaries(store, 0, Infinity)[0]!;
    expect(x.growth).toBe(4);
    expect(x.inputGrowth).toBe(1);
    expect(contextGrew(x)).toBe(false);
    const html = render(store, "sessions");
    expect(html).toContain("later calls became more expensive");
    expect(html).not.toMatch(/the context grew|context kept growing/);
    const ins = render(store, "insights");
    expect(ins).toContain("Sessions that grew costly");
    expect(ins).not.toMatch(/context grew|\/compact/);
    expect(ins).toContain("costlier model or longer replies");
  });

  it("growing input does put it down to the context", () => {
    const store = session((i) => (i < 5 ? 1e11 : 4e11), (i) => (i < 5 ? 1000 : 4000));
    const x = sessionSummaries(store, 0, Infinity)[0]!;
    expect(x.inputGrowth).toBe(4);
    expect(contextGrew(x)).toBe(true);
    const html = render(store, "sessions");
    expect(html).toContain("input grew 4.0×, so the context grew");
    expect(html).toContain("the context kept growing");
    expect(render(store, "insights")).toContain("Its input grew too, so the context grew.");
  });

  it("no input growth figure when any compared call lacks input", () => {
    const s = session((i) => (i < 5 ? 1e11 : 4e11), () => 1000);
    s.add({ key: "u0", keySource: "usageId", kind: "call", source: "copilot", sessionId: "s1", folderId: "s1", timestampMs: T0, model: "m", tokens: { output: 100 }, nanoAiu: 1e11 }, "a.jsonl");
    const x = sessionSummaries(s, 0, Infinity)[0]!;
    expect(x.growth).toBe(4);
    expect(x.inputGrowth).toBeUndefined();
  });

  it("unlogged input reads as unclear, not as a costlier model (review F)", () => {
    const s = session((i) => (i < 5 ? 1e11 : 4e11), () => 1000);
    s.add({ key: "u0", keySource: "usageId", kind: "call", source: "copilot", sessionId: "s1", folderId: "s1", timestampMs: T0, model: "m", tokens: { output: 100 }, nanoAiu: 1e11 }, "a.jsonl");
    const html = render(s, "sessions");
    expect(html).toContain("input tokens were not logged for these calls, so the cause is unclear");
    expect(html).not.toContain("did not grow as much");
    const ins = render(s, "insights");
    expect(ins).toContain("Input tokens were not logged for its calls, so the cause is unclear.");
    expect(ins).not.toMatch(/costlier model|\/compact|context grew/);
  });

  it("one growing session does not speak for the others (review E)", () => {
    // Two flagged sessions: s1's input grew 4x, s2 switched to a 4x costlier model.
    const store = new UsageStore();
    for (const [sid, input, model] of [["s1", (i: number) => (i < 5 ? 1000 : 4000), () => "m"], ["s2", () => 1000, (i: number) => (i < 5 ? "cheap" : "dear")]] as const) {
      for (let i = 0; i < 10; i++) {
        store.add({ key: `${sid}u${i}`, keySource: "usageId", kind: "call", source: "copilot", sessionId: sid, folderId: sid, timestampMs: T0 + i * 60_000, model: model(i), tokens: { input: input(i), output: 100 }, nanoAiu: i < 5 ? 1e11 : 4e11 }, `${sid}.jsonl`);
      }
    }
    const recs = store.records(() => true);
    const sessions = sessionSummaries(store, 0, Infinity, 50);
    const ins = computeInsights({ sessions, monthRecords: recs, allRecords: recs, monthNanoAiu: store.totals(() => true)!.nanoAiu.sum }).items.find((i) => i.id === "context-growth")!;
    expect(ins.sessions).toBe(2);
    expect(ins.id === "context-growth" && ins.inputGrew).toBe(false);
    expect(ins.id === "context-growth" && ins.inputGrewSessions).toBe(1);
    const t = render(store, "insights");
    expect(t).not.toContain("Their input grew too");
    expect(t).toContain("In 1 of 2 sessions the input grew too, so the context grew there.");
    expect(t).toContain("costlier model or longer replies are the likelier cause");
  });

  it("growth advice wording covers every mix", () => {
    expect(growthAction(2, 2, 0)).toMatch(/^Their input grew too/);
    expect(growthAction(3, 1, 2)).toContain("In the others input tokens were not logged");
    expect(growthAction(3, 1, 1)).toContain("In the others where input was logged it did not grow as much");
    expect(growthAction(3, 0, 1)).toMatch(/^Where input was logged \(2 of 3 sessions\), it did not grow as much/);
    expect(growthAction(1, 0, 0)).toMatch(/^Its input did not grow as much/);
    for (const [n, g, u] of [[2, 2, 0], [3, 1, 2], [3, 1, 1], [3, 0, 1], [1, 0, 0], [2, 0, 2]]) {
      expect(growthAction(n!, g!, u!)).not.toMatch(/\b(limit|quota|allowance|billing|remaining|premium)\b|%/i);
    }
  });
});
