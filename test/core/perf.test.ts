// Performance budget (plan Task 9 / AC8). Runs only under PERF=1:
//   npm run test:perf   (add NODE_OPTIONS=--expose-gc for the heap check)
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import type { Snapshot } from "../../src/core/types";
import { CANARY, jsonl, otherEvent, shutdownEvent, usageEvent } from "../fixtures/build";

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
