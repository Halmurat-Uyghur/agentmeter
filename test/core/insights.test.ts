// v0.4 Insights (D32; O2 rules I2 and I3). Pure engine tests.
import { describe, expect, it } from "vitest";
import { computeInsights, LONG_CONTEXT_THRESHOLDS, longContextThreshold, promptConventions } from "../../src/core/insights";
import { promptOf } from "../../src/core/store";
import type { Metric, SessionSummary, UsageRecord } from "../../src/core/types";

const m = (sum: number, reported: number, missing = 0): Metric => ({ sum, reported, missing });
const USD = 1e11;

function session(o: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s",
    folderId: "s",
    firstMs: 0,
    lastMs: 1,
    calls: 20,
    tokens: m(1000, 20),
    nanoAiu: m(2 * USD, 20),
    growth: 4,
    excessNanoAiu: 1.5 * USD,
    ...o,
  };
}

let n = 0;
function call(o: Partial<UsageRecord> & { input?: number; cacheRead?: number; cacheWrite?: number } = {}): UsageRecord {
  const { input = 30_000, cacheRead = 9_000, cacheWrite, ...rest } = o;
  n++;
  return {
    key: `k${n}`,
    keySource: "usageId",
    kind: "call",
    source: "copilot",
    sessionId: "s1",
    folderId: "s1",
    timestampMs: n,
    sequence: n,
    model: "model-a",
    tokens: { input, output: 100, cacheRead, ...(cacheWrite !== undefined && { cacheWrite }) },
    nanoAiu: 0.1 * USD,
    ...rest,
  };
}

/** `perSession` eligible calls in each of `sessions` sessions, after one first call each. */
function cacheMonth(sessions: number, perSession: number, o: Parameters<typeof call>[0] = {}): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (let s = 0; s < sessions; s++) {
    out.push(call({ sessionId: `cs${s}`, folderId: `cs${s}`, sequence: 1, cacheRead: 0 }));
    for (let i = 0; i < perSession; i++) out.push(call({ sessionId: `cs${s}`, folderId: `cs${s}`, sequence: i + 2, ...o }));
  }
  return out;
}

const run = (o: Partial<Parameters<typeof computeInsights>[0]>) =>
  computeInsights({ sessions: [], monthRecords: [], allRecords: o.monthRecords ?? [], monthNanoAiu: 10 * USD, ...o });

describe("I1 long-context", () => {
  /** `k` calls of `model` with `prompt` input tokens, each costing `usd`, spread over 2 sessions. */
  const longCalls = (k: number, model = "claude-haiku-5.5", prompt = 100_001, usd = 0.2) =>
    Array.from({ length: k }, (_, i) => call({ model, input: prompt, cacheRead: 0, sessionId: `l${i % 2}`, folderId: `l${i % 2}`, nanoAiu: usd * USD }));

  it("the dated table holds only the explicit entries", () => {
    expect(LONG_CONTEXT_THRESHOLDS.map((e) => [e.id, e.thresholdTokens, e.prefix === true])).toEqual([
      ["claude-haiku-5.5", 100_000, false],
      ["gpt-5.6-luna", 200_000, false],
      ["gpt-5.6-sol", 272_000, false],
      ["gpt-5.6-terra", 272_000, false],
      ["gpt-6-astra", 272_000, false],
      ["gpt-6-luna", 272_000, false],
      ["gpt-6-sol", 272_000, false],
      ["gpt-6.1-sol", 272_000, false],
      ["gpt-6.1-terra", 272_000, false],
      ["grok-4", 200_000, true],
    ]);
  });

  it.each([
    ["claude-haiku-5.5", 100_000],
    ["CLAUDE-HAIKU-5.5", 100_000],
    ["gpt-6-sol", 272_000],
    ["grok-4", 200_000],
    ["grok-4-fast", 200_000],
    ["grok-4.1", 200_000],
    ["grok-40", undefined],
    ["claude-haiku-5", undefined],
    ["gpt-6-sol-mini", undefined],
    ["gpt-5.6-luna", 200_000],
    ["GPT-6.1-Terra", 272_000],
    ["gpt-6-luna", 272_000],
    ["gpt-6-terra", undefined],
    ["gpt-6.1", undefined],
  ])("threshold of %s is %s (unknown or near-miss ids never fire)", (model, want) => {
    expect(longContextThreshold(model)).toBe(want);
  });

  it("fires at 3 calls over the threshold costing at least $0.50, with the largest prompt", () => {
    const recs = [...longCalls(2), call({ model: "claude-haiku-5.5", input: 140_000, cacheRead: 0, sessionId: "l9", folderId: "l9", nanoAiu: 0.2 * USD })];
    const v = run({ monthRecords: recs });
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ id: "long-context", model: "claude-haiku-5.5", calls: 3, sessions: 3, thresholdTokens: 100_000, maxPromptTokens: 140_000 });
    expect(v.items[0]!.nanoAiu).toBeCloseTo(0.6 * USD);
  });

  it("boundaries: exactly at the threshold does not count; 2 calls do not fire; $0.49 does not fire", () => {
    expect(run({ monthRecords: longCalls(3, "claude-haiku-5.5", 100_000) }).items).toEqual([]);
    expect(run({ monthRecords: longCalls(2, "claude-haiku-5.5", 100_001, 1) }).items).toEqual([]);
    expect(run({ monthRecords: longCalls(3, "claude-haiku-5.5", 100_001, 0.49 / 3) }).items).toEqual([]);
    expect(run({ monthRecords: longCalls(3, "claude-haiku-5.5", 100_001, 0.5 / 3 + 1e-9) }).items).toHaveLength(1);
  });

  it("no AIU, no insight; session totals never count; no month-share floor", () => {
    expect(run({ monthRecords: longCalls(3).map((r) => ({ ...r, nanoAiu: undefined })) }).items).toEqual([]);
    expect(run({ monthRecords: longCalls(3).map((r) => ({ ...r, kind: "sessionTotal" as const })) }).items).toEqual([]);
    expect(run({ monthRecords: longCalls(3), monthNanoAiu: 1000 * USD }).items).toHaveLength(1);
  });

  it("long-context: unpriced calls do not count toward the $0.50 floor", () => {
    // 3 calls over the threshold, 1 priced at $0.50: the card would state one call's cost as "these calls"
    const one = longCalls(3).map((r, i) => ({ ...r, nanoAiu: i === 0 ? 0.5 * USD : undefined }));
    expect(run({ monthRecords: one }).items).toEqual([]);
    const three = [...one, ...longCalls(2, "claude-haiku-5.5", 100_001, 0.01)];
    expect(run({ monthRecords: three }).items).toMatchObject([{ id: "long-context", calls: 5 }]);
  });

  it("separate convention adds cache to the prompt; the costliest model wins", () => {
    const sep = [call({ model: "gpt-6-sol", input: 100, cacheRead: 272_000, sessionId: "x", nanoAiu: 1 * USD }), call({ model: "gpt-6-sol", input: 100, cacheRead: 272_000, sessionId: "x", nanoAiu: 1 * USD }), call({ model: "gpt-6-sol", input: 100, cacheRead: 272_000, sessionId: "x", nanoAiu: 1 * USD })];
    expect(promptConventions(sep).get("gpt-6-sol")).toBe("separate");
    const v = run({ monthRecords: [...sep, ...longCalls(3)] });
    expect(v.items.map((i) => i.id === "long-context" && i.model)).toEqual(["gpt-6-sol"]);
  });
});

describe("I2 context-growth", () => {
  it("fires for flagged sessions over $0.50 whose excess clears $1 and 5 in 100 of the month", () => {
    const v = run({ sessions: [session({ sessionId: "a", growth: 4.1 }), session({ sessionId: "b", growth: 3.2, excessNanoAiu: 0.5 * USD })] });
    expect(v.items).toHaveLength(1);
    const i = v.items[0]!;
    expect(i.id).toBe("context-growth");
    expect(i.nanoAiu).toBeCloseTo(2 * USD);
    expect(i.sessions).toBe(2);
    if (i.id === "context-growth") expect(i.top.map((t) => t.sessionId)).toEqual(["a", "b"]);
  });

  it("a ▲ session below $0.50 is not an insight", () => {
    expect(run({ sessions: [session({ nanoAiu: m(0.49 * USD, 20), excessNanoAiu: 3 * USD })] }).items).toEqual([]);
    expect(run({ sessions: [session({ nanoAiu: m(0.5 * USD, 20), excessNanoAiu: 3 * USD })] }).items).toHaveLength(1);
  });

  it("Claude Code and Codex sessions are not examined, nor counted in the coverage (review #7)", () => {
    const claude = session({ sessionId: "c", source: "claude-code", growth: 4.1 });
    const codex = session({ sessionId: "x", source: "codex", growth: 4.1 });
    const v = run({ sessions: [claude, codex] });
    expect(v.items).toEqual([]);
    expect(v.coverage).toEqual({ callSessions: 0, totalsOnlySessions: 0 });
    const mixed = run({ sessions: [claude, session({ sessionId: "p", source: "copilot", growth: 4.1 })] });
    expect(mixed.items).toHaveLength(1);
    if (mixed.items[0]!.id === "context-growth") expect(mixed.items[0]!.top.map((t) => t.sessionId)).toEqual(["p"]);
    expect(mixed.coverage.callSessions).toBe(1);
  });

  it("growth under 3 never fires; session totals never fire", () => {
    expect(run({ sessions: [session({ growth: 2.9 })] }).items).toEqual([]);
    expect(run({ sessions: [session({ sessionTotal: true })] }).items).toEqual([]);
  });

  it("shared floors: excess under $1, or under 5 in 100 of the month, does not fire", () => {
    expect(run({ sessions: [session({ excessNanoAiu: 0.99 * USD })] }).items).toEqual([]);
    expect(run({ sessions: [session({ excessNanoAiu: 1.5 * USD })], monthNanoAiu: 31 * USD }).items).toEqual([]);
    expect(run({ sessions: [session({ excessNanoAiu: 1.5 * USD })], monthNanoAiu: 30 * USD }).items).toHaveLength(1);
  });

  it("uses every session it is given (no top-10 cut) and lists at most 3", () => {
    const many = Array.from({ length: 12 }, (_, i) => session({ sessionId: `x${i}`, excessNanoAiu: (12 - i) * 0.1 * USD }));
    const v = run({ sessions: many, monthNanoAiu: 20 * USD });
    const i = v.items[0]!;
    expect(i.sessions).toBe(12);
    if (i.id === "context-growth") expect(i.top).toHaveLength(3);
  });
});

describe("I3 cache-reuse", () => {
  it("fires for low reuse over ≥ 20 eligible calls in ≥ 3 sessions with large prompts", () => {
    const recs = cacheMonth(3, 7); // 21 eligible, share 9K / 30K = 0.3
    const v = run({ monthRecords: recs });
    expect(v.items.map((x) => x.id)).toEqual(["cache-reuse"]);
    const i = v.items[0]!;
    if (i.id !== "cache-reuse") throw new Error();
    expect(i.model).toBe("model-a");
    expect(i.calls).toBe(21);
    expect(i.sessions).toBe(3);
    expect(i.share).toBeCloseTo(0.3);
    expect(i.nanoAiu).toBeCloseTo(2.1 * USD);
  });

  it("boundaries: 19 calls, 2 sessions, share 0.60, mean prompt under 20K", () => {
    expect(run({ monthRecords: cacheMonth(3, 7).slice(0, -2) }).items).toEqual([]);
    expect(run({ monthRecords: cacheMonth(2, 15) }).items).toEqual([]);
    expect(run({ monthRecords: cacheMonth(3, 7, { cacheRead: 18_000 }) }).items).toEqual([]);
    expect(run({ monthRecords: cacheMonth(3, 7, { cacheRead: 17_999 }) }).items).toHaveLength(1);
    expect(run({ monthRecords: cacheMonth(3, 7, { input: 19_999, cacheRead: 0 }) }).items).toEqual([]);
  });

  it("the first call of each session and prompts under 4,096 tokens are not eligible", () => {
    const recs = cacheMonth(3, 7);
    const v = run({ monthRecords: [...recs, call({ sessionId: "cs0", sequence: 99, input: 4095, cacheRead: 0 })] });
    const i = v.items[0]!;
    expect(i.calls).toBe(21);
  });

  it("records without cache read or AIU: not eligible, and no AIU means no insight", () => {
    expect(run({ monthRecords: cacheMonth(3, 7, { nanoAiu: undefined }) }).items).toEqual([]);
    const missing = cacheMonth(3, 7).map((r) => ({ ...r, tokens: { input: r.tokens.input } }));
    expect(run({ monthRecords: missing }).items).toEqual([]);
  });

  it("cache-reuse: fewer than 20 priced calls do not fire", () => {
    const recs = cacheMonth(3, 7).map((r, i) => (i % 8 === 1 ? { ...r, nanoAiu: undefined } : { ...r, nanoAiu: 0.2 * USD }));
    expect(run({ monthRecords: recs }).items).toEqual([]);
    expect(run({ monthRecords: cacheMonth(3, 7, { nanoAiu: 0.2 * USD }) }).items.map((i) => i.id)).toEqual(["cache-reuse"]);
  });

  it("session totals are excluded", () => {
    const recs = cacheMonth(3, 7).map((r) => ({ ...r, kind: "sessionTotal" as const }));
    expect(run({ monthRecords: recs }).items).toEqual([]);
  });

  it("separate convention: a model with cached > input counts cache in the prompt, so it fires less", () => {
    // input 10K + cacheRead 20K: under "separate" the prompt is 30K and the share 0.67 → no insight
    const recs = cacheMonth(3, 7, { input: 10_000, cacheRead: 20_000 });
    expect(promptConventions(recs).get("model-a")).toBe("separate");
    expect(run({ monthRecords: recs }).items).toEqual([]);
    expect(promptConventions(cacheMonth(1, 1)).get("model-a")).toBe("included");
  });

  it("month floor: the calls must be at least 5 in 100 of the month's AIU", () => {
    expect(run({ monthRecords: cacheMonth(3, 7), monthNanoAiu: 43 * USD }).items).toEqual([]);
  });
});

describe("ranking and coverage", () => {
  it("ranks by AIU, highest first, and counts per-call and session-total sessions", () => {
    const v = run({
      sessions: [session({ sessionId: "a", excessNanoAiu: 5 * USD }), session({ sessionId: "t", sessionTotal: true, growth: undefined })],
      monthRecords: cacheMonth(3, 7),
      monthNanoAiu: 40 * USD,
    });
    expect(v.items.map((x) => x.id)).toEqual(["context-growth", "cache-reuse"]);
    expect(v.coverage).toEqual({ callSessions: 1, totalsOnlySessions: 1 });
  });
});

describe("v0.8 sources (D47)", () => {
  it("a Claude Code record's prompt tokens are its input; promptConventions ignores it", () => {
    const r = call({ source: "claude-code", keySource: "claudeMessageId", model: "claude-x", input: 100, cacheRead: 100_000, cacheWrite: 5_000, nanoAiu: undefined });
    const conv = promptConventions([r]);
    expect(conv.has("claude-x")).toBe(false);
    expect(promptOf(r, conv)).toBe(100);
    expect(promptOf(r, new Map([["claude-x", "separate"]]))).toBe(100);
    // a Copilot record of the same model still drives the inference
    const cop = call({ model: "claude-x", input: 100, cacheRead: 100_000 });
    expect(promptConventions([r, cop]).get("claude-x")).toBe("separate");
  });
});

describe("fix wave F2: I1 and I3 read Copilot calls only", () => {
  const codexCall = (i: number, o: Parameters<typeof call>[0] = {}) =>
    call({ source: "codex", keySource: "codexResponseId", sessionId: `x${i % 5}`, folderId: `x${i % 5}`, sequence: i + 2, cacheRead: 0, nanoAiu: undefined, ...o });

  it("24 priced Copilot calls with good reuse fire nothing; 60 Codex calls of the same model without cache reads still fire nothing", () => {
    const copilot = cacheMonth(3, 8, { cacheRead: 27_000 });
    expect(run({ monthRecords: copilot }).items).toEqual([]);
    const codex = Array.from({ length: 60 }, (_, i) => codexCall(i));
    const recs = [...copilot, ...codex];
    expect(run({ monthRecords: recs, allRecords: recs }).items).toEqual([]);
  });

  it("long-context counts only Copilot calls: Codex calls past the threshold change nothing", () => {
    const long = (k: number) => Array.from({ length: k }, (_, i) => call({ model: "gpt-6-sol", input: 300_000, cacheRead: 0, sessionId: `l${i % 2}`, folderId: `l${i % 2}`, nanoAiu: 0.2 * USD }));
    const base = run({ monthRecords: long(3) }).items;
    expect(base.map((i) => i.id)).toEqual(["long-context"]);
    const codex = Array.from({ length: 10 }, (_, i) => codexCall(i, { model: "gpt-6-sol", input: 900_000 }));
    const recs = [...long(3), ...codex];
    const with_ = run({ monthRecords: recs, allRecords: recs }).items;
    expect(with_).toHaveLength(1);
    const i = with_[0]!;
    if (i.id !== "long-context") throw new Error();
    expect(i.calls).toBe(3);
    expect(i.maxPromptTokens).toBe(300_000);
    // Codex calls alone never fire it
    expect(run({ monthRecords: codex, allRecords: codex }).items).toEqual([]);
  });
});
