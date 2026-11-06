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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { parseUsageLine } from "../../src/core/extract";
import type { Snapshot } from "../../src/core/types";
import {
  CANARY,
  jsonl,
  otherEvent,
  sessionTree,
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

  it("legacy only: no-data, today undefined", async () => {
    await sessionTree(root, [
      {
        id: A,
        lines: jsonl([
          turnEnd(),
          turnEnd(),
          otherEvent("session.shutdown", { timestamp: at(9) }),
        ]),
      },
    ]);
    make();
    await monitor.refresh({ full: true });
    expect(last().health.state).toBe("no-data");
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

  it("reads only events.jsonl", async () => {
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

