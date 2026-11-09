// Review finding #5: a discovery that fails at the root for a reason other than a missing
// folder or a permission error (EIO, EMFILE...) must not leave totals looking complete. The
// last good figures stay, the source is marked partial (discoveryFailed) and the state
// clears when a discovery succeeds again; a missing root stays "not found", not a failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/log";
import { ClaudeSourceReader } from "../../src/core/claude";
import { UsageMonitor } from "../../src/core/monitor";
import { emptyReadResult, type SourceReader } from "../../src/core/source";
import type { Snapshot } from "../../src/core/types";
import { sourcesHealthBox } from "../../src/core/panel/sources";
import { healthBox } from "../../src/core/panel/health";
import { partialReasons } from "../../src/core/panel/shared";
import { currentTargetStatus } from "../../src/core/format";
import { jsonl, sessionTree, usageEvent } from "../fixtures/build";
import { claudeAssistantLine, claudeTree } from "../fixtures/claude";

const A = "0000aaaa-0000-4000-8000-000000000001";
const T0 = new Date(2026, 10, 8, 12, 0, 0).getTime();
const HOT = T0 - 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const cs = (n: number) => `c1a0de00-0000-4000-8000-${String(n).padStart(12, "0")}`;

const pRec = (n: number) => usageEvent({ usageId: `u-${n}`, id: `e-${n}`, sourceSessionId: A, timestamp: iso(T0 - 3_600_000 + n * 1000) });
const cRec = (session: string, n: number) =>
  claudeAssistantLine({ id: `msg_${n}`, requestId: `req_${n}`, sessionId: session, timestamp: iso(T0 - 3_600_000 + n * 1000) });

let dir: string;
let copilotRoot: string;
let claudeRoot: string;
let clock: number;
let snaps: Snapshot[];
let logLines: string[];
let monitor: UsageMonitor | undefined;

function make(extra: Partial<ConstructorParameters<typeof UsageMonitor>[0]> = {}): UsageMonitor {
  monitor = new UsageMonitor({
    root: copilotRoot,
    rootSource: "default",
    now: () => new Date(clock),
    isLive: () => false,
    log: new Logger((l) => logLines.push(l)),
    onSnapshot: (s) => snaps.push(s),
    ...extra,
  });
  return monitor;
}

const last = (): Snapshot => {
  const s = snaps.at(-1);
  if (!s) throw new Error("no snapshot");
  return s;
};

const eio = (): Error => Object.assign(new Error("EIO"), { code: "EIO" });

/** readdir of the Copilot session-state folder throws EIO while `fail.on` is true. */
function failSessionState(fail: { on: boolean }): void {
  const real = fs.promises.readdir.bind(fs.promises);
  vi.spyOn(fs.promises, "readdir").mockImplementation(((p: fs.PathLike, o?: unknown) => {
    if (fail.on && String(p) === join(copilotRoot, "session-state")) return Promise.reject(eio());
    return (real as (p: fs.PathLike, o?: unknown) => Promise<unknown>)(p, o);
  }) as typeof fs.promises.readdir);
}

/** A real Claude Code reader whose discovery reports OTHER while `fail.on` is true. */
function flakyClaude(fail: { on: boolean }, calls: { n: number }): SourceReader {
  const real = new ClaudeSourceReader({ root: claudeRoot, rootSource: "default", readProjects: false });
  return {
    source: real.source,
    root: real.root,
    rootSource: real.rootSource,
    rootDirMtime: () => real.rootDirMtime(),
    pathAllowed: (p) => real.pathAllowed(p),
    open: (p, c) => real.open(p, c),
    discover: async (w, d, n) => {
      calls.n++;
      return fail.on ? { ok: false, error: "OTHER" } : real.discover(w, d, n);
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cum-dischealth-"));
  copilotRoot = join(dir, "copilot");
  claudeRoot = join(dir, "claude");
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

describe("root discovery failures (finding #5)", () => {
  it("first load: an EIO on the root listing is partial, not ordinary no-data", async () => {
    await sessionTree(copilotRoot, [{ id: A, lines: jsonl([pRec(1)]), mtime: new Date(HOT) }]);
    const fail = { on: true };
    failSessionState(fail);
    make();
    await monitor!.refresh({ full: true });
    const h = last().health;
    expect(last().today).toBeUndefined();
    expect(h.partial).toBe(true);
    // A failed listing is no unreadable log (Codex review of PR #22): partial says it on its own.
    expect(h.unreadableFiles).toBe(0);
    expect(h.sources?.copilot).toMatchObject({ discoveryFailed: true, unreadableFiles: 0 });
    expect(h.sources?.copilot?.state).not.toBe("no-dir");
    expect(sourcesHealthBox(last())).toContain("could not be listed");
    expect(logLines.filter((l) => l === "error discover OTHER")).toHaveLength(1);

    // Recovery clears the failure and reads the data.
    fail.on = false;
    await monitor!.refresh({ full: true });
    expect(last().today?.records).toBe(1);
    expect(last().health.partial).toBe(false);
    expect(last().health.unreadableFiles).toBe(0);
    expect(last().health.sources?.copilot?.discoveryFailed).toBeUndefined();
  });

  it("after a good scan: the last figures stay, marked partial, until a discovery succeeds", async () => {
    await sessionTree(copilotRoot, [{ id: A, lines: jsonl([pRec(1), pRec(2)]), mtime: new Date(HOT) }]);
    const fail = { on: false };
    failSessionState(fail);
    make();
    await monitor!.refresh({ full: true });
    expect(last().today?.records).toBe(2);
    expect(last().health.partial).toBe(false);

    fail.on = true;
    await monitor!.refresh({ full: true });
    expect(last().today?.records).toBe(2);
    expect(last().health.partial).toBe(true);
    expect(last().health.sources?.copilot).toMatchObject({ discoveryFailed: true, unreadableFiles: 0, sessions: 1 });
    expect(last().health.state).toBe("ok");

    fail.on = false;
    await monitor!.refresh({ full: true });
    expect(last().today?.records).toBe(2);
    expect(last().health.partial).toBe(false);
    expect(last().health.sources?.copilot?.discoveryFailed).toBeUndefined();
  });

  it("a failure repeated on every tick marks the snapshot changed only when it starts and ends", async () => {
    await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1)], mtime: HOT }]);
    const fail = { on: false };
    const calls = { n: 0 };
    make({ readers: [flakyClaude(fail, calls)] });
    await monitor!.refresh({ full: true });
    expect(last().today?.records).toBe(1);

    fail.on = true;
    await monitor!.refresh({ full: true });
    expect(last().health.sources?.["claude-code"]?.discoveryFailed).toBe(true);
    const built = snaps.length;
    const before = calls.n;
    // Ticks across several cold rediscoveries: each fails the same way and rebuilds nothing.
    for (let i = 0; i < 300; i++) {
      clock += 500;
      await monitor!.refresh();
    }
    expect(calls.n).toBeGreaterThan(before);
    expect(snaps.length).toBe(built);
    expect(logLines.filter((l) => l === "error discover OTHER")).toHaveLength(1);

    // Recovery is a transition: one rebuild, the flag cleared, figures intact.
    fail.on = false;
    clock += 60_000;
    await monitor!.refresh();
    expect(snaps.length).toBe(built + 1);
    expect(last().health.sources?.["claude-code"]?.discoveryFailed).toBeUndefined();
    expect(last().health.partial).toBe(false);
    expect(last().today?.records).toBe(1);
  });

  it("a missing root (ENOENT) stays 'not found', not a discovery failure", async () => {
    make({ sources: { claude: { root: claudeRoot, rootSource: "default" } } });
    await monitor!.refresh({ full: true });
    const h = last().health;
    expect(h.state).toBe("no-dir");
    expect(h.partial).toBe(false);
    expect(h.sources?.copilot?.state).toBe("no-dir");
    expect(h.sources?.copilot?.discoveryFailed).toBeUndefined();
    expect(h.sources?.["claude-code"]?.state).toBe("no-dir");
    expect(h.sources?.["claude-code"]?.discoveryFailed).toBeUndefined();
    expect(logLines).not.toContain("error discover OTHER");
  });
});

/** A real Claude Code reader whose discovery returns `mode.next` (undefined = the real walk), and
 * whose rootDirMtime() fails while `mode.dirFails` is set. Records each discover's options. */
function scriptedClaude(
  mode: { next?: "no-dir" | "permission" | "OTHER"; dirFails?: boolean },
  calls: { n: number; opts: unknown[] },
): SourceReader {
  const real = new ClaudeSourceReader({ root: claudeRoot, rootSource: "default", readProjects: false });
  return {
    source: real.source,
    root: real.root,
    rootSource: real.rootSource,
    rootDirMtime: () => (mode.dirFails ? Promise.resolve(undefined) : real.rootDirMtime()),
    pathAllowed: (p) => real.pathAllowed(p),
    open: (p, c) => real.open(p, c),
    discover: async (w, d, n, o) => {
      calls.n++;
      calls.opts.push(o);
      return mode.next !== undefined ? { ok: false, error: mode.next } : real.discover(w, d, n);
    },
  };
}

describe("discovery failure after a root error (review C, U, D)", () => {
  for (const before of ["no-dir", "permission"] as const) {
    it(`${before} then OTHER: the row says the folder could not be listed, and idle ticks stay cheap`, async () => {
      const mode: { next?: "no-dir" | "permission" | "OTHER"; dirFails?: boolean } = { next: before };
      const calls = { n: 0, opts: [] as unknown[] };
      make({ readers: [scriptedClaude(mode, calls)] });
      await monitor!.refresh({ full: true });
      expect(last().health.sources?.["claude-code"]?.state).toBe(before);

      mode.next = "OTHER";
      await monitor!.refresh({ full: true });
      const h = last().health.sources?.["claude-code"];
      expect(h?.discoveryFailed).toBe(true);
      expect(h?.state).not.toBe("no-dir");
      expect(h?.state).not.toBe("permission");
      const box = sourcesHealthBox(last());
      expect(box).toContain("could not be listed");
      expect(box).not.toContain("Folder not found");
      expect(box).not.toContain("Unreadable (");
      expect(last().health.partial).toBe(true);
      // The row tests the failure before the folder state, whatever state a health carries.
      const stale = { ...last(), health: { ...last().health, sources: { "claude-code": { ...h!, state: before } } } };
      expect(sourcesHealthBox(stale)).toContain("could not be listed");

      // Idle ticks within the 10 s cadence neither rediscover nor rebuild the snapshot.
      const built = snaps.length;
      const n = calls.n;
      for (let i = 0; i < 9; i++) {
        clock += 1000;
        await monitor!.refresh();
      }
      expect(calls.n).toBe(n);
      expect(snaps.length).toBe(built);
    });
  }

  it("a failed discovery is retried at the 10 s cadence even when the directory check also fails", async () => {
    await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1)], mtime: HOT }]);
    const mode: { next?: "no-dir" | "permission" | "OTHER"; dirFails?: boolean } = { next: "OTHER", dirFails: true };
    const calls = { n: 0, opts: [] as unknown[] };
    make({ readers: [scriptedClaude(mode, calls)] });
    await monitor!.refresh({ full: true });
    expect(last().health.sources?.["claude-code"]?.discoveryFailed).toBe(true);

    mode.next = undefined;
    // Not every tick...
    const n = calls.n;
    clock += 5000;
    await monitor!.refresh();
    expect(calls.n).toBe(n);
    // ...but well before the 60 s cold cycle.
    clock += 6000;
    await monitor!.refresh();
    expect(calls.n).toBe(n + 1);
    expect(last().health.sources?.["claude-code"]?.discoveryFailed).toBeUndefined();
    expect(last().today?.records).toBe(1);
  });

  it("a full refresh passes the full hint to discover; a tick does not", async () => {
    const mode: { next?: "no-dir" | "permission" | "OTHER"; dirFails?: boolean } = {};
    const calls = { n: 0, opts: [] as unknown[] };
    make({ readers: [scriptedClaude(mode, calls)] });
    await monitor!.refresh({ full: true });
    expect(calls.opts.at(-1)).toEqual({ full: true });
    clock += 61_000;
    await monitor!.refresh();
    expect(calls.n).toBe(2);
    expect(calls.opts.at(-1)).toEqual({ full: false });
  });

  it("permission, then OTHER, then recovery: a file whose read failed is re-read without a manual refresh", async () => {
    // Inactive file: not hot, so only a change mark gets it read again.
    await claudeTree(claudeRoot, [{ sessionId: cs(1), lines: [cRec(cs(1), 1)], mtime: T0 - 2 * 3_600_000 }]);
    const mode: { next?: "no-dir" | "permission" | "OTHER"; dirFails?: boolean } = {};
    const calls = { n: 0, opts: [] as unknown[] };
    const readFails = { on: false };
    const base = scriptedClaude(mode, calls);
    const reader: SourceReader = {
      ...base,
      open: (p, c) => {
        const r = base.open(p, c);
        return { read: () => (readFails.on ? Promise.resolve({ ...emptyReadResult(), error: "EACCES" as const }) : r.read()) };
      },
    };
    make({ readers: [reader] });
    // 1. Read OK.
    await monitor!.refresh({ full: true });
    expect(last().today?.records).toBe(1);
    expect(last().health.partial).toBe(false);

    // 2. A directory permission failure: the root error re-reads the file once, and that read fails.
    mode.next = "permission";
    readFails.on = true;
    await monitor!.refresh({ full: true });
    expect(last().health.sources?.["claude-code"]?.state).toBe("permission");
    expect(last().health.unreadableFiles).toBe(1);

    // 3. Discovery then fails otherwise.
    mode.next = "OTHER";
    await monitor!.refresh({ full: true });
    expect(last().health.sources?.["claude-code"]?.discoveryFailed).toBe(true);

    // 4. Access recovers; size and mtime are unchanged. Ticks only, no manual refresh.
    mode.next = undefined;
    readFails.on = false;
    clock += 11_000;
    await monitor!.refresh();
    clock += 1000;
    await monitor!.refresh();
    const h = last().health;
    expect(h.sources?.["claude-code"]?.discoveryFailed).toBeUndefined();
    expect(h.sources?.["claude-code"]?.unreadableFiles).toBe(0);
    expect(h.unreadableFiles).toBe(0);
    expect(h.partial).toBe(false);
    expect(last().today?.records).toBe(1);

    // Idle ticks afterwards stay cheap: no rediscovery within the cadence, no rebuild.
    const built = snaps.length;
    const n = calls.n;
    for (let i = 0; i < 5; i++) {
      clock += 1000;
      await monitor!.refresh();
    }
    expect(calls.n).toBe(n);
    expect(snaps.length).toBe(built);
  });
});

describe("Codex review of PR #22: a failed root listing is not an unreadable log", () => {
  it("Data health shows the folder as its own fact, 'Unreadable logs' stays 0, the read is partial and the target starred", async () => {
    await sessionTree(copilotRoot, [{ id: A, lines: jsonl([pRec(1)]), mtime: new Date(HOT) }]);
    const fail = { on: true };
    failSessionState(fail);
    make();
    await monitor!.refresh({ full: true });
    const s = last();
    expect(s.health.partial).toBe(true);
    expect(s.health.unreadableFiles).toBe(0);
    expect(s.health.sources?.copilot).toMatchObject({ discoveryFailed: true, unreadableFiles: 0 });
    const box = healthBox(s);
    expect(box).toContain('<span>Unreadable logs</span><span class="num">0</span>');
    expect(box).toContain('<span>Log folders that could not be listed</span><span class="num star">1</span>');
    const src = sourcesHealthBox(s);
    expect(src).toContain('<span>Unreadable logs</span><span class="num">0</span>');
    expect(src).toContain('<span>Folder listings that failed</span><span class="num star">1</span>');
    expect(partialReasons(s.health)).toBe("Totals may be incomplete: a log folder could not be listed; new sessions may be missing.");
    expect(currentTargetStatus(s, { unit: "cost", range: { max: 60 } })).toEqual({ state: "in", partial: true });
  });
});
