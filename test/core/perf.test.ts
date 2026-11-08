// Performance budget (plan Task 9 / AC8). Runs only under PERF=1:
//   npm run test:perf   (the script sets NODE_OPTIONS=--expose-gc, so the heap checks run with gc)
import { statSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
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
      if (i % 100 === 50) parts.push(huge);
      for (let k = 0; k < 12; k++) {
        line++;
        if (line % 100 === 0) {
          parts.push(Buffer.from(assistant(`a${line}`, cs(i), ts)));
          assistants++;
        } else parts.push(content[line % content.length]!);
      }
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
      mtime: cold,
      lines: [codexMeta({ id: xs(i), timestamp: ts }), codexTurn({ timestamp: ts }), ...Array.from({ length: 50 }, (_, k) => codexRecord({ sessionId: xs(i), responseId: `resp_${i}_${k}`, timestamp: ts, ordinal: k + 2 }))],
    }));
    for (const p of await codexTree(codexRoot, files)) bytes += statSync(p).size;
    console.log(`sources corpus: ${(bytes / 1e6).toFixed(0)} MB, ${assistants} assistant lines, written in ${(performance.now() - t).toFixed(0)}ms`);
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
