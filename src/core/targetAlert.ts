// The opt-in target-crossed alert (v0.6, owner-approved): decides when to say, once per
// calendar month per window session, that this month's estimated cost went above the
// monthly target max. Pure and in memory only; src/vscode/targetAlert.ts shows it.
import { currentRangeState, formatRange, formatUsd, targetMetric, thisMonthTotals } from "./format";
import type { Snapshot, ViewOptions } from "./types";

export class TargetAlertState {
  /** "YYYY-M" of the month already alerted in this window; never stored */
  private shown: string | undefined;

  /**
   * The message to show now, or undefined. Fires when `enabled`, a target max is set,
   * the display currency has a rate (no pending currency), and this month (unfiltered,
   * as on the status bar) is over the target, at most once per calendar month; also on
   * start-up when the month is already over.
   */
  next(s: Snapshot | undefined, view: ViewOptions, enabled: boolean): string | undefined {
    if (!enabled || !s || view.currencyPending || view.range?.max === undefined) return undefined;
    if (currentRangeState(s, view) !== "over") return undefined;
    const d = new Date(s.dayStartMs);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (this.shown === key) return undefined;
    this.shown = key;
    // The Copilot cost the target compared (currentRangeState), not the all-source month.
    const spent = formatUsd(targetMetric(thisMonthTotals(s)!)!);
    return `Copilot usage this month is over your target: ${spent} est. (target ${formatRange(view.range)}). Locally observed from Copilot session logs on this computer.`;
  }
}
