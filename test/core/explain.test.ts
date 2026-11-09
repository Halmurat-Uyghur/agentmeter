// v0.6 Phase 1 aggregations (explain.ts): prompt chains, cache figures, tool-definition
// share and the session ledger. Pure; records are built by hand.
import { describe, expect, it } from "vitest";
import { cacheStats, DETAIL_ROWS, lastPrompt, modelCacheStats, promptStats, sessionDetail, toolOverhead, uncachedOf } from "../../src/core/explain";
import type { PromptConvention } from "../../src/core/insights";
import type { UsageRecord } from "../../src/core/types";

const USD = 1e11;
let n = 0;
function call(o: Partial<UsageRecord> & { input?: number; cacheRead?: number; cacheWrite?: number; output?: number } = {}): UsageRecord {
  const { input = 10_000, cacheRead = 6_000, cacheWrite = 1_000, output = 200, ...rest } = o;
  n++;
  return {
    key: `k${n}`,
    keySource: "usageId",
    kind: "call",
    source: "copilot",
    sessionId: "s1",
    folderId: "s1",
    timestampMs: 1_000 + n,
    sequence: n,
    model: "model-a",
    tokens: { input, cacheRead, cacheWrite, output, reasoning: 50 },
    nanoAiu: 0.01 * USD,
    ...rest,
  };
}
const NONE = new Map<string, PromptConvention>();

describe("uncachedOf (Phase 0: input = uncached + cache read + cache write)", () => {
  it("subtracts cache reads and writes; never below 0", () => {
    expect(uncachedOf(call(), NONE)).toBe(3_000);
    expect(uncachedOf(call({ input: 100, cacheRead: 90, cacheWrite: 20 }), NONE)).toBe(0);
  });
  it("is undefined when a part is missing, and is input for a 'separate' model", () => {
    const r = call();
    delete r.tokens.cacheWrite;
    expect(uncachedOf(r, NONE)).toBeUndefined();
    expect(uncachedOf(call({ input: 100, cacheRead: 500 }), new Map([["model-a", "separate"]]))).toBe(100);
  });
});

describe("promptStats (1.2)", () => {
  it("a user call opens a chain; following agent calls join it; per session, in sequence order", () => {
    const calls = [
      call({ initiator: "user", sequence: 1, nanoAiu: 0.02 * USD }),
      call({ initiator: "agent", sequence: 3 }),
      call({ initiator: "agent", sequence: 2 }),
      call({ initiator: "user", sequence: 4, nanoAiu: 0.04 * USD }),
      call({ initiator: "agent", sequence: 5 }),
      call({ sessionId: "s2", initiator: "agent", sequence: 1 }),
      call({ sessionId: "s2", initiator: "user", sequence: 2 }),
    ];
    const p = promptStats(calls);
    expect(p).toMatchObject({ prompts: 3, agentCalls: 3, notLinked: 1, unknown: 0 });
    expect(p.nanoAiu).toEqual({ sum: (0.04 + 0.05 + 0.01) * USD, reported: 3, missing: 0 });
    expect(p.tokens.reported).toBe(3);
  });

  it("a chain with an unpriced call is left out of the average (missing), never counted as 0", () => {
    const p = promptStats([call({ initiator: "user" }), call({ initiator: "agent", nanoAiu: undefined }), call({ initiator: "user", sessionId: "s3" })]);
    expect(p.nanoAiu).toEqual({ sum: 0.01 * USD, reported: 1, missing: 1 });
  });

  it("'other' initiators are notLinked and do not break a chain; no initiator is unknown", () => {
    const p = promptStats([call({ initiator: "user" }), call({ initiator: "other" }), call({ initiator: "agent" }), call()]);
    expect(p).toMatchObject({ prompts: 1, agentCalls: 1, notLinked: 1, unknown: 1 });
  });

  it("session totals are skipped", () => {
    const p = promptStats([{ ...call({ initiator: "user" }), kind: "sessionTotal" }]);
    expect(p.prompts).toBe(0);
  });

  it("lastPrompt is the newest chain of the session", () => {
    const calls = [call({ initiator: "user" }), call({ initiator: "agent" }), call({ initiator: "user", nanoAiu: 0.03 * USD }), call({ initiator: "agent" }), call({ initiator: "agent" })];
    expect(lastPrompt(calls)).toEqual({ atMs: calls[2]!.timestampMs, agentCalls: 2, nanoAiu: 0.05 * USD, tokens: 3 * 10_200 });
    expect(lastPrompt([call({ initiator: "agent" })])).toBeUndefined();
    expect(lastPrompt([call({ initiator: "user", nanoAiu: undefined })])!.nanoAiu).toBeUndefined();
  });
});

describe("cacheStats and modelCacheStats (1.3)", () => {
  const tc = { input: 3e9, cacheRead: 6e8, cacheWrite: 1e9, output: 4e8, inputAtReadRate: 3e8 };
  it("share inputs; uncached cost whenever logged, the at-read-rate pair over the same calls; '—' (reported 0) without tokenDetails", () => {
    const c = cacheStats([call({ typeCost: tc }), call({ typeCost: { ...tc, inputAtReadRate: undefined } }), call()], NONE);
    expect(c.prompt).toEqual({ sum: 30_000, reported: 3, missing: 0 });
    expect(c.cacheRead).toEqual({ sum: 18_000, reported: 3, missing: 0 });
    // review fix 1: a call without a cache-read price still has a known uncached-input cost
    expect(c.uncachedNano).toEqual({ sum: 6e9, reported: 2, missing: 1 });
    expect(c.atReadRateNano).toEqual({ sum: 3e8, reported: 1, missing: 2 });
    // the comparison pairs both figures over the same calls
    expect(c.pairedUncachedNano).toEqual({ sum: 3e9, reported: 1, missing: 2 });
    expect(c.cacheReadNano).toEqual({ sum: 1.2e9, reported: 2, missing: 1 });
    expect(c.cacheWriteNano).toEqual({ sum: 2e9, reported: 2, missing: 1 });
    const none = cacheStats([call()], NONE);
    expect(none.uncachedNano.reported).toBe(0);
  });

  it("per model, costliest uncached input first; prompt tokens follow the convention", () => {
    const rows = modelCacheStats([call({ model: "b", typeCost: tc }), call({ model: "a" }), call({ model: "sep", input: 100, cacheRead: 500, cacheWrite: 0 })], new Map([["sep", "separate" as const]]));
    expect(rows.map((r) => r.model)).toEqual(["b", "a", "sep"]);
    expect(rows[2]!.prompt.sum).toBe(600);
    expect(Object.getPrototypeOf(rows)).toBe(Array.prototype);
  });
});

describe("toolOverhead (1.5): a share of input, never on top of it", () => {
  it("sums tool-definition tokens over calls that report them; groups by built-in / server / none", () => {
    const o = toolOverhead(
      [
        call({ toolTokens: 2_000, availableTools: 10, tools: { bash: 1, "github-mcp-server/search": 2 } }),
        call({ toolTokens: 2_000, availableTools: 12, tools: { "github-mcp-server/get": 1 } }),
        call({ toolTokens: 2_000 }),
        call({ availableTools: 4 }),
      ],
      NONE,
    );
    expect(o).toMatchObject({ calls: 3, missing: 1, toolTokens: 6_000, input: 30_000 });
    expect(o.availableTools).toEqual({ sum: 26, reported: 3, missing: 1 });
    expect(o.groups).toEqual([
      { kind: "added", name: "github-mcp-server", calls: 2, toolTokens: 4_000, input: 20_000 },
      { kind: "builtIn", name: "", calls: 1, toolTokens: 2_000, input: 10_000 },
      { kind: "none", name: "", calls: 1, toolTokens: 2_000, input: 10_000 },
    ]);
  });

  it("a figure above input is clamped to input", () => {
    expect(toolOverhead([call({ input: 100, toolTokens: 500 })], NONE).toolTokens).toBe(100);
  });

  it("a server named like a prototype key stays a plain group", () => {
    const o = toolOverhead([call({ toolTokens: 1, tools: Object.assign(Object.create(null), { "__proto__/x": 1 }) })], NONE);
    expect(o.groups[0]).toMatchObject({ kind: "added", name: "__proto__" });
    expect(({} as Record<string, unknown>).calls).toBeUndefined();
  });
});

describe("sessionDetail (1.1)", () => {
  it("lists the session's calls in order with the derived columns, numbers and enums only", () => {
    const recs = [call({ initiator: "user", finishReason: "tool_calls", toolTokens: 900 }), call({ initiator: "agent", finishReason: "stop" }), call({ sessionId: "other" })];
    const d = sessionDetail("s1", recs, NONE);
    expect(d.calls).toBe(2);
    expect(d.omitted).toBe(0);
    expect(d.rows[0]).toEqual({ timestampMs: recs[0]!.timestampMs, model: "model-a", initiator: "user", finishReason: "tool_calls", uncached: 3_000, cacheRead: 6_000, cacheWrite: 1_000, output: 200, reasoning: 50, prompt: 10_000, toolTokens: 900, nanoAiu: 0.01 * USD });
    expect(d.prompts).toMatchObject({ prompts: 1, agentCalls: 1 });
    expect(d.nanoAiu).toEqual({ sum: 0.02 * USD, reported: 2, missing: 0 });
    for (const row of d.rows) for (const v of Object.values(row)) expect(["number", "string"]).toContain(typeof v);
  });

  it(`keeps at most ${DETAIL_ROWS} rows, the newest, and counts the rest`, () => {
    const recs = Array.from({ length: DETAIL_ROWS + 5 }, () => call());
    const d = sessionDetail("s1", recs, NONE);
    expect(d.rows).toHaveLength(DETAIL_ROWS);
    expect(d.omitted).toBe(5);
    expect(d.calls).toBe(DETAIL_ROWS + 5);
    expect(d.rows[0]!.timestampMs).toBe(recs[5]!.timestampMs);
    expect(d.prompts.unknown).toBe(DETAIL_ROWS + 5);
  });

  it("a call that logged one side only leaves the ledger total incomplete, as the Sessions row (review O)", async () => {
    const { formatCount } = await import("../../src/core/format");
    const { sessionSummaries, UsageStore } = await import("../../src/core/store");
    const half = call({ initiator: "user" });
    delete half.tokens.output;
    const recs = [half, call({ initiator: "agent" }), call({ initiator: "user" })];
    const d = sessionDetail("s1", recs, NONE);
    expect(d.tokens).toEqual({ sum: 10_000 + 10_200 * 2, reported: 3, missing: 1 });
    expect(formatCount(d.tokens)).toMatch(/\*$/);
    const store = new UsageStore();
    for (const r of recs) store.add(r, "a.jsonl");
    const row = sessionSummaries(store, 0, Infinity)[0]!;
    expect(formatCount(d.tokens)).toBe(formatCount(row.tokens));
    // The prompt with the one-sided call is left out of the average, not counted short.
    expect(d.prompts.tokens).toEqual({ sum: 10_200, reported: 1, missing: 1 });
    expect(lastPrompt([half, call({ initiator: "agent", sequence: 99, timestampMs: 9e9 })])!.tokens).toBeUndefined();
  });

  it("a session counted from a session total has no rows and says so", () => {
    const d = sessionDetail("s1", [{ ...call(), kind: "sessionTotal" }], NONE);
    expect(d).toMatchObject({ calls: 0, rows: [], sessionTotal: true });
  });
});

describe("monitor wiring (1.1, 1.2): selected session, month figures, last prompt", () => {
  it("selectSession lists the session's calls; prompts and cache figures cover the month; the current session has its last prompt", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { UsageMonitor } = await import("../../src/core/monitor");
    const { Logger } = await import("../../src/core/log");
    const { jsonl, sessionTree, usageEvent, CANARY } = await import("../fixtures/build");
    const A = "0000aaaa-0000-4000-8000-000000000001";
    const at = (m: number) => new Date(2026, 0, 15, 9, m, 0).toISOString();
    const ev = (i: number, initiator: string) => usageEvent({ usageId: `u-${i}`, id: `e-${i}`, sequence: i, sourceSessionId: A, timestamp: at(i), initiator, finishReason: i === 3 ? "stop" : "tool_calls", toolTokenCount: 300, availableToolCount: 9 });
    const root = await mkdtemp(join(tmpdir(), "cum-explain-"));
    try {
      await sessionTree(root, [{ id: A, lines: jsonl([ev(1, "user"), ev(2, "agent"), ev(3, "agent"), ev(4, "user"), ev(5, CANARY)]) }]);
      const snaps: import("../../src/core/types").Snapshot[] = [];
      const m = new UsageMonitor({ root, rootSource: "default", now: () => new Date(2026, 0, 15, 10, 0, 0), isLive: () => false, log: new Logger(() => undefined), onSnapshot: (s) => snaps.push(s) });
      await m.refresh({ full: true });
      let s = snaps.at(-1)!;
      expect(s.month?.detail).toBeUndefined();
      expect(s.month?.prompts).toMatchObject({ prompts: 2, agentCalls: 2, notLinked: 1 });
      expect(s.month?.toolOverhead).toMatchObject({ calls: 5, toolTokens: 1_500, input: 5_000 });
      expect(s.month?.modelCache?.map((x) => x.model)).toEqual(["model-a"]);
      expect(s.current?.lastPrompt).toMatchObject({ agentCalls: 0, nanoAiu: 2e9 });
      m.selectSession(A);
      await m.refresh();
      s = snaps.at(-1)!;
      expect(s.month?.detail).toMatchObject({ sessionId: A, calls: 5, omitted: 0 });
      expect(s.month?.detail?.rows.map((r) => r.initiator)).toEqual(["user", "agent", "agent", "user", "other"]);
      expect(JSON.stringify(s)).not.toContain(CANARY);
      m.selectSession(undefined);
      await m.refresh();
      expect(snaps.at(-1)!.month?.detail).toBeUndefined();
      m.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
