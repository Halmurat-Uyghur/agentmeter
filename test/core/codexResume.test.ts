// Review finding #1: a Codex session resumed today keeps appending to its rollout file in the
// date folder of the day it started. A folder older than the window must not hide a file whose
// mtime is in the window.
import * as fs from "node:fs";
import { appendFile, mkdtemp, rename, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_OLD_SCAN_MS, CodexSourceReader, discoverCodex } from "../../src/core/codex";
import { codexMeta, codexTree } from "../fixtures/codex";

const id = (n: number) => `cccccccc-0000-0000-0000-${String(n).padStart(12, "0")}`;

describe("Codex sessions resumed from an old date folder (review #1)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cum-codex-resume-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const windowStart = new Date(2026, 10, 1, 0, 0, 0).getTime(); // one month of history: 2026-11-01
  const dayStart = new Date(2026, 10, 8, 0, 0, 0).getTime();
  const now = new Date(2026, 10, 8, 12, 0, 0).getTime();

  it("discoverCodex finds a file in a folder before the window when its mtime is in the window", async () => {
    await codexTree(root, [
      // started 2026-10-20, resumed today
      { date: "2026/10/20", sessionId: id(1), lines: [codexMeta()], mtime: new Date(now - 1000) },
      // started 2025-03-02, last touched before the window
      { date: "2025/03/02", sessionId: id(2), lines: [codexMeta()], mtime: new Date(windowStart - 1000) },
      { date: "2026/11/08", sessionId: id(3), lines: [codexMeta()], mtime: new Date(now - 5000) },
    ]);
    const res = await discoverCodex(root, windowStart, dayStart, now);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.sessionId)).toEqual([id(1), id(3)]);
    expect(res.candidates[0]).toMatchObject({ live: true, mtimeMs: now - 1000 });
  });

  it("the reader walks old folders on its first discovery, then only re-stats the old files it found until CODEX_OLD_SCAN_MS passes", async () => {
    const [resumed, later] = await codexTree(root, [
      { date: "2026/10/20", sessionId: id(1), lines: [codexMeta()], mtime: new Date(now - 60_000) },
      { date: "2026/09/15", sessionId: id(2), lines: [codexMeta()], mtime: new Date(windowStart - 1000) },
      { date: "2026/11/08", sessionId: id(3), lines: [codexMeta()], mtime: new Date(now - 5000) },
    ]);
    const r = new CodexSourceReader({ root, rootSource: "default", readProjects: true, readTotals: true });

    const first = await r.discover(windowStart, dayStart, now);
    expect(first.ok && first.candidates.map((c) => c.sessionId).sort()).toEqual([id(1), id(3)]);

    // An append (a resume) to the found old file shows on the next discovery, which neither
    // lists the old folders nor stats the old file that was out of the window.
    await appendFile(resumed!, `${codexMeta()}\n`);
    await utimes(resumed!, new Date(now + 1000), new Date(now + 1000));
    // Meanwhile the other old session is resumed too: it is found by the next full walk.
    await utimes(later!, new Date(now + 2000), new Date(now + 2000));
    const readdir = vi.spyOn(fs.promises, "readdir");
    const lstat = vi.spyOn(fs.promises, "lstat");
    const quick = await r.discover(windowStart, dayStart, now + 30_000);
    expect(quick.ok && quick.candidates.map((c) => c.sessionId).sort()).toEqual([id(1), id(3)]);
    expect(quick.ok && quick.candidates.find((c) => c.sessionId === id(1))!.mtimeMs).toBe(now + 1000);
    const listed = readdir.mock.calls.map((a) => String(a[0]));
    expect(listed.some((p) => p.endsWith(join("10", "20")) || p.endsWith(join("09", "15")))).toBe(false);
    expect(lstat.mock.calls.map((a) => String(a[0])).some((p) => p.includes(`${sep}09${sep}15${sep}`))).toBe(false);

    const full = await r.discover(windowStart, dayStart, now + CODEX_OLD_SCAN_MS);
    expect(full.ok && full.candidates.map((c) => c.sessionId).sort()).toEqual([id(1), id(2), id(3)]);
  });

  it("a new window walks old folders again at once", async () => {
    const [p] = await codexTree(root, [{ date: "2026/09/15", sessionId: id(2), lines: [codexMeta()], mtime: new Date(windowStart - 1000) }]);
    const r = new CodexSourceReader({ root, rootSource: "default", readProjects: true, readTotals: true });
    const first = await r.discover(windowStart, dayStart, now);
    expect(first.ok && first.candidates).toEqual([]);
    await utimes(p!, new Date(now), new Date(now));
    const earlier = new Date(2026, 9, 1).getTime(); // the user widened history to two months
    const res = await r.discover(earlier, dayStart, now + 1000);
    expect(res.ok && res.candidates.map((c) => c.sessionId)).toEqual([id(2)]);
  });

  it("a found old file that is deleted drops out without being reported unreadable", async () => {
    const [p] = await codexTree(root, [{ date: "2026/10/20", sessionId: id(1), lines: [codexMeta()], mtime: new Date(now - 1000) }]);
    const r = new CodexSourceReader({ root, rootSource: "default", readProjects: true, readTotals: true });
    const first = await r.discover(windowStart, dayStart, now);
    expect(first.ok && first.candidates).toHaveLength(1);
    await rm(p!);
    const res = await r.discover(windowStart, dayStart, now + 1000);
    expect(res.ok && res.candidates).toEqual([]);
    expect(res.ok && res.unreadable).toEqual([]);
  });

  it("an unreadable old folder is reported on every discovery, not only on the full walks", async () => {
    await codexTree(root, [{ date: "2026/10/20", sessionId: id(1), lines: [codexMeta()], mtime: new Date(now - 1000) }]);
    const dir = join(root, "sessions", "2026", "10", "20");
    await fs.promises.chmod(dir, 0o000);
    try {
      const r = new CodexSourceReader({ root, rootSource: "default", readProjects: true, readTotals: true });
      const first = await r.discover(windowStart, dayStart, now);
      const expected = [{ folderId: "2026/10/20", path: dir, code: expect.stringMatching(/^E(ACCES|PERM)$/) }];
      expect(first.ok && first.unreadable).toEqual(expected);
      const quick = await r.discover(windowStart, dayStart, now + 1000);
      expect(quick.ok && quick.unreadable).toEqual(expected);
    } finally {
      await fs.promises.chmod(dir, 0o755);
    }
  });
  it("a full refresh (discover's full hint) walks the old folders at once (review D)", async () => {
    const [p] = await codexTree(root, [{ date: "2026/09/15", sessionId: id(2), lines: [codexMeta()], mtime: new Date(windowStart - 1000) }]);
    const r = new CodexSourceReader({ root, rootSource: "default", readProjects: true, readTotals: true });
    const first = await r.discover(windowStart, dayStart, now);
    expect(first.ok && first.candidates).toEqual([]);
    // The old session is resumed; a tick's discovery does not see it before CODEX_OLD_SCAN_MS...
    await utimes(p!, new Date(now), new Date(now));
    const tick = await r.discover(windowStart, dayStart, now + 1000, { full: false });
    expect(tick.ok && tick.candidates).toEqual([]);
    // ...a full refresh does.
    const full = await r.discover(windowStart, dayStart, now + 2000, { full: true });
    expect(full.ok && full.candidates.map((c) => c.sessionId)).toEqual([id(2)]);
  });

  it("an old file whose lstat failed in the full walk is re-stat'ed by the quick walks (review L)", async () => {
    const [p] = await codexTree(root, [{ date: "2026/10/20", sessionId: id(1), lines: [codexMeta()], mtime: new Date(now - 1000) }]);
    const fail = { on: true };
    const real = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, "lstat").mockImplementation(((q: fs.PathLike, o?: unknown) => {
      if (fail.on && String(q) === p) return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
      return (real as (q: fs.PathLike, o?: unknown) => Promise<fs.Stats>)(q, o);
    }) as typeof fs.promises.lstat);
    const r = new CodexSourceReader({ root, rootSource: "default", readProjects: true, readTotals: true });
    const first = await r.discover(windowStart, dayStart, now);
    expect(first.ok && first.unreadable).toEqual([{ folderId: id(1), path: p, code: "EIO" }]);
    // Still failing: still reported by the quick walk.
    const again = await r.discover(windowStart, dayStart, now + 1000);
    expect(again.ok && again.unreadable).toEqual([{ folderId: id(1), path: p, code: "EIO" }]);
    // Recovered: the next quick walk finds it and no longer reports it, well before CODEX_OLD_SCAN_MS.
    fail.on = false;
    const quick = await r.discover(windowStart, dayStart, now + 2000);
    expect(quick.ok && quick.unreadable).toEqual([]);
    expect(quick.ok && quick.candidates.map((c) => c.sessionId)).toEqual([id(1)]);
  });
  // Review of PR #22 (P2): a quick walk re-stats cached paths without listing their folders, so
  // a year, month or day folder swapped for a symlink to a folder outside sessions/ must not let
  // it pick up a rollout from outside the root. A full walk never descends into a symlink.
  it.skipIf(process.platform === "win32").each([
    ["day", 3],
    ["month", 2],
    ["year", 1],
  ])("a cached old path whose %s folder became a symlink out of the root is dropped by the quick walk", async (_level, up) => {
    const outside = await mkdtemp(join(tmpdir(), "cum-codex-outside-"));
    try {
      const [p] = await codexTree(root, [{ date: "2026/10/20", sessionId: id(1), lines: [codexMeta()], mtime: new Date(now - 60_000) }]);
      const r = new CodexSourceReader({ root, rootSource: "default", readProjects: true, readTotals: true });
      const first = await r.discover(windowStart, dayStart, now);
      expect(first.ok && first.candidates.map((c) => c.sessionId)).toEqual([id(1)]);

      // Move the folder out of the root and leave a symlink to it in its place; the file resolves through it.
      let folder = p!;
      for (let i = 0; i < 4 - up; i++) folder = dirname(folder);
      const moved = join(outside, "moved");
      await rename(folder, moved);
      await symlink(moved, folder, "dir");
      await utimes(p!, new Date(now), new Date(now));
      expect(fs.existsSync(p!)).toBe(true);

      const quick = await r.discover(windowStart, dayStart, now + 1000);
      expect(quick.ok && quick.candidates).toEqual([]);
      expect(quick.ok && quick.unreadable).toEqual([]);
      // Dropped from the cache, and a full walk does not find it either.
      const later = await r.discover(windowStart, dayStart, now + 2000);
      expect(later.ok && later.candidates).toEqual([]);
      const full = await r.discover(windowStart, dayStart, now + 3000, { full: true });
      expect(full.ok && full.candidates).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("an in-window day folder swapped for a symlink out of the root is not walked", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cum-codex-outside-"));
    try {
      const [p] = await codexTree(root, [{ date: "2026/11/08", sessionId: id(1), lines: [codexMeta()], mtime: new Date(now - 5000) }]);
      const r = new CodexSourceReader({ root, rootSource: "default", readProjects: true, readTotals: true });
      const first = await r.discover(windowStart, dayStart, now);
      expect(first.ok && first.candidates.map((c) => c.sessionId)).toEqual([id(1)]);
      const day = dirname(p!);
      await rename(day, join(outside, "08"));
      await symlink(join(outside, "08"), day, "dir");
      const quick = await r.discover(windowStart, dayStart, now + 1000);
      expect(quick.ok && quick.candidates).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
