// v0.4 section navigation (D30) and section content (D32).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_BANNER, SESSION_TOTAL_NOTE } from "../../src/core/format";
import {
  escapeHtml,
  isSectionId,
  PANEL_COMMANDS,
  renderPanelHtml,
  SECTION_DEFS,
  SECTIONS,
  sectionHref,
  sectionPickItems,
  type SectionId,
} from "../../src/core/panelHtml";
import { PANEL_CSS } from "../../src/core/panelCss";
import type { Counts, Health, Insight, Metric, SessionSummary, Snapshot, Totals } from "../../src/core/types";
import { CANARY } from "../fixtures/build";

const m = (sum: number, reported: number, missing = 0): Metric => ({ sum, reported, missing });

function counts(o: Partial<Counts> = {}): Counts {
  return {
    records: 2,
    calls: 2,
    sessionTotals: 0,
    input: m(1_200_000, 2),
    output: m(300_000, 2),
    cacheRead: m(500, 2),
    cacheWrite: m(50, 2),
    reasoning: m(30, 2),
    durationMs: m(83_000, 2),
    nanoAiu: m(4e9, 2),
    callsMissing: 0,
    callNanoAiu: o.nanoAiu ?? m(4e9, 2),
    ...o,
  };
}
const totals = (o: Partial<Counts> = {}, byModel: Record<string, Counts> = { "model-a": counts(o) }): Totals => ({ ...counts(o), byModel });
function health(o: Partial<Health> = {}): Health {
  return {
    state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0,
    unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0, ...o,
  };
}
const NOV = new Date(2026, 10, 1).getTime();
const DAY0 = new Date(2026, 10, 5).getTime();
const days = (n: number, filled: Record<number, Totals>) =>
  Array.from({ length: n }, (_, i) => {
    const dayStartMs = new Date(2026, 10, i + 1).getTime();
    return filled[i + 1] ? { dayStartMs, totals: filled[i + 1] } : { dayStartMs };
  });
function snap(o: Partial<Snapshot> = {}): Snapshot {
  const t = totals();
  return {
    generatedAtMs: new Date(2026, 10, 5, 10).getTime(),
    dayStartMs: DAY0,
    today: t,
    current: { folderId: "3f2a91c0-0000-4000-8000-000000000001", live: true, pinned: false, totals: t },
    sessions: [],
    health: health(),
    month: { monthStartMs: NOV, isCurrent: true, days: days(5, { 3: t, 5: t }), sessions: [], projects: [], tools: [], totals: t },
    history: [{ monthStartMs: NOV, totals: t }],
    ...o,
  };
}
const month = (o: Partial<NonNullable<Snapshot["month"]>>) => ({ ...snap().month!, ...o });

function text(html: string): string {
  const titles = [...html.matchAll(/ (?:title|aria-label)="([^"]*)"/g)].map((x) => x[1]).join(" ");
  return (html + " " + titles)
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<span class="sr">[^<]*<\/span>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;
const ROOT = join(__dirname, "..", "..");
const render = (s: Snapshot | undefined, section?: SectionId, view?: Parameters<typeof renderPanelHtml>[2]) => renderPanelHtml(s, "x", view, section);

describe("command allowlist", () => {
  it("PANEL_COMMANDS is exactly the six panel commands", () => {
    expect([...PANEL_COMMANDS]).toEqual([
      "copilotUsageMonitor.selectMonth",
      "copilotUsageMonitor.setUnit",
      "copilotUsageMonitor.setFilter",
      "copilotUsageMonitor.showSection",
      "copilotUsageMonitor.showSession",
      "copilotUsageMonitor.toggleNav",
    ]);
  });

  it("the webview's enableCommandUris is PANEL_COMMANDS, with scripts off", () => {
    const panel = readFileSync(join(ROOT, "src", "vscode", "panel.ts"), "utf8");
    expect(panel).toContain("enableCommandUris: PANEL_COMMANDS");
    expect(panel).toContain("enableScripts: false");
    expect(panel).toContain("localResourceRoots: []");
  });

  it("every command the panel links to is registered and contributed", () => {
    const ext = readFileSync(join(ROOT, "src", "extension.ts"), "utf8");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const contributed = pkg.contributes.commands.map((c: { command: string }) => c.command);
    for (const c of PANEL_COMMANDS) {
      expect(ext).toContain(`registerCommand("${c}"`);
      expect(contributed).toContain(c);
    }
    expect(pkg.contributes.commands).toContainEqual(expect.objectContaining({ command: "copilotUsageMonitor.showSection", title: "Show Section…", category: "Copilot Usage" }));
    const hidden = (pkg.contributes.menus?.commandPalette ?? []).filter((x: { when?: string }) => x.when === "false").map((x: { command: string }) => x.command);
    expect(hidden).not.toContain("copilotUsageMonitor.showSection");
  });
});

describe("sections", () => {
  it("are the eight ids in nav order, grouped Usage / Insight / Health under Overview (A2)", () => {
    expect([...SECTIONS]).toEqual(["overview", "sessions", "daily", "models", "projects", "tools", "insights", "health"]);
    expect(SECTION_DEFS.map((d) => d.label)).toEqual(["Overview", "Sessions", "Daily", "Models", "Projects", "Tools", "Insights", "Data health"]);
    expect(SECTION_DEFS.map((d) => d.group)).toEqual([undefined, "Usage", "Usage", "Usage", "Usage", "Usage", "Insight", "Health"]);
    expect(new Set(SECTION_DEFS.map((d) => d.icon)).size).toBe(8);
  });

  it("isSectionId accepts the closed list only", () => {
    for (const id of SECTIONS) expect(isSectionId(id)).toBe(true);
    for (const bad of ["Overview", "", " health", "health ", "__proto__", "constructor", 1, null, undefined, {}, ["overview"]]) expect(isSectionId(bad)).toBe(false);
  });

  it("quick pick items come from the section list, the current one marked", () => {
    const items = sectionPickItems("models");
    expect(items.map((i) => i.id)).toEqual([...SECTIONS]);
    expect(items.find((i) => i.id === "models")!.description).toContain("(shown now)");
    for (const i of items) expect(`${i.label} ${i.description}`).not.toMatch(COPY_RE);
  });

  it("an unknown section renders Overview", () => {
    const html = renderPanelHtml(snap(), "x", undefined, "bogus" as SectionId);
    expect(html).toContain('<h2 id="section-title" class="sec">Overview</h2>');
  });
});

describe("nav and page structure", () => {
  const states: [string, Snapshot | undefined][] = [
    ["loading", undefined],
    ["ok", snap()],
    ["no-dir", snap({ today: undefined, current: undefined, health: health({ state: "no-dir" }) })],
    ["format-changed", snap({ health: health({ state: "format-changed", unrecognized: 1 }) })],
    ["partial", snap({ health: health({ partial: true, malformed: 2 }) })],
  ];

  it.each(states)("every section has one nav, one main, one h1 and h2, one current link (%s)", (_name, s) => {
    for (const section of SECTIONS) {
      const html = render(s, section).replace(/<style>[\s\S]*?<\/style>/, "");
      const def = SECTION_DEFS.find((d) => d.id === section)!;
      expect(html.match(/<nav /g), section).toHaveLength(1);
      expect(html).toContain('<nav class="sidenav" aria-label="Sections">');
      expect(html.match(/<main /g)).toHaveLength(1);
      expect(html).toContain('<main id="main" class="content" aria-labelledby="section-title">');
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      // the section h2, plus the state note's own (screen-reader) h2 when there is one (m9)
      const problem = html.includes('id="problem-title"') ? 1 : 0;
      expect(html.match(/<h2[ >]/g)).toHaveLength(1 + problem);
      if (problem) expect(html).toContain('<h2 id="problem-title" class="sr">Problem reading logs</h2>');
      expect(html).toContain(`<h2 id="section-title" class="sec">${escapeHtml(def.label)}</h2>`);
      expect(html.match(/<h[4-6][ >]/g)).toBeNull();
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toContain(`<title>${escapeHtml(def.label)} · Copilot Usage (Local)</title>`);
      // the skip link is the first focusable element
      const body = html.slice(html.indexOf("<body>"));
      expect(body.indexOf('<a class="skip" href="#main">Skip to ')).toBe(body.indexOf("<a "));
      // the nav comes before main; h3s only inside main
      expect(html.indexOf("<nav ")).toBeLessThan(html.indexOf("<main "));
      expect(html.indexOf("<h3")).toSatisfy((i: number) => i < 0 || i > html.indexOf("<main ") || html.slice(i, i + 40).includes('class="sr"'));
      const t = text(html).split(LOCAL_BANNER).join("");
      expect(t, section).not.toMatch(COPY_RE);
      expect(html).not.toMatch(/<script|\son\w+\s*=|https?:\/\//i);
    }
  });

  it("nav: eight links in order, each a showSection command link, the active one its own id", () => {
    for (const active of SECTIONS) {
      const html = render(snap(), active);
      const nav = html.slice(html.indexOf("<nav "), html.indexOf("</nav>"));
      const links = [...nav.matchAll(/<a href="([^"]+)"( aria-current="page")?>/g)];
      expect(links.map((l) => l[1]!.replace(/&amp;/g, "&"))).toEqual(SECTIONS.map((id) => sectionHref(id)));
      expect(links.filter((l) => l[2]).map((l) => l[1])).toEqual([escapeHtml(sectionHref(active))]);
      expect(sectionHref(active)).toBe(`command:copilotUsageMonitor.showSection?${encodeURIComponent(JSON.stringify([active]))}`);
      // Overview on top with no group, then three labelled groups (A2)
      expect(nav).toMatch(/^<nav class="sidenav" aria-label="Sections"><div class="navtop"><a class="navtoggle" [^>]*>(<svg [^]*?<\/svg>)<\/a><\/div><ul><li><a [^>]*>(<svg [^]*?<\/svg>)<span class="lbl">Overview<\/span><\/a><\/li><\/ul><p class="grp" id="nav-usage">Usage<\/p><ul aria-labelledby="nav-usage">/);
      const groups = [...nav.matchAll(/<p class="grp" id="(nav-\w+)">(\w+)<\/p><ul aria-labelledby="(nav-\w+)">([^]*?)<\/ul>/g)];
      expect(groups.map((g) => g[2])).toEqual(["Usage", "Insight", "Health"]);
      for (const g of groups) expect(g[1]).toBe(g[3]);
      const labels = (body: string) => [...body.matchAll(/<\/svg><span class="lbl">([^<]+)/g)].map((x) => x[1]);
      expect(groups.map((g) => labels(g[4]!))).toEqual([["Sessions", "Daily", "Models", "Projects", "Tools"], ["Insights"], ["Data health"]]);
      // every link (eight sections plus the collapse toggle) carries a decorative inline icon
      expect(nav.match(/<a [^>]*><svg class="ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false">/g)).toHaveLength(9);
    }
  });

  it("nav toggle: collapses to an icon rail and expands again, labels kept for screen readers", () => {
    const toggleHref = escapeHtml(`command:copilotUsageMonitor.toggleNav?${encodeURIComponent(JSON.stringify([]))}`);
    const open = renderPanelHtml(snap(), "x", undefined, "sessions");
    expect(open).toContain('<div class="shell">');
    expect(open).toContain('<nav class="sidenav" aria-label="Sections">');
    expect(open).toContain(`<a class="navtoggle" href="${toggleHref}" title="Collapse side navigation" aria-label="Collapse side navigation" aria-expanded="true">`);
    expect(open).not.toMatch(/<a href="[^"]+"( aria-current="page")? title=/);

    const shut = renderPanelHtml(snap(), "x", undefined, "sessions", true);
    expect(shut).toContain('<div class="shell navcollapsed">');
    expect(shut).toContain('<nav class="sidenav collapsed" aria-label="Sections">');
    expect(shut).toContain(`<a class="navtoggle" href="${toggleHref}" title="Expand side navigation" aria-label="Expand side navigation" aria-expanded="false">`);
    // each section link keeps its label (visually hidden by CSS) and gains a tooltip
    expect(shut).toMatch(/aria-current="page" title="Sessions"><svg [^]*?<\/svg><span class="lbl">Sessions<\/span>/);
    expect(renderPanelHtml(undefined, "x", undefined, "overview", true)).toContain('<nav class="sidenav collapsed"');
    expect(PANEL_CSS).toContain(".shell.navcollapsed { grid-template-columns: 44px minmax(0, 1fr); }");
    // user-level only: the toggle writes Global, so a workspace value must not shadow it
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.contributes.configuration.properties["copilotUsageMonitor.panelNavCollapsed"]).toMatchObject({ type: "boolean", default: false, scope: "application" });
  });

  it("toolbar, banner and state note are chrome: on every section", () => {
    const s = snap({ health: health({ state: "no-dir" }), filter: { tool: "bash" } });
    for (const section of SECTIONS) {
      const html = render(s, section);
      expect(html).toContain('role="group" aria-label="Month, unit and filter"');
      expect(html).toContain("Pick month…");
      expect(html).toContain("USD (est.)");
      expect(html).toMatch(/class="fchip"[^>]*>Tool: <b>bash<\/b>/);
      expect(html).toContain("copilotUsageMonitor.copilotHome");
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain("aria-live");
    }
  });

  it("each section names its scope under the heading", () => {
    expect(text(render(snap(), "overview"))).toContain("Today, the current session and November at a glance.");
    expect(text(render(snap(), "projects"))).toContain("Usage by repository or folder in November. Click a row to filter.");
    const past = snap({ month: month({ monthStartMs: new Date(2026, 9, 1).getTime(), isCurrent: false, days: [] }) });
    expect(text(render(past, "sessions"))).toContain("The current session and October 2026's sessions, largest first.");
    expect(text(render(past, "daily"))).toContain("Each day of October 2026: daily bars and the calendar.");
    expect(text(render(past, "daily"))).not.toContain("Today in detail");
  });

  it("nav marks: Insights count, Data health * when partial and ! when it needs attention, in words too", () => {
    const ins: Insight = { id: "cache-reuse", nanoAiu: 3e11, tokens: 1, calls: 21, sessions: 3, model: "m", share: 0.3, meanPromptTokens: 30000 };
    const withIns = snap({ month: month({ insights: { items: [ins], coverage: { callSessions: 3, totalsOnlySessions: 0 } } }) });
    expect(render(withIns)).toMatch(/>Insights<\/span><span class="cnt num" aria-hidden="true"> · 1<\/span><span class="sr"> \(1 finding\)<\/span><\/a>/);
    expect(render(snap())).toMatch(/>Insights<\/span><\/a>/);
    expect(render(snap({ health: health({ partial: true, malformed: 1 }) }))).toContain('<span class="sr"> (partial data)</span>');
    expect(render(snap({ health: health({ state: "format-changed" }) }))).toContain('<span class="sr"> (needs attention)</span>');
    expect(render(snap())).toMatch(/>Data health<\/span><\/a>/);
  });

  it("loading renders the nav and Loading…, with no figures", () => {
    const html = render(undefined, "sessions");
    expect(html).toMatch(/aria-current="page"><svg [^]*?<\/svg><span class="lbl">Sessions/);
    expect(text(html)).toContain("Loading…");
    expect(html).not.toContain("Costliest sessions");
  });

  it("the selected unit is named for screen readers", () => {
    expect(render(snap())).toContain('<span class="seg on">Tokens<span class="sr"> (selected)</span></span>');
  });

  it("CSS: narrow row below 720px, focus outlines, high contrast and forced colours, nothing remote", () => {
    expect(PANEL_CSS).toMatch(/@media \(max-width: 720px\) \{[^@]*\.sidenav/);
    expect(PANEL_CSS).toContain("@media (forced-colors: active)");
    expect(PANEL_CSS).toContain(":focus-visible");
    expect(PANEL_CSS).toContain("body.vscode-high-contrast .sidenav a");
    expect(PANEL_CSS).toContain("--vscode-contrastActiveBorder");
    expect(PANEL_CSS).not.toMatch(/url\(|@import|@font-face/);
  });
});

describe("overview content (D32)", () => {
  // Two months read, so both weeks before Nov 5 are inside the history window.
  const OCT = new Date(2026, 9, 1).getTime();
  const twoMonths = { history: [{ monthStartMs: OCT }, { monthStartMs: NOV, totals: totals() }] };
  it("Last 7 days: ▲ or ▼ with a multiplier against the prior 7 days, never a percent sign", () => {
    const up = text(render(snap({ ...twoMonths, last7: totals({ input: m(2_800_000, 2), output: m(0, 2) }), prior7: totals({ input: m(2_000_000, 2), output: m(0, 2) }) })));
    expect(up).toContain("Last 7 days 2.8M ▲ 1.4× the 7 days before");
    const down = text(render(snap({ ...twoMonths, last7: totals({ nanoAiu: m(3e9, 1) }), prior7: totals({ nanoAiu: m(1e10, 1) }) }), "overview", { unit: "cost" }));
    expect(down).toContain("$0.030 ▼ 0.3× the 7 days before");
    const none = text(render(snap({ last7: undefined, prior7: undefined })));
    expect(none).toContain("Last 7 days — Nothing logged");
    expect(none).toContain("Not filtered.");
  });

  it("Month tile carries the target state of the viewed month in words", () => {
    const html = render(snap({ month: month({ totals: totals({ nanoAiu: m(7000e9, 1) }) }) }), "overview", { unit: "cost", range: { max: 60 } });
    expect(html).toContain('class="card mtd st-over"');
    expect(text(html)).toContain("Target up to $60.00: Over");
  });

  it("Today names its session totals; calls come from the request count", () => {
    const t = totals({ calls: 14, sessionTotals: 1 });
    expect(text(render(snap({ today: t })))).toContain("input + output tokens · 14 calls · includes 1 session total");
  });
});

describe("daily content (D32)", () => {
  it("calendar and bar titles name session totals; a footnote says they land on the end day", () => {
    const t = totals({ sessionTotals: 1 });
    const html = render(snap({ month: month({ days: days(5, { 3: t }), totals: t }) }), "daily");
    expect(html).toContain('data-tip="Tue Nov 3: 1.5M tokens (includes 1 session total)">3<small>');
    expect(html).toContain('data-tip="Tue Nov 3: 1.5M tokens (includes 1 session total)"><span class="track">');
    const v = text(html);
    expect(v).toContain("November includes 1 session total: each is counted on the day its session ended");
    expect(v).toContain(SESSION_TOTAL_NOTE);
    expect(text(render(snap(), "daily"))).not.toContain(SESSION_TOTAL_NOTE);
  });

  it("the daily bars have a text alternative", () => {
    expect(render(snap(), "daily")).toMatch(/role="img" aria-label="November: 2 of 5 days active, average 1\.5M tokens per active day, peak 1\.5M on Nov 3"/);
  });
});

function row(i: number, o: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    folderId: `f${i}`,
    firstMs: new Date(2026, 10, 3, 14, 2).getTime(),
    lastMs: DAY0,
    calls: 12,
    topModel: "model-a",
    tokens: m(1000 - i, 12),
    nanoAiu: m((100 - i) * 1e9, 12),
    input: m(1000, 12),
    cacheRead: m(620, 12),
    ...o,
  };
}

describe("sessions content (D32)", () => {
  it("columns: session, started, calls, top model, tokens, USD, cache read share, growth", () => {
    const html = render(snap({ month: month({ sessions: [row(1, { label: "acme/web", growth: 6.2 })], sessionCount: 1 }) }), "sessions");
    expect(html).toContain(["Session", "Started", "Calls", "Top model", "Tokens", "USD (est.)", "Cache read", "Growth"].map((h) => `<th scope="col">${h}</th>`).join(""));
    const v = text(html);
    expect(v).toContain("acme/web 00000001");
    expect(v).toContain("Nov 3 14:02");
    expect(v).toContain("62 in 100");
    expect(v).toContain("6.2× ▲");
    expect(v).toContain("Current session");
  });

  it("cache read share is — when not reported, never 0", () => {
    const html = render(snap({ month: month({ sessions: [row(1, { cacheRead: m(0, 0, 12) })] }) }), "sessions");
    expect(html).toMatch(/<td class="num muted"><span aria-hidden="true">—<\/span><span class="sr">not reported<\/span><\/td><td class="num" title="Needs at least 10 calls/);
  });

  it("shows 10 of up to 50 rows, folds the rest, and counts the sessions not kept", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    const html = render(snap({ month: month({ sessions: rows, sessionCount: 57 }) }), "sessions");
    const table = html.slice(html.indexOf("Costliest sessions"));
    const [visible, folded] = table.split('<details class="more">');
    expect(visible!.match(/<tr>/g)!.length - 1).toBe(10);
    expect(folded).toContain("<summary>Show 40 more</summary>");
    const v = text(html);
    expect(v).toContain("November · 57 sessions · largest first");
    expect(v).toContain("7 more sessions in November are not listed.");
  });

  it("hostile labels and model ids are escaped", () => {
    const evil = `<img src=x onerror=1>${CANARY}`;
    const html = render(snap({ month: month({ sessions: [row(1, { label: evil, topModel: evil })] }) }), "sessions");
    expect(html).not.toContain("<img");
    expect(html).toContain(escapeHtml(evil));
  });
});

describe("models content (D32)", () => {
  it("shows the viewed month with a Share column out of 100", () => {
    const t = totals({}, { big: counts({ input: m(3_000_000, 1), output: m(0, 1) }), small: counts({ input: m(1_000_000, 1), output: m(0, 1) }) });
    const html = render(snap({ today: undefined, month: month({ totals: { ...t, input: m(4_000_000, 2), output: m(0, 2) } }) }), "models");
    expect(html).toContain('<th scope="col">Model</th><th scope="col">Share</th>');
    const v = text(html);
    expect(v).toContain("November 2026 by model");
    expect(v).toMatch(/big 75 in 100/);
    expect(v).toMatch(/small 25 in 100/);
  });
});

describe("tools content (D32)", () => {
  const tool = { name: "bash", builtIn: true, uses: 3, calls: 2, tokens: m(10, 2), nanoAiu: m(1e9, 2) };
  it("footnote: session totals have no tool data, with the count when there are some", () => {
    expect(text(render(snap({ month: month({ tools: [tool] }) }), "tools"))).toContain("Session totals from Copilot before 1.0.99 have no tool data");
    expect(text(render(snap({ month: month({ tools: [tool], totalsSessions: 3 }) }), "tools"))).toContain("3 sessions counted from session totals are not in this table: session totals have no tool data.");
    expect(text(render(snap({ month: month({ tools: [], totalsSessions: 1 }) }), "tools"))).toContain(
      "No tool use logged in November. Tool use is logged per model call; the 1 session counted from session totals has no tool data.",
    );
  });
});

describe("insights content (D32)", () => {
  const growth: Insight = { id: "context-growth", nanoAiu: 3.1e11, tokens: 2_500_000, calls: 80, sessions: 2, top: [{ sessionId: "aaaaaaaa-1", label: `<b>${CANARY}`, growth: 4.1 }, { sessionId: "bbbbbbbb-2", growth: 3.2 }] };
  const cache: Insight = { id: "cache-reuse", nanoAiu: 6.8e11, tokens: 1_000_000, calls: 54, sessions: 5, model: "gpt-x<y>", share: 0.47, meanPromptTokens: 40_000 };
  const withItems = (items: Insight[], totalsOnly = 0) => snap({ month: month({ insights: { items, coverage: { callSessions: 6, totalsOnlySessions: totalsOnly } } }) });

  it("renders each finding with neutral copy, escaped names and the coverage footer", () => {
    const html = render(withItems([cache, growth], 31), "insights");
    const v = text(html);
    expect(v).toContain("Low cache reuse on gpt-x<y>");
    expect(v).toContain("Over 54 calls in 5 sessions, about 4 in 10 prompt tokens were read from cache. These calls cost about $6.80 (est.).");
    expect(v).toContain("Sessions that grew costly");
    expect(v).toContain("2 sessions got more expensive as they went on: their later calls cost 4.1× and 3.2× the first ones. The cost above each session's starting level came to about $3.10 (est.).");
    expect(v).toContain(`Sessions: <b>${CANARY} (aaaaaaaa) and bbbbbbbb.`);
    expect(v).toContain("Based on 6 sessions with per-call records; 31 older sessions counted from session totals are not included");
    expect(v).toContain("Thresholds are rules of thumb");
    expect(html).not.toContain("<b>" + CANARY);
    expect(html).not.toContain("gpt-x<y>");
    expect(v).not.toMatch(/\bsav(e|ing)|waste/i);
    expect(v.split(LOCAL_BANNER).join("")).not.toMatch(COPY_RE);
    expect(html.indexOf("Low cache reuse")).toBeLessThan(html.indexOf("Sessions that grew costly"));
  });

  it("evidence follows the unit", () => {
    expect(text(render(withItems([cache]), "insights"))).toContain("54 calls · 5 sessions · 1.0M input + output tokens");
    expect(text(render(withItems([cache]), "insights", { unit: "cost" }))).toContain("54 calls · 5 sessions · about $6.80 (est.)");
  });

  it("empty state", () => {
    const v = text(render(withItems([]), "insights"));
    expect(v).toContain("Nothing to point out in November.");
    expect(v).toContain("using only the numbers on this computer");
    expect(v).toContain("Based on 6 sessions with per-call records.");
  });
});

describe("v0.4 review fixes (panel)", () => {
  it("Models Per call uses per-call AIU only, never a session total's (review 2)", () => {
    // 4 calls at $0.01 plus one session total of $0.40 on the same model.
    const c = counts({ records: 5, calls: 10, sessionTotals: 1, nanoAiu: m(4.4e10, 5), callNanoAiu: m(4e9, 4) });
    const html = render(snap({ month: month({ totals: { ...c, byModel: { "model-a": c } } }) }), "models", { unit: "cost" });
    const v = text(html);
    expect(v).toContain("$0.010");
    expect(v).not.toContain("$0.11");
    // only session totals in the bucket: no per-call figure
    const onlyTotals = counts({ records: 1, calls: 6, sessionTotals: 1, nanoAiu: m(4e10, 1), callNanoAiu: m(0, 0, 0) });
    const html2 = render(snap({ month: month({ totals: { ...onlyTotals, byModel: { "model-a": onlyTotals } } }) }), "models", { unit: "cost" });
    expect(html2).toMatch(/<td class="num muted"><span aria-hidden="true">—<\/span><span class="sr">not reported<\/span><\/td><td class="num">6<\/td><\/tr>/);
  });

  it("Last 7 days: no change and a star when the history window starts inside the two weeks (review 4)", () => {
    const nov3 = new Date(2026, 10, 3).getTime();
    const s = snap({ dayStartMs: nov3, history: [{ monthStartMs: NOV, totals: totals() }], last7: totals({ input: m(2_800_000, 2), output: m(0, 2) }), prior7: totals({ input: m(2_000_000, 2), output: m(0, 2) }) });
    const v = text(render(s));
    expect(v).toContain("Last 7 days 2.8M * No comparison");
    expect(v).not.toMatch(/[▲▼]/);
    expect(v).toMatch(/fewer than 7 days/);
    // Nov 10: last 7 days fully read, the 7 before not
    const nov10 = new Date(2026, 10, 10).getTime();
    const v2 = text(render({ ...s, dayStartMs: nov10 }));
    expect(v2).toContain("Last 7 days 2.8M No comparison");
    expect(v2).toMatch(/No comparison: the 7 days before/);
    expect(v2).not.toMatch(/fewer than 7 days/);
  });

  it("Last 7 days: neutral wording without an arrow when a week has nothing logged (review 5)", () => {
    const read = { history: [{ monthStartMs: new Date(2026, 9, 1).getTime() }, { monthStartMs: NOV, totals: totals() }] };
    const empty = text(render(snap({ ...read, last7: undefined, prior7: totals() })));
    expect(empty).toContain("Last 7 days — Nothing logged yet");
    expect(empty).not.toMatch(/[▲▼]/);
    const fresh = text(render(snap({ ...read, last7: totals(), prior7: undefined })));
    expect(fresh).toContain("Nothing logged in the 7 days before");
    expect(fresh).not.toMatch(/[▲▼]/);
    for (const v of [empty, fresh]) expect(v.split(LOCAL_BANNER).join("")).not.toMatch(COPY_RE);
  });

  it("calls are — or starred when a session total lacks its request count, never a bare 0 (N1)", () => {
    const t = totals({ records: 1, calls: 0, sessionTotals: 1, callsMissing: 1 });
    const v = text(render(snap({ today: t, current: undefined }), "overview"));
    expect(v).toContain("calls not logged");
    expect(v).not.toMatch(/\b0 calls\b/);
    const some = totals({ records: 3, calls: 2, sessionTotals: 1, callsMissing: 1 });
    expect(text(render(snap({ today: some }), "overview"))).toContain("2 calls*");
    const html = render(snap({ month: month({ totals: { ...t, byModel: { "model-a": t } }, sessions: [row(1, { calls: 0, callsMissing: 1, sessionTotal: true })] }) }), "models");
    expect(html).not.toMatch(/<td class="num">0<\/td><\/tr>/);
    const sess = render(snap({ month: month({ sessions: [row(1, { calls: 0, callsMissing: 1, sessionTotal: true })] }) }), "sessions");
    expect(sess).not.toContain('<td class="num">0</td>');
    expect(sess).toContain('<td class="num muted"');
  });

  it("Sessions footnote: Started is the logged session start for a session total (N9)", () => {
    const html = render(snap({ month: month({ sessions: [row(1, { sessionTotal: true })] }) }), "sessions");
    expect(text(html)).toMatch(/Started = first record in November, or the session start Copilot logged with a session total/);
  });
});
