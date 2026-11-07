// Shapes shared by the core modules. A UsageRecord holds only allowlisted
// numbers and ids from a `session.usage_record` event, or one model's running
// total from a `session.shutdown` event (D29); nothing else is kept.

export interface Tokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/** Who started a call (v0.6): "user" for a prompt, "agent" for a follow-up call the agent
 * made on its own. Any other logged value is "other"; the log's string is never kept. */
export type Initiator = "user" | "agent" | "other";
export const INITIATORS: readonly Initiator[] = ["user", "agent", "other"];

/** Why a call ended (v0.6). Values outside the known set are "other"; the log's string is never kept. */
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "other";
export const FINISH_REASONS: readonly FinishReason[] = ["stop", "tool_calls", "length", "content_filter", "other"];

/**
 * A call's logged AIU split by token type (v0.6), from copilotUsage.tokenDetails[]:
 * Σ tokenCount / batchSize × costPerBatch per type. Kept only when the parts add up to
 * totalNanoAiu, so the split is exact. `inputAtReadRate` prices the uncached input
 * tokens at this call's cache-read rate (absent unless one cache-read rate was logged).
 */
export interface TypeCost {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** token types outside the four known ones; absent when 0 */
  other?: number;
  inputAtReadRate?: number;
}

export interface UsageRecord {
  key: string;
  keySource: "usageId" | "eventId" | "shutdown";
  /** "call": one session.usage_record; "sessionTotal": one model's total from session.shutdown (D29) */
  kind: "call" | "sessionTotal";
  /** accounting.sourceSessionId ?? folderId (always folderId for a session total) */
  sessionId: string;
  folderId: string;
  /** a session total is dated at its shutdown line */
  timestampMs: number;
  /** sessionTotal only: data.sessionStartTime, when it is not after timestampMs */
  startedMs?: number;
  /** sessionTotal only: requests.count, the model calls the total stands for. A call record is always 1. */
  calls?: number;
  sequence?: number;
  model?: string;
  tokens: Tokens;
  durationMs?: number;
  nanoAiu?: number;
  /** tool name → times the model invoked it in this call (D25); absent if none */
  tools?: Record<string, number>;
  /** call only (v0.6): who started the call */
  initiator?: Initiator;
  /** call only (v0.6): why the call ended */
  finishReason?: FinishReason;
  /** call only (v0.6): toolTokenCount, the tokens of tool definitions sent with the prompt
   * (part of input, never on top of it) */
  toolTokens?: number;
  /** call only (v0.6): availableToolCount, the tools offered to the model */
  availableTools?: number;
  /** call only (v0.6): exact AIU per token type; absent when tokenDetails is missing or does not add up */
  typeCost?: TypeCost;
}

export type UnrecognizedReason =
  | "no-usage-object"
  | "no-key"
  | "bad-timestamp"
  | "no-known-token-field"
  | "suspect-line"
  | "no-model-metrics";

export type ParseResult =
  | { kind: "usage"; record: UsageRecord }
  /** valid JSON, but type is not session.usage_record */
  | { kind: "ignored" }
  | { kind: "unrecognized"; reason: UnrecognizedReason }
  /** not JSON, or not an object */
  | { kind: "malformed" };

export type ShutdownParseResult =
  /** one record per model, at least one */
  | { kind: "totals"; records: UsageRecord[] }
  /** modelMetrics is {}: a session that never called a model */
  | { kind: "empty" }
  /** valid JSON, but type is not session.shutdown */
  | { kind: "ignored" }
  | { kind: "unrecognized"; reason: "no-model-metrics" | "bad-timestamp" | "no-known-token-field" }
  | { kind: "malformed" };

/** One numeric field aggregated over records. `sum` is meaningful only when
 * `reported > 0`; `missing` counts records that did not report the field. */
export interface Metric {
  sum: number;
  reported: number;
  missing: number;
}

export interface Counts {
  /** rows aggregated (call records + session-total records) */
  records: number;
  /** model calls: 1 per call record plus requests.count of each session total (D29) */
  calls: number;
  /** session totals that did not log requests.count: `calls` is then a lower bound ("*"), or unknown ("—") when 0 */
  callsMissing: number;
  /** rows that are session totals; the UI marks figures that include any */
  sessionTotals: number;
  input: Metric;
  output: Metric;
  cacheRead: Metric;
  cacheWrite: Metric;
  reasoning: Metric;
  durationMs: Metric;
  nanoAiu: Metric;
  /** nanoAiu of call records only, for per-call figures (a session total is not a call) */
  callNanoAiu: Metric;
}

/** byModel keys are the model id, or "(unknown model)" when none was reported. */
export interface Totals extends Counts {
  byModel: Record<string, Counts>;
}

export type HealthState = "ok" | "no-data" | "no-dir" | "permission" | "format-changed";

export interface Health {
  state: HealthState;
  rootSource: "setting" | "env" | "default";
  /** unreadableFiles + malformed + overlong > 0, or an oversize session.shutdown line in a log
   * without per-call records (where that line was the only source of the session's figures) */
  partial: boolean;
  unrecognized: number;
  malformed: number;
  /** over-long lines that may have been usage records; feeds `partial` */
  overlong: number;
  /** over-long lines whose type shows they are not usage; informational only */
  overlongOther: number;
  unreadableFiles: number;
  /** sessions with activity but neither per-call records nor a session total */
  sessionsWithoutUsage: number;
  /** sessions whose figures come from a session total only (D29) */
  sessionsFromTotals: number;
  /** session.shutdown lines over MAX_SHUTDOWN_BYTES, not decoded; feeds `partial` only for a log
   * without per-call records (otherwise the total would be hidden anyway) */
  shutdownOversize: number;
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
  /** today and the 6 local days before it; ignores the filter; undefined = no record (D32) */
  last7?: Totals;
  /** the 7 local days before last7; ignores the filter; undefined = no record (D32) */
  prior7?: Totals;
  /** the current calendar month, never filtered and never a selected past month: the
   * status bar, the target state and the side bar read it (D31); undefined = no record */
  thisMonth?: Totals;
  /** every project of the current calendar month, never filtered, costliest first, with
   * session titles applied as `label` (the side bar's top projects, D31) */
  thisMonthProjects?: GroupSummary[];
  /** every local day of the history window that has a record, never filtered: the
   * dashboard's heatmap, Yesterday and the 30-day bars read it (A2) */
  activity?: Activity;
  /** every project with a record today, never filtered, costliest first, titles applied (A1) */
  todayProjects?: GroupSummary[];
  /** every project with a record in last7's window, never filtered, costliest first, titles applied (A1) */
  last7Projects?: GroupSummary[];
}

/** One local day's headline figures (A2). A session total counts on the day it ended. */
export interface DayStats {
  dayStartMs: number;
  /** input + output tokens, combined like a Totals headline */
  tokens: Metric;
  nanoAiu: Metric;
  calls: number;
  callsMissing: number;
  sessionTotals: number;
  /** distinct sessions with a record dated that day */
  sessions: number;
}

/** Per-day figures over the history window, never filtered (A2). */
export interface Activity {
  /** the first day read (the history window start); days before it are unknown, not empty */
  fromMs: number;
  /** days with at least one record, oldest first; a day not listed had no record */
  days: DayStats[];
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
  /** session totals without requests.count; absent when 0 (see Counts.callsMissing) */
  callsMissing?: number;
  /** session-total rows included; set only by the side bar's recent figures (A1), absent when 0 */
  sessionTotals?: number;
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
  /** folder of the session's first record; display labels are looked up by it */
  folderId?: string;
  /** display only: the session's title, else its project label (never a key) */
  label?: string;
  firstMs: number;
  lastMs: number;
  calls: number;
  /** session totals without requests.count; absent when 0 (see Counts.callsMissing) */
  callsMissing?: number;
  /** model with the most calls (a session total without requests.count weighs 1); undefined if none reported */
  topModel?: string;
  tokens: Metric;
  nanoAiu: Metric;
  /** mean nanoAiu of the last 5 calls ÷ mean of the first 5, by time; needs ≥ 10 calls with AIU */
  growth?: number;
  /** true when the session is counted from its session total (no per-call records) */
  sessionTotal?: boolean;
  /** summed prompt tokens and cache reads, for the cache-read share (O1). Prompt tokens are
   * `input`, plus cache reads and writes for a model whose log reports them apart from
   * input (the same per-model inference as Insights, `promptConventions`). */
  input?: Metric;
  cacheRead?: Metric;
  /** with growth: Σ over priced calls after the first 5 of max(0, AIU − mean of the first 5) (O2 I2) */
  excessNanoAiu?: number;
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
  /** costliest sessions first (by AIU, then tokens), at most SESSION_ROWS (50) */
  sessions: SessionSummary[];
  /** sessions in the viewed month (filters applied), before the SESSION_ROWS cut */
  sessionCount?: number;
  /** sessions counted from session totals in the viewed month; project filter applies, tool filter does not */
  totalsSessions?: number;
  /** I2 and I3 over the viewed month (D32) */
  insights?: InsightsView;
  /** per project, costliest first; ignores the project filter, honours the tool filter (D26) */
  projects: GroupSummary[];
  /** per tool, costliest first; ignores the tool filter, honours the project filter (D26) */
  tools: ToolSummary[];
  /** undefined iff no record this month */
  totals?: Totals;
  /** prompt tokens and cache reads over the viewed month's sessions (filters applied), for
   * the cache-reuse ring (A2); prompt tokens follow the per-model convention of Insights */
  cache?: { prompt: Metric; cacheRead: Metric };
  /** the month before the viewed one, only when it is inside the history window (A2): up to
   * the same point for the current month, else the whole month; filters applied */
  prior?: { monthStartMs: number; toMs: number; totals?: Totals };
}

/** How figures are shown (D22, D23); from settings, never from the logs. */
/** A display currency: `rate` units of `code` per 1 USD, as of `date` (YYYY-MM-DD). */
export interface Currency {
  code: string;
  rate: number;
  date: string;
}

export interface ViewOptions {
  unit: "tokens" | "cost";
  /** self-set monthly target, held in USD; either bound may be absent */
  range?: { min?: number; max?: number };
  /** display currency for estimated cost; absent = USD */
  currency?: Currency;
  /** a non-USD currency was chosen but no rate is known yet; figures stay in USD */
  currencyPending?: string;
}

export type RangeState = "none" | "under" | "in" | "over";

/** One fired insight rule (O2). `nanoAiu` is the logged AIU it points at (I2: growth above
 * the starting level) and is the ranking key; `tokens` is input + output of the same calls. */
export type Insight =
  | { id: "context-growth"; nanoAiu: number; tokens: number; calls: number; sessions: number; top: { sessionId: string; label?: string; growth: number }[] }
  | { id: "cache-reuse"; nanoAiu: number; tokens: number; calls: number; sessions: number; model: string; share: number; meanPromptTokens: number };

export interface InsightsView {
  /** fired rules, highest AIU first */
  items: Insight[];
  /** sessions in scope with per-call records / counted from session totals only (the rules use only the former) */
  coverage: { callSessions: number; totalsOnlySessions: number };
}
