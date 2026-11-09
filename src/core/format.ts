// User-facing wording. Every figure here is a local observation from Copilot
// session logs, never an account statement: "—" means nothing was reported,
// "*" means some contributing records did not report the field.

import { CURRENCIES } from "./currency";
import { addMetrics, localDaysBefore } from "./store";
import { PRICES_AS_OF } from "./pricing";
import { type Currency, type Counts, type Health, type LastPrompt, type Metric, type RangeState, type Snapshot, type Source, type SourceHealth, SOURCE_LABEL, SOURCES, type Totals, type ViewOptions } from "./types";

export const LOCAL_BANNER =
  "Locally observed from Copilot, Claude Code and Codex session logs on this computer. Not an account statement from any of them, not your remaining allowance, and not usage from other devices or features that don't write these logs.";

/** Added to the cost notes wherever a non-Copilot record is in scope (D46). */
/** Cost note when a Claude Code or Codex record is in scope (v0.10; was Copilot-only cost, D46). */
export const COST_SOURCES_NOTE = `USD (est.) for Claude Code and Codex is estimated from their tokens at the public API list price of each model (as of ${PRICES_AS_OF}); a subscription plan is charged differently, and a model with no list price shows —. Targets compare Copilot only.`;

/** Insights footer line when a non-Copilot record is in scope (D49). */
export const INSIGHTS_SOURCES_NOTE = "Insights use Copilot's logged AI credits; Claude Code and Codex calls are not examined.";

/** True when records of a source other than Copilot are counted in `sources` (D46, D49). */
export function mixedSources(sources: Partial<Record<Source, number>> | undefined): boolean {
  return !!sources && SOURCES.some((x) => x !== "copilot" && (sources[x] ?? 0) > 0);
}

/** The settings that name each source's folder and turn it on (D48). */
export const SOURCE_HOME_SETTING: Record<Source, string> = {
  copilot: "copilotUsageMonitor.copilotHome",
  "claude-code": "copilotUsageMonitor.claudeHome",
  codex: "copilotUsageMonitor.codexHome",
};
export const SOURCE_TOGGLE_SETTING: Record<Exclude<Source, "copilot">, string> = {
  "claude-code": "copilotUsageMonitor.claudeCode",
  codex: "copilotUsageMonitor.codex",
};

/** Sources whose reading is on, in SOURCES order; undefined when the snapshot has no per-source health. */
export function enabledSources(h: Health): Source[] | undefined {
  const per = h.sources;
  if (!per) return undefined;
  return SOURCES.filter((x) => per[x] !== undefined && per[x]!.state !== "off");
}

/** Enabled sources whose folder was found (state neither off nor no-dir), in SOURCES order;
 * [] without per-source health. */
export function foundSources(h: Health): Source[] {
  return (enabledSources(h) ?? []).filter((x) => h.sources![x]!.state !== "no-dir");
}

function orList(xs: string[], word = "or"): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${word} ${xs.at(-1)}`;
}

/** "copilotUsageMonitor.copilotHome, …claudeHome or …codexHome": the folder settings of the
 * enabled sources. Without per-source health: Copilot's alone, or every source's when `all`. */
export function homeSettings(h: Health, all = false): string {
  const list = enabledSources(h) ?? (all ? [...SOURCES] : ["copilot" as const]);
  const names = list.map((x) => SOURCE_HOME_SETTING[x]);
  if (names.length === 0) names.push(SOURCE_HOME_SETTING.copilot);
  return orList(names);
}

/** "Copilot CLI, Claude Code and Codex": the enabled sources by name (every source without per-source health). */
export function enabledSourceNames(h: Health): string {
  const list = enabledSources(h) ?? [...SOURCES];
  return orList((list.length ? list : ["copilot" as const]).map((x) => (x === "copilot" ? "Copilot CLI" : SOURCE_LABEL[x])), "and");
}

/** The permission state's first sentence, for every enabled source (D49). */
export const PERMISSION_NOTE = "The usage log folder of an enabled source could not be read on this computer.";

/** True when a source other than Copilot is enabled (per-source health present). */
export function multiSource(h: Health): boolean {
  return (enabledSources(h) ?? []).some((x) => x !== "copilot");
}

/** "Reading history (n of N files)…" while the first read of the window runs (D50). */
export function readingLine(h: Health): string | undefined {
  const r = h.reading;
  return r ? `Reading history (${r.done} of ${r.total} files)…` : undefined;
}

/** "idle" for a session whose liveness comes from file times (Claude Code, Codex), else "ended" (D43). */
export function notLiveWord(source: Source | undefined): string {
  return source !== undefined && source !== "copilot" ? "idle" : "ended";
}

export const STREAMING_NOTE = "Updates when a model call finishes, not token by token.";

/** Loading text everywhere (no snapshot yet, so no source is known). */
export const LOADING_NOTE = "Reading session logs…";

/** "Claude Code may have changed its log format": the sources whose state is format-changed
 * (per-source health), else Copilot as in 0.7. */
export function formatChangedSentence(h: Health): string {
  const per = h.sources;
  const names = per ? SOURCES.filter((x) => per[x]?.state === "format-changed").map((x) => SOURCE_LABEL[x]) : [];
  if (names.length <= 1) return `${names[0] ?? SOURCE_LABEL.copilot} may have changed its log format`;
  return `${orList(names, "and")} may have changed their log formats`;
}

export const COST_NOTE =
  "Cost is an estimate: Copilot's own logged AI credits × $0.01, GitHub's published rate. It matches GitHub's per-model token prices, but it is not an invoice.";

/** Hover text for the "session total" marker (O3, verbatim). */
export const SESSION_TOTAL_NOTE =
  "Session total: Copilot before 1.0.99 writes one total when a session ends instead of a record per model call. The whole session is counted on the day it ended. Per-call figures, growth and tool use are not available for it.";

/** Short form of SESSION_TOTAL_NOTE for tooltips (O3). */
export const SESSION_TOTAL_SHORT = "Session total: counted once, on the day the session ended (older Copilot).";

export const DEFAULT_VIEW: ViewOptions = { unit: "tokens" };

/** The coverage gap most users hit (v0.6, 2.6): always shown in Data health. */
export const CHAT_NOT_COVERED =
  "Not covered: Copilot Chat in VS Code (only Copilot CLI logs are read), so figures are a lower bound for Chat users.";

/** The side bar's one-line form of CHAT_NOT_COVERED. */
export const CHAT_NOT_COVERED_SHORT = "Copilot Chat in VS Code not counted";

export const NOT_COVERED: string[] = [
  "Of Copilot's clients, only those that write session-state/*/events.jsonl (the Copilot CLI and coding agent, including agent sessions started from VS Code) are counted; inline completions, Copilot Chat surfaces without these logs, github.com, mobile, JetBrains and other computers are not.",
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

/**
 * What a target compares (review finding #3): `usd` spent so far and whether it is
 * `partial` (some records in scope logged no cost, so it is a lower bound), or "unknown"
 * when records are in scope but none of them logged a cost. No record in scope is $0.
 * Copilot's logged cost only (v0.10): Claude Code and Codex cost is an estimate from list
 * prices, shown with the figures but never counted against a target.
 */
export type TargetSpend = { usd: number; partial: boolean } | "unknown";

/** The cost a target compares: Copilot's own when there is a per-source split, else the whole. */
export function targetMetric(t: Counts & { bySource?: Partial<Record<Source, Counts>> }): Metric | undefined {
  return t.bySource ? t.bySource.copilot?.nanoAiu : t.nanoAiu;
}

export function targetSpend(t: (Counts & { bySource?: Partial<Record<Source, Counts>> }) | undefined): TargetSpend {
  if (!t) return { usd: 0, partial: false };
  // Without a per-source split, mixed sources cannot be separated: the Copilot part is unknown.
  if (!t.bySource && mixedSources(t.sources)) return "unknown";
  const m = targetMetric(t);
  if (!m || (m.reported === 0 && m.missing === 0)) return { usd: 0, partial: false };
  if (m.reported === 0) return "unknown";
  return { usd: m.sum / 1e11, partial: m.missing > 0 };
}

/** A target's state and whether the spend it compared is a lower bound. */
export interface TargetStatus {
  state: RangeState;
  /** the spend is a lower bound and the state could still change ("under" or "in" only) */
  partial: boolean;
  /** "unknown" because Copilot's logs could not be read (a locked folder, or lines in a
   * format this version does not recognize) and no Copilot amount is known, not because the
   * records in scope logged none */
  unread?: true;
}

/** A source's read left records out: an unreadable log or folder, a listing that failed,
 * malformed or over-long lines, or files over the discovery cap. */
function sourceIncomplete(x: SourceHealth | undefined): boolean {
  return x !== undefined && (x.unreadableFiles + x.malformed + x.overlong + (x.capped ?? 0) > 0 || x.discoveryFailed === true);
}

/**
 * Whether Copilot's logs could not be read as they are now (Codex review of PR #22): its folder
 * is locked ("permission": nothing in it was read, with no unreadable-file count to show it) or
 * its lines are in a format this version does not recognize ("format-changed"). Whatever Copilot
 * amount these logs hold was not read: a missing amount is unknown, not $0, and a known one is a
 * lower bound. A missing folder ("no-dir") is Copilot not installed: $0 stays $0. Without a
 * per-source split (older snapshots) the whole read is Copilot's.
 */
export function copilotUnread(h: Health | undefined): boolean {
  if (!h) return false;
  const st = h.sources ? h.sources.copilot?.state : h.state;
  return st === "permission" || st === "format-changed";
}

/** Whether `t` holds any Copilot record with a usage figure (a cost or a missing one): the
 * part a target compares, split out like targetSpend does. */
function hasCopilotAmount(t: Parameters<typeof targetSpend>[0]): boolean {
  if (!t) return false;
  const m = t.bySource ? t.bySource.copilot?.nanoAiu : t.nanoAiu;
  return m !== undefined && m.reported + m.missing > 0;
}

/**
 * Whether Copilot's logs were read incompletely, so its logged cost (all a target compares)
 * may be a lower bound. Other sources' read failures do not count: targets are Copilot only.
 * Without a per-source split (older snapshots) the whole read is Copilot's. An unread
 * session.shutdown line has no per-source count; it is Copilot's (only Copilot writes it).
 */
export function copilotIncomplete(h: Health | undefined): boolean {
  if (!h) return false;
  const src = h.sources;
  if (copilotUnread(h)) return true;
  if (!src) return h.partial;
  if (sourceIncomplete(src.copilot)) return true;
  // What health.partial holds beyond the sources' own counts (an unread session.shutdown line).
  return h.partial && (h.shutdownOversize > 0 || !SOURCES.some((x) => x !== "copilot" && sourceIncomplete(src[x])));
}

/** The state of `t` against `range`, keeping unknown cost apart from $0 (review finding #3).
 * `health`: the snapshot's read; when Copilot's logs were read incompletely the spend is a
 * lower bound too, so "under" and "in" are starred like a record without a logged cost.
 * When Copilot's logs could not be read at all (copilotUnread) and no Copilot amount is in
 * scope, nothing was read to compare: the state is "unknown" ("Not compared"), never a
 * definite $0 "In range". A Copilot amount kept from an earlier good read is a lower bound. */
export function targetStatus(t: Parameters<typeof targetSpend>[0], range: ViewOptions["range"], health?: Health): TargetStatus {
  let spend = targetSpend(t);
  const unread = range !== undefined && typeof spend === "object" && copilotUnread(health) && !hasCopilotAmount(t);
  if (unread) spend = "unknown";
  const state = rangeState(spend, range);
  // Spend already above the max is over whatever is missing; below it, it is a lower bound.
  // "In" a min-only range stays in whatever is missing, so only a max makes "in" uncertain.
  const open = state === "under" || (state === "in" && range?.max !== undefined);
  const partial = typeof spend === "object" && (spend.partial || copilotIncomplete(health)) && open;
  return unread ? { state, partial, unread: true } : { state, partial };
}

/** RANGE_LABEL with "*" when the spend is a lower bound ("in target range*"). */
export function rangeLabel(st: TargetStatus): string {
  if (st.unread === true) return UNREAD_LABEL;
  return st.partial ? RANGE_LABEL[st.state] + "*" : RANGE_LABEL[st.state];
}

/** The short word for a target state in a figure's subtitle: "Under", "In range", "Over", "Not compared". */
export function rangeWord(st: TargetStatus): string {
  const w = RANGE_WORD[st.state];
  return st.partial ? w + "*" : w;
}

export const RANGE_WORD: Record<RangeState, string> = { none: "", under: "Under", in: "In range", over: "Over", unknown: "Not compared" };

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

/** The cost note plus, when converting, the rate used (or why it is not converted yet).
 * `mixed`: a non-Copilot record is in scope, so the note says how its USD is estimated (v0.10). */
export function costNotes(view: ViewOptions, mixed = false): string[] {
  const out = [COST_NOTE];
  if (mixed) out.push(COST_SOURCES_NOTE);
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

/** Decimals for a shown amount: 3 under 1, 2 under 100, 0 above; chosen after rounding,
 * so 0.9995 is "1.00", not "1.000", and 99.995 is "100", not "100.00". */
function moneyDigits(x: number): number {
  if (x === 0) return 2;
  let d = x >= 100 ? 0 : x >= 1 ? 2 : 3;
  if (d === 3 && +x.toFixed(3) >= 1) d = 2;
  if (d === 2 && +x.toFixed(2) >= 100) d = 0;
  return d;
}

/** Formats a USD amount, converted to the display currency (or `cur`); a non-zero
 * amount that rounds to 0 is "<$0.001" (spoken() reads "<" as "less than"). */
export function money(v: number, cur: Currency | undefined = displayCurrency): string {
  const usd = !cur || cur.code === "USD";
  const x = usd ? v : v * cur.rate;
  const tiny = x > 0 && +x.toFixed(3) === 0;
  const y = tiny ? 0.001 : x;
  const digits = moneyDigits(y);
  let s: string;
  if (usd) s = "$" + (digits === 0 ? Math.round(y).toLocaleString("en-US") : y.toFixed(digits));
  else {
    try {
      s = new Intl.NumberFormat("en-US", { style: "currency", currency: cur.code, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(y);
    } catch {
      s = `${y.toFixed(digits)} ${cur.code}`;
    }
  }
  return tiny ? "<" + s : s;
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

/** Where spend so far sits against the range; no month data counts as $0, but a
 * TargetSpend of "unknown" (records with no cost logged) is never compared (review finding #3). */
export function rangeState(spent: number | undefined | TargetSpend, range: ViewOptions["range"]): RangeState {
  if (!range) return "none";
  if (spent === "unknown") return "unknown";
  const v = typeof spent === "object" ? spent.usd : (spent ?? 0);
  // Compared as shown: spend that displays as the bound is not past it.
  if (range.max !== undefined && v > range.max && money(v) !== money(range.max)) return "over";
  if (range.min !== undefined && v < range.min && money(v) !== money(range.min)) return "under";
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
  // No "cost", "spend" or "credits": the tokens view's stricter copy gate applies here too.
  unknown: "amount not logged, target not compared",
};

/** rangeLabel of an "unknown" state whose Copilot logs could not be read (TargetStatus.unread). */
export const UNREAD_LABEL = "Copilot logs not read, target not compared";

const RANGE_ICON_ID: Record<RangeState, string> = {
  none: "pulse",
  under: "arrow-down",
  in: "pass",
  over: "flame",
  unknown: "question",
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
  return currentTargetStatus(s, view).state;
}

/** Target status of the current month in `s`, with whether its spend is a lower bound. */
export function currentTargetStatus(s: Snapshot, view: ViewOptions): TargetStatus {
  return targetStatus(thisMonthTotals(s), view.range, s.health);
}

/** Codicon id for a range state; the status bar and the side bar share it (D31). */
export function rangeIconId(state: RangeState): string {
  return RANGE_ICON_ID[state];
}

/** What made a read incomplete beyond its lines: source folders whose last listing failed
 * (SourceHealth.discoveryFailed, review finding N) and log files that could not be read
 * (`h.unreadableFiles`; a failed listing is not counted there, Codex review of PR #22). */
export function unreadableParts(h: Health): { logs: number; folders: number } {
  const folders = Object.values(h.sources ?? {}).filter((x) => x?.discoveryFailed === true).length;
  return { folders, logs: h.unreadableFiles };
}

/** "a log folder could not be listed; new sessions may be missing" (2 or more: "2 log folders"). */
export function folderListNote(folders: number): string {
  return `${folders === 1 ? "a log folder" : `${folders} log folders`} could not be listed; new sessions may be missing`;
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
  /** the month's spend is a lower bound, so `state` ("under" or "in") may still change */
  partial: boolean;
  /** see TargetStatus.unread */
  unread?: true;
}

export function statusParts(s: Snapshot, view: ViewOptions = DEFAULT_VIEW): StatusParts {
  // The icon is chosen independently, so a format change that stops every
  // record from parsing (no `today`) still shows the warning.
  const st = currentTargetStatus(s, view);
  const { state, partial } = st;
  const unread = st.unread === true ? { unread: true as const } : {};
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
    return { icon, place, figure: n, suffix, state, partial, ...unread };
  }
  if (!c) return { icon, place, figure: DASH, suffix: "", state, partial, ...unread };
  let n = formatCount(addMetrics(c.input, c.output));
  if (s.health.partial) n = star(n);
  return { icon, place, figure: `${n} tok`, suffix: "", state, partial, ...unread };
}

export function statusText(s: Snapshot | undefined, view: ViewOptions = DEFAULT_VIEW): string {
  if (!s) return "$(sync~spin) AgentMeter: loading";
  if (s.health.state === "no-dir")
    return "$(circle-slash) Local: no usage logs found";
  if (s.health.state === "permission") return "$(lock) Local: usage logs unreadable";
  const p = statusParts(s, view);
  return `$(${p.icon}) Local ${p.place}: ${p.figure}${p.suffix}`;
}

/** Intl symbol → ISO code for every offered currency ("CA$" → "CAD", "€" → "EUR"); USD keeps "$". */
const SYMBOL_CODE = new Map<string, string>();
let symbolRe: RegExp | undefined;

/** Matches a currency symbol and its amount; a bare "$" only when no letter precedes it. */
function currencyRe(): RegExp {
  if (!symbolRe) {
    for (const [code] of CURRENCIES) {
      if (code === "USD") continue;
      try {
        const sym = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).formatToParts(1).find((p) => p.type === "currency")?.value;
        if (sym && sym !== "$") SYMBOL_CODE.set(sym, code);
      } catch {
        // an unknown code keeps its own name in money()'s fallback
      }
    }
    const syms = [...SYMBOL_CODE.keys()].sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    symbolRe = new RegExp(`(?<![A-Za-z])(${[...syms, "\\$"].join("|")})\\s?(\\d[\\d,]*(?:\\.\\d+)?)`, "g");
  }
  symbolRe.lastIndex = 0;
  return symbolRe;
}

/**
 * Words for a screen reader (D33): "1.5M* tok" → "1.5 million tokens (may be
 * incomplete)", "—" → "not reported", "$12.40" → "12.40 US dollars", "CA$16.92" →
 * "16.92 CAD". No icon syntax.
 */
export function spoken(text: string): string {
  return text
    .replace(/\$\(([a-z-]+)(~[a-z]+)?\)\s*/g, "")
    .replace(/—/g, "not reported")
    .replace(/([\dMKa-z])\*/g, "$1 (may be incomplete)")
    .replace(currencyRe(), (_, sym: string, n: string) => `${n} ${sym === "$" ? "US dollars" : SYMBOL_CODE.get(sym)}`)
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
  if (!s) return "AgentMeter: loading";
  if (s.health.state === "no-dir") return "No usage logs found. Opens details.";
  if (s.health.state === "permission") return "Usage logs unreadable. Opens details.";
  const p = statusParts(s, view);
  const mode = view.statusBar ?? "today";
  const period = mode === "session" ? "current session" : mode === "month" || view.unit === "cost" ? "this month" : "today";
  const place = view.unit === "cost" ? `${period}, estimated` : period;
  const parts = [multiSource(s.health) ? `Local usage, ${place}: ${spoken(p.figure)}` : `Copilot usage, local ${place}: ${spoken(p.figure)}`];
  // The target is monthly: name the month when the figure is today or the session (review fix 5).
  if (p.state !== "none") {
    const month = period === "this month" ? "" : "this month ";
    const range = spoken(formatRange(view.range));
    // "amount not logged, target up to 60.00 US dollars not compared": the range belongs to the target.
    parts.push(p.state === "unknown" ? `${month}${p.unread === true ? "Copilot logs not read" : "amount not logged"}, target ${range} not compared` : `${month}${spoken(rangeLabel(p))} ${range}`);
  }
  if (s.health.state === "format-changed") parts.push("the log format may have changed");
  return parts.join(", ") + ". Opens details.";
}

/** Backslash-escapes every ASCII punctuation character (all are escapable in
 * CommonMark), so a log-derived string cannot form a link, autolink, HTML or
 * emphasis — `:` and `/` included, which GFM would otherwise autolink. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, (c) => "\\" + c);
}

/** `partial` (health.partial) stars the figure, as the status bar does. */
function tok(m: Metric, partial = false): string {
  const n = formatCount(m);
  return escapeMarkdown(partial ? star(n) : n) + " tok";
}

function fieldLine(label: string, m: Metric, partial: boolean): string {
  const note = partialNote(m);
  return `${label}: ${tok(m, partial)}` + (note ? ` (\\* ${note})` : "");
}

function countsLines(c: Counts, partial: boolean): string[] {
  return [fieldLine("Input", c.input, partial), fieldLine("Output", c.output, partial)];
}

function healthLines(h: Health): string[] {
  const out: string[] = [];
  if (h.state === "no-dir") {
    out.push(
      multiSource(h)
        ? `No usage logs were found. Set ${homeSettings(h).replace(/copilotUsageMonitor\.\w+/g, (x) => `\`${x}\``)} if a tool keeps its logs elsewhere.`
        : "No Copilot session logs were found. Set `copilotUsageMonitor.copilotHome` if Copilot keeps them elsewhere.",
    );
  } else if (h.state === "permission") {
    out.push(`${PERMISSION_NOTE} Check the folder's permissions, or set ${homeSettings(h, true).replace(/copilotUsageMonitor\.\w+/g, (x) => `\`${x}\``)}.`);
  } else if (h.state === "format-changed") {
    out.push(
      `Data health: ${h.unrecognized} line(s) in a format this version doesn't recognize. ${formatChangedSentence(h)}, so figures may be incomplete.`,
    );
  } else if (h.state === "no-data") {
    out.push("No per-call records dated today yet.");
  }
  if (h.partial) {
    const reasons = ["Figures marked \\* may be incomplete:"];
    const u = unreadableParts(h);
    if (u.folders > 0) {
      const n = folderListNote(u.folders);
      reasons.push(`- ${n.charAt(0).toUpperCase()}${n.slice(1)}.`);
    }
    if (u.logs > 0)
      reasons.push(`- ${u.logs} log file(s) could not be read.`);
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
    parts.push(LOADING_NOTE);
    return parts.join("\n\n");
  }

  // health.partial stars the tooltip's figures as it does the status bar's (the legend below).
  const pt = s.health.partial;
  if (s.today) {
    const incl = s.today.sessionTotals > 0 ? ` (incl. ${s.today.sessionTotals} session total${s.today.sessionTotals === 1 ? "" : "s"})` : "";
    parts.push([`**Local today**${incl}`, ...countsLines(s.today, pt)].join("  \n"));
    const t = s.today;
    const present = SOURCES.filter((x) => (t.sources?.[x] ?? 0) > 0);
    if (present.length >= 2) {
      const lines = present.map((x) => {
        const c = t.bySource?.[x];
        return `- ${SOURCE_LABEL[x]}: ${c ? tok(addMetrics(c.input, c.output), pt) : DASH}`;
      });
      parts.push(["**By source today**", ...lines].join("\n"));
    }
  } else if (s.health.state !== "no-dir" && s.health.state !== "permission") {
    parts.push(`**Local today**: ${DASH}`);
  }

  const cur = s.current;
  if (cur) {
    const tags = [
      cur.live ? undefined : notLiveWord(cur.source),
      cur.pinned ? "pinned" : undefined,
    ].filter(Boolean);
    const label =
      "Current session" + (tags.length ? ` (${tags.join(", ")})` : "");
    if (cur.totals) {
      const both = addMetrics(cur.totals.input, cur.totals.output);
      // In session mode with cost, the status bar shows the session's estimate: say it here too.
      const est = view.statusBar === "session" && view.unit === "cost" ? ` · ${escapeMarkdown(`${pt ? star(formatUsd(cur.totals.nanoAiu)) : formatUsd(cur.totals.nanoAiu)} est.`)}` : "";
      parts.push(`${label}: ${tok(both, pt)}${est}`);
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
        return `- ${escapeMarkdown(model)}: ${tok(addMetrics(c.input, c.output), pt)}`;
      });
      parts.push(["**By model today**", ...lines].join("\n"));
    }
  }

  const thisMonth = thisMonthTotals(s);
  if (view.statusBar === "month" && view.unit === "tokens") {
    // The status bar shows this month's tokens (2.5): say the same figure here.
    parts.push(`**This month**: ${thisMonth ? tok(addMetrics(thisMonth.input, thisMonth.output), pt) : DASH}`);
  }
  if (view.unit === "cost" || view.range || view.dayTarget || view.weekTarget) {
    const spent = thisMonth ? formatUsd(thisMonth.nanoAiu) : DASH;
    const lines = [`**This month (estimated)**: ${escapeMarkdown(pt ? star(spent) : spent)}`];
    const mixed = mixedSources(thisMonth?.sources);
    if (view.range) {
      const st = currentTargetStatus(s, view);
      lines.push(`Target ${escapeMarkdown(formatRange(view.range))}${mixed ? " \\(Copilot only\\)" : ""}: ${escapeMarkdown(rangeLabel(st))}`);
    }
    // The daily and weekly targets (v0.9) follow today and the last 7 days, never filtered.
    const only = " \\(Copilot only\\)";
    if (view.dayTarget) lines.push(`Daily target ${escapeMarkdown(formatRange(view.dayTarget))}${mixedSources(s.today?.sources) ? only : ""}: ${escapeMarkdown(rangeLabel(targetStatus(s.today, view.dayTarget, s.health)))}`);
    if (view.weekTarget) lines.push(`Weekly target ${escapeMarkdown(formatRange(view.weekTarget))}${mixedSources(s.last7?.sources) ? only : ""}: ${escapeMarkdown(rangeLabel(targetStatus(s.last7, view.weekTarget, s.health)))}`);
    parts.push(lines.join("  \n"), ...costNotes(view, mixed).map(escapeMarkdown));
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
  // Under 0.05 rounds to "0.0": say "<0.1" instead (spoken "less than 0.1").
  const x = r >= 10 ? String(Math.round(r)) : r < 0.05 ? "<0.1" : r.toFixed(1);
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

/** A change against an earlier period as an amount (v0.6, 2.1). */
export interface Change {
  /** "▲ $1.20", "▼ 340K*", "same", "new" (nothing logged then) or "—" */
  text: string;
  dir: "up" | "down" | "same" | "new" | "none";
  /** words for a screen reader */
  said: string;
}

/**
 * `cur` minus `prior` in the unit (tokens, or estimated cost in the display currency),
 * as ▲ or ▼ with the amount: never a percentage or a multiplier (the Last-7-days rules,
 * D32). `undefined` = nothing logged (a logged 0 is a real 0). No arrow when either side has nothing logged
 * ("new" / "—"), and "—" when either side logged records without a figure in the unit.
 * `*` when either side may be incomplete or `partial` is set.
 */
export function changeAmount(cur: Metric | undefined, prior: Metric | undefined, unit: ViewOptions["unit"], partial = false): Change {
  // A side with records whose figure is 0 is a real 0, not "nothing logged" (review fix 2).
  if (!cur) return { text: DASH, dir: "none", said: "nothing logged" };
  if (!prior) return { text: "new", dir: "new", said: "nothing logged then" };
  if (cur.reported === 0 || prior.reported === 0) return { text: DASH, dir: "none", said: "not reported" };
  const cost = unit === "cost";
  const d = cost ? (cur.sum - prior.sum) / 1e11 : cur.sum - prior.sum;
  const abs = Math.abs(d);
  // "same" at display precision: the threshold is in the display currency.
  if (cost ? abs * (displayCurrency?.rate ?? 1) < 0.0005 : Math.round(abs) === 0) return { text: "same", dir: "same", said: "about the same" };
  const amt = cost ? money(abs) : formatCount({ sum: Math.round(abs), reported: 1, missing: 0 });
  const starred = partial || cur.missing > 0 || prior.missing > 0;
  const dir = d > 0 ? "up" : "down";
  const said = `${dir} ${cost ? `${amt}, estimated` : `${spoken(amt)} tokens`}${starred ? " (may be incomplete)" : ""}`;
  return { text: `${d > 0 ? "▲" : "▼"} ${amt}${starred ? "*" : ""}`, dir, said };
}

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
