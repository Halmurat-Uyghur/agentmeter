// ING-1: a Codex token_count event whose payload.info is the JSON literal null (rate limits
// only, written before the session has any usage) carries no usage and is not a format
// change: it is ignored, not unrecognized. An info object without a known token field, or a
// missing info key, stays unrecognized (the renamed-field detector). Ported from the review
// harness (codexInfoNull.test.ts).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCodexLine, CodexSourceReader, parseCodexLine, type CodexFileState } from "../../src/core/codex";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import type { Snapshot } from "../../src/core/types";
import { CODEX_SESSION, CODEX_TS, codexMeta, codexRecord, codexTokenCount, codexTree, codexTurn } from "../fixtures/codex";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-info-null-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A token_count event_msg with the given payload fields after `type`. */
const event = (fields: object, ts = CODEX_TS) =>
  JSON.stringify({ timestamp: ts, ordinal: 2, type: "event_msg", payload: { type: "token_count", ...fields } });
/** token_count as Codex writes it before the first response: info is null, only rate limits. */
const infoNull = (ts = CODEX_TS) => event({ info: null, rate_limits: { primary: null, secondary: null } }, ts);

const o = { fileSessionId: CODEX_SESSION, wantLabel: true, readTotals: true };
function parse(line: string) {
  const buf = Buffer.from(line);
  const state: CodexFileState = { models: new Map(), sawTurn: false };
  return parseCodexLine(buf, 0, buf.length, classifyCodexLine(buf, 0, buf.length), state, o);
}

async function readAll(lines: string[]) {
  const [p] = await codexTree(dir, [{ date: "2026/11/08", sessionId: CODEX_SESSION, lines }]);
  const reader = new CodexSourceReader({ root: dir, rootSource: "default", readProjects: true, readTotals: true });
  const c = { source: "codex" as const, sessionId: CODEX_SESSION, folderId: CODEX_SESSION, files: [], mtimeMs: 0, live: true };
  return reader.open(p!, c).read();
}

describe("Codex token_count with info:null (ING-1)", () => {
  it("is ignored by the parser", () => {
    expect(parse(infoNull())).toEqual({ kind: "ignored" });
    // Whitespace around the literal is the scanner's concern, not the rule's.
    expect(parse(infoNull().replace('"info":null', '"info" :  null'))).toEqual({ kind: "ignored" });
  });

  it("an info object with no known token field is still unrecognized", () => {
    expect(parse(event({ info: {} }))).toEqual({ kind: "unrecognized", reason: "no-known-token-field" });
    expect(parse(event({ info: { something_else: 1 } }))).toEqual({ kind: "unrecognized", reason: "no-known-token-field" });
  });

  it("a missing info key is still unrecognized", () => {
    expect(parse(event({ rate_limits: { primary: null } }))).toEqual({ kind: "unrecognized", reason: "no-known-token-field" });
  });

  it('"info":null inside a string value does not change a line\'s handling', () => {
    const quoted = '"info":null';
    expect(parse(event({ rate_limits: { plan_type: quoted } }))).toEqual({ kind: "unrecognized", reason: "no-known-token-field" });
    const normal = JSON.parse(codexTokenCount()) as { payload: Record<string, unknown> };
    normal.payload.note = quoted;
    expect(parse(JSON.stringify(normal)).kind).toBe("total");
  });

  it("a normal totals line still yields the session total", () => {
    expect(parse(codexTokenCount()).kind).toBe("total");
  });

  it("before the first per-call record is not an unrecognized line", async () => {
    const r = await readAll([codexMeta(), codexTurn(), infoNull(), codexRecord(), codexTokenCount()]);
    expect(r.usage).toBe(1);
    expect(r.unrecognized).toBe(0);
  });

  it("in a totals-only (older Codex) file is not an unrecognized line", async () => {
    const r = await readAll([codexMeta(), codexTurn(), infoNull(), codexTokenCount()]);
    expect(r.totals?.length).toBe(1);
    expect(r.unrecognized).toBe(0);
  });

  it("keeps Codex health ok in Data health", async () => {
    const T0 = new Date(2026, 10, 8, 12, 0, 0).getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    const ms = T0 - 3_600_000;
    const sid = "c0de0000-0000-4000-8000-000000000001";
    await codexTree(join(dir, "codex"), [
      {
        date: "2026/11/08",
        sessionId: sid,
        lines: [codexMeta({ id: sid, timestamp: iso(ms) }), codexTurn({ timestamp: iso(ms) }), infoNull(iso(ms)), codexRecord({ sessionId: sid, timestamp: iso(ms + 1000) })],
        mtime: new Date(T0 - 60_000),
      },
    ]);
    const snaps: Snapshot[] = [];
    const m = new UsageMonitor({
      root: join(dir, "copilot"),
      rootSource: "default",
      now: () => new Date(T0),
      isLive: () => false,
      log: new Logger(() => undefined),
      onSnapshot: (s) => snaps.push(s),
      readProjects: true,
      readTotals: true,
      sources: { codex: { root: join(dir, "codex"), rootSource: "setting" } },
    });
    try {
      await m.refresh({ full: true });
      expect(snaps.at(-1)!.health.sources?.codex?.state).toBe("ok");
    } finally {
      m.dispose();
    }
  });
});
