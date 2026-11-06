// A2 data: the unfiltered per-day activity over the history window, and the viewed
// month's cache-reuse share and prior-month comparison.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { dailyActivity, UsageStore } from "../../src/core/store";
import type { Snapshot, UsageRecord } from "../../src/core/types";
import { CANARY, jsonl, otherEvent, sessionTree, shutdownEvent, usageEvent } from "../fixtures/build";

function rec(key: string, ts: number, o: Partial<UsageRecord> = {}): UsageRecord {
  return { key, keySource: "usageId", kind: "call", sessionId: "s1", folderId: "s1", timestampMs: ts, model: "model-a", tokens: { input: 100, output: 10 }, nanoAiu: 1e9, ...o };
}

describe("dailyActivity", () => {
  const from = new Date(2026, 9, 1).getTime();
  const today = new Date(2026, 10, 6).getTime();

  it("buckets visible records per local day from the window start; empty days are not listed", () => {
    const st = new UsageStore();
    st.add(rec("old", new Date(2026, 8, 30, 23).getTime()), "f");
    st.add(rec("a", new Date(2026, 9, 1, 0, 0).getTime()), "f");
    st.add(rec("b", new Date(2026, 9, 1, 23, 59).getTime(), { sessionId: "s2" }), "f");
    st.add(rec("c", new Date(2026, 10, 5, 12).getTime(), { nanoAiu: undefined }), "f");
    // clock-skewed: after today counts today, like the Today figure
    st.add(rec("d", new Date(2026, 10, 7, 3).getTime()), "f");
    const a = dailyActivity(st, from, today);
    expect(a.fromMs).toBe(from);
    expect(a.days.map((d) => d.dayStartMs)).toEqual([from, new Date(2026, 10, 5).getTime(), today]);
    const [oct1, nov5, nov6] = a.days;
    expect(oct1).toMatchObject({ calls: 2, sessions: 2, sessionTotals: 0, callsMissing: 0 });
    expect(oct1!.tokens).toEqual({ sum: 220, reported: 2, missing: 0 });
    expect(oct1!.nanoAiu).toEqual({ sum: 2e9, reported: 2, missing: 0 });
    expect(nov5!.nanoAiu).toEqual({ sum: 0, reported: 0, missing: 1 });
    expect(nov6!.calls).toBe(1);
  });

  it("a session total counts on its end day with its request count; a hidden one not at all", () => {
    const st = new UsageStore();
    const total = rec("shutdown:f9:model-a", new Date(2026, 10, 3, 18).getTime(), { kind: "sessionTotal", keySource: "shutdown", sessionId: "f9", folderId: "f9", calls: 7, startedMs: new Date(2026, 10, 1).getTime() });
    st.setSessionTotals("f9", "f", [total]);
    const hidden = rec("shutdown:f1:model-a", new Date(2026, 10, 4).getTime(), { kind: "sessionTotal", keySource: "shutdown", sessionId: "s1", folderId: "s1", calls: 99 });
    st.setSessionTotals("s1", "g", [hidden]);
    st.add(rec("x", new Date(2026, 10, 4, 9).getTime()), "g");
    const a = dailyActivity(st, from, today);
    expect(a.days.map((d) => new Date(d.dayStartMs).getDate())).toEqual([3, 4]);
    expect(a.days[0]).toMatchObject({ calls: 7, sessionTotals: 1, sessions: 1 });
    expect(a.days[1]).toMatchObject({ calls: 1, sessionTotals: 0 });
  });

  it("days are local midnights across a DST change", () => {
    const st = new UsageStore();
    for (let d = 1; d <= 6; d++) st.add(rec(`k${d}`, new Date(2026, 10, d, 0, 30).getTime()), "f");
    const a = dailyActivity(st, new Date(2026, 10, 1).getTime(), today);
    expect(a.days.map((d) => d.dayStartMs)).toEqual([1, 2, 3, 4, 5, 6].map((d) => new Date(2026, 10, d).getTime()));
  });
});

describe("monitor: A2 snapshot fields", () => {
  const A = "0000aaaa-0000-4000-8000-000000000001";
  const B = "0000bbbb-0000-4000-8000-000000000002";
  const L = "0000cccc-0000-4000-8000-000000000003";
  let root: string;
  let snaps: Snapshot[];
  let now = new Date(2026, 10, 6, 10).getTime();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cum-a2-"));
    snaps = [];
    now = new Date(2026, 10, 6, 10).getTime();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const make = (historyMonths = 2) =>
    new UsageMonitor({ root, rootSource: "default", now: () => new Date(now), isLive: () => false, log: new Logger(() => {}), onSnapshot: (s) => snaps.push(s), historyMonths, readTotals: true });
  const at = (mo: number, d: number, h = 9) => new Date(2026, mo, d, h).toISOString();
  const u = (n: string, ts: string, o: Parameters<typeof usageEvent>[0] = {}) => usageEvent({ usageId: n, id: `e-${n}`, sourceSessionId: A, timestamp: ts, ...o });

  it("activity covers the history window, ignores the filter, and counts session totals on their end day", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([u("a1", at(9, 3)), u("a2", at(10, 5)), u("a3", at(10, 6, 8)), u("a4", at(10, 6, 9), { sourceSessionId: B })]) },
      { id: L, lines: jsonl([otherEvent("assistant.turn_end", { timestamp: at(10, 4) }), shutdownEvent({ timestamp: at(10, 4, 20) })]) },
    ]);
    const mon = make();
    await mon.refresh({ full: true });
    let s = snaps.at(-1)!;
    expect(s.activity!.fromMs).toBe(new Date(2026, 9, 1).getTime());
    expect(s.activity!.days.map((d) => new Date(d.dayStartMs).toDateString())).toEqual(
      [new Date(2026, 9, 3), new Date(2026, 10, 4), new Date(2026, 10, 5), new Date(2026, 10, 6)].map((d) => d.toDateString()),
    );
    expect(s.activity!.days.at(-1)).toMatchObject({ calls: 2, sessions: 2 });
    expect(s.activity!.days[1]).toMatchObject({ sessionTotals: 1 });
    mon.setFilter({ tool: "no-such-tool" });
    await mon.refresh();
    s = snaps.at(-1)!;
    expect(s.month!.totals).toBeUndefined();
    expect(s.activity!.days).toHaveLength(4);
  });

  it("prior: last month up to the same point for the current month; absent outside the window", async () => {
    await sessionTree(root, [
      {
        id: A,
        lines: jsonl([
          u("o1", at(9, 2), { totalNanoAiu: 1e9 }),
          u("o2", at(9, 6, 9), { totalNanoAiu: 2e9 }),
          // Oct 6 11:00 is after "this point" (Nov 6 10:00 → Oct 6 10:00)
          u("o3", at(9, 6, 11), { totalNanoAiu: 4e9 }),
          u("o4", at(9, 20), { totalNanoAiu: 8e9 }),
          u("n1", at(10, 2), { totalNanoAiu: 16e9 }),
        ]),
      },
    ]);
    const mon = make();
    await mon.refresh({ full: true });
    let s = snaps.at(-1)!;
    expect(s.month!.prior!.monthStartMs).toBe(new Date(2026, 9, 1).getTime());
    expect(s.month!.prior!.toMs).toBe(new Date(2026, 9, 6, 10).getTime());
    expect(s.month!.prior!.totals!.nanoAiu.sum).toBe(3e9);
    // a past viewed month compares with the whole month before it, when that is in the window
    mon.selectMonth(new Date(2026, 9, 1).getTime());
    await mon.refresh();
    s = snaps.at(-1)!;
    expect(s.month!.isCurrent).toBe(false);
    expect(s.month!.prior).toBeUndefined();
    const one = new UsageMonitor({ root, rootSource: "default", now: () => new Date(now), isLive: () => false, log: new Logger(() => {}), onSnapshot: (x) => snaps.push(x), historyMonths: 1 });
    await one.refresh({ full: true });
    expect(snaps.at(-1)!.month!.prior).toBeUndefined();
  });

  it("prior: a past month's whole previous month, filtered like the month", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([u("s1", at(8, 30), { totalNanoAiu: 5e9 }), u("o1", at(9, 2), { totalNanoAiu: 1e9 })]) }]);
    const mon = make(3);
    mon.selectMonth(new Date(2026, 9, 1).getTime());
    await mon.refresh({ full: true });
    let s = snaps.at(-1)!;
    expect(s.month!.prior).toEqual(expect.objectContaining({ monthStartMs: new Date(2026, 8, 1).getTime(), toMs: new Date(2026, 9, 1).getTime() }));
    expect(s.month!.prior!.totals!.nanoAiu.sum).toBe(5e9);
    mon.setFilter({ tool: "no-such-tool" });
    await mon.refresh();
    s = snaps.at(-1)!;
    expect(s.month!.prior!.totals).toBeUndefined();
  });

  it("cache: prompt tokens and cache reads over the viewed month's sessions", async () => {
    // input 1000 already includes cache reads 500 + writes 50 (convention "included")
    await sessionTree(root, [{ id: A, lines: jsonl([u("n1", at(10, 2)), u("n2", at(10, 3)), u("o1", at(9, 3))]) }]);
    await make().refresh({ full: true });
    const s = snaps.at(-1)!;
    expect(s.month!.cache).toEqual({ prompt: { sum: 2000, reported: 2, missing: 0 }, cacheRead: { sum: 1000, reported: 2, missing: 0 } });
  });

  it("no log content reaches the new fields", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([u("n1", at(10, 2)), otherEvent("tool.execution_complete", { data: { content: CANARY } })]) }]);
    await make().refresh({ full: true });
    expect(JSON.stringify(snaps.at(-1)!.activity)).not.toContain(CANARY);
  });
});
