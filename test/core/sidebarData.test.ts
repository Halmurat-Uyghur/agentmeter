// A1 data: per-project figures for today and the last 7 days, never filtered, in one
// pass over the store (the side bar's "This workspace" and "Top projects" groups).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { recentProjects, UsageStore } from "../../src/core/store";
import type { Snapshot, UsageRecord } from "../../src/core/types";
import { CANARY, jsonl, sessionTree, usageEvent } from "../fixtures/build";

function rec(key: string, ts: number, o: Partial<UsageRecord> = {}): UsageRecord {
  return { key, keySource: "usageId", kind: "call", sessionId: "s1", folderId: "s1", timestampMs: ts, model: "model-a", tokens: { input: 100, output: 10 }, nanoAiu: 1e9, ...o };
}

describe("recentProjects", () => {
  const today = new Date(2026, 10, 6).getTime();
  const last7 = new Date(2026, 9, 31).getTime();

  it("groups today and the last 7 days by project in one pass, costliest first; older records skipped", () => {
    const st = new UsageStore();
    st.add(rec("old", new Date(2026, 9, 30, 23).getTime(), { folderId: "a" }), "f");
    st.add(rec("w1", new Date(2026, 10, 2).getTime(), { folderId: "a" }), "f");
    st.add(rec("w2", new Date(2026, 10, 3).getTime(), { folderId: "b", sessionId: "s2", nanoAiu: 5e9 }), "f");
    st.add(rec("t1", new Date(2026, 10, 6, 9).getTime(), { folderId: "a", sessionId: "s3" }), "f");
    // clock-skewed: after today counts today, like the Today figure
    st.add(rec("t2", new Date(2026, 10, 7, 1).getTime(), { folderId: "a", sessionId: "s3", nanoAiu: undefined }), "f");
    const projectOf = (r: UsageRecord) => (r.folderId === "a" ? "acme/web" : "tools");
    const { today: t, last7: w } = recentProjects(st, last7, today, projectOf);
    expect(w.map((g) => g.name)).toEqual(["tools", "acme/web"]);
    expect(w[1]).toMatchObject({ name: "acme/web", sessions: 2, calls: 3, tokens: { sum: 330, reported: 3, missing: 0 }, nanoAiu: { sum: 2e9, reported: 2, missing: 1 } });
    expect(t).toEqual([{ name: "acme/web", sessions: 1, calls: 2, tokens: { sum: 220, reported: 2, missing: 0 }, nanoAiu: { sum: 1e9, reported: 1, missing: 1 } }]);
  });

  it("session totals count their request count; one without it is marked callsMissing", () => {
    const st = new UsageStore();
    const total = rec("shutdown:f9:model-a", new Date(2026, 10, 6, 8).getTime(), { kind: "sessionTotal", keySource: "shutdown", sessionId: "f9", folderId: "f9", calls: undefined });
    st.setSessionTotals("f9", "f", [total]);
    const { today: t, last7: w } = recentProjects(st, last7, today, () => "p");
    expect(t[0]).toMatchObject({ calls: 0, callsMissing: 1, sessionTotals: 1 });
    expect(w[0]).toMatchObject({ calls: 0, callsMissing: 1 });
  });
});

describe("monitor: A1 snapshot fields", () => {
  const A = "0000aaaa-0000-4000-8000-000000000001";
  const B = "0000bbbb-0000-4000-8000-000000000002";
  let root: string;
  let snaps: Snapshot[];
  const now = new Date(2026, 10, 6, 10).getTime();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cum-a1-"));
    snaps = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const at = (mo: number, d: number, h = 9) => new Date(2026, mo, d, h).toISOString();
  const start = (cwd: string, ts: string) =>
    JSON.stringify({ type: "session.start", id: "s", parentId: null, timestamp: ts, data: { copilotVersion: "1.0.100-1", context: { cwd }, prompt: CANARY } });

  it("todayProjects and last7Projects ignore the filter and a selected month", async () => {
    await sessionTree(root, [
      { id: A, lines: start("/srv/x/code/acme-web", at(9, 25)) + "\n" + jsonl([usageEvent({ usageId: "a1", id: "e1", sourceSessionId: A, timestamp: at(9, 25) }), usageEvent({ usageId: "a2", id: "e2", sourceSessionId: A, timestamp: at(10, 6) })]) },
      { id: B, lines: start("/srv/x/code/tools", at(10, 4)) + "\n" + jsonl([usageEvent({ usageId: "b1", id: "e3", sourceSessionId: B, timestamp: at(10, 4) })]) },
    ]);
    const mon = new UsageMonitor({ root, rootSource: "default", now: () => new Date(now), isLive: () => false, log: new Logger(() => {}), onSnapshot: (s) => snaps.push(s), historyMonths: 2, readProjects: true });
    await mon.refresh({ full: true });
    let s = snaps.at(-1)!;
    expect(s.todayProjects!.map((g) => [g.name, g.calls])).toEqual([["acme-web", 1]]);
    expect(s.last7Projects!.map((g) => g.name).sort()).toEqual(["acme-web", "tools"]);
    expect(s.last7Projects!.find((g) => g.name === "acme-web")!.calls).toBe(1);
    mon.setFilter({ project: "tools" });
    mon.selectMonth(new Date(2026, 9, 1).getTime());
    await mon.refresh();
    s = snaps.at(-1)!;
    expect(s.todayProjects!.map((g) => g.name)).toEqual(["acme-web"]);
    expect(s.last7Projects).toHaveLength(2);
    expect(JSON.stringify(s.last7Projects)).not.toContain(CANARY);
    expect(JSON.stringify(s.last7Projects)).not.toContain("/srv/");
    mon.dispose();
  });
});
