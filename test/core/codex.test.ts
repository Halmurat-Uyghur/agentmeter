import * as fs from "node:fs";
import { appendFile, chmod, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyCodexHead,
  classifyCodexLine,
  CODEX_HEAD_BYTES,
  CODEX_MAX_LINE_BYTES,
  CODEX_MAX_TURNS,
  CodexSourceReader,
  discoverCodex,
  parseCodexLine,
  type CodexFileState,
} from "../../src/core/codex";
import type { SourceCandidate } from "../../src/core/source";
import {
  canaryCwd,
  CODEX_CANARY,
  CODEX_SESSION,
  CODEX_TS,
  codexMeta,
  codexOther,
  codexRecord,
  codexTokenCount,
  codexTree,
  codexTurn,
  codexAgentReasoning,
  codexCompacted,
  codexInterAgent,
  codexUserMessage,
  NEVER_NUMBER,
  type CodexUsage,
} from "../fixtures/codex";

const OTHER_SESSION = "11111111-2222-3333-4444-555555555555";
const ids0 = (n: number) => `bbbbbbbb-0000-0000-0000-${String(n).padStart(12, "0")}`;
const o = { fileSessionId: OTHER_SESSION, wantLabel: true, readTotals: true };

function fresh(): CodexFileState {
  return { models: new Map(), sawTurn: false };
}

function parse(line: string, state: CodexFileState = fresh(), opts = o) {
  const buf = Buffer.from(line);
  return parseCodexLine(buf, 0, buf.length, classifyCodexLine(buf, 0, buf.length), state, opts);
}

function cls(line: string) {
  const buf = Buffer.from(line);
  return classifyCodexLine(buf, 0, buf.length);
}

function expectNoLeak(x: unknown): void {
  const s = JSON.stringify(x);
  expect(s).not.toContain(CODEX_CANARY);
  expect(s).not.toContain(String(NEVER_NUMBER));
  expect(s).not.toContain("/");
}

describe("classifyCodexLine (D45 gate)", () => {
  it("classifies the four line types and skips everything else", () => {
    expect(cls(codexRecord())).toBe("record");
    expect(cls(codexTurn())).toBe("turn");
    expect(cls(codexMeta())).toBe("meta");
    expect(cls(codexTokenCount())).toBe("event");
    expect(cls(codexOther("event_msg", "agent_message"))).toBe("event");
    expect(cls(codexOther("response_item", "message"))).toBe("skip");
    expect(cls(codexOther("world_state", "x"))).toBe("skip");
    expect(cls("")).toBe("skip");
    expect(cls("not json")).toBe("skip");
  });

  it("a needle as escaped text inside a string is skipped", () => {
    const text = JSON.stringify({ type: "token_usage_record", payload: {} });
    expect(cls(codexOther("response_item", "message", { text }))).toBe("skip");
  });

  it("classification is bounded to the line inside a large multi-line chunk", () => {
    const kinds = [codexRecord(), codexTurn(), codexMeta(), codexTokenCount(), codexOther("response_item", "message")];
    const expected = ["record", "turn", "meta", "event", "skip"];
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) lines.push(kinds[i % kinds.length]!);
    // A plain line whose only needle-bearing neighbour comes later in the same chunk.
    lines.push(codexOther("response_item", "message"), codexMeta());
    const chunk = Buffer.from(lines.map((l) => `${l}\n`).join(""));
    const got: string[] = [];
    let pos = 0;
    for (let nl = chunk.indexOf(0x0a, pos); nl !== -1; nl = chunk.indexOf(0x0a, pos)) {
      got.push(classifyCodexLine(chunk, pos, nl));
      pos = nl + 1;
    }
    expect(got).toHaveLength(2002);
    for (let i = 0; i < 2000; i++) expect(got[i]).toBe(expected[i % expected.length]);
    expect(got[2000]).toBe("skip");
    expect(got[2001]).toBe("meta");
  });

  it("a nested record needle in a turn, meta or event line is parsed as its real type", () => {
    const nest = (l: string) => l.replace('"payload":{', '"payload":{"x":{"type":"token_usage_record","response_id":"resp_n","usage":{"input_tokens":5}},');
    const state = fresh();
    expect(cls(nest(codexTurn({ turnId: "t1", model: "gpt-5" })))).toBe("record");
    expect(parse(nest(codexTurn({ turnId: "t1", model: "gpt-5" })), state)).toEqual({ kind: "turn" });
    expect(state.models.get("t1")).toBe("gpt-5");
    expect(parse(nest(codexMeta()))).toEqual({ kind: "meta", label: "codex-proj" });
    const t = parse(nest(codexTokenCount({ total: { input_tokens: 9 } })));
    expect(t.kind === "total" && t.record.tokens).toEqual({ input: 9 });
  });

  it("a needle in a nested payload does not make a record", () => {
    const nested = JSON.stringify({
      timestamp: CODEX_TS,
      ordinal: 1,
      type: "response_item",
      payload: { type: "token_usage_record", response_id: "resp_x", usage: { input_tokens: 5 } },
    });
    const state = fresh();
    expect(parse(nested, state)).toEqual({ kind: "ignored" });
  });
});

describe("parseCodexLine records (D45 mapping)", () => {
  it("maps usage as logged; cache writes are not added into input", () => {
    const r = parse(codexRecord({ usage: { input_tokens: 1200, cached_input_tokens: 800, cache_write_input_tokens: 50, output_tokens: 300, reasoning_output_tokens: 120, total_tokens: 1550 } }));
    expect(r.kind).toBe("usage");
    if (r.kind !== "usage") return;
    expect(r.record).toEqual({
      key: "resp_0123456789abcdefABCDEF_-0123456789abcdefABCDEFghijk",
      keySource: "codexResponseId",
      source: "codex",
      kind: "call",
      sessionId: CODEX_SESSION,
      folderId: OTHER_SESSION,
      timestampMs: Date.parse(CODEX_TS),
      tokens: { input: 1200, cacheRead: 800, cacheWrite: 50, output: 300, reasoning: 120 },
    });
    expectNoLeak(r);
  });

  it("a missing or invalid token field is absent; none valid is unrecognized", () => {
    const r = parse(codexRecord({ usage: { input_tokens: 10, output_tokens: -1, cached_input_tokens: 1.5, reasoning_output_tokens: "7" } }));
    expect(r.kind === "usage" && r.record.tokens).toEqual({ input: 10 });
    expect(parse(codexRecord({ usage: { total_tokens: 5 } }))).toEqual({ kind: "unrecognized", reason: "no-known-token-field" });
    expect(parse(codexRecord({ usage: null }))).toEqual({ kind: "unrecognized", reason: "no-known-token-field" });
  });

  it("no response_id → no-key; a bad timestamp → bad-timestamp", () => {
    expect(parse(codexRecord({ responseId: "" }))).toEqual({ kind: "unrecognized", reason: "no-key" });
    expect(parse(codexRecord({ responseId: "has space" }))).toEqual({ kind: "unrecognized", reason: "no-key" });
    expect(parse(codexRecord({ responseId: "__proto__" }))).toEqual({ kind: "unrecognized", reason: "no-key" });
    expect(parse(codexRecord({ timestamp: "2026-11-08 15:00" }))).toEqual({ kind: "unrecognized", reason: "bad-timestamp" });
  });

  it("a usage scalar over the slice limit → slice-too-large; a large usage object is fine (never decoded)", () => {
    const big = codexRecord({ usage: { input_tokens: 1, output_tokens: 2 } }).replace('"input_tokens":1', `"input_tokens":${"1".repeat(5000)}`);
    expect(parse(big)).toEqual({ kind: "unrecognized", reason: "slice-too-large" });
    const usage: Record<string, unknown> = { input_tokens: 1 };
    for (let i = 0; i < 400; i++) usage[`pad_${i}`] = 123456;
    const r = parse(codexRecord({ usage: usage as CodexUsage }));
    expect(r.kind === "usage" && r.record.tokens).toEqual({ input: 1 });
  });

  it("zero usage is ignored: all counts 0, or only cache_write_input_tokens: 0", () => {
    const zero = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    expect(parse(codexRecord({ usage: zero }))).toEqual({ kind: "ignored" });
    expect(parse(codexRecord({ usage: { cache_write_input_tokens: 0 } }))).toEqual({ kind: "ignored" });
    expect(parse(codexRecord({ usage: { input_tokens: 0, output_tokens: 1 } })).kind).toBe("usage");
  });

  it("usage counts are scalar paths: a duplicate count is malformed; a string count is never decoded", () => {
    const dup = codexRecord({ usage: { input_tokens: 1, output_tokens: 2 } }).replace('"output_tokens":2', '"output_tokens":2,"output_tokens":3');
    expect(parse(dup)).toEqual({ kind: "malformed" });
    const spy = vi.spyOn(JSON, "parse");
    try {
      const withCanary = codexRecord({ usage: { input_tokens: CODEX_CANARY, output_tokens: 5 } });
      const r = parse(withCanary);
      expect(r.kind === "usage" && r.record.tokens).toEqual({ output: 5 });
      parse(codexTokenCount({ total: { input_tokens: CODEX_CANARY, output_tokens: 5 } }));
      expect(spy).toHaveBeenCalled();
      for (const [text] of spy.mock.calls) expect(String(text)).not.toContain(CODEX_CANARY);
    } finally {
      spy.mockRestore();
    }
  });

  it("records carry folderId = the file's id and sessionId = payload.session_id", () => {
    const r = parse(codexRecord({ sessionId: CODEX_SESSION }));
    expect(r.kind === "usage" && [r.record.sessionId, r.record.folderId]).toEqual([CODEX_SESSION, OTHER_SESSION]);
    const f = parse(codexRecord({ sessionId: "not-a-session!" }));
    expect(f.kind === "usage" && [f.record.sessionId, f.record.folderId]).toEqual([OTHER_SESSION, OTHER_SESSION]);
  });

  it("duplicate keys and truncated lines are malformed", () => {
    const dup = codexRecord().replace('"payload":{', '"payload":{"response_id":"resp_a",');
    expect(parse(dup)).toEqual({ kind: "malformed" });
    const line = codexRecord();
    expect(parse(line.slice(0, line.length - 20))).toEqual({ kind: "malformed" });
  });

  it("session_id falls back to the file session id when it is not a session id", () => {
    const r = parse(codexRecord({ sessionId: "not a uuid!" }));
    expect(r.kind === "usage" && [r.record.sessionId, r.record.folderId]).toEqual([OTHER_SESSION, OTHER_SESSION]);
  });

  it("tolerates a trailing CR", () => {
    expect(parse(`${codexRecord()}\r`).kind).toBe("usage");
  });
});

describe("parseCodexLine models (turn_context)", () => {
  it("a record takes the model of its turn id, the latest as fallback, none before any turn", () => {
    const state = fresh();
    const before = parse(codexRecord({ turnId: "t1", responseId: "r0" }), state);
    expect(before.kind === "usage" && before.record.model).toBeUndefined();
    expect(state.sawTurn).toBe(false);

    expect(parse(codexTurn({ turnId: "t1", model: "gpt-5-codex" }), state)).toEqual({ kind: "turn" });
    expect(state.sawTurn).toBe(true);
    expect(parse(codexTurn({ turnId: "t2", model: "gpt-5.1" }), state)).toEqual({ kind: "turn" });

    const r1 = parse(codexRecord({ turnId: "t1", responseId: "r1" }), state);
    const r2 = parse(codexRecord({ turnId: "t2", responseId: "r2" }), state);
    const r3 = parse(codexRecord({ turnId: "t-unknown", responseId: "r3" }), state);
    expect(r1.kind === "usage" && r1.record.model).toBe("gpt-5-codex");
    expect(r2.kind === "usage" && r2.record.model).toBe("gpt-5.1");
    expect(r3.kind === "usage" && r3.record.model).toBe("gpt-5.1");
  });

  it("invalid models and turn ids are not kept", () => {
    const state = fresh();
    parse(codexTurn({ turnId: "t1", model: `${CODEX_CANARY} with space` }), state);
    parse(codexTurn({ turnId: "__proto__", model: "gpt-5" }), state);
    parse(codexTurn({ turnId: "x".repeat(129), model: "gpt-5" }), state);
    expect(state.models.size).toBe(0);
    expect(state.latestModel).toBe("gpt-5");
    parse(codexTurn({ turnId: "t9", model: "__proto__" }), state);
    expect(state.latestModel).toBe("gpt-5");
    expect(state.models.has("t9")).toBe(false);
  });

  it("caps turns at CODEX_MAX_TURNS, dropping the oldest", () => {
    const state = fresh();
    for (let i = 0; i <= CODEX_MAX_TURNS; i++) parse(codexTurn({ turnId: `t${i}`, model: `m${i % 3}` }), state);
    expect(state.models.size).toBe(CODEX_MAX_TURNS);
    expect(state.models.has("t0")).toBe(false);
    expect(state.models.get(`t${CODEX_MAX_TURNS}`)).toBe(`m${CODEX_MAX_TURNS % 3}`);
  });
});

describe("parseCodexLine session_meta and token_count", () => {
  it("session_meta yields the folder label, worktree suffix stripped, never the path", () => {
    expect(parse(codexMeta())).toEqual({ kind: "meta", label: "codex-proj" });
    expect(parse(codexMeta({ cwd: `${canaryCwd("repo")}/.claude/worktrees/feature-x` }))).toEqual({ kind: "meta", label: "repo" });
    expect(parse(codexMeta(), fresh(), { ...o, wantLabel: false })).toEqual({ kind: "meta" });
  });

  it("token_count yields a session total only with readTotals", () => {
    const state = fresh();
    parse(codexTurn({ model: "gpt-5-codex" }), state);
    const r = parse(codexTokenCount({ total: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 700, reasoning_output_tokens: 70 } }), state);
    expect(r).toEqual({
      kind: "total",
      record: {
        key: `codex-total:${OTHER_SESSION}`,
        keySource: "codexTotal",
        source: "codex",
        kind: "sessionTotal",
        sessionId: OTHER_SESSION,
        folderId: OTHER_SESSION,
        timestampMs: Date.parse(CODEX_TS),
        model: "gpt-5-codex",
        tokens: { input: 5000, cacheRead: 4000, output: 700, reasoning: 70 },
      },
    });
    expectNoLeak(r);
    expect(parse(codexTokenCount(), fresh(), { ...o, readTotals: false })).toEqual({ kind: "ignored" });
    expect(parse(codexOther("event_msg", "agent_message"))).toEqual({ kind: "ignored" });
  });
});

describe("CodexSourceReader", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cum-codex-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const reader = (readTotals = true, readProjects = true) =>
    new CodexSourceReader({ root, rootSource: "default", readProjects, readTotals });

  function candidate(path: string, sessionId = CODEX_SESSION): SourceCandidate {
    return { source: "codex", sessionId, folderId: sessionId, files: [{ path, mtimeMs: 0, size: 0 }], mtimeMs: 0, live: false };
  }

  it("reads a whole file: label, models, records, activity; canary never leaks", async () => {
    const [p] = await codexTree(root, [
      {
        date: "2026/11/08",
        sessionId: CODEX_SESSION,
        lines: [
          codexMeta(),
          codexMeta({ cwd: "/other/second" }),
          codexTurn({ turnId: "t1", model: "gpt-5-codex" }),
          codexOther("response_item", "message"),
          codexRecord({ turnId: "t1", responseId: "r1" }),
          codexTokenCount(),
          codexOther("event_msg", "agent_message"),
        ],
      },
    ]);
    const res = await reader().open(p!, candidate(p!)).read();
    expect(res.label).toBe("codex-proj");
    expect(res.records).toHaveLength(1);
    expect(res.records[0]!.model).toBe("gpt-5-codex");
    expect(res.usage).toBe(1);
    expect(res.activity).toBe(1);
    // The first record clears the file's session total.
    expect(res.totals).toEqual([]);
    expect(res.hasTotals).toBe(true);
    expect(res.candidates).toBe(2);
    expect(res.malformed + res.unrecognized).toBe(0);
    expectNoLeak(res);
  });

  it("other line kinds (compacted, inter-agent, user_message, agent_reasoning) never leak and are not candidates", async () => {
    const [p] = await codexTree(root, [
      {
        date: "2026/11/08",
        sessionId: CODEX_SESSION,
        lines: [codexMeta(), codexCompacted(), codexInterAgent(), codexUserMessage(), codexAgentReasoning(), codexOther("event_msg", "agent_message")],
      },
    ]);
    const res = await reader().open(p!, candidate(p!)).read();
    expect(res.records).toEqual([]);
    expect(res.candidates).toBe(0);
    expect(res.malformed + res.unrecognized).toBe(0);
    expectNoLeak(res);
    for (const l of [codexMeta(), codexCompacted(), codexInterAgent(), codexUserMessage(), codexAgentReasoning()]) expectNoLeak(parse(l));
  });

  it("the first record deletes the file's total even when payload.session_id differs from the file's id", async () => {
    const [p] = await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta(), codexTokenCount({ total: { input_tokens: 10 } })] }]);
    const fr = reader().open(p!, candidate(p!));
    const r1 = await fr.read();
    expect(r1.totals?.map((t) => t.folderId)).toEqual([CODEX_SESSION]);
    expect(r1.candidates).toBe(1);
    await appendFile(p!, `${codexRecord({ sessionId: OTHER_SESSION, responseId: "r1" })}\n${codexRecord({ sessionId: OTHER_SESSION, responseId: "r2" })}\n`);
    const r2 = await fr.read();
    expect(r2.totals).toEqual([]);
    expect(r2.hasTotals).toBe(true);
    expect(r2.candidates).toBe(2);
    expect(r2.records.map((r) => [r.sessionId, r.folderId])).toEqual([
      [OTHER_SESSION, CODEX_SESSION],
      [OTHER_SESSION, CODEX_SESSION],
    ]);
    await appendFile(p!, `${codexRecord({ responseId: "r3" })}\n`);
    const r3 = await fr.read();
    expect(r3.totals).toBeUndefined();
    expect(r3.hasTotals).toBe(false);
  });

  it("reports the label only in the read that first finds it, and again after a reset", async () => {
    const [p] = await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta(), codexRecord({ responseId: "r1" })] }]);
    const fr = reader().open(p!, candidate(p!));
    expect((await fr.read()).label).toBe("codex-proj");
    expect((await fr.read()).label).toBeUndefined();
    await appendFile(p!, `${codexRecord({ responseId: "r2" })}\n`);
    const more = await fr.read();
    expect(more.records).toHaveLength(1);
    expect(more.label).toBeUndefined();
    await writeFile(p!, `${codexMeta({ cwd: canaryCwd("other") })}\n`);
    const reset = await fr.read();
    expect(reset.reset).toBe(true);
    expect(reset.label).toBe("other");
  });

  it("readProjects off yields no label", async () => {
    const [p] = await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta(), codexRecord()] }]);
    const res = await reader(true, false).open(p!, candidate(p!)).read();
    expect(res.label).toBeUndefined();
    expect(res.records).toHaveLength(1);
  });

  it("a token_count-only file yields one total, replaced by a later line, and none once a record exists", async () => {
    const [p] = await codexTree(root, [
      {
        date: "2026/11/08",
        sessionId: CODEX_SESSION,
        lines: [codexMeta(), codexTurn(), codexTokenCount({ total: { input_tokens: 10 } }), codexTokenCount({ total: { input_tokens: 20 } })],
      },
    ]);
    const fr = reader().open(p!, candidate(p!));
    const r1 = await fr.read();
    expect(r1.totals).toHaveLength(1);
    expect(r1.totals![0]!.tokens).toEqual({ input: 20 });
    expect(r1.totals![0]!.key).toBe(`codex-total:${CODEX_SESSION}`);
    expect(r1.hasTotals).toBe(true);
    expect(r1.records).toEqual([]);
    expectNoLeak(r1);

    await writeFile(p!, `${codexTokenCount({ total: { input_tokens: 30 }, timestamp: "2026-11-08T16:00:00Z" })}\n`, { flag: "a" });
    const r2 = await fr.read();
    expect(r2.totals![0]!.tokens).toEqual({ input: 30 });
    expect(r2.totals![0]!.timestampMs).toBe(Date.parse("2026-11-08T16:00:00Z"));

    await writeFile(p!, `${codexRecord()}\n${codexTokenCount({ total: { input_tokens: 40 } })}\n`, { flag: "a" });
    const r3 = await fr.read();
    expect(r3.records).toHaveLength(1);
    expect(r3.totals).toEqual([]);
    expect(r3.hasTotals).toBe(true);

    await writeFile(p!, `${codexTokenCount({ total: { input_tokens: 50 } })}\n`, { flag: "a" });
    const r4 = await fr.read();
    expect(r4.totals).toBeUndefined();
  });

  it("a record before a token_count in one read suppresses the total; readTotals off never yields one", async () => {
    const [p] = await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexRecord(), codexTokenCount()] }]);
    expect((await reader().open(p!, candidate(p!)).read()).totals).toEqual([]);
    const [q] = await codexTree(root, [{ date: "2026/11/07", sessionId: OTHER_SESSION, lines: [codexTokenCount()] }]);
    const off = await reader(false).open(q!, candidate(q!, OTHER_SESSION)).read();
    expect(off.totals).toBeUndefined();
    expect(off.hasTotals).toBe(false);
    // A token_count line is still a candidate with totals off (the raw needle, never decoded).
    expect(off.candidates).toBe(1);
    const [r] = await codexTree(root, [{ date: "2026/11/06", sessionId: OTHER_SESSION, lines: [codexRecord()] }]);
    const offRec = await reader(false).open(r!, candidate(r!, OTHER_SESSION)).read();
    expect(offRec.totals).toBeUndefined();
    expect(offRec.hasTotals).toBe(false);
  });

  it("a turn without records counts as activity", async () => {
    const [p] = await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta(), codexTurn(), codexTurn({ turnId: "t2" })] }]);
    const res = await reader().open(p!, candidate(p!)).read();
    expect(res.activity).toBe(2);
    expect(res.usage).toBe(0);
  });

  it("counts malformed and unrecognized lines", async () => {
    const [p] = await codexTree(root, [
      {
        date: "2026/11/08",
        sessionId: CODEX_SESSION,
        lines: [codexRecord().slice(0, 100), codexRecord({ responseId: "" }), codexRecord({ timestamp: "bad" })],
      },
    ]);
    const res = await reader().open(p!, candidate(p!)).read();
    expect(res.malformed).toBe(1);
    expect(res.unrecognized).toBe(2);
    expect(res.records).toEqual([]);
  });

  it("an over-long record line is overlong; an over-long other line is overlongOther", async () => {
    const big = "x".repeat(CODEX_MAX_LINE_BYTES + 10);
    const longRecord = codexRecord().replace('"payload":{', `"payload":{"pad":"${big}",`);
    const longOther = codexOther("response_item", "message", { text: big });
    const [p] = await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [longRecord, longOther, codexRecord()] }]);
    const res = await reader().open(p!, candidate(p!)).read();
    expect(res.overlong).toBe(1);
    expect(res.overlongOther).toBe(1);
    expect(res.records).toHaveLength(1);
  });

  it("an over-long line is classified by its first CODEX_HEAD_BYTES only (a 5 MiB line)", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    // The record needle sits past the head: the line counts as overlongOther.
    const lateType = JSON.stringify({ timestamp: CODEX_TS, payload: { pad: big }, type: "token_usage_record" });
    const earlyType = JSON.stringify({ timestamp: CODEX_TS, type: "token_usage_record", payload: { pad: big } });
    const [p] = await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [lateType, earlyType, codexRecord()] }]);
    const res = await reader().open(p!, candidate(p!)).read();
    expect(res.overlong).toBe(1);
    expect(res.overlongOther).toBe(1);
    expect(res.records).toHaveLength(1);
    const buf = Buffer.from(lateType);
    expect(classifyCodexLine(buf, 0, buf.length)).toBe("record");
    expect(classifyCodexHead(buf, 0, buf.length)).toBe("other");
    expect(CODEX_HEAD_BYTES).toBe(4096);
  }, 30_000);

  it("a rewritten file resets: state starts over", async () => {
    const [p] = await codexTree(root, [
      { date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta(), codexTurn({ turnId: "t1", model: "gpt-old" }), codexRecord({ turnId: "t1", responseId: "r1" })] },
    ]);
    const fr = reader().open(p!, candidate(p!));
    expect((await fr.read()).records[0]!.model).toBe("gpt-old");
    await writeFile(p!, `${codexRecord({ turnId: "t1", responseId: "r2" })}\n`);
    const res = await fr.read();
    expect(res.reset).toBe(true);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]!.model).toBeUndefined();
    expect(res.label).toBeUndefined();
  });

  it("pathAllowed admits only sessions/YYYY/MM/DD/rollout-*.jsonl", () => {
    const r = reader();
    expect(r.pathAllowed(join(root, "sessions", "2026", "11", "08", `rollout-2026-11-08T10-00-00-${CODEX_SESSION}.jsonl`))).toBe(true);
    expect(r.pathAllowed(join(root, "history.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "archived_sessions", "x.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "archived_sessions", "rollout-x.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "sessions", "2026", "11", "08", "notes.txt"))).toBe(false);
    expect(r.pathAllowed(join(root, "sessions", "2026", "11", "08", "rollout-x.jsonl.zst"))).toBe(false);
    expect(r.pathAllowed(join(root, "sessions", "2026", "11", "rollout-x.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "sessions", "26", "11", "08", "rollout-x.jsonl"))).toBe(false);
    expect(r.pathAllowed(`${root}${sep}sessions${sep}2026${sep}11${sep}08${sep}..${sep}..${sep}..${sep}..${sep}auth.json`)).toBe(false);
    expect(r.pathAllowed(join(root, "..", "sessions", "2026", "11", "08", "rollout-x.jsonl"))).toBe(false);
  });

  it("rootDirMtime is the sessions folder's mtime, undefined when absent", async () => {
    expect(await reader().rootDirMtime()).toBeUndefined();
    await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta()] }]);
    expect(typeof (await reader().rootDirMtime())).toBe("number");
  });

  it("rootDirMtime covers the two newest day folders: a new file changes it, an append does not", async () => {
    const [, , p] = await codexTree(root, [
      { date: "2026/10/30", sessionId: ids0(1), lines: [codexMeta()] },
      { date: "2026/11/07", sessionId: ids0(2), lines: [codexMeta()] },
      { date: "2026/11/08", sessionId: ids0(3), lines: [codexMeta()] },
    ]);
    const old = new Date(Date.now() - 3_600_000);
    const s = join(root, "sessions");
    for (const d of [s, join(s, "2026"), join(s, "2026", "10"), join(s, "2026", "11"), join(s, "2026", "10", "30"), join(s, "2026", "11", "07"), join(s, "2026", "11", "08")]) {
      await utimes(d, old, old);
    }
    const r = reader();
    const before = await r.rootDirMtime();
    expect(before).toBe(fs.statSync(s).mtimeMs);
    await appendFile(p!, `${codexRecord()}\n`);
    expect(await r.rootDirMtime()).toBe(before);
    // A new file in the third-newest day folder is not seen; one in the second-newest is.
    await writeFile(join(s, "2026", "10", "30", `rollout-x-${ids0(4)}.jsonl`), "");
    expect(await r.rootDirMtime()).toBe(before);
    await writeFile(join(s, "2026", "11", "07", `rollout-x-${ids0(5)}.jsonl`), "");
    const after = await r.rootDirMtime();
    expect(after).toBe(fs.statSync(join(s, "2026", "11", "07")).mtimeMs);
    expect(after).toBeGreaterThan(before!);
  });
});

describe("discoverCodex (D45)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cum-codex-disc-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const windowStart = new Date(2026, 9, 1, 0, 0, 0).getTime(); // 2026-10-01 local
  const dayStart = new Date(2026, 10, 8, 0, 0, 0).getTime();
  const now = new Date(2026, 10, 8, 12, 0, 0).getTime();

  it("no sessions folder → no-dir", async () => {
    expect(await discoverCodex(root, windowStart, dayStart, now)).toEqual({ ok: false, error: "no-dir" });
    expect(await discoverCodex(join(root, "missing"), windowStart, dayStart, now)).toEqual({ ok: false, error: "no-dir" });
  });

  it("with the old folders' last findings given, skips date folders before the window's first day less one day of slack, and keeps the slack day", async () => {
    const ids = ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002", "aaaaaaaa-0000-0000-0000-000000000003", "aaaaaaaa-0000-0000-0000-000000000004", "aaaaaaaa-0000-0000-0000-000000000005"];
    const mtime = new Date(now - 3_600_000);
    await codexTree(root, [
      { date: "2025/01/01", sessionId: ids[0]!, lines: [codexMeta()], mtime },
      { date: "2026/09/29", sessionId: ids[1]!, lines: [codexMeta()], mtime },
      { date: "2026/09/30", sessionId: ids[4]!, lines: [codexMeta()], mtime },
      { date: "2026/10/01", sessionId: ids[2]!, lines: [codexMeta()], mtime },
      { date: "2026/11/08", sessionId: ids[3]!, lines: [codexMeta()], mtime: new Date(now - 1000) },
    ]);
    const readdir = vi.spyOn(fs.promises, "readdir");
    const res = await discoverCodex(root, windowStart, dayStart, now, { paths: [], unreadable: [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = new Map(res.candidates.map((c) => [c.sessionId, c]));
    expect([...byId.keys()].sort()).toEqual([ids[2], ids[3], ids[4]]);
    const c = byId.get(ids[3]!)!;
    expect(c).toMatchObject({ source: "codex", folderId: ids[3], live: true, mtimeMs: now - 1000 });
    expect(c.files).toHaveLength(1);
    expect(c.files[0]!.path).toBe(join(root, "sessions", "2026", "11", "08", `rollout-2026-11-08T10-00-00-${ids[3]}.jsonl`));
    expect(byId.get(ids[2]!)!.live).toBe(false);
    expect(res.archived).toBe(0);
    expect(typeof res.dirMtimeMs).toBe("number");
    const listed = readdir.mock.calls.map((a) => String(a[0]));
    expect(listed.some((p) => p.includes(`${sep}2025`))).toBe(false);
    expect(listed.some((p) => p.endsWith(join("09", "29")))).toBe(false);
    expect(listed.some((p) => p.endsWith(join("09", "30")))).toBe(true);
    // Without them every folder is walked: a session resumed in the window is found wherever it started.
    const all = await discoverCodex(root, windowStart, dayStart, now);
    expect(all.ok && all.candidates.map((c) => c.sessionId).sort()).toEqual([...ids].sort());
  });

  it("the slack day crosses a month and year boundary", async () => {
    const jan1 = new Date(2027, 0, 1).getTime();
    await codexTree(root, [
      { date: "2026/12/30", sessionId: ids0(1), lines: [codexMeta()], mtime: new Date(jan1 + 1000) },
      { date: "2026/12/31", sessionId: ids0(2), lines: [codexMeta()], mtime: new Date(jan1 + 1000) },
    ]);
    const res = await discoverCodex(root, jan1, jan1, jan1 + 2000, { paths: [], unreadable: [] });
    expect(res.ok && res.candidates.map((c) => c.sessionId)).toEqual([ids0(2)]);
  });

  it("an unreadable day folder is reported, not swallowed", async () => {
    const [p] = await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta()], mtime: new Date(now - 1000) }]);
    const dir = join(root, "sessions", "2026", "11", "08");
    await chmod(dir, 0o000);
    try {
      const res = await discoverCodex(root, windowStart, dayStart, now);
      expect(res.ok && res.unreadable).toEqual([{ folderId: "2026/11/08", path: dir, code: expect.stringMatching(/^E(ACCES|PERM)$/) }]);
      expect(res.ok && res.candidates).toEqual([]);
    } finally {
      await chmod(dir, 0o755);
    }
    expect(p).toBeDefined();
  });

  it("skips non-digit folders, non-rollout files, and rollout files without a trailing session id", async () => {
    const mtime = new Date(now - 1000);
    await codexTree(root, [
      { date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta()], mtime },
      { date: "2026/11/08", sessionId: "x", name: "rollout-odd.jsonl", lines: [codexMeta()], mtime },
      { date: "2026/11/08", sessionId: "x", name: "notes.jsonl", lines: [codexMeta()], mtime },
      { date: "2026/11/xx", sessionId: OTHER_SESSION, lines: [codexMeta()], mtime },
    ]);
    await writeFile(join(root, "history.jsonl"), `${codexMeta()}\n`);
    const res = await discoverCodex(root, windowStart, dayStart, now);
    expect(res.ok && res.candidates.map((c) => c.sessionId)).toEqual([CODEX_SESSION]);
    expect(res.ok && res.unreadable).toEqual([]);
  });

  it("an unreadable year or month folder is reported under its YYYY or YYYY/MM segment", async () => {
    await codexTree(root, [
      { date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta()], mtime: new Date(now - 1000) },
      { date: "2027/01/01", sessionId: OTHER_SESSION, lines: [codexMeta()], mtime: new Date(now - 1000) },
    ]);
    const month = join(root, "sessions", "2026", "11");
    const year = join(root, "sessions", "2027");
    await chmod(month, 0o000);
    await chmod(year, 0o000);
    try {
      const res = await discoverCodex(root, windowStart, dayStart, now);
      expect(res.ok && res.unreadable).toEqual([
        { folderId: "2026/11", path: month, code: expect.stringMatching(/^E(ACCES|PERM)$/) },
        { folderId: "2027", path: year, code: expect.stringMatching(/^E(ACCES|PERM)$/) },
      ]);
      expect(res.ok && res.candidates).toEqual([]);
    } finally {
      await chmod(month, 0o755);
      await chmod(year, 0o755);
    }
  });

  it("counts archived sessions by name and never opens them", async () => {
    await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta()], mtime: new Date(now - 1000) }], ["rollout-a.jsonl", "rollout-b.jsonl.zst", "rollout-c.jsonl"]);
    const open = vi.spyOn(fs.promises, "open");
    const readFile = vi.spyOn(fs.promises, "readFile");
    const readdir = vi.spyOn(fs.promises, "readdir");
    const lstat = vi.spyOn(fs.promises, "lstat");
    const stat = vi.spyOn(fs.promises, "stat");
    const res = await discoverCodex(root, windowStart, dayStart, now);
    expect(res.ok && res.archived).toBe(3);
    const touched = [...open.mock.calls, ...readFile.mock.calls, ...readdir.mock.calls, ...lstat.mock.calls, ...stat.mock.calls].map((a) => String(a[0]));
    expect(touched.filter((p) => p.includes(`archived_sessions${sep}`))).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("files older than the window are skipped", async () => {
    await codexTree(root, [{ date: "2026/10/01", sessionId: CODEX_SESSION, lines: [codexMeta()], mtime: new Date(windowStart - 1000) }]);
    const res = await discoverCodex(root, windowStart, dayStart, now);
    expect(res.ok && res.candidates).toEqual([]);
  });

  it("the reader's discover delegates to discoverCodex", async () => {
    await codexTree(root, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines: [codexMeta()], mtime: new Date(now - 1000) }]);
    const r = new CodexSourceReader({ root, rootSource: "setting", readProjects: true, readTotals: true });
    expect(r.source).toBe("codex");
    expect(r.root).toBe(root);
    expect(r.rootSource).toBe("setting");
    const res = await r.discover(windowStart, dayStart, now);
    expect(res.ok && res.candidates.map((c) => c.sessionId)).toEqual([CODEX_SESSION]);
  });
});
