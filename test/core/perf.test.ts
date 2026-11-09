// Performance budget (plan Task 9 / AC8). Runs only under PERF=1:
//   npm run test:perf   (the script sets NODE_OPTIONS=--expose-gc, so the heap checks run with gc)
import { statSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Logger } from "../../src/core/log";
import { ClaudeSourceReader } from "../../src/core/claude";
import { CopilotSourceReader } from "../../src/core/copilot";
import { UsageMonitor } from "../../src/core/monitor";
import type { SourceReader } from "../../src/core/source";
import type { Snapshot } from "../../src/core/types";
import { CANARY, jsonl, otherEvent, shutdownEvent, usageEvent } from "../fixtures/build";
import { CLAUDE_CANARY, claudeAssistantLine, claudeOtherLine, claudeUserLine } from "../fixtures/claude";
import { codexMeta, codexRecord, codexTree, codexTurn } from "../fixtures/codex";

let root: string;
const id = (i: number) => `0000${String(i).padStart(4, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cum-perf-"));
  const base = join(root, "session-state");
  // 300 folders, 40 of them with logs: 20 MB total, ~99 % big non-usage lines.
  for (let i = 0; i < 300; i++) await mkdir(join(base, id(i)), { recursive: true });
  const big = JSON.stringify(otherEvent("tool.execution_complete", { data: { content: CANARY.repeat(200_000 / CANARY.length) } })) + "\n";
  let n = 0;
  for (let i = 0; i < 40; i++) {
    const parts: string[] = [];
    let size = 0;
    while (size < 500_000) {
      parts.push(big);
      size += big.length;
      for (let k = 0; k < 3; k++) {
        const line = jsonl([usageEvent({ usageId: `p-${n}`, id: `pe-${n}`, sourceSessionId: id(i) })]);
        n++;
        parts.push(line);
        size += line.length;
      }
    }
    // Each log ends with a session total (3 models); its per-call records hide it (D29).
    parts.push(jsonl([shutdownEvent({ models: { [`model-${i}`]: {}, "model-b": {}, "model-c": {} } })]));
    await writeFile(join(base, id(i), "events.jsonl"), parts.join(""));
  }
  // 20 legacy logs counted from session totals only, plus one with a 2 MB shutdown line (counted, not decoded).
  const turn = jsonl([otherEvent("assistant.turn_end")]);
  for (let i = 40; i < 60; i++) {
    await writeFile(join(base, id(i), "events.jsonl"), big + turn.repeat(3) + jsonl([shutdownEvent({ models: { "model-a": { totalNanoAiu: 0 }, "model-b": {} } })]));
  }
  const huge = JSON.stringify(shutdownEvent()).replace('"routine"', `"${CANARY.repeat(2_000_000 / CANARY.length)}"`);
  await writeFile(join(base, id(60), "events.jsonl"), turn + huge + "\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("perf", () => {
  it("cold scan < 2 s, steady refresh < 50 ms, bounded heap", async () => {
    (globalThis as { gc?: () => void }).gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    let snaps = 0;
    let last: Snapshot | undefined;
    const m = new UsageMonitor({ root, rootSource: "default", log: new Logger(() => {}), onSnapshot: (x) => {
      snaps++;
      last = x;
    }, readTotals: true });

    let t = performance.now();
    await m.refresh({ full: true });
    const cold = performance.now() - t;

    await appendFile(join(root, "session-state", id(0), "events.jsonl"), jsonl([usageEvent({ usageId: "p-new", sourceSessionId: id(0) })]));
    t = performance.now();
    await m.refresh();
    const steady = performance.now() - t;

    const cpu0 = process.cpuUsage();
    const wall0 = performance.now();
    for (let i = 0; i < 20; i++) await m.refresh();
    const cpu = process.cpuUsage(cpu0);
    const idleCpuMsPerPoll = (cpu.user + cpu.system) / 1000 / 20;

    (globalThis as { gc?: () => void }).gc?.();
    const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
    console.log(`cold ${cold.toFixed(0)}ms, steady ${steady.toFixed(1)}ms, idle ${idleCpuMsPerPoll.toFixed(2)}ms cpu per poll (${(performance.now() - wall0).toFixed(0)}ms wall), heap +${heapMb.toFixed(1)}MB, snapshots ${snaps}`);
    expect(last?.health).toMatchObject({ sessionsFromTotals: 20, shutdownOversize: 1, partial: true });
    expect(last?.today?.sessionTotals).toBe(40);
    expect(JSON.stringify(last)).not.toContain(CANARY);
    expect(cold).toBeLessThan(2000);
    expect(steady).toBeLessThan(50);
    // 500 ms poll → 1 % CPU means < 5 ms CPU per idle poll.
    expect(idleCpuMsPerPoll).toBeLessThan(5);
    expect(heapMb).toBeLessThan(64);
    m.dispose();
  }, 60_000);

  it("a busy month (50k records): median steady refresh < 75 ms, idle poll < 5 ms CPU", async () => {
    const dir = join(root, "session-state", id(299));
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) {
      lines.push(jsonl([usageEvent({ usageId: `busy-${i}`, id: `be-${i}`, sourceSessionId: id(299), model: `model-${i % 7}` })]));
    }
    await writeFile(join(dir, "events.jsonl"), lines.join(""));
    const m = new UsageMonitor({ root, rootSource: "default", log: new Logger(() => {}), onSnapshot: () => {}, readTotals: true });
    await m.refresh({ full: true });
    // Median of 5 steady refreshes (each with one new record): one sample is noise on a loaded machine.
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      await appendFile(join(dir, "events.jsonl"), jsonl([usageEvent({ usageId: `busy-new-${i}`, id: `bn-${i}`, sourceSessionId: id(299) })]));
      const t = performance.now();
      await m.refresh();
      samples.push(performance.now() - t);
    }
    const steady = [...samples].sort((a, b) => a - b)[2]!;
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < 20; i++) await m.refresh();
    const cpu = process.cpuUsage(cpu0);
    const idle = (cpu.user + cpu.system) / 1000 / 20;
    console.log(`busy month: steady median ${steady.toFixed(1)}ms of [${samples.map((x) => x.toFixed(1)).join(", ")}], idle ${idle.toFixed(2)}ms cpu per poll`);
    expect(steady).toBeLessThan(75);
    expect(idle).toBeLessThan(5);
    m.dispose();
  }, 60_000);
});

// Task 12 (D50): the Claude Code and Codex budgets. A synthetic Claude-shaped corpus of
// 3,000 files over 60 slugs (>= 200 MB): 1 % assistant lines built by the fixture
// builder, 99 % user and attachment lines of 2-8 KB holding CLAUDE_CANARY, and 30
// user lines over 1 MiB; plus a Codex tree. Lines are written from pre-built templates.
const MiB = 1024 * 1024;
const SESS_MARK = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ID_MARK = "IDMARK0000";
const TS_MARK = "2000-01-01T00:00:00.000Z";
const cs = (i: number) => `c1a0de00-0000-4000-8000-${String(i).padStart(12, "0")}`;
const xs = (i: number) => `c0de0000-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** An assistant-line factory: the fixture builder's line with per-line ids, session and time spliced in. */
function assistantTemplate(): (id: string, session: string, ts: string) => string {
  const tpl = claudeAssistantLine({ id: `msg_${ID_MARK}`, requestId: `req_${ID_MARK}`, sessionId: SESS_MARK, timestamp: TS_MARK, tools: ["Bash", "Read"] });
  const parts = tpl.split(/(IDMARK0000|ffffffff-ffff-4fff-8fff-ffffffffffff|2000-01-01T00:00:00\.000Z)/);
  return (id, session, ts) => {
    let out = "";
    for (const p of parts) out += p === ID_MARK ? id : p === SESS_MARK ? session : p === TS_MARK ? ts : p;
    return `${out}\n`;
  };
}

function contentLines(): Buffer[] {
  const out: Buffer[] = [];
  for (let kb = 2; kb <= 8; kb++) {
    const pad = CLAUDE_CANARY.repeat(Math.floor((kb * 1024 - 900) / CLAUDE_CANARY.length));
    out.push(Buffer.from(`${claudeUserLine({ text: pad })}\n`));
    out.push(Buffer.from(`${claudeOtherLine("attachment", { extra: { attachment: { content: pad, usage: { input_tokens: 9, output_tokens: 9 } } } })}\n`));
  }
  return out;
}

describe("perf: Claude Code and Codex sources (D50)", () => {
  let sroot: string;
  let claudeRoot: string;
  let codexRoot: string;
  let bytes = 0;
  let assistants = 0;
  let claudeLines = 0;
  let hotFile = "";
  const assistant = assistantTemplate();

  beforeAll(async () => {
    sroot = await mkdtemp(join(tmpdir(), "cum-perf-sources-"));
    claudeRoot = join(sroot, "claude");
    codexRoot = join(sroot, "codex");
    // every source folder exists (an empty Copilot one), so the idle budget measures only the hot/cold polling
    await mkdir(join(sroot, "copilot", "session-state"), { recursive: true });
    const now = Date.now();
    const ts = new Date(now - 1000).toISOString();
    const cold = (now - 10 * 60_000) / 1000;
    const content = contentLines();
    const huge = Buffer.from(`${claudeUserLine({ text: CLAUDE_CANARY.repeat(Math.ceil((1.2 * MiB) / CLAUDE_CANARY.length)) })}\n`);
    expect(huge.length).toBeGreaterThan(MiB);
    let line = 0;
    const t = performance.now();
    for (let i = 0; i < 3000; i++) {
      const dir = join(claudeRoot, "projects", `-${CLAUDE_CANARY}-${CLAUDE_CANARY}-slug${i % 60}`);
      if (i < 60) await mkdir(dir, { recursive: true });
      const parts: Buffer[] = [];
      if (i % 100 === 50) {
        parts.push(huge);
        claudeLines++;
      }
      for (let k = 0; k < 12; k++) {
        line++;
        if (line % 100 === 0) {
          parts.push(Buffer.from(assistant(`a${line}`, cs(i), ts)));
          assistants++;
        } else parts.push(content[line % content.length]!);
      }
      claudeLines += 12;
      const buf = Buffer.concat(parts);
      bytes += buf.length;
      const p = join(dir, `${cs(i)}.jsonl`);
      await writeFile(p, buf);
      if (i === 0) hotFile = p;
      else await utimes(p, cold, cold);
    }
    // Codex: 20 rollouts of 50 records each, today, cold.
    const d = new Date(now);
    const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    const files = Array.from({ length: 20 }, (_, i) => ({
      date,
      sessionId: xs(i),
      mtime: new Date(cold * 1000), // a Date: codexTree reads a number as milliseconds
      lines: [codexMeta({ id: xs(i), timestamp: ts }), codexTurn({ timestamp: ts }), ...Array.from({ length: 50 }, (_, k) => codexRecord({ sessionId: xs(i), responseId: `resp_${i}_${k}`, timestamp: ts, ordinal: k + 2 }))],
    }));
    for (const p of await codexTree(codexRoot, files)) bytes += statSync(p).size;
    console.log(`sources corpus: ${(bytes / 1e6).toFixed(0)} MB, ${assistants} assistant lines of ${claudeLines} Claude lines (${((assistants / claudeLines) * 100).toFixed(2)} %), written in ${(performance.now() - t).toFixed(0)}ms`);
    // D50: about 1 % assistant lines.
    expect(assistants / claudeLines).toBeGreaterThan(0.009);
    expect(assistants / claudeLines).toBeLessThan(0.011);
  }, 300_000);

  afterAll(async () => {
    await rm(sroot, { recursive: true, force: true });
  });

  it("cold scan < 1 s per 100 MB, steady tick with one hot file < 50 ms, idle tick < 5 ms CPU, no canary", async () => {
    expect(bytes).toBeGreaterThanOrEqual(200e6);
    let last: Snapshot | undefined;
    const m = new UsageMonitor({
      root: join(sroot, "copilot"),
      rootSource: "default",
      log: new Logger(() => {}),
      onSnapshot: (x) => {
        last = x;
      },
      readTotals: true,
      readProjects: true,
      historyMonths: 2,
      sources: { claude: { root: claudeRoot, rootSource: "default" }, codex: { root: codexRoot, rootSource: "default" } },
    });
    let t = performance.now();
    await m.refresh({ full: true });
    const cold = performance.now() - t;
    const budget = (bytes / 100e6) * 1000;
    const claudeRecords = () => last?.month?.totals?.bySource?.["claude-code"]?.records;
    expect(claudeRecords()).toBe(assistants);
    expect(last?.month?.totals?.bySource?.codex?.records).toBe(20 * 50);

    await appendFile(hotFile, assistant("hot-1", cs(0), new Date().toISOString()));
    t = performance.now();
    await m.refresh();
    const steady = performance.now() - t;
    expect(claudeRecords()).toBe(assistants + 1);

    const cpu0 = process.cpuUsage();
    const wall0 = performance.now();
    for (let i = 0; i < 20; i++) await m.refresh();
    const cpu = process.cpuUsage(cpu0);
    const idle = (cpu.user + cpu.system) / 1000 / 20;
    console.log(`sources: cold ${cold.toFixed(0)}ms for ${(bytes / 1e6).toFixed(0)} MB (budget ${budget.toFixed(0)}ms, ${((cold / bytes) * 100e6).toFixed(0)}ms per 100 MB), steady ${steady.toFixed(1)}ms, idle ${idle.toFixed(2)}ms cpu per tick (${(performance.now() - wall0).toFixed(0)}ms wall)`);
    expect(JSON.stringify(last)).not.toContain(CLAUDE_CANARY);
    expect(cold).toBeLessThan(budget);
    expect(steady).toBeLessThan(50);
    expect(idle).toBeLessThan(5);
    m.dispose();
  }, 300_000);

  it("idle tick < 5 ms CPU when one enabled source's folder is missing (a machine without Copilot)", async () => {
    let snaps = 0;
    const m = new UsageMonitor({
      root: join(sroot, "no-copilot"),
      rootSource: "default",
      log: new Logger(() => {}),
      onSnapshot: () => {
        snaps++;
      },
      readTotals: true,
      historyMonths: 2,
      sources: { claude: { root: claudeRoot, rootSource: "default" }, codex: { root: codexRoot, rootSource: "default" } },
    });
    await m.refresh({ full: true });
    const before = snaps;
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < 20; i++) await m.refresh();
    const cpu = process.cpuUsage(cpu0);
    const idle = (cpu.user + cpu.system) / 1000 / 20;
    console.log(`sources, Copilot folder missing: idle ${idle.toFixed(2)}ms cpu per tick, ${snaps - before} snapshots over 20 idle ticks`);
    expect(idle).toBeLessThan(5);
    m.dispose();
  }, 300_000);

  it("cheap rediscovery tick: with 3,000 cold Claude files primed, a 10 s directory check (no walk) < 20 ms wall, < 5 ms CPU", async () => {
    let clock = Date.now();
    const claude = new ClaudeSourceReader({ root: claudeRoot, rootSource: "default", readProjects: true });
    let walks = 0;
    const discover = claude.discover.bind(claude);
    claude.discover = async (...a: Parameters<SourceReader["discover"]>) => {
      walks++;
      return discover(...a);
    };
    const readers: SourceReader[] = [new CopilotSourceReader({ root: join(sroot, "copilot"), rootSource: "default", readProjects: true, readTotals: true }), claude];
    const m = new UsageMonitor({ root: join(sroot, "copilot"), rootSource: "default", log: new Logger(() => {}), onSnapshot: () => {}, readTotals: true, readProjects: true, historyMonths: 2, now: () => new Date(clock), readers });
    await m.refresh({ full: true });
    expect(walks).toBe(1);
    // One unmeasured check tick (first-run compilation), then the priming read's garbage is
    // collected and its background GC threads settle, so the samples measure the tick alone.
    clock += 10_000;
    await m.refresh();
    (globalThis as { gc?: () => void }).gc?.();
    await new Promise((r) => setTimeout(r, 100));
    const walls: number[] = [];
    const cpus: number[] = [];
    // four more ticks 10 s apart (20-50 s): each runs the directory check, none reaches the 60 s walk
    for (let i = 0; i < 4; i++) {
      clock += 10_000;
      const cpu0 = process.cpuUsage();
      const t = performance.now();
      await m.refresh();
      walls.push(performance.now() - t);
      const c = process.cpuUsage(cpu0);
      cpus.push((c.user + c.system) / 1000);
    }
    const median = (xs: number[]) => {
      const v = [...xs].sort((a, b) => a - b);
      return (v[1]! + v[2]!) / 2;
    };
    const wall = median(walls);
    const cpu = median(cpus);
    console.log(`cheap rediscovery tick: median ${wall.toFixed(1)}ms wall of [${walls.map((x) => x.toFixed(1)).join(", ")}], median ${cpu.toFixed(2)}ms cpu of [${cpus.map((x) => x.toFixed(2)).join(", ")}], walks ${walks - 1} after priming`);
    expect(walks).toBe(1);
    expect(wall).toBeLessThan(20);
    expect(cpu).toBeLessThan(5);
    m.dispose();
  }, 300_000);

  it("heap growth < 64 MB for 100,000 Claude Code records", async () => {
    const hroot = join(sroot, "heap");
    const ts = new Date(Date.now() - 1000).toISOString();
    const cold = (Date.now() - 10 * 60_000) / 1000;
    const dir = join(hroot, "projects", `-${CLAUDE_CANARY}-heap`);
    await mkdir(dir, { recursive: true });
    for (let f = 0; f < 100; f++) {
      let s = "";
      for (let k = 0; k < 1000; k++) s += assistant(`h${f}_${k}`, cs(10_000 + f), ts);
      const p = join(dir, `${cs(10_000 + f)}.jsonl`);
      await writeFile(p, s);
      await utimes(p, cold, cold);
    }
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    let last: Snapshot | undefined;
    const m = new UsageMonitor({
      root: join(sroot, "copilot"),
      rootSource: "default",
      log: new Logger(() => {}),
      onSnapshot: (x) => {
        last = x;
      },
      readTotals: true,
      readProjects: true,
      historyMonths: 2,
      sources: { claude: { root: hroot, rootSource: "default" } },
    });
    await m.refresh({ full: true });
    gc?.();
    const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
    console.log(`sources heap: +${heapMb.toFixed(1)}MB for ${last?.month?.totals?.bySource?.["claude-code"]?.records} records (gc ${gc ? "on" : "off"})`);
    expect(last?.month?.totals?.bySource?.["claude-code"]?.records).toBe(100_000);
    expect(JSON.stringify(last)).not.toContain(CLAUDE_CANARY);
    expect(heapMb).toBeLessThan(64);
    m.dispose();
  }, 300_000);
});

// Live appends: what one new line of a session being written costs. A store shaped like a year
// of daily use of the three tools: about 90,000 records in 40 Copilot, 3,774 Claude Code and
// 193 Codex logs, spread over six months (three in ten in the current one), one live log per
// source. The next tick picks an appended line up and rebuilds the snapshot; the budgets are
// the CPU of that tick, for a line that adds a call and for one that adds none.
const LIVE_MONTHS = 6;
/** months back of a log, by its index: three in ten are this month's */
const LIVE_MONTH_OF = [0, 0, 0, 1, 1, 2, 2, 3, 4, 5];
const LIVE = { copilot: [40, 150], claude: [3774, 20], codex: [193, 44] } as const;
const CWD_MARK = "CWDMARK0000";
const MODEL_MARK = "MODELMARK0000";
const ls = (i: number) => `11fe0000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const lx = (i: number) => `11fec0de-0000-4000-8000-${String(i).padStart(12, "0")}`;
const lc = (i: number) => `11fec011-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** A Claude assistant-line factory with the id, session, time, project folder and model spliced in. */
function liveAssistantTemplate(tools: string[]): (id: string, session: string, ts: string, project: string, model: string) => string {
  const tpl = claudeAssistantLine({ id: `msg_${ID_MARK}`, requestId: `req_${ID_MARK}`, sessionId: SESS_MARK, timestamp: TS_MARK, tools, cwd: `/${CLAUDE_CANARY}/${CWD_MARK}`, model: MODEL_MARK });
  const parts = tpl.split(/(IDMARK0000|ffffffff-ffff-4fff-8fff-ffffffffffff|2000-01-01T00:00:00\.000Z|CWDMARK0000|MODELMARK0000)/);
  return (id, session, ts, project, model) => {
    let out = "";
    for (const p of parts) out += p === ID_MARK ? id : p === SESS_MARK ? session : p === TS_MARK ? ts : p === CWD_MARK ? project : p === MODEL_MARK ? model : p;
    return `${out}\n`;
  };
}

describe("perf: live append on a 90,000-record store (three sources, six months)", () => {
  let lroot: string;
  let records = 0;
  const live = { copilot: "", claude: "", codex: "" };
  const assistants = [["Bash", "Read"], ["Edit"], [], ["mcp__srv__lookup", "Grep"]].map(liveAssistantTemplate);
  const CLAUDE_MODELS = ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"];

  beforeAll(async () => {
    lroot = await mkdtemp(join(tmpdir(), "cum-perf-live-"));
    const now = Date.now();
    const nowDate = new Date(now);
    const STEP_MS = 20_000;
    /** The time of log `i`'s first record: in its month, spread over the month's days (this month: up to now). */
    const baseOf = (i: number, perFile: number): number => {
      const back = LIVE_MONTH_OF[i % LIVE_MONTH_OF.length]!;
      const start = new Date(nowDate.getFullYear(), nowDate.getMonth() - back, 1).getTime();
      const end = back === 0 ? now : new Date(nowDate.getFullYear(), nowDate.getMonth() - back + 1, 1).getTime();
      const room = Math.max(0, end - start - perFile * STEP_MS - 60_000);
      return start + Math.floor((((i * 7919) % 1000) / 1000) * room);
    };
    const iso = (ms: number) => new Date(ms).toISOString();
    /** A log was last written at its last record (never within the last ten minutes: only the live logs are hot). */
    const mtimeOf = (base: number, perFile: number) => Math.min(base + perFile * STEP_MS, now - 10 * 60_000) / 1000;
    const t = performance.now();

    const [copilotLogs, copilotCalls] = LIVE.copilot;
    for (let i = 0; i < copilotLogs; i++) {
      const dir = join(lroot, "copilot", "session-state", lc(i));
      await mkdir(dir, { recursive: true });
      const base = baseOf(i, copilotCalls);
      let s = "";
      for (let k = 0; k < copilotCalls; k++) {
        s += jsonl([usageEvent({ usageId: `lu-${i}-${k}`, id: `le-${i}-${k}`, sourceSessionId: lc(i), sequence: k + 1, model: `model-${(i + k) % 4}`, timestamp: iso(base + k * STEP_MS), initiator: k % 5 === 0 ? "user" : "agent", toolTokenCount: 900, availableToolCount: 30 })]);
      }
      records += copilotCalls;
      const p = join(dir, "events.jsonl");
      await writeFile(p, s);
      if (i === 0) live.copilot = p;
      else await utimes(p, mtimeOf(base, copilotCalls), mtimeOf(base, copilotCalls));
    }

    // Claude Code: 60 project folders, three models, four tool mixes.
    const [claudeLogs, claudeCalls] = LIVE.claude;
    for (let i = 0; i < claudeLogs; i++) {
      const dir = join(lroot, "claude", "projects", `-${CLAUDE_CANARY}-live${i % 60}`);
      if (i < 60) await mkdir(dir, { recursive: true });
      const base = baseOf(i, claudeCalls);
      let s = "";
      for (let k = 0; k < claudeCalls; k++) s += assistants[(i + k) % assistants.length]!(`l${i}_${k}`, ls(i), iso(base + k * STEP_MS), `proj${i % 60}`, CLAUDE_MODELS[(i + k) % CLAUDE_MODELS.length]!);
      records += claudeCalls;
      const p = join(dir, `${ls(i)}.jsonl`);
      await writeFile(p, s);
      if (i === 0) live.claude = p;
      else await utimes(p, mtimeOf(base, claudeCalls), mtimeOf(base, claudeCalls));
    }

    // Codex: each rollout in the date folder of its first record.
    const [codexLogs, codexCalls] = LIVE.codex;
    const files = Array.from({ length: codexLogs }, (_, i) => {
      const base = baseOf(i, codexCalls);
      const d = new Date(base);
      return {
        date: `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`,
        sessionId: lx(i),
        ...(i === 0 ? {} : { mtime: new Date(mtimeOf(base, codexCalls) * 1000) }),
        lines: [
          codexMeta({ id: lx(i), timestamp: iso(base), cwd: `/${CLAUDE_CANARY}/cproj${i % 12}` }),
          codexTurn({ timestamp: iso(base) }),
          ...Array.from({ length: codexCalls }, (_, k) => codexRecord({ sessionId: lx(i), responseId: `lresp_${i}_${k}`, timestamp: iso(base + k * STEP_MS), ordinal: k + 2 })),
        ],
      };
    });
    records += codexLogs * codexCalls;
    live.codex = (await codexTree(join(lroot, "codex"), files))[0]!;
    console.log(`live corpus: ${records} records in ${copilotLogs + claudeLogs + codexLogs} logs, written in ${(performance.now() - t).toFixed(0)}ms`);
  }, 300_000);

  afterAll(async () => {
    await rm(lroot, { recursive: true, force: true });
  });

  it("the tick that picks up an appended line: a new call < 30 ms CPU, a line without one < 8 ms, idle < 5 ms", async () => {
    let last: Snapshot | undefined;
    let snaps = 0;
    const m = new UsageMonitor({
      root: join(lroot, "copilot"),
      rootSource: "default",
      log: new Logger(() => {}),
      onSnapshot: (x) => {
        last = x;
        snaps++;
      },
      readTotals: true,
      readProjects: true,
      historyMonths: 12,
      sources: { claude: { root: join(lroot, "claude"), rootSource: "default" }, codex: { root: join(lroot, "codex"), rootSource: "default" } },
    });
    const t0 = performance.now();
    await m.refresh({ full: true });
    const cold = performance.now() - t0;
    const stored = () => (last?.history ?? []).reduce((a, h) => a + (h.totals?.records ?? 0), 0);
    expect(stored()).toBe(records);
    expect((last?.history ?? []).filter((h) => h.totals !== undefined).length).toBe(LIVE_MONTHS);

    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const tick = async (): Promise<{ cpu: number; wall: number }> => {
      const cpu0 = process.cpuUsage();
      const t = performance.now();
      await m.refresh();
      const wall = performance.now() - t;
      const c = process.cpuUsage(cpu0);
      return { cpu: (c.user + c.system) / 1000, wall };
    };
    /** One more call in a live log: Claude Code, Codex and Copilot in turn. */
    const append = async (n: number): Promise<void> => {
      const ts = new Date().toISOString();
      const which = n % 3;
      if (which === 0) await appendFile(live.claude, assistants[n % assistants.length]!(`live-${n}`, ls(0), ts, "proj0", CLAUDE_MODELS[n % CLAUDE_MODELS.length]!));
      else if (which === 1) await appendFile(live.codex, `${codexRecord({ sessionId: lx(0), responseId: `lresp_live_${n}`, timestamp: ts, ordinal: 1000 + n })}\n`);
      else await appendFile(live.copilot, jsonl([usageEvent({ usageId: `lu-live-${n}`, id: `le-live-${n}`, sourceSessionId: lc(0), sequence: 1000 + n, timestamp: ts })]));
    };
    // Three unmeasured appends (first-run compilation), then the first read's garbage is collected.
    for (let n = 0; n < 3; n++) {
      await append(n);
      await m.refresh();
    }
    (globalThis as { gc?: () => void }).gc?.();
    await new Promise((r) => setTimeout(r, 100));

    const cpus: number[] = [];
    const walls: number[] = [];
    const bySource: number[][] = [[], [], []];
    const APPENDS = 21;
    for (let n = 3; n < 3 + APPENDS; n++) {
      await append(n);
      const before = snaps;
      const s = await tick();
      // Every appended call is in the very next snapshot.
      expect(snaps).toBe(before + 1);
      expect(stored()).toBe(records + n + 1);
      cpus.push(s.cpu);
      walls.push(s.wall);
      bySource[n % 3]!.push(s.cpu);
    }
    // A line that adds no call (a tool result in the live Claude Code log): the session's
    // activity counters change, so the snapshot is rebuilt, with the same records.
    const quiet: number[] = [];
    const calls = stored();
    for (let i = 0; i < 9; i++) {
      await appendFile(live.claude, `${claudeUserLine({ sessionId: ls(0) })}\n`);
      quiet.push((await tick()).cpu);
      expect(stored()).toBe(calls);
    }
    // A rebuild with nothing read at all (a pin change; like the once-a-minute refresh of the prior-month comparison).
    const rebuilds: number[] = [];
    for (let i = 0; i < 9; i++) {
      const cpu0 = process.cpuUsage();
      m.pin(undefined);
      await m.refresh();
      const c = process.cpuUsage(cpu0);
      rebuilds.push((c.user + c.system) / 1000);
    }
    const idle0 = process.cpuUsage();
    for (let i = 0; i < 20; i++) await m.refresh();
    const idleCpu = process.cpuUsage(idle0);
    const idle = (idleCpu.user + idleCpu.system) / 1000 / 20;
    const f = (xs: number[]) => xs.map((x) => x.toFixed(1)).join(", ");
    console.log(
      `live append: cold ${cold.toFixed(0)}ms for ${records} records; a new call: median ${median(cpus).toFixed(1)}ms cpu, ${median(walls).toFixed(1)}ms wall ` +
        `(claude ${median(bySource[0]!).toFixed(1)}, codex ${median(bySource[1]!).toFixed(1)}, copilot ${median(bySource[2]!).toFixed(1)}ms cpu; all [${f(cpus)}]); ` +
        `a line without a call: median ${median(quiet).toFixed(1)}ms cpu of [${f(quiet)}]; ` +
        `a rebuild with nothing read: median ${median(rebuilds).toFixed(1)}ms cpu of [${f(rebuilds)}]; idle ${idle.toFixed(2)}ms cpu per tick`,
    );
    expect(JSON.stringify(last)).not.toContain(CLAUDE_CANARY);
    // Before results were kept between snapshots each of the three cost a whole rebuild: about
    // 105 ms on this store (2026-11-09, the machine that then measured 21, 4.6 and 4.6 ms).
    expect(median(cpus)).toBeLessThan(30);
    expect(median(quiet)).toBeLessThan(8);
    expect(median(rebuilds)).toBeLessThan(8);
    expect(idle).toBeLessThan(5);
    m.dispose();
  }, 300_000);
});
