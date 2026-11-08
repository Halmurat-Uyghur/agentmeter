// The multi-source monitor (Task 8, D43, D49, D50, D54): Copilot, Claude Code and
// Codex readers composed by one UsageMonitor, hot/cold polling, per-source health.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { appendFile, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/log";
import { UsageMonitor, SESSION_ROWS } from "../../src/core/monitor";
import { emptyReadResult, type FileReader, type SourceCandidate, type SourceDiscoverResult, type SourceReader } from "../../src/core/source";
import type { Snapshot } from "../../src/core/types";
import { jsonl, sessionTree, usageEvent } from "../fixtures/build";
import { CLAUDE_CANARY, claudeAssistantLine, claudeTree, claudeUserLine } from "../fixtures/claude";
import { CODEX_CANARY, codexMeta, codexRecord, codexTokenCount, codexTree, codexTurn } from "../fixtures/codex";

const A = "0000aaaa-0000-4000-8000-000000000001";
const B = "0000bbbb-0000-4000-8000-000000000002";
const LIVE_PID = 4242;
const isLive = (pid: number) => pid === LIVE_PID;

// A fixed local day; every file mtime is set explicitly relative to it.
const T0 = new Date(2026, 10, 8, 12, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const HOT = T0 - 60_000;
const COLD = T0 - 2 * 3_600_000;

/** A Claude session id (UUID) numbered n. */
const cs = (n: number) => `c1a0de00-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A Codex session id (UUID) numbered n. */
const xs = (n: number) => `c0de0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function cRec(session: string, n: number, o: { input?: number; output?: number; ms?: number; id?: string; cwd?: string } = {}): string {
  return claudeAssistantLine({
    id: o.id ?? `msg_${session.slice(-6)}_${n}`,
    requestId: `req_${session.slice(-6)}_${n}`,
    sessionId: session,
    timestamp: iso(o.ms ?? T0 - 3_600_000 + n * 1000),
    ...(o.input !== undefined && { input: o.input }),
    ...(o.output !== undefined && { output: o.output }),
    ...(o.cwd !== undefined && { cwd: o.cwd }),
  });
}

function xFile(session: string, n: number, ms = T0 - 3_600_000): string[] {
  const lines = [codexMeta({ id: session, timestamp: iso(ms) }), codexTurn({ timestamp: iso(ms) })];
  for (let i = 0; i < n; i++) lines.push(codexRecord({ sessionId: session, responseId: `resp_${session.slice(-6)}_${i}`, timestamp: iso(ms + i * 1000) }));
  return lines;
}

function pRec(folder: string, n: number, ms = T0 - 3_600_000 + n * 1000): object {
  return usageEvent({ usageId: `u-${folder.slice(4, 8)}-${n}`, id: `e-${n}`, sourceSessionId: folder, timestamp: iso(ms) });
}

let dir: string;
let copilotRoot: string;
let claudeRoot: string;
let codexRoot: string;
let clock: number;
let snaps: Snapshot[];
let logLines: string[];
let monitor: UsageMonitor | undefined;

function make(extra: Partial<ConstructorParameters<typeof UsageMonitor>[0]> = {}, withSources = true): UsageMonitor {
  monitor = new UsageMonitor({
    root: copilotRoot,
    rootSource: "default",
    now: () => new Date(clock),
    isLive,
    log: new Logger((l) => logLines.push(l)),
    onSnapshot: (s) => snaps.push(s),
    readProjects: true,
    readTotals: true,
    ...(withSources && { sources: { claude: { root: claudeRoot, rootSource: "default" }, codex: { root: codexRoot, rootSource: "setting" } } }),
    ...extra,
  });
  return monitor;
}

const last = (): Snapshot => {
  const s = snaps.at(-1);
  if (!s) throw new Error("no snapshot");
  return s;
};

const touch = (p: string, ms: number) => utimes(p, ms / 1000, ms / 1000);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cum-sources-"));
  copilotRoot = join(dir, "copilot");
  claudeRoot = join(dir, "claude");
  codexRoot = join(dir, "codex");
  clock = T0;
  snaps = [];
  logLines = [];
});

afterEach(async () => {
  monitor?.dispose();
  monitor = undefined;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("multi-source monitor", () => {
  it("a Copilot-only machine shows the same figures as a monitor without sources", async () => {
    await sessionTree(copilotRoot, [{ id: A, lines: jsonl([pRec(A, 1), pRec(A, 2)]), mtime: new Date(HOT) }]);
    make({}, false);
    await monitor!.refresh({ full: true });
    const plain = last();
    monitor!.dispose();
    snaps = [];
    make();
    await monitor!.refresh({ full: true });
    const multi = last();
    expect(multi.today).toEqual(plain.today);
    expect(multi.month).toEqual(plain.month);
    expect(multi.history).toEqual(plain.history);
    expect(multi.health.state).toBe(plain.health.state);
    expect(multi.health.state).toBe("ok");
    expect(multi.health.sources?.["claude-code"]?.state).toBe("no-dir");
    expect(multi.health.sources?.codex?.state).toBe("no-dir");
    expect(multi.health.sources?.copilot?.state).toBe("ok");
    expect(plain.health.sources?.["claude-code"]).toBeUndefined();
  });

  it("health.sources lists only enabled sources, with their root origins", async () => {
    await sessionTree(copilotRoot, [{ id: A, lines: jsonl([pRec(A, 1)]), mtime: new Date(HOT) }]);
    make({ sources: { codex: { root: codexRoot, rootSource: "env" } } });
    await monitor!.refresh({ full: true });
    expect(Object.keys(last().health.sources ?? {}).sort()).toEqual(["codex", "copilot"]);
    expect(last().health.sources?.codex?.rootSource).toBe("env");
    expect(last().health.sources?.codex?.state).toBe("no-dir");
  });

  it("three sources: bySource sums, byModel source counts, and the source filter narrows the month", async () => {
    await sessionTree(copilotRoot, [{ id: A, lines: jsonl([pRec(A, 1), pRec(A, 2)]), mtime: new Date(HOT) }]);
    await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1), cRec(cs(1), 2), cRec(cs(1), 3)], mtime: HOT }]);
    await codexTree(codexRoot, [{ date: "2026/11/08", sessionId: xs(1), lines: xFile(xs(1), 4), mtime: HOT }]);
    make();
    await monitor!.refresh({ full: true });
    const s = last();
    expect(s.today?.records).toBe(9);
    expect(s.today?.bySource?.copilot?.records).toBe(2);
    expect(s.today?.bySource?.["claude-code"]?.records).toBe(3);
    expect(s.today?.bySource?.codex?.records).toBe(4);
    expect(s.today?.byModel["claude-opus-4-1"]?.sources).toEqual({ "claude-code": 3 });
    expect(s.today?.byModel["gpt-5-codex"]?.sources).toEqual({ codex: 4 });
    expect(s.health.state).toBe("ok");
    expect(s.health.sources?.["claude-code"]).toMatchObject({ state: "ok", files: 1, sessions: 1 });
    expect(s.health.sources?.codex).toMatchObject({ state: "ok", files: 1, sessions: 1, rootSource: "setting" });
    expect(s.month?.sessionsBySource).toEqual({ copilot: 1, "claude-code": 1, codex: 1 });
    expect(s.sessions.map((x) => x.source).sort()).toEqual(["claude-code", "codex", "copilot"]);
    // Projects are keyed by folder name for every source (D44).
    expect(s.month?.projects.map((p) => p.name).sort()).toEqual(["(no project)", "codex-proj", "myrepo"]);

    monitor!.setFilter({ source: "codex" });
    await monitor!.refresh();
    const f = last();
    expect(f.filter).toEqual({ source: "codex" });
    expect(f.month?.totals?.records).toBe(4);
    expect(f.month?.projects.map((p) => p.name)).toEqual(["codex-proj"]);
    expect(f.month?.sessionsBySource).toEqual({ codex: 1 });
    expect(f.history?.at(-1)?.totals?.records).toBe(4);
    // Today and thisMonth are never filtered.
    expect(f.today?.records).toBe(9);
    expect(f.thisMonth?.records).toBe(9);
    expect(f.thisMonthProjects?.length).toBe(3);

    monitor!.setFilter({ source: "x" as never });
    await monitor!.refresh();
    expect(last().filter).toBeUndefined();
    expect(last().month?.totals?.records).toBe(9);
    monitor!.setFilter({ source: "" as never });
    await monitor!.refresh();
    expect(last().filter).toBeUndefined();
  });

  it("a Claude Code message streamed across two refreshes counts once with the last usage", async () => {
    const [main] = await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1, { id: "msg_stream", output: 5 })], mtime: HOT }]);
    make();
    await monitor!.refresh({ full: true });
    expect(last().today?.bySource?.["claude-code"]?.output.sum).toBe(5);
    await appendFile(main!, `${cRec(cs(1), 1, { id: "msg_stream", output: 77 })}\n`);
    await touch(main!, T0);
    clock += 500;
    await monitor!.refresh();
    expect(last().today?.bySource?.["claude-code"]?.records).toBe(1);
    expect(last().today?.bySource?.["claude-code"]?.output.sum).toBe(77);
  });

  it("a subagent file's records join the parent session", async () => {
    await claudeTree(claudeRoot, [
      { sessionId: cs(1), lines: [cRec(cs(1), 1), claudeUserLine({ sessionId: cs(1) })], subagents: [{ id: "a1", lines: [cRec(cs(1), 2), cRec(cs(1), 3)] }], mtime: HOT },
    ]);
    make();
    await monitor!.refresh({ full: true });
    const m = last().month!;
    expect(m.sessions).toHaveLength(1);
    expect(m.sessions[0]).toMatchObject({ sessionId: cs(1), calls: 3, source: "claude-code" });
    expect(last().health.sources?.["claude-code"]).toMatchObject({ files: 2, sessions: 1 });
  });

  it("current prefers a PID-live Copilot session over an mtime-live Claude session and reports its source", async () => {
    await sessionTree(copilotRoot, [{ id: A, lines: jsonl([pRec(A, 1, T0 - 3_600_000)]), lockPid: LIVE_PID, mtime: new Date(COLD) }]);
    await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1, { ms: T0 - 30_000 })], mtime: HOT }]);
    make();
    await monitor!.refresh({ full: true });
    expect(last().current).toMatchObject({ folderId: A, live: true, source: "copilot" });
    monitor!.dispose();
    // Without a live Copilot session the mtime-live Claude session is current.
    await rm(join(copilotRoot, "session-state", A, `inuse.${LIVE_PID}.lock`));
    snaps = [];
    make();
    await monitor!.refresh({ full: true });
    expect(last().current).toMatchObject({ folderId: cs(1), live: true, source: "claude-code" });
    expect(last().sessions.find((x) => x.folderId === cs(1))).toMatchObject({ live: true, source: "claude-code" });
  });

  it("idle refreshes open only hot files and Copilot files, never the cold Claude files; an edited cold file is re-read after discovery", async () => {
    await sessionTree(copilotRoot, [{ id: A, lines: jsonl([pRec(A, 1)]), mtime: new Date(COLD) }]);
    const cold: string[] = [];
    for (let i = 0; i < 50; i++) cold.push(...(await claudeTree(claudeRoot, [{ sessionId: cs(100 + i), lines: [cRec(cs(100 + i), 1)], mtime: COLD }])));
    const [hot] = await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1)], mtime: HOT }]);
    make();
    await monitor!.refresh({ full: true });
    expect(last().today?.records).toBe(52);
    const open = vi.spyOn(fs.promises, "open");
    for (let i = 0; i < 20; i++) {
      clock += 500;
      await monitor!.refresh();
    }
    const opened = new Set(open.mock.calls.map((c) => String(c[0])));
    expect(opened).toEqual(new Set([hot!, join(copilotRoot, "session-state", A, "events.jsonl")]));
    for (const p of cold) expect(opened.has(p)).toBe(false);

    // An edit to a cold file is seen by the next discovery and read then.
    const edited = cold[7]!;
    await appendFile(edited, `${cRec(cs(107), 2)}\n`);
    await touch(edited, clock);
    open.mockClear();
    clock += 500;
    await monitor!.refresh();
    expect(open.mock.calls.some((c) => String(c[0]) === edited)).toBe(false); // not before discovery
    clock += 10_000;
    await monitor!.refresh();
    expect(open.mock.calls.some((c) => String(c[0]) === edited)).toBe(true);
    expect(last().today?.records).toBe(53);
    for (const p of cold) if (p !== edited) expect(open.mock.calls.some((c) => String(c[0]) === p)).toBe(false);
  });

  it("health.reading is set during the first read of 200 files and absent after", async () => {
    for (let i = 0; i < 200; i++) await claudeTree(claudeRoot, [{ sessionId: cs(i), lines: [cRec(cs(i), 1)], mtime: COLD - i * 1000 }]);
    // The clock moves 50 ms per call, so progress snapshots fall due during the read.
    make({ now: () => new Date((clock += 50)) });
    await monitor!.refresh({ full: true });
    const reading = snaps.filter((s) => s.health.reading !== undefined);
    expect(reading.length).toBeGreaterThan(0);
    for (const s of reading) {
      expect(s.health.reading!.total).toBe(200);
      expect(s.health.reading!.done).toBeLessThan(200);
    }
    const dones = reading.map((s) => s.health.reading!.done);
    expect([...dones].sort((a, b) => a - b)).toEqual(dones);
    expect(last().health.reading).toBeUndefined();
    expect(last().today?.records).toBe(200);
  });

  it("the first read goes newest file first", async () => {
    await claudeTree(claudeRoot, [
      { sessionId: cs(1), lines: [cRec(cs(1), 1)], mtime: COLD - 5000 },
      { sessionId: cs(2), lines: [cRec(cs(2), 1)], mtime: COLD },
      { sessionId: cs(3), lines: [cRec(cs(3), 1)], mtime: COLD - 9000 },
    ]);
    const open = vi.spyOn(fs.promises, "open");
    make();
    await monitor!.refresh({ full: true });
    const order = open.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith(claudeRoot));
    expect(order.map((p) => p.match(/(\d{12})\.jsonl$/)?.[1])).toEqual(["000000000002", "000000000001", "000000000003"]);
  });

  it("health.state is no-dir only when every enabled source is missing", async () => {
    make();
    await monitor!.refresh({ full: true });
    expect(last().health.state).toBe("no-dir");
    monitor!.dispose();
    await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1)], mtime: HOT }]);
    snaps = [];
    make();
    await monitor!.refresh({ full: true });
    expect(last().health.state).toBe("ok");
    expect(last().health.sources?.copilot?.state).toBe("no-dir");
    expect(last().health.sources?.["claude-code"]?.state).toBe("ok");
  });

  it("a source without a record today is no-data while another is ok", async () => {
    await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1)], mtime: HOT }]);
    await codexTree(codexRoot, [{ date: "2026/11/02", sessionId: xs(1), lines: xFile(xs(1), 1, new Date(2026, 10, 2, 9).getTime()), mtime: new Date(2026, 10, 2, 10) }]);
    make();
    await monitor!.refresh({ full: true });
    expect(last().health.sources?.codex?.state).toBe("no-data");
    expect(last().health.sources?.["claude-code"]?.state).toBe("ok");
    expect(last().health.state).toBe("ok");
  });

  it("sessionsBySource counts every session of the month, beyond the session rows", async () => {
    for (let i = 0; i < 60; i++) await claudeTree(claudeRoot, [{ sessionId: cs(i), lines: [cRec(cs(i), 1)], mtime: COLD }]);
    await codexTree(codexRoot, [1, 2, 3].map((n) => ({ date: "2026/11/08", sessionId: xs(n), lines: xFile(xs(n), 1), mtime: COLD })));
    make();
    await monitor!.refresh({ full: true });
    const m = last().month!;
    expect(m.sessions).toHaveLength(SESSION_ROWS);
    expect(m.sessionCount).toBe(63);
    expect(m.sessionsBySource).toEqual({ "claude-code": 60, codex: 3 });
  });

  it("a Codex token_count-only file yields a session total, hidden once a record arrives", async () => {
    const ms = T0 - 3_600_000;
    const [file] = await codexTree(codexRoot, [
      { date: "2026/11/08", sessionId: xs(1), lines: [codexMeta({ id: xs(1), timestamp: iso(ms) }), codexTurn({ timestamp: iso(ms) }), codexTokenCount({ timestamp: iso(ms) })], mtime: HOT },
    ]);
    make();
    await monitor!.refresh({ full: true });
    expect(last().month?.totals).toMatchObject({ records: 1, sessionTotals: 1 });
    expect(last().health.sessionsFromTotals).toBe(1);
    await appendFile(file!, `${codexRecord({ sessionId: xs(1), timestamp: iso(ms + 5000) })}\n`);
    await touch(file!, T0);
    clock += 500;
    await monitor!.refresh();
    expect(last().month?.totals).toMatchObject({ records: 1, sessionTotals: 0 });
    expect(last().health.sessionsFromTotals).toBe(0);
  });

  it("a candidate path the reader does not allow is refused, counted unreadable and logged by code only", async () => {
    const opened: string[] = [];
    const secret = join(dir, "elsewhere", CLAUDE_CANARY, "x.jsonl");
    const stub: SourceReader = {
      source: "claude-code",
      root: join(dir, "stub"),
      rootSource: "default",
      rootDirMtime: async () => 1,
      discover: async (): Promise<SourceDiscoverResult> => ({
        ok: true,
        candidates: [{ source: "claude-code", sessionId: cs(1), folderId: cs(1), files: [{ path: secret, mtimeMs: HOT, size: 10 }], mtimeMs: HOT, live: true } satisfies SourceCandidate],
        unreadable: [],
        dirMtimeMs: 1,
      }),
      pathAllowed: () => false,
      open: (p: string): FileReader => {
        opened.push(p);
        return { read: async () => emptyReadResult() };
      },
    };
    make({ readers: [stub] }, false);
    await monitor!.refresh({ full: true });
    clock += 10_000;
    await monitor!.refresh();
    expect(opened).toEqual([]);
    expect(last().health.sources?.["claude-code"]).toMatchObject({ files: 0, unreadableFiles: 1 });
    expect(last().health.unreadableFiles).toBe(1);
    expect(last().health.partial).toBe(true);
    expect(logLines.filter((l) => l === "error discover PATH_REFUSED")).toHaveLength(1);
    expect(logLines.join("\n")).not.toContain(dir);
    expect(logLines.join("\n")).not.toContain(CLAUDE_CANARY);
  });

  it("an off source's root is never touched", async () => {
    await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1)], mtime: HOT }]);
    await codexTree(codexRoot, [{ date: "2026/11/08", sessionId: xs(1), lines: xFile(xs(1), 1), mtime: HOT }]);
    await sessionTree(copilotRoot, [{ id: B, lines: jsonl([pRec(B, 1)]), mtime: new Date(HOT) }]);
    const spies = [vi.spyOn(fs.promises, "readdir"), vi.spyOn(fs.promises, "lstat"), vi.spyOn(fs.promises, "stat"), vi.spyOn(fs.promises, "open")];
    make({ sources: { codex: { root: codexRoot, rootSource: "default" } } });
    await monitor!.refresh({ full: true });
    clock += 10_000;
    await monitor!.refresh();
    expect(last().today?.records).toBe(2);
    for (const spy of spies) for (const c of spy.mock.calls) expect(String(c[0]).startsWith(claudeRoot)).toBe(false);
  });

  it("canary: no snapshot or log line carries Claude Code or Codex log content", async () => {
    await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1), claudeUserLine({ sessionId: cs(1) })], subagents: [{ id: "a1", lines: [cRec(cs(1), 2)] }], mtime: HOT }]);
    await codexTree(codexRoot, [{ date: "2026/11/08", sessionId: xs(1), lines: [...xFile(xs(1), 2), codexTokenCount()], mtime: HOT }]);
    make();
    await monitor!.refresh({ full: true });
    const all = JSON.stringify(snaps) + logLines.join("\n");
    expect(all).not.toContain(CLAUDE_CANARY);
    expect(all).not.toContain(CODEX_CANARY);
    expect(all).not.toContain(dir);
  });
});
