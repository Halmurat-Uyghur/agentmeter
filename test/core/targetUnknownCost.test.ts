// Review finding #3: unknown cost must never read as "in range". A target compares a
// TargetSpend that keeps apart no records ($0), known zero, partial cost (a lower bound,
// marked "*") and full cost; records with tokens but no logged cost are "unknown".
import { describe, expect, it } from "vitest";
import { rangeLabel, rangeState, rangeWord, statusAccessibilityLabel, statusParts, statusText, targetSpend, targetStatus, tooltipMarkdown } from "../../src/core/format";
import { trend } from "../../src/core/panel/overview";
import { buildSidebarModel, sidebarRows } from "../../src/core/sidebarModel";
import { TargetAlertState } from "../../src/core/targetAlert";
import type { Counts, Health, Metric, Snapshot, Totals, ViewOptions } from "../../src/core/types";

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
    expect(rangeLabel(unk)).toBe("cost not reported, target not compared");
    expect(rangeWord(unk)).toBe("Not compared");
  });
});

describe("every surface: unknown is not 'in range'", () => {
  it("status bar: no pass icon, a question mark instead", () => {
    const s = snap(UNKNOWN);
    expect(statusParts(s, COST).state).toBe("unknown");
    expect(statusText(s, COST)).toBe("$(question) Local Nov: — / up to $60.00");
    const said = statusAccessibilityLabel(s, COST);
    expect(said).toContain("cost not reported, target not compared");
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
    expect(md.match(/cost not reported\\, target not compared/g)).toHaveLength(3);
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
    expect(html).toContain("cost not reported, target not compared");
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
