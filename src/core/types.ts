// Shapes shared by the core modules. A UsageRecord holds only allowlisted
// numbers and ids from a `session.usage_record` event, or one model's running
// total from a `session.shutdown` event (D29); nothing else is kept.

/** The tool whose local log a record came from (D40). UI order is SOURCES. */
export type Source = "copilot" | "claude-code" | "codex";
export const SOURCES: readonly Source[] = ["copilot", "claude-code", "codex"];
/** Display names; a source's label comes only from this table, never from a log. */
export const SOURCE_LABEL: Record<Source, string> = { copilot: "Copilot", "claude-code": "Claude Code", codex: "Codex" };

export function isSource(x: unknown): x is Source {
  return typeof x === "string" && (SOURCES as readonly string[]).includes(x);
}

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

/** Why a call ended (v0.6). Values outside the known set are "other"; the log's string is never kept. */
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "other";

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
  keySource: "usageId" | "eventId" | "shutdown" | "claudeMessageId" | "claudeRequestId" | "codexResponseId" | "codexTotal";
  /** the tool whose log held the record (D40) */
  source: Source;
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
  /** records per source (D40); nanoAiu and callNanoAiu count Copilot records only (D46) */
  sources?: Partial<Record<Source, number>>;
}

/** byModel keys are the model id, or "(unknown model)" when none was reported. */
export interface Totals extends Counts {
  byModel: Record<string, Counts>;
  /** per source, filled like byModel (D40) */
  bySource?: Partial<Record<Source, Counts>>;
}

export type HealthState = "ok" | "no-data" | "no-dir" | "permission" | "format-changed";

/** One source's reading state (D50); "off" when its setting disables it. */
export type SourceState = "ok" | "no-data" | "no-dir" | "permission" | "off" | "format-changed";

export interface SourceHealth {
  state: SourceState;
  rootSource: "setting" | "env" | "default";
  files: number;
  sessions: number;
  unreadableFiles: number;
  unrecognized: number;
  malformed: number;
  overlong: number;
  overlongOther: number;
  /** files over the discovery cap, not read */
  capped?: number;
  /** archived files seen (Codex) */
  archived?: number;
}

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
  /** per source (D50) */
  sources?: Partial<Record<Source, SourceHealth>>;
  /** first-read progress: files read so far of those discovered */
  reading?: { done: number; total: number };
}

export interface Snapshot {
  generatedAtMs: number;
  dayStartMs: number;
  /** undefined iff no record is dated today */
  today?: Totals;
  current?: { folderId: string; live: boolean; pinned: boolean; totals?: Totals; lastPrompt?: LastPrompt; source?: Source };
  sessions: { folderId: string; lastMs?: number; live: boolean; source?: Source }[];
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
  source?: Source;
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
  /** records per source (D40) */
  sources?: Partial<Record<Source, number>>;
}

/** One tool in the viewed month: how often the model invoked it, and the model
 * calls that did. A call that used two tools counts toward both (D26). */
export interface ToolSummary {
  name: string;
  /** built in to a source that used it (D52) */
  builtIn: boolean;
  uses: number;
  calls: number;
  tokens: Metric;
  nanoAiu: Metric;
  /** records per source (D40) */
  sources?: Partial<Record<Source, number>>;
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
  /** the first record's source (D40) */
  source?: Source;
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

/** Prompts and the agent calls they triggered (v0.6, item 1.2). A prompt is a call with
 * initiator "user"; the agent calls after it in the same session, up to the next prompt,
 * belong to it (its chain). */
export interface PromptStats {
  /** calls with initiator "user" */
  prompts: number;
  /** agent calls that followed a prompt in the same session */
  agentCalls: number;
  /** agent calls before the first prompt in scope, and calls whose initiator is "other" */
  notLinked: number;
  /** calls that logged no initiator (Copilot before the field existed) */
  unknown: number;
  /** AIU per chain: `reported` = chains whose every call logged AIU, `missing` = the others */
  nanoAiu: Metric;
  /** input + output tokens per chain, under the same rule */
  tokens: Metric;
}

/** The newest prompt chain of a session (v0.6, status bar tooltip). */
export interface LastPrompt {
  atMs: number;
  agentCalls: number;
  /** undefined unless every call of the chain logged AIU */
  nanoAiu?: number;
  /** input + output tokens; undefined unless every call reported one */
  tokens?: number;
}

/** Cache figures over a set of call records (v0.6, item 1.3). */
export interface CacheStats {
  /** prompt tokens (per-model convention, as in Insights) and cache reads */
  prompt: Metric;
  cacheRead: Metric;
  /** from tokenDetails: AIU of the uncached input, over every call with a per-type split */
  uncachedNano: Metric;
  /** the same tokens at the cache-read rate, and the uncached-input AIU of those same calls
   * (those with one logged cache-read rate), so the comparison pairs like with like */
  atReadRateNano: Metric;
  pairedUncachedNano: Metric;
  /** from tokenDetails: AIU of cache reads and cache writes */
  cacheReadNano: Metric;
  cacheWriteNano: Metric;
}

export interface ModelCache extends CacheStats {
  model: string;
}

/** Tool-definition tokens as a share of input (v0.6, item 1.5). They are part of input,
 * never an extra cost. */
export interface ToolOverheadGroup {
  /** "builtIn": calls that used a built-in tool; "added": calls that used a tool of server
   * or plugin `name`; "none": calls that used no tool */
  kind: "builtIn" | "added" | "none";
  name: string;
  calls: number;
  toolTokens: number;
  /** prompt tokens of the same calls */
  input: number;
}

export interface ToolOverhead {
  /** calls that reported both toolTokenCount and input */
  calls: number;
  /** calls without toolTokenCount */
  missing: number;
  toolTokens: number;
  input: number;
  availableTools: Metric;
  /** costliest first by tool-definition tokens; a call that used two groups counts in both */
  groups: ToolOverheadGroup[];
}

/** One call in a session's ledger (v0.6, item 1.1). Every field is a number or a fixed enum. */
export interface CallRow {
  timestampMs: number;
  model?: string;
  initiator?: Initiator;
  finishReason?: FinishReason;
  /** input not read from or written to the cache; undefined when not derivable */
  uncached?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  /** prompt tokens (per-model convention) */
  prompt?: number;
  toolTokens?: number;
  nanoAiu?: number;
}

/** The selected session's calls in the viewed month (v0.6, item 1.1). In memory only. */
export interface SessionDetail {
  sessionId: string;
  /** display only: the session title, else its project label */
  label?: string;
  /** call records of the session in scope */
  calls: number;
  /** the newest DETAIL_ROWS calls, oldest first */
  rows: CallRow[];
  /** calls in scope not in `rows` (the oldest ones) */
  omitted: number;
  /** true when the session is counted from a session total only (no calls to list) */
  sessionTotal?: boolean;
  nanoAiu: Metric;
  tokens: Metric;
  prompts: PromptStats;
  cache: CacheStats;
  tools: ToolOverhead;
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
  /** sessions in the viewed month per source, counted before the SESSION_ROWS cut; filters applied like sessionCount */
  sessionsBySource?: Partial<Record<Source, number>>;
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
  /** v0.6: prompts and agent calls over the viewed month (project filter only; a tool filter would cut chains) */
  prompts?: PromptStats;
  /** v0.6: cache figures over the viewed month (filters applied), and per model, costliest uncached input first */
  cacheCost?: CacheStats;
  modelCache?: ModelCache[];
  /** v0.6: tool-definition share of input over the viewed month (filters applied) */
  toolOverhead?: ToolOverhead;
  /** v0.6: the session picked in the Sessions table, if any */
  detail?: SessionDetail;
  /** the month before the viewed one, only when it is inside the history window (A2): up to
   * the same point for the current month, else the whole month; filters applied. `projects`
   * and `tools` (v0.6, 2.1) are that period's tables, under the same filter rules as
   * `MonthView.projects` and `MonthView.tools`, for the change-vs-last-month column */
  prior?: { monthStartMs: number; toMs: number; totals?: Totals; projects?: GroupSummary[]; tools?: ToolSummary[] };
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
  /** self-set target for today (`dailyTargetMax`), held in USD; a ceiling only (v0.9) */
  dayTarget?: { min?: number; max?: number };
  /** self-set target for the last 7 days (`weeklyTargetMax`), held in USD; a ceiling only (v0.9) */
  weekTarget?: { min?: number; max?: number };
  /** display currency for estimated cost; absent = USD */
  currency?: Currency;
  /** a non-USD currency was chosen but no rate is known yet; figures stay in USD */
  currencyPending?: string;
  /** what the status bar text shows (v0.6, `copilotUsageMonitor.statusBar`); absent = "today" */
  statusBar?: StatusBarContent;
}

/** "today": today's tokens, or this month against the target in the cost view (the
 * behaviour before 0.6); "month": this month in either unit; "session": the current session. */
export type StatusBarContent = "today" | "month" | "session";
export const STATUS_BAR_CONTENTS: readonly StatusBarContent[] = ["today", "month", "session"];

/** The settings the panel's Settings section shows (v0.9), read by the extension from the
 * user's VS Code settings; never from the logs. Amounts are as entered, in `currency`. The
 * palette and the nav state travel separately (they already did). */
export interface Prefs {
  /** the chosen currency code, even while its rate is pending */
  currency: string;
  statusBar: StatusBarContent;
  targets: { dayMax?: number; weekMax?: number; monthMin?: number; monthMax?: number };
  targetAlert: boolean;
  historyMonths: number;
  projectNames: boolean;
  sessionTotals: boolean;
  sources: { claudeCode: boolean; codex: boolean };
  /** setting keys (without the section) whose last save VS Code refused in this window */
  unsaved: string[];
}

export const DEFAULT_PREFS: Prefs = {
  currency: "USD",
  statusBar: "today",
  targets: {},
  targetAlert: false,
  historyMonths: 12,
  projectNames: true,
  sessionTotals: true,
  sources: { claudeCode: true, codex: true },
  unsaved: [],
};

export type RangeState = "none" | "under" | "in" | "over";

/** One fired insight rule (O2). `nanoAiu` is the logged AIU it points at (I2: growth above
 * the starting level) and is the ranking key; `tokens` is input + output of the same calls. */
export type Insight =
  | { id: "long-context"; nanoAiu: number; tokens: number; calls: number; sessions: number; model: string; thresholdTokens: number; maxPromptTokens: number }
  | { id: "context-growth"; nanoAiu: number; tokens: number; calls: number; sessions: number; top: { sessionId: string; label?: string; growth: number }[] }
  | { id: "cache-reuse"; nanoAiu: number; tokens: number; calls: number; sessions: number; model: string; share: number; meanPromptTokens: number };

export interface InsightsView {
  /** fired rules, highest AIU first */
  items: Insight[];
  /** sessions in scope with per-call records / counted from session totals only (the rules use only the former) */
  coverage: { callSessions: number; totalsOnlySessions: number };
}
