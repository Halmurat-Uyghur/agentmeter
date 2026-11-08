// Owner-approved v0.6 item: the opt-in target-crossed alert. At most once per calendar
// month per window session, in memory only; never without a usable target and rate.
import { afterEach, describe, expect, it } from "vitest";
import { setDisplayCurrency } from "../../src/core/format";
import { TargetAlertState } from "../../src/core/targetAlert";
import type { Counts, Health, Metric, Snapshot, Totals, ViewOptions } from "../../src/core/types";

const m = (sum: number, reported = 1, missing = 0): Metric => ({ sum, reported, missing });
const t = (usd: number): Totals => {
  const c: Counts = { records: 1, calls: 1, callsMissing: 0, sessionTotals: 0, input: m(10), output: m(1), cacheRead: m(0), cacheWrite: m(0), reasoning: m(0), durationMs: m(0), nanoAiu: m(usd * 1e11), callNanoAiu: m(usd * 1e11) };
  return { ...c, byModel: {} };
};
const health: Health = { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0 };
const snap = (usd: number | undefined, day = new Date(2026, 10, 6).getTime()): Snapshot => ({ generatedAtMs: day, dayStartMs: day, sessions: [], health, ...(usd !== undefined && { thisMonth: t(usd) }) });
const COST: ViewOptions = { unit: "cost", range: { min: 20, max: 60 } };
const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;

afterEach(() => setDisplayCurrency(undefined));

describe("target-crossed alert", () => {
  it("off: never fires", () => {
    const a = new TargetAlertState();
    expect(a.next(snap(80), COST, false)).toBeUndefined();
    expect(a.next(snap(90), COST, false)).toBeUndefined();
  });

  it("fires once when this month first goes above the target max, then not again that month", () => {
    const a = new TargetAlertState();
    expect(a.next(snap(40), COST, true)).toBeUndefined();
    expect(a.next(snap(59.99), COST, true)).toBeUndefined();
    const msg = a.next(snap(61.2), COST, true);
    expect(msg).toBe("Copilot usage this month is over your target: $61.20 est. (target $20.00–$60.00). Locally observed from Copilot session logs on this computer.");
    expect(msg).not.toMatch(COPY_RE);
    expect(a.next(snap(70), COST, true)).toBeUndefined();
    expect(a.next(snap(40), COST, true)).toBeUndefined();
    expect(a.next(snap(80), COST, true)).toBeUndefined();
  });

  it("fires on start-up when the month is already over, once; and again in a new month", () => {
    const a = new TargetAlertState();
    expect(a.next(snap(80), COST, true)).toBeDefined();
    expect(a.next(snap(80), COST, true)).toBeUndefined();
    expect(a.next(snap(80, new Date(2026, 11, 1).getTime()), COST, true)).toBeDefined();
    expect(a.next(snap(80, new Date(2026, 11, 2).getTime()), COST, true)).toBeUndefined();
  });

  it("works in the tokens view too: the target is in estimated cost", () => {
    expect(new TargetAlertState().next(snap(80), { unit: "tokens", range: { max: 60 } }, true)).toContain("$80.00 est. (target up to $60.00)");
  });

  it("no target max, no data, or no snapshot: nothing", () => {
    const a = new TargetAlertState();
    expect(a.next(snap(80), { unit: "cost" }, true)).toBeUndefined();
    expect(a.next(snap(80), { unit: "cost", range: { min: 100 } }, true)).toBeUndefined();
    expect(a.next(snap(undefined), COST, true)).toBeUndefined();
    expect(a.next(undefined, COST, true)).toBeUndefined();
    // nothing was recorded, so a later crossing still fires
    expect(a.next(snap(80), COST, true)).toBeDefined();
  });

  it("no fire without a rate for a non-USD currency; fires in that currency once it arrives", () => {
    const a = new TargetAlertState();
    // readView drops the range while the rate is pending; even if one slips through, nothing fires
    expect(a.next(snap(80), { unit: "cost", currencyPending: "CAD" }, true)).toBeUndefined();
    expect(a.next(snap(80), { unit: "cost", currencyPending: "CAD", range: { max: 60 } }, true)).toBeUndefined();
    const cad = { code: "CAD", rate: 1.5, date: "2026-11-06" };
    setDisplayCurrency(cad);
    expect(a.next(snap(50), { unit: "cost", currency: cad, range: { max: 40 } }, true)).toBe(
      "Copilot usage this month is over your target: CA$75.00 est. (target up to CA$60.00). Locally observed from Copilot session logs on this computer.",
    );
  });
});

describe("target-crossed alert at display precision", () => {
  it("no alert when the rounded spend equals the target max", () => {
    const view: ViewOptions = { unit: "cost", range: { min: 20, max: 150 } };
    const a = new TargetAlertState();
    expect(a.next(snap(150.4), view, true)).toBeUndefined();
    expect(a.next(snap(151), view, true)).toBe("Copilot usage this month is over your target: $151 est. (target $20.00–$150). Locally observed from Copilot session logs on this computer.");
  });
});
