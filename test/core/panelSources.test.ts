// v0.8 (D40, D46, D49): the source dimension in the panel. Snapshots are built by hand;
// nothing here reads a log. A Copilot-only snapshot shows no chip, card or note.
import { describe, expect, it } from "vitest";
import { COST_SOURCES_NOTE, INSIGHTS_SOURCES_NOTE } from "../../src/core/format";
import { filterHref } from "../../src/core/panel/links";
import { renderSourcesCard, sourceChips, sourcesHealthBox } from "../../src/core/panel/sources";
import { escapeHtml, renderPanelHtml } from "../../src/core/panelHtml";
import type { Counts, Health, Metric, Snapshot, SourceHealth, Totals, ViewOptions } from "../../src/core/types";
import { CANARY } from "../fixtures/build";

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
function sh(o: Partial<SourceHealth> = {}): SourceHealth {
  return { state: "ok", rootSource: "default", files: 0, sessions: 0, unreadableFiles: 0, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, ...o };
}

const NOW = new Date(2026, 10, 5, 10, 0, 0);
const DAY0 = new Date(2026, 10, 5).getTime();
const MONTH0 = new Date(2026, 10, 1).getTime();
const SID = "3f2a91c0-0000-4000-8000-000000000001";
const CC = counts({ records: 3, calls: 3, input: m(900_000, 3), output: m(100_000, 3), nanoAiu: m(0, 0), callNanoAiu: m(0, 0), sources: { "claude-code": 3 } });
const CP = counts({ sources: { copilot: 2 } });

/** A month with Copilot and Claude Code records; the model "shared-model" is used by both. */
function mixedTotals(): Totals {
  return {
    ...counts({ records: 5, calls: 5, input: m(2_100_000, 5), output: m(400_000, 5), sources: { copilot: 2, "claude-code": 3 } }),
    byModel: { "shared-model": counts({ records: 5, sources: { copilot: 2, "claude-code": 3 } }), "cp-only": CP },
    bySource: { copilot: CP, "claude-code": CC },
  };
}
function copilotTotals(): Totals {
  return { ...counts({ sources: { copilot: 2 } }), byModel: { "model-a": CP }, bySource: { copilot: CP } };
}

function snap(t: Totals, o: Partial<Snapshot> = {}): Snapshot {
  return {
    generatedAtMs: NOW.getTime(),
    dayStartMs: DAY0,
    today: t,
    current: { folderId: SID, live: false, pinned: false, totals: t, source: "claude-code" },
    sessions: [{ folderId: SID, live: false, lastMs: NOW.getTime(), source: "claude-code" }],
    health: health(),
    month: {
      monthStartMs: MONTH0,
      isCurrent: true,
      days: [{ dayStartMs: DAY0, totals: t }],
      sessions: [
        { sessionId: SID, source: "claude-code", firstMs: DAY0, lastMs: DAY0, calls: 3, tokens: m(1_000_000, 3), nanoAiu: none() },
        { sessionId: "aaaa0000-0000-4000-8000-000000000002", source: "copilot", firstMs: DAY0, lastMs: DAY0, calls: 2, tokens: m(1_500_000, 2), nanoAiu: m(4e9, 2) },
      ],
      projects: [{ name: "acme/web", sessions: 2, calls: 5, tokens: m(2_500_000, 5), nanoAiu: m(4e9, 2), sources: { copilot: 2, "claude-code": 3 } }],
      tools: [{ name: "Bash", builtIn: true, uses: 4, calls: 3, tokens: m(1_000_000, 3), nanoAiu: none(), sources: { "claude-code": 3 } }],
      totals: t,
    },
    ...o,
  };
}

const TOKENS: ViewOptions = { unit: "tokens" };
const COST: ViewOptions = { unit: "cost" };
const chips = (html: string) => [...html.matchAll(/class="srcchip src-([a-z-]+)"/g)].map((x) => x[1]);

describe("sourceChips", () => {
  it("one chip per source present, in SOURCES order, label from SOURCE_LABEL", () => {
    const html = sourceChips({ codex: 1, copilot: 2, "claude-code": 0 });
    expect(chips(html)).toEqual(["copilot", "codex"]);
    expect(html).toContain(">Copilot<");
    expect(html).toContain(">Codex<");
    expect(sourceChips(undefined)).toBe("");
    expect(sourceChips({})).toBe("");
  });
});

describe("By source card", () => {
  it("lists sources in SOURCES order with — USD for Claude Code, each row filtering to its source", () => {
    const html = renderSourcesCard(snap(mixedTotals()), COST);
    expect(html).toContain("By source");
    const rows = [...html.matchAll(/<tr><th scope="row"><a[^>]*>([^<]*)<\/a>/g)].map((x) => x[1]);
    expect(rows).toEqual(["Copilot", "Claude Code"]);
    const cc = html.slice(html.indexOf(">Claude Code<"));
    const ccRow = cc.slice(0, cc.indexOf("</tr>"));
    expect(ccRow).toContain('<span aria-hidden="true">—</span><span class="sr">not reported</span>');
    expect(ccRow).toContain("1.0M");
    expect(html).toContain(filterHref("source", "claude-code").replace(/"/g, "&quot;"));
    expect(html).toContain(COST_SOURCES_NOTE);
  });
  it("Sessions column from month.sessionsBySource; omitted when absent", () => {
    const s = snap(mixedTotals());
    expect(renderSourcesCard(s, TOKENS)).not.toContain("<th scope=\"col\">Sessions</th>");
    s.month!.sessionsBySource = { copilot: 70, "claude-code": 120 };
    const html = renderSourcesCard(s, TOKENS);
    expect(html).toContain('<th scope="col">Sessions</th>');
    const cc = html.slice(html.indexOf(">Claude Code<"));
    expect(cc.slice(0, cc.indexOf("</tr>"))).toMatch(/>120<\/td>$/);
    const cp = html.slice(html.indexOf(">Copilot<"));
    expect(cp.slice(0, cp.indexOf("</tr>"))).toMatch(/>70<\/td>$/);
  });
  it("permission note names the enabled sources' settings", () => {
    const sh = { rootSource: "default" as const, files: 0, sessions: 0, unreadableFiles: 0, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0 };
    const html = renderPanelHtml(snap(copilotTotals(), { health: health({ state: "permission", sources: { copilot: { ...sh, state: "ok" }, "claude-code": { ...sh, state: "permission" } } }) }), "csp", TOKENS, "overview");
    expect(html).toContain("The usage log folder of an enabled source could not be read on this computer.");
    expect(html).toContain("<b>copilotUsageMonitor.copilotHome</b> or <b>copilotUsageMonitor.claudeHome</b>");
    expect(html).not.toContain("codexHome");
  });
  it("renders nothing for a Copilot-only month", () => {
    expect(renderSourcesCard(snap(copilotTotals()), TOKENS)).toBe("");
  });
  it("sits after the KPIs on Overview", () => {
    const html = renderPanelHtml(snap(mixedTotals()), "csp", TOKENS, "overview");
    expect(html.indexOf("By source")).toBeGreaterThan(html.indexOf("Current session"));
    expect(html.indexOf("By source")).toBeLessThan(html.indexOf("Monthly trend") < 0 ? Infinity : html.indexOf("Monthly trend"));
  });
});

describe("source chips in tables", () => {
  it("a model used by two sources shows two chips", () => {
    const html = renderPanelHtml(snap(mixedTotals()), "csp", TOKENS, "models");
    const row = html.slice(html.indexOf('title="shared-model"'));
    expect(chips(row.slice(0, row.indexOf("</tr>")))).toEqual(["copilot", "claude-code"]);
  });
  it("projects, sessions and tools rows carry their sources' chips", () => {
    expect(chips(renderPanelHtml(snap(mixedTotals()), "csp", TOKENS, "projects"))).toEqual(["copilot", "claude-code"]);
    expect(chips(renderPanelHtml(snap(mixedTotals()), "csp", TOKENS, "tools"))).toEqual(["claude-code"]);
    expect(chips(renderPanelHtml(snap(mixedTotals()), "csp", TOKENS, "sessions"))).toEqual(["claude-code", "copilot"]);
  });
  it("no chip anywhere for a Copilot-only snapshot", () => {
    for (const sec of ["overview", "models", "projects", "sessions", "tools", "insights", "health"] as const) {
      const s = snap(copilotTotals(), { current: { folderId: SID, live: true, pinned: false, source: "copilot" } });
      s.month!.projects[0]!.sources = { copilot: 2 };
      s.month!.tools[0]!.sources = { copilot: 2 };
      s.month!.sessions = [s.month!.sessions[1]!];
      const html = renderPanelHtml(s, "csp", COST, sec);
      expect(chips(html), sec).toEqual([]);
      expect(html, sec).not.toContain(COST_SOURCES_NOTE);
      expect(html, sec).not.toContain(escapeHtml(INSIGHTS_SOURCES_NOTE));
      expect(html, sec).not.toContain("By source");
    }
  });
});

describe("source filter chip", () => {
  it("shows Source: Claude Code with a clear link", () => {
    const html = renderPanelHtml(snap(mixedTotals(), { filter: { source: "claude-code" } }), "csp", TOKENS, "overview");
    expect(html).toMatch(/Source: <b>Claude Code<\/b>/);
    expect(html).toContain(`href="${filterHref("source", "").replace(/"/g, "&quot;")}"`);
    expect(html).toContain('aria-label="Clear source filter: Claude Code"');
  });
});

describe("idle wording and notes", () => {
  it("a Claude Code current session that is not live reads idle, never ended", () => {
    for (const sec of ["overview", "sessions"] as const) {
      const html = renderPanelHtml(snap(mixedTotals()), "csp", TOKENS, sec);
      expect(html, sec).toContain("idle");
      expect(html, sec).not.toMatch(/\bended\b/);
    }
  });
  it("a Copilot current session that is not live still reads ended", () => {
    const html = renderPanelHtml(snap(copilotTotals(), { current: { folderId: SID, live: false, pinned: false, source: "copilot" } }), "csp", TOKENS, "overview");
    expect(html).toContain("Current session ended");
  });
  it("Insights footer and cost notes name the Copilot-only scope when mixed", () => {
    expect(renderPanelHtml(snap(mixedTotals()), "csp", TOKENS, "insights")).toContain(escapeHtml(INSIGHTS_SOURCES_NOTE));
    expect(renderPanelHtml(snap(mixedTotals()), "csp", COST, "overview")).toContain(COST_SOURCES_NOTE);
  });
  it("the target line says Copilot only when mixed", () => {
    const view: ViewOptions = { unit: "cost", range: { min: 20, max: 60 } };
    expect(renderPanelHtml(snap(mixedTotals()), "csp", view, "overview")).toContain("(Copilot only)");
    expect(renderPanelHtml(snap(copilotTotals()), "csp", view, "overview")).not.toContain("(Copilot only)");
  });
  it("health.reading shows the first-read progress in the top bar", () => {
    const html = renderPanelHtml(snap(mixedTotals(), { health: health({ reading: { done: 3, total: 40 } }) }), "csp", TOKENS, "overview");
    expect(html).toContain("Reading history (3 of 40 files)…");
  });
});

describe("Sources health box", () => {
  const h = health({
    sources: {
      copilot: sh({ files: 12, sessions: 4, malformed: 2 }),
      "claude-code": sh({ state: "no-dir" }),
      codex: sh({ state: "off" }),
    },
  });
  it("one row per source: ok with counters, folder not found and off naming their settings", () => {
    const html = sourcesHealthBox(snap(copilotTotals(), { health: h }));
    expect(html).toContain("Sources");
    expect(html).toContain("12 files, 4 sessions read");
    expect(html).toMatch(/Malformed lines<\/span><span class="num star">2</);
    expect(html).toContain("Folder not found");
    expect(html).toContain("copilotUsageMonitor.claudeHome");
    expect(html).toContain("Off");
    expect(html).toContain("copilotUsageMonitor.codex");
    expect(html.indexOf("Copilot")).toBeLessThan(html.indexOf("Claude Code"));
    expect(html.indexOf("Claude Code")).toBeLessThan(html.indexOf("Codex"));
  });
  it("capped and archived counters when present", () => {
    const html = sourcesHealthBox(snap(copilotTotals(), { health: health({ sources: { "claude-code": sh({ files: 10_000, sessions: 9, capped: 7 }), codex: sh({ files: 2, sessions: 2, archived: 5 }) } }) }));
    expect(html).toMatch(/beyond the cap[^<]*<\/span><span class="num[^"]*">7</);
    expect(html).toMatch(/[Aa]rchived[^<]*<\/span><span class="num[^"]*">5</);
  });
  it("is placed after Logs read in Data health; absent without health.sources", () => {
    const html = renderPanelHtml(snap(copilotTotals(), { health: h }), "csp", TOKENS, "health");
    expect(html.indexOf("Logs read")).toBeLessThan(html.indexOf("Folder not found"));
    expect(sourcesHealthBox(snap(copilotTotals()))).toBe("");
  });
  it("the folder chip lists each enabled source's folder origin", () => {
    const html = renderPanelHtml(snap(copilotTotals(), { health: health({ sources: { copilot: sh(), "claude-code": sh({ rootSource: "setting" }), codex: sh({ state: "off" }) } }) }), "csp", TOKENS, "overview");
    expect(html).toContain("Folders: Copilot default · Claude Code setting");
    expect(html).not.toContain("Codex default");
  });
  it("no log-derived string reaches the HTML unescaped", () => {
    const t = mixedTotals();
    const s = snap(t);
    s.month!.projects[0]!.name = `<b>${CANARY}</b>`;
    const html = renderPanelHtml(s, "csp", TOKENS, "projects");
    expect(html).not.toContain(`<b>${CANARY}`);
  });
});
