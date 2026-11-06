// Shapes shared by the core modules. A UsageRecord holds only allowlisted
// numbers and ids from a `session.usage_record` event; nothing else is kept.

export interface Tokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface UsageRecord {
  key: string;
  keySource: "usageId" | "eventId";
  /** accounting.sourceSessionId ?? folderId */
  sessionId: string;
  folderId: string;
  timestampMs: number;
  sequence?: number;
  model?: string;
  tokens: Tokens;
  durationMs?: number;
  nanoAiu?: number;
  /** tool name → times the model invoked it in this call (D25); absent if none */
  tools?: Record<string, number>;
}

export type UnrecognizedReason =
  | "no-usage-object"
  | "no-key"
  | "bad-timestamp"
  | "no-known-token-field"
  | "suspect-line";

export type ParseResult =
  | { kind: "usage"; record: UsageRecord }
  /** valid JSON, but type is not session.usage_record */
  | { kind: "ignored" }
  | { kind: "unrecognized"; reason: UnrecognizedReason }
  /** not JSON, or not an object */
  | { kind: "malformed" };

/** One numeric field aggregated over records. `sum` is meaningful only when
 * `reported > 0`; `missing` counts records that did not report the field. */
export interface Metric {
  sum: number;
  reported: number;
  missing: number;
}

export interface Counts {
  records: number;
  input: Metric;
  output: Metric;
  cacheRead: Metric;
  cacheWrite: Metric;
  reasoning: Metric;
  durationMs: Metric;
  nanoAiu: Metric;
}

/** byModel keys are the model id, or "(unknown model)" when none was reported. */
export interface Totals extends Counts {
  byModel: Record<string, Counts>;
}

export type HealthState = "ok" | "no-data" | "no-dir" | "permission" | "format-changed";

export interface Health {
  state: HealthState;
  rootSource: "setting" | "env" | "default";
  /** unreadableFiles + malformed + overlong > 0 */
  partial: boolean;
  unrecognized: number;
  malformed: number;
  /** over-long lines that may have been usage records; feeds `partial` */
  overlong: number;
  /** over-long lines whose type shows they are not usage; informational only */
  overlongOther: number;
  unreadableFiles: number;
  sessionsWithoutUsage: number;
}

export interface Snapshot {
  generatedAtMs: number;
  dayStartMs: number;
  /** undefined iff no record is dated today */
  today?: Totals;
  current?: { folderId: string; live: boolean; pinned: boolean; totals?: Totals };
  sessions: { folderId: string; lastMs?: number; live: boolean }[];
  health: Health;
  /** the viewed month (D10; D20): this month by default, or a selected past month */
  month?: MonthView;
  /** one entry per month in the history window, oldest first, ending with this month (D21) */
  history?: MonthSummary[];
  /** active filter, if any (D26) */
  filter?: Filter;
}

/** Narrows the month view, trend and tables (D26); Today and the status bar ignore it. */
export interface Filter {
  project?: string;
  tool?: string;
}

/** One project's records in the viewed month. */
export interface GroupSummary {
  /** grouping and filter key: the project label (repository or folder name) */
  name: string;
  /** display-only: the session title when the folder is named by an ID; show it instead of `name` */
  label?: string;
  sessions: number;
  calls: number;
  tokens: Metric;
  nanoAiu: Metric;
}

/** One tool in the viewed month: how often the model invoked it, and the model
 * calls that did. A call that used two tools counts toward both (D26). */
export interface ToolSummary {
  name: string;
  builtIn: boolean;
  uses: number;
  calls: number;
  tokens: Metric;
  nanoAiu: Metric;
}

/** One calendar month of the history window; totals undefined = no record. */
export interface MonthSummary {
  monthStartMs: number;
  totals?: Totals;
}

/** One session's records inside the viewed month (D24). */
export interface SessionSummary {
  sessionId: string;
  firstMs: number;
  lastMs: number;
  calls: number;
  /** model with the most calls; undefined if none reported */
  topModel?: string;
  tokens: Metric;
  nanoAiu: Metric;
  /** mean nanoAiu of the last 5 calls ÷ mean of the first 5, by time; needs ≥ 10 calls with AIU */
  growth?: number;
}

/** One local day of the month window; totals undefined = no record that day. */
export interface DayTotals {
  dayStartMs: number;
  totals?: Totals;
}

export interface MonthView {
  monthStartMs: number;
  /** true when the viewed month is the current one */
  isCurrent: boolean;
  /** day 1 .. today for this month; every day for a past month */
  days: DayTotals[];
  /** costliest sessions first (by AIU, then tokens), at most 10 */
  sessions: SessionSummary[];
  /** per project, costliest first; ignores the project filter, honours the tool filter (D26) */
  projects: GroupSummary[];
  /** per tool, costliest first; ignores the tool filter, honours the project filter (D26) */
  tools: ToolSummary[];
  /** undefined iff no record this month */
  totals?: Totals;
}

/** How figures are shown (D22, D23); from settings, never from the logs. */
export interface ViewOptions {
  unit: "tokens" | "cost";
  /** self-set monthly target in USD; either bound may be absent */
  range?: { min?: number; max?: number };
}

export type RangeState = "none" | "under" | "in" | "over";
