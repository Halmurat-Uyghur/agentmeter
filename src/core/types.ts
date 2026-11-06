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
  overlong: number;
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
  /** month-to-date view (D10); absent until the first snapshot with a month window */
  month?: MonthView;
}

/** One local day of the month window; totals undefined = no record that day. */
export interface DayTotals {
  dayStartMs: number;
  totals?: Totals;
}

export interface MonthView {
  monthStartMs: number;
  /** day 1 .. today */
  days: DayTotals[];
  /** undefined iff no record this month */
  totals?: Totals;
}
