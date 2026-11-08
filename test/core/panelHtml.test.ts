import { describe, expect, it } from "vitest";
import { formatDuration, LOCAL_BANNER, NOT_COVERED, SESSION_TOTAL_NOTE, STREAMING_NOTE, setDisplayCurrency } from "../../src/core/format";
import { escapeHtml, renderPanelHtml, SECTIONS } from "../../src/core/panelHtml";
import {
  byLocalDay,
  heatLevel,
  localMonthStart,
  modelFamily,
  UsageStore,
} from "../../src/core/store";
import type { Counts, DayTotals, Health, Metric, Snapshot, Totals, UsageRecord } from "../../src/core/types";
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

// 2026-11-05 10:00 Toronto
const NOW = new Date(2026, 10, 5, 10, 0, 0);
const DAY0 = new Date(2026, 10, 5).getTime();

function days(n: number, filled: Record<number, Totals>): DayTotals[] {
  const out: DayTotals[] = [];
  for (let d = 1; d <= n; d++) {
    const dayStartMs = new Date(2026, 10, d).getTime();
    out.push(filled[d] ? { dayStartMs, totals: filled[d] } : { dayStartMs });
  }
  return out;
}

function snap(o: Partial<Snapshot> = {}): Snapshot {
  const t = totals();
  return {
    generatedAtMs: NOW.getTime(),
    dayStartMs: DAY0,
    today: t,
    current: { folderId: "3f2a91c0-0000-4000-8000-000000000001", live: true, pinned: false, totals: t },
    sessions: [{ folderId: "3f2a91c0-0000-4000-8000-000000000001", live: true, lastMs: NOW.getTime() }],
    health: health(),
    month: { monthStartMs: new Date(2026, 10, 1).getTime(), isCurrent: true, days: days(5, { 3: t, 5: t }), sessions: [], projects: [], tools: [], totals: t },
    ...o,
  };
}

/** Visible text plus title tooltips: drop <style> and tags, decode the few entities we emit. */
function text(html: string): string {
  const titles = [...html.matchAll(/ title="([^"]*)"/g)].map((x) => x[1]).join(" ");
  return (html + " " + titles)
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<span class="sr">[^<]*<\/span>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// D22: estimated USD is allowed (labelled "est."); account-statement words stay banned.
const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;

describe("month helpers", () => {
  it("localMonthStart is local midnight on the 1st (across DST)", () => {
    expect(localMonthStart(new Date("2026-11-05T15:00:00Z"))).toBe(Date.parse("2026-11-01T04:00:00Z"));
    expect(localMonthStart(new Date("2026-11-01T03:59:00Z"))).toBe(Date.parse("2026-10-01T04:00:00Z"));
  });

  it("byLocalDay has one entry per elapsed day, undefined for empty days", () => {
    const store = new UsageStore();
    const rec = (key: string, ts: number): UsageRecord => ({
      key, keySource: "usageId", kind: "call", source: "copilot", sessionId: "s", folderId: "s", timestampMs: ts, tokens: { input: 10, output: 5 },
    });
    store.add(rec("a", new Date(2026, 10, 2, 9).getTime()), "f");
    store.add(rec("b", new Date(2026, 10, 2, 23, 59).getTime()), "f");
    store.add(rec("c", new Date(2026, 10, 5, 0, 0, 1).getTime()), "f");
    store.add(rec("old", new Date(2026, 9, 31, 23).getTime()), "f");
    const d = byLocalDay(store, NOW);
    expect(d).toHaveLength(5);
    expect(d[0]!.totals).toBeUndefined();
    expect(d[1]!.totals!.records).toBe(2);
    expect(d[2]!.totals).toBeUndefined();
    expect(d[4]!.totals!.records).toBe(1);
    expect(d[1]!.dayStartMs).toBe(new Date(2026, 10, 2).getTime());
  });

  it("heatLevel", () => {
    expect(heatLevel(undefined, 100)).toBe(0);
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(100, 100)).toBe(4);
    expect(heatLevel(1, 100)).toBe(1);
    expect(heatLevel(51, 100)).toBe(3);
    expect(heatLevel(5, 0)).toBe(0);
  });

  it("modelFamily", () => {
    expect(modelFamily("Claude-Sonnet-4.6")).toBe("claude");
    expect(modelFamily("gpt-5.5")).toBe("gpt");
    expect(modelFamily("o3-mini")).toBe("gpt");
    expect(modelFamily("gemini-3-pro")).toBe("gemini");
    expect(modelFamily("(unknown model)")).toBe("other");
  });

  it("formatDuration", () => {
    expect(formatDuration(m(83_000, 2))).toBe("1m 23s");
    expect(formatDuration(m(42_000, 1))).toBe("42s");
    expect(formatDuration(m(3_780_000, 1))).toBe("1h 03m");
    expect(formatDuration(none())).toBe("—");
    expect(formatDuration(m(1000, 1, 1))).toBe("1s*");
  });
});

describe("renderPanelHtml", () => {
  it("partial reason for over-long lines reads as a sentence (singular and plural)", () => {
    const one = text(renderPanelHtml(snap({ health: health({ partial: true, overlong: 1 }) }), "x", undefined, "daily"));
    expect(one).toContain("1 over-long line that may contain usage was skipped.");
    const many = text(renderPanelHtml(snap({ health: health({ partial: true, overlong: 3 }) }), "x", undefined, "daily"));
    expect(many).toContain("3 over-long lines that may contain usage were skipped.");
  });

  it("hides the over-long non-usage row when there are none", () => {
    const t = text(renderPanelHtml(snap(), "x", undefined, "health"));
    expect(t).not.toContain("Over-long lines skipped (not usage)");
    expect(t).toContain("Over-long lines skipped (may be usage)");
  });

  it("over-long non-usage lines are listed but not flagged as partial", () => {
    const t = text(renderPanelHtml(snap({ health: health({ overlongOther: 37 }) }), "x", undefined, "health"));
    expect(t).toMatch(/Over-long lines skipped \(not usage\)\s+37/);
    expect(t).not.toContain("Totals may be incomplete");
    expect(t).not.toContain("Partial data");
  });

  it("is static, locked down and carries the banner on every section", () => {
    for (const section of SECTIONS) {
      const html = renderPanelHtml(snap(), "vscode-webview://abc", undefined, section);
      expect(html, section).not.toMatch(/<script/i);
      expect(html, section).not.toMatch(/https?:\/\//i);
      expect(html, section).not.toMatch(/@import|url\(|@font-face/i);
      expect(html, section).toContain("default-src 'none'");
      expect(html, section).toContain(escapeHtml(LOCAL_BANNER));
      expect(html, section).toContain(escapeHtml(STREAMING_NOTE));
    }
    const health = renderPanelHtml(snap(), "x", undefined, "health");
    for (const n of NOT_COVERED) expect(health).toContain(escapeHtml(n));
  });

  it("overview shows its blocks in order and nothing from other sections", () => {
    const t = text(renderPanelHtml(snap({ history: [{ monthStartMs: new Date(2026, 10, 1).getTime(), totals: totals() }] }), "x"));
    const order = ["Copilot Usage", "Local", "Overview", "Today", "Yesterday", "Daily activity", "Cache reuse", "Month to date", "Last 7 days", "Current session", "Daily tokens", "Monthly trend"];
    let at = 0;
    for (const s of order) {
      const i = t.indexOf(s, at);
      expect(i, s).toBeGreaterThanOrEqual(0);
      at = i + 1;
    }
    for (const other of ["Today in detail", "Daily trend", "by model", "By project", "By tool", "Costliest sessions", "Not covered", "AIU (as logged)"]) expect(t).not.toContain(other);
  });

  it("each section holds its own blocks", () => {
    const has: Record<string, string[]> = {
      daily: ["Today in detail", "Daily trend November 2026", "Daily tokens November 2026"],
      sessions: ["Current session", "Costliest sessions"],
      models: ["November 2026 by model"],
      projects: ["By project"],
      tools: ["By tool"],
      insights: ["Nothing to point out in November."],
      health: ["Sessions counted from session totals", "Not covered"],
    };
    for (const [section, blocks] of Object.entries(has)) {
      const t = text(renderPanelHtml(snap(), "x", undefined, section as (typeof SECTIONS)[number])).replace(/\s+/g, " ");
      for (const b of blocks) expect(t, `${section}: ${b}`).toContain(b);
      expect(t, section).not.toContain("Monthly trend");
    }
  });

  it("daily trend: one bar per day of the month, future days empty, today marked", () => {
    const t = totals();
    const big = totals(undefined, { input: m(6_000_000, 2), output: m(0, 2) });
    const html = renderPanelHtml(snap({ month: { ...snap().month!, days: days(5, { 2: t, 3: big, 5: t }) } }), "x", undefined, "daily");
    const daily = html.slice(html.indexOf("Daily trend"), html.indexOf("</section>", html.indexOf("Daily trend")));
    expect(daily.match(/class="col[ "]/g)).toHaveLength(30);
    expect(daily.match(/class="col later[ "]/g)).toHaveLength(25);
    expect(daily.match(/class="col sel[ "]/g)).toHaveLength(1);
    expect(daily.match(/class="fill/g)).toHaveLength(3);
    expect(daily.match(/class="fill peak"/g)).toHaveLength(1);
    const v = text(daily).replace(/\s+/g, " ");
    expect(v).toContain("Peak 6.0M on Nov 3");
    expect(v).toContain("3 of 5 days active");
    // (1.5M + 6.0M + 1.5M) / 3 active days
    expect(v).toContain("Avg / active day 3.0M");
    // instant hover readout with the weekday (no script, no native tooltip)
    expect(daily).toContain('class="col tip-l" data-tip="Sun Nov 1: no usage records"');
    expect(v).not.toMatch(COPY_RE);
  });

  it("daily trend: USD view and empty month", () => {
    const cost = text(renderPanelHtml(snap(), "x", { unit: "cost" }, "daily")).replace(/\s+/g, " ");
    expect(cost).toContain("Daily trend November 2026");
    expect(cost).toContain("Avg / active day $0.040");
    const empty = text(renderPanelHtml(snap({ month: { ...snap().month!, days: days(5, {}), totals: undefined } }), "x", undefined, "daily"));
    expect(empty).toContain("No usage logged in November.");
  });

  it("calendar: 7 weekday headers, leading blanks, one today, future days", () => {
    const html = renderPanelHtml(snap(), "x", undefined, "daily");
    expect(html.match(/class="dow"/g)).toHaveLength(7);
    // Nov 1 2026 is a Sunday → 6 blanks in a Monday-first grid.
    expect(html.match(/class="d pad"/g)).toHaveLength(6);
    expect(html.match(/ now"/g)).toHaveLength(1);
    expect(html.match(/class="d later"/g)).toHaveLength(25);
  });

  it("empty day renders —, never 0", () => {
    const html = renderPanelHtml(snap(), "x", undefined, "daily");
    // a day with no record stays blank; its title says so (design #7)
    expect(html).toMatch(/class="d tip-r" data-tip="Sun Nov 1: no usage records">1<small><span class="sr">no usage records<\/span><\/small>/);
    expect(html).not.toMatch(/>1<small>0<\/small>/);
  });

  it("unreported metrics render — and partial ones * with a reason", () => {
    const t = totals({ "model-a": counts({ reasoning: none(), cacheWrite: m(10, 1, 1) }) }, { reasoning: none(), cacheWrite: m(10, 1, 1) });
    const html = renderPanelHtml(snap({ today: t }), "x", undefined, "daily");
    expect(html).toMatch(/Reasoning<\/span><span class="v"><span aria-hidden="true">—<\/span><span class="sr">not reported<\/span></);
    expect(html).toMatch(/title="reported by 1 of 2 records"><span class="k">Cache write<\/span><span class="v">10<span class="star"[^>]*>\*<\/span>/);
    expect(html).toContain("Cache write: reported by 1 of 2 records.");
    expect(text(html)).not.toMatch(/Reasoning\s+0\b/);
  });

  it("partial health stars Today and names the reason", () => {
    const html = renderPanelHtml(snap({ health: health({ partial: true, unreadableFiles: 1 }) }), "x");
    expect(html).toContain("Partial data");
    expect(html).toMatch(/<div class="big">1\.5M<span class="star"[^>]*>\*<\/span>/);
    expect(renderPanelHtml(snap({ health: health({ partial: true, unreadableFiles: 1 }) }), "x", undefined, "daily")).toContain("1 log could not be read");
  });

  it("one row per model, hostile ids escaped everywhere", () => {
    const evil = `<img src=x onerror=1>"'`;
    const t = totals({ "model-a": counts(), "model-b": counts(), [evil]: counts() });
    const html = renderPanelHtml(snap({ month: { ...snap().month!, totals: t } }), "x", undefined, "models");
    expect(html.match(/<tr><th scope="row"><span class="chipm/g)).toHaveLength(3);
    expect(html).not.toContain("<img");
    expect(html).not.toContain(`onerror=1>"`);
    expect(html).toContain("&lt;img src=x onerror=1&gt;&quot;&#39;");
  });

  it("loading, no-dir, permission and format-changed states", () => {
    expect(text(renderPanelHtml(undefined, "x"))).toContain("Loading");
    const noDir = renderPanelHtml(snap({ today: undefined, current: undefined, health: health({ state: "no-dir" }) }), "x");
    expect(noDir).toContain("copilotUsageMonitor.copilotHome");
    expect(renderPanelHtml(snap({ health: health({ state: "permission" }) }), "x")).toContain("could not be read");
    const fc = renderPanelHtml(snap({ health: health({ state: "format-changed", unrecognized: 2 }) }), "x");
    expect(fc).toContain("Format changed");
    expect(fc).toContain("2 lines in a format this version doesn&#39;t recognize");
  });

  it("no today and no month render dashes", () => {
    const s = snap({ today: undefined, current: undefined, month: { monthStartMs: new Date(2026, 10, 1).getTime(), isCurrent: true, days: days(5, {}), sessions: [], projects: [], tools: [] } });
    const html = renderPanelHtml(s, "x");
    expect(html).toMatch(/<div class="big"><span aria-hidden="true">—<\/span><span class="sr">not reported<\/span><\/div>/);
    expect(text(html)).toContain("No Copilot usage logged in November.");
    expect(text(renderPanelHtml(s, "x", undefined, "models"))).toContain("No model usage logged in November.");
    expect(text(renderPanelHtml(s, "x", undefined, "sessions"))).toContain("No current session.");
    expect(text(renderPanelHtml(s, "x", undefined, "sessions"))).toContain("No sessions with usage in November.");
    expect(text(renderPanelHtml(s, "x", undefined, "daily"))).toContain("Nothing logged today yet.");
    expect(renderPanelHtml(s, "x", undefined, "daily")).not.toMatch(/class="d h[1-4]/);
  });

  it("copy check passes on visible text in every state", () => {
    const states = [
      undefined,
      snap(),
      snap({ health: health({ partial: true, unreadableFiles: 1, malformed: 2, overlong: 1 }) }),
      snap({ health: health({ state: "no-dir" }) }),
      snap({ health: health({ state: "permission" }) }),
      snap({ health: health({ state: "format-changed", unrecognized: 1 }) }),
      snap({ today: undefined, current: undefined }),
      snap({ today: totals(undefined, { sessionTotals: 1 }), month: { ...snap().month!, totals: totals(undefined, { sessionTotals: 2 }) }, health: health({ partial: true, sessionsFromTotals: 2, shutdownOversize: 1 }) }),
    ];
    for (const s of states) {
      for (const view of [undefined, { unit: "cost" as const, range: { min: 1, max: 2 } }]) {
        for (const section of SECTIONS) {
          const html = renderPanelHtml(s, "x", view, section);
          const t = text(html).replace(LOCAL_BANNER, "");
          expect(t, section).not.toMatch(COPY_RE);
          expect(html).not.toMatch(/<script/i);
          expect(html).not.toMatch(/\son\w+\s*=/i);
        }
      }
    }
  });

  it("partial health stars every figure, including the current session, tiles, table and calendar", () => {
    const s = snap({ health: health({ partial: true, unreadableFiles: 1 }) });
    const all = SECTIONS.map((x) => renderPanelHtml(s, "x", undefined, x)).join("");
    expect(renderPanelHtml(s, "x")).toMatch(/Current session<\/span><\/h3><div class="big">1\.5M<span class="star"[^>]*>\*<\/span>/s);
    expect(renderPanelHtml(s, "x", undefined, "daily")).toMatch(/<span class="k">Input<\/span><span class="v">1\.2M<span class="star"[^>]*>\*/);
    expect(renderPanelHtml(s, "x", undefined, "models")).toMatch(/<td class="num sum">1\.5M<span class="star"[^>]*>\*/);
    expect(renderPanelHtml(s, "x", undefined, "daily")).toMatch(/5(?:<span class="sr"> \(today\)<\/span>)?<small>1\.5M<span class="star"[^>]*>\*/);
    expect(all).not.toMatch(/\*<span class="star"[^>]*>\*/);
    expect(all).not.toMatch(/\*\*/);
  });

  it("Calls figures read `calls`, not rows", () => {
    const t = totals({ "model-a": counts({ records: 2, calls: 9 }) }, { records: 2, calls: 9 });
    const s = snap({ today: t, current: { folderId: "3f2a91c0-0000-4000-8000-000000000001", live: true, pinned: false, totals: t }, month: { ...snap().month!, totals: t } });
    const v = text(renderPanelHtml(s, "x"));
    expect(v).toContain("input + output tokens · 9 calls");
    expect(v).toContain("3f2a91c0 · live · 9 calls");
    expect(renderPanelHtml(s, "x", undefined, "daily")).toMatch(/<span class="k">Calls<\/span><span class="v">9<\/span>/);
    expect(renderPanelHtml(s, "x", undefined, "sessions")).toMatch(/<span class="k">Calls<\/span><span class="v">9<\/span>/);
    expect(renderPanelHtml(s, "x", undefined, "models")).toMatch(/<td class="num">9<\/td><\/tr>/);
  });

  it("per call in the model table divides by per-call records only", () => {
    const c = counts({ records: 3, calls: 12, sessionTotals: 1, nanoAiu: m(4e9, 2, 1) });
    const html = renderPanelHtml(snap({ month: { ...snap().month!, totals: totals({ "model-a": c }, { records: 3, calls: 12, sessionTotals: 1 }) } }), "x", undefined, "models");
    expect(text(html)).toContain("November 2026 includes 1 session total from older Copilot, each counted on the day its session ended.");
    // $0.04 over the 2 per-call records, not over 12 calls
    expect(html).toContain("$0.020");
  });

  it("month KPI and data health name session totals only when there are some", () => {
    const plainHtml = SECTIONS.map((x) => renderPanelHtml(snap(), "x", undefined, x)).join("");
    const plain = text(plainHtml);
    expect(plain).not.toContain(SESSION_TOTAL_NOTE);
    expect(plain).not.toMatch(/\d session totals?\b/);
    expect(plain).toMatch(/Sessions counted from session totals\s+0/);
    expect(plain).not.toContain("Session-end lines too long to read");

    const mt = totals({ "model-a": counts({ sessionTotals: 3 }) }, { sessionTotals: 3 });
    const s = snap({ month: { ...snap().month!, totals: mt }, health: health({ sessionsFromTotals: 3, shutdownOversize: 2, partial: true }) });
    const html = renderPanelHtml(s, "x") + renderPanelHtml(s, "x", undefined, "daily") + renderPanelHtml(s, "x", undefined, "health");
    const v = text(html);
    expect(v).toContain("3 session totals");
    expect(v).toContain(SESSION_TOTAL_NOTE);
    expect(html).toContain(`title="${escapeHtml(SESSION_TOTAL_NOTE)}"`);
    expect(v).toMatch(/Sessions counted from session totals\s+3/);
    expect(v).toMatch(/Session-end lines too long to read\s+2/);
    expect(v).toContain("2 session-end lines too long to read were skipped");
    expect(v.split(LOCAL_BANNER).join("")).not.toMatch(COPY_RE);
  });

  it("a session-total row in the sessions table is tagged, with — per call and growth", () => {
    const row = { sessionId: "abcd1234-0000", firstMs: DAY0, lastMs: DAY0 + 1000, calls: 6, tokens: m(7200, 1), nanoAiu: m(0, 0, 1), sessionTotal: true };
    const html = renderPanelHtml(snap({ month: { ...snap().month!, sessions: [row] } }), "x", undefined, "sessions");
    expect(html).toMatch(/<span class="tag total" title="[^"]+">session total<\/span>/);
    expect(text(html)).toContain(SESSION_TOTAL_NOTE);
    // calls come from the request count; growth is not available
    expect(html).toMatch(/<td class="num">6<\/td>/);
    expect(html).toMatch(/title="Not available for a session total[^"]*"><span aria-hidden="true">—<\/span><span class="sr">not reported<\/span><\/td>/);
  });

  it("canary never reaches the HTML", () => {
    for (const section of SECTIONS) expect(renderPanelHtml(snap(), "x", undefined, section)).not.toContain(CANARY);
  });
  it("cost view in CAD: every cost label and figure is converted", () => {
    const cad = { code: "CAD", rate: 1.4, date: "2026-11-06" };
    setDisplayCurrency(cad);
    let t: string;
    try {
      t = text(renderPanelHtml(snap(), "x", { unit: "cost", currency: cad, range: { min: 10, max: 50 } }));
    } finally {
      setDisplayCurrency(undefined);
    }
    expect(t).toContain("CAD (est.)");
    expect(t).toContain("1 USD = 1.4 CAD");
    expect(t).toContain("CA$14.00–CA$70.00");
    expect(t).not.toContain("USD (est.)");
    expect(t.replace(/\$0\.01/g, "")).not.toMatch(/(?<![A-Z])\$\d/);
  });
  it("cost view in CAD: no section shows a USD label or a bare $ figure", () => {
    const cad = { code: "CAD", rate: 1.4, date: "2026-11-06" };
    setDisplayCurrency(cad);
    try {
      for (const sec of SECTIONS) {
        const t = text(renderPanelHtml(snap(), "x", { unit: "cost", currency: cad, range: { min: 10 } }, sec));
        expect(t, sec).not.toContain("USD (est.)");
        expect(t, sec).not.toMatch(/estimated USD(?! reference)/);
        expect(t.replace(/× \$0\.01|\$0\.01 per credit/g, ""), sec).not.toMatch(/(?<![A-Z])\$\d/);
      }
    } finally {
      setDisplayCurrency(undefined);
    }
  });
});

describe("v0.6 (2.6): Copilot Chat in VS Code is named as not covered", () => {
  it("Data health always shows the line, as a note above the facts, whatever the state", async () => {
    const { CHAT_NOT_COVERED } = await import("../../src/core/format");
    expect(CHAT_NOT_COVERED).toBe("Not covered: Copilot Chat in VS Code (only Copilot CLI logs are read), so figures are a lower bound for Chat users.");
    expect(CHAT_NOT_COVERED).not.toMatch(COPY_RE);
    for (const s of [snap(), snap({ health: health({ partial: true, malformed: 1 }) }), snap({ today: undefined, health: health({ state: "no-data" }) })]) {
      const html = renderPanelHtml(s, "x", undefined, "health");
      const t = text(html).replace(/\s+/g, " ");
      expect(t).toContain(CHAT_NOT_COVERED);
      expect(html.indexOf("Copilot Chat in VS Code")).toBeLessThan(html.indexOf("Logs read"));
    }
    for (const other of ["overview", "daily", "sessions", "models"] as const) {
      expect(text(renderPanelHtml(snap(), "x", undefined, other))).not.toContain(CHAT_NOT_COVERED);
    }
  });
});
