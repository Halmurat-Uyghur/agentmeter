// Review #7: session growth compares the cost of early and later calls; only input-token
// growth puts it down to a growing context.
import { describe, expect, it } from "vitest";
import { computeInsights, contextGrew } from "../../src/core/insights";
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
    expect(render(store, "insights")).toContain("Their input grew too, so the context grew.");
  });

  it("no input growth figure when any compared call lacks input", () => {
    const s = session((i) => (i < 5 ? 1e11 : 4e11), () => 1000);
    s.add({ key: "u0", keySource: "usageId", kind: "call", source: "copilot", sessionId: "s1", folderId: "s1", timestampMs: T0, model: "m", tokens: { output: 100 }, nanoAiu: 1e11 }, "a.jsonl");
    const x = sessionSummaries(s, 0, Infinity)[0]!;
    expect(x.growth).toBe(4);
    expect(x.inputGrowth).toBeUndefined();
  });
});
