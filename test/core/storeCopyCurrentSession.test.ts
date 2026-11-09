// Codex review of PR #22: an exact copy of a Copilot session folder carries the original
// folder's name as its sourceSessionId. Once the original goes and the copy owns the call,
// the monitor's current session for the copy's folder (looked up by sessionId === folderId)
// must show the call that Today counts.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { UsageStore } from "../../src/core/store";
import type { Snapshot, UsageRecord } from "../../src/core/types";
import { jsonl, sessionTree, usageEvent } from "../fixtures/build";

const A = "0000aaaa-0000-4000-8000-000000000001";
const B = "0000bbbb-0000-4000-8000-000000000002";
const C = "0000cccc-0000-4000-8000-000000000003";
const T0 = new Date(2026, 0, 15, 10, 0, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 0, 15, h, m, 0).toISOString();
const all = () => true;

function rec(key: string, o: Partial<UsageRecord> = {}): UsageRecord {
  return { key, keySource: "usageId", kind: "call", source: "copilot", sessionId: A, folderId: A, timestampMs: T0, model: "m", tokens: { input: 100, output: 20 }, ...o };
}

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("an exact folder copy's current session after the original goes", () => {
  it("store: the promoted call is filed under the copy's folder session", () => {
    const s = new UsageStore();
    s.add(rec("u1"), `${A}/events.jsonl`);
    s.add(rec("u1", { folderId: B }), `${B}/events.jsonl`);
    s.resetFile(`${A}/events.jsonl`);
    expect(s.records(all).map((r) => [r.folderId, r.sessionId])).toEqual([[B, B]]);
    expect(s.totals((r) => r.sessionId === B)?.records).toBe(1);
    // Session counters moved with it: A's session total shows again, B's stays hidden.
    s.setSessionTotals(A, `${A}/old.jsonl`, [rec(`shutdown:${A}`, { kind: "sessionTotal" })]);
    s.setSessionTotals(B, `${B}/events.jsonl`, [rec(`shutdown:${B}`, { kind: "sessionTotal", sessionId: B, folderId: B })]);
    expect(s.sessionTotalSessions()).toEqual(new Set([A]));
  });

  it("store: a second exact copy takes over in turn, and the original's re-read restores it", () => {
    const s = new UsageStore();
    s.add(rec("u1"), `${A}/events.jsonl`);
    s.add(rec("u1", { folderId: B }), `${B}/events.jsonl`);
    s.add(rec("u1", { folderId: C }), `${C}/events.jsonl`);
    s.resetFile(`${A}/events.jsonl`);
    expect(s.add(rec("u1"), `${A}/events.jsonl`)).toBe(true);
    expect(s.records(all).map((r) => [r.folderId, r.sessionId])).toEqual([[A, A]]);
    s.resetFile(`${A}/events.jsonl`);
    s.resetFile(`${B}/events.jsonl`);
    expect(s.records(all).map((r) => [r.folderId, r.sessionId])).toEqual([[C, C]]);
    expect(s.totals((r) => r.sessionId === C)?.records).toBe(1);
    s.resetFile(`${C}/events.jsonl`);
    expect(s.records(all)).toEqual([]);
    for (const f of [A, B, C]) s.setSessionTotals(f, `${f}/old.jsonl`, [rec(`shutdown:${f}`, { kind: "sessionTotal", sessionId: f, folderId: f })]);
    expect(s.sessionTotalSessions()).toEqual(new Set([A, B, C]));
  });

  it("store: the original read after its copy takes the call over, counters consistent", () => {
    const s = new UsageStore();
    s.add(rec("u1", { folderId: B }), `${B}/events.jsonl`);
    expect(s.add(rec("u1"), `${A}/events.jsonl`)).toBe(true);
    expect(s.records(all).map((r) => [r.folderId, r.sessionId])).toEqual([[A, A]]);
    expect(s.totals(all)!.records).toBe(1);
    // The copy then repeats nothing on top; dropping the original hands it back to B as B's session.
    expect(s.add(rec("u1", { folderId: B, tokens: { input: 900, output: 20 } }), `${B}/events.jsonl`)).toBe(false);
    s.resetFile(`${A}/events.jsonl`);
    expect(s.records(all).map((r) => [r.folderId, r.sessionId, r.tokens.input])).toEqual([[B, B, 100]]);
    s.resetFile(`${B}/events.jsonl`);
    expect(s.records(all)).toEqual([]);
    for (const f of [A, B]) s.setSessionTotals(f, `${f}/old.jsonl`, [rec(`shutdown:${f}`, { kind: "sessionTotal", sessionId: f, folderId: f })]);
    expect(s.sessionTotalSessions()).toEqual(new Set([A, B]));
  });

  it("monitor: deleting the original leaves the copy's current session showing the call", async () => {
    root = await mkdtemp(join(tmpdir(), "cum-copy-current-"));
    const lines = jsonl([usageEvent({ usageId: "u1", id: "e1", sourceSessionId: A, timestamp: at(9, 1) })]);
    await sessionTree(root, [{ id: A, lines }, { id: B, lines }]);
    const snaps: Snapshot[] = [];
    let clock = T0;
    const m = new UsageMonitor({ root, rootSource: "default", now: () => new Date(clock), isLive: () => false, log: new Logger(() => {}), onSnapshot: (s) => snaps.push(s) });
    try {
      await m.refresh({ full: true });
      // Whichever folder was read first, the original owns the call and is current.
      expect(snaps.at(-1)!.current).toMatchObject({ folderId: A, totals: { calls: 1 } });
      await rm(join(root, "session-state", A), { recursive: true, force: true });
      clock += 11_000;
      await m.refresh({ full: true });
    } finally {
      m.dispose();
    }
    const last = snaps.at(-1)!;
    expect(last.today?.calls).toBe(1);
    expect(last.current?.folderId).toBe(B);
    expect(last.current?.totals?.calls).toBe(1);
  });
});
