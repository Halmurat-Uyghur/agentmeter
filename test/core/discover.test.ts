import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, isLive } from "../../src/core/discover";
import { jsonl, sessionTree, usageEvent } from "../fixtures/build";

const A = "0000aaaa-0000-4000-8000-000000000001";
const B = "0000bbbb-0000-4000-8000-000000000002";
const C = "0000cccc-0000-4000-8000-000000000003";

const LINES = jsonl([usageEvent()]);
const DAY_START = new Date(2026, 10, 5, 0, 0, 0).getTime();
const TODAY = new Date(2026, 10, 5, 10, 0, 0);
const YESTERDAY = new Date(2026, 10, 4, 22, 0, 0);

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

const alive = () => true;
const dead = () => false;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cum-discover-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await chmod(join(root, "session-state"), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

function byId(r: Awaited<ReturnType<typeof discover>>) {
  if (!r.ok) throw new Error(`unexpected error ${r.error}`);
  return new Map(r.candidates.map((c) => [c.folderId, c]));
}

describe("isLive", () => {
  it("is true when kill(pid, 0) returns", () => {
    const kill = vi.fn();
    expect(isLive(1234, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(1234, 0);
  });

  it("counts EPERM as alive", () => {
    expect(
      isLive(1234, () => {
        throw errno("EPERM");
      }),
    ).toBe(true);
  });

  it("is false on ESRCH or any other error", () => {
    expect(
      isLive(1234, () => {
        throw errno("ESRCH");
      }),
    ).toBe(false);
    expect(
      isLive(1234, () => {
        throw new Error("boom");
      }),
    ).toBe(false);
  });

  it("rejects PIDs below 1 and non-safe integers without calling kill", () => {
    const kill = vi.fn();
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isLive(pid, kill)).toBe(false);
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it("finds the test's own process alive with the real kill", () => {
    expect(isLive(process.pid)).toBe(true);
  });
});

describe("discover", () => {
  it("returns no-dir when session-state is missing", async () => {
    expect(await discover(root, DAY_START, alive)).toEqual({
      ok: false,
      error: "no-dir",
    });
  });

  it("returns no-dir when session-state is a file", async () => {
    await writeFile(join(root, "session-state"), "");
    expect(await discover(root, DAY_START, alive)).toEqual({
      ok: false,
      error: "no-dir",
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "returns permission when session-state is unreadable",
    async () => {
      await sessionTree(root, [{ id: A, lines: LINES, mtime: TODAY }]);
      await chmod(join(root, "session-state"), 0o000);
      expect(await discover(root, DAY_START, alive)).toEqual({
        ok: false,
        error: "permission",
      });
    },
  );

  it("maps EPERM on session-state to permission and other errors to OTHER", async () => {
    await sessionTree(root, [{ id: A, lines: LINES, mtime: TODAY }]);
    const spy = vi.spyOn(fs.promises, "readdir");
    spy.mockRejectedValueOnce(errno("EPERM"));
    expect(await discover(root, DAY_START, alive)).toEqual({
      ok: false,
      error: "permission",
    });
    spy.mockRejectedValueOnce(errno("EIO"));
    expect(await discover(root, DAY_START, alive)).toEqual({
      ok: false,
      error: "OTHER",
    });
  });

  it("maps stat errors on session-state the same way", async () => {
    await sessionTree(root, [{ id: A, lines: LINES, mtime: TODAY }]);
    const spy = vi.spyOn(fs.promises, "stat");
    spy.mockRejectedValueOnce(errno("EACCES"));
    expect(await discover(root, DAY_START, alive)).toEqual({ ok: false, error: "permission" });
    spy.mockRejectedValueOnce(errno("ENOTDIR"));
    expect(await discover(root, DAY_START, alive)).toEqual({ ok: false, error: "no-dir" });
    spy.mockRejectedValueOnce(errno("ELOOP"));
    expect(await discover(root, DAY_START, alive)).toEqual({ ok: false, error: "OTHER" });
  });

  it("includes today's file, excludes yesterday's, and reports the dir mtime", async () => {
    await sessionTree(root, [
      { id: A, lines: LINES, mtime: TODAY },
      { id: B, lines: LINES, mtime: YESTERDAY },
    ]);
    const r = await discover(root, DAY_START, dead);
    const m = byId(r);
    expect([...m.keys()]).toEqual([A]);
    expect(m.get(A)).toEqual({
      folderId: A,
      eventsPath: join(root, "session-state", A, "events.jsonl"),
      mtimeMs: TODAY.getTime(),
      size: Buffer.byteLength(LINES),
      live: false,
    });
    if (!r.ok) throw new Error("unreachable");
    expect(r.dirMtimeMs).toBe(fs.statSync(join(root, "session-state")).mtimeMs);
  });

  it("dead-pid lock is not live", async () => {
    await sessionTree(root, [
      { id: A, lines: LINES, lockPid: 4242, mtime: TODAY },
    ]);
    const kill = vi.fn(() => {
      throw errno("ESRCH");
    });
    const m = byId(await discover(root, DAY_START, (pid) => isLive(pid, kill)));
    expect(m.get(A)?.live).toBe(false);
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it("live lock makes today's session live", async () => {
    await sessionTree(root, [
      { id: A, lines: LINES, lockPid: 4242, mtime: TODAY },
    ]);
    const m = byId(
      await discover(root, DAY_START, (pid) => isLive(pid, () => undefined)),
    );
    expect(m.get(A)?.live).toBe(true);
  });

  it("EPERM from kill counts as live", async () => {
    await sessionTree(root, [
      { id: A, lines: LINES, lockPid: 4242, mtime: TODAY },
    ]);
    const m = byId(
      await discover(root, DAY_START, (pid) =>
        isLive(pid, () => {
          throw errno("EPERM");
        }),
      ),
    );
    expect(m.get(A)?.live).toBe(true);
  });

  it("old file with a live lock is not a candidate", async () => {
    await sessionTree(root, [
      { id: A, lines: LINES, lockPid: 4242, mtime: YESTERDAY },
    ]);
    const m = byId(await discover(root, DAY_START, alive));
    expect(m.size).toBe(0);
  });

  it("ignores .hold files and malformed lock names", async () => {
    await sessionTree(root, [{ id: A, lines: LINES, mtime: TODAY }]);
    const dir = join(root, "session-state", A);
    for (const name of [
      "inuse.4242.hold",
      "inuse.abc.lock",
      "inuse.0.lock",
      "inuse.12.lock.bak",
    ]) {
      await writeFile(join(dir, name), "");
    }
    const seen: number[] = [];
    const m = byId(
      await discover(root, DAY_START, (pid) => {
        seen.push(pid);
        return true;
      }),
    );
    expect(m.get(A)?.live).toBe(false);
    expect(seen).toEqual([]);
  });

  it("skips .session-operation-locks, .DS_Store and other badly named entries", async () => {
    await sessionTree(root, [{ id: A, lines: LINES, mtime: TODAY }]);
    const ss = join(root, "session-state");
    await mkdir(join(ss, ".session-operation-locks"));
    await writeFile(
      join(ss, ".session-operation-locks", "events.jsonl"),
      LINES,
    );
    await writeFile(join(ss, ".DS_Store"), "");
    await mkdir(join(ss, "not_a_session"));
    await writeFile(join(ss, "not_a_session", "events.jsonl"), LINES);
    const r = await discover(root, DAY_START, alive);
    expect([...byId(r).keys()]).toEqual([A]);
  });

  it("counts valid folders without a log", async () => {
    await sessionTree(root, [{ id: A, lines: LINES, mtime: TODAY }]);
    await mkdir(join(root, "session-state", B));
    await mkdir(join(root, "session-state", C, "events.jsonl"), {
      recursive: true,
    });
    const r = await discover(root, DAY_START, alive);
    expect([...byId(r).keys()]).toEqual([A]);
  });

  it("skips a symlinked events.jsonl", async () => {
    await sessionTree(root, [{ id: A, lines: LINES, mtime: TODAY }]);
    const dir = join(root, "session-state", B);
    await mkdir(dir);
    await symlink(
      join(root, "session-state", A, "events.jsonl"),
      join(dir, "events.jsonl"),
    );
    const r = await discover(root, DAY_START, alive);
    expect([...byId(r).keys()]).toEqual([A]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "skips an unreadable session folder without failing",
    async () => {
      await sessionTree(root, [
        { id: A, lines: LINES, mtime: TODAY },
        { id: B, lines: LINES, lockPid: 4242, mtime: TODAY },
      ]);
      const dirB = join(root, "session-state", B);
      await chmod(dirB, 0o000);
      try {
        const r = await discover(root, DAY_START, alive);
        expect([...byId(r).keys()]).toEqual([A]);
        // Reported, not dropped: the monitor keeps the session and flags it partial (v0.7).
        if (!r.ok) throw new Error("unreachable");
        expect(r.unreadable).toEqual([{ folderId: B, eventsPath: join(dirB, "events.jsonl"), code: "EACCES" }]);
      } finally {
        await chmod(dirB, 0o755);
      }
    },
  );

  it("follows a symlinked session-state and reports the target's mtime", async () => {
    const real = join(root, "real");
    await sessionTree(real, [{ id: A, lines: LINES, mtime: TODAY }]);
    await symlink(join(real, "session-state"), join(root, "session-state"));
    const r = await discover(root, DAY_START, alive);
    expect([...byId(r).keys()]).toEqual([A]);
    if (!r.ok) throw new Error("unreachable");
    expect(r.dirMtimeMs).toBe(fs.statSync(join(real, "session-state")).mtimeMs);
  });

  it("includes a file whose mtime equals dayStartMs", async () => {
    await sessionTree(root, [{ id: A, lines: LINES, mtime: new Date(DAY_START) }]);
    const m = byId(await discover(root, DAY_START, alive));
    expect(m.get(A)?.mtimeMs).toBe(DAY_START);
  });

  it("is live when any lock's PID is alive", async () => {
    await sessionTree(root, [{ id: A, lines: LINES, lockPid: 111, mtime: TODAY }]);
    await writeFile(join(root, "session-state", A, "inuse.222.lock"), "");
    const kill = (pid: number) => {
      if (pid === 111) throw errno("ESRCH");
    };
    const m = byId(await discover(root, DAY_START, (pid) => isLive(pid, kill)));
    expect(m.get(A)?.live).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("keeps a traversable but unlistable folder as a non-live candidate", async () => {
    await sessionTree(root, [{ id: A, lines: LINES, lockPid: 4242, mtime: TODAY }]);
    const dirA = join(root, "session-state", A);
    await chmod(dirA, 0o100);
    try {
      const m = byId(await discover(root, DAY_START, alive));
      expect(m.get(A)?.live).toBe(false);
    } finally {
      await chmod(dirA, 0o755);
    }
  });

  it("never opens a file", async () => {
    await sessionTree(root, [
      { id: A, lines: LINES, lockPid: 4242, mtime: TODAY },
    ]);
    const open = vi.spyOn(fs.promises, "open");
    const readFile = vi.spyOn(fs.promises, "readFile");
    await discover(root, DAY_START, alive);
    expect(open).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
