// The Copilot SourceReader (D54): today's discovery, tailing and parsing behind
// the reader contract, with the folder-name project key of D44.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { appendFile, mkdtemp, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotSourceReader } from "../../src/core/copilot";
import { parseShutdownLine, parseUsageLine } from "../../src/core/extract";
import type { FileReadResult, SourceCandidate } from "../../src/core/source";
import type { UsageRecord } from "../../src/core/types";
import { CANARY, jsonl, otherEvent, sessionTree, shutdownEvent, usageEvent } from "../fixtures/build";

const A = "0000aaaa-0000-4000-8000-00000000000a";
const NOW = Date.now();
const DAY_START = NOW - 3_600_000;
const dead = () => false;

const startEvent = (context: object): object => ({
  type: "session.start",
  id: "s",
  parentId: null,
  timestamp: "2026-01-15T10:00:00.000Z",
  data: { copilotVersion: "1.0.100-1", context: { branch: CANARY, ...context }, prompt: CANARY },
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "copilot-reader-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function reader(o: { readProjects?: boolean; readTotals?: boolean } = {}): CopilotSourceReader {
  return new CopilotSourceReader({
    root,
    rootSource: "default",
    readProjects: o.readProjects ?? true,
    readTotals: o.readTotals ?? true,
    isLive: dead,
  });
}

async function candidate(r: CopilotSourceReader): Promise<SourceCandidate> {
  const d = await r.discover(DAY_START, DAY_START, NOW);
  if (!d.ok) throw new Error("discover failed");
  expect(d.candidates).toHaveLength(1);
  return d.candidates[0]!;
}

const eventsPath = () => join(root, "session-state", A, "events.jsonl");
const leaks = (r: FileReadResult) => JSON.stringify(r).includes(CANARY);

describe("CopilotSourceReader.discover", () => {
  it("wraps discover: one file per session, sessionId = folder id, size from lstat", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([usageEvent()]) }]);
    const r = reader();
    const d = await r.discover(DAY_START, DAY_START, NOW);
    if (!d.ok) throw new Error("discover failed");
    const st = fs.statSync(eventsPath());
    expect(d.candidates).toStrictEqual([
      {
        source: "copilot",
        sessionId: A,
        folderId: A,
        files: [{ path: eventsPath(), mtimeMs: st.mtimeMs, size: st.size }],
        mtimeMs: st.mtimeMs,
        live: false,
      },
    ]);
    expect(d.unreadable).toStrictEqual([]);
    expect(d.dirMtimeMs).toBe(fs.statSync(join(root, "session-state")).mtimeMs);
    expect(await r.rootDirMtime()).toBe(d.dirMtimeMs);
    expect(r.source).toBe("copilot");
  });

  it("a missing root is no-dir, and rootDirMtime is undefined", async () => {
    const r = reader();
    expect(await r.discover(DAY_START, DAY_START, NOW)).toStrictEqual({ ok: false, error: "no-dir" });
    expect(await r.rootDirMtime()).toBeUndefined();
  });
});

describe("CopilotSourceReader.pathAllowed", () => {
  it("accepts only <root>/session-state/<id>/events.jsonl", () => {
    const r = reader();
    expect(r.pathAllowed(eventsPath())).toBe(true);
    expect(r.pathAllowed(join(root, "session-state", "0123abcd", "events.jsonl"))).toBe(true);
    for (const p of [
      join(root, "session-state", A, "workspace.yaml"),
      join(root, "session-state", A, "sub", "events.jsonl"),
      join(root, "session-state", "..", "events.jsonl"),
      join(root, "session-state", "not-hex!", "events.jsonl"),
      join(root, "session-state", "abc", "events.jsonl"),
      join(root, "session-state", "events.jsonl"),
      join(root, "other", A, "events.jsonl"),
      join(root + "x", "session-state", A, "events.jsonl"),
      `${root}/session-state/${A}/../${A}/events.jsonl`,
      "events.jsonl",
      "",
    ])
      expect(r.pathAllowed(p), p).toBe(false);
  });
});

describe("CopilotSourceReader.open: parity with the v0.7 monitor read", () => {
  it("records, totals, folder-name key, owner/repo title and counters", async () => {
    const u1 = usageEvent({ usageId: "u-1", id: "e-1" });
    const u2 = usageEvent({ usageId: "u-2", id: "e-2", sequence: 2 });
    const sd = shutdownEvent();
    await sessionTree(root, [
      {
        id: A,
        lines: jsonl([
          startEvent({ gitRoot: "/x/repo/.claude/worktrees/f", cwd: "/x/elsewhere", repository: "o/repo" }),
          u1,
          otherEvent("assistant.turn_end"),
          u2,
          { type: "session.usage_record", id: "e-3", timestamp: new Date().toISOString(), data: { usage: { model: "m" } } },
          sd,
        ]) + '{"data":{},"type":"session.usage_record"}\n',
      },
    ]);
    const r = reader();
    const fr = r.open(eventsPath(), await candidate(r));
    const res = await fr.read();

    const expectRecord = (e: object): UsageRecord => {
      const p = parseUsageLine(JSON.stringify(e), A);
      if (p.kind !== "usage") throw new Error("fixture");
      return p.record;
    };
    const totals = parseShutdownLine(JSON.stringify(sd), A);
    if (totals.kind !== "totals") throw new Error("fixture");
    expect(res.records).toStrictEqual([expectRecord(u1), expectRecord(u2)]);
    expect(res.records.every((x) => x.source === "copilot")).toBe(true);
    expect(res.totals).toStrictEqual(totals.records);
    expect(res.hasTotals).toBe(true);
    expect(res.label).toBe("repo");
    expect(res.title).toBe("o/repo");
    expect(res).toMatchObject({
      reset: false,
      activity: 1,
      usage: 2,
      unrecognized: 1, // e-3: no known token field
      suspect: 1, // the reordered usage line
      malformed: 0,
      overlong: 0,
      overlongOther: 0,
      shutdownOversize: 0,
    });
    expect(res.error).toBeUndefined();
    expect(leaks(res)).toBe(false);

    // An idle read reports nothing new and does not repeat label or title.
    const idle = await fr.read();
    expect(idle.records).toStrictEqual([]);
    expect(idle.totals).toBeUndefined();
    expect(idle.label).toBeUndefined();
    expect(idle.title).toBeUndefined();
    expect(idle.hasTotals).toBe(false);
  });

  it("the last shutdown line in a read wins", async () => {
    const first = shutdownEvent({ models: { "model-a": { inputTokens: 1 } } });
    const last = shutdownEvent({ models: { "model-b": { inputTokens: 2 } } });
    await sessionTree(root, [{ id: A, lines: jsonl([first, last]) }]);
    const r = reader();
    const res = await r.open(eventsPath(), await candidate(r)).read();
    const want = parseShutdownLine(JSON.stringify(last), A);
    if (want.kind !== "totals") throw new Error("fixture");
    expect(res.totals).toStrictEqual(want.records);
  });

  it("no label and no title when the key equals nothing to show; a malformed line is counted", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([startEvent({ cwd: "/x/proj" }), usageEvent()]) + `{"type":"session.usage_record",${CANARY}\n` }]);
    const r = reader();
    const res = await r.open(eventsPath(), await candidate(r)).read();
    expect(res.label).toBe("proj");
    expect(res.title).toBeUndefined();
    expect(res.malformed).toBe(1);
    expect(res.records).toHaveLength(1);
    expect(leaks(res)).toBe(false);
  });

  it("with projects and totals off, start and shutdown lines are not decoded", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([startEvent({ cwd: "/x/proj", repository: "o/repo" }), usageEvent(), shutdownEvent()]) }]);
    const r = reader({ readProjects: false, readTotals: false });
    const res = await r.open(eventsPath(), await candidate(r)).read();
    expect(res.label).toBeUndefined();
    expect(res.title).toBeUndefined();
    expect(res.totals).toBeUndefined();
    expect(res.hasTotals).toBe(false);
    expect(res.records).toHaveLength(1);
  });

  it("only the first start line sets the key", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([startEvent({ cwd: "/x/first" }), startEvent({ cwd: "/x/second" })]) }]);
    const r = reader();
    expect((await r.open(eventsPath(), await candidate(r)).read()).label).toBe("first");
  });

  it("an ID-named folder shows the workspace.yaml title; dropping the file clears it", async () => {
    const id = "0123456789abcdef0123";
    await sessionTree(root, [{ id: A, lines: jsonl([startEvent({ cwd: `/x/${id}` }), usageEvent()]) }]);
    const ws = join(root, "session-state", A, "workspace.yaml");
    await writeFile(ws, `cwd: ${CANARY}\nname: Fix bug\n`);
    const r = reader();
    const fr = r.open(eventsPath(), await candidate(r));
    const first = await fr.read();
    expect(first.label).toBe(id);
    expect(first.title).toBe("Fix bug");
    expect(leaks(first)).toBe(false);

    // Unchanged workspace.yaml: no new title on the next moving read.
    await appendFile(eventsPath(), jsonl([usageEvent({ usageId: "u-9", id: "e-9" })]));
    expect((await fr.read()).title).toBeUndefined();

    // A changed name is re-read.
    await writeFile(ws, "name: Second\n");
    await utimes(ws, new Date(NOW + 5000), new Date(NOW + 5000));
    await appendFile(eventsPath(), jsonl([otherEvent("assistant.turn_end")]));
    expect((await fr.read()).title).toBe("Second");

    await unlink(ws);
    await appendFile(eventsPath(), jsonl([otherEvent("assistant.turn_end")]));
    expect((await fr.read()).title).toBeNull();

    // An idle read never touches workspace.yaml: a new file is not seen until the log moves.
    await writeFile(ws, "name: Third\n");
    expect((await fr.read()).title).toBeUndefined();
    await appendFile(eventsPath(), jsonl([otherEvent("assistant.turn_end")]));
    expect((await fr.read()).title).toBe("Third");
  });

  it("an ID-named folder without workspace.yaml falls back to owner/repo", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([startEvent({ cwd: "/x/0123456789abcdef0123", repository: "o/repo" })]) }]);
    const r = reader();
    const res = await r.open(eventsPath(), await candidate(r)).read();
    expect(res.label).toBe("0123456789abcdef0123");
    expect(res.title).toBe("o/repo");
  });

  it.skipIf(process.platform === "win32")("a workspace.yaml that is a symlink is no title (the bounded read refuses non-regular files)", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([startEvent({ cwd: "/x/0123456789abcdef0123" })]) }]);
    const target = join(root, "elsewhere.yaml");
    await writeFile(target, "name: Linked\n");
    await symlink(target, join(root, "session-state", A, "workspace.yaml"));
    const r = reader();
    const res = await r.open(eventsPath(), await candidate(r)).read();
    expect(res.label).toBe("0123456789abcdef0123");
    expect(res.title).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("Linked");
  });

  it("an oversize or non-regular workspace.yaml is no title", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([startEvent({ cwd: "/x/0123456789abcdef0123" })]) }]);
    await writeFile(join(root, "session-state", A, "workspace.yaml"), `name: Big\n${"#".repeat(20_000)}\n`);
    const r = reader();
    expect((await r.open(eventsPath(), await candidate(r)).read()).title).toBeUndefined();
  });

  it("a reset re-derives label and title", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([startEvent({ cwd: "/x/one", repository: "o/one" }), usageEvent()]) }]);
    const r = reader();
    const fr = r.open(eventsPath(), await candidate(r));
    expect((await fr.read()).label).toBe("one");
    await writeFile(eventsPath(), jsonl([startEvent({ cwd: "/x/two" })]));
    const res = await fr.read();
    expect(res.reset).toBe(true);
    expect(res.label).toBe("two");
    expect(res.title).toBeNull();
  });

  it("a vanished file passes ENOENT through", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([usageEvent()]) }]);
    const r = reader();
    const fr = r.open(eventsPath(), await candidate(r));
    await fr.read();
    await unlink(eventsPath());
    expect((await fr.read()).error).toBe("ENOENT");
  });

  it("a custom parse is used for usage lines", async () => {
    await sessionTree(root, [{ id: A, lines: jsonl([usageEvent()]) }]);
    const seen: string[] = [];
    const r = new CopilotSourceReader({
      root,
      rootSource: "setting",
      readProjects: true,
      readTotals: true,
      isLive: dead,
      parse: (line, folderId) => {
        seen.push(folderId);
        return parseUsageLine(line, folderId);
      },
    });
    expect(r.rootSource).toBe("setting");
    await r.open(eventsPath(), await candidate(r)).read();
    expect(seen).toStrictEqual([A]);
  });
});
