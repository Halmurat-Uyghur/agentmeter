// The Settings section (v0.9): every row names a setting with its value and a command link
// from the panel's allowlist; the text obeys the copy rules; a refused save is shown.
import { describe, expect, it } from "vitest";
import { LOCAL_BANNER, setDisplayCurrency } from "../../src/core/format";
import { enteredAmount, STATUS_BAR_OPTIONS, TARGET_DEFS } from "../../src/core/panel/settings";
import { PANEL_COMMANDS, renderPanelHtml, sectionPickItems } from "../../src/core/panelHtml";
import { DEFAULT_PREFS, type Counts, type Health, type Metric, type Prefs, type Snapshot, type SourceHealth, type SourceState, type Totals, type ViewOptions } from "../../src/core/types";

const m = (sum: number, reported: number, missing = 0): Metric => ({ sum, reported, missing });
function counts(o: Partial<Counts> = {}): Counts {
  return {
    records: 2, calls: 2, callsMissing: 0, sessionTotals: 0,
    input: m(1_200_000, 2), output: m(300_000, 2), cacheRead: m(500, 2), cacheWrite: m(50, 2), reasoning: m(30, 2),
    durationMs: m(83_000, 2), nanoAiu: m(4e9, 2), callNanoAiu: o.nanoAiu ?? m(4e9, 2), ...o,
  };
}
const totals = (o: Partial<Counts> = {}): Totals => ({ ...counts(o), byModel: { "model-a": counts(o) } });
function health(o: Partial<Health> = {}): Health {
  return { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0, ...o };
}
const NOV = new Date(2026, 10, 1).getTime();
function snap(o: Partial<Snapshot> = {}): Snapshot {
  const t = totals();
  return {
    generatedAtMs: new Date(2026, 10, 5, 10).getTime(),
    dayStartMs: new Date(2026, 10, 5).getTime(),
    today: t,
    sessions: [],
    health: health(),
    month: { monthStartMs: NOV, isCurrent: true, days: [], sessions: [], projects: [], tools: [], totals: t },
    history: [{ monthStartMs: NOV, totals: t }],
    ...o,
  };
}
const sh = (state: SourceState, rootSource: SourceHealth["rootSource"] = "default"): SourceHealth => ({ state, rootSource, files: 1, sessions: 1, unreadableFiles: 0, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0 });

function text(html: string): string {
  const titles = [...html.matchAll(/ (?:title|aria-label)="([^"]*)"/g)].map((x) => x[1]).join(" ");
  return (html + " " + titles)
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<span class="sr">[^<]*<\/span>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;
const render = (s: Snapshot | undefined, view: ViewOptions = { unit: "tokens" }, prefs: Prefs = DEFAULT_PREFS, collapsed = false, palette: Parameters<typeof renderPanelHtml>[5] = "theme") =>
  renderPanelHtml(s, "x", view, "settings", collapsed, palette, prefs);
const main = (html: string) => html.slice(html.indexOf("<main "), html.indexOf("</main>"));
const row = (html: string, name: string) => {
  const re = new RegExp(`<div class="srow"><div class="sk">${name.replace(/[()]/g, "\\$&")}(?:<small>[^<]*</small>)?</div><div class="sv">([^]*?)</div><div class="sa">([^]*?)</div></div>`);
  const x = re.exec(html);
  if (!x) throw new Error(`no row ${name}`);
  return { value: x[1]!, actions: x[2]! };
};
const href = (cmd: string, ...args: unknown[]) => `command:copilotUsageMonitor.${cmd}?${encodeURIComponent(JSON.stringify(args))}`;

describe("Settings section: structure and allowlist", () => {
  it("is the ninth section, offered by Show Section…, with three cards and no snapshot figures", () => {
    const html = render(snap());
    expect(html).toContain('<h2 id="section-title" class="sec">Settings</h2>');
    expect(html).toContain("Unit, currency, colours, status bar, targets and where logs are read from. Saved in your VS Code settings.");
    expect([...main(html).matchAll(/<section class="card settings" aria-labelledby="(set-\w+)"/g)].map((x) => x[1])).toEqual(["set-display", "set-targets", "set-sources"]);
    expect(main(html).match(/<h3 id="set-\w+" class="ch">/g)).toHaveLength(3);
    expect(sectionPickItems().map((i) => i.id)).toContain("settings");
    expect(render(undefined)).toContain("Loading…");
  });

  it("every link is a panel command with JSON-encoded arguments; the webview allows exactly those", () => {
    const html = main(render(snap(), { unit: "cost", currency: { code: "CAD", rate: 1.4, date: "2026-11-06" } }, { ...DEFAULT_PREFS, currency: "CAD", targets: { dayMax: 5, monthMin: 10, monthMax: 60 }, targetAlert: true }));
    const hrefs = [...html.matchAll(/ href="([^"]+)"/g)].map((x) => x[1]!.replace(/&amp;/g, "&"));
    expect(hrefs.length).toBeGreaterThan(10);
    for (const h of hrefs) {
      const x = /^command:([\w.]+)\?(.*)$/.exec(h);
      expect(x, h).not.toBeNull();
      expect(PANEL_COMMANDS as readonly string[]).toContain(x![1]);
      expect(Array.isArray(JSON.parse(decodeURIComponent(x![2]!)))).toBe(true);
    }
    expect(html).not.toMatch(/<script|<form|<input|<button|\son\w+=|https?:\/\//i);
  });

  it("copy rules: no banned words, the banner stays in the chrome, and no path", () => {
    const html = render(snap({ health: health({ rootSource: "setting", sources: { copilot: sh("ok", "setting"), "claude-code": sh("no-dir", "env"), codex: sh("off") } }) }), { unit: "cost" }, { ...DEFAULT_PREFS, unsaved: ["palette", "dailyTargetMax"] });
    expect(text(html).split(LOCAL_BANNER).join("")).not.toMatch(COPY_RE);
    expect(html).not.toMatch(/\/Users\/|\/home\/|~\//);
  });
});

describe("Settings section: Display card", () => {
  it("unit, currency, colours, status bar and navigation rows show the current value and link to the change", () => {
    const html = main(render(snap(), { unit: "tokens" }, { ...DEFAULT_PREFS, statusBar: "month" }, true, "ocean"));
    expect(row(html, "Unit").value).toBe("Tokens");
    expect(row(html, "Unit").actions).toContain(`href="${href("setUnit", "cost")}"`);
    expect(row(html, "Unit").actions).toContain(">Show USD (est.)</a>");
    expect(row(html, "Currency").value).toBe("USD<small>No conversion and no network request.</small>");
    expect(row(html, "Currency").actions).toContain(`href="${href("selectCurrency")}"`);
    expect(row(html, "Colours").value).toBe("Ocean<small>Blue accent.</small>");
    expect(row(html, "Colours").actions).toContain(`href="${href("selectPalette")}"`);
    const sb = row(html, "Status bar shows");
    expect(sb.value).toContain("This month");
    expect(sb.actions).toContain(`<a class="seg" href="${href("setStatusBar", "today")}"`);
    expect(sb.actions).toContain('<span class="seg on" title="This month so far, in tokens or estimated cost.">This month<span class="sr"> (selected)</span></span>');
    expect(sb.actions).toContain(`<a class="seg" href="${href("setStatusBar", "session")}"`);
    const nav = row(html, "Section navigation");
    expect(nav.value).toBe("Icon rail");
    expect(nav.actions).toContain(`href="${href("toggleNav")}"`);
    expect(nav.actions).toContain(">Expand</a>");
    expect(STATUS_BAR_OPTIONS.map((o) => o.value)).toEqual(["today", "month", "session"]);
  });

  it("the cost view, a rate, and a pending rate", () => {
    // the extension sets the display currency with the view (readView); the label follows it
    const rate = { code: "CAD", rate: 1.4, date: "2026-11-06" };
    setDisplayCurrency(rate);
    let cad: string;
    try {
      cad = main(render(snap(), { unit: "cost", currency: rate }, { ...DEFAULT_PREFS, currency: "CAD" }));
    } finally {
      setDisplayCurrency(undefined);
    }
    expect(row(cad, "Unit").value).toBe("CAD (est.)");
    expect(row(cad, "Unit").actions).toContain(">Show tokens</a>");
    expect(row(cad, "Currency").value).toBe("CAD<small>1 USD = 1.4 CAD, the European Central Bank rate of 2026-11-06.</small>");
    const pending = main(render(snap(), { unit: "cost", currencyPending: "CAD" }, { ...DEFAULT_PREFS, currency: "CAD" }));
    expect(row(pending, "Currency").value).toBe("CAD<small>No CAD exchange rate yet; figures stay in USD until it arrives.</small>");
    expect(pending).toContain("No CAD exchange rate yet: targets are compared once it arrives.");
    expect(row(main(render(snap())), "Section navigation").value).toBe("Labels and icons");
  });
});

describe("Settings section: Targets card", () => {
  it("four target rows as entered in the chosen currency, Set… always and Clear when set; the alert row; a conflict note", () => {
    const prefs: Prefs = { ...DEFAULT_PREFS, currency: "CAD", targets: { dayMax: 5, weekMax: 30, monthMin: 60, monthMax: 20 }, targetAlert: true };
    const html = main(render(snap(), { unit: "cost" }, prefs));
    expect(TARGET_DEFS.map((d) => d.label)).toEqual(["Daily target (most)", "Weekly target (most)", "Monthly target (least)", "Monthly target (most)"]);
    const day = row(html, "Daily target (most)");
    expect(day.value).toBe("CA$5.00");
    expect(day.actions).toBe(`<a class="btn" href="${href("setTarget", "day", "max")}" title="Enter the daily target (most) in CAD">Set…</a><a class="btn" href="${href("setTarget", "day", "max", "")}" title="Remove the daily target (most)">Clear</a>`);
    expect(row(html, "Weekly target (most)").value).toBe("CA$30.00");
    expect(row(html, "Monthly target (least)").value).toBe("CA$60.00");
    expect(row(html, "Monthly target (most)").value).toBe("CA$20.00");
    expect(html).toContain("The monthly most is below the least, so the most is ignored until you raise it.");
    const alert = row(html, "Target alert");
    expect(alert.value).toBe("On");
    expect(alert.actions).toContain(`href="${href("setTargetAlert", "off")}"`);
    expect(alert.actions).toContain(">Turn off</a>");
    expect(html).toContain("Amounts are estimated cost in CAD. Targets compare Copilot&#39;s logged cost only; Claude Code and Codex cost is an estimate from list prices and is not counted.");

    const none = main(render(snap(), { unit: "tokens", range: { max: 0.5 } }));
    const w = row(none, "Weekly target (most)");
    expect(w.value).toBe('<span class="muted">not set</span>');
    expect(w.actions).not.toContain("Clear");
    expect(row(none, "Target alert").value).toBe("Off");
    expect(row(none, "Target alert").actions).toContain(`href="${href("setTargetAlert", "on")}"`);
    expect(none).not.toContain("is ignored until");
    expect(none).toContain("This month is compared against up to $0.500.");
    expect(enteredAmount(5, "USD")).toBe("$5.00");
    expect(enteredAmount(12.345, "EUR")).toBe("€12.35");
    expect(enteredAmount(3, "XXX")).toMatch(/3/);
  });
});

describe("Settings section: Sources card and the unsaved note", () => {
  it("names each source's state and folder origin without a path, the history, the switches, and one link to VS Code's Settings", () => {
    const s = snap({ health: health({ rootSource: "env", sources: { copilot: sh("ok", "env"), "claude-code": sh("no-dir", "setting"), codex: sh("off") } }) });
    const html = main(render(s, { unit: "tokens" }, { ...DEFAULT_PREFS, historyMonths: 3, projectNames: false, sources: { claudeCode: true, codex: false } }));
    expect(row(html, "Copilot").value).toBe("found · folder from the environment variable");
    expect(row(html, "Claude Code").value).toBe("folder not found · folder from the setting");
    expect(row(html, "Codex").value).toBe("Off");
    expect(row(html, "History").value).toBe("3 months");
    expect(row(html, "Project names").value).toBe("Off");
    expect(row(html, "Session totals").value).toBe("On");
    expect(html.match(new RegExp(href("openVsCodeSettings").replace(/[?]/g, "\\?"), "g"))).toHaveLength(1);
    expect(html).toContain(">Open in VS Code Settings</a>");
    // without per-source health (first read) the Copilot row falls back to the top-level origin
    const early = main(render(snap({ health: health({ rootSource: "default" }) })));
    expect(row(early, "Copilot").value).toBe("on · default folder");
    expect(row(early, "Claude Code").value).toBe("on");
  });

  it("a refused save is named at the top; nothing when every save took", () => {
    expect(main(render(snap()))).not.toContain("Not saved");
    const html = main(render(snap(), { unit: "tokens" }, { ...DEFAULT_PREFS, unsaved: ["dailyTargetMax", "palette", "weird"] }));
    expect(html).toContain('<section class="note alert" aria-label="Settings not saved"><p><b>Not saved: Daily target, Colours, weird.</b> VS Code refused to write your user settings file');
    expect(html.indexOf("Not saved")).toBeLessThan(html.indexOf('aria-labelledby="set-display"'));
  });
});
