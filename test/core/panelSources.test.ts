// v0.8 (D40, D46, D49): the source dimension in the panel. Snapshots are built by hand;
// nothing here reads a log. A Copilot-only snapshot shows no chip, card or note.
import { describe, expect, it } from "vitest";
import { COST_SOURCES_NOTE, INSIGHTS_SOURCES_NOTE, LOCAL_BANNER } from "../../src/core/format";
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

// Fix wave F3a: wording and a11y once more than one source is read.
describe("multi-source panel wording (F3a)", () => {
  const multi = (o: Partial<Health> = {}) => health({ sources: { copilot: sh(), "claude-code": sh(), codex: sh({ state: "off" }) }, ...o });
  const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;
  // LOCAL_BANNER's disclaimer ("not your remaining allowance") is the one sanctioned use.
  const words = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, " ").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/g, " ").split(LOCAL_BANNER.replace(/'/g, " ")).join(" ");

  it("format-changed note names the source whose format changed; Copilot-only keeps the 0.7 text", () => {
    const fc = renderPanelHtml(snap(mixedTotals(), { health: multi({ state: "format-changed", unrecognized: 2, sources: { copilot: sh(), "claude-code": sh({ state: "format-changed" }) } }) }), "csp", TOKENS, "overview");
    expect(fc).toContain("Claude Code may have changed its log format, so figures may be incomplete.");
    expect(fc).not.toContain("Copilot may have changed");
    const cp = renderPanelHtml(snap(copilotTotals(), { health: health({ state: "format-changed", unrecognized: 2 }) }), "csp", TOKENS, "overview");
    expect(cp).toContain("Copilot may have changed its log format, so figures may be incomplete.");
  });

  it("empty month and no current session are neutral when another source is on or a source filter is set", () => {
    const empty = (o: Partial<Snapshot>) => {
      const s = snap(copilotTotals(), { current: undefined, ...o });
      s.month!.totals = undefined;
      return s;
    };
    const multiHtml = renderPanelHtml(empty({ health: multi() }), "csp", TOKENS, "overview");
    expect(multiHtml).toContain("No usage logged in November. Figures appear here after a model call finishes, or when an older Copilot session ends.");
    const filtered = renderPanelHtml(empty({ filter: { source: "codex" } }), "csp", TOKENS, "overview");
    expect(filtered).toContain("No usage logged in November for this filter. Figures appear here after a model call finishes");
    expect(renderPanelHtml(empty({}), "csp", TOKENS, "overview")).toContain("No Copilot usage logged in November.");
    expect(renderPanelHtml(empty({ health: multi() }), "csp", TOKENS, "sessions")).toContain("A session becomes current when a model call is logged in it.");
    expect(renderPanelHtml(empty({ filter: { source: "copilot" } }), "csp", TOKENS, "sessions")).toContain("A session becomes current when a model call is logged in it.");
    expect(renderPanelHtml(empty({}), "csp", TOKENS, "sessions")).toContain("A session becomes current when Copilot logs a model call in it.");
  });

  it("the loading page and streaming note are neutral", () => {
    const html = renderPanelHtml(undefined, "csp", TOKENS, "overview");
    expect(html).toContain("Reading session logs…");
    expect(html).not.toContain("Reading Copilot");
    expect(html).toContain("Updates when a model call finishes, not token by token.");
  });

  it("trend band title and legend say Copilot only when the month mixes sources", () => {
    const view: ViewOptions = { unit: "cost", range: { min: 20, max: 60 } };
    const hist = (t: Totals) => [{ monthStartMs: new Date(2026, 9, 1).getTime() }, { monthStartMs: MONTH0, totals: t }];
    const mixed = renderPanelHtml(snap(mixedTotals(), { history: hist(mixedTotals()) }), "csp", view, "overview");
    const trend = mixed.slice(mixed.indexOf('id="trend-title"'));
    expect(trend).toMatch(/class="band"[^>]*title="Target \$20\.00–\$60\.00 \(Copilot only\)"/);
    expect(trend).toMatch(/Target \$20\.00–\$60\.00 \(Copilot only\)<\/span>/);
    const cp = renderPanelHtml(snap(copilotTotals(), { history: hist(copilotTotals()) }), "csp", view, "overview");
    expect(cp.slice(cp.indexOf('id="trend-title"'))).not.toContain("(Copilot only)");
  });

  it("row chips are spaced and introduced for screen readers", () => {
    expect(sourceChips({ copilot: 1, codex: 1 })).toBe('<span class="srcchip src-copilot">Copilot</span> <span class="srcchip src-codex">Codex</span>');
    const html = renderPanelHtml(snap(mixedTotals()), "csp", TOKENS, "models");
    const row = html.slice(html.indexOf('title="shared-model"'));
    expect(row.slice(0, row.indexOf("</tr>"))).toContain('<span class="srcchips"><span class="sr">Source: </span><span class="srcchip src-copilot">Copilot</span> <span class="srcchip src-claude-code">Claude Code</span></span>');
  });

  it("Sources box iterates SOURCES: a source missing from health.sources reads Off with its setting; Copilot is never off", () => {
    const html = sourcesHealthBox(snap(copilotTotals(), { health: health({ sources: { copilot: sh({ files: 3, sessions: 1 }) } }) }));
    expect(html).toContain("Off (copilotUsageMonitor.claudeCode)");
    expect(html).toContain("Off (copilotUsageMonitor.codex)");
    expect(html).toContain("3 files, 1 session read");
    expect(html.indexOf("Claude Code")).toBeLessThan(html.indexOf("Codex"));
    const noCopilot = sourcesHealthBox(snap(copilotTotals(), { health: health({ sources: { codex: sh() } }) }));
    expect(noCopilot).not.toContain("src-copilot");
    expect(noCopilot).toContain("Off (copilotUsageMonitor.claudeCode)");
  });

  it("By source card: a copilot filter with nothing else in scope omits the cost-sources note", () => {
    const s = snap(copilotTotals(), { filter: { source: "copilot" } });
    const html = renderSourcesCard(s, COST);
    expect(html).toContain("By source");
    expect(html).not.toContain(COST_SOURCES_NOTE);
    expect(renderSourcesCard(snap(mixedTotals(), { filter: { source: "claude-code" } }), COST)).toContain(COST_SOURCES_NOTE);
  });

  it("prompts card names Claude Code and Codex for calls without an initiator when another source is on", () => {
    const prompts = { prompts: 0, agentCalls: 0, notLinked: 0, unknown: 3, nanoAiu: none(), tokens: none() };
    const s = snap(mixedTotals(), { health: multi() });
    s.month!.prompts = prompts;
    const html = renderPanelHtml(s, "csp", TOKENS, "sessions");
    expect(html).toContain("3 calls that logged no initiator (older Copilot, Claude Code and Codex) are not counted here.");
    expect(html).toContain("The calls in November logged no initiator, so prompts cannot be counted.");
    const cp = snap(copilotTotals());
    cp.month!.prompts = prompts;
    const old = renderPanelHtml(cp, "csp", TOKENS, "sessions");
    expect(old).toContain("3 calls did not log who started them (older Copilot), so they are not counted here.");
    expect(old).toContain("Copilot did not log who started the calls in November");
  });

  it("sessions table bar note covers every source's cost (v0.10)", () => {
    expect(renderPanelHtml(snap(mixedTotals()), "csp", TOKENS, "sessions")).toContain("Bar = share of the month's estimated cost. Started");
    const cp = snap(copilotTotals());
    cp.month!.sessions = [cp.month!.sessions[1]!];
    expect(renderPanelHtml(cp, "csp", TOKENS, "sessions")).toContain("Bar = share of the month's estimated cost. Started");
  });

  it("the new wording follows the copy rule", () => {
    const s = snap(mixedTotals(), { health: multi({ state: "format-changed", unrecognized: 1, sources: { copilot: sh(), "claude-code": sh({ state: "format-changed" }) } }) });
    s.month!.prompts = { prompts: 0, agentCalls: 0, notLinked: 0, unknown: 3, nanoAiu: none(), tokens: none() };
    for (const sec of ["overview", "sessions", "health"] as const) expect(words(renderPanelHtml(s, "csp", { unit: "cost", range: { max: 60 } }, sec)), sec).not.toMatch(COPY_RE);
  });
});

describe("Source dropdown in the toolbar (v0.10)", () => {
  const three = () => health({ sources: { copilot: sh(), "claude-code": sh(), codex: sh({ state: "no-dir" }) } });
  const menu = (html: string) => html.slice(html.indexOf('<details class="dd srcpick">'), html.indexOf("</details>", html.indexOf('<details class="dd srcpick">')) + 10);

  it("is on every section, lists All sources then each enabled source as a setFilter link", () => {
    for (const section of ["overview", "projects", "tools", "insights", "settings"] as const) {
      const html = renderPanelHtml(snap(mixedTotals(), { health: three() }), "csp", TOKENS, section);
      const dd = menu(html);
      expect(dd, section).toContain("<b>All</b>");
      const labels = [...dd.matchAll(/<li><a [^>]*><span class="ddcheck"[^>]*>[^<]*<\/span>([^<]*)/g)].map((x) => x[1]!.trim());
      expect(labels).toEqual(["All sources", "Copilot", "Claude Code", "Codex"]);
      expect(dd).toContain(escapeHtml(filterHref("source", "")));
      expect(dd).toContain(escapeHtml(filterHref("source", "codex")));
      expect(dd).toContain("folder not found");
      expect(dd).toContain("Turn sources on or off…");
    }
  });
  it("marks the active source and names it on the button", () => {
    const html = renderPanelHtml(snap(mixedTotals(), { health: three(), filter: { source: "claude-code" } }), "csp", TOKENS, "overview");
    const dd = menu(html);
    expect(dd).toContain("<b>Claude Code</b>");
    expect(dd).toMatch(/aria-current="true"><span class="ddcheck" aria-hidden="true">✓<\/span>Claude Code/);
  });
  it("leaves out a source that is turned off, and is hidden with one source or no per-source health", () => {
    const off = health({ sources: { copilot: sh(), "claude-code": sh(), codex: sh({ state: "off" }) } });
    expect(menu(renderPanelHtml(snap(mixedTotals(), { health: off }), "csp", TOKENS, "overview"))).not.toContain("Codex");
    expect(renderPanelHtml(snap(copilotTotals(), { health: health({ sources: { copilot: sh() } }) }), "csp", TOKENS, "overview")).not.toContain("srcpick");
    expect(renderPanelHtml(snap(copilotTotals()), "csp", TOKENS, "overview")).not.toContain("srcpick");
  });
});

describe("estimated cost for Claude Code and Codex (v0.10)", () => {
  it("the By source card shows a priced Claude Code row's USD instead of —", () => {
    const t = mixedTotals();
    t.bySource!["claude-code"] = { ...CC, nanoAiu: m(1.5e11, 3), callNanoAiu: m(1.5e11, 3) };
    const html = renderSourcesCard(snap(t), COST);
    const cc = html.slice(html.indexOf(">Claude Code<"));
    expect(cc.slice(0, cc.indexOf("</tr>"))).toContain("$1.50");
  });
  it("targets compare Copilot's cost only, even when the month total includes estimates", () => {
    const t = mixedTotals();
    // Copilot $0.04 (4e9 nano-AIU) + Claude Code $50 estimated; target up to $10 → still in range
    t.nanoAiu = m(4e9 + 5e12, 5);
    t.bySource!["claude-code"] = { ...CC, nanoAiu: m(5e12, 3), callNanoAiu: m(5e12, 3) };
    const view: ViewOptions = { unit: "cost", range: { max: 10 } };
    const html = renderPanelHtml(snap(t, { thisMonth: t }), "csp", view, "overview");
    expect(html).toContain("(Copilot only): In range");
    expect(html).not.toContain("(Copilot only): Over");
  });
});
