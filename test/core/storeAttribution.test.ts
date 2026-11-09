// Review #6: when the file that owned a deduplicated call goes, the surviving copy owns it,
// and the record is attributed to that copy's folder (and session) from then on.
import { describe, expect, it } from "vitest";
import { projectSummaries, UsageStore } from "../../src/core/store";
import type { UsageRecord } from "../../src/core/types";

const T0 = Date.parse("2026-11-05T14:30:00.000Z");
const all = () => true;
function rec(key: string, o: Partial<UsageRecord> = {}): UsageRecord {
  return { key, keySource: "usageId", kind: "call", source: "copilot", sessionId: "s1", folderId: "fA", timestampMs: T0, model: "m", tokens: { input: 100, output: 20 }, ...o };
}

describe("attribution follows the surviving copy (review #6)", () => {
  it("a copied folder's call moves to the copy's folder when the original file is reset", () => {
    const s = new UsageStore();
    s.add(rec("u1"), "A/events.jsonl");
    s.add(rec("u1", { folderId: "fB" }), "B/events.jsonl");
    s.resetFile("A/events.jsonl");
    expect(s.records(all).map((r) => r.folderId)).toEqual(["fB"]);
    expect(s.totals(all)!.records).toBe(1);
    expect(projectSummaries(s, 0, Infinity, (r) => r.folderId).map((g) => g.name)).toEqual(["fB"]);
    expect([...s.latest().keys()]).toEqual(["fB"]);
  });

  it("a copy that named its own session moves the call to that session", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "fA" }), "A/events.jsonl");
    s.add(rec("u1", { folderId: "fB", sessionId: "fB" }), "B/events.jsonl");
    s.resetFile("A/events.jsonl");
    expect(s.records(all).map((r) => [r.folderId, r.sessionId])).toEqual([["fB", "fB"]]);
    // fB's session total stays hidden (fB holds a call), and fA's is visible again.
    expect(s.setSessionTotals("fA", "A/old.jsonl", [rec("shutdown:fA", { kind: "sessionTotal", sessionId: "fA", folderId: "fA" })])).toBe(true);
    expect(s.setSessionTotals("fB", "B/events.jsonl", [rec("shutdown:fB", { kind: "sessionTotal", sessionId: "fB", folderId: "fB" })])).toBe(true);
    expect(s.sessionTotalSessions()).toEqual(new Set(["fA"]));
  });

  it("dropping a later holder leaves the owner's attribution alone", () => {
    const s = new UsageStore();
    s.add(rec("u1"), "A/events.jsonl");
    s.add(rec("u1", { folderId: "fB" }), "B/events.jsonl");
    s.resetFile("B/events.jsonl");
    expect(s.records(all).map((r) => r.folderId)).toEqual(["fA"]);
  });

  it("the surviving copy then owns repeats of the call", () => {
    const s = new UsageStore();
    s.add(rec("u1"), "A/events.jsonl");
    s.add(rec("u1", { folderId: "fB" }), "B/events.jsonl");
    s.resetFile("A/events.jsonl");
    expect(s.add(rec("u1", { folderId: "fB", tokens: { input: 300, output: 20 } }), "B/events.jsonl")).toBe(true);
    expect(s.records(all)[0]!).toMatchObject({ folderId: "fB", tokens: { input: 300 } });
  });

  // Review G: the monitor resets a file and re-reads it (truncation or rewrite, D42); the
  // copy must not keep the call once the original delivers it again.
  it("a tailer reset of the original file gives the call back to it", () => {
    const s = new UsageStore();
    s.add(rec("u1"), "A/events.jsonl");
    s.add(rec("u1", { folderId: "fB" }), "B/events.jsonl");
    s.resetFile("A/events.jsonl");
    expect(s.records(all).map((r) => r.folderId)).toEqual(["fB"]);
    expect(s.add(rec("u1"), "A/events.jsonl")).toBe(true);
    expect(s.records(all).map((r) => [r.folderId, r.sessionId])).toEqual([["fA", "s1"]]);
    expect(s.totals(all)!.records).toBe(1);
    expect(projectSummaries(s, 0, Infinity, (r) => r.folderId).map((g) => g.name)).toEqual(["fA"]);
    // A owns it again: its repeats merge, B's do not.
    expect(s.add(rec("u1", { tokens: { input: 300, output: 20 } }), "A/events.jsonl")).toBe(true);
    expect(s.add(rec("u1", { folderId: "fB", tokens: { input: 900, output: 20 } }), "B/events.jsonl")).toBe(false);
    expect(s.records(all)[0]!.tokens.input).toBe(300);
    // Both folders still hold it: dropping B keeps A's attribution, dropping A then removes it.
    s.resetFile("B/events.jsonl");
    expect(s.records(all).map((r) => r.folderId)).toEqual(["fA"]);
    s.resetFile("A/events.jsonl");
    expect(s.records(all)).toEqual([]);
  });

  it("restoring the original session keeps the session and folder counters consistent", () => {
    const s = new UsageStore();
    s.add(rec("u1", { sessionId: "fA" }), "A/events.jsonl");
    s.add(rec("u1", { folderId: "fB", sessionId: "fB" }), "B/events.jsonl");
    s.add(rec("u1", { folderId: "fC", sessionId: "fC" }), "C/events.jsonl");
    s.resetFile("A/events.jsonl");
    s.add(rec("u1", { sessionId: "fA" }), "A/events.jsonl");
    expect(s.records(all).map((r) => [r.folderId, r.sessionId])).toEqual([["fA", "fA"]]);
    // Every folder holds the call, so none of their session totals show.
    for (const f of ["fA", "fB", "fC"]) s.setSessionTotals(f, `${f}/old.jsonl`, [rec(`shutdown:${f}`, { kind: "sessionTotal", sessionId: f, folderId: f })]);
    expect(s.sessionTotalSessions()).toEqual(new Set());
    // Each copy stays tied to its own session: B then A go, C owns it as fC.
    s.resetFile("B/events.jsonl");
    s.resetFile("A/events.jsonl");
    const calls = () => s.records((r) => r.kind === "call").map((r) => [r.folderId, r.sessionId]);
    expect(calls()).toEqual([["fC", "fC"]]);
    expect(s.sessionTotalSessions()).toEqual(new Set(["fA", "fB"]));
    s.resetFile("C/events.jsonl");
    expect(calls()).toEqual([]);
    expect(s.sessionTotalSessions()).toEqual(new Set(["fA", "fB", "fC"]));
  });

  it("a third copy arriving after the reset does not take the call", () => {
    const s = new UsageStore();
    s.add(rec("u1"), "A/events.jsonl");
    s.add(rec("u1", { folderId: "fB" }), "B/events.jsonl");
    s.resetFile("A/events.jsonl");
    expect(s.add(rec("u1", { folderId: "fC" }), "C/events.jsonl")).toBe(false);
    expect(s.records(all).map((r) => r.folderId)).toEqual(["fB"]);
  });
});

