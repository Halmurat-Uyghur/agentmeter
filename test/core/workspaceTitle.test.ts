// v0.3.2 review: extra coverage for session titles on ID-named folders.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIdLabel, MAX_TITLE_CHARS, parseWorkspaceName } from "../../src/core/extract";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { renderPanelHtml } from "../../src/core/panelHtml";
import type { Snapshot } from "../../src/core/types";
import { CANARY, sessionTree, usageEvent } from "../fixtures/build";

const start = (context: object) =>
  JSON.stringify({ type: "session.start", id: "s", parentId: null, timestamp: "2026-01-15T10:00:00.000Z", data: { copilotVersion: "1.0.100-1", context, prompt: CANARY } });
const usage = (o: Parameters<typeof usageEvent>[0]) => JSON.stringify(usageEvent(o));
const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("parseWorkspaceName: edge cases", () => {
  it("YAML null / empty scalars are not titles", () => {
    expect(parseWorkspaceName("name: null\n")).toBeUndefined();
    expect(parseWorkspaceName("name: ~\n")).toBeUndefined();
    expect(parseWorkspaceName("name: ''\n")).toBeUndefined();
    expect(parseWorkspaceName('name: ""\n')).toBeUndefined();
  });
  it("truncation never splits a surrogate pair", () => {
    const t = parseWorkspaceName(`name: ${"x".repeat(MAX_TITLE_CHARS - 2)}\u{1F600}${"y".repeat(20)}\n`)!;
    expect(hasLoneSurrogate(t)).toBe(false);
  });
  it("bidi overrides and zero-width characters are removed", () => {
    const t = parseWorkspaceName("name: abc‮def​ghi\n")!;
    expect(t).not.toMatch(/[​-‏‪-‮⁦-⁩﻿]/);
  });
  it("CRLF line endings are handled", () => {
    expect(parseWorkspaceName("name: Fix bug\r\n")).toBe("Fix bug");
  });
  it("a YAML trailing comment is not part of the title", () => {
    expect(parseWorkspaceName("name: Fix bug # note\n")).toBe("Fix bug");
  });
  it("a quoted value keeps a # inside the quotes and drops a comment after them", () => {
    expect(parseWorkspaceName("name: 'Fix #42' # note\n")).toBe("Fix #42");
    expect(parseWorkspaceName('name: "Fix #42"  # note\n')).toBe("Fix #42");
    expect(parseWorkspaceName("name: Fix#42\n")).toBe("Fix#42"); // no whitespace before #: not a comment
    expect(parseWorkspaceName("name: # only a comment\n")).toBeUndefined();
  });
  it("other format (Cf) characters are removed and whitespace collapsed", () => {
    expect(parseWorkspaceName("name: ⁦a⁩ ­ b⁠c ﻿\n")).toBe("a bc");
  });
  it("only the first top-level name: line is used", () => {
    expect(parseWorkspaceName("summary: x\nname: First\nname: Second\n")).toBe("First");
  });
  it("isIdLabel: exact length bounds", () => {
    expect(isIdLabel("0123456789abcde")).toBe(false); // 15
    expect(isIdLabel("0123456789abcdef")).toBe(true); // 16
    expect(isIdLabel("a".repeat(63) + "1")).toBe(true); // 64
    expect(isIdLabel("a".repeat(64) + "1")).toBe(false); // 65
  });
  it("isIdLabel: all-digit names (build / ticket numbers) are not IDs", () => {
    expect(isIdLabel("1234567890123456")).toBe(false);
    expect(isIdLabel("2026-1105-1234-5678")).toBe(false);
    expect(isIdLabel("123456789012345a")).toBe(true);
  });
});

describe("monitor: session title lifecycle", () => {
  const C = "0000cccc-0000-4000-8000-000000000003";
  const D = "0000dddd-0000-4000-8000-000000000004";
  const E = "0000eeee-0000-4000-8000-000000000005";
  const ID1 = "a5ba938d-3495-450d-94f0-cdab4c64c501";
  const ID2 = "33887a44-aeb6-43ec-b802-689f688a9d41";
  let root: string;
  let snaps: Snapshot[];
  const now = new Date(2026, 0, 15, 12).getTime();
  const ts = (h: number) => new Date(2026, 0, 15, h).toISOString();
  const make = () =>
    new UsageMonitor({ root, rootSource: "default", now: () => new Date(now), isLive: () => false, log: new Logger(() => {}), onSnapshot: (s) => snaps.push(s), readProjects: true });
  /** What the "By project" table shows: the display label (title) else the key (folder). */
  const names = () => snaps.at(-1)!.month!.projects.map((p) => [p.label ?? p.name, p.sessions]);
  const keys = () => snaps.at(-1)!.month!.projects.map((p) => p.name);
  /** The Projects section, where the project rows and (as chrome) the filter chips are. */
  const html = () => renderPanelHtml(snaps.at(-1)!, "x", undefined, "projects");
  const ws = (id: string) => join(root, "session-state", id, "workspace.yaml");
  const ev = (id: string) => join(root, "session-state", id, "events.jsonl");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cum-title-"));
    snaps = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("non-ID folder ignores workspace.yaml", async () => {
    await sessionTree(root, [{ id: C, lines: start({ cwd: "/srv/x/tools-cli" }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" }]);
    await writeFile(ws(C), "name: Should Not Show\n");
    await make().refresh({ full: true });
    expect(names()).toEqual([["tools-cli", 1]]);
  });

  it("oversize or symlinked workspace.yaml falls back to the folder name", async () => {
    await sessionTree(root, [
      { id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" },
      { id: D, lines: start({ cwd: `/srv/x/${ID2}` }) + "\n" + usage({ usageId: "d1", sourceSessionId: D, timestamp: ts(8) }) + "\n" },
    ]);
    await writeFile(ws(C), `name: Big\nsummary: ${"z".repeat(17 * 1024)}\n`);
    const target = join(root, "elsewhere.yaml");
    await writeFile(target, "name: Via Symlink\n");
    await symlink(target, ws(D));
    await make().refresh({ full: true });
    expect(names().map((n) => n[0]).sort()).toEqual([ID2, ID1].sort());
  });

  it("rename is picked up once the log moves", async () => {
    await sessionTree(root, [{ id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" }]);
    await writeFile(ws(C), "name: Old Title\n");
    const m = make();
    await m.refresh({ full: true });
    expect(names()).toEqual([["Old Title", 1]]);
    await writeFile(ws(C), "name: New Title\n");
    await utimes(ws(C), new Date(now + 5000), new Date(now + 5000));
    await appendFile(ev(C), usage({ usageId: "c2", id: "e2", sourceSessionId: C, timestamp: ts(9) }) + "\n");
    await m.refresh();
    expect(names()).toEqual([["New Title", 1]]);
  });

  it("deleted workspace.yaml drops the stale title once the log moves", async () => {
    await sessionTree(root, [{ id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" }]);
    await writeFile(ws(C), "name: Old Title\n");
    const m = make();
    await m.refresh({ full: true });
    await unlink(ws(C));
    await appendFile(ev(C), usage({ usageId: "c2", id: "e2", sourceSessionId: C, timestamp: ts(9) }) + "\n");
    await m.refresh();
    expect(names()).toEqual([[ID1, 1]]);
  });

  it("two sessions in the SAME ID folder stay one project row", async () => {
    await sessionTree(root, [
      { id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" },
      { id: D, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "d1", sourceSessionId: D, timestamp: ts(9) }) + "\n" },
    ]);
    await writeFile(ws(C), "name: Fix Login Bug\n");
    await writeFile(ws(D), "name: Refactor auth\n");
    await make().refresh({ full: true });
    expect(names()).toHaveLength(1);
  });

  it("a title equal to a real repository name does not merge into that repo's row", async () => {
    await sessionTree(root, [
      { id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" },
      { id: E, lines: start({ repository: "acme/web", cwd: "/srv/x/web" }) + "\n" + usage({ usageId: "e1", sourceSessionId: E, timestamp: ts(9) }) + "\n" },
    ]);
    await writeFile(ws(C), "name: acme/web\n");
    await make().refresh({ full: true });
    expect(names()).toHaveLength(2);
  });

  it("a two-session ID folder is labelled with its most recently active session's title", async () => {
    await sessionTree(root, [
      { id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" },
      { id: D, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "d1", sourceSessionId: D, timestamp: ts(9) }) + "\n" },
    ]);
    await writeFile(ws(C), "name: Fix Login Bug\n");
    await writeFile(ws(D), "name: Refactor auth\n");
    await make().refresh({ full: true });
    expect(names()).toEqual([["Refactor auth", 2]]);
    expect(keys()).toEqual([ID1]);
    expect(html()).toContain(">Refactor auth</a>");
  });

  it("the acme/web filter matches the real repo only, never a session titled acme/web", async () => {
    await sessionTree(root, [
      { id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" },
      { id: E, lines: start({ repository: "acme/web", cwd: "/srv/x/web" }) + "\n" + usage({ usageId: "e1", sourceSessionId: E, timestamp: ts(9) }) + "\n" },
    ]);
    await writeFile(ws(C), "name: acme/web\n");
    const m = make();
    await m.refresh({ full: true });
    expect(keys().sort()).toEqual([ID1, "acme/web"].sort());
    m.setFilter({ project: "acme/web" });
    await m.refresh();
    expect(snaps.at(-1)!.month!.totals?.records).toBe(1);
    expect(snaps.at(-1)!.month!.sessions.map((x) => x.sessionId)).toEqual([E]);
  });

  it("two different ID folders with the same title stay two rows", async () => {
    await sessionTree(root, [
      { id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" },
      { id: D, lines: start({ cwd: `/srv/x/${ID2}` }) + "\n" + usage({ usageId: "d1", sourceSessionId: D, timestamp: ts(9) }) + "\n" },
    ]);
    await writeFile(ws(C), "name: Same Title\n");
    await writeFile(ws(D), "name: Same Title\n");
    await make().refresh({ full: true });
    expect(names()).toEqual([["Same Title", 1], ["Same Title", 1]]);
    expect(keys().sort()).toEqual([ID1, ID2].sort());
  });

  it("filtering by an ID folder uses its key; the chip and table show the title", async () => {
    await sessionTree(root, [
      { id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" },
      { id: E, lines: start({ repository: "acme/web", cwd: "/srv/x/web" }) + "\n" + usage({ usageId: "e1", sourceSessionId: E, timestamp: ts(9) }) + "\n" },
    ]);
    await writeFile(ws(C), "name: Fix Login Bug\n");
    const m = make();
    await m.refresh({ full: true });
    // The row shows the title but its link filters by the folder key.
    expect(html()).toContain(`${encodeURIComponent(JSON.stringify(["project", ID1]))}" aria-label="Fix Login Bug. Show only this project" title="Show only this project">Fix Login Bug</a>`);
    m.setFilter({ project: ID1 });
    await m.refresh();
    expect(snaps.at(-1)!.month!.totals?.records).toBe(1);
    expect(html()).toContain("Project: <b>Fix Login Bug</b>");
  });

  it("a renamed title keeps an active ID-folder filter matching", async () => {
    await sessionTree(root, [{ id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" }]);
    await writeFile(ws(C), "name: Old Title\n");
    const m = make();
    await m.refresh({ full: true });
    m.setFilter({ project: ID1 });
    await m.refresh();
    await writeFile(ws(C), "name: New Title\n");
    await utimes(ws(C), new Date(now + 5000), new Date(now + 5000));
    await appendFile(ev(C), usage({ usageId: "c2", id: "e2", sourceSessionId: C, timestamp: ts(9) }) + "\n");
    await m.refresh();
    expect(snaps.at(-1)!.month!.totals?.records).toBe(2);
    expect(names()).toEqual([["New Title", 1]]);
  });

  it("a workspace.yaml that grows past the limit drops the stale title", async () => {
    await sessionTree(root, [{ id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" }]);
    await writeFile(ws(C), "name: Old Title\n");
    const m = make();
    await m.refresh({ full: true });
    expect(names()).toEqual([["Old Title", 1]]);
    await writeFile(ws(C), `name: Old Title\nsummary: ${"z".repeat(17 * 1024)}\n`);
    await appendFile(ev(C), usage({ usageId: "c2", id: "e2", sourceSessionId: C, timestamp: ts(9) }) + "\n");
    await m.refresh();
    expect(names()).toEqual([[ID1, 1]]);
  });

  it("a workspace.yaml replaced by a symlink drops the stale title", async () => {
    await sessionTree(root, [{ id: C, lines: start({ cwd: `/srv/x/${ID1}` }) + "\n" + usage({ usageId: "c1", sourceSessionId: C, timestamp: ts(8) }) + "\n" }]);
    await writeFile(ws(C), "name: Old Title\n");
    const m = make();
    await m.refresh({ full: true });
    const target = join(root, "elsewhere.yaml");
    await writeFile(target, "name: Via Symlink\n");
    await unlink(ws(C));
    await symlink(target, ws(C));
    await appendFile(ev(C), usage({ usageId: "c2", id: "e2", sourceSessionId: C, timestamp: ts(9) }) + "\n");
    await m.refresh();
    expect(names()).toEqual([[ID1, 1]]);
  });
});
