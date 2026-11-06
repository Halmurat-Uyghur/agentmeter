// v0.4 side bar (A1): the pure model and HTML behind the no-script webview view. Same
// value rules as the panel and the status bar: "—" never 0, "*" partial, session totals
// named in the title tooltips.
import { readFileSync } from "node:fs";
import { mkdtemp as mkdtempP, rm as rmP } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_BANNER, SESSION_TOTAL_SHORT, setDisplayCurrency, statusParts, statusText } from "../../src/core/format";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { isSectionId } from "../../src/core/panelHtml";
import { renderSidebarHtml, sidebarHref } from "../../src/core/sidebarHtml";
import { buildSidebarModel, matchesFolder, SIDEBAR_COMMANDS, sidebarRows, TOP_N, type SidebarModel } from "../../src/core/sidebarModel";
import type { Counts, GroupSummary, Health, Insight, Metric, Snapshot, Totals, ViewOptions } from "../../src/core/types";
import { CANARY, jsonl, sessionTree, shutdownEvent, usageEvent } from "../fixtures/build";

const m = (sum: number, reported: number, missing = 0): Metric => ({ sum, reported, missing });
const none = (): Metric => m(0, 0, 0);

function counts(o: Partial<Counts> = {}): Counts {
  return {
    records: 2,
    calls: 2,
    sessionTotals: 0,
    input: m(1_200_000, 2),
    output: m(300_000, 2),
    cacheRead: none(),
    cacheWrite: none(),
    reasoning: none(),
    durationMs: none(),
    nanoAiu: m(4e9, 2),
    callsMissing: 0,
    callNanoAiu: o.nanoAiu ?? m(4e9, 2),
    ...o,
  };
}
function totals(byModel: Record<string, Counts> = { "model-a": counts() }, o: Partial<Counts> = {}): Totals {
  return { ...counts(o), byModel };
}
function health(o: Partial<Health> = {}): Health {
  return {
    state: "ok",
    rootSource: "default",
    partial: false,
    unrecognized: 0,
    malformed: 0,
    overlong: 0,
    overlongOther: 0,
    unreadableFiles: 0,
    sessionsWithoutUsage: 0,
    sessionsFromTotals: 0,
    shutdownOversize: 0,
    ...o,
  };
}
function group(name: string, tokens: number, nano: number, o: Partial<GroupSummary> = {}): GroupSummary {
  return { name, sessions: 1, calls: 3, tokens: m(tokens, 3), nanoAiu: m(nano, 3), ...o };
}

const DAY0 = new Date(2026, 10, 5).getTime();
const MONTH0 = new Date(2026, 10, 1).getTime();
const OCT = new Date(2026, 9, 1).getTime();
const FOLDER = "0000aaaa-0000-4000-8000-000000000001";
const insight = (): Insight => ({ id: "cache-reuse", nanoAiu: 1, tokens: 1, calls: 1, sessions: 1, model: "m", share: 0.1, meanPromptTokens: 1 });

function snap(o: Partial<Snapshot> = {}): Snapshot {
  return {
    generatedAtMs: DAY0 + 3600_000,
    dayStartMs: DAY0,
    today: totals(),
    current: { folderId: FOLDER, live: true, pinned: false, totals: totals() },
    sessions: [],
    health: health(),
    history: [{ monthStartMs: OCT }, { monthStartMs: MONTH0, totals: totals() }],
    last7: totals({
      "model-a": counts({ input: m(5_000_000, 5), output: m(1_000_000, 5), calls: 5, nanoAiu: m(9e9, 5) }),
      "model-b": counts({ input: m(9_000_000, 5), output: m(0, 5), calls: 7, nanoAiu: m(1e9, 5) }),
    }),
    prior7: totals({}, { input: m(600_000, 1), output: m(150_000, 1) }),
    thisMonth: totals({}, { input: m(14_000_000, 10), output: m(1_000_000, 10), calls: 12, nanoAiu: m(1e10, 10) }),
    thisMonthProjects: [group("acme/web", 1_000, 9e9), group("tools-cli", 9_000, 1e9, { label: "Fix the login bug" }), group("old-thing", 1, 1)],
    last7Projects: [group("acme/web", 1_000, 9e9), group("tools-cli", 9_000, 1e9, { label: "Fix the login bug" })],
    todayProjects: [group("acme/web", 500, 2e9, { calls: 2 })],
    ...o,
  };
}

const TOKENS: ViewOptions = { unit: "tokens" };
const COST: ViewOptions = { unit: "cost" };
const r = (model: SidebarModel, id: string) => sidebarRows(model).find((x) => x.id === id)!;
const grp = (model: SidebarModel, id: string) => model.groups.find((g) => g.id === id);

// The status bar's stricter wording rule applies in tokens view; D22's in USD view (O3 §6).
const STRICT_RE = /\b(bill|billing|remaining|quota|limit|allowance|credits?|cost|spend|premium)\b|\$\d|%/i;
const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;

/** Visible text plus title and aria-label values, without the style block or hrefs. */
function text(html: string): string {
  const titles = [...html.matchAll(/ (?:title|aria-label)="([^"]*)"/g)].map((x) => x[1]).join(" ");
  return (html.replace(/<head>[\s\S]*?<\/head>/, " ") + " " + titles)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function strings(model: SidebarModel): string[] {
  const out = [model.unitWord, model.message ?? "", ...model.notice, model.unitSwitch.text];
  for (const g of model.groups) out.push(g.heading, g.title, g.empty ?? "");
  for (const x of sidebarRows(model)) out.push(x.label, x.value, x.title, x.spoken, x.marker?.text ?? "");
  if (model.insights) out.push(model.insights.text, model.insights.title, model.insights.spoken);
  if (model.health) out.push(model.health.text, model.health.title);
  return out.map((t) => t.split(LOCAL_BANNER).join(""));
}

describe("sidebar model: groups and rows", () => {
  it("groups in order with fixed headings; rows label left, value right; ids positional", () => {
    const model = buildSidebarModel(snap(), TOKENS, ["web"]);
    expect(model.state).toBe("ready");
    expect(model.groups.map((g) => g.heading)).toEqual(["This workspace · web", "All projects", "Top projects, last 7 days", "Top models, last 7 days"]);
    expect(grp(model, "all")!.rows.map((x) => [x.id, x.label])).toEqual([
      ["today", "Today"],
      ["week", "Last 7 days"],
      ["month", "This month"],
    ]);
    expect(grp(model, "workspace")!.rows.map((x) => [x.id, x.label, x.value])).toEqual([
      ["workspace/today", "Today", "500 tok"],
      ["workspace/week", "Last 7 days", "1.0K tok"],
    ]);
    expect(model.unitWord).toBe("tokens");
    expect(buildSidebarModel(snap(), COST).unitWord).toBe("USD (est.)");
    const other = buildSidebarModel(snap({ today: totals({}, { input: m(7, 1) }) }), TOKENS, ["web"]);
    expect(sidebarRows(other).map((x) => x.id)).toEqual(sidebarRows(model).map((x) => x.id));
    for (const x of sidebarRows(model)) expect(x.id).toMatch(/^[a-z]+(\/[a-z0-9]+)?$/);
  });

  it("This workspace: matches a folder name or the repo part of owner/repo; hidden when nothing matches", () => {
    expect(matchesFolder("acme/web", "web")).toBe(true);
    expect(matchesFolder("acme/Web", "web")).toBe(true);
    expect(matchesFolder("tools-cli", "tools-cli")).toBe(true);
    expect(matchesFolder("acme/web", "acme")).toBe(false);
    expect(matchesFolder("web-app", "web")).toBe(false);
    expect(matchesFolder("web", "")).toBe(false);
    expect(grp(buildSidebarModel(snap(), TOKENS, []), "workspace")).toBeUndefined();
    expect(grp(buildSidebarModel(snap(), TOKENS, ["nope"]), "workspace")).toBeUndefined();
    // the first open folder that matches wins
    const two = buildSidebarModel(snap(), TOKENS, ["nope", "tools-cli", "web"]);
    expect(grp(two, "workspace")!.heading).toBe("This workspace · tools-cli");
    expect(r(two, "workspace/today").value).toBe("—");
    expect(r(two, "workspace/week").value).toBe("9.0K tok");
    // a project seen this month but not in the last 7 days still matches, with "—" figures
    const old = buildSidebarModel(snap(), COST, ["old-thing"]);
    expect(grp(old, "workspace")!.rows.map((x) => x.value)).toEqual(["—", "—"]);
    // a click filters the panel to the project and opens Projects; again, it clears
    expect(r(two, "workspace/week").link).toEqual({ command: "copilotUsageMonitor.setFilter", args: ["project", "tools-cli", "projects"] });
    const on = buildSidebarModel(snap({ filter: { project: "tools-cli" } }), TOKENS, ["tools-cli"]);
    expect(r(on, "workspace/today").link!.args).toEqual(["project", "", "projects"]);
  });

  it("top projects and models of the last 7 days: at most TOP_N, sorted by the unit's headline, then name", () => {
    const many = Array.from({ length: 8 }, (_, i) => group(`p${i}`, (i + 1) * 1000, (8 - i) * 1e9));
    const t = snap({ last7Projects: many });
    const tok = buildSidebarModel(t, TOKENS);
    expect(grp(tok, "projects")!.rows.map((x) => x.label)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
    expect(grp(tok, "projects")!.rows).toHaveLength(TOP_N);
    const usd = buildSidebarModel(t, COST);
    expect(grp(usd, "projects")!.rows.map((x) => x.label)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(grp(tok, "models")!.rows.map((x) => x.label)).toEqual(["model-b", "model-a"]);
    expect(grp(usd, "models")!.rows.map((x) => x.label)).toEqual(["model-a", "model-b"]);
    expect(grp(tok, "models")!.rows[0]!.value).toBe("9.0M tok");
    expect(grp(usd, "models")!.rows[0]!.value).toBe("$0.090");
    // the session title shows for an ID-named project; the key stays the filter value
    const p = grp(buildSidebarModel(snap(), TOKENS), "projects")!.rows;
    expect(p.map((x) => x.label)).toEqual(["Fix the login bug", "web"]); // repo part only when unique (design #6)
    expect(p[0]!.link).toEqual({ command: "copilotUsageMonitor.setFilter", args: ["project", "tools-cli", "projects"] });
    expect(p[0]!.title).toContain("Project: tools-cli (shown by its session title).");
  });

  it("status-bar parity: Today (tokens) and This month (USD) values equal the status figure", () => {
    for (const partial of [false, true]) {
      const s = snap({ health: health({ partial, unreadableFiles: partial ? 1 : 0 }) });
      const figure = statusText(s, TOKENS).replace(/^\$\([a-z-]+\) Local today: /, "");
      expect(r(buildSidebarModel(s, TOKENS), "today").value).toBe(figure);
      for (const range of [undefined, { min: 1 }, { min: 1, max: 50 }, { max: 0.01 }]) {
        const view: ViewOptions = range ? { unit: "cost", range } : { unit: "cost" };
        const month = r(buildSidebarModel(s, view), "month");
        // " est." is said once in the footer, not per row (design #6)
        expect(month.value).toBe(statusParts(s, view).figure);
        const state = statusParts(s, view).state;
        expect(month.marker?.kind).toBe(state === "none" ? undefined : state);
      }
    }
    const over = r(buildSidebarModel(snap(), { unit: "cost", range: { max: 0.01 } }), "month");
    expect(over.value).toBe("$0.100");
    expect(over.marker).toEqual({ kind: "over", text: "over" });
    expect(over.spoken).toBe("This month: 0.100 US dollars estimated, over target");
    expect(over.title).toContain("Target up to $0.010: over target.");
    expect(r(buildSidebarModel(snap(), { unit: "cost", range: { min: 1 } }), "month").marker).toEqual({ kind: "under", text: "under" });
    expect(r(buildSidebarModel(snap(), { unit: "cost", range: { min: 0.01, max: 1 } }), "month").marker).toEqual({ kind: "in", text: "in range" });
  });

  it("the month row reads thisMonth, not the filtered or selected month; a filter adds a note", () => {
    const s = snap({ filter: { tool: "x" }, history: [{ monthStartMs: MONTH0 }], month: { monthStartMs: OCT, isCurrent: false, days: [], sessions: [], projects: [], tools: [] } });
    expect(r(buildSidebarModel(s, TOKENS), "month").value).toBe("15.0M tok");
    expect(buildSidebarModel(s, TOKENS).message).toMatch(/filtered/);
    expect(buildSidebarModel(snap(), TOKENS).message).toBeUndefined();
  });

  it("'—' never 0: no data today, no last 7 days, no month; empty groups say so", () => {
    const s = snap({ today: undefined, last7: undefined, thisMonth: undefined, thisMonthProjects: [], last7Projects: [], todayProjects: [] });
    const model = buildSidebarModel(s, TOKENS, ["web"]);
    expect(grp(model, "all")!.rows.map((x) => x.value)).toEqual(["—", "—", "—"]);
    expect(grp(model, "workspace")).toBeUndefined();
    expect(grp(model, "projects")!.rows).toEqual([]);
    expect(grp(model, "projects")!.empty).toBe("Nothing logged in the last 7 days.");
    expect(grp(model, "models")!.rows).toEqual([]);
    expect(r(model, "today").title).toContain("Nothing logged.");
    // a session-total month with no AIU shows "—" in USD, never "$0.00"
    const noAiu = snap({ thisMonth: totals({}, { nanoAiu: m(0, 0, 3), sessionTotals: 3 }) });
    expect(r(buildSidebarModel(noAiu, COST), "month").value).toBe("—");
    for (const t of strings(model)) expect(t).not.toMatch(/(^|[^\d.])0 tok/);
  });

  it("'*' once on every figure under partial health; an incomplete week window gets '*' and a sentence", () => {
    const model = buildSidebarModel(snap({ health: health({ partial: true, malformed: 2 }) }), TOKENS, ["web"]);
    for (const id of ["today", "week", "month", "workspace/today", "workspace/week", "projects/0", "models/0"]) {
      const v = r(model, id).value;
      expect(v, id).toMatch(/^[\d.]+[KM]?\* tok$/);
      expect(r(model, id).spoken, id).toContain("may be incomplete");
      expect(r(model, id).title, id).toContain("Totals may be incomplete: 2 malformed lines skipped.");
    }
    // history starts this month on the 5th: the last 7 days are cut short
    const short = buildSidebarModel(snap({ history: [{ monthStartMs: MONTH0, totals: totals() }] }), TOKENS);
    expect(r(short, "week").value).toBe("1.5M* tok");
    expect(r(short, "week").title).toMatch(/fewer than 7 days/);
    expect(r(short, "projects/0").value).toMatch(/\*/);
    expect(r(buildSidebarModel(snap(), TOKENS), "week").value).toBe("1.5M tok");
  });

  it("session totals are named in title tooltips, never in the compact value", () => {
    const st = totals({ "model-a": counts({ sessionTotals: 2 }) }, { sessionTotals: 1, calls: 9 });
    const s = snap({ today: st, last7: st, thisMonth: st, last7Projects: [group("acme/web", 5, 5, { sessionTotals: 2 })], health: health({ sessionsFromTotals: 2 }) });
    const model = buildSidebarModel(s, TOKENS, ["web"]);
    expect(r(model, "today").value).toBe("1.5M tok");
    for (const id of ["today", "week", "month"]) expect(r(model, id).title, id).toContain(`Includes 1 session total. ${SESSION_TOTAL_SHORT}`);
    expect(r(model, "models/0").title).toContain("Includes 2 session totals.");
    expect(r(model, "projects/0").title).toContain("Includes 2 session totals.");
    expect(r(model, "workspace/week").title).toContain("Includes 2 session totals.");
    // session totals alone are not a data-health problem
    expect(model.health).toBeUndefined();
  });

  it("data health note: only when partial or format-changed, format change first", () => {
    expect(buildSidebarModel(snap(), TOKENS).health).toBeUndefined();
    expect(buildSidebarModel(snap({ health: health({ state: "no-data" }) }), TOKENS).health).toBeUndefined();
    expect(buildSidebarModel(snap({ health: health({ sessionsWithoutUsage: 4 }) }), TOKENS).health).toBeUndefined();
    const fc = buildSidebarModel(snap({ health: health({ state: "format-changed", unrecognized: 3, partial: true, malformed: 1 }) }), TOKENS).health!;
    expect(fc.text).toBe("Format changed · 3 lines unknown");
    expect(fc.link).toEqual({ command: "copilotUsageMonitor.showSection", args: ["health"] });
    const partial = buildSidebarModel(snap({ health: health({ partial: true, unreadableFiles: 1 }) }), TOKENS).health!;
    expect(partial.text).toBe("Partial data · 1 log could not be read");
  });

  it("insights: 'N findings · Review' only when the panel's month has findings", () => {
    expect(buildSidebarModel(snap(), TOKENS).insights).toBeUndefined();
    const month = { monthStartMs: MONTH0, isCurrent: true, days: [], sessions: [], projects: [], tools: [] };
    expect(buildSidebarModel(snap({ month: { ...month, insights: { items: [], coverage: { callSessions: 1, totalsOnlySessions: 0 } } } }), TOKENS).insights).toBeUndefined();
    const two = buildSidebarModel(snap({ month: { ...month, insights: { items: [insight(), insight()], coverage: { callSessions: 1, totalsOnlySessions: 0 } } } }), TOKENS);
    expect(two.insights).toMatchObject({ text: "2 findings", link: { command: "copilotUsageMonitor.showSection", args: ["insights"] } });
    const html = renderSidebarHtml(two, "x");
    expect(text(html)).toMatch(/Insights 2 findings Review/);
  });
});

describe("sidebar model: links", () => {
  it("row clicks open the matching section; a project row toggles the project filter", () => {
    const model = buildSidebarModel(snap({ filter: { project: "tools-cli" } }), TOKENS);
    expect(r(model, "today").link).toEqual({ command: "copilotUsageMonitor.showSection", args: ["daily"] });
    expect(r(model, "week").link).toEqual({ command: "copilotUsageMonitor.showSection", args: ["overview"] });
    expect(r(model, "month").link).toEqual({ command: "copilotUsageMonitor.showSection", args: ["overview"] });
    expect(r(model, "models/0").link).toEqual({ command: "copilotUsageMonitor.showSection", args: ["models"] });
    const p = grp(model, "projects")!.rows;
    expect(p[0]!.label).toBe("Fix the login bug");
    expect(p[0]!.link).toEqual({ command: "copilotUsageMonitor.setFilter", args: ["project", "", "projects"] });
    expect(p[0]!.marker).toEqual({ kind: "filtered", text: "filtered" });
    expect(p[0]!.spoken).toMatch(/, filtered$/);
    expect(p[1]!.link).toEqual({ command: "copilotUsageMonitor.setFilter", args: ["project", "acme/web", "projects"] });
    expect(p[1]!.marker).toBeUndefined();
  });

  it("the active filter's project stays listed even outside the top 5", () => {
    const many = Array.from({ length: 7 }, (_, i) => group(`p${i}`, (7 - i) * 1000, 1e9));
    const p = grp(buildSidebarModel(snap({ last7Projects: many, filter: { project: "p6" } }), TOKENS), "projects")!.rows;
    expect(p.map((x) => x.label)).toEqual(["p0", "p1", "p2", "p3", "p4", "p6"]);
  });

  it("allowlist: every link is a SIDEBAR command with validated arguments; every href in the HTML is one", () => {
    const month = { monthStartMs: MONTH0, isCurrent: true, days: [], sessions: [], projects: [], tools: [], insights: { items: [insight()], coverage: { callSessions: 1, totalsOnlySessions: 0 } } };
    const states = [
      undefined,
      snap({ health: health({ state: "no-dir" }) }),
      snap({ health: health({ state: "permission" }) }),
      snap({ month }),
      snap({ filter: { project: "acme/web" }, health: health({ state: "format-changed", unrecognized: 1, partial: true, malformed: 1 }) }),
    ];
    const allowed = new Set<string>();
    for (const s of states) {
      for (const view of [TOKENS, COST, { unit: "cost" as const, range: { min: 1, max: 2 } }]) {
        const model = buildSidebarModel(s, view, ["web"]);
        const links = [...sidebarRows(model).map((x) => x.link), model.insights?.link, model.health?.link, model.unitSwitch.link];
        for (const l of links) {
          if (!l) continue;
          expect(SIDEBAR_COMMANDS).toContain(l.command);
          if (l.command === "copilotUsageMonitor.showSection") {
            expect(l.args).toHaveLength(1);
            expect(isSectionId(l.args[0])).toBe(true);
          } else if (l.command === "copilotUsageMonitor.setFilter") {
            expect(l.args).toHaveLength(3);
            expect(l.args[0]).toBe("project");
            expect(l.args[2]).toBe("projects");
          } else {
            expect(l.args).toEqual([]);
          }
          allowed.add(sidebarHref(l));
        }
        allowed.add("command:copilotUsageMonitor.showDetails");
        const html = renderSidebarHtml(model, "vscode-resource:");
        const hrefs = [...html.matchAll(/\shref="([^"]*)"/g)].map((x) => x[1]!.replace(/&amp;/g, "&"));
        expect(hrefs.length).toBeGreaterThan(1);
        for (const h of hrefs) {
          expect(allowed.has(h), h).toBe(true);
          const cmd = /^command:([\w.]+)(\?|$)/.exec(h)?.[1];
          expect(SIDEBAR_COMMANDS as readonly string[]).toContain(cmd);
        }
        // every attribute that can load or run something is absent
        expect(html.replace(/"[^"]*"/g, '""')).not.toMatch(/<script|<img|<iframe|<form|<link|<[^>]*\s(?:src|on\w+)\s*=|javascript:/i);
      }
    }
    expect(() => sidebarHref({ command: "workbench.action.terminal.new" as never, args: [] })).toThrow();
  });

  it("an argument is JSON- then URI-encoded, so a hostile project key cannot break out of the href", () => {
    const hostile = `x" onclick="y' <b>&`;
    const html = renderSidebarHtml(buildSidebarModel(snap({ last7Projects: [group(hostile, 5, 5)] }), TOKENS), "x");
    const href = `command:copilotUsageMonitor.setFilter?${encodeURIComponent(JSON.stringify(["project", hostile, "projects"]))}`;
    // encodeURIComponent leaves ' alone; the attribute escape turns it into &#39;
    expect(html).toContain(`href="${href.replace(/'/g, "&#39;")}"`);
    expect(html).not.toContain(hostile);
  });
});

describe("sidebar html: page, states, escaping, copy", () => {
  it("same CSP as the panel, no scripts, theme variables only", () => {
    const html = renderSidebarHtml(buildSidebarModel(snap(), TOKENS), "vscode-webview://abc");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src vscode-webview://abc 'unsafe-inline';">`);
    expect(html).not.toMatch(/<script/i);
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|url\(|@import/i);
    // label left, value right; no row icons
    expect(html).toMatch(/<a class="row" href="command:copilotUsageMonitor\.showSection\?[^"]+" title="[^"]+" aria-label="Today: [^"]+"><span class="l">Today<\/span><span class="v">1\.5M tok<\/span><\/a>/);
    expect(html).not.toMatch(/codicon|<svg|<i\b/);
    expect(text(html)).toContain("Open dashboard");
    expect(html).toContain('<a class="btn" href="command:copilotUsageMonitor.showDetails"');
    expect(html).toContain('href="command:copilotUsageMonitor.toggleUnit"');
  });

  it("loading, no-dir and permission: in-page states naming the setting; no groups", () => {
    const loading = buildSidebarModel(undefined, TOKENS);
    expect(loading).toMatchObject({ state: "loading", groups: [] });
    expect(text(renderSidebarHtml(loading, "x"))).toContain("Reading Copilot session logs on this computer…");
    for (const st of ["no-dir", "permission"] as const) {
      const model = buildSidebarModel(snap({ health: health({ state: st }) }), TOKENS);
      expect(model).toMatchObject({ state: st, groups: [] });
      const t = text(renderSidebarHtml(model, "x"));
      expect(t).toContain("copilotUsageMonitor.copilotHome");
      expect(t).toContain("Refresh");
      expect(t).not.toContain("All projects");
    }
    expect(buildSidebarModel(snap({ today: undefined, health: health({ state: "no-data" }) }), TOKENS).state).toBe("ready");
    expect(buildSidebarModel(snap({ health: health({ state: "format-changed", unrecognized: 1 }) }), TOKENS).groups.length).toBeGreaterThan(0);
  });

  it("signature: equal for equal input, different when a figure, the unit or the folders change", () => {
    const a = buildSidebarModel(snap(), TOKENS, ["web"]);
    expect(buildSidebarModel(snap({ generatedAtMs: 1 }), TOKENS, ["web"]).signature).toBe(a.signature);
    expect(buildSidebarModel(snap({ today: totals({}, { input: m(5, 1) }) }), TOKENS, ["web"]).signature).not.toBe(a.signature);
    expect(buildSidebarModel(snap(), COST, ["web"]).signature).not.toBe(a.signature);
    expect(buildSidebarModel(snap(), TOKENS, []).signature).not.toBe(a.signature);
    expect(buildSidebarModel(undefined).signature).not.toBe(buildSidebarModel(snap({ health: health({ state: "no-dir" }) })).signature);
  });

  it("hostile log-derived strings are escaped everywhere: labels, titles and aria-labels", () => {
    const hostile = `[x](command:y)<b onmouseover="z">$(warning)'&`;
    const s = snap({
      last7: totals({ [hostile]: counts() }),
      last7Projects: [group(hostile, 5, 5, { label: `<img src=x onerror=alert(1)>` })],
      todayProjects: [group(hostile, 5, 5)],
    });
    const model = buildSidebarModel(s, TOKENS, ["web"]);
    expect(r(model, "models/0").label).toBe(hostile);
    const html = renderSidebarHtml(model, "x");
    expect(html).not.toContain("<b onmouseover");
    expect(html).not.toContain("<img");
    // with every (escaped, double-quoted) attribute value blanked, no tag has an event handler
    expect(html.replace(/"[^"]*"/g, '""')).not.toMatch(/<[^>]*\son\w+\s*=/i);
    expect(html).toContain("&lt;b onmouseover=&quot;z&quot;&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // a hostile folder name is escaped too
    const ws = renderSidebarHtml(buildSidebarModel(snap({ last7Projects: [group("o/<i>", 1, 1)] }), TOKENS, ["<i>"]), "x");
    expect(ws).toContain("This workspace · &lt;i&gt;");
    expect(ws).not.toContain("<i>");
  });

  it("copy check: every string and the rendered text pass in every state (stricter rule in tokens view)", () => {
    const month = { monthStartMs: MONTH0, isCurrent: true, days: [], sessions: [], projects: [], tools: [], insights: { items: [insight()], coverage: { callSessions: 1, totalsOnlySessions: 0 } } };
    const variants: (Snapshot | undefined)[] = [
      undefined,
      snap(),
      snap({ month }),
      snap({ today: undefined, current: undefined, last7: undefined, thisMonth: undefined, thisMonthProjects: [], last7Projects: [], todayProjects: [] }),
      snap({ health: health({ state: "format-changed", unrecognized: 2, partial: true, malformed: 1, overlong: 1, unreadableFiles: 1, shutdownOversize: 1, sessionsFromTotals: 1, sessionsWithoutUsage: 1 }) }),
      snap({ health: health({ state: "no-dir" }) }),
      snap({ health: health({ state: "permission" }) }),
      snap({ filter: { project: "acme/web" }, history: [{ monthStartMs: MONTH0 }] }),
      snap({ today: totals({}, { sessionTotals: 2, callsMissing: 1 }) }),
    ];
    for (const s of variants) {
      for (const view of [TOKENS, COST, { unit: "cost" as const, range: { min: 1, max: 2 } }, { unit: "tokens" as const, range: { max: 2 } }]) {
        const re = view.unit === "tokens" ? STRICT_RE : COPY_RE;
        const model = buildSidebarModel(s, view, ["web"]);
        for (const t of strings(model)) expect(t).not.toMatch(re);
        expect(text(renderSidebarHtml(model, "x")).split(LOCAL_BANNER).join("")).not.toMatch(re);
      }
    }
  });

  it("the adapter: webview view only, the closed command list, redraws skip unchanged HTML", () => {
    const adapter = readFileSync(join(__dirname, "..", "..", "src", "vscode", "sidebar.ts"), "utf8");
    expect(adapter).toContain("registerWebviewViewProvider(SUMMARY_VIEW_ID, this)");
    expect(adapter).toContain("{ enableScripts: false, enableForms: false, enableCommandUris: SIDEBAR_COMMANDS, localResourceRoots: [] }");
    expect(adapter).toContain("if (html === this.html) return;");
    expect(adapter).not.toMatch(/createTreeView|MarkdownString|resourceUri|retainContextWhenHidden/);
  });

  it("canary: a model and page built from real monitor snapshots carry no content strings", async () => {
    const root = await mkdtempP(join(tmpdir(), "cum-sidebar-"));
    try {
      const A = "0000aaaa-0000-4000-8000-000000000001";
      const L = "0000eeee-0000-4000-8000-000000000005";
      const start = JSON.stringify({ type: "session.start", id: "s", parentId: null, timestamp: new Date().toISOString(), data: { copilotVersion: "1.0.100-1", context: { cwd: "/srv/x/code/acme-web" }, prompt: CANARY } });
      await sessionTree(root, [
        { id: A, lines: start + "\n" + jsonl([usageEvent({ usageId: "a1", sourceSessionId: A })]) },
        { id: L, lines: jsonl([shutdownEvent({ timestamp: new Date().toISOString() })]) },
      ]);
      const snaps: Snapshot[] = [];
      const mon = new UsageMonitor({ root, rootSource: "default", isLive: () => false, log: new Logger(() => {}), onSnapshot: (x) => snaps.push(x), readProjects: true, readTotals: true });
      await mon.refresh({ full: true });
      mon.dispose();
      const s = snaps.at(-1)!;
      expect(s.last7Projects!.map((p) => p.name)).toContain("acme-web");
      for (const view of [TOKENS, COST]) {
        const model = buildSidebarModel(s, view, ["acme-web"]);
        expect(grp(model, "workspace")!.heading).toBe("This workspace · acme-web");
        expect(r(model, "workspace/today").value).not.toBe("—");
        const html = renderSidebarHtml(model, "x");
        for (const out of [JSON.stringify(model), html]) {
          expect(out).not.toContain(CANARY);
          expect(out).not.toContain("/srv/");
        }
      }
    } finally {
      await rmP(root, { recursive: true, force: true });
    }
  });
});

describe("v0.4 review fixes (side bar)", () => {
  it("Last 7 days: no arrow and a no-comparison note when the 7 days before were not fully read (review 4)", () => {
    const nov10 = new Date(2026, 10, 10).getTime();
    const s = snap({ dayStartMs: nov10, history: [{ monthStartMs: MONTH0, totals: totals() }] });
    const week = r(buildSidebarModel(s, TOKENS), "week");
    expect(week.title).not.toMatch(/[▲▼]/);
    expect(week.title).toMatch(/No comparison: the 7 days before/);
    expect(week.title).not.toMatch(/fewer than 7 days/);
    expect(week.value).toBe("1.5M tok");
    const short = r(buildSidebarModel(snap({ history: [{ monthStartMs: MONTH0, totals: totals() }] }), TOKENS), "week");
    expect(short.title).not.toMatch(/[▲▼]/);
    expect(short.title).toMatch(/fewer than 7 days/);
  });

  it("Last 7 days: neutral wording without an arrow when a week has nothing logged (review 5)", () => {
    const empty = r(buildSidebarModel(snap({ last7: undefined }), TOKENS), "week");
    expect(empty.title).toContain("Nothing logged yet.");
    expect(empty.title).not.toMatch(/[▲▼]|none yet/);
    const fresh = r(buildSidebarModel(snap({ prior7: undefined }), TOKENS), "week");
    expect(fresh.title).toContain("Nothing logged in the 7 days before.");
    expect(fresh.title).not.toMatch(/[▲▼]/);
    for (const x of [empty, fresh]) expect(x.title.split(LOCAL_BANNER).join("")).not.toMatch(STRICT_RE);
  });

  it("calls missing from a session total show as not logged or starred in the title, never a bare 0 (N1)", () => {
    const t = totals({}, { records: 1, calls: 0, sessionTotals: 1, callsMissing: 1 });
    const today = r(buildSidebarModel(snap({ today: t }), TOKENS), "today");
    expect(today.title).toContain("Calls: —");
    expect(today.title).not.toMatch(/\b0 calls\b|Calls: 0\b/);
    const some = totals({}, { records: 3, calls: 2, sessionTotals: 1, callsMissing: 1 });
    expect(r(buildSidebarModel(snap({ today: some }), TOKENS), "today").title).toContain("Calls: 2*");
    const p = r(buildSidebarModel(snap({ last7Projects: [group("acme/web", 5, 5, { calls: 0, callsMissing: 1 })] }), TOKENS), "projects/0");
    expect(p.title).toContain("calls not logged in 1 session.");
  });
});

describe("sidebar: v0.4 review fixes", () => {
  it("design #6: a project shows its repo name when unique; owner/repo stays in the title and spoken label", () => {
    const s = snap({ last7Projects: [group("acme/web", 1_000, 9e9), group("other/web", 900, 8e9), group("acme/api", 800, 7e9), group("tools-cli", 9_000, 1e9, { label: "Fix the login bug" })] });
    const rows = grp(buildSidebarModel(s, COST), "projects")!.rows;
    const by = (name: string) => rows.find((x) => x.title.includes(`Project: ${name}`))!;
    expect(by("acme/api").label).toBe("api");
    expect(by("acme/api").spoken).toMatch(/^acme\/api: /);
    // two projects named "web": both keep the owner
    expect(by("acme/web").label).toBe("acme/web");
    expect(by("other/web").label).toBe("other/web");
    expect(by("tools-cli").label).toBe("Fix the login bug");
  });

  it("design #6: USD rows carry no ' est.'; the footer says it once; spoken labels still say estimated", () => {
    const model = buildSidebarModel(snap(), COST);
    for (const x of sidebarRows(model)) expect(x.value).not.toContain("est.");
    expect(r(model, "today").spoken).toMatch(/US dollars estimated$/);
    const html = renderSidebarHtml(model, "x");
    expect(html.match(/est\./g)).toHaveLength(1);
    expect(html).toContain('<div class="foot">Local logs only · USD figures are est. · <a');
    expect(renderSidebarHtml(buildSidebarModel(snap(), TOKENS), "x")).toContain('<div class="foot">Local logs only · <a');
  });

  it("M3, M5, m9: text-safe warning tones, a visible button focus ring, a main landmark and an h1", () => {
    const html = renderSidebarHtml(buildSidebarModel(snap({ health: health({ partial: true, malformed: 1 }) }), COST), "x");
    expect(html).toContain(".btn:focus-visible{outline-offset:2px}");
    expect(html).not.toMatch(/(?:\.star|\.mk\.over|\.health a)\{color:var\(--vscode-editorWarning-foreground\)\}/);
    expect(html).toMatch(/\.star\{color:color-mix\(in srgb,var\(--vscode-editorWarning-foreground\) 60%,var\(--vscode-foreground\)\)\}/);
    expect(html).toContain('<main aria-label="Copilot usage summary">');
    expect(html).toContain('<h1 class="sr">Copilot usage summary</h1>');
    expect(html.match(/<main[ >]/g)).toHaveLength(1);
  });
  it("cost view in CAD: side bar labels and figures are converted", () => {
    const cad = { code: "CAD", rate: 1.4, date: "2026-11-06" };
    setDisplayCurrency(cad);
    try {
      const json = JSON.stringify(buildSidebarModel(snap(), { unit: "cost", currency: cad }));
      expect(json).toContain("CAD");
      expect(json).not.toContain("USD (est.)");
      expect(json.replace(/× \$0\.01/g, "")).not.toMatch(/(?<![A-Z])\$\d/);
    } finally {
      setDisplayCurrency(undefined);
    }
  });
});
