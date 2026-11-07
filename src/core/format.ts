// User-facing wording. Every figure here is a local observation from Copilot
// session logs, never an account statement: "—" means nothing was reported,
// "*" means some contributing records did not report the field.

import { addMetrics, localDaysBefore } from "./store";
import type { Currency, Counts, Health, LastPrompt, Metric, RangeState, Snapshot, Totals, ViewOptions } from "./types";

export const LOCAL_BANNER =
  "Locally observed from Copilot session logs on this computer. Not your GitHub bill, not your remaining allowance, and not usage from other devices or Copilot features that don't write these logs.";

export const STREAMING_NOTE =
  "Updates when Copilot finishes each model call, not token by token.";

export const COST_NOTE =
  "Cost is an estimate: Copilot's own logged AI credits × $0.01, GitHub's published rate. It matches GitHub's per-model token prices, but it is not an invoice.";

/** Hover text for the "session total" marker (O3, verbatim). */
export const SESSION_TOTAL_NOTE =
  "Session total: Copilot before 1.0.99 writes one total when a session ends instead of a record per model call. The whole session is counted on the day it ended. Per-call figures, growth and tool use are not available for it.";

/** Short form of SESSION_TOTAL_NOTE for tooltips (O3). */
export const SESSION_TOTAL_SHORT = "Session total: counted once, on the day the session ended (older Copilot).";

export const DEFAULT_VIEW: ViewOptions = { unit: "tokens" };

export const NOT_COVERED: string[] = [
  "Only Copilot clients that write session-state/*/events.jsonl (the Copilot CLI and coding agent, including agent sessions started from VS Code) are counted. Inline completions, Copilot Chat surfaces without these logs, github.com, mobile, JetBrains and other computers are not.",
  "Sessions from Copilot before 1.0.99 have no per-call records; they are counted from the session total Copilot writes when the session ends (one figure per model, dated at that moment, no estimated amount), unless copilotUsageMonitor.sessionTotals is off. A session that is still open or that crashed adds nothing until it ends.",
  '"Today" starts at local midnight on this computer; GitHub\'s own day may follow UTC.',
];

const DASH = "—";

export function formatCount(m: Metric): string {
  if (m.reported === 0) return DASH;
  const n = m.sum;
  let s: string;
  if (n < 1000) {
    s = String(n);
  } else {
    const k = (n / 1e3).toFixed(1);
    s = Number(k) >= 1000 ? (n / 1e6).toFixed(1) + "M" : k + "K";
  }
  return m.missing > 0 ? s + "*" : s;
}

export function formatAiu(m: Metric): string {
  if (m.reported === 0) return DASH;
  const s = (m.sum / 1e9).toFixed(2);
  return m.missing > 0 ? s + "*" : s;
}

/** Estimated USD from logged nanoAiu (1 AIU = 1 AI credit = $0.01). */
export function usd(m: Metric): number | undefined {
  return m.reported === 0 ? undefined : m.sum / 1e11;
}

/** Display currency for every cost figure; undefined = USD. Set by the extension
 * (setDisplayCurrency) from the chosen currency and its daily rate. */
let displayCurrency: Currency | undefined;

export function setDisplayCurrency(c: Currency | undefined): void {
  displayCurrency = c && c.code !== "USD" ? c : undefined;
}

/** "USD", "CAD", … — the code estimated cost is shown in. */
export function currencyCode(): string {
  return displayCurrency?.code ?? "USD";
}

/** "USD (est.)", "CAD (est.)". */
export function costLabel(): string {
  return `${currencyCode()} (est.)`;
}

/** "estimated USD", "estimated CAD". */
export function estWord(): string {
  return `estimated ${currencyCode()}`;
}

/** The cost note plus, when converting, the rate used (or why it is not converted yet). */
export function costNotes(view: ViewOptions): string[] {
  const out = [COST_NOTE];
  const c = view.currency;
  if (c) out.push(`Shown in ${c.code} at 1 USD = ${c.rate} ${c.code}, the European Central Bank reference rate of ${c.date} (via frankfurter.dev). Targets are in ${c.code}.`);
  else if (view.currencyPending) out.push(`No ${view.currencyPending} exchange rate yet, so cost is shown in USD and targets are not compared until it arrives.`);
  return out;
}

/** "$12.34", "$0.032", "$123" (or "CA$17.36" in CAD); "—" when unreported, "*" when partial. */
export function formatUsd(m: Metric, cur: Currency | undefined = displayCurrency): string {
  const v = usd(m);
  if (v === undefined) return DASH;
  return m.missing > 0 ? money(v, cur) + "*" : money(v, cur);
}

/** Formats a USD amount, converted to the display currency (or `cur`). */
export function money(v: number, cur: Currency | undefined = displayCurrency): string {
  if (!cur || cur.code === "USD") {
    if (v >= 100) return "$" + Math.round(v).toLocaleString("en-US");
    if (v >= 1 || v === 0) return "$" + v.toFixed(2);
    return "$" + v.toFixed(3);
  }
  const x = v * cur.rate;
  const digits = x >= 100 ? 0 : x >= 1 || x === 0 ? 2 : 3;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur.code, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x);
  } catch {
    return `${x.toFixed(digits)} ${cur.code}`;
  }
}

/** Usable range bounds: finite, non-negative, min ≤ max; anything else is dropped. */
export function cleanRange(min: unknown, max: unknown): ViewOptions["range"] {
  const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
  const lo = ok(min) ? min : undefined;
  let hi = ok(max) ? max : undefined;
  if (lo !== undefined && hi !== undefined && hi < lo) hi = undefined;
  if (lo === undefined && hi === undefined) return undefined;
  return { ...(lo !== undefined && { min: lo }), ...(hi !== undefined && { max: hi }) };
}

/** Where spend so far sits against the range; no month data counts as $0. */
export function rangeState(spent: number | undefined, range: ViewOptions["range"]): RangeState {
  if (!range) return "none";
  const v = spent ?? 0;
  if (range.max !== undefined && v > range.max) return "over";
  if (range.min !== undefined && v < range.min) return "under";
  return "in";
}

export function formatRange(range: ViewOptions["range"], cur: Currency | undefined = displayCurrency): string {
  if (!range) return DASH;
  if (range.min !== undefined && range.max !== undefined) return `${money(range.min, cur)}–${money(range.max, cur)}`;
  if (range.min !== undefined) return `at least ${money(range.min, cur)}`;
  return `up to ${money(range.max!, cur)}`;
}

export const RANGE_LABEL: Record<RangeState, string> = {
  none: "no target set",
  under: "under target",
  in: "in target range",
  over: "over target",
};

const RANGE_ICON_ID: Record<RangeState, string> = {
  none: "pulse",
  under: "arrow-down",
  in: "pass",
  over: "flame",
};

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The current calendar month's totals, never filtered and never a selected past
 * month (D31): `thisMonth`. Snapshots built without it (older tests) fall back to
 * the newest history month, which the monitor filters, so the monitor always sets it.
 */
export function thisMonthTotals(s: Snapshot): Totals | undefined {
  if ("thisMonth" in s) return s.thisMonth;
  return s.history?.at(-1)?.totals ?? (s.month?.isCurrent ? s.month.totals : undefined);
}

/** Range state of the current month in `s` (unfiltered; never a selected past month). */
export function currentRangeState(s: Snapshot, view: ViewOptions): RangeState {
  const t = thisMonthTotals(s);
  return rangeState(t ? usd(t.nanoAiu) : undefined, view.range);
}

/** Codicon id for a range state; the status bar and the side bar share it (D31). */
export function rangeIconId(state: RangeState): string {
  return RANGE_ICON_ID[state];
}

export function partialNote(m: Metric): string | undefined {
  if (m.missing === 0) return undefined;
  return `reported by ${m.reported} of ${m.reported + m.missing} records`;
}

function star(s: string): string {
  return s === DASH || s.endsWith("*") ? s : s + "*";
}

/** The parts of the status bar text for a snapshot with data; the side bar reuses them (D31). */
export interface StatusParts {
  /** codicon id: the range state, or "warning" when the log format changed */
  icon: string;
  /** "today" in tokens; the month's short name in USD or with statusBar "month"; "session" */
  place: string;
  /** "1.5M* tok", "—", "$12.40*" */
  figure: string;
  /** " / $20.00–$60.00" in USD with a range set, else "" */
  suffix: string;
  state: RangeState;
}

export function statusParts(s: Snapshot, view: ViewOptions = DEFAULT_VIEW): StatusParts {
  // The icon is chosen independently, so a format change that stops every
  // record from parsing (no `today`) still shows the warning.
  const state = currentRangeState(s, view);
  const icon = s.health.state === "format-changed" ? "warning" : RANGE_ICON_ID[state];
  const mode = view.statusBar ?? "today";
  const monthAbbr = MONTH_ABBR[new Date(s.dayStartMs).getMonth()]!;
  // v0.6 (2.5): the period follows copilotUsageMonitor.statusBar; "today" keeps the earlier text.
  const c: Counts | undefined = mode === "session" ? s.current?.totals : mode === "month" || view.unit === "cost" ? thisMonthTotals(s) : s.today;
  const place = mode === "session" ? "session" : mode === "month" || view.unit === "cost" ? monthAbbr : "today";
  // The target is monthly, so only a month figure carries it.
  const suffix = view.unit === "cost" && place === monthAbbr && state !== "none" ? ` / ${formatRange(view.range)}` : "";
  if (view.unit === "cost") {
    // The current month is unfiltered (D31): a project or tool filter never reaches the status bar.
    let n = c ? formatUsd(c.nanoAiu) : DASH;
    if (s.health.partial) n = star(n);
    return { icon, place, figure: n, suffix, state };
  }
  if (!c) return { icon, place, figure: DASH, suffix: "", state };
  let n = formatCount(addMetrics(c.input, c.output));
  if (s.health.partial) n = star(n);
  return { icon, place, figure: `${n} tok`, suffix: "", state };
}

export function statusText(s: Snapshot | undefined, view: ViewOptions = DEFAULT_VIEW): string {
  if (!s) return "$(sync~spin) Copilot usage: loading";
  if (s.health.state === "no-dir")
    return "$(circle-slash) Copilot logs not found";
  if (s.health.state === "permission") return "$(lock) Copilot logs unreadable";
  const p = statusParts(s, view);
  return `$(${p.icon}) Local ${p.place}: ${p.figure}${p.suffix}`;
}

/**
 * Words for a screen reader (D33): "1.5M* tok" → "1.5 million tokens (may be
 * incomplete)", "—" → "not reported", "$12.40" → "12.40 US dollars". No icon syntax.
 */
export function spoken(text: string): string {
  return text
    .replace(/\$\(([a-z-]+)(~[a-z]+)?\)\s*/g, "")
    .replace(/—/g, "not reported")
    .replace(/([\dMK])\*/g, "$1 (may be incomplete)")
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, "$1 US dollars")
    .replace(/(\d(?:\.\d)?)M\b/g, "$1 million")
    .replace(/(\d(?:\.\d)?)K\b/g, "$1 thousand")
    .replace(/\btok\b/g, "tokens")
    .replace(/\best\./g, "estimated")
    .replace(/–/g, " to ")
    .replace(/▲/g, "up")
    .replace(/▼/g, "down")
    .replace(/×/g, " times")
    .replace(/<(?=\d)/g, "less than ")
    .replace(/ · /g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The status bar item's spoken label (D33); same figures as statusText, in words. */
export function statusAccessibilityLabel(s: Snapshot | undefined, view: ViewOptions = DEFAULT_VIEW): string {
  if (!s) return "Copilot usage: loading";
  if (s.health.state === "no-dir") return "Copilot logs not found. Opens details.";
  if (s.health.state === "permission") return "Copilot logs unreadable. Opens details.";
  const p = statusParts(s, view);
  const mode = view.statusBar ?? "today";
  const period = mode === "session" ? "current session" : mode === "month" || view.unit === "cost" ? "this month" : "today";
  const place = view.unit === "cost" ? `${period}, estimated` : period;
  const parts = [`Copilot usage, local ${place}: ${spoken(p.figure)}`];
  if (p.state !== "none") parts.push(`${RANGE_LABEL[p.state]} ${spoken(formatRange(view.range))}`);
  if (s.health.state === "format-changed") parts.push("the log format may have changed");
  return parts.join(", ") + ". Opens details.";
}

/** Backslash-escapes every ASCII punctuation character (all are escapable in
 * CommonMark), so a log-derived string cannot form a link, autolink, HTML or
 * emphasis — `:` and `/` included, which GFM would otherwise autolink. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, (c) => "\\" + c);
}

function tok(m: Metric): string {
  return escapeMarkdown(formatCount(m)) + " tok";
}

function fieldLine(label: string, m: Metric): string {
  const note = partialNote(m);
  return `${label}: ${tok(m)}` + (note ? ` (\\* ${note})` : "");
}

function countsLines(c: Counts): string[] {
  return [fieldLine("Input", c.input), fieldLine("Output", c.output)];
}

function healthLines(h: Health): string[] {
  const out: string[] = [];
  if (h.state === "no-dir") {
    out.push(
      "No Copilot session logs were found. Set `copilotUsageMonitor.copilotHome` if Copilot keeps them elsewhere.",
    );
  } else if (h.state === "permission") {
    out.push(
      "The Copilot session log folder could not be read on this computer.",
    );
  } else if (h.state === "format-changed") {
    out.push(
      `Data health: ${h.unrecognized} line(s) in a format this version doesn't recognize. Copilot may have changed its log format, so figures may be incomplete.`,
    );
  } else if (h.state === "no-data") {
    out.push("No per-call records dated today yet.");
  }
  if (h.partial) {
    const reasons = ["Figures marked \\* may be incomplete:"];
    if (h.unreadableFiles > 0)
      reasons.push(`- ${h.unreadableFiles} log file(s) could not be read.`);
    if (h.malformed > 0)
      reasons.push(`- ${h.malformed} malformed line(s) were skipped.`);
    if (h.overlong > 0)
      reasons.push(`- ${h.overlong} over-long line(s) that may contain usage were skipped.`);
    if (h.shutdownOversize > 0)
      reasons.push(`- ${h.shutdownOversize} session-end line(s) too long to read were skipped.`);
    out.push(reasons.join("\n"));
  }
  if (h.overlongOther > 0) {
    out.push(
      `Data health: ${h.overlongOther} over-long line(s) that are not usage were skipped; totals are unaffected.`,
    );
  }
  if (h.sessionsFromTotals > 0) {
    out.push(`${h.sessionsFromTotals} session(s) counted from session totals. ${SESSION_TOTAL_SHORT}`);
  }
  if (h.sessionsWithoutUsage > 0) {
    out.push(`${h.sessionsWithoutUsage} session(s) without usage data are not in the totals.`);
  }
  return out;
}

/** "Last prompt: $0.042 est., 1 call + 3 agent calls" (cost view or a target set), else in tokens (v0.6). */
export function lastPromptLine(lp: LastPrompt | undefined, view: ViewOptions = DEFAULT_VIEW): string | undefined {
  if (!lp) return undefined;
  const cost = view.unit === "cost" || view.range !== undefined;
  const figure = cost
    ? lp.nanoAiu === undefined ? DASH : `${money(lp.nanoAiu / 1e11)} est.`
    : lp.tokens === undefined ? DASH : `${formatCount({ sum: lp.tokens, reported: 1, missing: 0 })} tok`;
  return `Last prompt: ${escapeMarkdown(figure)}, 1 call + ${lp.agentCalls} agent call${lp.agentCalls === 1 ? "" : "s"}`;
}

export function tooltipMarkdown(s: Snapshot | undefined, view: ViewOptions = DEFAULT_VIEW): string {
  const parts: string[] = [LOCAL_BANNER, STREAMING_NOTE];
  if (!s) {
    parts.push("Reading Copilot session logs…");
    return parts.join("\n\n");
  }

  if (s.today) {
    const incl = s.today.sessionTotals > 0 ? ` (incl. ${s.today.sessionTotals} session total${s.today.sessionTotals === 1 ? "" : "s"})` : "";
    parts.push([`**Local today**${incl}`, ...countsLines(s.today)].join("  \n"));
  } else if (s.health.state !== "no-dir" && s.health.state !== "permission") {
    parts.push(`**Local today**: ${DASH}`);
  }

  const cur = s.current;
  if (cur) {
    const tags = [
      cur.live ? undefined : "ended",
      cur.pinned ? "pinned" : undefined,
    ].filter(Boolean);
    const label =
      "Current session" + (tags.length ? ` (${tags.join(", ")})` : "");
    if (cur.totals) {
      const both = addMetrics(cur.totals.input, cur.totals.output);
      parts.push(`${label}: ${tok(both)}`);
    } else {
      parts.push(`${label}: ${DASH}`);
    }
    const lp = lastPromptLine(cur.lastPrompt, view);
    if (lp) parts.push(lp);
  }

  if (s.today) {
    const models = Object.keys(s.today.byModel).sort();
    if (models.length > 0) {
      const lines = models.map((model) => {
        const c = s.today!.byModel[model]!;
        return `- ${escapeMarkdown(model)}: ${tok(addMetrics(c.input, c.output))}`;
      });
      parts.push(["**By model today**", ...lines].join("\n"));
    }
  }

  const thisMonth = thisMonthTotals(s);
  if (view.statusBar === "month" && view.unit === "tokens" && !view.range) {
    // The status bar shows this month's tokens (2.5): say the same figure here.
    parts.push(`**This month**: ${thisMonth ? tok(addMetrics(thisMonth.input, thisMonth.output)) : DASH}`);
  }
  if (view.unit === "cost" || view.range) {
    const spent = thisMonth ? formatUsd(thisMonth.nanoAiu) : DASH;
    const lines = [`**This month (estimated)**: ${escapeMarkdown(spent)}`];
    if (view.range) {
      const state = currentRangeState(s, view);
      lines.push(`Target ${escapeMarkdown(formatRange(view.range))}: ${RANGE_LABEL[state]}`);
    }
    parts.push(lines.join("  \n"), ...costNotes(view).map(escapeMarkdown));
  }

  parts.push(...healthLines(s.health));
  return parts.join("\n\n");
}

/**
 * The last 7 days against the 7 before, as ▲/▼ and a multiplier (D32; the copy
 * gate bans the percent sign). Undefined when neither week has a figure. An
 * arrow appears only when both weeks have a figure; when one has none the text
 * is neutral. `priorRead` false (the 7 days before start before the history
 * window, see weekCoverage) gives no comparison at all.
 */
export function weekChange(cur: number | undefined, prior: number | undefined, priorRead = true): string | undefined {
  const c = cur ?? 0;
  const p = prior ?? 0;
  if (!priorRead) return c > 0 ? "no comparison" : undefined;
  if (c <= 0 && p <= 0) return undefined;
  if (p <= 0) return "nothing logged in the 7 days before";
  if (c <= 0) return "nothing logged yet";
  const r = c / p;
  const x = r >= 10 ? String(Math.round(r)) : r.toFixed(1);
  if (x === "1.0") return "about the same as the 7 days before";
  return `${r > 1 ? "▲" : "▼"} ${x}× the 7 days before`;
}

/** Which of the two weeks behind weekChange start before the history window (the first
 * month read, `copilotUsageMonitor.historyMonths`), so they hold fewer than 7 days of logs. */
export function weekCoverage(s: Pick<Snapshot, "dayStartMs" | "history">): { last7Short: boolean; prior7Short: boolean } {
  const windowStart = s.history?.[0]?.monthStartMs;
  if (windowStart === undefined) return { last7Short: false, prior7Short: false };
  const day = new Date(s.dayStartMs);
  return { last7Short: windowStart > localDaysBefore(day, 6), prior7Short: windowStart > localDaysBefore(day, 13) };
}

export const WEEK_SHORT_NOTE =
  "Logs are read from the 1st of the month only (copilotUsageMonitor.historyMonths), so this covers fewer than 7 days.";
export const PRIOR_SHORT_NOTE =
  "No comparison: the 7 days before start before the first month of logs read (copilotUsageMonitor.historyMonths).";

/** Model time as "18m 22s" / "42s" / "1h 03m"; "—" when unreported, "*" when partial. */
export function formatDuration(m: Metric): string {
  if (m.reported === 0) return DASH;
  const total = Math.round(m.sum / 1000);
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = h > 0 ? `${h}h ${pad(min)}m` : min > 0 ? `${min}m ${pad(sec)}s` : `${sec}s`;
  return m.missing > 0 ? s + "*" : s;
}
