// Extension-host smoke tests (Mocha, run by `npm run test:integration`).
// COPILOT_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME point at synthetic fixture roots (see .vscode-test.mjs).
import * as assert from "node:assert";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { CANARY, jsonl, sessionTree, usageEvent } from "../fixtures/build";
import { CLAUDE_SESSION, claudeAssistantLine, claudeTree } from "../fixtures/claude";
import { CODEX_SESSION, codexMeta, codexRecord, codexTree, codexTurn } from "../fixtures/codex";

const ROOT = join(tmpdir(), "agentmeter-fixture");
const CLAUDE_ROOT = join(tmpdir(), "agentmeter-fixture-claude");
const CODEX_ROOT = join(tmpdir(), "agentmeter-fixture-codex");
const LIVE = "0000aaaa-0000-4000-8000-000000000001";

interface SidebarRow {
  id: string;
  label: string;
  value: string;
  spoken: string;
  link?: { command: string; args: string[] };
}

interface TestState {
  statusText: string;
  tooltip: string;
  statusA11y: string;
  panelOpen: boolean;
  panelTitle?: string;
  panelSection: string;
  panelPalette: string;
  prefs: { currency: string; statusBar: string; targets: { dayMax?: number; weekMax?: number; monthMin?: number; monthMax?: number }; targetAlert: boolean; unsaved: string[] };
  view: { unit: string; statusBar?: string; dayTarget?: { max?: number }; weekTarget?: { max?: number } };
  panelRenders: number;
  panelActive: boolean;
  panelHeld: boolean;
  sidebar: {
    visible: boolean;
    renders: number;
    state: string;
    unitWord: string;
    html?: string;
    folders: string[];
    options?: { enableScripts?: boolean; enableForms?: boolean; enableCommandUris?: boolean | string[]; localResourceRoots?: string[] };
    rows: SidebarRow[];
    groups: string[];
  };
  snapshot?: {
    filter?: { project?: string; tool?: string; source?: string };
    today?: { bySource?: Record<string, unknown> };
    health?: { sources?: Record<string, { state: string }> };
  };
}

const SIDEBAR_COMMANDS = ["copilotUsageMonitor.showDetails", "copilotUsageMonitor.showSection", "copilotUsageMonitor.setFilter", "copilotUsageMonitor.toggleUnit", "copilotUsageMonitor.selectCurrency"];
const row = (s: TestState, id: string) => s.sidebar.rows.find((i) => i.id === id);
/** The status bar figure in tokens view: "$(pulse) Local today: 1.2K tok" → "1.2K tok". */
const statusFigure = (s: TestState) => s.statusText.replace(/^\$\([a-z-]+\) Local today: /, "");
/** The value cell of a row in the last drawn HTML: the escaped figure after its label. */
const drawn = (s: TestState, label: string) =>
  new RegExp(`<span class="l">${label}</span>(?:<span class="mk[^"]*">[^<]*</span>)?<span class="v">((?:[^<]|<span[^>]*>[^<]*</span>)*)</span>`)
    .exec(s.sidebar.html ?? "")?.[1]
    ?.replace(/<span class="sr">[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, "");
const showSidebar = () => vscode.commands.executeCommand("workbench.view.extension.copilotUsageMonitor");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let usageSeq = 0;
const appendUsage = () =>
  appendFile(
    join(ROOT, "session-state", LIVE, "events.jsonl"),
    jsonl([usageEvent({ usageId: `side-${++usageSeq}`, id: `se-${usageSeq}`, sourceSessionId: LIVE, inputTokens: 400_000 })]),
  );

const state = () => vscode.commands.executeCommand<TestState>("copilotUsageMonitor._testState");

async function waitFor(pred: (s: TestState) => boolean, ms = 5000): Promise<TestState> {
  const start = Date.now();
  for (;;) {
    const s = await state();
    if (pred(s)) return s;
    if (Date.now() - start > ms) throw new Error(`timed out; last status: ${s.statusText}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const config = () => vscode.workspace.getConfiguration("copilotUsageMonitor");

suite("AgentMeter", () => {
  suiteSetup(async () => {
    await rm(ROOT, { recursive: true, force: true });
    const now = Date.now();
    const sessions: Parameters<typeof sessionTree>[1] = [];
    for (let i = 0; i < 200; i++) {
      const id = `0000${String(i).padStart(4, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;
      sessions.push({
        id,
        lines: jsonl([usageEvent({ usageId: `seed-${i}`, id: `e-${i}`, sourceSessionId: id, timestamp: new Date(now - 60_000).toISOString() })]),
      });
    }
    sessions.push({ id: LIVE, lines: jsonl([usageEvent({ usageId: "live-0", sourceSessionId: LIVE })]), lockPid: process.pid });
    await sessionTree(ROOT, sessions);
    // One Claude Code session and one Codex session today, large enough to move the status bar figure.
    await rm(CLAUDE_ROOT, { recursive: true, force: true });
    await rm(CODEX_ROOT, { recursive: true, force: true });
    const ts = (ago: number) => new Date(now - ago).toISOString();
    await claudeTree(CLAUDE_ROOT, [
      {
        sessionId: CLAUDE_SESSION,
        lines: [
          claudeAssistantLine({ id: "msg_int_1", requestId: "req_int_1", timestamp: ts(120_000), input: 7_000_000 }),
          claudeAssistantLine({ id: "msg_int_2", requestId: "req_int_2", timestamp: ts(60_000), input: 7_000_000 }),
        ],
      },
    ]);
    const d = new Date(now);
    const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    const usage = { input_tokens: 50_000_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1000, reasoning_output_tokens: 0 };
    await codexTree(CODEX_ROOT, [
      { date, sessionId: CODEX_SESSION, lines: [codexMeta({ timestamp: ts(120_000) }), codexTurn({ timestamp: ts(90_000) }), codexRecord({ timestamp: ts(60_000), usage })] },
    ]);
    const ext = vscode.extensions.getExtension("local.agentmeter");
    assert.ok(ext, "extension present");
    await ext.activate();
    await vscode.commands.executeCommand("copilotUsageMonitor.refresh");
  });

  test("activates and shows status text", async () => {
    const s = await waitFor((x) => x.statusText.startsWith("$(pulse) Local today:") && x.statusText.endsWith("tok"), 3000);
    assert.match(s.tooltip, /Locally observed from Copilot, Claude Code and Codex session logs/);
  });

  test("updates within 2 s of a complete usage line", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const before = (await state()).statusText;
      const t0 = Date.now();
      await appendFile(
        join(ROOT, "session-state", LIVE, "events.jsonl"),
        jsonl([usageEvent({ usageId: `live-${i + 1}`, id: `le-${i}`, sourceSessionId: LIVE, inputTokens: 100_000 })]),
      );
      await waitFor((x) => x.statusText !== before, 5000);
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1]!;
    console.log(`latency median ${samples[10]}ms p95 ${p95}ms max ${samples.at(-1)}ms`);
    assert.ok(p95 < 2000, `p95 ${p95}`);
    assert.ok(samples.at(-1)! < 5000);
  });

  test("showDetails opens the panel", async () => {
    await vscode.commands.executeCommand("copilotUsageMonitor.showDetails");
    const s = await waitFor((x) => x.panelOpen);
    assert.strictEqual(s.panelTitle, "AgentMeter (Local)");
  });

  test("showSection switches the panel's section; bad ids are ignored; other commands keep it", async () => {
    await vscode.commands.executeCommand("copilotUsageMonitor.showSection", "sessions");
    let s = await waitFor((x) => x.panelOpen && x.panelSection === "sessions");
    for (const bad of ["bogus", "<img src=x>", "__proto__", 42, {}, ["overview"]]) {
      await vscode.commands.executeCommand("copilotUsageMonitor.showSection", bad);
    }
    s = await state();
    assert.strictEqual(s.panelSection, "sessions");
    // Same section again: the unchanged document is not re-assigned.
    const renders = s.panelRenders;
    await vscode.commands.executeCommand("copilotUsageMonitor.showSection", "sessions");
    assert.strictEqual((await state()).panelRenders, renders);
    await vscode.commands.executeCommand("copilotUsageMonitor.selectMonth", "current");
    await vscode.commands.executeCommand("copilotUsageMonitor.setFilter", "tool", "");
    await vscode.commands.executeCommand("copilotUsageMonitor.showDetails");
    assert.strictEqual((await state()).panelSection, "sessions");
    assert.strictEqual(config().inspect("showSection")?.globalValue, undefined);
    await vscode.commands.executeCommand("copilotUsageMonitor.showSection", "overview");
    await waitFor((x) => x.panelSection === "overview");
  });

  test("panel: while focused, usage lines redraw it at most once per 10 s; user actions and losing focus draw at once (A11y C1)", async () => {
    await vscode.commands.executeCommand("copilotUsageMonitor.showSection", "overview");
    let s = await waitFor((x) => x.panelOpen && x.panelActive && x.panelSection === "overview");
    const renders = s.panelRenders;
    // three model calls within the interval: the status bar follows, the focused panel is held
    for (let i = 0; i < 3; i++) {
      const before = (await state()).statusText;
      await appendUsage();
      await waitFor((x) => x.statusText !== before);
    }
    s = await state();
    assert.strictEqual(s.panelRenders, renders, `no redraw while focused within 10 s (active ${s.panelActive}, held ${s.panelHeld})`);
    assert.ok(s.panelHeld, "a redraw is held back");
    // a section switch is the user's: drawn at once, with the latest figures
    await vscode.commands.executeCommand("copilotUsageMonitor.showSection", "daily");
    s = await waitFor((x) => x.panelSection === "daily");
    assert.strictEqual(s.panelRenders, renders + 1);
    assert.ok(!s.panelHeld);
    // another call is held; moving focus to an editor draws it at once
    const before = s.statusText;
    await appendUsage();
    s = await waitFor((x) => x.statusText !== before && x.panelHeld);
    assert.strictEqual(s.panelRenders, renders + 1);
    const doc = await vscode.workspace.openTextDocument({ content: "focus elsewhere" });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
    s = await waitFor((x) => !x.panelActive && !x.panelHeld, 3000);
    assert.strictEqual(s.panelRenders, renders + 2, "one redraw when the panel loses focus");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await vscode.commands.executeCommand("copilotUsageMonitor.showSection", "overview");
    await waitFor((x) => x.panelSection === "overview");
  });

  test("side bar: contributions are present", async () => {
    const ext = vscode.extensions.getExtension("local.agentmeter")!;
    const c = ext.packageJSON.contributes;
    assert.strictEqual(c.viewsContainers.activitybar[0].id, "copilotUsageMonitor");
    assert.strictEqual(c.viewsContainers.activitybar[0].icon, "media/activity.svg");
    assert.strictEqual(c.views.copilotUsageMonitor[0].id, "copilotUsageMonitor.summary");
    assert.strictEqual(c.views.copilotUsageMonitor[0].type, "webview");
    assert.strictEqual(c.viewsWelcome, undefined);
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("copilotUsageMonitor.summary.focus"), "VS Code registered the view's focus command");
    assert.ok(all.includes("workbench.view.extension.copilotUsageMonitor"), "VS Code registered the container");
  });

  test("side bar: focusing the view draws a no-script page that matches the snapshot and the status bar", async () => {
    await showSidebar();
    const s = await waitFor((x) => x.sidebar.visible && x.sidebar.state === "ready" && (x.sidebar.html ?? "").includes("All projects"), 5000);
    assert.deepStrictEqual(s.sidebar.options, { enableScripts: false, enableForms: false, enableCommandUris: SIDEBAR_COMMANDS, localResourceRoots: [] });
    assert.strictEqual(s.sidebar.unitWord, "tokens");
    // no workspace folder is open in the test host, so there is no "This workspace" group
    assert.deepStrictEqual(s.sidebar.folders, []);
    assert.deepStrictEqual(s.sidebar.groups, ["all", "sources", "projects", "models"]);
    assert.deepStrictEqual(s.sidebar.rows.filter((i) => !i.id.includes("/")).map((i) => i.label), ["Today", "Last 7 days", "This month"]);
    const today = row(s, "today")!;
    assert.strictEqual(today.value, statusFigure(s), `${today.value} vs ${s.statusText}`);
    assert.strictEqual(drawn(s, "Today"), statusFigure(s));
    assert.match(today.spoken, /^Today: [\d.]+ (thousand|million) tokens/);
    assert.match(s.statusA11y, /^Local usage, today: /);
    const html = s.sidebar.html!;
    assert.ok(html.includes("Open dashboard"));
    assert.ok(html.includes("Top projects, last 7 days") && html.includes("Top models, last 7 days"));
    assert.ok(!/<script/i.test(html));
    assert.ok(html.includes(`content="default-src 'none'; style-src `));
    for (const [, href] of html.matchAll(/\shref="([^"]*)"/g)) {
      const cmd = /^command:([\w.]+)(\?|$)/.exec(href!)?.[1];
      assert.ok(cmd && SIDEBAR_COMMANDS.includes(cmd), href);
    }
    assert.ok(!JSON.stringify(s.sidebar).includes(CANARY));
    // the CSP names the webview's resource origin; nothing else in the page or model is a URL
    assert.ok(!JSON.stringify({ ...s.sidebar, html: html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "") }).includes("http"));
  });

  test("side bar: the page is redrawn within 2 s of a usage line while visible, once per change", async () => {
    await showSidebar();
    await waitFor((x) => x.sidebar.visible);
    await sleep(400); // let a pending debounced redraw land
    for (let i = 0; i < 3; i++) {
      const before = await state();
      const t0 = Date.now();
      await appendUsage();
      // the figure changed and the page was redrawn (250 ms debounce)
      const s = await waitFor((x) => drawn(x, "Today") !== drawn(before, "Today") && x.sidebar.renders > before.sidebar.renders, 5000);
      assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
      assert.strictEqual(s.sidebar.renders, before.sidebar.renders + 1, "one redraw per change");
      assert.strictEqual(drawn(s, "Today"), statusFigure(s));
    }
    // idle: no redraws without a change
    await sleep(400);
    const renders = (await state()).sidebar.renders;
    await sleep(1500);
    assert.strictEqual((await state()).sidebar.renders, renders);
  });

  test("side bar: no redraws while hidden; one when shown again", async () => {
    await showSidebar();
    await waitFor((x) => x.sidebar.visible);
    // Showing another side bar container hides ours.
    await vscode.commands.executeCommand("workbench.view.explorer");
    let s = await waitFor((x) => !x.sidebar.visible);
    const renders = s.sidebar.renders;
    const html = s.sidebar.html;
    for (let i = 0; i < 3; i++) {
      // The model keeps up while hidden (the figure always moves); only the redraw is held back.
      const before = row(s, "today")!.value;
      await appendUsage();
      s = await waitFor((x) => row(x, "today")!.value !== before);
    }
    await sleep(600);
    s = await state();
    assert.strictEqual(s.sidebar.renders, renders, "no redraw while hidden");
    assert.strictEqual(s.sidebar.html, html);
    await showSidebar();
    s = await waitFor((x) => x.sidebar.visible && x.sidebar.renders > renders);
    await sleep(600);
    s = await state();
    assert.strictEqual(s.sidebar.renders, renders + 1, "exactly one redraw on show");
    assert.strictEqual(drawn(s, "Today"), statusFigure(s));
  });

  test("side bar: links open the matching section; a project row toggles the filter", async () => {
    let s = await state();
    const run = (c: { command: string; args: string[] }) => vscode.commands.executeCommand(c.command, ...c.args);
    await run(row(s, "today")!.link!);
    await waitFor((x) => x.panelOpen && x.panelSection === "daily");
    await run(row(s, "models/0")!.link!);
    await waitFor((x) => x.panelSection === "models");
    await run(row(s, "month")!.link!);
    await waitFor((x) => x.panelSection === "overview");
    const project = row(s, "projects/0")!;
    assert.strictEqual(project.link!.command, "copilotUsageMonitor.setFilter");
    const todayBefore = row(s, "today")!.value;
    await run(project.link!);
    s = await waitFor((x) => x.panelSection === "projects" && x.snapshot?.filter?.project === project.link!.args[1]);
    s = await waitFor((x) => row(x, "projects/0")!.link!.args[1] === "");
    assert.strictEqual(row(s, "today")!.value, todayBefore, "Today is never filtered");
    assert.deepStrictEqual(row(s, "projects/0")!.link!.args, ["project", "", "projects"]);
    await run(row(s, "projects/0")!.link!);
    await waitFor((x) => x.snapshot?.filter === undefined);
    await vscode.commands.executeCommand("copilotUsageMonitor.showSection", "overview");
  });

  test("side bar: switching the unit updates the rows and the status bar together", async () => {
    await showSidebar();
    try {
      await vscode.commands.executeCommand("copilotUsageMonitor.toggleUnit");
      const s = await waitFor((x) => x.sidebar.unitWord === "USD (est.)" && x.statusText.includes(" Local ") && !x.statusText.endsWith("tok"));
      const figure = s.statusText.replace(/^\$\([a-z-]+\) Local [A-Z][a-z]{2}: /, "");
      // " est." is said once in the footer, not on every row (design #6)
      assert.strictEqual(row(s, "month")!.value, figure.split(" / ")[0]!, `${row(s, "month")!.value} vs ${s.statusText}`);
      assert.match(row(s, "today")!.value, /^(\$[\d.,]+\*?|—)$/);
      assert.match(s.statusA11y, /^Local usage, this month, estimated: /);
      const html = (await waitFor((x) => (x.sidebar.html ?? "").includes("Show tokens"))).sidebar.html!;
      assert.ok(html.includes('href="command:copilotUsageMonitor.toggleUnit"'));
    } finally {
      await vscode.commands.executeCommand("copilotUsageMonitor.setUnit", "tokens");
      await config().update("display", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor((x) => x.sidebar.unitWord === "tokens" && x.statusText.endsWith("tok"));
  });

  test("no-dir tooltip names the setting, and a setting change re-roots", async () => {
    // Copilot alone: with Claude Code and Codex on and found, the state would not be no-dir (D49).
    await config().update("claudeCode", false, vscode.ConfigurationTarget.Global);
    await config().update("codex", false, vscode.ConfigurationTarget.Global);
    await config().update("copilotHome", join(ROOT, "missing"), vscode.ConfigurationTarget.Global);
    try {
      const s = await waitFor((x) => x.statusText === "$(circle-slash) Local: no usage logs found");
      assert.match(s.tooltip, /copilotUsageMonitor\.copilotHome/);
      // the side bar shows the in-page state: no rows, the setting named
      await showSidebar();
      const side = await waitFor((x) => x.sidebar.state === "no-dir" && (x.sidebar.html ?? "").includes("No Copilot session logs were found"));
      assert.deepStrictEqual(side.sidebar.rows, []);
      assert.ok(side.sidebar.html!.includes("copilotUsageMonitor.copilotHome"));
      assert.ok(!side.sidebar.html!.includes("All projects"));
    } finally {
      await config().update("copilotHome", undefined, vscode.ConfigurationTarget.Global);
      await config().update("claudeCode", undefined, vscode.ConfigurationTarget.Global);
      await config().update("codex", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor((x) => x.statusText.startsWith("$(pulse) Local today:") && x.sidebar.state === "ready" && x.snapshot?.today?.bySource?.codex !== undefined);
  });

  test("USD view and a target range change the status bar; the panel links are allowlisted", async () => {
    try {
      await config().update("monthlyTargetMax", 0.001, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("copilotUsageMonitor.setUnit", "cost");
      const s = await waitFor((x) => x.statusText.startsWith("$(flame) Local ") && x.statusText.includes(" / up to $0.001"));
      assert.match(s.tooltip, /over target/);
      assert.strictEqual(config().get("display"), "cost");
    } finally {
      await config().update("monthlyTargetMax", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("copilotUsageMonitor.setUnit", "tokens");
      await config().update("display", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor((x) => x.statusText.startsWith("$(pulse) Local today:"));
  });

  test("selectMonth accepts current and ignores unknown months", async () => {
    await vscode.commands.executeCommand("copilotUsageMonitor.selectMonth", "1999-01");
    await vscode.commands.executeCommand("copilotUsageMonitor.selectMonth", "current");
    const s = await waitFor((x) => x.panelOpen);
    const snap = (s as unknown as { snapshot: { month: { isCurrent: boolean }; history: unknown[] } }).snapshot;
    assert.strictEqual(snap.month.isCurrent, true);
    assert.strictEqual(snap.history.length, 12);
  });

  test("setFilter narrows the month view and clears; bad kinds are ignored", async () => {
    type S = { snapshot: { filter?: { tool?: string }; month: { totals?: { records: number } } } };
    const before = ((await state()) as unknown as S).snapshot.month.totals?.records ?? 0;
    await vscode.commands.executeCommand("copilotUsageMonitor.setFilter", "tool", "no-such-tool");
    let s = (await waitFor((x) => (x as unknown as S).snapshot.filter?.tool === "no-such-tool")) as unknown as S;
    assert.strictEqual(s.snapshot.month.totals, undefined);
    await vscode.commands.executeCommand("copilotUsageMonitor.setFilter", "bogus", "x");
    await vscode.commands.executeCommand("copilotUsageMonitor.setFilter", "tool", "");
    s = (await waitFor((x) => (x as unknown as S).snapshot.filter === undefined)) as unknown as S;
    assert.ok((s.snapshot.month.totals?.records ?? 0) >= before);
  });

  test("v0.6: showSession opens and closes a session's call list; bad ids are ignored", async () => {
    type S = { panelSection: string; snapshot: { month: { sessions: { sessionId: string }[]; detail?: { sessionId: string } } } };
    const first = (await waitFor((x) => ((x as unknown as S).snapshot?.month?.sessions.length ?? 0) > 0)) as unknown as S;
    const id = first.snapshot.month.sessions[0]!.sessionId;
    await vscode.commands.executeCommand("copilotUsageMonitor.showSession", id);
    let s = (await waitFor((x) => (x as unknown as S).snapshot.month.detail?.sessionId === id && x.panelSection === "sessions")) as unknown as S;
    for (const bad of [undefined, "bogus", "../" + id, 42, {}, [id], "<img src=x>"]) {
      await vscode.commands.executeCommand("copilotUsageMonitor.showSession", bad);
    }
    await sleep(600);
    s = (await state()) as unknown as S;
    assert.strictEqual(s.snapshot.month.detail?.sessionId, id);
    await vscode.commands.executeCommand("copilotUsageMonitor.showSession", "");
    await waitFor((x) => (x as unknown as S).snapshot.month.detail === undefined);
    assert.strictEqual(config().inspect("showSession")?.globalValue, undefined);
    await vscode.commands.executeCommand("copilotUsageMonitor.showSection", "overview");
  });

  test("v0.6: copilotUsageMonitor.statusBar switches the status text among today, month and session", async () => {
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][new Date().getMonth()];
    try {
      await config().update("statusBar", "month", vscode.ConfigurationTarget.Global);
      let s = await waitFor((x) => x.statusText.startsWith(`$(pulse) Local ${month}: `) && x.statusText.endsWith(" tok"));
      assert.match(s.statusA11y, /^Local usage, this month: /);
      assert.match(s.tooltip, /\*\*This month\*\*: /);
      await config().update("statusBar", "session", vscode.ConfigurationTarget.Global);
      s = await waitFor((x) => x.statusText.startsWith("$(pulse) Local session: ") && x.statusText.endsWith(" tok"));
      assert.match(s.statusA11y, /^Local usage, current session: /);
      await config().update("statusBar", "today", vscode.ConfigurationTarget.Global);
      await waitFor((x) => x.statusText.startsWith("$(pulse) Local today: "));
    } finally {
      await config().update("statusBar", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor((x) => x.statusText.startsWith("$(pulse) Local today: "));
  });

  test("v0.8: copilotUsageMonitor.palette recolours the panel; selectPalette with an id writes the user setting, other ids are ignored", async () => {
    try {
      await vscode.commands.executeCommand("copilotUsageMonitor.showDetails");
      assert.strictEqual((await state()).panelPalette, "theme");
      await config().update("palette", "ocean", vscode.ConfigurationTarget.Global);
      await waitFor((x) => x.panelPalette === "ocean");
      await vscode.commands.executeCommand("copilotUsageMonitor.selectPalette", "forest");
      await waitFor((x) => x.panelPalette === "forest");
      assert.strictEqual(config().inspect("palette")?.globalValue, "forest");
      await vscode.commands.executeCommand("copilotUsageMonitor.selectPalette", "Forest");
      await sleep(200);
      assert.strictEqual((await state()).panelPalette, "forest");
      assert.strictEqual(config().inspect("palette")?.globalValue, "forest");
    } finally {
      await config().update("palette", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor((x) => x.panelPalette === "theme");
  });

  test("v0.9: the Settings section opens; setTarget and setStatusBar write the user settings and the view follows; junk is ignored", async () => {
    try {
      await vscode.commands.executeCommand("copilotUsageMonitor.showSettings");
      const s = await waitFor((x) => x.panelOpen && x.panelSection === "settings");
      assert.strictEqual(s.prefs.currency, "USD");
      assert.deepStrictEqual(s.prefs.targets, {});
      assert.deepStrictEqual(s.prefs.unsaved, []);
      await vscode.commands.executeCommand("copilotUsageMonitor.setTarget", "day", "max", "2.5");
      await waitFor((x) => x.prefs.targets.dayMax === 2.5 && x.view.dayTarget?.max === 2.5);
      assert.strictEqual(config().inspect("dailyTargetMax")?.globalValue, 2.5);
      await vscode.commands.executeCommand("copilotUsageMonitor.setTarget", "week", "max", "abc");
      await vscode.commands.executeCommand("copilotUsageMonitor.setTarget", "day", "min", "1");
      await sleep(200);
      assert.strictEqual(config().inspect("weeklyTargetMax")?.globalValue, undefined);
      await vscode.commands.executeCommand("copilotUsageMonitor.setTarget", "day", "max", "");
      await waitFor((x) => x.prefs.targets.dayMax === undefined && x.view.dayTarget === undefined);
      assert.strictEqual(config().inspect("dailyTargetMax")?.globalValue, undefined);
      await vscode.commands.executeCommand("copilotUsageMonitor.setStatusBar", "month");
      await waitFor((x) => x.prefs.statusBar === "month" && x.view.statusBar === "month");
      assert.strictEqual(config().inspect("statusBar")?.globalValue, "month");
      await vscode.commands.executeCommand("copilotUsageMonitor.setTargetAlert", "on");
      await waitFor((x) => x.prefs.targetAlert === true);
      assert.strictEqual(config().inspect("targetAlert")?.globalValue, true);
      await vscode.commands.executeCommand("copilotUsageMonitor.setTargetAlert", "off");
      await waitFor((x) => x.prefs.targetAlert === false);
    } finally {
      for (const k of ["dailyTargetMax", "weeklyTargetMax", "statusBar", "targetAlert"]) await config().update(k, undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor((x) => x.prefs.statusBar === "today" && x.view.statusBar === undefined);
  });

  test("v0.6: the getting-started walkthrough is contributed and opens", async () => {
    const ext = vscode.extensions.getExtension("local.agentmeter")!;
    const w = ext.packageJSON.contributes.walkthroughs;
    assert.strictEqual(w.length, 1);
    assert.strictEqual(w[0].id, "gettingStarted");
    assert.deepStrictEqual(w[0].steps.map((x: { id: string }) => x.id), ["folder", "unit", "target", "open"]);
    await vscode.commands.executeCommand("workbench.action.openWalkthrough", "local.agentmeter#gettingStarted", false);
    await sleep(500);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  test("v0.6: the target alert is off by default and shows nothing when over target; on, it shows once", async () => {
    const ext = vscode.extensions.getExtension("local.agentmeter")!;
    assert.strictEqual(ext.packageJSON.contributes.configuration.properties["copilotUsageMonitor.targetAlert"].default, false);
    assert.strictEqual(config().get("targetAlert"), false);
    type A = { alertsShown: number };
    const shown = async () => ((await state()) as unknown as A).alertsShown;
    const base = await shown();
    try {
      await config().update("monthlyTargetMax", 0.001, vscode.ConfigurationTarget.Global);
      await waitFor((x) => x.statusText.startsWith("$(flame) "));
      await appendUsage();
      await sleep(800);
      assert.strictEqual(await shown(), base, "off by default: no notification");
      await config().update("targetAlert", true, vscode.ConfigurationTarget.Global);
      await waitFor((x) => (x as unknown as A).alertsShown === base + 1);
      // more usage the same month: no second notification
      const before = (await state()).statusText;
      await appendUsage();
      await waitFor((x) => x.statusText !== before);
      await sleep(300);
      assert.strictEqual(await shown(), base + 1);
    } finally {
      await config().update("targetAlert", undefined, vscode.ConfigurationTarget.Global);
      await config().update("monthlyTargetMax", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("notifications.clearAll");
    }
    await waitFor((x) => x.statusText.startsWith("$(pulse) Local today:"));
  });

  test("sources: today counts Copilot, Claude Code and Codex; the side bar lists them", async () => {
    const s = await waitFor((x) => ["copilot", "claude-code", "codex"].every((k) => x.snapshot?.today?.bySource?.[k] !== undefined));
    assert.deepStrictEqual(Object.keys(s.snapshot!.today!.bySource!).sort(), ["claude-code", "codex", "copilot"]);
    assert.strictEqual(s.snapshot!.health?.sources?.["claude-code"]?.state, "ok");
    assert.strictEqual(s.snapshot!.health?.sources?.codex?.state, "ok");
    // status bar text unchanged in shape (D49)
    assert.match(s.statusText, /^\$\([a-z-]+\) Local today: .+ tok$/);
    await showSidebar();
    const side = await waitFor((x) => x.sidebar.groups.includes("sources"));
    const rows = side.sidebar.rows.filter((r) => r.id.startsWith("sources/"));
    assert.deepStrictEqual(rows.map((r) => r.label), ["Copilot", "Claude Code", "Codex"]);
    for (const r of rows) {
      assert.notStrictEqual(r.value, "—", `${r.label} has records`);
      assert.strictEqual(r.link?.command, "copilotUsageMonitor.setFilter");
      assert.strictEqual(r.link?.args[0], "source");
      assert.strictEqual(r.link?.args[2], "overview");
    }
    assert.ok(!(side.sidebar.html ?? "").includes(CLAUDE_ROOT) && !(side.sidebar.html ?? "").includes(CODEX_ROOT), "no root path rendered");
    assert.ok(!s.tooltip.includes(CLAUDE_ROOT) && !s.tooltip.includes(CODEX_ROOT), "no root path in the tooltip");
  });

  test("sources: setFilter source narrows to Codex and an empty value clears; unknown sources are ignored", async () => {
    await vscode.commands.executeCommand("copilotUsageMonitor.setFilter", "source", "codex");
    await waitFor((x) => x.snapshot?.filter?.source === "codex");
    await vscode.commands.executeCommand("copilotUsageMonitor.setFilter", "source", "nope");
    await sleep(600);
    assert.strictEqual((await state()).snapshot?.filter?.source, "codex");
    await vscode.commands.executeCommand("copilotUsageMonitor.setFilter", "source", "");
    await waitFor((x) => x.snapshot?.filter === undefined);
  });

  test("sources: turning Codex off drops its records and its share of the status figure; on restores them", async () => {
    const on = await waitFor((x) => x.snapshot?.today?.bySource?.codex !== undefined && x.statusText.startsWith("$(pulse) Local today:"));
    const withCodex = statusFigure(on);
    try {
      await config().update("codex", false, vscode.ConfigurationTarget.Global);
      const off = await waitFor((x) => x.snapshot?.today?.bySource !== undefined && x.snapshot.today.bySource.codex === undefined && x.statusText.startsWith("$(pulse) Local today:"), 3000);
      assert.ok(off.snapshot!.today!.bySource!["claude-code"] !== undefined, "Claude Code stays");
      assert.notStrictEqual(statusFigure(off), withCodex, "the status figure included Codex");
      await config().update("codex", true, vscode.ConfigurationTarget.Global);
      await waitFor((x) => x.snapshot?.today?.bySource?.codex !== undefined, 3000);
    } finally {
      await config().update("codex", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor((x) => x.snapshot?.today?.bySource?.codex !== undefined && x.statusText.startsWith("$(pulse) Local today:"));
  });

  test("the folder setting is machine-scoped", () => {
    const ext = vscode.extensions.getExtension("local.agentmeter")!;
    const prop = ext.packageJSON.contributes.configuration.properties["copilotUsageMonitor.copilotHome"];
    assert.strictEqual(prop.scope, "machine");
  });

  suiteTeardown(async () => {
    await mkdir(ROOT, { recursive: true });
  });
});
