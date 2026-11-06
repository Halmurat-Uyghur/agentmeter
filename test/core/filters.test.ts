// v0.3: project labels, tool use and filtering (D25, D26).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLine, MAX_START_BYTES, parseStartLine, parseUsageLine } from "../../src/core/extract";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { PANEL_COMMANDS, renderPanelHtml } from "../../src/core/panelHtml";
import { byMonth, NO_PROJECT, projectSummaries, toolSummaries, UsageStore } from "../../src/core/store";
import { LineTailer } from "../../src/core/tailer";
import type { Snapshot, UsageRecord } from "../../src/core/types";
import { CANARY, jsonl, sessionTree, usageEvent } from "../fixtures/build";

const start = (context: object, extra: object = {}) =>
  JSON.stringify({ type: "session.start", id: "s", parentId: null, timestamp: "2026-01-15T10:00:00.000Z", data: { copilotVersion: "1.0.100-1", context, prompt: CANARY, ...extra } });

function usageWithTools(tools: unknown, o: Parameters<typeof usageEvent>[0] = {}): string {
  const e = usageEvent(o) as { data: { usage: Record<string, unknown> } };
  e.data.usage.toolCounts = tools;
  return JSON.stringify(e);
}

describe("extract: session.start → project label only", () => {
  it("gate: start lines are their own class; huge ones are skipped", () => {
    const line = Buffer.from(start({ cwd: "/x/y" }));
    expect(classifyLine(line, 0, line.length)).toBe("start");
    const big = Buffer.from(start({ cwd: "/x/y" }, { pad: "a".repeat(MAX_START_BYTES) }));
    expect(classifyLine(big, 0, big.length)).toBe("skip");
  });

  it("prefers a well-formed repository, else the folder name; never a path", () => {
    expect(parseStartLine(start({ repository: "acme/web", cwd: "/srv/h/acme-web" }))).toBe("acme/web");
    expect(parseStartLine(start({ repository: "not a repo", gitRoot: "/srv/u/code/billing-api", cwd: "/srv/u/code/billing-api/src" }))).toBe("billing-api");
    expect(parseStartLine(start({ cwd: "C:\\Users\\u\\proj\\desk-app" }))).toBe("desk-app");
    expect(parseStartLine(start({ cwd: "/" }))).toBeUndefined();
    expect(parseStartLine(start({ cwd: "/a/<script>" }))).toBeUndefined();
    expect(parseStartLine(start({}))).toBeUndefined();
    expect(parseStartLine("{not json")).toBeUndefined();
    expect(parseStartLine(JSON.stringify({ type: "session.resume", data: { context: { repository: "a/b" } } }))).toBeUndefined();
    const label = parseStartLine(start({ cwd: "/srv/someone/secret/proj" }))!;
    expect(label).toBe("proj");
    expect(label).not.toContain("/");
  });
});

describe("extract: toolCounts", () => {
  it("keeps positive integer counts for identifier-like names", () => {
    const p = parseUsageLine(usageWithTools({ bash: 3, "github-mcp-server/get_issue": 1, view: 0, "bad name<": 2, rg: -1, edit: 1.5 }), "f");
    expect(p.kind).toBe("usage");
    if (p.kind === "usage") expect(p.record.tools).toEqual({ bash: 3, "github-mcp-server/get_issue": 1 });
  });

  it("absent, empty or wrong-typed toolCounts leaves tools undefined", () => {
    for (const t of [undefined, {}, [], "bash", { view: 0 }]) {
      const p = parseUsageLine(usageWithTools(t), "f");
      if (p.kind === "usage") expect(p.record.tools).toBeUndefined();
    }
  });

  it("caps the number of tools kept", () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`t${i}`, 1]));
    const p = parseUsageLine(usageWithTools(many), "f");
    if (p.kind === "usage") expect(Object.keys(p.record.tools!)).toHaveLength(64);
  });
});

describe("tailer: start lines only when asked", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cum-tail-start-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("decodeStart false (default) never returns them", async () => {
    const f = join(dir, "events.jsonl");
    await writeFile(f, start({ cwd: "/p/q" }) + "\n" + usageWithTools({ bash: 1 }) + "\n");
    expect((await new LineTailer(f).read()).startLines).toEqual([]);
    const on = await new LineTailer(f, { decodeStart: true }).read();
    expect(on.startLines).toHaveLength(1);
    expect(on.usageLines).toHaveLength(1);
  });
});

function rec(key: string, o: Partial<UsageRecord> = {}): UsageRecord {
  return { key, keySource: "usageId", sessionId: "s1", folderId: "f1", timestampMs: 1000, model: "m", tokens: { input: 100, output: 10 }, nanoAiu: 1e9, ...o };
}

describe("store: projects and tools", () => {
  const st = new UsageStore();
  st.add(rec("a", { folderId: "fa", sessionId: "sa", nanoAiu: 5e9, tools: { bash: 2, "mcp/x": 1 } }), "f");
  st.add(rec("b", { folderId: "fa", sessionId: "sa2", nanoAiu: 1e9, tools: { bash: 1 } }), "f");
  st.add(rec("c", { folderId: "fb", sessionId: "sb", nanoAiu: 2e9 }), "f");
  const projects = new Map([["fa", "acme/web"]]);
  const projectOf = (r: UsageRecord) => projects.get(r.folderId) ?? NO_PROJECT;

  it("projectSummaries: sessions, calls, cost; unknown folder is (no project)", () => {
    const p = projectSummaries(st, 0, Infinity, projectOf);
    expect(p.map((x) => [x.name, x.sessions, x.calls, x.nanoAiu.sum])).toEqual([
      ["acme/web", 2, 2, 6e9],
      [NO_PROJECT, 1, 1, 2e9],
    ]);
  });

  it("toolSummaries: uses, calls that used it, built-in vs added", () => {
    const t = toolSummaries(st, 0, Infinity);
    expect(t.map((x) => [x.name, x.builtIn, x.uses, x.calls, x.nanoAiu.sum])).toEqual([
      ["bash", true, 3, 2, 6e9],
      ["mcp/x", false, 1, 1, 5e9],
    ]);
  });

  it("filters apply to month buckets", () => {
    const h = byMonth(st, [0], (r) => (r.tools?.["mcp/x"] ?? 0) > 0);
    expect(h[0]!.totals!.records).toBe(1);
  });
});

describe("monitor: project labels and filters", () => {
  const A = "0000aaaa-0000-4000-8000-000000000001";
  const B = "0000bbbb-0000-4000-8000-000000000002";
  let root: string;
  let snaps: Snapshot[];
  const now = new Date(2026, 0, 15, 12).getTime();
  const ts = (h: number) => new Date(2026, 0, 15, h).toISOString();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cum-filters-"));
    snaps = [];
    await sessionTree(root, [
      { id: A, lines: start({ repository: "acme/web", cwd: `/srv/x/${CANARY}/web` }) + "\n" + jsonl([]) + usageWithTools({ bash: 2, "github-mcp/get_pr": 1 }, { usageId: "a1", sourceSessionId: A, timestamp: ts(9), totalNanoAiu: 4e9 }) + "\n" + usageWithTools({ bash: 1 }, { usageId: "a2", id: "e2", sourceSessionId: A, timestamp: ts(10), totalNanoAiu: 1e9 }) + "\n" },
      { id: B, lines: start({ cwd: "/srv/x/code/tools-cli" }) + "\n" + usageWithTools({ view: 1 }, { usageId: "b1", sourceSessionId: B, timestamp: ts(11), totalNanoAiu: 2e9 }) + "\n" },
    ]);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const make = (readProjects: boolean) =>
    new UsageMonitor({ root, rootSource: "default", now: () => new Date(now), isLive: () => false, log: new Logger(() => {}), onSnapshot: (s) => snaps.push(s), readProjects });

  it("labels projects; never keeps the path or other start fields", async () => {
    const m = make(true);
    await m.refresh({ full: true });
    const s = snaps.at(-1)!;
    expect(s.month!.projects.map((p) => [p.name, p.calls])).toEqual([["acme/web", 2], ["tools-cli", 1]]);
    expect(s.month!.tools.map((t) => [t.name, t.uses])).toEqual([["bash", 3], ["github-mcp/get_pr", 1], ["view", 1]]);
    const json = JSON.stringify(snaps);
    expect(json).not.toContain(CANARY);
    expect(json).not.toContain("/srv/");
  });

  it("readProjects off: every call is (no project)", async () => {
    const m = make(false);
    await m.refresh({ full: true });
    expect(snaps.at(-1)!.month!.projects.map((p) => p.name)).toEqual([NO_PROJECT]);
  });

  it("project filter narrows the month, trend and tool table; today stays whole", async () => {
    const m = make(true);
    await m.refresh({ full: true });
    m.setFilter({ project: "tools-cli" });
    await m.refresh();
    const s = snaps.at(-1)!;
    expect(s.filter).toEqual({ project: "tools-cli" });
    expect(s.month!.totals!.records).toBe(1);
    expect(s.history!.at(-1)!.totals!.records).toBe(1);
    expect(s.month!.tools.map((t) => t.name)).toEqual(["view"]);
    expect(s.month!.projects).toHaveLength(2); // the project table ignores its own filter
    expect(s.today!.records).toBe(3);
  });

  it("tool filter keeps calls that used the tool; clearing restores", async () => {
    const m = make(true);
    await m.refresh({ full: true });
    m.setFilter({ tool: "github-mcp/get_pr" });
    await m.refresh();
    let s = snaps.at(-1)!;
    expect(s.month!.totals!.records).toBe(1);
    expect(s.month!.totals!.nanoAiu.sum).toBe(4e9);
    expect(s.month!.projects.map((p) => p.name)).toEqual(["acme/web"]);
    expect(s.month!.sessions.map((x) => x.sessionId)).toEqual([A]);
    m.setFilter({});
    await m.refresh();
    s = snaps.at(-1)!;
    expect(s.filter).toBeUndefined();
    expect(s.month!.totals!.records).toBe(3);
  });
});

describe("panel: project and tool tables", () => {
  const m = (sum: number, reported: number) => ({ sum, reported, missing: 0 });
  const base = (): Snapshot => ({
    generatedAtMs: 0,
    dayStartMs: new Date(2026, 10, 5).getTime(),
    sessions: [],
    health: { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, unreadableFiles: 0, sessionsWithoutUsage: 0 },
    month: {
      monthStartMs: new Date(2026, 10, 1).getTime(),
      isCurrent: true,
      days: [],
      sessions: [],
      projects: [
        { name: "acme/web", sessions: 2, calls: 5, tokens: m(1000, 5), nanoAiu: m(3e9, 5) },
        { name: NO_PROJECT, sessions: 1, calls: 1, tokens: m(10, 1), nanoAiu: m(1e9, 1) },
      ],
      tools: [
        { name: "bash", builtIn: true, uses: 9, calls: 4, tokens: m(900, 4), nanoAiu: m(2e9, 4) },
        { name: `evil<img src=x>${CANARY}`, builtIn: false, uses: 1, calls: 1, tokens: m(5, 1), nanoAiu: m(1e9, 1) },
      ],
    },
    history: [{ monthStartMs: new Date(2026, 10, 1).getTime() }],
  });

  it("rows link to setFilter; only allowlisted commands; names escaped", () => {
    const html = renderPanelHtml(base(), "x");
    expect(html).toContain("By project");
    expect(html).toContain("By tool");
    expect(html).toContain(`href="command:copilotUsageMonitor.setFilter?${encodeURIComponent(JSON.stringify(["project", "acme/web"])).replace(/&/g, "&amp;")}"`);
    expect(html).toContain("built-in");
    expect(html).toContain("1 added tool");
    expect(html).not.toContain("<img");
    for (const h of [...html.matchAll(/href="command:([\w.]+)\?/g)].map((x) => x[1])) expect(PANEL_COMMANDS as readonly string[]).toContain(h);
  });

  it("active filter: chips with clear links, active row highlighted, trend marked filtered", () => {
    const html = renderPanelHtml({ ...base(), filter: { project: "acme/web", tool: "bash" } }, "x");
    expect(html).toMatch(/class="fchip"[^>]*>Project: <b>acme\/web<\/b> ✕/);
    expect(html).toMatch(/class="fchip"[^>]*>Tool: <b>bash<\/b> ✕/);
    expect(html).toContain(encodeURIComponent(JSON.stringify(["project", ""])));
    expect(html.match(/<tr class="on">/g)).toHaveLength(2);
    expect(html).toContain("· filtered ·");
    expect(html).toContain("Today and the status bar are not filtered.");
  });
});
