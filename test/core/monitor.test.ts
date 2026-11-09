import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { parseUsageLine } from "../../src/core/extract";
import type { Snapshot } from "../../src/core/types";
import { renderPanelHtml, SECTIONS } from "../../src/core/panelHtml";
import { statusText, tooltipMarkdown } from "../../src/core/format";
import {
  CANARY,
  jsonl,
  otherEvent,
  sessionTree,
  shutdownEvent,
  usageEvent,
} from "../fixtures/build";

const A = "0000aaaa-0000-4000-8000-000000000001";
const B = "0000bbbb-0000-4000-8000-000000000002";
const C = "0000cccc-0000-4000-8000-000000000003";

const LIVE_PID = 4242;
const DEAD_PID = 9999;
const isLive = (pid: number) => pid === LIVE_PID;

// A fixed day in the past, so every real file mtime counts as "today" for discover.
const T0 = new Date(2026, 0, 15, 10, 0, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 0, 15, h, m, 0).toISOString();

/** A usage event of session `folder`, recorded at `ts`, with a unique key `n`. */
function rec(folder: string, n: number, ts = at(9, n % 60)): object {
  return usageEvent({
    usageId: `u-${folder.slice(4, 8)}-${n}`,
    id: `e-${n}`,
    sourceSessionId: folder,
    timestamp: ts,
  });
}

const turnEnd = () => otherEvent("assistant.turn_end", { timestamp: at(9) });

let root: string;
let clock: number;
let snaps: Snapshot[];
let logLines: string[];
let monitor: UsageMonitor;

function make(
  extra: Partial<ConstructorParameters<typeof UsageMonitor>[0]> = {},
): UsageMonitor {
  monitor = new UsageMonitor({
    root,
    rootSource: "default",
    now: () => new Date(clock),
    isLive,
    log: new Logger((l) => logLines.push(l)),
    onSnapshot: (s) => snaps.push(s),
    ...extra,
  });
  return monitor;
}

const events = (id: string) => join(root, "session-state", id, "events.jsonl");
const last = (): Snapshot => {
  const s = snaps.at(-1);
  if (!s) throw new Error("no snapshot");
  return s;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cum-monitor-"));
  clock = T0;
  snaps = [];
  logLines = [];
});

afterEach(async () => {
  monitor?.dispose();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await chmod(join(root, "session-state"), 0o755).catch(() => undefined);
  for (const id of [A, B, C])
    await chmod(events(id), 0o644).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("UsageMonitor", () => {
  it("restart rescan: reads existing lines on the first full refresh", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1), rec(A, 2)]) }]);
    make();
    expect(snaps).toHaveLength(0); // does not refresh on construction
    await monitor.refresh({ full: true });
    expect(last().today?.records).toBe(2);
    expect(last().health.state).toBe("ok");
    expect(last().health.rootSource).toBe("default");
    expect(last().dayStartMs).toBe(new Date(2026, 0, 15).getTime());
  });

  it("incremental: one appended line → 3 records, exactly one new snapshot", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1), rec(A, 2)]) }]);
    make();
    await monitor.refresh({ full: true });
    await monitor.refresh();
    expect(snaps).toHaveLength(1); // nothing changed, nothing emitted
    await appendFile(events(A), jsonl([rec(A, 3)]));
    await monitor.refresh();
    expect(snaps).toHaveLength(2);
    expect(last().today?.records).toBe(3);
  });

  it("partial line waits for its newline", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    make();
    await monitor.refresh({ full: true });
    const line = jsonl([rec(A, 2)]);
    await appendFile(events(A), line.slice(0, 40));
    await monitor.refresh();
    expect(last().today?.records).toBe(1);
    expect(last().health.partial).toBe(false);
    await appendFile(events(A), line.slice(40));
    await monitor.refresh();
    expect(last().today?.records).toBe(2);
  });

  it("duplicate events count once", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    make();
    await monitor.refresh({ full: true });
    await appendFile(events(A), jsonl([rec(A, 2), rec(A, 2), rec(A, 1)]));
    await monitor.refresh();
    expect(last().today?.records).toBe(2);
  });

  it("new live session becomes current", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1, at(9, 50))]), lockPid: LIVE_PID },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().current).toMatchObject({
      folderId: A,
      live: true,
      pinned: false,
    });
    await sessionTree(root, [
      { id: B, lines: jsonl([rec(B, 1, at(9, 55))]), lockPid: LIVE_PID },
    ]);
    await monitor.refresh();
    expect(last().current).toMatchObject({
      folderId: B,
      live: true,
      pinned: false,
    });
    expect(last().current?.totals?.records).toBe(1);
    expect(last().today?.records).toBe(2);
    expect(last().sessions.map((s) => s.folderId)).toEqual([B, A]);
  });

  it("current falls back to the newest ended session; pin and unpin", async () => {
    await sessionTree(root, [
      {
        id: A,
        lines: jsonl([rec(A, 1, at(9, 0)), rec(A, 2, at(9, 1))]),
        lockPid: DEAD_PID,
      },
      { id: B, lines: jsonl([rec(B, 1, at(9, 30))]), lockPid: DEAD_PID },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().current).toMatchObject({
      folderId: B,
      live: false,
      pinned: false,
    });
    expect(last().current?.totals?.records).toBe(1);
    monitor.pin(A);
    await monitor.refresh();
    expect(last().current).toMatchObject({
      folderId: A,
      live: false,
      pinned: true,
    });
    expect(last().current?.totals?.records).toBe(2);
    monitor.pin(undefined);
    await monitor.refresh();
    expect(last().current).toMatchObject({ folderId: B, pinned: false });
  });

  it("truncation: today matches the rewritten file", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1), rec(A, 2), rec(A, 3)]) },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().today?.records).toBe(3);
    await writeFile(events(A), jsonl([rec(A, 7)]));
    await monitor.refresh();
    expect(last().today?.records).toBe(1);
  });

  it("format-changed health on an unrecognized usage line, earlier records still counted", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    make();
    await monitor.refresh({ full: true });
    const odd = {
      type: "session.usage_record",
      id: "e-x",
      timestamp: at(9, 5),
      data: { usage: { tokens: {} } },
    };
    await appendFile(events(A), jsonl([odd]));
    await monitor.refresh();
    expect(last().health).toMatchObject({
      state: "format-changed",
      unrecognized: 1,
    });
    expect(last().today?.records).toBe(1);
  });

  it("silent live session flags format change", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1)]) },
      { id: B, lines: "", lockPid: LIVE_PID },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().health.state).toBe("ok");
    await appendFile(events(B), jsonl([turnEnd(), turnEnd()]));
    await monitor.refresh();
    expect(last().health.state).toBe("ok");
    await appendFile(events(B), jsonl([turnEnd()]));
    await monitor.refresh();
    expect(last().health.state).toBe("format-changed");
    expect(last().health.unrecognized).toBe(0);
  });

  it("activity delivered by the first read never flags format change", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1)]) },
      {
        id: B,
        lines: jsonl([turnEnd(), turnEnd(), turnEnd()]),
        lockPid: LIVE_PID,
      },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({
      state: "ok",
      sessionsWithoutUsage: 1,
    });
  });

  it("stale legacy session never flags format change", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1)]) },
      {
        id: B,
        lines: jsonl([1, 2, 3, 4, 5].map(turnEnd)),
        lockPid: DEAD_PID,
        mtime: new Date(T0 - 60_000),
      },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({
      state: "ok",
      sessionsWithoutUsage: 1,
    });
  });

  it("legacy only, empty session totals: no-data, today undefined", async () => {
    await sessionTree(root, [
      {
        id: A,
        lines: jsonl([
          turnEnd(),
          turnEnd(),
          shutdownEvent({ models: {}, timestamp: at(9) }),
        ]),
      },
    ]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({ state: "no-data", unrecognized: 0, sessionsWithoutUsage: 1, sessionsFromTotals: 0 });
    expect(last().today).toBeUndefined();
  });

  it("unreadable file marks partial; the other log is still counted", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1)]) },
      { id: B, lines: jsonl([rec(B, 1)]) },
    ]);
    await chmod(events(B), 0o000);
    make();
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({
      partial: true,
      unreadableFiles: 1,
      state: "ok",
    });
    expect(last().today?.records).toBe(1);
    await chmod(events(B), 0o644);
    await monitor.refresh();
    expect(last().health).toMatchObject({ partial: false, unreadableFiles: 0 });
    expect(last().today?.records).toBe(2);
  });

  it("malformed gated line marks partial", async () => {
    const garbage = `{"type":"session.usage_record","id":{"type":"assistant.turn_end"}\n`;
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) + garbage }]);
    make();
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({ partial: true, malformed: 1 });
    expect(last().today?.records).toBe(1);
  });

  it("an over-long non-usage line is reported but does not mark partial", async () => {
    const big = `{"type":"tool.execution_complete","data":{"text":"${"z".repeat(1_100_000)}"}}\n`;
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) + big + jsonl([rec(A, 2)]) }]);
    make();
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({ partial: false, overlong: 0, overlongOther: 1 });
    expect(last().today?.records).toBe(2);
  });

  it("an over-long usage line marks partial", async () => {
    const big = `{"type":"session.usage_record","data":{"text":"${"z".repeat(1_100_000)}"}}\n`;
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) + big }]);
    make();
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({ partial: true, overlong: 1, overlongOther: 0 });
  });

  it("no-dir recovers to ok after the folder appears", async () => {
    make();
    await monitor.refresh({ full: true });
    expect(last().health.state).toBe("no-dir");
    expect(last().today).toBeUndefined();
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    await monitor.refresh();
    expect(last().health.state).toBe("ok");
    expect(last().today?.records).toBe(1);
  });

  it("permission recovers to ok after the folder is readable", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    await chmod(join(root, "session-state"), 0o000);
    make();
    await monitor.refresh({ full: true });
    expect(last().health.state).toBe("permission");
    await chmod(join(root, "session-state"), 0o755);
    await monitor.refresh();
    expect(last().health.state).toBe("ok");
    expect(last().today?.records).toBe(1);
  });

  it("rediscovers after 10 s without a session-state change", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    make();
    const statSpy = vi.spyOn(fs.promises, "stat");
    const readdirSpy = vi.spyOn(fs.promises, "readdir");
    await monitor.refresh({ full: true });
    const listed = readdirSpy.mock.calls.length;
    await monitor.refresh();
    expect(readdirSpy.mock.calls.length).toBe(listed); // mtime unchanged, < 10 s
    expect(statSpy).toHaveBeenCalled();
    clock += 10_000;
    await monitor.refresh();
    expect(readdirSpy.mock.calls.length).toBeGreaterThan(listed);
  });

  it("day change re-snapshots and keeps current", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1), rec(A, 2)]), lockPid: LIVE_PID },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().current?.totals?.records).toBe(2);
    const before = snaps.length;
    clock = new Date(2026, 0, 16, 0, 0, 5).getTime();
    await monitor.refresh();
    expect(snaps.length).toBe(before + 1);
    expect(last().dayStartMs).toBe(new Date(2026, 0, 16).getTime());
    expect(last().today).toBeUndefined();
    expect(last().health.state).toBe("no-data");
    expect(last().current).toMatchObject({ folderId: A, live: true });
    expect(last().current?.totals?.records).toBe(2);
  });

  it("projectNames on: opens events.jsonl, plus workspace.yaml only for ID-named projects", async () => {
    const ID = "a5ba938d-3495-450d-94f0-cdab4c64c501";
    const startEv = (cwd: string) => ({ type: "session.start", id: "s", parentId: null, timestamp: at(8), data: { context: { cwd }, prompt: CANARY } });
    await sessionTree(root, [
      { id: A, lines: jsonl([startEv(`/srv/${ID}`), rec(A, 1)]) },
      { id: B, lines: jsonl([startEv("/srv/tools-cli"), rec(B, 2)]) },
      { id: C, lines: jsonl([rec(C, 3)]) },
    ]);
    for (const id of [A, B, C]) {
      const dir = join(root, "session-state", id);
      await writeFile(join(dir, "workspace.yaml"), `name: Title ${id.slice(4, 8)}\n`);
      for (const name of ["config.json", "session.db", "vscode.metadata.json"])
        await writeFile(join(dir, name), CANARY);
    }
    const open = vi.spyOn(fs.promises, "open");
    const readFile = vi.spyOn(fs.promises, "readFile");
    const openSync = vi.spyOn(fsModule, "openSync");
    const readFileSync = vi.spyOn(fsModule, "readFileSync");
    syncBuiltinESMExports();
    make({ readProjects: true });
    await monitor.refresh({ full: true });
    expect(last().month?.projects.find((p) => p.name === ID)?.label).toBe("Title aaaa");
    const opened = open.mock.calls.map((c) => String(c[0]).slice(root.length));
    const evs = opened.filter((p) => /^\/session-state\/[0-9a-f-]+\/events\.jsonl$/.test(p));
    const others = opened.filter((p) => !evs.includes(p));
    expect(new Set(evs).size).toBe(3);
    expect(others).toEqual([`/session-state/${A}/workspace.yaml`]);
    expect(readFile).not.toHaveBeenCalled();
    expect(openSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("projectNames off: reads only events.jsonl", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1)]), lockPid: LIVE_PID },
      { id: B, lines: jsonl([turnEnd()]) },
    ]);
    for (const id of [A, B]) {
      const dir = join(root, "session-state", id);
      for (const name of [
        "config.json",
        "session.db",
        "workspace.yaml",
        "inuse.1.lock",
      ]) {
        await writeFile(join(dir, name), CANARY);
      }
    }
    await mkdir(join(root, "session-state", "not-a-session"), {
      recursive: true,
    });
    await writeFile(join(root, "config.json"), CANARY);
    const open = vi.spyOn(fs.promises, "open");
    const readFile = vi.spyOn(fs.promises, "readFile");
    // ESM namespaces cannot be spied on: patch the CommonJS object and sync the
    // named exports, so `fs.openSync` seen through `import * as fs` is the spy.
    const openSync = vi.spyOn(fsModule, "openSync");
    const readFileSync = vi.spyOn(fsModule, "readFileSync");
    syncBuiltinESMExports();
    expect(fs.openSync).toBe(openSync);
    make();
    await monitor.refresh({ full: true });
    await appendFile(events(A), jsonl([rec(A, 2)]));
    await monitor.refresh();
    expect(last().today?.records).toBe(2);
    const opened = open.mock.calls.map((c) => String(c[0]));
    expect(opened.length).toBeGreaterThan(0);
    for (const p of opened)
      expect(p).toMatch(/session-state\/[0-9a-f-]+\/events\.jsonl$/);
    expect(readFile).not.toHaveBeenCalled();
    expect(openSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("an exception never leaks its message and the monitor keeps working", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    let fail = true;
    make({
      parse: (line, folderId) => {
        if (fail) throw new Error(CANARY);
        return parseUsageLine(line, folderId);
      },
    });
    await monitor.refresh({ full: true });
    expect(logLines).toContain("error refresh EXCEPTION");
    expect(logLines.join("\n")).not.toContain(CANARY);
    fail = false;
    await appendFile(events(A), jsonl([rec(A, 2)]));
    await monitor.refresh();
    expect(snaps.length).toBeGreaterThan(0);
    expect(last().today?.records).toBe(1);
  });

  it("logs a sanitised err.code", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    make({
      parse: () => {
        throw Object.assign(new Error(CANARY), { code: "ENOMEM" });
      },
    });
    await monitor.refresh({ full: true });
    expect(logLines).toContain("error refresh ENOMEM");
    expect(logLines.join("\n")).not.toContain(CANARY);
  });

  it("serialises concurrent refreshes: one more run follows a busy one", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]), lockPid: LIVE_PID }]);
    const reads = vi.spyOn(fs.promises, "open");
    const during: Promise<void>[] = [];
    let first = true;
    make({
      // Called by discover inside the first run: both calls arrive while it is busy.
      isLive: (pid) => {
        if (first) {
          first = false;
          during.push(monitor.refresh(), monitor.refresh());
        }
        return isLive(pid);
      },
    });
    const p1 = monitor.refresh({ full: true });
    await p1;
    expect(during).toHaveLength(2);
    expect(reads.mock.calls.length).toBe(1); // the queued run has not run yet
    await Promise.all(during);
    // the queued run reads A once more; the third call joined it.
    expect(reads.mock.calls.length).toBe(2);
    expect(during[0]).toBe(during[1]);
    expect(last().today?.records).toBe(1);
    expect(snaps).toHaveLength(1);
  });

  it("no snapshot after dispose", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    make();
    const p = monitor.refresh({ full: true });
    monitor.dispose();
    await p;
    await monitor.refresh({ full: true });
    expect(snaps).toHaveLength(0);
  });

  it("month window: earlier-this-month logs feed the month view, never live, never today", async () => {
    const jan10 = new Date(2026, 0, 10, 12, 0, 0);
    const dec20 = new Date(2025, 11, 20, 12, 0, 0);
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1)]) },
      { id: B, lines: jsonl([rec(B, 2, jan10.toISOString())]), lockPid: LIVE_PID, mtime: jan10 },
      { id: C, lines: jsonl([rec(C, 3, dec20.toISOString())]), mtime: dec20 },
    ]);
    make();
    await monitor.refresh({ full: true });
    const s = last();
    expect(s.today!.records).toBe(1);
    expect(s.month!.monthStartMs).toBe(new Date(2026, 0, 1).getTime());
    expect(s.month!.totals!.records).toBe(2);
    expect(s.month!.days).toHaveLength(15);
    expect(s.month!.days[9]!.totals!.records).toBe(1);
    expect(s.month!.days[8]!.totals).toBeUndefined();
    expect(s.month!.days[14]!.totals!.records).toBe(1);
    const b = s.sessions.find((x) => x.folderId === B)!;
    expect(b.live).toBe(false);
    expect(s.sessions.some((x) => x.folderId === C)).toBe(false);
    expect(s.current!.folderId).toBe(A);
  });

  it("month rollover forgets last month's logs, records and health", async () => {
    const jan20 = new Date(2026, 0, 20, 12, 0, 0);
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1, jan20.toISOString())]) + "{not json\n", mtime: jan20 },
    ]);
    // Make the bad line a gated one so it counts as malformed.
    await appendFile(events(A), '{"type":"session.usage_record",\n');
    const { utimes } = await import("node:fs/promises");
    await utimes(events(A), jan20, jan20);
    clock = new Date(2026, 0, 31, 23, 0, 0).getTime();
    make();
    await monitor.refresh({ full: true });
    expect(last().month!.totals!.records).toBe(1);
    expect(last().health.partial).toBe(true);
    expect(last().sessions.map((x) => x.folderId)).toContain(A);

    clock = new Date(2026, 1, 1, 1, 0, 0).getTime();
    await monitor.refresh();
    const s = last();
    expect(s.month!.monthStartMs).toBe(new Date(2026, 1, 1).getTime());
    expect(s.month!.totals).toBeUndefined();
    expect(s.health.partial).toBe(false);
    expect(s.sessions.map((x) => x.folderId)).not.toContain(A);
  });

  it("idle polls emit nothing; a pin change emits", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }, { id: B, lines: jsonl([rec(B, 2)]) }]);
    make();
    await monitor.refresh({ full: true });
    const n = snaps.length;
    await monitor.refresh();
    await monitor.refresh();
    expect(snaps.length).toBe(n);
    monitor.pin(B);
    await monitor.refresh();
    expect(last().current!.folderId).toBe(B);
    expect(last().current!.pinned).toBe(true);
  });

  it("a __proto__ model line does not stop snapshots (D28)", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    make();
    await monitor.refresh({ full: true });
    const evil = usageEvent({ model: "__proto__", usageId: "evil", id: "evil", sourceSessionId: A, timestamp: at(9, 30) }) as Record<string, any>;
    evil.data.usage.toolCounts = JSON.parse('{"__proto__":1,"constructor":1}');
    await appendFile(events(A), jsonl([evil]));
    await monitor.refresh();
    expect(last().today?.records).toBe(2);
    expect(Object.keys(last().today!.byModel).sort()).toStrictEqual(["(unknown model)", "model-a"]);
    expect(logLines.join("\n")).not.toContain("EXCEPTION");
    expect(({} as Record<string, unknown>).records).toBeUndefined();
  });

  // ---- session totals from session.shutdown (D29)

  const legacy = (id: string, ts = at(9), o: Parameters<typeof shutdownEvent>[0] = {}) =>
    jsonl([turnEnd(), turnEnd(), turnEnd(), shutdownEvent({ timestamp: ts, ...o })]);

  it("legacy session total counted on its shutdown day", async () => {
    await sessionTree(root, [{ id: A, lines: legacy(A) }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    const s = last();
    expect(s.today).toBeDefined();
    expect(s.today!.calls).toBe(6);
    expect(s.today!.records).toBe(1);
    expect(s.today!.sessionTotals).toBe(1);
    expect(s.today!.input.sum).toBe(6000);
    expect(s.today!.nanoAiu.sum).toBe(12_000_000_000);
    expect(s.health).toMatchObject({ state: "ok", sessionsFromTotals: 1, sessionsWithoutUsage: 0, unrecognized: 0, partial: false });
    expect(s.current).toMatchObject({ folderId: A, live: false });
    expect(s.current!.totals!.sessionTotals).toBe(1);
    expect(s.month!.sessions[0]).toMatchObject({ sessionId: A, sessionTotal: true, calls: 6 });
  });

  it("legacy zero AIU stays unreported: tokens counted, USD not", async () => {
    await sessionTree(root, [{ id: A, lines: legacy(A, at(9), { models: { "model-a": { totalNanoAiu: 0 } } }) }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().today!.input.sum).toBe(6000);
    expect(last().today!.nanoAiu).toEqual({ sum: 0, reported: 0, missing: 1 });
    expect(statusText(last(), { unit: "cost" })).not.toContain("$0.00");
  });

  it("a session with usage records and a shutdown is counted once", async () => {
    const lines = jsonl([rec(A, 1), rec(A, 2), shutdownEvent({ timestamp: at(9, 30), models: { "model-a": { inputTokens: 2000, outputTokens: 400, requests: 2 } } })]);
    await sessionTree(root, [{ id: A, lines }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().today).toMatchObject({ records: 2, calls: 2, sessionTotals: 0 });
    expect(last().today!.input.sum).toBe(2000);
    expect(last().health.sessionsFromTotals).toBe(0);
  });

  it("two shutdown lines count once: the last one wins", async () => {
    const lines = legacy(A, at(8)) + jsonl([otherEvent("session.resume", { timestamp: at(8, 30) }), turnEnd(), shutdownEvent({ timestamp: at(9), models: { "model-a": { inputTokens: 9000 } } })]);
    await sessionTree(root, [{ id: A, lines }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().today).toMatchObject({ records: 1, calls: 6, sessionTotals: 1 });
    expect(last().today!.input.sum).toBe(9000);
  });

  it("shutdown, then later usage records for the same session: the total is hidden", async () => {
    await sessionTree(root, [{ id: A, lines: legacy(A) }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().today!.sessionTotals).toBe(1);
    const n = snaps.length;
    await appendFile(events(A), jsonl([rec(A, 1, at(9, 40))]));
    await monitor.refresh();
    expect(snaps.length).toBe(n + 1);
    expect(last().today).toMatchObject({ records: 1, calls: 1, sessionTotals: 0 });
    expect(last().health.sessionsFromTotals).toBe(0);
  });

  it("a shutdown dated yesterday feeds the month, not today", async () => {
    const yesterday = new Date(2026, 0, 14, 18, 0, 0).toISOString();
    await sessionTree(root, [{ id: A, lines: legacy(A, yesterday) }, { id: B, lines: jsonl([rec(B, 1)]) }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().today).toMatchObject({ records: 1, sessionTotals: 0 });
    expect(last().month!.totals).toMatchObject({ records: 2, calls: 7, sessionTotals: 1 });
    expect(last().month!.days[13]!.totals!.sessionTotals).toBe(1);
  });

  it("readTotals off: shutdown lines are never decoded (v0.3 numbers)", async () => {
    await sessionTree(root, [{ id: A, lines: legacy(A) }]);
    const toStr = vi.spyOn(Buffer.prototype, "toString");
    make();
    await monitor.refresh({ full: true });
    const decoded = toStr.mock.results.map((r) => String(r.value));
    toStr.mockRestore();
    expect(decoded.some((d) => d.includes("session.shutdown"))).toBe(false);
    expect(last().today).toBeUndefined();
    expect(last().health).toMatchObject({ state: "no-data", sessionsWithoutUsage: 1, sessionsFromTotals: 0, shutdownOversize: 0 });
  });

  it("an unrecognized shutdown line raises format-changed; earlier records still count", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }, { id: B, lines: jsonl([turnEnd(), shutdownEvent({ timestamp: at(9), models: null })]) }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({ state: "format-changed", unrecognized: 1 });
    expect(last().today!.records).toBe(1);
  });

  it("a malformed shutdown line marks partial", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) + '{"type":"session.shutdown","data":{\n' }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({ partial: true, malformed: 1 });
  });

  it("an oversize shutdown line marks partial and is not decoded", async () => {
    const big = JSON.stringify(shutdownEvent({ timestamp: at(9) })).replace('"routine"', `"${CANARY.repeat(5000)}"`);
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }, { id: B, lines: jsonl([turnEnd()]) + big + "\n" }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({ partial: true, shutdownOversize: 1, sessionsWithoutUsage: 1 });
    expect(last().today!.records).toBe(1);
    expect(JSON.stringify(last())).not.toContain(CANARY);
  });

  it("an oversize shutdown line in a log with per-call records does not mark partial (review 3)", async () => {
    const big = JSON.stringify(shutdownEvent({ timestamp: at(9, 30) })).replace('"routine"', `"${CANARY.repeat(5000)}"`);
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1), rec(A, 2)]) + big + "\n" }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().health).toMatchObject({ partial: false, shutdownOversize: 1 });
    expect(last().today!.records).toBe(2);
    expect(statusText(last(), { unit: "tokens" })).not.toContain("*");
  });

  it("per-call records whose sourceSessionId is not the folder still hide that folder's total (review 1)", async () => {
    // Folder B holds calls attributed to session A (a resumed or forked session) and B's own shutdown.
    const lines = jsonl([rec(A, 1), rec(A, 2), shutdownEvent({ timestamp: at(9, 30), models: { "model-a": { inputTokens: 9000, requests: 9 } } })]);
    await sessionTree(root, [{ id: B, lines }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().today).toMatchObject({ records: 2, calls: 2, sessionTotals: 0 });
    expect(last().today!.input.sum).toBe(2000);
    expect(last().health.sessionsFromTotals).toBe(0);
  });

  it("the current session counts its folder's calls even when they name another session (review #5)", async () => {
    await sessionTree(root, [{ id: B, lines: jsonl([rec(A, 1), rec(A, 2)]) }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().current?.folderId).toBe(B);
    expect(last().current?.totals?.records).toBe(2);
  });

  it("truncation and rewrite of a legacy log replaces its totals", async () => {
    await sessionTree(root, [{ id: A, lines: legacy(A) }]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().today!.input.sum).toBe(6000);
    await writeFile(events(A), jsonl([shutdownEvent({ timestamp: at(9), models: { "model-b": { inputTokens: 5 } } })]));
    await monitor.refresh();
    expect(Object.keys(last().today!.byModel)).toStrictEqual(["model-b"]);
    expect(last().today!.input.sum).toBe(5);
  });

  it("month rollover forgets last month's session totals", async () => {
    const jan20 = new Date(2026, 0, 20, 12, 0, 0);
    await sessionTree(root, [{ id: A, lines: legacy(A, jan20.toISOString()), mtime: jan20 }]);
    clock = new Date(2026, 0, 31, 23, 0, 0).getTime();
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().month!.totals!.sessionTotals).toBe(1);
    expect(last().health.sessionsFromTotals).toBe(1);
    clock = new Date(2026, 1, 1, 1, 0, 0).getTime();
    await monitor.refresh();
    expect(last().month!.totals).toBeUndefined();
    expect(last().health.sessionsFromTotals).toBe(0);
  });

  it("readTotals on still opens only events.jsonl", async () => {
    await sessionTree(root, [{ id: A, lines: legacy(A) }, { id: B, lines: jsonl([rec(B, 1)]) }]);
    for (const id of [A, B]) await writeFile(join(root, "session-state", id, "workspace.yaml"), CANARY);
    const open = vi.spyOn(fs.promises, "open");
    const readFile = vi.spyOn(fs.promises, "readFile");
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    expect(last().today!.sessionTotals).toBe(1);
    for (const p of open.mock.calls.map((c) => String(c[0]))) expect(p).toMatch(/session-state\/[0-9a-f-]+\/events\.jsonl$/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("canary: session totals never carry log content into snapshots, HTML, tooltips or logs", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([otherEvent("session.start"), rec(A, 1), turnEnd()]), lockPid: LIVE_PID },
      { id: B, lines: legacy(B, at(8), { models: { "model-a": {}, "model-b": { totalNanoAiu: 0 } } }) },
      { id: C, lines: legacy(C, at(7), { models: {} }) },
    ]);
    make({ readTotals: true });
    await monitor.refresh({ full: true });
    await appendFile(events(A), jsonl([shutdownEvent({ timestamp: at(9, 50) })]));
    await monitor.refresh();
    expect(last().today!.sessionTotals).toBe(2);
    for (const s of snaps) {
      expect(JSON.stringify(s)).not.toContain(CANARY);
      for (const view of [{ unit: "tokens" as const }, { unit: "cost" as const, range: { max: 5 } }]) {
        for (const section of SECTIONS) expect(renderPanelHtml(s, "csp", view, section)).not.toContain(CANARY);
        expect(tooltipMarkdown(s, view)).not.toContain(CANARY);
        expect(statusText(s, view)).not.toContain(CANARY);
      }
    }
    expect(logLines.join("\n")).not.toContain(CANARY);
  });

  it("canary: no emitted snapshot contains log content", async () => {
    await sessionTree(root, [
      {
        id: A,
        lines: jsonl([otherEvent("session.start"), rec(A, 1), turnEnd()]),
        lockPid: LIVE_PID,
      },
      { id: B, lines: jsonl([otherEvent("user.message"), turnEnd()]) },
    ]);
    make();
    await monitor.refresh({ full: true });
    await appendFile(
      events(A),
      jsonl([otherEvent("tool.execution_start"), rec(A, 2), turnEnd()]),
    );
    await monitor.refresh();
    expect(snaps.length).toBeGreaterThan(0);
    for (const s of snaps) expect(JSON.stringify(s)).not.toContain(CANARY);
    expect(logLines.join("\n")).not.toContain(CANARY);
  });
});

describe("UsageMonitor resilience (v0.7 review)", () => {
  it("refresh keeps working after a run rejects", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    // A raw logger (not the guarded Logger) that throws during the first refresh: it rejects.
    let fail = true;
    const boom = () => {
      if (fail) throw new Error("sink down");
    };
    const log = { count: boom, error: boom, timing: boom } as unknown as Logger;
    make({ log });
    await expect(monitor.refresh({ full: true })).rejects.toThrow("sink down");
    fail = false;
    await appendFile(events(A), jsonl([rec(A, 2)]));
    await expect(monitor.refresh({ full: true })).resolves.toBeUndefined();
    expect(last().today?.records).toBe(2);
  });

  it("a log that disappears (ENOENT) drops its records", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1), rec(A, 2)]) },
      { id: B, lines: jsonl([rec(B, 3)]) },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().today?.records).toBe(3);
    await rm(events(A));
    await monitor.refresh();
    clock += 11_000;
    await monitor.refresh();
    await monitor.refresh({ full: true });
    expect(last().today?.records).toBe(1);
    // Recreated with different content: counted once, not on top of the old records.
    await writeFile(events(A), jsonl([rec(A, 7)]));
    await monitor.refresh({ full: true });
    expect(last().today?.records).toBe(2);
  });

  it("a throwing onSnapshot is retried on the next refresh", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([rec(A, 1)]) }]);
    let calls = 0;
    make({
      onSnapshot: (s) => {
        calls++;
        if (calls === 1) throw new Error("ui");
        snaps.push(s);
      },
    });
    await monitor.refresh({ full: true });
    expect(snaps).toHaveLength(0);
    await monitor.refresh({ full: true });
    expect(last().today?.records).toBe(1);
  });

  it("a transient lstat error keeps the session's records", async () => {
    await sessionTree(root, [
      { id: A, lines: jsonl([rec(A, 1), rec(A, 2)]) },
      { id: B, lines: jsonl([rec(B, 3)]) },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().today?.records).toBe(3);
    const real = fs.promises.lstat;
    let armed = true;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (armed && String(p) === events(A)) {
        armed = false;
        throw Object.assign(new Error("x"), { code: "EMFILE" });
      }
      return (real as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest);
    }) as typeof real);
    await monitor.refresh({ full: true });
    expect(armed).toBe(false);
    expect(last().today?.records).toBe(3);
    expect(last().health.partial).toBe(true);
    expect(logLines).toContain("error discover EMFILE");
    await monitor.refresh({ full: true });
    expect(last().today?.records).toBe(3);
    expect(last().health.partial).toBe(false);
  });

  it.skipIf(process.platform === "win32")("a FIFO swapped in for workspace.yaml never blocks the title read", async () => {
    const ID = "a5ba938d-3495-450d-94f0-cdab4c64c501";
    const startEv = { type: "session.start", id: "s", parentId: null, timestamp: at(8), data: { context: { cwd: `/srv/${ID}` } } };
    await sessionTree(root, [{ id: A, lines: jsonl([startEv, rec(A, 1)]) }]);
    const ws = join(root, "session-state", A, "workspace.yaml");
    execFileSync("mkfifo", [ws]);
    // lstat sees a regular file (the race window); the open then meets the FIFO.
    const real = fs.promises.lstat;
    const fileStat = await real(events(A));
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) =>
      String(p) === ws ? fileStat : (real as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest)) as typeof real);
    make({ readProjects: true });
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      monitor.refresh({ full: true }).then(() => "done"),
      new Promise<string>((r) => (timer = setTimeout(() => r("blocked"), 1000))),
    ]);
    clearTimeout(timer);
    // Unblock a stuck open (if any) so the worker thread is released.
    if (outcome === "blocked") fsModule.closeSync(fsModule.openSync(ws, fsModule.constants.O_WRONLY | fsModule.constants.O_NONBLOCK));
    expect(outcome).toBe("done");
    expect(last().month?.projects.find((p) => p.name === ID)?.label).toBeUndefined();
  });
});

