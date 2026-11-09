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
    // Evidence-based (Codex review of PR #22): the model switch is named, nothing else.
    expect(x.growthCauses).toEqual(["model"]);
    expect(html).toContain("their calls show a switch to another model");
    expect(ins).toContain("so the likelier cause is a switch to another model.");
    expect(ins).not.toMatch(/longer replies|cache reads/);
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
    expect(t).toContain("In the others it did not grow as much, so the likelier cause is a switch to another model.");
  });

  it("growth advice wording covers every mix", () => {
    expect(growthAction(2, 2, 0)).toMatch(/^Their input grew too/);
    expect(growthAction(3, 1, 2)).toContain("In the others input tokens were not logged");
    expect(growthAction(3, 1, 1)).toContain("In the others where input was logged it did not grow as much");
    expect(growthAction(3, 0, 1)).toMatch(/^Where input was logged \(2 of 3 sessions\), it did not grow as much/);
    expect(growthAction(1, 0, 0)).toMatch(/^Its input did not grow as much/);
    expect(growthAction(1, 0, 0)).toContain("so the cause is unclear.");
    expect(growthAction(3, 0, 0, { model: 1, output: 0, cache: 2, unclear: 1 })).toContain(
      "so the likelier causes are a switch to another model (1 of 3) and fewer cache reads (2 of 3); in 1 of 3 the cause is unclear.",
    );
    expect(growthAction(1, 0, 0, { model: 0, output: 1, cache: 0, unclear: 0 })).toContain("so the likelier cause is longer replies.");
    const mixes = [{ model: 0, output: 0, cache: 0, unclear: 2 }, { model: 1, output: 1, cache: 1, unclear: 1 }, undefined];
    for (const [n, g, u] of [[2, 2, 0], [3, 1, 2], [3, 1, 1], [3, 0, 1], [1, 0, 0], [2, 0, 2]]) {
      for (const c of mixes) expect(growthAction(n!, g!, u!, c)).not.toMatch(/\b(limit|quota|allowance|billing|remaining|premium)\b|%/i);
    }
  });

  // Codex review of PR #22: with the model, input and output unchanged, fewer cache hits alone
  // raise cost. The advice names only that, never a costlier model or longer replies.
  function cached(read: (i: number) => number, output: (i: number) => number = () => 100, model: (i: number) => string = () => "m"): UsageStore {
    const s = new UsageStore();
    for (let i = 0; i < 10; i++) {
      s.add({ key: `u${i}`, keySource: "usageId", kind: "call", source: "copilot", sessionId: "s1", folderId: "s1", timestampMs: T0 + i * 60_000, model: model(i), tokens: { input: 10_000, output: output(i), cacheRead: read(i) }, nanoAiu: i < 5 ? 1e11 : 4e11 }, "a.jsonl");
    }
    return s;
  }

  it("a cache drop with the same model, input and output names fewer cache reads only", () => {
    const store = cached((i) => (i < 5 ? 9_000 : 1_000));
    const x = sessionSummaries(store, 0, Infinity)[0]!;
    expect(x.inputGrowth).toBe(1);
    expect(x.growthCauses).toEqual(["cache"]);
    const html = render(store, "sessions");
    expect(html).toContain("their input did not grow as much; their calls show fewer cache reads");
    const ins = render(store, "insights");
    expect(ins).toContain("so the likelier cause is fewer cache reads.");
    for (const t of [html, ins]) expect(t).not.toMatch(/another model|costlier model|longer replies|context grew/);
  });

  it("longer replies are named only when output grew", () => {
    const store = cached(() => 5_000, (i) => (i < 5 ? 100 : 400));
    expect(sessionSummaries(store, 0, Infinity)[0]!.growthCauses).toEqual(["output"]);
    expect(render(store, "insights")).toContain("so the likelier cause is longer replies.");
  });

  it("every cause that holds is named, together", () => {
    const store = cached((i) => (i < 5 ? 9_000 : 1_000), (i) => (i < 5 ? 100 : 400), (i) => (i < 5 ? "cheap" : "dear"));
    expect(sessionSummaries(store, 0, Infinity)[0]!.growthCauses).toEqual(["model", "output", "cache"]);
    expect(render(store, "insights")).toContain("so the likelier causes are a switch to another model, longer replies and fewer cache reads.");
  });

  it("nothing measured changed: the cause is unclear", () => {
    const store = cached(() => 5_000);
    const x = sessionSummaries(store, 0, Infinity)[0]!;
    expect(x.growthCauses).toBeUndefined();
    expect(render(store, "sessions")).toContain("their input did not grow as much; the cause is unclear");
    const ins = render(store, "insights");
    expect(ins).toContain("Its input did not grow as much, so the cause is unclear.");
    expect(ins).not.toMatch(/another model|costlier model|longer replies|cache reads/);
  });

  it("a cause not logged on every compared call is not named", () => {
    const store = cached((i) => (i < 5 ? 9_000 : 1_000));
    // One early call without cache reads: the share is not measured, so the drop is not claimed.
    store.add({ key: "u0", keySource: "usageId", kind: "call", source: "copilot", sessionId: "s1", folderId: "s1", timestampMs: T0, model: "m", tokens: { input: 10_000, output: 100 }, nanoAiu: 1e11 }, "a.jsonl");
    expect(sessionSummaries(store, 0, Infinity)[0]!.growthCauses).toBeUndefined();
  });
});
