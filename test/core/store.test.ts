import { describe, expect, it } from "vitest";
import {
  UsageStore,
  addMetrics,
  localDayStart,
  nextLocalMidnight,
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

describe("byLocalDay", () => {
  it("today's bucket has no upper bound, like the Today figure", async () => {
    const { byLocalDay } = await import("../../src/core/store");
    const store = new UsageStore();
    const now = new Date(2026, 10, 5, 10, 0, 0);
    store.add({ key: "skew", keySource: "usageId", sessionId: "s", folderId: "s", timestampMs: new Date(2026, 10, 6, 3).getTime(), tokens: { input: 1 } }, "f");
    const d = byLocalDay(store, now);
    expect(d).toHaveLength(5);
    expect(d[4]!.totals!.records).toBe(1);
  });
});
