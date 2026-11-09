// The status bar stars its figure when health.partial, and the tooltip ends with the
// legend "Figures marked \* may be incomplete": its own figures carry the star too
// (review UI-3). Its daily and weekly target lines say "(Copilot only)" with mixed
// sources, as the month line and the panel do (review UI-4).
import { describe, expect, it } from "vitest";
import { statusText, tooltipMarkdown } from "../../src/core/format";
import type { Counts, Health, Metric, Snapshot, Totals, ViewOptions } from "../../src/core/types";

const m = (sum: number, reported: number, missing = 0): Metric => ({ sum, reported, missing });
const counts = (o: Partial<Counts> = {}): Counts => ({
  records: 2, calls: 2, sessionTotals: 0, input: m(1_200_000, 2), output: m(300_000, 2), cacheRead: m(500, 2), cacheWrite: m(50, 2),
  reasoning: m(30, 2), durationMs: m(83_000, 2), nanoAiu: m(4e9, 2), callsMissing: 0, callNanoAiu: o.nanoAiu ?? m(4e9, 2), ...o,
});
const totals = (byModel: Record<string, Counts> = { "model-a": counts() }, o: Partial<Counts> = {}): Totals => ({ ...counts(o), byModel });
const health = (o: Partial<Health> = {}): Health => ({
  state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0,
  unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0, ...o,
});
const DAY0 = new Date(2026, 10, 5).getTime();
const snap = (o: Partial<Snapshot> = {}): Snapshot => {
  const t = totals();
  return {
    generatedAtMs: DAY0 + 36e6, dayStartMs: DAY0, today: t, thisMonth: t,
    current: { folderId: "3f2a91c0-0000-4000-8000-000000000001", live: true, pinned: false, totals: t },
    sessions: [], health: health(), ...o,
  } as Snapshot;
};
const PARTIAL = health({ partial: true, unreadableFiles: 2 });

describe("tooltip figures carry the star when health.partial", () => {
  it("cost view: This month (estimated) is starred like the status bar", () => {
    const s = snap({ health: PARTIAL });
    const view: ViewOptions = { unit: "cost" };
    expect(statusText(s, view)).toContain("$0.040*");
    const md = tooltipMarkdown(s, view);
    expect(md).toContain("Figures marked \\* may be incomplete");
    expect(md).toContain("**This month (estimated)**: \\$0\\.040\\*");
  });

  it("tokens view: Local today, by source, by model and current session are starred", () => {
    const cop = counts();
    const cc = counts();
    const today = { ...totals({ "model-a": cop }), sources: { copilot: 2, "claude-code": 2 }, bySource: { copilot: cop, "claude-code": cc } } as Totals;
    const s = snap({ today, health: PARTIAL });
    expect(statusText(s, { unit: "tokens" })).toContain("1.5M* tok");
    const md = tooltipMarkdown(s, { unit: "tokens" });
    expect(md).toContain("Input: 1\\.2M\\* tok");
    expect(md).toContain("Output: 300\\.0K\\* tok");
    expect(md).toContain("- Copilot: 1\\.5M\\* tok");
    expect(md).toContain("- model\\-a: 1\\.5M\\* tok");
    expect(md).toContain("Current session: 1\\.5M\\* tok");
  });

  it("session + cost mode: the current session's estimate is starred", () => {
    const md = tooltipMarkdown(snap({ health: PARTIAL }), { unit: "cost", statusBar: "session" });
    expect(md).toContain("Current session: 1\\.5M\\* tok · \\$0\\.040\\* est\\.");
  });

  it("month + tokens mode: This month is starred", () => {
    const md = tooltipMarkdown(snap({ health: PARTIAL }), { unit: "tokens", statusBar: "month" });
    expect(md).toContain("**This month**: 1\\.5M\\* tok");
  });

  it("a figure already starred for its own missing values is not starred twice", () => {
    const t = totals(undefined, { input: m(1_200_000, 2, 1) });
    const md = tooltipMarkdown(snap({ today: t, health: PARTIAL }), { unit: "tokens" });
    expect(md).toContain("Input: 1\\.2M\\* tok");
    expect(md).not.toContain("\\*\\*");
  });

  it("no star without health.partial", () => {
    const md = tooltipMarkdown(snap(), { unit: "cost", statusBar: "session" });
    expect(md).toContain("Input: 1\\.2M tok");
    expect(md).toContain("Current session: 1\\.5M tok · \\$0\\.040 est\\.");
    expect(md).toContain("**This month (estimated)**: \\$0\\.040");
    expect(md).not.toContain("\\$0\\.040\\*");
  });
});

describe("tooltip daily and weekly targets with mixed sources", () => {
  it("say (Copilot only), as the month target does", () => {
    const cop = counts();
    const cc = counts({ nanoAiu: m(2e10, 2) });
    const mixed = { ...totals({ a: cop, b: cc }), sources: { copilot: 2, "claude-code": 2 }, bySource: { copilot: cop, "claude-code": cc } } as Totals;
    const s = snap({ today: mixed, last7: mixed, thisMonth: mixed });
    const md = tooltipMarkdown(s, { unit: "cost", range: { max: 5 }, dayTarget: { max: 1 }, weekTarget: { max: 2 } });
    expect(md).toContain("Target up to \\$5\\.00 \\(Copilot only\\)");
    expect(md).toContain("Daily target up to \\$1\\.00 \\(Copilot only\\): ");
    expect(md).toContain("Weekly target up to \\$2\\.00 \\(Copilot only\\): ");
  });

  it("Copilot only: no tag", () => {
    const md = tooltipMarkdown(snap({ last7: totals() }), { unit: "cost", dayTarget: { max: 1 }, weekTarget: { max: 2 } });
    expect(md).toContain("Daily target up to \\$1\\.00: ");
    expect(md).toContain("Weekly target up to \\$2\\.00: ");
  });
});
