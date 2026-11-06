// v0.2: month history, month selection, estimated USD, the personal target
// range and per-session cost summaries (D20–D24).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanRange,
  currentRangeState,
  formatRange,
  formatUsd,
  LOCAL_BANNER,
  money,
  rangeState,
  statusText,
  tooltipMarkdown,
} from "../../src/core/format";
import { Logger } from "../../src/core/log";
import { clampHistory, UsageMonitor } from "../../src/core/monitor";
import { escapeHtml, GROWTH_FLAG, monthKey, PANEL_COMMANDS, renderPanelHtml } from "../../src/core/panelHtml";
import { byMonth, daysOfMonth, monthStarts, sessionSummaries, UsageStore } from "../../src/core/store";
import type { Counts, Health, Metric, Snapshot, Totals, UsageRecord } from "../../src/core/types";
import { CANARY, jsonl, sessionTree, usageEvent } from "../fixtures/build";

const m = (sum: number, reported: number, missing = 0): Metric => ({ sum, reported, missing });
const none = (): Metric => m(0, 0);

// ---------------------------------------------------------------- store

function rec(key: string, ts: number, o: Partial<UsageRecord> = {}): UsageRecord {
  return {
    key,
    keySource: "usageId",
    sessionId: "s1",
    folderId: "s1",
    timestampMs: ts,
    model: "model-a",
    tokens: { input: 100, output: 10 },
    nanoAiu: 1e9,
    ...o,
  };
}

describe("month helpers", () => {
  it("monthStarts: n local month starts ending with now's month, across a year", () => {
    const s = monthStarts(new Date(2026, 1, 10), 3);
    expect(s).toEqual([new Date(2025, 11, 1).getTime(), new Date(2026, 0, 1).getTime(), new Date(2026, 1, 1).getTime()]);
  });

  it("byMonth buckets records; empty months stay undefined; older records are skipped", () => {
    const st = new UsageStore();
    st.add(rec("old", new Date(2025, 10, 30).getTime()), "f");
    st.add(rec("a", new Date(2025, 11, 31, 23, 59).getTime()), "f");
    st.add(rec("b", new Date(2026, 1, 2).getTime()), "f");
    st.add(rec("c", new Date(2026, 1, 3).getTime()), "f");
    const h = byMonth(st, monthStarts(new Date(2026, 1, 10), 3));
    expect(h.map((x) => x.totals?.records)).toEqual([1, undefined, 2]);
  });

  it("daysOfMonth for a past month covers every day and stops at the month end", () => {
    const st = new UsageStore();
    st.add(rec("a", new Date(2026, 1, 28, 23).getTime()), "f");
    st.add(rec("b", new Date(2026, 2, 1, 1).getTime()), "f");
    const d = daysOfMonth(st, new Date(2026, 1, 1).getTime(), 28, false);
    expect(d).toHaveLength(28);
    expect(d[27]!.totals!.records).toBe(1);
  });

  it("clampHistory", () => {
    expect(clampHistory(12)).toBe(12);
    expect(clampHistory(0)).toBe(1);
    expect(clampHistory(99)).toBe(24);
    expect(clampHistory(3.7)).toBe(3);
    expect(clampHistory("x")).toBe(1);
    expect(clampHistory(Number.NaN)).toBe(1);
  });
});

describe("sessionSummaries", () => {
  it("groups by session, costliest first, top model by calls, limit applies", () => {
    const st = new UsageStore();
    const t = new Date(2026, 9, 5).getTime();
    st.add(rec("a1", t, { sessionId: "cheap", nanoAiu: 1e9 }), "f");
    st.add(rec("b1", t, { sessionId: "dear", nanoAiu: 5e9, model: "m-x" }), "f");
    st.add(rec("b2", t + 1, { sessionId: "dear", nanoAiu: 5e9, model: "m-y" }), "f");
    st.add(rec("b3", t + 2, { sessionId: "dear", nanoAiu: 5e9, model: "m-y" }), "f");
    st.add(rec("out", new Date(2026, 10, 1).getTime(), { sessionId: "nextmonth" }), "f");
    const s = sessionSummaries(st, new Date(2026, 9, 1).getTime(), new Date(2026, 10, 1).getTime());
    expect(s.map((x) => x.sessionId)).toEqual(["dear", "cheap"]);
    expect(s[0]!.calls).toBe(3);
    expect(s[0]!.topModel).toBe("m-y");
    expect(s[0]!.nanoAiu.sum).toBe(15e9);
    expect(s[0]!.tokens.sum).toBe(330);
    expect(s[0]!.firstMs).toBe(t);
    expect(s[0]!.lastMs).toBe(t + 2);
    expect(sessionSummaries(st, 0, Infinity, 1)).toHaveLength(1);
  });

  it("growth = mean of last 5 calls ÷ mean of first 5, only with ≥ 10 priced calls", () => {
    const st = new UsageStore();
    const t = new Date(2026, 9, 5).getTime();
    for (let i = 0; i < 10; i++) st.add(rec(`g${i}`, t + i, { sessionId: "grow", nanoAiu: i < 5 ? 1e9 : 6e9 }), "f");
    for (let i = 0; i < 9; i++) st.add(rec(`s${i}`, t + i, { sessionId: "short" }), "f");
    const s = sessionSummaries(st, 0, Infinity);
    expect(s.find((x) => x.sessionId === "grow")!.growth).toBeCloseTo(6);
    expect(s.find((x) => x.sessionId === "short")!.growth).toBeUndefined();
  });

  it("unreported fields stay unreported", () => {
    const st = new UsageStore();
    st.add(rec("a", 1, { nanoAiu: undefined, tokens: {} }), "f");
    const [s] = sessionSummaries(st, 0, Infinity);
    expect(s!.nanoAiu.reported).toBe(0);
    expect(s!.tokens.reported).toBe(0);
    expect(s!.topModel).toBe("model-a");
  });
});

// ---------------------------------------------------------------- format

describe("USD and target range", () => {
  it("formatUsd: AIU × $0.01, — when unreported, * when partial", () => {
    expect(formatUsd(m(3.229e9, 38))).toBe("$0.032");
    expect(formatUsd(m(1234e9, 2))).toBe("$12.34");
    expect(formatUsd(m(25_000e9, 2))).toBe("$250");
    expect(formatUsd(m(0, 1))).toBe("$0.00");
    expect(formatUsd(none())).toBe("—");
    expect(formatUsd(m(1e9, 1, 1))).toBe("$0.010*");
    expect(money(1234.5)).toBe("$1,235");
  });

  it("cleanRange drops bad bounds and an inverted max", () => {
    expect(cleanRange(20, 60)).toEqual({ min: 20, max: 60 });
    expect(cleanRange(null, 60)).toEqual({ max: 60 });
    expect(cleanRange(-1, "x")).toBeUndefined();
    expect(cleanRange(50, 10)).toEqual({ min: 50 });
    expect(cleanRange(undefined, undefined)).toBeUndefined();
  });

  it("rangeState and formatRange", () => {
    const r = { min: 20, max: 60 };
    expect(rangeState(10, r)).toBe("under");
    expect(rangeState(undefined, r)).toBe("under");
    expect(rangeState(20, r)).toBe("in");
    expect(rangeState(60, r)).toBe("in");
    expect(rangeState(60.01, r)).toBe("over");
    expect(rangeState(5, undefined)).toBe("none");
    expect(rangeState(1000, { min: 5 })).toBe("in");
    expect(formatRange(r)).toBe("$20.00–$60.00");
    expect(formatRange({ min: 5 })).toBe("at least $5.00");
    expect(formatRange({ max: 5 })).toBe("up to $5.00");
  });
});

// ---------------------------------------------------------------- snapshots

function counts(o: Partial<Counts> = {}): Counts {
  return {
    records: 4,
    input: m(1_000_000, 4),
    output: m(20_000, 4),
    cacheRead: m(900_000, 4),
    cacheWrite: m(0, 4),
    reasoning: m(0, 4),
    durationMs: m(60_000, 4),
    nanoAiu: m(3_000e9, 4), // $30
    ...o,
  };
}
function totals(o: Partial<Counts> = {}): Totals {
  return { ...counts(o), byModel: { "model-a": counts(o) } };
}
function health(o: Partial<Health> = {}): Health {
  return { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, ...o };
}

const NOV = new Date(2026, 10, 1).getTime();
const OCT = new Date(2026, 9, 1).getTime();
const SEP = new Date(2026, 8, 1).getTime();

function snap(o: Partial<Snapshot> = {}): Snapshot {
  const t = totals();
  const days = Array.from({ length: 5 }, (_, i) => ({ dayStartMs: new Date(2026, 10, i + 1).getTime(), ...(i === 4 && { totals: t }) }));
  return {
    generatedAtMs: new Date(2026, 10, 5, 10).getTime(),
    dayStartMs: new Date(2026, 10, 5).getTime(),
    today: t,
    sessions: [],
    health: health(),
    month: {
      monthStartMs: NOV,
      isCurrent: true,
      days,
      totals: t,
      sessions: [
        { sessionId: "3f2a91c0-aaaa-4000-8000-000000000001", firstMs: NOV, lastMs: NOV + 86_400_000, calls: 12, topModel: "gpt-6-luna", tokens: m(500_000, 12), nanoAiu: m(2_000e9, 12), growth: 6.2 },
        { sessionId: "77777777-bbbb-4000-8000-000000000002", firstMs: NOV, lastMs: NOV, calls: 3, tokens: m(9_000, 3), nanoAiu: m(1_000e9, 3) },
      ],
    },
    history: [{ monthStartMs: SEP }, { monthStartMs: OCT, totals: totals({ nanoAiu: m(7_000e9, 9) }) }, { monthStartMs: NOV, totals: t }],
    ...o,
  };
}

const COST = { unit: "cost" as const };
const RANGE = { unit: "cost" as const, range: { min: 20, max: 60 } };

describe("status bar with USD and target", () => {
  it("tokens mode is unchanged without a target", () => {
    expect(statusText(snap())).toBe("$(pulse) Local today: 1.0M tok");
  });

  it("cost mode shows this month's estimate, with the target when set", () => {
    expect(statusText(snap(), COST)).toBe("$(pulse) Local Nov: $30.00");
    expect(statusText(snap(), RANGE)).toBe("$(pass) Local Nov: $30.00 / $20.00–$60.00");
    expect(statusText(snap(), { unit: "cost", range: { max: 10 } })).toBe("$(flame) Local Nov: $30.00 / up to $10.00");
    expect(statusText(snap(), { unit: "tokens", range: { min: 50 } })).toBe("$(arrow-down) Local today: 1.0M tok");
  });

  it("the target follows the current month even while a past month is viewed", () => {
    const s = snap({ month: { ...snap().month!, monthStartMs: OCT, isCurrent: false } });
    expect(currentRangeState(s, { unit: "cost", range: { max: 40 } })).toBe("in");
    expect(statusText(s, COST)).toContain("Local Nov:");
  });

  it("format change still wins the icon; partial stars the figure", () => {
    expect(statusText(snap({ health: health({ state: "format-changed" }) }), RANGE)).toMatch(/^\$\(warning\)/);
    expect(statusText(snap({ health: health({ partial: true }) }), COST)).toBe("$(pulse) Local Nov: $30.00*");
  });

  it("tooltip names the estimate and the target state", () => {
    const md = tooltipMarkdown(snap(), RANGE);
    expect(md).toContain("**This month (estimated)**: \\$30\\.00");
    expect(md).toContain("in target range");
    expect(md).toContain("not an invoice");
    expect(tooltipMarkdown(snap())).not.toContain("estimated");
  });
});

// ---------------------------------------------------------------- panel

function text(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

describe("panel: navigation, trend, target, sessions", () => {
  it("links only to allowlisted commands, with encoded month arguments", () => {
    const html = renderPanelHtml(snap(), "x", RANGE);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]!.replace(/&amp;/g, "&"));
    expect(hrefs.length).toBeGreaterThan(4);
    for (const h of hrefs) {
      const cmd = /^command:([\w.]+)\?/.exec(h)?.[1];
      expect(PANEL_COMMANDS as readonly string[]).toContain(cmd);
    }
    expect(hrefs).toContain(`command:copilotUsageMonitor.selectMonth?${encodeURIComponent(JSON.stringify([monthKey(OCT)]))}`);
    expect(hrefs).toContain(`command:copilotUsageMonitor.setUnit?${encodeURIComponent(JSON.stringify(["tokens"]))}`);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
  });

  it("nav: no next on the current month; prev and next on a middle month", () => {
    const cur = renderPanelHtml(snap(), "x");
    expect(cur).toMatch(/<span class="btn off">›<\/span>/);
    const mid = renderPanelHtml(snap({ month: { ...snap().month!, monthStartMs: OCT, isCurrent: false } }), "x");
    expect(mid).toMatch(/<a class="btn" href="[^"]*%222026-09%22[^"]*" title="Previous month">‹<\/a>/);
    expect(mid).toMatch(/<a class="btn" href="[^"]*%222026-11%22[^"]*" title="Next month">›<\/a>/);
    expect(text(mid)).toContain("This month");
    expect(text(mid)).toContain("October 2026 by model");
  });

  it("trend: one column per month, selected outlined, empty month has no bar, target band in USD", () => {
    const html = renderPanelHtml(snap(), "x", RANGE);
    expect(html.match(/<a class="col/g)).toHaveLength(3);
    expect(html.match(/<a class="col sel"/g)).toHaveLength(1);
    expect(html).toContain('class="band"');
    expect(html).toMatch(/fill st-in/); // Nov $30 in $20–$60
    expect(html).toMatch(/fill st-over/); // Oct $70
    const tok = renderPanelHtml(snap(), "x");
    expect(tok).not.toContain('class="band"');
  });

  it("USD view: KPIs in dollars, cost note shown, target card", () => {
    const t = text(renderPanelHtml(snap(), "x", RANGE));
    expect(t).toContain("$30.00");
    expect(t).toContain("Target $20.00–$60.00");
    expect(t).toContain("In range");
    expect(t).toContain("not an invoice");
    expect(t).toContain("Daily USD (est.)");
  });

  it("costliest sessions: short ids, growth flag, escaped hostile ids", () => {
    const evil = `<img src=x onerror=1>${CANARY}`;
    const base = snap();
    const s = snap({ month: { ...base.month!, sessions: [...base.month!.sessions, { sessionId: evil, firstMs: NOV, lastMs: NOV, calls: 1, topModel: evil, tokens: m(1, 1), nanoAiu: m(1, 1) }] } });
    const html = renderPanelHtml(s, "x");
    expect(html).toContain(">3f2a91c0<");
    expect(html).toContain(`6.2× ▲`);
    expect(GROWTH_FLAG).toBe(3);
    expect(html).toContain("a fresh session may be cheaper");
    expect(html).not.toContain("<img");
    expect(html).toContain(escapeHtml(evil.slice(0, 8)));
  });

  it("copy check: no account-statement words or % in any unit", () => {
    for (const view of [undefined, COST, RANGE]) {
      const t = text(renderPanelHtml(snap(), "x", view)).replace(LOCAL_BANNER, "");
      expect(t).not.toMatch(/\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i);
    }
  });
});

// ---------------------------------------------------------------- monitor

describe("monitor: history window and month selection", () => {
  const A = "0000aaaa-0000-4000-8000-000000000001";
  const B = "0000bbbb-0000-4000-8000-000000000002";
  const C = "0000cccc-0000-4000-8000-000000000003";
  let root: string;
  let snaps: Snapshot[];
  const now = new Date(2026, 0, 15, 10).getTime();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cum-history-"));
    snaps = [];
    const dec = new Date(2025, 11, 20, 12);
    const nov = new Date(2025, 10, 3, 12);
    await sessionTree(root, [
      { id: A, lines: jsonl([usageEvent({ usageId: "a1", sourceSessionId: A, timestamp: new Date(2026, 0, 15, 9).toISOString() })]) },
      { id: B, lines: jsonl([usageEvent({ usageId: "b1", sourceSessionId: B, timestamp: dec.toISOString() }), usageEvent({ usageId: "b2", id: "e2", sourceSessionId: B, timestamp: dec.toISOString() })]), mtime: dec },
      { id: C, lines: jsonl([usageEvent({ usageId: "c1", sourceSessionId: C, timestamp: nov.toISOString() })]), mtime: nov },
    ]);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const make = (historyMonths?: number) =>
    new UsageMonitor({ root, rootSource: "default", now: () => new Date(now), isLive: () => false, log: new Logger(() => {}), onSnapshot: (s) => snaps.push(s), ...(historyMonths !== undefined && { historyMonths }) });

  it("default (1 month) keeps the old behaviour", async () => {
    const mon = make();
    await mon.refresh({ full: true });
    const s = snaps.at(-1)!;
    expect(s.history).toHaveLength(1);
    expect(s.history![0]!.totals!.records).toBe(1);
  });

  it("reads older logs into history; this month's session list ignores them", async () => {
    const mon = make(3);
    await mon.refresh({ full: true });
    const s = snaps.at(-1)!;
    expect(s.history!.map((h) => h.totals?.records)).toEqual([1, 2, 1]);
    expect(s.month!.isCurrent).toBe(true);
    expect(s.month!.totals!.records).toBe(1);
    expect(s.sessions.map((x) => x.folderId)).toEqual([A]);
  });

  it("history window bounds what is read", async () => {
    const mon = make(2);
    await mon.refresh({ full: true });
    expect(snaps.at(-1)!.history!.map((h) => h.totals?.records)).toEqual([2, 1]);
  });

  it("selectMonth shows a past month in full; today and current stay live; out of window falls back", async () => {
    const mon = make(3);
    await mon.refresh({ full: true });
    mon.selectMonth(new Date(2025, 11, 1).getTime());
    await mon.refresh();
    let s = snaps.at(-1)!;
    expect(s.month!.isCurrent).toBe(false);
    expect(s.month!.days).toHaveLength(31);
    expect(s.month!.totals!.records).toBe(2);
    expect(s.month!.days[19]!.totals!.records).toBe(2);
    expect(s.month!.sessions.map((x) => x.sessionId)).toEqual([B]);
    expect(s.today!.records).toBe(1);

    mon.selectMonth(new Date(2024, 0, 1).getTime());
    await mon.refresh();
    s = snaps.at(-1)!;
    expect(s.month!.isCurrent).toBe(true);
    expect(s.month!.monthStartMs).toBe(new Date(2026, 0, 1).getTime());

    mon.selectMonth(undefined);
    await mon.refresh();
    expect(snaps.at(-1)!.month!.isCurrent).toBe(true);
  });

  it("canary never reaches a snapshot", async () => {
    const mon = make(3);
    await mon.refresh({ full: true });
    expect(JSON.stringify(snaps)).not.toContain(CANARY);
  });
});
