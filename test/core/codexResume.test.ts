// Review finding #1: a Codex session resumed today keeps appending to its rollout file in the
// date folder of the day it started. A folder older than the window must not hide a file whose
// mtime is in the window.
import * as fs from "node:fs";
import { appendFile, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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
});
