// Review finding #3: unknown cost must never read as "in range". A target compares a
// TargetSpend that keeps apart no records ($0), known zero, partial cost (a lower bound,
// marked "*") and full cost; records with tokens but no logged cost are "unknown".
import { describe, expect, it } from "vitest";
import { copilotIncomplete, rangeLabel, rangeState, rangeWord, statusAccessibilityLabel, statusParts, statusText, targetSpend, targetStatus, tooltipMarkdown } from "../../src/core/format";
import { renderOverview, trend } from "../../src/core/panel/overview";
import { partialReasons } from "../../src/core/panel/shared";
import { PANEL_CSS } from "../../src/core/panelCss";
import { buildSidebarModel, sidebarRows } from "../../src/core/sidebarModel";
import { TargetAlertState } from "../../src/core/targetAlert";
import type { Counts, Health, Metric, Snapshot, SourceHealth, Totals, ViewOptions } from "../../src/core/types";

const m = (sum: number, reported = 1, missing = 0): Metric => ({ sum, reported, missing });
const USD = 1e11;
const t = (nano: Metric): Totals => {
  const c: Counts = { records: 1, calls: 1, callsMissing: 0, sessionTotals: 0, input: m(10), output: m(1), cacheRead: m(0), cacheWrite: m(0), reasoning: m(0), durationMs: m(0), nanoAiu: nano, callNanoAiu: nano };
  return { ...c, byModel: {} };
};
const health: Health = { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0 };
const day = new Date(2026, 10, 6).getTime();
const snap = (nano: Metric | undefined, extra: Partial<Snapshot> = {}): Snapshot => ({ generatedAtMs: day, dayStartMs: day, sessions: [], health, ...(nano && { thisMonth: t(nano) }), ...extra });
const COST: ViewOptions = { unit: "cost", range: { max: 60 } };
const UNKNOWN = m(0, 0, 3); // three records, none logged a cost
const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;

describe("targetSpend: four distinct cases", () => {
  it("no records is $0, known zero is $0, partial is a lower bound, records without cost are unknown", () => {
    expect(targetSpend(undefined)).toEqual({ usd: 0, partial: false });
    expect(targetSpend(t(m(0, 2)))).toEqual({ usd: 0, partial: false });
    expect(targetSpend(t(m(10 * USD, 2, 1)))).toEqual({ usd: 10, partial: true });
    expect(targetSpend(t(m(10 * USD, 3)))).toEqual({ usd: 10, partial: false });
    expect(targetSpend(t(UNKNOWN))).toBe("unknown");
  });

  it("only the Copilot part counts: Claude Code alone is $0, Copilot without cost is unknown", () => {
    const claudeOnly: Totals = { ...t(m(5 * USD)), sources: { "claude-code": 1 }, bySource: { "claude-code": t(m(5 * USD)) } };
    expect(targetSpend(claudeOnly)).toEqual({ usd: 0, partial: false });
    const copilotNoCost: Totals = { ...t(m(5 * USD, 1, 1)), sources: { "claude-code": 1, copilot: 1 }, bySource: { "claude-code": t(m(5 * USD)), copilot: t(m(0, 0, 1)) } };
    expect(targetSpend(copilotNoCost)).toBe("unknown");
  });

  it("rangeState: unknown is never compared (and never 'in'); numbers keep their old meaning", () => {
    expect(rangeState("unknown", { max: 60 })).toBe("unknown");
    expect(rangeState("unknown", { min: 5, max: 60 })).toBe("unknown");
    expect(rangeState("unknown", undefined)).toBe("none");
    expect(rangeState(undefined, { max: 60 })).toBe("in");
    expect(rangeState({ usd: 70, partial: true }, { max: 60 })).toBe("over");
  });

  it("partial: under and in carry '*' (a lower bound); over is certain and does not", () => {
    const inP = targetStatus(t(m(10 * USD, 2, 1)), { max: 60 });
    expect(inP).toEqual({ state: "in", partial: true });
    expect(rangeLabel(inP)).toBe("in target range*");
    expect(rangeWord(inP)).toBe("In range*");
    const overP = targetStatus(t(m(70 * USD, 2, 1)), { max: 60 });
    expect(overP).toEqual({ state: "over", partial: false });
    expect(rangeLabel(overP)).toBe("over target");
    const unk = targetStatus(t(UNKNOWN), { max: 60 });
    expect(rangeLabel(unk)).toBe("amount not logged, target not compared");
    expect(rangeWord(unk)).toBe("Not compared");
  });
});

describe("every surface: unknown is not 'in range'", () => {
  it("status bar: no pass icon, a question mark instead", () => {
    const s = snap(UNKNOWN);
    expect(statusParts(s, COST).state).toBe("unknown");
    expect(statusText(s, COST)).toBe("$(question) Local Nov: — / up to $60.00");
    const said = statusAccessibilityLabel(s, COST);
    // The range belongs to the target, not to the amount (review finding J).
    expect(said).toContain("amount not logged, target up to 60.00 US dollars not compared");
    expect(said).not.toContain("not compared up to");
    expect(said).not.toContain("in target range");
  });

  it("status bar: known zero and no records stay in range", () => {
    expect(statusText(snap(m(0, 2)), COST)).toBe("$(pass) Local Nov: $0.00 / up to $60.00");
    expect(statusText(snap(undefined), COST)).toBe("$(pass) Local Nov: — / up to $60.00");
  });

  it("status bar and tooltip: partial in range is marked as a lower bound", () => {
    const s = snap(m(10 * USD, 2, 1));
    expect(statusParts(s, COST)).toMatchObject({ state: "in", partial: true });
    expect(statusAccessibilityLabel(s, COST)).toContain("in target range (may be incomplete)");
    expect(tooltipMarkdown(s, COST)).toContain("in target range\\*");
  });

  it("tooltip: monthly, daily and weekly targets say not compared", () => {
    const md = tooltipMarkdown(snap(UNKNOWN, { today: t(UNKNOWN), last7: t(UNKNOWN) }), { ...COST, dayTarget: { max: 5 }, weekTarget: { max: 20 } });
    expect(md).not.toContain("in target range");
    expect(md.match(/amount not logged\\, target not compared/g)).toHaveLength(3);
  });

  it("side bar: the markers and titles say not compared", () => {
    const s = snap(UNKNOWN, { today: t(UNKNOWN), last7: t(UNKNOWN) });
    const rows = sidebarRows(buildSidebarModel(s, { ...COST, dayTarget: { max: 5 }, weekTarget: { max: 20 } }));
    const marked = rows.filter((r) => r.marker);
    expect(marked.length).toBeGreaterThanOrEqual(3);
    for (const r of marked) {
      expect(r.marker).toEqual({ kind: "unknown", text: "not compared" });
      expect(r.spoken).not.toContain("in target range");
      expect(r.title).not.toContain("in target range");
    }
  });

  it("side bar: a partial month marks its state with '*'", () => {
    const rows = sidebarRows(buildSidebarModel(snap(m(10 * USD, 2, 1)), COST));
    const r = rows.find((x) => x.marker && x.marker.kind !== "filtered")!;
    expect(r.marker).toEqual({ kind: "in", text: "in range*" });
    expect(r.spoken).toContain("in target range (may be incomplete)");
  });

  it("overview trend: an unknown month is not drawn as in range", () => {
    const html = trend(snap(UNKNOWN, { history: [{ monthStartMs: new Date(2026, 10, 1).getTime(), totals: t(UNKNOWN) }] as Snapshot["history"] }), COST);
    expect(html).not.toContain("in target range");
    expect(html).toContain("amount not logged, target not compared");
    expect(html).toContain("Nov 26 ?");
    expect(html).not.toContain("fill st-in");
  });

  it("the target alert never fires on unknown cost; a partial month already over still fires", () => {
    expect(new TargetAlertState().next(snap(UNKNOWN), COST, true)).toBeUndefined();
    const msg = new TargetAlertState().next(snap(m(70 * USD, 2, 1)), COST, true);
    expect(msg).toContain("$70.00* est.");
  });

  it("the new wording passes the copy gate", () => {
    for (const st of [targetStatus(t(UNKNOWN), { max: 1 }), targetStatus(t(m(USD, 1, 1)), { max: 60 })]) {
      expect(rangeLabel(st)).not.toMatch(COPY_RE);
      expect(rangeWord(st)).not.toMatch(COPY_RE);
    }
  });
});

describe("review findings I, K, P and N", () => {
  const nov = new Date(2026, 10, 1).getTime();
  const oct = new Date(2026, 9, 1).getTime();
  // Tokens from two sources without a per-source split: a figure, but the Copilot part is unknown.
  const mixed: Totals = { ...t(m(5 * USD)), sources: { copilot: 1, "claude-code": 1 } };

  it("I: an unknown month draws a muted fill and the legend gains '? Not compared' only then", () => {
    const html = trend(snap(m(5 * USD), { history: [{ monthStartMs: oct, totals: t(m(5 * USD)) }, { monthStartMs: nov, totals: mixed }] as Snapshot["history"] }), COST);
    expect(html).toContain('class="fill st-unknown"');
    expect(html).toContain('<b class="st-unknown"></b>? Not compared');
    expect(PANEL_CSS).toMatch(/\.trend \.col \.fill\.st-unknown, \.lg b\.st-unknown \{ background: [^}]+\}/);
    const known = trend(snap(m(5 * USD), { history: [{ monthStartMs: nov, totals: t(m(5 * USD)) }] as Snapshot["history"] }), COST);
    expect(known).not.toContain("Not compared");
    expect(known).not.toContain("st-unknown");
  });

  it("K: 'in' a min-only range is not starred (more amount cannot leave it); with a max it is", () => {
    const partial = t(m(25 * USD, 2, 1));
    expect(targetStatus(partial, { min: 20 })).toEqual({ state: "in", partial: false });
    expect(rangeLabel(targetStatus(partial, { min: 20 }))).toBe("in target range");
    expect(targetStatus(partial, { min: 20, max: 60 })).toEqual({ state: "in", partial: true });
    expect(targetStatus(partial, { min: 30 })).toEqual({ state: "under", partial: true });
  });

  it("P: the '*' in the hero, Month to date and Last 7 days subtitles is spoken", () => {
    const p = t(m(USD, 2, 1));
    const view: ViewOptions = { unit: "cost", range: { max: 60 }, dayTarget: { max: 5 }, weekTarget: { max: 20 } };
    const month = { monthStartMs: nov, isCurrent: true, days: [{ dayStartMs: day, totals: p }], sessions: [], projects: [], tools: [], totals: p } as unknown as Snapshot["month"];
    const html = renderOverview(snap(m(USD, 2, 1), { today: p, last7: p, month }), view);
    const subs = [...html.matchAll(/<div class="sub">([\s\S]*?)<\/div>/g)].map((x) => x[1]!);
    const hero = subs.find((x) => x.includes("Daily target"))!;
    const mtd = subs.find((x) => x.includes("Target up to"))!;
    const week = subs.find((x) => x.includes("Weekly target"))!;
    for (const sub of [hero, mtd, week]) {
      expect(sub).toContain('<span aria-hidden="true">');
      expect(sub).toMatch(/<span class="sr">[^<]*In range \(may be incomplete\)/);
    }
  });

  it("N: a folder that could not be listed is named as such, not as an unreadable log", () => {
    const failed: Health = {
      ...health,
      partial: true,
      unreadableFiles: 1,
      sources: { copilot: { state: "ok", rootSource: "default", files: 1, sessions: 1, unreadableFiles: 1, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, discoveryFailed: true } },
    };
    expect(partialReasons(failed)).toBe("Totals may be incomplete: a log folder could not be listed; new sessions may be missing.");
    const md = tooltipMarkdown(snap(m(USD), { health: failed, today: t(m(USD)) }), COST);
    expect(md).toContain("- A log folder could not be listed; new sessions may be missing.");
    expect(md).not.toContain("log file(s) could not be read");
    // an unreadable log beside it is still counted, without the folder
    expect(partialReasons({ ...failed, unreadableFiles: 2 })).toBe("Totals may be incomplete: a log folder could not be listed; new sessions may be missing; 1 log could not be read.");
    expect(tooltipMarkdown(snap(m(USD), { health: { ...failed, unreadableFiles: 2 }, today: t(m(USD)) }), COST)).toContain("- 1 log file(s) could not be read.");
  });
});

describe("a Copilot read failure makes the target comparison a lower bound too", () => {
  const nov = new Date(2026, 10, 1).getTime();
  const src = (extra: Partial<SourceHealth> = {}): SourceHealth => ({ state: "ok", rootSource: "default", files: 1, sessions: 1, unreadableFiles: 0, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, ...extra });
  const copilotUnreadable: Health = { ...health, partial: true, unreadableFiles: 1, sources: { copilot: src({ unreadableFiles: 1 }), "claude-code": src() } };
  const copilotNotListed: Health = { ...health, partial: true, unreadableFiles: 1, sources: { copilot: src({ unreadableFiles: 1, discoveryFailed: true }) } };
  const claudeUnreadable: Health = { ...health, partial: true, unreadableFiles: 1, sources: { copilot: src(), "claude-code": src({ unreadableFiles: 1 }) } };
  const full = m(10 * USD, 3); // every record logged a cost
  const view: ViewOptions = { unit: "cost", range: { max: 60 }, dayTarget: { max: 50 }, weekTarget: { max: 55 } };

  it("copilotIncomplete counts Copilot's failures only", () => {
    expect(copilotIncomplete(undefined)).toBe(false);
    expect(copilotIncomplete(health)).toBe(false);
    expect(copilotIncomplete({ ...health, partial: true })).toBe(true); // no per-source split: the read is Copilot's
    expect(copilotIncomplete(copilotUnreadable)).toBe(true);
    expect(copilotIncomplete(copilotNotListed)).toBe(true);
    expect(copilotIncomplete({ ...health, partial: true, sources: { copilot: src({ malformed: 2 }) } })).toBe(true);
    expect(copilotIncomplete({ ...health, partial: true, sources: { copilot: src({ capped: 4 }) } })).toBe(true);
    expect(copilotIncomplete(claudeUnreadable)).toBe(false);
    // an unread session.shutdown line has no per-source count; only Copilot writes it
    expect(copilotIncomplete({ ...claudeUnreadable, shutdownOversize: 1 })).toBe(true);
    expect(copilotIncomplete({ ...health, partial: true, shutdownOversize: 1, sources: { copilot: src() } })).toBe(true);
  });

  it("targetStatus: under and in-with-max are starred; over and min-only in stay certain", () => {
    expect(targetStatus(t(full), { max: 60 }, copilotUnreadable)).toEqual({ state: "in", partial: true });
    expect(targetStatus(t(full), { min: 20 }, copilotUnreadable)).toEqual({ state: "under", partial: true });
    expect(targetStatus(t(full), { min: 5 }, copilotUnreadable)).toEqual({ state: "in", partial: false });
    expect(targetStatus(t(full), { max: 5 }, copilotUnreadable)).toEqual({ state: "over", partial: false });
    expect(targetStatus(t(UNKNOWN), { max: 60 }, copilotUnreadable)).toEqual({ state: "unknown", partial: false });
    // no Copilot record at all, but its logs were not all read: $0 so far is a lower bound
    expect(targetStatus(undefined, { max: 60 }, copilotUnreadable)).toEqual({ state: "in", partial: true });
    expect(targetStatus(t(full), { max: 60 }, claudeUnreadable)).toEqual({ state: "in", partial: false });
    expect(targetStatus(t(full), { max: 60 }, health)).toEqual({ state: "in", partial: false });
  });

  it("status bar text, accessibility label and tooltip: the reviewer's case is no longer an unqualified 'In range'", () => {
    const s = snap(full, { health: copilotUnreadable, today: t(full), last7: t(full) });
    expect(statusParts(s, view)).toMatchObject({ figure: "$10.00*", state: "in", partial: true });
    expect(statusAccessibilityLabel(s, view)).toContain("in target range (may be incomplete)");
    const md = tooltipMarkdown(s, view);
    // monthly, daily and weekly target lines
    expect(md.match(/target up to \\\$\d+\\\.00: in target range\\\*/gi)).toHaveLength(3);
    // a list that failed is the same
    expect(statusParts(snap(full, { health: copilotNotListed }), view).partial).toBe(true);
  });

  it("a Claude Code read failure leaves the Copilot-only target certain", () => {
    const s = snap(full, { health: claudeUnreadable, today: t(full), last7: t(full) });
    expect(statusParts(s, view)).toMatchObject({ figure: "$10.00*", state: "in", partial: false });
    expect(statusAccessibilityLabel(s, view)).not.toContain("in target range (may be incomplete)");
    expect(tooltipMarkdown(s, view)).not.toContain("in target range\\*");
  });

  it("side bar: month, today and last 7 days markers are starred", () => {
    const s = snap(full, { health: copilotUnreadable, today: t(full), last7: t(full) });
    const marked = sidebarRows(buildSidebarModel(s, view)).filter((r) => r.marker && r.marker.kind !== "filtered");
    expect(marked.length).toBeGreaterThanOrEqual(3);
    for (const r of marked) {
      expect(r.marker).toEqual({ kind: "in", text: "in range*" });
      expect(r.spoken).toContain("in target range (may be incomplete)");
    }
  });

  it("overview: the hero, Month to date, Last 7 days and the trend are starred", () => {
    const month = { monthStartMs: nov, isCurrent: true, days: [{ dayStartMs: day, totals: t(full) }], sessions: [], projects: [], tools: [], totals: t(full) } as unknown as Snapshot["month"];
    const history = [{ monthStartMs: nov, totals: t(full) }] as Snapshot["history"];
    const s = snap(full, { health: copilotUnreadable, today: t(full), last7: t(full), month, history });
    const html = renderOverview(s, view);
    const subs = [...html.matchAll(/<div class="sub">([\s\S]*?)<\/div>/g)].map((x) => x[1]!);
    for (const what of ["Daily target", "Target up to", "Weekly target"]) {
      const sub = subs.find((x) => x.includes(what))!;
      expect(sub).toMatch(/<span class="sr">[^<]*In range \(may be incomplete\)/);
    }
    expect(trend(s, view)).toContain("in target range*");
    expect(trend({ ...s, health: claudeUnreadable }, view)).not.toContain("in target range*");
  });
});
