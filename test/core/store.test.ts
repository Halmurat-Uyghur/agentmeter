import { describe, expect, it } from "vitest";
import {
  UsageStore,
  addMetrics,
  localDayStart,
  nextLocalMidnight,
  BUILT_IN_TOOLS,
  dailyActivity,
  projectSummaries,
  promptOf,
  recentProjects,
  sessionSummaries,
  toolSummaries,
} from "../../src/core/store";
import type { Tokens, UsageRecord } from "../../src/core/types";

const T0 = Date.parse("2026-11-05T14:30:00.000Z");
const all = () => true;

function rec(
  key: string,
  o: Partial<Omit<UsageRecord, "tokens">> & { tokens?: Tokens } = {},
): UsageRecord {
  return {
    key,
    keySource: "usageId",
    kind: "call",
    source: "copilot",
    sessionId: "s1",
    folderId: "f1",
    timestampMs: T0,
    model: "model-a",
    tokens: {
      input: 100,
      output: 20,
      cacheRead: 10,
      cacheWrite: 50,
      reasoning: 5,
    },
    ...o,
  };
}

describe("UsageStore dedupe", () => {
  it("same usageId in two files counted once", () => {
    const s = new UsageStore();
    expect(s.add(rec("u1"), "a.jsonl")).toBe(true);
    expect(s.add(rec("u1"), "b.jsonl")).toBe(false);
    const t = s.totals(all)!;
    expect(t.records).toBe(1);
    expect(t.input).toStrictEqual({ sum: 100, reported: 1, missing: 0 });
  });

  it("reset of first file keeps record seen in second", () => {
    const s = new UsageStore();
    s.add(rec("u1"), "f1");
    s.add(rec("u1"), "f2");
    s.resetFile("f1");
    expect(s.totals(all)!.records).toBe(1);
    s.resetFile("f2");
    expect(s.totals(all)).toBeUndefined();
  });

  it("resetFile then re-add", () => {
    const s = new UsageStore();
    expect(s.add(rec("u1"), "f1")).toBe(true);
    s.resetFile("f1");
    expect(s.totals(all)).toBeUndefined();
    expect(s.add(rec("u1"), "f1")).toBe(true);
    expect(s.totals(all)!.records).toBe(1);
  });

  it("resetFile of an unknown file is a no-op", () => {
    const s = new UsageStore();
    s.add(rec("u1"), "f1");
    s.resetFile("nope");
    expect(s.totals(all)!.records).toBe(1);
  });
});

describe("metrics", () => {
  it("missing is not zero", () => {
    const s = new UsageStore();
    s.add(rec("u1"), "f");
    s.add(rec("u2", { tokens: { input: 1 } }), "f");
    expect(s.totals(all)!.cacheWrite).toStrictEqual({
      sum: 50,
      reported: 1,
      missing: 1,
    });

    const s2 = new UsageStore();
    s2.add(rec("u1", { tokens: { input: 1 } }), "f");
    s2.add(rec("u2", { tokens: { input: 2 } }), "f");
    const t = s2.totals(all)!;
    expect(t.cacheWrite).toStrictEqual({ sum: 0, reported: 0, missing: 2 });
    expect(t.durationMs).toStrictEqual({ sum: 0, reported: 0, missing: 2 });
    expect(t.input).toStrictEqual({ sum: 3, reported: 2, missing: 0 });
  });

  it("counts durationMs and nanoAiu", () => {
    const s = new UsageStore();
    s.add(rec("u1", { durationMs: 1500, nanoAiu: 7 }), "f");
    s.add(rec("u2", { durationMs: 500 }), "f");
    const t = s.totals(all)!;
    expect(t.durationMs).toStrictEqual({ sum: 2000, reported: 2, missing: 0 });
    expect(t.nanoAiu).toStrictEqual({ sum: 7, reported: 1, missing: 1 });
  });

  it("addMetrics", () => {
    expect(
      addMetrics(
        { sum: 100, reported: 3, missing: 0 },
        { sum: 0, reported: 0, missing: 3 },
      ),
    ).toStrictEqual({ sum: 100, reported: 3, missing: 3 });
    expect(
      addMetrics(
        { sum: 0, reported: 0, missing: 3 },
        { sum: 0, reported: 0, missing: 3 },
      ),
    ).toStrictEqual({ sum: 0, reported: 0, missing: 3 });
  });

  it("per-model breakdown", () => {
    const s = new UsageStore();
    s.add(rec("u1", { model: "model-a", tokens: { input: 1 } }), "f");
    s.add(rec("u2", { model: "model-a", tokens: { input: 2 } }), "f");
    s.add(
      rec("u3", { model: "model-b", tokens: { input: 10, output: 4 } }),
      "f",
    );
    const { model: _m, ...noModel } = rec("u4", { tokens: { input: 100 } });
    s.add(noModel, "f");
    const t = s.totals(all)!;
    expect(Object.keys(t.byModel).sort()).toStrictEqual(
      ["(unknown model)", "model-a", "model-b"].sort(),
    );
    expect(t.byModel["model-a"]!.records).toBe(2);
    expect(t.byModel["model-a"]!.input).toStrictEqual({
      sum: 3,
      reported: 2,
      missing: 0,
    });
    expect(t.byModel["model-a"]!.output).toStrictEqual({
      sum: 0,
      reported: 0,
      missing: 2,
    });
    expect(t.byModel["model-b"]!.input.sum).toBe(10);
    expect(t.byModel["model-b"]!.output).toStrictEqual({
      sum: 4,
      reported: 1,
      missing: 0,
    });
    expect(t.byModel["(unknown model)"]!.input.sum).toBe(100);
    expect("byModel" in t.byModel["model-a"]!).toBe(false);
    expect(t.input.sum).toBe(113);
    expect(t.records).toBe(4);
  });

  it("totals respects the filter and is undefined when nothing matches", () => {
    const s = new UsageStore();
    s.add(rec("u1", { folderId: "A" }), "f");
    s.add(rec("u2", { folderId: "B" }), "f");
    expect(s.totals((r) => r.folderId === "A")!.records).toBe(1);
    expect(s.totals((r) => r.folderId === "C")).toBeUndefined();
    expect(new UsageStore().totals(all)).toBeUndefined();
  });

  it("large sums stay finite", () => {
    const s = new UsageStore();
    s.add(rec("u1", { tokens: { input: Number.MAX_SAFE_INTEGER } }), "f");
    s.add(rec("u2", { tokens: { input: Number.MAX_SAFE_INTEGER } }), "f");
    const sum = s.totals(all)!.input.sum;
    expect(sum).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(sum)).toBe(true);
  });
});

describe("latest", () => {
  it("maps folderId to newest timestampMs", () => {
    const s = new UsageStore();
    s.add(rec("u1", { folderId: "A", timestampMs: 100 }), "f");
    s.add(rec("u2", { folderId: "A", timestampMs: 300 }), "f");
    s.add(rec("u3", { folderId: "A", timestampMs: 200 }), "f");
    s.add(rec("u4", { folderId: "B", timestampMs: 50 }), "g");
    expect(s.latest()).toStrictEqual(
      new Map([
        ["A", 300],
        ["B", 50],
      ]),
    );
    s.resetFile("g");
    expect(s.latest()).toStrictEqual(new Map([["A", 300]]));
  });
});

describe("local day boundaries (TZ America/Toronto)", () => {
  it("runs in America/Toronto", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      "America/Toronto",
    );
  });

  it("today excludes records before local midnight", () => {
    const now = new Date("2026-11-05T05:30:00Z");
    const start = localDayStart(now);
    expect(start).toBe(Date.parse("2026-11-05T05:00:00Z"));
    const s = new UsageStore();
    s.add(
      rec("before", { timestampMs: Date.parse("2026-11-05T04:59:59Z") }),
      "f",
    );
    s.add(
      rec("after", { timestampMs: Date.parse("2026-11-05T05:00:01Z") }),
      "f",
    );
    const t = s.totals((r) => r.timestampMs >= start)!;
    expect(t.records).toBe(1);
  });

  it("DST", () => {
    const now = new Date("2026-11-01T17:00:00Z");
    expect(localDayStart(now)).toBe(Date.parse("2026-11-01T04:00:00Z"));
    expect(nextLocalMidnight(now)).toBe(Date.parse("2026-11-02T05:00:00Z"));
    expect(nextLocalMidnight(now) - localDayStart(now)).toBe(25 * 3600_000);
  });
});

describe("hostile keys (D28)", () => {
  it("never reach the prototype", () => {
    const s = new UsageStore();
    // Bypass the extractor: the store must hold even if a bad key gets through.
    for (const model of ["__proto__", "constructor", "prototype", "toString"]) s.add(rec(`k-${model}`, { model }), "f");
    const t = s.totals(all)!;
    expect(t.records).toBe(4);
    expect(Object.keys(t.byModel).sort()).toStrictEqual(["__proto__", "constructor", "prototype", "toString"]);
    expect(t.byModel["__proto__"]!.records).toBe(1);
    const b = s.totalsByBucket(1, () => 0)[0]!;
    expect(Object.keys(b.byModel)).toHaveLength(4);
    expect(({} as Record<string, unknown>).records).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("byLocalDay", () => {
  it("today's bucket has no upper bound, like the Today figure", async () => {
    const { byLocalDay } = await import("../../src/core/store");
    const store = new UsageStore();
    const now = new Date(2026, 10, 5, 10, 0, 0);
    store.add({ key: "skew", keySource: "usageId", kind: "call", source: "copilot", sessionId: "s", folderId: "s", timestampMs: new Date(2026, 10, 6, 3).getTime(), tokens: { input: 1 } }, "f");
    const d = byLocalDay(store, now);
    expect(d).toHaveLength(5);
    expect(d[4]!.totals!.records).toBe(1);
  });
});

/** A session total of folder `f` (sessionId = folderId), as parseShutdownLine builds it. */
function total(f: string, model: string, o: Partial<UsageRecord> = {}): UsageRecord {
  return {
    key: `shutdown:${f}:${model}`,
    keySource: "shutdown",
    kind: "sessionTotal",
    source: "copilot",
    sessionId: f,
    folderId: f,
    timestampMs: T0,
    startedMs: T0 - 3_600_000,
    model,
    tokens: { input: 600, output: 120 },
    calls: 6,
    ...o,
  };
}

describe("session totals (D29)", () => {
  it("calls: a call counts 1, a total counts requests.count; sessionTotals counts total rows", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "s1", folderId: "s1" }), "a");
    expect(s.setSessionTotals("f2", "b", [total("f2", "model-a"), total("f2", "model-b", { calls: 2 })])).toBe(true);
    const t = s.totals(all)!;
    expect(t.records).toBe(3);
    expect(t.calls).toBe(9);
    expect(t.sessionTotals).toBe(2);
    expect(t.byModel["model-a"]!.calls).toBe(7);
    expect(t.byModel["model-a"]!.sessionTotals).toBe(1);
    expect(t.byModel["model-b"]!.calls).toBe(2);
    expect(t.input.sum).toBe(1300);
  });

  it("a total without requests.count adds no calls", () => {
    const s = new UsageStore();
    s.setSessionTotals("f", "a", [total("f", "m", { calls: undefined })]);
    expect(s.totals(all)!.calls).toBe(0);
  });

  it("setSessionTotals replaces the session's previous totals: last wins, never summed", () => {
    const s = new UsageStore();
    s.setSessionTotals("f", "a", [total("f", "model-a"), total("f", "model-b")]);
    s.setSessionTotals("f", "a", [total("f", "model-a", { tokens: { input: 900, output: 100 } })]);
    const t = s.totals(all)!;
    expect(t.records).toBe(1);
    expect(t.input.sum).toBe(900);
    expect(Object.keys(t.byModel)).toStrictEqual(["model-a"]);
  });

  it("setSessionTotals reports no change for identical totals", () => {
    const s = new UsageStore();
    s.setSessionTotals("f", "a", [total("f", "m")]);
    expect(s.setSessionTotals("f", "a", [total("f", "m")])).toBe(false);
    expect(s.setSessionTotals("f", "a", [total("f", "m", { calls: 7 })])).toBe(true);
  });

  it("totals are hidden while the session has call records, in both insertion orders", () => {
    for (const totalsFirst of [true, false]) {
      const s = new UsageStore();
      const call = () => s.add(rec("u1", { sessionId: "f", folderId: "f" }), "a");
      const tot = () => s.setSessionTotals("f", "a", [total("f", "model-a")]);
      if (totalsFirst) {
        tot();
        call();
      } else {
        call();
        tot();
      }
      const t = s.totals(all)!;
      expect({ totalsFirst, records: t.records, calls: t.calls, sessionTotals: t.sessionTotals }).toEqual({ totalsFirst, records: 1, calls: 1, sessionTotals: 0 });
      expect(s.records(all)).toHaveLength(1);
      expect(s.totalsByBucket(1, () => 0)[0]!.records).toBe(1);
      expect(s.sessionTotalSessions().size).toBe(0);
    }
  });

  it("resetFile of the call file un-hides the totals; resetFile of the totals file removes them", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "f", folderId: "f" }), "calls.jsonl");
    s.setSessionTotals("f", "totals.jsonl", [total("f", "model-a")]);
    s.resetFile("calls.jsonl");
    expect(s.totals(all)!.sessionTotals).toBe(1);
    expect([...s.sessionTotalSessions()]).toStrictEqual(["f"]);
    s.resetFile("totals.jsonl");
    expect(s.totals(all)).toBeUndefined();
    // and the folder can take new totals afterwards
    expect(s.setSessionTotals("f", "totals.jsonl", [total("f", "model-a")])).toBe(true);
    expect(s.totals(all)!.records).toBe(1);
  });

  it("a duplicate call key in two files keeps the session's totals hidden until both files reset", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "f", folderId: "f" }), "a");
    s.add(rec("u1", { sessionId: "f", folderId: "f" }), "b");
    s.setSessionTotals("f", "t", [total("f", "m")]);
    s.resetFile("a");
    expect(s.totals(all)!.sessionTotals).toBe(0);
    s.resetFile("b");
    expect(s.totals(all)!.sessionTotals).toBe(1);
  });

  it("a duplicate call key from another folder hides that folder's session total (D29), and keeps hiding it after the first folder's file resets", () => {
    const s = new UsageStore();
    // folder B is a copy of folder A: same usageId, plus B's own shutdown total
    s.add(rec("u1", { sessionId: "A", folderId: "A" }), "A/events.jsonl");
    s.add(rec("u1", { sessionId: "B", folderId: "B" }), "B/events.jsonl");
    s.setSessionTotals("B", "B/events.jsonl", [total("B", "model-a")]);
    expect(s.totals(all)).toMatchObject({ records: 1, calls: 1, sessionTotals: 0 });
    expect(s.sessionTotalSessions().size).toBe(0);
    s.resetFile("A/events.jsonl");
    expect(s.totals(all)).toMatchObject({ records: 1, calls: 1, sessionTotals: 0 });
    s.resetFile("B/events.jsonl");
    expect(s.totals(all)).toBeUndefined();
  });

  it("a folder holding a call key in two of its files keeps holding it until both reset (D29)", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "A", folderId: "A" }), "A/a.jsonl");
    s.add(rec("u1", { sessionId: "B", folderId: "B" }), "B/1.jsonl");
    s.add(rec("u1", { sessionId: "B", folderId: "B" }), "B/2.jsonl");
    s.setSessionTotals("B", "B/t.jsonl", [total("B", "model-a")]);
    s.resetFile("A/a.jsonl");
    s.resetFile("B/1.jsonl");
    expect(s.totals(all)!.sessionTotals).toBe(0);
    s.resetFile("B/2.jsonl");
    expect(s.totals(all)!.sessionTotals).toBe(1);
  });

  it("latest() and records() skip hidden totals", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "f", folderId: "f", timestampMs: T0 - 1000 }), "a");
    s.setSessionTotals("f", "a", [total("f", "m", { timestampMs: T0 + 5000 })]);
    expect(s.latest().get("f")).toBe(T0 - 1000);
    expect(s.records((r) => r.kind === "sessionTotal")).toHaveLength(0);
  });

  it("sessionSummaries: sessionTotal flag, firstMs from startedMs, calls summed, no growth", () => {
    const s = new UsageStore();
    s.setSessionTotals("f", "a", [total("f", "model-a", { calls: 4 }), total("f", "model-b", { calls: 9 })]);
    for (let i = 0; i < 12; i++) s.add(rec(`c${i}`, { sessionId: "g", folderId: "g", nanoAiu: 1e9 * (i + 1), timestampMs: T0 + i }), "b");
    const list = sessionSummaries(s, 0, Number.POSITIVE_INFINITY);
    const legacy = list.find((x) => x.sessionId === "f")!;
    expect(legacy).toMatchObject({ sessionTotal: true, firstMs: T0 - 3_600_000, lastMs: T0, calls: 13, topModel: "model-b" });
    expect(legacy.growth).toBeUndefined();
    const live = list.find((x) => x.sessionId === "g")!;
    expect(live.sessionTotal).toBeUndefined();
    expect(live.calls).toBe(12);
    expect(live.growth).toBeGreaterThan(1);
  });

  it("projectSummaries sums calls; toolSummaries ignores totals", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "g", folderId: "g", tools: { bash: 1 } }), "a");
    s.setSessionTotals("f", "b", [total("f", "m")]);
    const p = projectSummaries(s, 0, Number.POSITIVE_INFINITY, () => "proj");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ sessions: 2, calls: 7 });
    expect(p[0]!.tokens.sum).toBe(120 + 720);
    const tools = toolSummaries(s, 0, Number.POSITIVE_INFINITY);
    expect(tools.map((t) => [t.name, t.calls])).toStrictEqual([["bash", 1]]);
  });
});

describe("v0.4 review fixes (store)", () => {
  it("a total is hidden when its folder holds a call record under another sessionId, in both orders (review 1)", () => {
    for (const totalsFirst of [true, false]) {
      const s = new UsageStore();
      const call = () => s.add(rec("u1", { sessionId: "A", folderId: "B" }), "b.jsonl");
      const tot = () => s.setSessionTotals("B", "b.jsonl", [total("B", "model-a")]);
      if (totalsFirst) {
        tot();
        call();
      } else {
        call();
        tot();
      }
      const t = s.totals(all)!;
      expect({ totalsFirst, records: t.records, calls: t.calls, sessionTotals: t.sessionTotals, input: t.input.sum }).toEqual({ totalsFirst, records: 1, calls: 1, sessionTotals: 0, input: 100 });
      expect(s.sessionTotalSessions().size).toBe(0);
      expect(s.records(all)).toHaveLength(1);
    }
  });

  it("resetFile of the call file un-hides a folder's total again (review 1)", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "A", folderId: "B" }), "calls.jsonl");
    s.setSessionTotals("B", "totals.jsonl", [total("B", "model-a")]);
    expect(s.totals(all)!.sessionTotals).toBe(0);
    s.resetFile("calls.jsonl");
    expect(s.totals(all)!.sessionTotals).toBe(1);
  });

  it("a call key equal to a session-total key does not collide (N10)", () => {
    for (const totalsFirst of [true, false]) {
      const s = new UsageStore();
      const call = () => s.add(rec("shutdown:f:m", { sessionId: "g", folderId: "g" }), "a");
      const tot = () => s.setSessionTotals("f", "b", [total("f", "m")]);
      if (totalsFirst) {
        tot();
        expect(call()).toBe(true);
      } else {
        call();
        tot();
      }
      expect(s.totals(all)).toMatchObject({ records: 2, sessionTotals: 1 });
    }
  });

  it("per-call AIU is kept apart from session-total AIU (review 2)", () => {
    const s = new UsageStore();
    for (let i = 0; i < 4; i++) s.add(rec(`c${i}`, { sessionId: "g", folderId: "g", model: "m", nanoAiu: 1e9 }), "a");
    s.setSessionTotals("f", "b", [total("f", "m", { nanoAiu: 4e10 })]);
    const c = s.totals(all)!.byModel["m"]!;
    expect(c.nanoAiu.sum).toBe(4.4e10);
    expect(c.callNanoAiu).toEqual({ sum: 4e9, reported: 4, missing: 0 });
  });

  it("a total without requests.count is counted as calls missing; its session keeps a top model (N1)", () => {
    const s = new UsageStore();
    s.setSessionTotals("f", "a", [total("f", "m", { calls: undefined })]);
    const t = s.totals(all)!;
    expect(t.calls).toBe(0);
    expect(t.callsMissing).toBe(1);
    expect(t.byModel["m"]!.callsMissing).toBe(1);
    const [x] = sessionSummaries(s, 0, Number.POSITIVE_INFINITY);
    expect(x).toMatchObject({ topModel: "m", calls: 0, callsMissing: 1 });
    const [p] = projectSummaries(s, 0, Number.POSITIVE_INFINITY, () => "proj");
    expect(p).toMatchObject({ calls: 0, callsMissing: 1 });
  });

  it("sessions cache-read share uses the per-model prompt convention (N4)", () => {
    const s = new UsageStore();
    // "separate": cached tokens are reported apart from input, so the prompt is input + cacheRead + cacheWrite.
    s.add(rec("c1", { sessionId: "g", folderId: "g", model: "sep", tokens: { input: 100, cacheRead: 300, cacheWrite: 100 } }), "a");
    s.add(rec("c2", { sessionId: "h", folderId: "h", model: "inc", tokens: { input: 1000, cacheRead: 400, cacheWrite: 0 } }), "a");
    const conv = new Map([["sep", "separate" as const], ["inc", "included" as const]]);
    const list = sessionSummaries(s, 0, Number.POSITIVE_INFINITY, 10, all, conv);
    expect(list.find((x) => x.sessionId === "g")!.input!.sum).toBe(500);
    expect(list.find((x) => x.sessionId === "h")!.input!.sum).toBe(1000);
  });
});

describe("v0.8 source dimension (D40, D42, D46, D52)", () => {
  const cc = (key: string, o: Partial<Omit<UsageRecord, "tokens">> & { tokens?: Tokens } = {}) =>
    rec(key, { source: "claude-code", keySource: "claudeMessageId", sessionId: "c1", folderId: "c1", nanoAiu: undefined, ...o });

  it("store keys are namespaced by source: the same key from two sources counts twice", () => {
    const s = new UsageStore();
    expect(s.add(rec("k", { nanoAiu: 1 }), "a.jsonl")).toBe(true);
    expect(s.add(cc("k"), "b.jsonl")).toBe(true);
    expect(s.totals(all)!.records).toBe(2);
  });

  it("a same-file repeat replaces tokens and scalars, sums tools and reports the change", () => {
    const s = new UsageStore();
    s.add(cc("m1", { tokens: { input: 10, output: 1 }, tools: { Read: 1 }, finishReason: "tool_calls" }), "a.jsonl");
    const changed = s.add(cc("m1", { tokens: { input: 10, output: 50 }, timestampMs: T0 + 1000, tools: { Read: 1, Bash: 2 }, finishReason: "stop" }), "a.jsonl");
    expect(changed).toBe(true);
    const [r] = s.records(all);
    expect(r!.tokens).toStrictEqual({ input: 10, output: 50 });
    expect(r!.timestampMs).toBe(T0 + 1000);
    expect(r!.finishReason).toBe("stop");
    expect(r!.tools).toEqual({ Read: 2, Bash: 2 });
    expect(Object.getPrototypeOf(r!.tools)).toBeNull();
    expect(s.totals(all)!.records).toBe(1);
  });

  it("a same-file repeat with identical figures and no tools reports no change", () => {
    const s = new UsageStore();
    s.add(cc("m1"), "a.jsonl");
    expect(s.add(cc("m1"), "a.jsonl")).toBe(false);
  });

  it("a same-file repeat drops a field the new line does not report", () => {
    const s = new UsageStore();
    s.add(cc("m1", { finishReason: "tool_calls", durationMs: 5 }), "a.jsonl");
    expect(s.add(cc("m1", { finishReason: undefined, durationMs: 7 }), "a.jsonl")).toBe(true);
    const [r] = s.records(all);
    expect("finishReason" in r!).toBe(false);
    expect(r!.durationMs).toBe(7);
  });

  it("same-file tool merge keeps at most 64 names", () => {
    const s = new UsageStore();
    const many = (from: number) => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`t${from + i}`, 1]));
    s.add(cc("m1", { tools: many(0) }), "a.jsonl");
    s.add(cc("m1", { tools: { ...many(40), t0: 1 } }), "a.jsonl");
    const tools = s.records(all)[0]!.tools!;
    expect(Object.keys(tools)).toHaveLength(64);
    expect(tools.t0).toBe(2);
  });

  it("a cross-file repeat returns false and keeps the first file's record", () => {
    const s = new UsageStore();
    s.add(cc("m1", { tokens: { input: 10 } }), "a.jsonl");
    expect(s.add(cc("m1", { tokens: { input: 99 } }), "b.jsonl")).toBe(false);
    expect(s.records(all)[0]!.tokens.input).toBe(10);
  });

  it("another holder's repeat lines never merge: the first file keeps the record", () => {
    const s = new UsageStore();
    expect(s.add(cc("x", { tokens: { input: 10 }, tools: { Read: 1 } }), "A")).toBe(true);
    expect(s.add(cc("x", { tokens: { input: 10 }, tools: { Read: 1 } }), "B")).toBe(false);
    expect(s.add(cc("x", { tokens: { input: 99 }, tools: { Read: 1 } }), "B")).toBe(false);
    const [r] = s.records(all);
    expect(r!.tokens).toStrictEqual({ input: 10 });
    expect(r!.tools).toEqual({ Read: 1 });
    // the owner's own later line still merges
    expect(s.add(cc("x", { tokens: { input: 20 }, tools: { Bash: 1 } }), "A")).toBe(true);
    expect(s.records(all)[0]!.tools).toEqual({ Read: 1, Bash: 1 });
  });

  it("after the owner is reset, its re-read lines do not merge into the next holder's record", () => {
    const s = new UsageStore();
    s.add(cc("x", { tokens: { input: 10 }, tools: { Read: 1 } }), "A");
    s.add(cc("x", { tokens: { input: 10 }, tools: { Read: 1 } }), "B");
    s.resetFile("A");
    expect(s.add(cc("x", { tokens: { input: 10 }, tools: { Read: 1 } }), "A")).toBe(false);
    expect(s.add(cc("x", { tokens: { input: 50 }, tools: { Read: 1 } }), "A")).toBe(false);
    const [r] = s.records(all);
    expect(r!.tokens).toStrictEqual({ input: 10 });
    expect(r!.tools).toEqual({ Read: 1 });
    expect(s.totals(all)!.records).toBe(1);
  });

  it("when the owner is reset, the earliest remaining holder owns the record (its repeats merge, later holders' do not)", () => {
    const s = new UsageStore();
    s.add(cc("x", { tokens: { input: 10 } }), "A");
    s.add(cc("x", { tokens: { input: 10 } }), "B");
    s.add(cc("x", { tokens: { input: 10 } }), "C");
    s.resetFile("A");
    expect(s.add(cc("x", { tokens: { input: 30 } }), "C")).toBe(false);
    expect(s.add(cc("x", { tokens: { input: 20 } }), "B")).toBe(true);
    expect(s.records(all)[0]!.tokens).toStrictEqual({ input: 20 });
    s.resetFile("B");
    expect(s.add(cc("x", { tokens: { input: 40 } }), "C")).toBe(true);
    expect(s.records(all)[0]!.tokens).toStrictEqual({ input: 40 });
    s.resetFile("C");
    expect(s.totals(all)).toBeUndefined();
  });

  it("a folder keeps holding a call key while any of three holders from it remains, across owner changes (D29)", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "s", folderId: "f" }), "f/a");
    s.add(rec("u1", { sessionId: "s", folderId: "g" }), "g/a");
    s.add(rec("u1", { sessionId: "s", folderId: "f" }), "f/b");
    s.setSessionTotals("f", "f/t", [total("f", "m")]);
    s.setSessionTotals("g", "g/t", [total("g", "m")]);
    s.resetFile("f/a");
    s.resetFile("g/a");
    // f/b still holds u1, so folder f's total stays hidden; folder g holds nothing any more
    expect(s.totals(all)!.sessionTotals).toBe(1);
    expect([...s.sessionTotalSessions()]).toEqual(["g"]);
    s.resetFile("f/b");
    expect(s.totals(all)!.sessionTotals).toBe(2);
  });

  it("a merged record keeps hiding its session's totals; resetFile deletes it once", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "f", folderId: "f", tools: { bash: 1 } }), "a");
    s.add(rec("u1", { sessionId: "f", folderId: "f", tokens: { input: 7 }, tools: { bash: 1 } }), "a");
    s.setSessionTotals("f", "t", [total("f", "m")]);
    expect(s.totals(all)!.records).toBe(1);
    expect(s.totals(all)!.sessionTotals).toBe(0);
    s.resetFile("a");
    const t = s.totals(all)!;
    expect(t.records).toBe(1);
    expect(t.sessionTotals).toBe(1);
  });

  it("a repeat with no tools on either side creates no tools object", () => {
    const s = new UsageStore();
    s.add(cc("m1"), "a");
    expect(s.add(cc("m1", { tools: {} }), "a")).toBe(false);
    expect("tools" in s.records(all)[0]!).toBe(false);
  });

  it("USD metrics count Copilot records only: a Claude Code record is never 'missing'", () => {
    const s = new UsageStore();
    s.add(cc("m1"), "a.jsonl");
    s.add(cc("m2"), "a.jsonl");
    const t = s.totals(all)!;
    expect(t.nanoAiu).toStrictEqual({ sum: 0, reported: 0, missing: 0 });
    expect(t.callNanoAiu).toStrictEqual({ sum: 0, reported: 0, missing: 0 });
    expect(t.input.reported).toBe(2);
  });

  it("a Copilot session total without AIU still bumps missing", () => {
    const s = new UsageStore();
    s.add(cc("m1"), "a.jsonl");
    s.setSessionTotals("f", "t.jsonl", [total("f", "m")]);
    const t = s.totals(all)!;
    expect(t.nanoAiu.missing).toBe(1);
    expect(t.callNanoAiu.missing).toBe(0);
  });

  it("totals fill sources and bySource", () => {
    const s = new UsageStore();
    s.add(rec("u1", { nanoAiu: 7 }), "a");
    s.add(rec("u2", { nanoAiu: 3 }), "a");
    s.add(cc("m1"), "b");
    const t = s.totals(all)!;
    expect(t.sources).toEqual({ copilot: 2, "claude-code": 1 });
    expect(Object.getPrototypeOf(t.sources)).toBeNull();
    expect(t.bySource!.copilot!.records).toBe(2);
    expect(t.bySource!.copilot!.nanoAiu.sum).toBe(10);
    expect(t.bySource!["claude-code"]!.records).toBe(1);
    expect(t.bySource!["claude-code"]!.sources).toEqual({ "claude-code": 1 });
    expect(t.bySource!.codex).toBeUndefined();
    const [day] = s.totalsByBucket(1, () => 0);
    expect(day!.bySource!["claude-code"]!.records).toBe(1);
  });

  it("toolSummaries marks Read built-in for Claude Code and bash for Copilot, with sources", () => {
    const s = new UsageStore();
    s.add(rec("u1", { tools: { bash: 1, Read: 1 } }), "a");
    s.add(cc("m1", { tools: { Read: 2, bash: 1, mcp__gh__issue: 1 } }), "b");
    const by = Object.fromEntries(toolSummaries(s, 0, Number.POSITIVE_INFINITY).map((t) => [t.name, t]));
    expect(by.bash!.builtIn).toBe(true);
    expect(by.Read!.builtIn).toBe(true);
    expect(by.mcp__gh__issue!.builtIn).toBe(false);
    expect(by.Read!.sources).toEqual({ copilot: 1, "claude-code": 1 });
    expect(BUILT_IN_TOOLS.codex.size).toBe(0);
    expect(BUILT_IN_TOOLS["claude-code"].has("Read")).toBe(true);
    expect(BUILT_IN_TOOLS.copilot.has("Read")).toBe(false);
  });

  it("toolSummaries judges built-in by the using source only", () => {
    const s = new UsageStore();
    s.add(cc("m1", { tools: { bash: 1 } }), "b");
    expect(toolSummaries(s, 0, Number.POSITIVE_INFINITY)[0]!.builtIn).toBe(false);
  });

  it("project, recent and session summaries carry the source; USD stays Copilot-only", () => {
    const s = new UsageStore();
    s.add(rec("u1", { nanoAiu: 5 }), "a");
    s.add(cc("m1"), "b");
    const [p] = projectSummaries(s, 0, Number.POSITIVE_INFINITY, () => "repo");
    expect(p!.sources).toEqual({ copilot: 1, "claude-code": 1 });
    expect(p!.nanoAiu).toStrictEqual({ sum: 5, reported: 1, missing: 0 });
    const recent = recentProjects(s, 0, 0, () => "repo");
    expect(recent.today[0]!.sources).toEqual({ copilot: 1, "claude-code": 1 });
    expect(recent.last7[0]!.nanoAiu.missing).toBe(0);
    const sessions = sessionSummaries(s, 0, Number.POSITIVE_INFINITY);
    const c1 = sessions.find((x) => x.sessionId === "c1")!;
    expect(c1.source).toBe("claude-code");
    expect(c1.nanoAiu).toStrictEqual({ sum: 0, reported: 0, missing: 0 });
    expect(sessions.find((x) => x.sessionId === "s1")!.source).toBe("copilot");
    const act = dailyActivity(s, T0, localDayStart(new Date(T0)));
    expect(act.days[0]!.nanoAiu).toStrictEqual({ sum: 5, reported: 1, missing: 0 });
  });

  it("promptOf: a non-Copilot record's prompt is its input, whatever the convention", () => {
    const r = cc("m1", { model: "claude-x", tokens: { input: 100, cacheRead: 100_000, cacheWrite: 5_000 } });
    expect(promptOf(r, new Map([["claude-x", "separate"]]))).toBe(100);
  });
});
