// v0.3: project labels, tool use and filtering (D25, D26).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLine, isIdLabel, MAX_START_BYTES, MAX_TITLE_CHARS, parseStartLine, parseUsageLine, parseWorkspaceName } from "../../src/core/extract";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { PANEL_COMMANDS, renderPanelHtml, toolGroup } from "../../src/core/panelHtml";
import { byMonth, NO_PROJECT, projectSummaries, toolSummaries, UsageStore } from "../../src/core/store";
import { LineTailer } from "../../src/core/tailer";
import type { Snapshot, UsageRecord } from "../../src/core/types";
import { CANARY, jsonl, sessionTree, shutdownEvent, usageEvent } from "../fixtures/build";

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

describe("extract: session title for ID-named folders", () => {
  it("isIdLabel: UUIDs and long hex only", () => {
    expect(isIdLabel("a5ba938d-3495-450d-94f0-cdab4c64c501")).toBe(true);
    expect(isIdLabel("0123456789abcdef0123")).toBe(true);
    expect(isIdLabel("dt_cibc_spark_api")).toBe(false);
    expect(isIdLabel("acme/web")).toBe(false);
    expect(isIdLabel("deadbeef")).toBe(false); // too short
    expect(isIdLabel("abcdef-abcdef-abcdef")).toBe(false); // no digit: a word, not an id
  });
  it("parseWorkspaceName: the top-level name only, one line, capped", () => {
    expect(parseWorkspaceName("id: x\ncwd: /srv/secret\nname: Build And Create Zip File\nuser_named: false\n")).toBe("Build And Create Zip File");
    expect(parseWorkspaceName("name: 'it''s quoted'\n")).toBe("it's quoted");
    expect(parseWorkspaceName('name: "say \\"hi\\""\n')).toBe('say "hi"');
    expect(parseWorkspaceName("name: |\n  block\n")).toBeUndefined();
    expect(parseWorkspaceName("  name: nested\n")).toBeUndefined();
    expect(parseWorkspaceName("cwd: /a\n")).toBeUndefined();
    expect(parseWorkspaceName("name:   \n")).toBeUndefined();
    const long = parseWorkspaceName(`name: ${"x".repeat(200)}\n`)!;
    expect(long.length).toBe(MAX_TITLE_CHARS);
    expect(long.endsWith("…")).toBe(true);
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
  return { key, keySource: "usageId", kind: "call", source: "copilot", sessionId: "s1", folderId: "f1", timestampMs: 1000, model: "m", tokens: { input: 100, output: 10 }, nanoAiu: 1e9, ...o };
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

  it("a folder named by an ID shows the session title from workspace.yaml", async () => {
    const C = "0000cccc-0000-4000-8000-000000000003";
    const D = "0000dddd-0000-4000-8000-000000000004";
    await sessionTree(root, [
      { id: C, lines: start({ cwd: `/srv/x/${CANARY}/a5ba938d-3495-450d-94f0-cdab4c64c501` }) + "\n" + usageWithTools({ bash: 1 }, { usageId: "c1", sourceSessionId: C, timestamp: ts(8), totalNanoAiu: 1e9 }) + "\n" },
      { id: D, lines: start({ cwd: "/srv/x/33887a44-aeb6-43ec-b802-689f688a9d41" }) + "\n" + usageWithTools({ bash: 1 }, { usageId: "d1", sourceSessionId: D, timestamp: ts(8), totalNanoAiu: 1e9 }) + "\n" },
    ]);
    await writeFile(join(root, "session-state", C, "workspace.yaml"), `id: ${C}\ncwd: /srv/x/${CANARY}\nname: Fix Login Bug\nbranch: ${CANARY}\n`);
    // D has no workspace.yaml: it keeps the folder name.
    const m = make(true);
    await m.refresh({ full: true });
    // Shown: the title (label) for the ID folder; the key stays the folder name.
    const names = snaps.at(-1)!.month!.projects.map((p) => p.label ?? p.name);
    expect(names).toContain("Fix Login Bug");
    expect(snaps.at(-1)!.month!.projects.find((p) => p.label === "Fix Login Bug")?.name).toBe("a5ba938d-3495-450d-94f0-cdab4c64c501");
    expect(names).toContain("33887a44-aeb6-43ec-b802-689f688a9d41");
    expect(names).toContain("acme/web"); // real names are never replaced
    expect(JSON.stringify(snaps)).not.toContain(CANARY);
  });

  it("readProjects off: workspace.yaml is never read", async () => {
    const C = "0000cccc-0000-4000-8000-000000000003";
    await sessionTree(root, [
      { id: C, lines: start({ cwd: "/srv/x/a5ba938d-3495-450d-94f0-cdab4c64c501" }) + "\n" + usageWithTools({ bash: 1 }, { usageId: "c1", sourceSessionId: C, timestamp: ts(8), totalNanoAiu: 1e9 }) + "\n" },
    ]);
    await writeFile(join(root, "session-state", C, "workspace.yaml"), "name: Fix Login Bug\n");
    const m = make(false);
    await m.refresh({ full: true });
    expect(JSON.stringify(snaps)).not.toContain("Fix Login Bug");
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

  it("session totals: the project filter keeps them, the tool filter drops them (D29)", async () => {
    const L = "0000eeee-0000-4000-8000-000000000005";
    await sessionTree(root, [
      { id: L, lines: start({ cwd: "/srv/x/code/tools-cli" }) + "\n" + jsonl([shutdownEvent({ timestamp: ts(11) })]) },
    ]);
    const m = new UsageMonitor({ root, rootSource: "default", now: () => new Date(now), isLive: () => false, log: new Logger(() => {}), onSnapshot: (x) => snaps.push(x), readProjects: true, readTotals: true });
    await m.refresh({ full: true });
    let s = snaps.at(-1)!;
    expect(s.month!.projects.find((p) => p.name === "tools-cli")).toMatchObject({ sessions: 2, calls: 7 });
    m.setFilter({ project: "tools-cli" });
    await m.refresh();
    s = snaps.at(-1)!;
    expect(s.month!.totals).toMatchObject({ records: 2, calls: 7, sessionTotals: 1 });
    expect(s.month!.sessions.map((x) => x.sessionId).sort()).toEqual([B, L].sort());
    m.setFilter({ tool: "view" });
    await m.refresh();
    s = snaps.at(-1)!;
    expect(s.month!.totals).toMatchObject({ records: 1, calls: 1, sessionTotals: 0 });
    expect(s.month!.sessions.map((x) => x.sessionId)).toEqual([B]);
    expect(s.today!.sessionTotals).toBe(1); // Today ignores the filter
  });
});

describe("panel: project and tool tables", () => {
  const m = (sum: number, reported: number) => ({ sum, reported, missing: 0 });
  const base = (): Snapshot => ({
    generatedAtMs: 0,
    dayStartMs: new Date(2026, 10, 5).getTime(),
    sessions: [],
    health: { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0 },
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
    const html = renderPanelHtml(base(), "x", undefined, "projects") + renderPanelHtml(base(), "x", undefined, "tools");
    expect(html).toContain("By project");
    expect(html).toContain("By tool");
    expect(html).toContain(`href="command:copilotUsageMonitor.setFilter?${encodeURIComponent(JSON.stringify(["project", "acme/web"])).replace(/&/g, "&amp;")}"`);
    expect(html).toContain("built-in");
    expect(html).toContain("1 added tool");
    expect(html).not.toContain("<img");
    for (const h of [...html.matchAll(/href="command:([\w.]+)\?/g)].map((x) => x[1])) expect(PANEL_COMMANDS as readonly string[]).toContain(h);
  });

  it("active filter: chips with clear links, active row highlighted, trend marked filtered", () => {
    const f = { ...base(), filter: { project: "acme/web", tool: "bash" } };
    // Chips are chrome: on every section.
    for (const section of ["overview", "projects", "health"] as const) {
      const html = renderPanelHtml(f, "x", undefined, section);
      expect(html).toMatch(/class="fchip"[^>]*aria-label="Clear project filter: acme\/web">Project: <b>acme\/web<\/b><span aria-hidden="true"> ✕<\/span>/);
      expect(html).toMatch(/class="fchip"[^>]*aria-label="Clear tool filter: bash">Tool: <b>bash<\/b><span aria-hidden="true"> ✕<\/span>/);
      expect(html).toContain(encodeURIComponent(JSON.stringify(["project", ""])));
      expect(html).toContain("Today, the last 7 days, daily activity and the status bar are not filtered.");
    }
    const rows = renderPanelHtml(f, "x", undefined, "projects") + renderPanelHtml(f, "x", undefined, "tools");
    expect(rows.match(/<tr class="on">/g)).toHaveLength(2);
    expect(renderPanelHtml(f, "x")).toContain("· filtered ·");
  });
});

describe("panel: long lists fold (D27)", () => {
  const m = (sum: number, reported: number) => ({ sum, reported, missing: 0 });
  const tool = (name: string, i: number) => ({ name, builtIn: false, uses: 1, calls: 1, tokens: m(100 - i, 1), nanoAiu: m((100 - i) * 1e9, 1) });
  const snap = (filter?: { tool?: string }): Snapshot => ({
    generatedAtMs: 0,
    dayStartMs: new Date(2026, 10, 5).getTime(),
    sessions: [],
    health: { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0 },
    month: {
      monthStartMs: new Date(2026, 10, 1).getTime(),
      isCurrent: true,
      days: [],
      sessions: [],
      projects: Array.from({ length: 4 }, (_, i) => ({ name: `p${i}`, sessions: 1, calls: 1, tokens: m(1, 1), nanoAiu: m(1, 1) })),
      tools: [
        ...Array.from({ length: 14 }, (_, i) => tool(`github-mcp-server/t${i}`, i)),
        ...Array.from({ length: 11 }, (_, i) => tool(`mcp__jira__t${i}`, 20 + i)),
      ],
    },
    ...(filter && { filter }),
  });

  it("shows 10 rows, folds the rest into a script-free details", () => {
    const html = renderPanelHtml(snap(), "x", undefined, "tools");
    const tools = html.slice(html.indexOf("By tool"));
    const [visible, folded] = tools.split('<details class="more">');
    expect(visible!.match(/<tr>/g)!.length - 1).toBe(10); // minus the header row
    expect(folded).toContain("<summary>Show 15 more</summary>");
    expect(folded!.match(/<tr>/g)!.length - 1).toBe(15);
    expect(html).not.toMatch(/<script/i);
    // short lists do not fold
    const projects = renderPanelHtml(snap(), "x", undefined, "projects");
    expect(projects.slice(projects.indexOf("By project"))).not.toContain("<details");
  });

  it("an active filter row beyond the top 10 stays visible", () => {
    const html = renderPanelHtml(snap({ tool: "mcp__jira__t9" }), "x", undefined, "tools");
    const tools = html.slice(html.indexOf("By tool"));
    const [visible, folded] = tools.split('<details class="more">');
    expect(visible).toContain("mcp__jira__t9");
    expect(visible).toContain('<tr class="on">');
    expect(folded).toContain("<summary>Show 14 more</summary>");
    expect(folded).not.toContain("mcp__jira__t9");
  });

  it("added tools are summarised per server or plugin", () => {
    const html = renderPanelHtml(snap(), "x", undefined, "tools");
    expect(html).toContain("25 added tools from 2 servers or plugins: github-mcp-server (14 tools, 14 uses), jira (11 tools, 11 uses).");
  });
});

describe("toolGroup", () => {
  it.each([
    ["github-mcp-server/get_issue", "github-mcp-server"],
    ["mcp__jira__create_issue", "jira"],
    ["playwright-browser_click", "playwright"],
    ["sentry_list_issues", "sentry"],
    ["bash", "bash"],
  ])("%s → %s", (name, group) => {
    expect(toolGroup(name)).toBe(group);
  });
});

describe("monitor: last month's projects and tools for the change column (v0.6, 2.1)", () => {
  const A = "0000aaaa-0000-4000-8000-000000000001";
  const B = "0000bbbb-0000-4000-8000-000000000002";
  let root: string;
  let snaps: Snapshot[];
  const now = new Date(2026, 10, 6, 12).getTime();
  const at = (mo: number, d: number, h = 9) => new Date(2026, mo, d, h).toISOString();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cum-delta-"));
    snaps = [];
    await sessionTree(root, [
      {
        id: A,
        lines:
          start({ repository: "acme/web" }) + "\n" +
          usageWithTools({ bash: 2 }, { usageId: "o1", id: "e1", sourceSessionId: A, timestamp: at(9, 3), totalNanoAiu: 4e9 }) + "\n" +
          // after "this point" (Oct 6 12:00): outside the same-point window
          usageWithTools({ bash: 1 }, { usageId: "o2", id: "e2", sourceSessionId: A, timestamp: at(9, 6, 13), totalNanoAiu: 8e9 }) + "\n" +
          usageWithTools({ view: 1 }, { usageId: "n1", id: "e3", sourceSessionId: A, timestamp: at(10, 2), totalNanoAiu: 1e9 }) + "\n",
      },
      { id: B, lines: start({ cwd: "/srv/x/code/tools-cli" }) + "\n" + usageWithTools({ view: 1 }, { usageId: "b1", sourceSessionId: B, timestamp: at(9, 4), totalNanoAiu: 2e9 }) + "\n" },
    ]);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const make = (historyMonths = 2) =>
    new UsageMonitor({ root, rootSource: "default", now: () => new Date(now), isLive: () => false, log: new Logger(() => {}), onSnapshot: (s) => snaps.push(s), readProjects: true, historyMonths });

  it("current month: last month up to the same point, per project and per tool", async () => {
    const m = make();
    await m.refresh({ full: true });
    const p = snaps.at(-1)!.month!.prior!;
    expect(p.projects!.map((g) => [g.name, g.nanoAiu.sum])).toEqual([["acme/web", 4e9], ["tools-cli", 2e9]]);
    expect(p.tools!.map((t) => [t.name, t.nanoAiu.sum])).toEqual([["bash", 4e9], ["view", 2e9]]);
    expect(p.totals!.byModel["model-a"]!.nanoAiu.sum).toBe(6e9);
  });

  it("filters: projects honour the tool filter only, tools the project filter only, models both", async () => {
    const m = make();
    await m.refresh({ full: true });
    m.setFilter({ project: "acme/web" });
    await m.refresh();
    let p = snaps.at(-1)!.month!.prior!;
    expect(p.projects!.map((g) => g.name)).toEqual(["acme/web", "tools-cli"]);
    expect(p.tools!.map((t) => t.name)).toEqual(["bash"]);
    expect(p.totals!.nanoAiu.sum).toBe(4e9);
    m.setFilter({ tool: "view" });
    await m.refresh();
    p = snaps.at(-1)!.month!.prior!;
    expect(p.projects!.map((g) => g.name)).toEqual(["tools-cli"]);
    expect(p.tools!.map((t) => t.name)).toEqual(["bash", "view"]);
  });

  it("a past month compares with the whole month before; none outside historyMonths", async () => {
    const m = make(3);
    m.selectMonth(new Date(2026, 9, 1).getTime());
    await m.refresh({ full: true });
    const p = snaps.at(-1)!.month!.prior!;
    expect(p.projects).toEqual([]);
    expect(p.tools).toEqual([]);
    const one = make(1);
    await one.refresh({ full: true });
    expect(snaps.at(-1)!.month!.prior).toBeUndefined();
  });
});
