// A2: the Overview dashboard cards (Today hero, heatmap, cache ring, Month to
// date, last 30 days) and the wordmark header.
import { describe, expect, it, vi } from "vitest";
import { LOCAL_BANNER, SESSION_TOTAL_NOTE } from "../../src/core/format";
import { changeVs, dailyBars } from "../../src/core/panel/dashboard";
import { PANEL_CSS } from "../../src/core/panelCss";
import { renderPanelHtml, SECTIONS } from "../../src/core/panelHtml";
import type { Counts, DayStats, Health, Metric, Snapshot, Totals } from "../../src/core/types";

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
const OCT = new Date(2026, 9, 1).getTime();
const NOV = new Date(2026, 10, 1).getTime();
const DAY0 = new Date(2026, 10, 6).getTime(); // a Friday
const day = (mo: number, d: number) => new Date(2026, mo, d).getTime();
function stats(dayStartMs: number, tokens: number, o: Partial<DayStats> = {}): DayStats {
  return { dayStartMs, tokens: m(tokens, 1), nanoAiu: m(tokens * 1e4, 1), calls: 3, callsMissing: 0, sessionTotals: 0, sessions: 2, ...o };
}
const ACT = {
  fromMs: OCT,
  days: [stats(day(9, 3), 1_000_000), stats(day(10, 2), 2_000_000), stats(day(10, 4), 6_000_000), stats(day(10, 5), 1_000_000), stats(DAY0, 3_000_000, { sessions: 4 })],
};
function snap(o: Partial<Snapshot> = {}): Snapshot {
  const t = totals({ input: m(2_500_000, 2), output: m(500_000, 2) });
  return {
    generatedAtMs: new Date(2026, 10, 6, 10).getTime(),
    dayStartMs: DAY0,
    today: t,
    sessions: [],
    health: health(),
    month: {
      monthStartMs: NOV, isCurrent: true,
      days: Array.from({ length: 6 }, (_, i) => (i === 1 || i === 5 ? { dayStartMs: day(10, i + 1), totals: t } : { dayStartMs: day(10, i + 1) })),
      sessions: [], projects: [], tools: [], totals: t,
      cache: { prompt: m(10_000, 4), cacheRead: m(6_100, 4) },
      prior: { monthStartMs: OCT, toMs: new Date(2026, 9, 6, 10).getTime(), totals: totals({ input: m(1_000_000, 1), output: m(0, 1) }) },
    },
    history: [{ monthStartMs: OCT }, { monthStartMs: NOV, totals: t }],
    activity: ACT,
    ...o,
  };
}
const month = (o: Partial<NonNullable<Snapshot["month"]>>) => ({ ...snap().month!, ...o });
function text(html: string): string {
  const attrs = [...html.matchAll(/ (?:title|aria-label)="([^"]*)"/g)].map((x) => x[1]).join(" ");
  return (html + " " + attrs)
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<span class="sr">[^<]*<\/span>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;
const render = (s: Snapshot, view?: Parameters<typeof renderPanelHtml>[2]) => renderPanelHtml(s, "x", view, "overview");
const between = (html: string, from: string, to = "</section>") => {
  const i = html.indexOf(from);
  return html.slice(i, html.indexOf(to, i));
};

describe("changeVs", () => {
  it("▲ with a multiplier, ▼ as N in 10, never a percent", () => {
    expect(changeVs(27, 10)).toEqual({ text: "▲ 2.7×", dir: "up" });
    expect(changeVs(150, 10)).toEqual({ text: "▲ 15×", dir: "up" });
    expect(changeVs(4, 10)).toEqual({ text: "▼ 4 in 10", dir: "down" });
    expect(changeVs(0.2, 10)).toEqual({ text: "▼ <1 in 10", dir: "down" });
    expect(changeVs(10.2, 10)).toEqual({ text: "about the same", dir: "same" });
    expect(changeVs(9.7, 10)).toEqual({ text: "about the same", dir: "same" });
  });
  it("unknown or zero on either side: no comparison", () => {
    for (const [a, b] of [[undefined, 1], [1, undefined], [0, 1], [1, 0]] as const) expect(changeVs(a, b)).toBeUndefined();
  });
});

describe("header (A2)", () => {
  it("wordmark with an inline mark and the Local chip, one h1, nothing borrowed", () => {
    const html = render(snap());
    expect(html).toMatch(/<h1 class="wordmark"><svg class="logo" viewBox="0 0 20 20" aria-hidden="true" focusable="false">[^]*?<\/svg><span class="wm">Copilot Usage<\/span> <span class="pill">Local<\/span><\/h1>/);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).not.toMatch(/codeburn/i);
  });
});

describe("Today hero (A2)", () => {
  it("big figure, calls and sessions, then Yesterday, 7-day average per active day and the change against yesterday", () => {
    const hero = between(render(snap()), 'class="card hero"');
    const v = text(hero);
    expect(hero).toContain('<h3 id="today-title" class="ch">');
    expect(v).toContain("Today (Fri, Nov 6)");
    expect(hero).toMatch(/<div class="big">3\.0M<\/div>/);
    expect(v).toContain("input + output tokens · 2 calls · 4 sessions");
    expect(v).toMatch(/Yesterday 1\.0M/);
    // Oct 31 .. Nov 6: Nov 2 2.0M, Nov 4 6.0M, Nov 5 1.0M, Nov 6 3.0M → 12.0M / 4 active days (Oct 3 is outside)
    expect(v).toMatch(/7-day avg 3\.0M/);
    expect(v).toContain("(4 active days)");
    expect(v).toMatch(/vs yesterday ▲ 3\.0×/);
    // the arrow and × are read as words (m5)
    expect(hero).toContain('<dd class="num"><span class="up"><span aria-hidden="true">▲ 3.0×</span><span class="sr">up 3.0 times</span></span></dd>');
  });

  it("USD unit, and a drop shown as N in 10", () => {
    const s = snap({ today: totals({ nanoAiu: m(4e9, 1) }) });
    const v = text(between(render(s, { unit: "cost" }), 'class="card hero"'));
    expect(v).toContain("$0.040");
    // yesterday 1.0M tokens × 1e4 nano = 1e10 nano = $0.10
    expect(v).toMatch(/Yesterday \$0\.100/);
    expect(v).toMatch(/vs yesterday ▼ 4 in 10/);
  });

  it("— when unknown: nothing yesterday, yesterday before the window, nothing today", () => {
    // Nothing logged yesterday: one muted line across two stat cells, not "—" twice (design #7)
    const noYHtml = between(render(snap({ activity: { fromMs: OCT, days: ACT.days.filter((d) => d.dayStartMs !== day(10, 5)) } })), 'class="card hero"');
    const noY = text(noYHtml);
    expect(noYHtml).toContain('<div class="span2"><dt>Yesterday</dt><dd class="num"><span class="muted">Nothing logged yesterday</span></dd></div>');
    expect(noY).not.toMatch(/vs yesterday/);
    expect(noY).not.toMatch(/Yesterday —/);
    const before = text(between(render(snap({ activity: { fromMs: DAY0, days: [stats(DAY0, 3_000_000)] } })), 'class="card hero"'));
    expect(before).toMatch(/Yesterday —/);
    expect(before).toContain("Yesterday is before the history window.");
    const none = between(render(snap({ today: undefined, activity: { fromMs: OCT, days: [] } })), 'class="card hero"');
    expect(none).toContain('<div class="big"><span aria-hidden="true">—</span><span class="sr">not reported</span></div>');
    expect(text(none)).toMatch(/7-day avg —/);
    expect(text(none)).not.toMatch(/\b0 calls\b/);
  });

  it("partial data stars the figures", () => {
    const hero = between(render(snap({ health: health({ partial: true, malformed: 1 }) })), 'class="card hero"');
    const STAR = '<span class="star" aria-hidden="true">*</span><span class="sr"> (may be incomplete)</span>';
    expect(hero).toContain(`<div class="big">3.0M${STAR}</div>`);
    expect(hero).toContain(`Yesterday</dt><dd class="num">1.0M${STAR}`);
  });
});

describe("activity heatmap (A2)", () => {
  it("weekday rows × week columns over the window, today marked, a text alternative", () => {
    const html = render(snap());
    const heat = html.slice(html.indexOf('<svg class="heat"'), html.indexOf("</svg>", html.indexOf('<svg class="heat"')));
    // Oct 1 .. Nov 6 = 37 days; Oct 1 2026 is a Thursday → 6 week columns (Sep 28 .. Nov 2 weeks)
    expect(heat.match(/<rect class="hm/g)).toHaveLength(37);
    // 120 wide for six weeks, widened to 220 for the readout row (20 tall) under the grid
    expect(heat).toContain('viewBox="0 0 220 141"');
    // hovering a square reveals its weekday and date at once (no script, no native tooltip)
    expect(heat).toContain('<text class="hint" x="0" y="137">Hover a square to see its date</text>');
    expect(heat).toContain('<title>Nov 4: 6.0M tokens</title></rect><text class="tip" x="0" y="137">Wed Nov 4: 6.0M tokens</text></g>');
    expect(heat.match(/<g class="hc">/g)).toHaveLength(37);
    expect(heat.match(/class="hm h\d now"/g)).toHaveLength(1);
    expect(heat.match(/class="hm h4/g)).toHaveLength(1); // the busiest day
    expect(heat.match(/class="hm h[1-4]/g)).toHaveLength(5);
    // Thursday Oct 1 is row 3, column 0
    expect(heat).toMatch(/<rect class="hm h0" x="30" y="61" width="12" height="12" rx="2"><title>Oct 1: no usage records<\/title>/);
    expect(heat).toContain("<title>Nov 4: 6.0M tokens</title>");
    expect(heat).toMatch(/role="img" aria-label="Daily activity from Oct 1 to Nov 6: 5 of 37 days active, busiest Nov 4 \(6\.0M tokens\)\./);
    expect(text(html)).toContain("Daily activity 5 active days");
    for (const l of [">Mon<", ">Wed<", ">Fri<", ">Oct<", ">Nov<"]) expect(heat).toContain(l);
  });

  it("session totals are named on their end day; no activity yet says so", () => {
    const s = snap({ activity: { fromMs: OCT, days: [stats(day(10, 4), 9, { sessionTotals: 1 })] } });
    expect(render(s)).toContain("<title>Nov 4: 9 tokens (includes 1 session total)</title>");
    expect(text(render(snap({ activity: undefined })))).toContain("No days read yet.");
  });
});

describe("cache-reuse ring (A2)", () => {
  it("N in 100 for the viewed month, drawn as an SVG arc with a text alternative", () => {
    const html = render(snap());
    const ring = html.slice(html.indexOf('<svg class="ring"'), html.indexOf("</svg>", html.indexOf('<svg class="ring"')));
    expect(ring).toContain('aria-label="Cache reuse in November: 61 in 100 prompt tokens were cache reads."');
    expect(ring).toMatch(/<circle class="ring-fg" [^>]*stroke-dasharray="153\.31 251\.33"/);
    expect(text(ring + "</svg>")).toMatch(/61 in 100/);
  });
  it("— when not reported, <1 when tiny, filtered marked", () => {
    expect(render(snap({ month: month({ cache: undefined }) }))).toContain('aria-label="Cache reuse in November: not reported."');
    expect(render(snap({ month: month({ cache: undefined }) }))).not.toContain('class="ring-fg"');
    expect(render(snap({ month: month({ cache: { prompt: m(10_000, 1), cacheRead: m(10, 1) } }) }))).toContain("&lt;1 in 100 prompt tokens");
    expect(render(snap({ filter: { project: "p" } }))).toContain("cache reads (filtered).");
  });
});

describe("Month to date (A2)", () => {
  it("total, cumulative line and the change against the same point last month, as an amount; no projection", () => {
    const html = render(snap());
    const card = between(html, 'class="card mtd');
    const v = text(card);
    expect(v).toContain("Month to date");
    expect(card).toMatch(/<div class="big">3\.0M<\/div>/);
    expect(v).toContain("▲ 2.0M Nov 1–6 vs Oct 1–6 (1.0M)"); // v0.6 (2.1): an amount, never a ratio
    expect(card).toMatch(/<svg class="spark" viewBox="0 0 120 40" preserveAspectRatio="none" role="img" aria-label="Running total of November by day: 6\.0M tokens after 6 days\.">/);
    expect(v).not.toMatch(/project|pace|forecast|estimate for|to go/i);
  });
  it("a hint when last month is not read; a past month compares with the whole month before", () => {
    const one = text(between(render(snap({ month: month({ prior: undefined }) })), 'class="card mtd'));
    expect(one).toContain("Read 2 or more months (copilotUsageMonitor.historyMonths) to compare with October.");
    const past = snap({ month: month({ monthStartMs: OCT, isCurrent: false, days: [], prior: { monthStartMs: day(8, 1), toMs: OCT, totals: totals({ input: m(6_000_000, 1), output: m(0, 1) }) } }) });
    const v = text(between(render(past), 'class="card mtd'));
    expect(v).toContain("October 2026 total");
    expect(v).toContain("▼ 3.0M October vs September (6.0M)");
    const outside = text(between(render(snap({ month: month({ monthStartMs: OCT, isCurrent: false, prior: undefined }) })), 'class="card mtd'));
    expect(outside).toContain("September is outside the history window.");
    const nothing = text(between(render(snap({ month: month({ prior: { monthStartMs: OCT, toMs: OCT + 1 } }) })), 'class="card mtd'));
    expect(nothing).toContain("Nothing logged in Oct 1–6.");
  });
});

describe("last 30 days bars (A2)", () => {
  it("30 slots, today in the accent, a dashed average line and the Avg/day, Peak and Yesterday chips", () => {
    const card = between(render(snap()), 'class="card bars"');
    // 30 HTML hover targets over the plot, each with an instant weekday + date readout
    expect(card.match(/<span class="hit[^"]*" data-tip="/g)).toHaveLength(30);
    expect(card.match(/class="hit tip-l"/g)).toHaveLength(6);
    expect(card.match(/class="hit tip-r"/g)).toHaveLength(6);
    expect(card).toContain('data-tip="Wed Nov 4: 6.0M tokens"');
    expect(card.match(/<rect class="dbar"/g)).toHaveLength(3);
    expect(card.match(/<rect class="dbar-today"/g)).toHaveLength(1);
    expect(card).toMatch(/<line class="bar-avg" x1="0" x2="300" y1="[\d.]+" y2="[\d.]+" vector-effect="non-scaling-stroke"\/>/);
    const v = text(card);
    // (2 + 6 + 1 + 3) M / 4 active days; Oct 3 is before the 30 days (Oct 8 .. Nov 6)
    expect(v).toMatch(/Avg\/day 3\.0M/);
    expect(v).toMatch(/Peak 6\.0M · Nov 4/);
    expect(v).toMatch(/Yesterday 1\.0M/);
    expect(v).toContain("Daily tokens last 30 days");
    expect(card).toMatch(/role="img" aria-label="Daily tokens, last 30 days: 4 of 30 days read had usage, average 3\.0M per active day, peak 6\.0M on Nov 4, today 3\.0M\. Not filtered\."/);
    expect(card).toContain('data-tip="Thu Oct 8: no usage records"');
    expect(card).toMatch(/<span>Today<\/span><\/div>/);
  });

  it("days before the window have no bar and say so; USD; not filtered marked", () => {
    const s = snap({ activity: { fromMs: NOV, days: ACT.days.filter((d) => d.dayStartMs >= NOV) }, filter: { tool: "bash" } });
    const card = between(render(s, { unit: "cost" }), 'class="card bars"');
    const v = text(card);
    expect(v).toContain("Daily USD (est.) last 30 days · not filtered");
    expect(card).toContain('data-tip="Sat Oct 31: before the history window"');
    expect(v).toContain("Days before Nov 1 are outside the history window and have no bar.");
    expect(v).toMatch(/Peak \$0\.600 · Nov 4/);
  });

  it("empty states", () => {
    expect(text(dailyBars(snap({ activity: { fromMs: OCT, days: [] } }), { unit: "tokens" }))).toContain("Nothing logged in the last 30 days.");
    expect(text(dailyBars(snap({ activity: undefined }), { unit: "tokens" }))).toContain("No days read yet.");
  });

  it("names session totals in the bar titles; the full note is not repeated under the bars (design #1)", () => {
    const s = snap({ activity: { fromMs: OCT, days: [stats(day(10, 4), 9, { sessionTotals: 1 })] } });
    const card = between(render(s), 'class="card bars"');
    expect(card).toContain("Nov 4: 9 tokens (includes 1 session total)");
    expect(text(card)).not.toContain(SESSION_TOTAL_NOTE);
  });
});

describe("overview layout and gates (A2)", () => {
  it("cards in order: hero, Month to date, Last 7 days, Current session, bars, monthly trend", () => {
    const html = render(snap());
    const order = ['class="card hero"', 'class="card mtd', 'class="card kpi k3"', 'class="card kpi k2"', 'class="card bars"', 'id="trend-title"'];
    const at = order.map((x) => html.indexOf(x));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("copy rules, no script, no URL and no event handler across units, states and sections", () => {
    const states = [
      snap(),
      snap({ health: health({ partial: true, malformed: 1 }), filter: { project: "p", tool: "t" } }),
      snap({ today: undefined, activity: { fromMs: DAY0, days: [] }, month: month({ totals: undefined, cache: undefined, prior: undefined }) }),
      snap({ activity: undefined }),
    ];
    for (const s of states)
      for (const view of [undefined, { unit: "cost" as const, range: { min: 1, max: 2 } }])
        for (const section of SECTIONS) {
          const html = renderPanelHtml(s, "x", view, section);
          expect(text(html).split(LOCAL_BANNER).join(""), section).not.toMatch(COPY_RE);
          expect(html).not.toMatch(/<script|\son\w+\s*=|https?:\/\/|xlink:href|<image|<foreignObject/i);
          expect(html.match(/<h[4-6][ >]/g)).toBeNull();
        }
  });

  it("every chart SVG has a text alternative; decorative icons are hidden", () => {
    const html = render(snap());
    const svgs = [...html.matchAll(/<svg ([^>]*)>/g)].map((x) => x[1]!);
    expect(svgs.length).toBeGreaterThan(10);
    for (const a of svgs) expect(a).toMatch(/aria-hidden="true"|role="img" aria-label="[^"]+"/);
    expect(svgs.filter((a) => a.includes('role="img"'))).toHaveLength(4);
  });

  it("CSS: orange accent with a yellow fallback, theme variables, narrow and high-contrast rules for the new cards", () => {
    expect(PANEL_CSS).toContain("--hot: var(--vscode-charts-orange, var(--vscode-charts-yellow,");
    expect(PANEL_CSS).toMatch(/\.dbar-today \{ fill: var\(--hot\); \}/);
    expect(PANEL_CSS).toMatch(/body\.vscode-high-contrast [^{]*\.card/);
    expect(PANEL_CSS).toMatch(/@media \(forced-colors: active\) \{[^@]*\.dbar-today/);
    expect(PANEL_CSS).toMatch(/@container \(max-width: 480px\) \{[^@]*\.hero-grid/);
    expect(PANEL_CSS).toMatch(/@media \(max-width: 720px\) \{[^@]*\.sidenav \.grp \{ display: none; \}/);
    expect(PANEL_CSS).not.toMatch(/url\(|@import|@font-face/);
  });
});

describe("v0.4 review fixes (dashboard)", () => {
  // A day whose records carry tokens but no logged cost (session totals from older Copilot).
  const unpriced = (t: number) => stats(t, 5_000, { nanoAiu: m(0, 0, 1), sessionTotals: 3 });

  it("D1: a day with records but no figure in the unit reads '— (… not reported)', never 'no usage records'", () => {
    const s = snap({ activity: { fromMs: OCT, days: [unpriced(day(10, 2)), stats(day(10, 4), 6_000_000), unpriced(day(10, 5)), stats(DAY0, 3_000_000)] } });
    const html = render(s, { unit: "cost" });
    const heat = html.slice(html.indexOf('<svg class="heat"'), html.indexOf("</svg>", html.indexOf('<svg class="heat"')));
    expect(heat).toContain("<title>Nov 2: — (estimated USD not reported) (includes 3 session totals)</title>");
    expect(heat).not.toContain("Nov 2: no usage records");
    expect(heat).toContain("<title>Nov 3: no usage records</title>");
    const bars = between(html, 'class="card bars"');
    expect(bars).toContain('data-tip="Mon Nov 2: — (estimated USD not reported) (includes 3 session totals)"');
    expect(bars).toContain('data-tip="Tue Nov 3: no usage records"');
    // Hero Yesterday (Nov 5) has records but no cost: "—", and its note says why
    const hero = between(html, 'class="card hero"');
    expect(hero).toContain('title="Yesterday has usage records, but estimated USD not reported. (includes 3 session totals)"');
    expect(text(hero)).toMatch(/Yesterday —/);
    expect(text(hero)).not.toContain("Nothing logged yesterday");
    // the same day in tokens view has a figure
    expect(render(s)).toContain("<title>Nov 2: 5.0K tokens (includes 3 session totals)</title>");
  });

  it("D1: a day with records but no token counts reads '— (tokens not reported)' in tokens view", () => {
    const s = snap({ activity: { fromMs: OCT, days: [stats(day(10, 4), 0, { tokens: m(0, 0, 1) })] } });
    expect(render(s)).toContain("<title>Nov 4: — (tokens not reported)</title>");
  });

  it("design #2: last month logged tokens but no cost → the token change, or a plain sentence", () => {
    const prior = { monthStartMs: OCT, toMs: new Date(2026, 9, 6, 10).getTime(), totals: totals({ input: m(1_000_000, 1), output: m(0, 1), nanoAiu: m(0, 0, 1) }) };
    const v = text(between(render(snap({ month: month({ prior }) }), { unit: "cost" }), 'class="card mtd'));
    expect(v).toContain("▲ 2.0M tokens Nov 1–6 vs Oct 1–6 (1.0M tokens)");
    expect(v).not.toContain("No comparison");
    const none = text(between(render(snap({ month: month({ prior, totals: totals({ input: m(0, 0, 1), output: m(0, 0, 1) }) }) }), { unit: "cost" }), 'class="card mtd'));
    expect(none).toContain("Oct 1–6 logged tokens but no estimated USD.");
  });

  it("design #3: the heatmap draws at most the last 20 weeks with 12 px cells; the active-day count covers the whole window", () => {
    const from = new Date(2025, 10, 1).getTime();
    const s = snap({ activity: { fromMs: from, days: [stats(new Date(2025, 11, 1).getTime(), 1000), ...ACT.days] } });
    const html = render(s);
    const heat = html.slice(html.indexOf('<svg class="heat"'), html.indexOf("</svg>", html.indexOf('<svg class="heat"')));
    // 19 whole weeks before this one + Mon..Fri of this week
    expect(heat.match(/<rect class="hm/g)).toHaveLength(19 * 7 + 5);
    expect(heat).toContain('width="12" height="12"');
    expect(text(html)).toContain("Daily activity 6 active days");
    expect(heat).toMatch(/aria-label="Daily activity from Jun 22 to Nov 6: 5 of 138 days active, busiest Nov 4 \(6\.0M tokens\)\. 6 active days since Nov 1\./);
    expect(PANEL_CSS).toMatch(/\.heat \.ax \{[^}]*font-size: 10\.5px/);
    expect(PANEL_CSS).not.toMatch(/\.heat \{[^}]*max-width: 420px/);
  });

  it("heatmap labels the first month that starts within the first weeks", () => {
    // Sat Nov 7 with activity since Jan 1: the 20-week grid starts Mon Jun 22 and July 1 sits in
    // column 1; a real month start replaces the column-0 label instead of being dropped.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 7, 10));
    try {
      const today = day(10, 7);
      const days: DayStats[] = [];
      for (let d = new Date(2026, 0, 1); d.getTime() <= today; d.setDate(d.getDate() + 1)) days.push(stats(d.getTime(), 1000));
      const html = render(snap({ generatedAtMs: new Date(2026, 10, 7, 10).getTime(), dayStartMs: today, activity: { fromMs: day(0, 1), days } }));
      const labels = [...html.matchAll(/<text class="ax" x="(\d+)" y="11">(\w+)<\/text>/g)].map((x) => `${x[2]}@${x[1]}`);
      expect(labels).toEqual(["Jul@45", "Aug@105", "Sep@180", "Oct@240", "Nov@300"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("design #5: the chips sit in the card header, three value ticks, no repeated average in the legend", () => {
    const card = between(render(snap()), 'class="card bars"');
    expect(card).toMatch(/<div class="chrow"><h3 id="bars-title" class="ch">[^]*?<\/h3><div class="kchips">/);
    // scale = 6.0M × 1.1
    expect(card).toContain('<div class="yaxis" aria-hidden="true"><span class="num">6.6M</span><span class="num">3.3M</span><span class="num">0</span></div>');
    expect(text(card)).toMatch(/Avg \/ active day Today/);
  });

  it("M7: every day of the 30-day chart and each active heatmap day as a table in a fold", () => {
    const html = render(snap({ activity: { fromMs: OCT, days: [...ACT.days, unpriced(day(10, 3))].sort((a, b) => a.dayStartMs - b.dayStartMs) } }), { unit: "cost" });
    const bars = between(html, 'class="card bars"');
    const t = bars.slice(bars.indexOf('<details class="more daytable">'));
    expect(t).toContain("<summary>Daily figures as a table</summary>");
    expect(t).toContain('<caption class="sr">Daily USD (est.), last 30 days, not filtered</caption>');
    expect(t).toContain('<th scope="col">Day</th><th scope="col">USD (est.)</th><th scope="col">Session totals</th>');
    expect(t.match(/<th scope="row">/g)).toHaveLength(30);
    expect(t).toContain('<tr><th scope="row">Wed, Nov 4</th><td class="num">$0.600</td><td class="num">0</td></tr>');
    expect(t).toContain('<tr><th scope="row">Tue, Nov 3</th><td class="num"><span aria-hidden="true">—</span><span class="sr">not reported</span></td><td class="num">3</td></tr>');
    expect(t).toContain('<tr><th scope="row">Sun, Nov 1</th><td class="muted">nothing logged</td><td></td></tr>');
    const hero = between(html, 'class="card hero"');
    expect(hero).toContain("<summary>Active days as a table</summary>");
    expect(hero.match(/<th scope="row">/g)).toHaveLength(6);
  });

  it("M1: every '—' on every section has screen-reader text", () => {
    const s = snap({ today: undefined, current: undefined, month: month({ cache: undefined, totals: undefined, days: [], prior: undefined }) });
    for (const section of SECTIONS) {
      for (const unit of ["tokens", "cost"] as const) {
        const html = renderPanelHtml(s, "x", { unit }, section);
        const body = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/"—"/g, "").replace(/ (?:title|aria-label)="[^"]*"/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
        const dashes = (body.match(/—/g) ?? []).length;
        const said = (body.match(/<span aria-hidden="true">—<\/span><span class="sr">not reported<\/span>/g) ?? []).length;
        expect(dashes, `${section} ${unit}`).toBe(said);
      }
    }
  });
});

describe("v0.4 review fixes (panel a11y and design)", () => {
  it("M2 + design #7: trend months are a list; each link names month, value, target state and current; a visible ▲ ✓ ▼ mark; blank above empty months", () => {
    const view = { unit: "cost" as const, range: { max: 0.01 } };
    const html = render(snap(), view);
    const trend = between(html, 'id="trend-title"');
    expect(trend).toContain('<ol class="tcols" role="list" aria-label="Months, oldest first">');
    expect(trend.match(/<li><a class="col/g)).toHaveLength(2);
    expect(trend).toContain('aria-label="November 2026: 0.040 US dollars estimated, over target, viewing" aria-current="true"');
    expect(trend).toContain('aria-label="October 2026: nothing logged, in target range"');
    expect(trend).toMatch(/<span class="m" aria-hidden="true">Nov ▲<\/span>/);
    expect(trend).toMatch(/<span class="m" aria-hidden="true">Oct 26 ✓<\/span>/);
    // October has no record: nothing above its bar (its title still says so)
    expect(trend).toMatch(/title="October 2026: no usage records · in target range"><span class="v"><\/span>/);
    expect(text(trend)).toContain("▼ Under");
    expect(text(trend)).toContain("✓ In range");
    expect(text(trend)).toContain("▲ Over");
  });

  it("design #1: the session-total note appears once on Overview, short, with the full text in its title", () => {
    const t = totals({ sessionTotals: 3 });
    const html = render(snap({ month: month({ totals: t }), activity: { fromMs: OCT, days: [stats(day(10, 4), 9, { sessionTotals: 1 })] } }));
    const body = html.replace(/<style>[\s\S]*?<\/style>/, "");
    expect(body).toContain("November includes 3 session totals (older Copilot; each counted on the day it ended).");
    expect(body.split(`title="${SESSION_TOTAL_NOTE.replace(/'/g, "&#39;")}"`)).toHaveLength(2);
    const visible = body.replace(/ (?:title|aria-label)="[^"]*"/g, "");
    expect(visible).not.toContain("writes one total when a session ends");
  });

  it("design #4: one muted line and an 'About these figures' fold on every section; Data health also lays the full text out in its own content", () => {
    // Everything above the month bar is shared chrome. It must be the same markup on every
    // section, or the month bar, the section nav and the content sit at a different height
    // on one section and jump when the reader clicks to the next (the Data health jump).
    const chrome = (html: string) => html.slice(html.indexOf('<header class="top">'), html.indexOf('<div class="toolbar"'));
    const first = chrome(renderPanelHtml(snap(), "x", { unit: "cost" }, SECTIONS[0]!));
    expect(first).toContain('<header class="top">');
    for (const section of SECTIONS) {
      const html = renderPanelHtml(snap(), "x", { unit: "cost" }, section);
      expect(chrome(html), section).toBe(first);
      expect(html, section).toContain('<section class="about" aria-label="About these figures"><span class="muted">Local logs on this computer only · cost is an estimate · updates after each model call</span><details class="more"><summary>About these figures</summary>');
      const main = html.slice(html.indexOf('<main id="main"'));
      if (section === "health") {
        expect(main).toMatch(/<p class="secdesc">[^<]*<\/p>\n<section class="note" aria-label="About these figures"><p>Locally observed/);
        expect(main).toContain("Cost is an estimate");
      } else {
        expect(html, section).not.toContain('<section class="note" aria-label="About these figures"');
      }
    }
  });

  it("design #8 + #10: section cards use the dashboard header; the cards under the hero share one layout", () => {
    for (const [section, id] of [["sessions", "sessions-title"], ["daily", "calendar-title"], ["models", "models-title"]] as const) {
      expect(renderPanelHtml(snap(), "x", undefined, section)).toMatch(new RegExp(`<section class="card" aria-labelledby="${id}"><h3 id="${id}" class="ch"><svg class="ic"`));
    }
    const daily = renderPanelHtml(snap(), "x", undefined, "daily");
    expect(daily).not.toContain("Daily trend —");
    const html = render(snap());
    expect(html).toMatch(/<section class="card kpi k3" aria-labelledby="k3-title"[^>]*><h3 id="k3-title" class="ch">[^]*?<\/h3><div class="big">[^]*?<\/div><div class="sub">/);
    expect(text(between(html, 'class="card kpi k3"'))).not.toContain("input + output tokens");
    expect(PANEL_CSS).toContain(".kpi .big, .mtd .big { font-size: 26px; }");
  });

  it("M3, M4, M6, design #9: text-safe tones, the selected unit underlined in the accent, calendar heat as a bar", () => {
    expect(PANEL_CSS).toContain("--warn-text: color-mix(in srgb, var(--warn) 60%, var(--fg));");
    for (const sel of [".star", ".chip.warn", "td.flag", ".up", ".delta.up", ".sidenav .cnt.warn"]) {
      const rule = new RegExp(`${sel.replace(/\./g, "\\.")} \\{[^}]*(?<![-\\w])color: var\\(--warn\\)`);
      expect(PANEL_CSS, sel).not.toMatch(rule);
    }
    expect(PANEL_CSS).toMatch(/\.seg\.on \{[^}]*border-bottom: 2px solid var\(--hot\)/);
    expect(PANEL_CSS).not.toMatch(/\.seg\.on \{[^}]*background: var\(--accent\)/);
    expect(PANEL_CSS).toMatch(/@media \(forced-colors: active\) \{[^@]*\.seg\.on \{ forced-color-adjust: none; background: Highlight; color: HighlightText;/);
    expect(PANEL_CSS).toContain(".month .d::after {");
    expect(PANEL_CSS).not.toMatch(/\.h4 \{ background:/);
    expect(PANEL_CSS).toMatch(/\.h4 \{ --lvl: var\(--hot\); \}/);
  });

  it("m4, m9, security 5: glyph controls have names; the toolbar link label is escaped; tables have captions and scopes", () => {
    const html = renderPanelHtml(snap({ history: [{ monthStartMs: OCT, totals: totals() }, { monthStartMs: NOV, totals: totals() }] }), "x", undefined, "models");
    expect(html).toMatch(/aria-label="Previous month"><span aria-hidden="true">‹<\/span><\/a>/);
    expect(html).toContain('<span class="btn off"><span aria-hidden="true">›</span><span class="sr">No later month</span></span>');
    expect(html).toContain('<caption class="sr">Usage by model, November 2026</caption>');
    expect(html).toContain('<div class="tablewrap" tabindex="0" role="region" aria-label="Usage by model, November 2026, scrolls sideways">');
    expect(html).toMatch(/<tr><th scope="row"><span class="chipm/);
    expect(html).not.toMatch(/<th>/);
  });
});

describe("daily and weekly targets on the Overview (v0.9)", () => {
  it("Today shows the daily target state and colours the figure; Last 7 days the weekly one", () => {
    const s = snap({ last7: totals({ nanoAiu: m(2e11, 2) }) }); // $2.00 over the last 7 days; today is $0.04
    const html = render(s, { unit: "cost", dayTarget: { max: 0.01 }, weekTarget: { max: 5 } });
    expect(html).toContain('<section class="card hero st-over" aria-labelledby="today-title">');
    const hero = between(html, 'class="card hero');
    expect(text(hero)).toContain("Daily target up to $0.010: Over");
    expect(hero).toMatch(/<div class="hero-main" title="over target[^"]*">/);
    expect(html).toContain('<section class="card kpi k3 st-in" aria-labelledby="k3-title"');
    const week = between(html, 'class="card kpi k3');
    expect(text(week)).toContain("Weekly target up to $5.00: In range");
    expect(week).toMatch(/aria-labelledby="k3-title" title="in target range /);
    expect(text(html).split(LOCAL_BANNER).join("")).not.toMatch(COPY_RE);
    // tokens view still shows the state (the target is estimated cost either way, like Month to date)
    const tok = render(s, { unit: "tokens", dayTarget: { max: 0.01 } });
    expect(tok).toContain('<section class="card hero st-over"');
    expect(text(between(tok, 'class="card hero'))).toContain("Daily target up to $0.010: Over");
    // no target: no state and no line
    const plain = render(s, { unit: "cost" });
    expect(plain).toContain('<section class="card hero" aria-labelledby="today-title">');
    expect(plain).toContain('<section class="card kpi k3" aria-labelledby="k3-title"');
    expect(plain).not.toContain("Daily target");
    expect(plain).not.toContain("Weekly target");
  });

  it("the status bar tooltip names each set target with its state", async () => {
    const { tooltipMarkdown } = await import("../../src/core/format");
    const tip = tooltipMarkdown(snap(), { unit: "tokens", dayTarget: { max: 0.01 }, weekTarget: { max: 5 } });
    expect(tip).toContain("Daily target up to \\$0\\.010: over target");
    expect(tip).toContain("Weekly target up to \\$5\\.00: in target range");
    expect(tooltipMarkdown(snap(), { unit: "tokens" })).not.toContain("Daily target");
  });
});
