// v0.6 (2.1): change vs last month in the Projects, Models and Tools tables, and the
// same-point comparison on Overview. ▲/▼ with amounts, never percentages; no arrow when
// either side has nothing logged; no column when last month is outside historyMonths.
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_BANNER, setDisplayCurrency } from "../../src/core/format";
import { renderPanelHtml, type SECTIONS } from "../../src/core/panelHtml";
import type { Counts, GroupSummary, Health, Metric, Snapshot, ToolSummary, Totals } from "../../src/core/types";

const m = (sum: number, reported = 1, missing = 0): Metric => ({ sum, reported, missing });
function counts(input: number, nano: number, o: Partial<Counts> = {}): Counts {
  return {
    records: 2, calls: 2, callsMissing: 0, sessionTotals: 0,
    input: m(input), output: m(0), cacheRead: m(0), cacheWrite: m(0), reasoning: m(0),
    durationMs: m(0), nanoAiu: m(nano), callNanoAiu: m(nano), ...o,
  };
}
const totals = (byModel: Record<string, Counts>): Totals => {
  const all = Object.values(byModel);
  return { ...counts(all.reduce((a, c) => a + c.input.sum, 0), all.reduce((a, c) => a + c.nanoAiu.sum, 0)), byModel };
};
const group = (name: string, tokens: number, nano: number): GroupSummary => ({ name, sessions: 1, calls: 2, tokens: m(tokens), nanoAiu: m(nano) });
const tool = (name: string, tokens: number, nano: number): ToolSummary => ({ name, builtIn: true, uses: 2, calls: 2, tokens: m(tokens), nanoAiu: m(nano) });
function health(o: Partial<Health> = {}): Health {
  return { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0, ...o };
}
const OCT = new Date(2026, 9, 1).getTime();
const NOV = new Date(2026, 10, 1).getTime();
const DAY0 = new Date(2026, 10, 6).getTime();

function snap(o: Partial<NonNullable<Snapshot["month"]>> = {}, s: Partial<Snapshot> = {}): Snapshot {
  const cur = totals({ "model-a": counts(3_000_000, 5e11), "model-b": counts(1_000, 1e9) });
  const prior = totals({ "model-a": counts(1_000_000, 3.8e11), "model-c": counts(500, 1e9) });
  return {
    generatedAtMs: new Date(2026, 10, 6, 10).getTime(),
    dayStartMs: DAY0,
    sessions: [],
    health: health(),
    month: {
      monthStartMs: NOV, isCurrent: true, days: [], sessions: [],
      projects: [group("acme/web", 3_000_000, 5e11), group("tools-cli", 1_000, 1e9)],
      tools: [tool("bash", 3_000_000, 5e11), tool("view", 1_000, 1e9)],
      totals: cur,
      prior: {
        monthStartMs: OCT, toMs: new Date(2026, 9, 6, 10).getTime(), totals: prior,
        projects: [group("acme/web", 1_000_000, 3.8e11), group("old-repo", 500, 1e9)],
        tools: [tool("bash", 1_000_000, 3.8e11), tool("grep", 500, 1e9)],
      },
      ...o,
    },
    history: [{ monthStartMs: OCT, totals: prior }, { monthStartMs: NOV, totals: cur }],
    ...s,
  };
}
type Section = (typeof SECTIONS)[number];
const render = (s: Snapshot, section: Section, unit: "tokens" | "cost" = "tokens") => renderPanelHtml(s, "x", { unit }, section);
function text(html: string): string {
  const attrs = [...html.matchAll(/ (?:title|aria-label)="([^"]*)"/g)].map((x) => x[1]).join(" ");
  return (html.replace(/<head>[\s\S]*?<\/head>/, " ") + " " + attrs)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .split(LOCAL_BANNER)
    .join("");
}
/** The cells of the table row whose header contains `name`. */
function row(html: string, name: string): string[] {
  const tr = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1]!).find((r) => /<th scope="row"/.test(r) && text(r).includes(name));
  expect(tr, name).toBeDefined();
  return [...tr!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((x) => x[0]);
}
const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;

afterEach(() => setDisplayCurrency(undefined));

describe("change vs last month: table columns", () => {
  it("Projects: a Δ column headed with the compared period; ▲ amount, 'new', screen-reader words", () => {
    const html = render(snap(), "projects");
    expect(html).toContain('<th scope="col"><span aria-hidden="true">Δ</span><span class="sr">Change</span> vs Oct 1–6</th>');
    const web = row(html, "acme/web").at(-1)!;
    expect(web).toContain('<span class="delta up"><span aria-hidden="true">▲ 2.0M</span><span class="sr">up 2.0 million tokens</span></span>');
    const cli = row(html, "tools-cli").at(-1)!;
    expect(cli).toContain('<span aria-hidden="true">new</span><span class="sr">nothing logged then</span>');
    expect(cli).not.toMatch(/[▲▼]/);
    const t = text(html);
    expect(t).toContain("Δ (change) = Nov 1–6 minus Oct 1–6, the same point last month");
    expect(t).toContain("1 project logged in Oct 1–6 has nothing in Nov 1–6.");
    expect(t).not.toMatch(COPY_RE);
  });

  it("cost unit: amounts in the display currency, labelled est. by the unit word", () => {
    let html = render(snap(), "projects", "cost");
    expect(row(html, "acme/web").at(-1)).toContain("▲ $1.20");
    expect(row(html, "acme/web").at(-1)).toContain("up $1.20, estimated");
    expect(text(html)).toContain("in estimated USD");
    setDisplayCurrency({ code: "CAD", rate: 1.5, date: "2026-11-06" });
    html = render(snap(), "projects", "cost");
    expect(row(html, "acme/web").at(-1)).toContain("▲ CA$1.80");
    expect(text(html)).toContain("in estimated CAD");
  });

  it("Models: Δ per model against last month's same model; a model gone from this month is counted", () => {
    const html = render(snap(), "models");
    expect(html).toContain("Δ</span><span class=\"sr\">Change</span> vs Oct 1–6</th>");
    expect(row(html, "model-a").at(-1)).toContain("▲ 2.0M");
    expect(row(html, "model-b").at(-1)).toContain(">new<");
    expect(text(html)).toContain("1 model logged in Oct 1–6 has nothing in Nov 1–6.");
  });

  it("Tools: ▼ when smaller; 'same' without an arrow; '—' when a side did not report the unit", () => {
    const s = snap({
      tools: [tool("bash", 400, 1e9), tool("view", 1_000, 1e9), tool("edit", 10, 1e9)],
      prior: { ...snap().month!.prior!, tools: [tool("bash", 1_000, 1e9), tool("view", 1_000, 1e9), { ...tool("edit", 0, 0), tokens: m(0, 0, 2), nanoAiu: m(0, 0, 2) }] },
    });
    const html = render(s, "tools");
    expect(row(html, "bash").at(-1)).toContain('<span class="delta down"><span aria-hidden="true">▼ 600</span><span class="sr">down 600 tokens</span>');
    expect(row(html, "view").at(-1)).toContain('<span class="delta same"><span aria-hidden="true">same</span>');
    expect(row(html, "edit").at(-1)).toContain('<span class="sr">not reported</span>');
  });

  it("partial data stars the change", () => {
    const html = render(snap({}, { health: health({ partial: true, malformed: 1 }) }), "projects");
    expect(row(html, "acme/web").at(-1)).toContain("▲ 2.0M*");
  });

  it("a past month compares with the whole month before, by name", () => {
    const html = render(snap({ monthStartMs: OCT, isCurrent: false, prior: { ...snap().month!.prior!, monthStartMs: new Date(2026, 8, 1).getTime(), toMs: OCT } }), "projects");
    expect(html).toContain("<span class=\"sr\">Change</span> vs September</th>");
    expect(text(html)).toContain("Δ (change) = October minus September, in input + output tokens");
  });

  it("no column, and a note why, when last month is outside historyMonths", () => {
    for (const section of ["projects", "models", "tools"] as const) {
      const html = render(snap({ prior: undefined }), section);
      expect(html, section).not.toContain(">Change</span>");
      expect(text(html), section).toContain("Read 2 or more months (copilotUsageMonitor.historyMonths) to see the change against October.");
      const past = render(snap({ monthStartMs: OCT, isCurrent: false, prior: undefined }), section);
      expect(text(past), section).toContain("September is outside the history window, so there is no change column.");
    }
  });

  it("every section with a change column passes the copy gate in both units", () => {
    for (const section of ["overview", "projects", "models", "tools"] as const)
      for (const unit of ["tokens", "cost"] as const) expect(text(render(snap(), section, unit)), `${section} ${unit}`).not.toMatch(COPY_RE);
  });
});

describe("change vs last month: Overview same-point comparison", () => {
  const card = (html: string) => {
    const i = html.indexOf('class="card mtd');
    return html.slice(i, html.indexOf("</section>", i));
  };
  it("current month: ▲ amount, 'Nov 1–6 vs Oct 1–6' and last month's figure", () => {
    const c = card(render(snap(), "overview"));
    expect(c).toContain('<span class="delta up"><span aria-hidden="true">▲ 2.0M</span><span class="sr">up 2.0 million tokens</span></span>');
    expect(text(c)).toContain("Nov 1–6 vs Oct 1–6 (1.0M)");
    expect(text(card(render(snap(), "overview", "cost")))).toContain("▲ $1.20 up $1.20, estimated Nov 1–6 vs Oct 1–6 ($3.81)");
  });
  it("no arrow when either side has nothing logged", () => {
    const none = text(card(render(snap({ prior: { monthStartMs: OCT, toMs: OCT + 1 } }), "overview")));
    expect(none).toContain("Nothing logged in Oct 1–6.");
    expect(none).not.toMatch(/[▲▼]/);
    const empty = text(card(render(snap({ totals: undefined }), "overview")));
    expect(empty).toContain("Nothing logged in Nov 1–6 (Oct 1–6: 1.0M).");
    expect(empty).not.toMatch(/[▲▼]/);
  });
  it("past month: the whole month before, by name; the 1st reads 'Nov 1'", () => {
    const past = snap({ monthStartMs: OCT, isCurrent: false, prior: { ...snap().month!.prior!, monthStartMs: new Date(2026, 8, 1).getTime(), toMs: OCT } });
    expect(text(card(render(past, "overview")))).toContain("October vs September (1.0M)");
    const first = snap({}, { dayStartMs: NOV });
    expect(text(card(render(first, "overview")))).toContain("Nov 1 vs Oct 1 (1.0M)");
  });
  it("Mar 30 compares with the whole of February", () => {
    const MAR = new Date(2027, 2, 1).getTime();
    const s = snap({ monthStartMs: MAR, prior: { ...snap().month!.prior!, monthStartMs: new Date(2027, 1, 1).getTime() } }, { dayStartMs: new Date(2027, 2, 30).getTime() });
    expect(text(card(render(s, "overview")))).toContain("Mar 1–30 vs Feb 1–28");
  });
});
