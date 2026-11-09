// Ties the source readers (D54), the store and health together and emits a
// Snapshot whenever what it would show changes. Missing data stays undefined,
// incomplete data sets `health.partial`, and only counts, codes and timings are
// logged: never a path, never a root.
//
// A snapshot is not built from scratch each time. Every figure is kept with what it was
// computed from (`memo`): the store's version for the dates it reads, its date range, the
// filter, the project labels. And where a figure adds up days, the days before today are
// kept apart and only today's records are read again (`Build.split`). A new line in a log
// then costs today's records, not every record stored. Nothing is written anywhere: the
// kept results live in this object and go with it. `fullRebuild` builds every snapshot
// from the whole store instead; test/core/snapshotReuse.test.ts holds the two equal.
import { ClaudeSourceReader } from "./claude";
import { CodexSourceReader } from "./codex";
import { CopilotSourceReader } from "./copilot";
import { isLive as realIsLive } from "./discover";
import { parseUsageLine } from "./extract";
import type { Logger } from "./log";
import { sep } from "node:path";
import { cacheStats, lastPrompt, modelCacheStats, promptStats, sessionDetail, toolOverhead } from "./explain";
import { computeInsights, extendScan, promptConventions, scanCalls, type CallScan } from "./insights";
import { RECENT_MS, type FileReader, type FileReadResult, type SourceCandidate, type SourceDiscoverResult, type SourceFile, type SourceReader } from "./source";
import { byMonth, bySessionCost, dailyActivity, daysOfMonth, groupSummaries, localDayStart, localDaysBefore, localMonthStart, monthStarts, NO_PROJECT, projectGroups, projectSummaries, recentProjects, sessionSummaries, toolGroups, toolRows, toolSummaries, totalsOf, UsageStore, type RecordSource } from "./store";
import type { ReadErrorCode } from "./tailer";
import { isSource, SOURCES, type Activity, type DayTotals, type Filter, type GroupSummary, type Health, type HealthState, type MonthSummary, type MonthView, type SessionSummary, type Snapshot, type Source, type SourceHealth, type SourceScope, type ToolSummary, type Totals, type UsageRecord } from "./types";

export { RECENT_MS };

export interface MonitorOptions {
  /** Copilot's home; Copilot is always read */
  root: string;
  rootSource: Health["rootSource"];
  /** the other sources; absent = off (D48, D54) */
  sources?: {
    claude?: { root: string; rootSource: Health["rootSource"] };
    codex?: { root: string; rootSource: Health["rootSource"] };
  };
  now?: () => Date;
  isLive?: typeof realIsLive;
  /** injectable for tests; defaults to the real extractor */
  parse?: typeof parseUsageLine;
  log: Logger;
  onSnapshot: (s: Snapshot) => void;
  /** months of history to read, this month included (D21); default 1 = this month only */
  historyMonths?: number;
  /** decode each log's project folder (D25, D44); default false */
  readProjects?: boolean;
  /** decode session totals and count sessions without per-call records from them (D29);
   * default false here, the extension passes its setting (default on) */
  readTotals?: boolean;
  /** test hook: replaces the readers built from root/sources */
  readers?: SourceReader[];
  /** test hook: every snapshot aggregates the whole store again and keeps nothing between
   * snapshots, as every snapshot was built before results were kept. The reference those results are compared with. */
  fullRebuild?: boolean;
}

export const MAX_HISTORY_MONTHS = 24;

/** Session rows a snapshot keeps for the viewed month; the panel shows 10 and folds the rest (D32). */
export const SESSION_ROWS = 50;

/** Clamps a history setting to 1..MAX_HISTORY_MONTHS; anything invalid is 1. */
export function clampHistory(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_HISTORY_MONTHS, Math.max(1, Math.floor(n))) : 1;
}

interface FileState {
  source: Source;
  sessionId: string;
  folderId: string;
  reader: FileReader;
  /** false until a read without error; that read's lines are history, not "since start" */
  primed: boolean;
  /** read at least once (with or without error): the first read of the window is done for it */
  tried: boolean;
  error?: ReadErrorCode;
  malformed: number;
  unrecognized: number;
  overlong: number;
  overlongOther: number;
  /** session.shutdown lines too long to decode */
  shutdownOversize: number;
  /** a totals line of this file gave session totals */
  hasTotals: boolean;
  /** activity / usage lines over the whole file (since the last reset) */
  activity: number;
  usage: number;
  /** lines that could have yielded a record or total (FileReadResult.candidates), since the last reset (D42) */
  candidates: number;
  /** activity / usage lines read after the first read (the format-change window) */
  windowActivity: number;
  windowUsage: number;
  /** project key (D44) */
  label?: string;
  /** display title (Copilot: workspace.yaml title, else `owner/repo`) */
  title?: string;
  /** mtime and size seen by the last discovery */
  lastMtimeMs: number;
  lastSize: number;
  /** mtime within RECENT_MS of the last discovery: read every tick (D50) */
  hot: boolean;
  /** discovery saw the mtime or size change since the last read */
  changed: boolean;
}

/** How one snapshot build reads the records. */
interface Build {
  /** results are kept between snapshots (see `memo`) */
  reuse: boolean;
  /** with `reuse`: figures are put together from what the days before today came to (kept
   * until one of their records changes) and today's records, read from the store's own list
   * of them. Off while today's records are most of the store: then one pass is as cheap. */
  split: boolean;
  dayStartMs: number;
  monthStartMs: number;
  /** the records dated from today on (only with `split`; the whole store otherwise) */
  day: RecordSource;
  /** the records dated from the 1st of this month on, when the store keeps their list; else
   * the whole store. Every pass over it names its own dates. */
  month: RecordSource;
}

/** The filter of one snapshot build, as predicates and as the values they were made from. */
interface Scope {
  keep: (r: UsageRecord) => boolean;
  projectOf: (r: UsageRecord) => string;
  byProject: (r: UsageRecord) => boolean;
  byTool: (r: UsageRecord) => boolean;
  project: string | undefined;
  tool: string | undefined;
  source: Source | undefined;
  /** changes whenever a folder's project label does (`projectOf` reads them) */
  labels: number;
}

/** Whether two maps hold the same keys with the same values. */
function sameEntries<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (!b.has(k) || b.get(k) !== v) return false;
  return true;
}

/** One enabled source: its reader and what its last discovery found. */
interface ReaderState {
  reader: SourceReader;
  discovered: boolean;
  lastDiscoverAt: number;
  /** when rootDirMtime() was last compared (non-Copilot readers check it every REDISCOVER_MS, D50) */
  lastDirCheckAt: number;
  lastDirMtimeMs: number | undefined;
  error: "no-dir" | "permission" | undefined;
  /** the last discovery failed for another reason (EIO, EMFILE...): the last good candidates are
   * kept, but new sessions may be missing, so the source counts one unreadable root (partial) */
  discoverFailed?: boolean;
  /** sessionId → candidate from the last successful discover */
  candidates: Map<string, SourceCandidate>;
  /** paths whose lstat failed (not ENOENT) in the last discover: kept, partial */
  unreadable: Set<string>;
  /** candidate paths the reader refused (pathAllowed false): never opened, partial */
  refused: Set<string>;
  capped?: number;
  /** the last discovery's outcome; a rediscovery with the same one changes nothing shown */
  fingerprint?: string;
  archived?: number;
}

const REDISCOVER_MS = 10_000;
/** Claude Code and Codex: the full walk runs this often, or sooner when the 10 s directory-mtime
 * check sees a change (a walk of thousands of files costs ~200 ms of CPU; D50). */
export const COLD_REDISCOVER_MS = 60_000;
/** While the current month is viewed with a prior-month comparison, the snapshot is rebuilt at
 * least this often so the comparison's end point (`prior.toMs`) follows the clock. */
export const PRIOR_REFRESH_MS = 60_000;
const FORMAT_ACTIVITY = 3;
/** progress snapshots during the first read, at most this often (D50) */
const PROGRESS_MS = 500;
/** "today" has no upper bound (a clock-skewed record still counts today); the month mirrors that. */
const DAY_SLACK_MS = Number.POSITIVE_INFINITY;
const CODE = /^[A-Z0-9_]{1,40}$/;

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && CODE.test(code) ? code : "EXCEPTION";
}

/** A reader-supplied code, if it is a code; never a free string. */
function safeCode(code: string): string {
  return CODE.test(code) ? code : "OTHER";
}

/** Copilot's logged cost in the month's totals: the Insights month-share floor (other sources log no cost, D46). */
function copilotNano(totals: Totals | undefined): number {
  return totals?.bySource?.copilot?.nanoAiu.sum ?? 0;
}

export class UsageMonitor {
  private readonly rootSource: Health["rootSource"];
  private readonly now: () => Date;
  private readonly log: Logger;
  private readonly onSnapshot: (s: Snapshot) => void;
  private readonly historyMonths: number;
  /** month start of the viewed month; undefined = follow the current month */
  private selectedMonth: number | undefined;
  private filter: Filter = {};
  /** session whose calls the Sessions section lists (v0.6); in memory only */
  private selectedSession: string | undefined;

  private readonly store = new UsageStore();
  private readonly readers: ReaderState[];
  /** path → state; dropped when the file leaves the window or on ENOENT */
  private readonly files = new Map<string, FileState>();
  private lastDayStartMs: number | undefined;
  private pinned: string | undefined;
  private lastSignature: string | undefined;
  /** when the last snapshot was built, and whether it compared the current month with a prior one */
  private lastBuildMs = 0;
  private priorFollowsClock = false;
  private disposed = false;
  /** set when something other than new lines can change the snapshot */
  private dirty = true;

  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | undefined;
  private wantFull = false;

  /** false: every snapshot aggregates the whole store again (MonitorOptions.fullRebuild) */
  private readonly incremental: boolean;
  /** results kept from the last snapshot, by name: what each was computed from, and the result (see `memo`) */
  private readonly kept = new Map<string, { deps: readonly unknown[]; value: unknown }>();
  /** the last prior-month comparison of the current month and the span of `toMs` it holds for (see `priorSoFar`) */
  private priorKept: { deps: readonly unknown[]; afterMs: number; untilMs: number; value: { totals: Totals | undefined; projects: GroupSummary[]; tools: ToolSummary[] } } | undefined;
  private lastScan: CallScan | undefined;
  /** folderId → project label at the last snapshot, and a number that changes when they do */
  private projectsSeen = new Map<string, string>();
  private labelsVersion = 0;
  /** grows whenever a file is added or forgotten, or a file's label or title changes: what the
   * snapshot derives from `files` alone (sources, labels, titles) is kept until then */
  private shape = 0;

  constructor(o: MonitorOptions) {
    this.rootSource = o.rootSource;
    this.now = o.now ?? (() => new Date());
    this.log = o.log;
    this.onSnapshot = o.onSnapshot;
    this.historyMonths = clampHistory(o.historyMonths ?? 1);
    this.incremental = o.fullRebuild !== true;
    const readProjects = o.readProjects === true;
    const readTotals = o.readTotals === true;
    const readers: SourceReader[] = o.readers ?? [
      new CopilotSourceReader({
        root: o.root,
        rootSource: o.rootSource,
        readProjects,
        readTotals,
        ...(o.isLive && { isLive: o.isLive }),
        ...(o.parse && { parse: o.parse }),
      }),
      ...(o.sources?.claude ? [new ClaudeSourceReader({ ...o.sources.claude, readProjects })] : []),
      ...(o.sources?.codex ? [new CodexSourceReader({ ...o.sources.codex, readProjects, readTotals })] : []),
    ];
    this.readers = readers.map((reader) => ({
      reader,
      discovered: false,
      lastDiscoverAt: 0,
      lastDirCheckAt: 0,
      lastDirMtimeMs: undefined,
      error: undefined,
      candidates: new Map(),
      unreadable: new Set(),
      refused: new Set(),
    }));
  }

  /**
   * Serialised: a call while a run is busy queues exactly one more run, which
   * every later caller joins; each promise resolves after the work it asked for.
   * A rejected run never wedges the chain: the next run starts either way (v0.7).
   */
  refresh(opts: { full?: boolean } = {}): Promise<void> {
    if (opts.full) this.wantFull = true;
    if (this.queued) return this.queued;
    const start = (): Promise<void> => {
      this.queued = undefined;
      return this.run();
    };
    const run = this.chain.then(start, start);
    this.queued = run;
    this.chain = run;
    return run;
  }

  /** Pins `folderId` as current (undefined unpins) and refreshes. */
  pin(folderId: string | undefined): void {
    this.pinned = folderId;
    this.dirty = true;
    void this.refresh();
  }

  /** Views the month starting at `monthStartMs` (undefined = the current month) and refreshes.
   * A month outside the history window, or the current month, follows the current month. */
  selectMonth(monthStartMs: number | undefined): void {
    this.selectedMonth = monthStartMs;
    this.dirty = true;
    void this.refresh();
  }

  /** Lists the calls of session `sessionId` in the viewed month (undefined clears) and refreshes. */
  selectSession(sessionId: string | undefined): void {
    this.selectedSession = sessionId;
    this.dirty = true;
    void this.refresh();
  }

  /** Narrows the month view, trend and tables; empty values clear (D26). A source must be one of SOURCES (D40). */
  setFilter(filter: Filter): void {
    this.filter = {
      ...(filter.project ? { project: filter.project } : {}),
      ...(filter.tool ? { tool: filter.tool } : {}),
      ...(isSource(filter.source) ? { source: filter.source } : {}),
    };
    this.dirty = true;
    void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
  }

  private async run(): Promise<void> {
    if (this.disposed) return;
    const full = this.wantFull;
    this.wantFull = false;
    const started = performance.now();
    try {
      const nowMs = this.now().getTime();
      const dayStartMs = localDayStart(new Date(nowMs));
      // A full refresh (a command, a settings change) always rebuilds the snapshot, every
      // figure from the records: nothing kept from earlier snapshots is used.
      if (full) this.forget();
      let changed = full || this.dirty || dayStartMs !== this.lastDayStartMs;
      // The current month's prior-month comparison runs up to "now": rebuild it at least every minute.
      if (this.priorFollowsClock && Math.abs(nowMs - this.lastBuildMs) >= PRIOR_REFRESH_MS) changed = true;
      this.dirty = false;
      for (const rs of this.readers) {
        if (await this.shouldDiscover(rs, full, nowMs, dayStartMs)) {
          if (await this.rediscover(rs, nowMs, dayStartMs, full)) changed = true;
        }
      }
      // The first read of the window goes newest file first (D50); the rest keep their order.
      const due = [...this.files].filter(([, f]) => this.isDue(f, full));
      const fresh = due.filter(([, f]) => !f.tried).sort(([, a], [, b]) => b.lastMtimeMs - a.lastMtimeMs);
      const order = [...fresh, ...due.filter(([, f]) => f.tried)];
      let lastProgressMs = nowMs;
      let progressed = false;
      let added = 0;
      for (const [path, f] of order) {
        // A disposed monitor stops reading at once and emits nothing more.
        if (this.disposed) return;
        // A file dropped earlier in this run (ENOENT) is not read again.
        if (this.files.get(path) !== f) continue;
        const r = await this.readFile(path, f);
        added += r.added;
        if (r.changed) changed = true;
        if (fresh.length > 0 && !this.disposed) {
          const t = this.now().getTime();
          if (t - lastProgressMs >= PROGRESS_MS && this.reading() !== undefined) {
            lastProgressMs = t;
            progressed = true;
            this.emit(this.snapshot(nowMs, dayStartMs));
          }
        }
      }
      if (added > 0) this.log.count("usage", added);
      this.lastDayStartMs = dayStartMs;
      // Idle polls (nothing read, nothing rediscovered) skip the rebuild; after progress
      // snapshots the final one (without `reading`) is always built.
      if (changed || progressed) this.emit(this.snapshot(nowMs, dayStartMs));
    } catch (err) {
      this.log.error("refresh", errCode(err));
    }
    this.log.timing("refresh", performance.now() - started);
  }

  /**
   * Copilot files are always read (they are few); others when never read, hot, or changed
   * at the last discovery (D50). A file whose read failed is retried only then, or on a
   * full refresh, so an unreadable tree is not reopened every tick.
   */
  private isDue(f: FileState, full: boolean): boolean {
    return f.source === "copilot" || !f.tried || f.hot || f.changed || (full && (!f.primed || f.error !== undefined));
  }

  /** First-read progress, while any file of the window has not been read yet. */
  private reading(): { done: number; total: number } | undefined {
    let done = 0;
    for (const f of this.files.values()) if (f.tried) done++;
    return done < this.files.size ? { done, total: this.files.size } : undefined;
  }

  /**
   * Copilot: every REDISCOVER_MS, or when its directory mtime changes (checked every tick; it is
   * one stat). Claude Code and Codex: every COLD_REDISCOVER_MS, or sooner when their directory
   * mtimes, checked every REDISCOVER_MS, change (D50). Always on a full refresh, a new day, before
   * the first discovery and while the root is missing or locked. A discovery that failed otherwise
   * (EIO, EMFILE...) is retried every REDISCOVER_MS, whatever the directory check says (it may fail
   * too), not on every tick.
   */
  private async shouldDiscover(rs: ReaderState, full: boolean, nowMs: number, dayStartMs: number): Promise<boolean> {
    if (full || !rs.discovered || rs.error !== undefined) return true;
    if (dayStartMs !== this.lastDayStartMs) return true;
    if (rs.discoverFailed === true) return Math.abs(nowMs - rs.lastDiscoverAt) >= REDISCOVER_MS;
    const copilot = rs.reader.source === "copilot";
    if (Math.abs(nowMs - rs.lastDiscoverAt) >= (copilot ? REDISCOVER_MS : COLD_REDISCOVER_MS)) return true;
    if (!copilot) {
      if (Math.abs(nowMs - rs.lastDirCheckAt) < REDISCOVER_MS) return false;
      rs.lastDirCheckAt = nowMs;
    }
    return (await rs.reader.rootDirMtime()) !== rs.lastDirMtimeMs;
  }

  /** What a discovery found, as one string: error, candidate files, unreadable and refused paths, extras. */
  private fingerprint(rs: ReaderState): string {
    const fp = rs.error ?? this.goodFingerprint(rs);
    return rs.discoverFailed === true ? `OTHER\0${fp}` : fp;
  }

  private goodFingerprint(rs: ReaderState): string {
    const files: string[] = [];
    for (const c of rs.candidates.values()) for (const f of c.files) files.push(`${f.path}\0${c.sessionId}\0${f.mtimeMs}\0${f.size}\0${c.live ? 1 : 0}`);
    files.sort();
    return JSON.stringify([files, [...rs.unreadable].sort(), [...rs.refused].sort(), rs.capped ?? null, rs.archived ?? null]);
  }

  /** Discovers one reader's files; true when the outcome differs from the last discovery's. */
  private async rediscover(rs: ReaderState, nowMs: number, dayStartMs: number, full: boolean): Promise<boolean> {
    // Claude Code and Codex: the 10 s check compares rootDirMtime() with its own value taken just
    // before the walk (a change during the walk still differs), so a walk's dirMtimeMs that covers
    // fewer directories than rootDirMtime() can never make every check look like a change (D50).
    const before = rs.reader.source === "copilot" ? undefined : await rs.reader.rootDirMtime();
    // A full refresh asks the reader for its complete walk (Codex: the old date folders too).
    const result = await rs.reader.discover(monthStarts(new Date(nowMs), this.historyMonths)[0]!, dayStartMs, nowMs, { full });
    this.discoverOnce(rs, result, nowMs, dayStartMs);
    if (result.ok && rs.reader.source !== "copilot") rs.lastDirMtimeMs = before;
    const fp = this.fingerprint(rs);
    if (fp === rs.fingerprint) return false;
    rs.fingerprint = fp;
    return true;
  }

  private discoverOnce(rs: ReaderState, result: SourceDiscoverResult, nowMs: number, dayStartMs: number): void {
    const reader = rs.reader;
    rs.discovered = true;
    rs.lastDiscoverAt = nowMs;
    rs.lastDirCheckAt = nowMs;
    if (!result.ok) {
      rs.lastDirMtimeMs = undefined;
      if (result.error === "OTHER") {
        // Keep the last known candidates (their figures stay), but mark the source partial until
        // a discovery succeeds: sessions started since may be missing. A missing or locked root
        // seen before is no longer known: its state goes (it had no candidates to keep), so the
        // row says the folder could not be listed and ticks stop rediscovering on rs.error.
        // Logged once per episode; the fingerprint changes only on entering it, so a failure
        // that repeats does not rebuild the snapshot.
        if (rs.discoverFailed !== true) this.log.error("discover", "OTHER");
        rs.discoverFailed = true;
        rs.error = undefined;
        return;
      }
      delete rs.discoverFailed;
      // A new or different error (permission → no-dir and back) re-reads the files once.
      const entering = rs.error !== result.error;
      rs.error = result.error;
      rs.candidates = new Map();
      rs.unreadable = new Set();
      rs.refused = new Set();
      delete rs.capped;
      delete rs.archived;
      // Files of a vanished or locked folder are read once more when the error starts or
      // changes: ENOENT drops them, other errors show (not again on every tick while it lasts).
      if (entering) for (const f of this.files.values()) if (f.source === reader.source) f.changed = true;
      return;
    }
    // A root that recovers re-reads its files once, so errors of the locked period clear. After an
    // OTHER failure (which clears rs.error, perhaps one that followed a locked root) the files whose
    // last read failed are retried too: an unchanged size and mtime would never re-read them.
    if (rs.error !== undefined) for (const f of this.files.values()) if (f.source === reader.source) f.changed = true;
    if (rs.discoverFailed === true) for (const f of this.files.values()) if (f.source === reader.source && f.error !== undefined) f.changed = true;
    rs.error = undefined;
    delete rs.discoverFailed;
    rs.lastDirMtimeMs = result.dirMtimeMs;
    if (result.capped !== undefined) rs.capped = result.capped;
    else delete rs.capped;
    if (result.archived !== undefined) rs.archived = result.archived;
    else delete rs.archived;
    // A file dated more than RECENT_MS ahead of the clock (clock skew, a corrupt mtime) is
    // neither hot nor live: otherwise it would stay so until the clock caught up. Copilot's
    // liveness is its lock PID, not an mtime, and is kept.
    const futureMs = nowMs + RECENT_MS;
    const liveSinceMs = Math.max(dayStartMs, nowMs - RECENT_MS);
    const liveOf = (c: SourceCandidate): boolean =>
      c.live && (reader.source === "copilot" || c.files.some((f) => f.mtimeMs >= liveSinceMs && f.mtimeMs <= futureMs));
    // One candidate per session: files of the same session id join it.
    const candidates = new Map<string, SourceCandidate>();
    for (const raw of result.candidates) {
      const c = { ...raw, live: liveOf(raw) };
      const prev = candidates.get(c.sessionId);
      if (prev === undefined) candidates.set(c.sessionId, { ...c, files: [...c.files] });
      else {
        prev.files.push(...c.files);
        prev.mtimeMs = Math.max(prev.mtimeMs, c.mtimeMs);
        prev.live = prev.live || c.live;
      }
    }
    // A file or directory lstat or listing failed on (EMFILE, EIO, EACCES...) may be
    // transient: keep the last candidate entry of every file at or under that path, with its
    // state and records, count it unreadable, log each path once per episode (v0.7).
    const unreadable = new Set<string>();
    const prevFiles = new Map<string, { c: SourceCandidate; f: SourceFile }>();
    if (result.unreadable.length > 0) for (const c of rs.candidates.values()) for (const f of c.files) prevFiles.set(f.path, { c, f });
    const carry = (prev: SourceCandidate, prevFile: SourceFile): void => {
      const now = candidates.get(prev.sessionId);
      if (now === undefined) candidates.set(prev.sessionId, { ...prev, files: [prevFile] });
      else if (!now.files.some((x) => x.path === prevFile.path)) now.files.push(prevFile);
    };
    for (const u of result.unreadable) {
      unreadable.add(u.path);
      if (!rs.unreadable.has(u.path)) this.log.error("discover", safeCode(u.code));
      const exact = prevFiles.get(u.path);
      if (exact !== undefined) {
        carry(exact.c, exact.f);
        continue;
      }
      // Not a known file: a directory that failed to list; keep every file under it.
      const under = u.path + sep;
      for (const [path, { c, f }] of prevFiles) if (path.startsWith(under)) carry(c, f);
    }
    rs.unreadable = unreadable;
    rs.candidates = candidates;
    // Files that left the window (e.g. last month's, after the 1st) are forgotten
    // with their records and counters.
    const inWindow = new Map<string, { c: SourceCandidate; mtimeMs: number; size: number }>();
    for (const c of candidates.values()) for (const f of c.files) inWindow.set(f.path, { c, mtimeMs: f.mtimeMs, size: f.size });
    const keep = new Set([...inWindow.keys(), ...unreadable]);
    const gone = new Set<string>();
    for (const [path, f] of [...this.files]) {
      if (f.source !== reader.source || keep.has(path)) continue;
      this.files.delete(path);
      this.shape++;
      gone.add(path);
    }
    this.store.resetFiles(gone);
    const refused = new Set<string>();
    const hotSinceMs = nowMs - RECENT_MS;
    for (const [path, { c, mtimeMs, size }] of inWindow) {
      const f = this.files.get(path);
      if (f !== undefined) {
        if (mtimeMs !== f.lastMtimeMs || size !== f.lastSize) f.changed = true;
        f.lastMtimeMs = mtimeMs;
        f.lastSize = size;
        f.hot = mtimeMs >= hotSinceMs && mtimeMs <= futureMs;
        continue;
      }
      // Only a path the reader itself vouches for is ever opened.
      if (!reader.pathAllowed(path)) {
        refused.add(path);
        if (!rs.refused.has(path)) this.log.error("discover", "PATH_REFUSED");
        continue;
      }
      this.shape++;
      this.files.set(path, {
        source: reader.source,
        sessionId: c.sessionId,
        folderId: c.folderId,
        reader: reader.open(path, c),
        primed: false,
        tried: false,
        malformed: 0,
        unrecognized: 0,
        overlong: 0,
        overlongOther: 0,
        shutdownOversize: 0,
        hasTotals: false,
        activity: 0,
        usage: 0,
        candidates: 0,
        windowActivity: 0,
        windowUsage: 0,
        lastMtimeMs: mtimeMs,
        lastSize: size,
        hot: mtimeMs >= hotSinceMs && mtimeMs <= futureMs,
        changed: false,
      });
    }
    rs.refused = refused;
  }

  /** One read of one file: new records, and whether anything shown may have changed. */
  private async readFile(path: string, f: FileState): Promise<{ added: number; changed: boolean }> {
    const r: FileReadResult = await f.reader.read();
    f.tried = true;
    if (r.error === "ENOENT") {
      // Its records go too, so a recreated log is not counted on top of them (v0.7).
      this.files.delete(path);
      this.shape++;
      this.store.resetFile(path);
      return { added: 0, changed: true };
    }
    const changed =
      r.reset ||
      r.error !== f.error ||
      r.records.length > 0 ||
      r.totals !== undefined ||
      r.hasTotals ||
      // A reader may repeat a label or title it already gave: only a different one counts.
      (r.label !== undefined && r.label !== f.label) ||
      (r.title !== undefined && (r.title ?? undefined) !== f.title) ||
      r.usage > 0 ||
      r.shutdownOversize > 0 ||
      r.activity > 0 ||
      (r.candidates ?? 0) > 0 ||
      r.suspect > 0 ||
      r.unrecognized > 0 ||
      r.malformed > 0 ||
      r.overlong > 0 ||
      r.overlongOther > 0;
    if (r.error !== undefined && f.error === undefined) this.log.error("read", r.error);
    if (r.error === undefined) delete f.error;
    else f.error = r.error;
    // A reset re-delivers the whole file: apply it first, and treat its lines
    // as history (like a first read) so old activity never looks like new.
    if (r.reset) {
      this.store.resetFile(path);
      f.malformed = f.unrecognized = f.overlong = f.overlongOther = f.shutdownOversize = 0;
      f.hasTotals = false;
      delete f.label;
      delete f.title;
      this.shape++;
      f.activity = f.usage = f.candidates = f.windowActivity = f.windowUsage = 0;
      f.primed = false;
    }
    const inWindow = f.primed;
    if (r.label !== undefined && r.label !== f.label) {
      f.label = r.label;
      this.shape++;
      this.dirty = true;
    }
    // A title is reported only when it changes; null clears it.
    if (r.title !== undefined && (r.title ?? undefined) !== f.title) {
      if (r.title === null) delete f.title;
      else f.title = r.title;
      this.shape++;
      this.dirty = true;
    }
    let added = 0;
    for (const rec of r.records) if (this.store.add(rec, path)) added++;
    // The last totals line wins (D29).
    if (r.totals !== undefined && this.store.setSessionTotals(f.folderId, path, r.totals)) added += r.totals.length;
    if (r.hasTotals) f.hasTotals = true;
    f.malformed += r.malformed;
    f.unrecognized += r.unrecognized + r.suspect;
    f.shutdownOversize += r.shutdownOversize;
    f.overlong += r.overlong;
    f.overlongOther += r.overlongOther;
    f.activity += r.activity;
    f.usage += r.usage;
    f.candidates += r.candidates ?? 0;
    if (inWindow) {
      f.windowActivity += r.activity;
      f.windowUsage += r.usage;
    }
    // A read attempt answers the change discovery saw, whether or not it succeeded.
    f.changed = false;
    if (r.error === undefined) f.primed = true;
    return { added, changed };
  }

  /** Health per enabled source (D49) and the global health over their sums. */
  private health(isToday: (ms: number) => boolean, live: Map<string, boolean>, day: RecordSource): Health {
    const fromTotals = this.store.sessionTotalSessions();
    // Records dated today, per source and per (source, folder), for the no-data and silent-live rules.
    const todayBySource = new Set<Source>();
    const todayFolders = new Map<Source, Set<string>>();
    day.each((r) => {
      if (!isToday(r.timestampMs)) return;
      todayBySource.add(r.source);
      let s = todayFolders.get(r.source);
      if (!s) todayFolders.set(r.source, (s = new Set()));
      s.add(r.folderId);
    });
    const sources = Object.create(null) as Partial<Record<Source, SourceHealth>>;
    const g = { malformed: 0, unrecognized: 0, overlong: 0, overlongOther: 0, shutdownOversize: 0, shutdownOversizeNeeded: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, capped: 0, notListed: 0 };
    const states: SourceHealth["state"][] = [];
    for (const rs of this.readers) {
      const src = rs.reader.source;
      const h: SourceHealth = {
        state: "ok",
        rootSource: rs.reader.rootSource,
        files: 0,
        // Candidates of the last discovery, including ones whose files were all refused or
        // dropped on ENOENT since (until the next discovery).
        sessions: rs.candidates.size,
        // An unreadable directory (a listing that failed) counts as one file here. A root whose
        // last discovery failed (not ENOENT or a permission error) is no log: it shows as
        // discoveryFailed and keeps the read partial on its own (Codex review of PR #22).
        unreadableFiles: rs.unreadable.size + rs.refused.size,
        unrecognized: 0,
        malformed: 0,
        overlong: 0,
        overlongOther: 0,
        ...(rs.capped !== undefined && { capped: rs.capped }),
        ...(rs.archived !== undefined && { archived: rs.archived }),
        ...(rs.discoverFailed === true && { discoveryFailed: true as const }),
      };
      /** per session: the files' activity and usage summed (a Claude session has several files) */
      const sessions = new Map<string, { activity: number; usage: number; candidates: number; hasTotals: boolean; windowActivity: number; windowUsage: number }>();
      for (const [path, f] of this.files) {
        if (f.source !== src) continue;
        h.files++;
        h.malformed += f.malformed;
        h.unrecognized += f.unrecognized;
        h.overlong += f.overlong;
        h.overlongOther += f.overlongOther;
        g.shutdownOversize += f.shutdownOversize;
        if (f.usage === 0) g.shutdownOversizeNeeded += f.shutdownOversize;
        if (f.error !== undefined && !rs.unreadable.has(path)) h.unreadableFiles++;
        const s = sessions.get(f.folderId) ?? { activity: 0, usage: 0, candidates: 0, hasTotals: false, windowActivity: 0, windowUsage: 0 };
        s.activity += f.activity;
        s.usage += f.usage;
        s.candidates += f.candidates;
        s.hasTotals ||= f.hasTotals;
        s.windowActivity += f.windowActivity;
        s.windowUsage += f.windowUsage;
        sessions.set(f.folderId, s);
      }
      let silentLive = false;
      for (const [folderId, s] of sessions) {
        if ((s.activity === 0 && !s.hasTotals) || s.usage > 0) continue;
        // D42: a Claude Code or Codex session none of whose lines could have held usage (only
        // user lines, say) never called a model; it is neither "without usage" nor silent.
        if (src !== "copilot" && s.candidates === 0 && !s.hasTotals) continue;
        if (fromTotals.has(folderId)) {
          g.sessionsFromTotals++;
          continue;
        }
        const others = todayFolders.get(src);
        const flags =
          live.get(`${src}|${folderId}`) === true &&
          s.windowActivity >= FORMAT_ACTIVITY &&
          s.windowUsage === 0 &&
          others !== undefined &&
          [...others].some((id) => id !== folderId);
        if (flags) silentLive = true;
        else g.sessionsWithoutUsage++;
      }
      h.state = rs.error ?? (h.unrecognized > 0 || silentLive ? "format-changed" : todayBySource.has(src) ? "ok" : "no-data");
      states.push(h.state);
      g.malformed += h.malformed;
      g.unrecognized += h.unrecognized;
      g.overlong += h.overlong;
      g.overlongOther += h.overlongOther;
      g.unreadableFiles += h.unreadableFiles;
      g.capped += rs.capped ?? 0;
      if (rs.discoverFailed === true) g.notListed++;
      sources[src] = h;
    }
    const missing = (s: SourceHealth["state"]) => s === "no-dir" || s === "permission";
    const state: HealthState =
      states.length > 0 && states.every((s) => s === "no-dir")
        ? "no-dir"
        : states.length > 0 && states.every(missing) && states.includes("permission")
          ? "permission"
          : states.includes("format-changed")
            ? "format-changed"
            : todayBySource.size === 0
              ? "no-data"
              : "ok";
    // Sources in UI order (D40).
    const ordered = Object.create(null) as Partial<Record<Source, SourceHealth>>;
    for (const s of SOURCES) if (sources[s] !== undefined) ordered[s] = sources[s];
    return {
      state,
      rootSource: this.rootSource,
      // A log with per-call records hides its session total anyway, so an unread
      // shutdown line there loses nothing (review 3); Data health still counts it.
      // A capped discovery left files unread (D42, D50): the figures miss them, so they are partial.
      // So does a folder whose last listing failed: sessions started since may be missing.
      partial: g.unreadableFiles + g.malformed + g.overlong + g.shutdownOversizeNeeded + g.capped + g.notListed > 0,
      unrecognized: g.unrecognized,
      malformed: g.malformed,
      overlong: g.overlong,
      overlongOther: g.overlongOther,
      unreadableFiles: g.unreadableFiles,
      sessionsWithoutUsage: g.sessionsWithoutUsage,
      sessionsFromTotals: g.sessionsFromTotals,
      shutdownOversize: g.shutdownOversize,
      sources: ordered,
    };
  }

  /**
   * A result kept from one snapshot to the next: `compute` runs again only when one of `deps`
   * differs from last time (a store version for the dates the computation reads, and whatever
   * else it depends on: its date range, the filter, the project labels). Every computation
   * here is a function of exactly those, so a kept result is the one a fresh run would give.
   */
  private memo<T>(b: Build, name: string, deps: readonly unknown[], compute: () => T): T {
    if (!b.reuse) return compute();
    const hit = this.kept.get(name);
    if (hit !== undefined && hit.deps.length === deps.length && deps.every((d, i) => Object.is(d, hit.deps[i]))) return hit.value as T;
    const value = compute();
    this.kept.set(name, { deps, value });
    return value;
  }

  /** Drops every kept result: the next snapshot computes each figure from the records. */
  private forget(): void {
    this.kept.clear();
    this.priorKept = undefined;
    this.lastScan = undefined;
  }

  private snapshot(nowMs: number, dayStartMs: number): Snapshot {
    const nowDate = new Date(nowMs);
    const isToday = (ms: number) => ms >= dayStartMs;
    // Unfiltered, like Today: the last 7 local days (open-ended) and the 7 before them.
    const last7Start = localDaysBefore(nowDate, 6);
    const prior7Start = localDaysBefore(nowDate, 13);
    const monthStart = localMonthStart(nowDate);
    const reading = this.reading();
    // While the first read is under way records of every date keep arriving: nothing is kept
    // until it is done, and each progress snapshot reads the whole store as before.
    const reuse = this.incremental && reading === undefined;
    if (reuse) this.store.setCuts([prior7Start, last7Start, monthStart, dayStartMs]);
    const split = reuse && this.store.keeps(dayStartMs);
    const b: Build = {
      reuse,
      split,
      dayStartMs,
      monthStartMs: monthStart,
      day: split ? this.store.from(dayStartMs) : this.store,
      month: reuse && this.store.keeps(monthStart) ? this.store.from(monthStart) : this.store,
    };
    const v = (fromMs?: number, toMs?: number) => this.store.versionOf(fromMs, toMs);

    const today = this.since(b, "today", dayStartMs, undefined, []);
    const last7 = this.since(b, "last7", last7Start, undefined, []);
    const prior7 = this.memo(b, "prior7", [v(prior7Start, last7Start), prior7Start, last7Start], () =>
      this.store.totals((r) => r.timestampMs >= prior7Start && r.timestampMs < last7Start),
    );
    const latest = this.latest(b);

    // Every candidate of every source, by folder: liveness, newest write, source. A discovery
    // replaces a reader's candidates; until one does, these stand.
    const { folders, live } = this.memo(
      b,
      "folders",
      this.readers.map((rs) => rs.candidates),
      () => {
        const folders = new Map<string, { source: Source; live: boolean; mtimeMs: number }>();
        const live = new Map<string, boolean>();
        for (const rs of this.readers) {
          for (const c of rs.candidates.values()) {
            const prev = folders.get(c.folderId);
            folders.set(c.folderId, prev === undefined ? { source: c.source, live: c.live, mtimeMs: c.mtimeMs } : { source: prev.source, live: prev.live || c.live, mtimeMs: Math.max(prev.mtimeMs, c.mtimeMs) });
            if (c.live) live.set(`${c.source}|${c.folderId}`, true);
          }
        }
        return { folders, live };
      },
    );
    // What the files say of each folder: its source, its project label, its title (`shape`
    // grows when any of that changes).
    const named = this.memo(b, "named", [this.shape, folders], () => {
      const sourceOf = new Map<string, Source>();
      for (const f of this.files.values()) if (!sourceOf.has(f.folderId)) sourceOf.set(f.folderId, f.source);
      for (const [id, c] of folders) if (!sourceOf.has(id)) sourceOf.set(id, c.source);
      // Grouping and the project filter are keyed by the project folder name only (D44).
      const projects = new Map<string, string>();
      /** the labelled files with a title, in the files' order */
      const titled: { folderId: string; label: string; title: string }[] = [];
      // Display label of a session row: its folder's title, else its project label.
      const folderTitles = new Map<string, string>();
      for (const f of this.files.values()) {
        if (f.title !== undefined) folderTitles.set(f.folderId, f.title);
        if (f.label === undefined) continue;
        if (!projects.has(f.folderId)) projects.set(f.folderId, f.label);
        if (f.title !== undefined) titled.push({ folderId: f.folderId, label: f.label, title: f.title });
      }
      return { sourceOf, projects, titled, folderTitles };
    });
    // A record whose folder is neither a file's nor a candidate's (its session id is no file's)
    // shows its own source: one pass, only when there is such a folder.
    let sourceOf = named.sourceOf;
    const orphans = new Set<string>();
    for (const id of latest.keys()) if (!sourceOf.has(id)) orphans.add(id);
    if (orphans.size > 0) {
      const found = this.memo(b, "orphans", [v(), [...orphans].sort().join("\0")], () => {
        const out = new Map<string, Source>();
        this.store.each((r) => {
          if (orphans.has(r.folderId) && !out.has(r.folderId)) out.set(r.folderId, r.source);
        });
        return out;
      });
      sourceOf = new Map(sourceOf);
      for (const [id, s] of found) sourceOf.set(id, s);
    }

    const health = this.health(isToday, live, b.day);
    if (reading !== undefined) health.reading = reading;

    const sessions = this.memo(b, "sessions.list", [latest, folders, sourceOf, monthStart], () => {
      const inMonth = [...latest].filter(([, ms]) => ms >= monthStart).map(([id]) => id);
      // Older logs in the history window are read for totals but are not "this month's" sessions.
      const recent = [...folders].filter(([, c]) => c.mtimeMs >= monthStart).map(([id]) => id);
      const ids = new Set<string>([...recent, ...inMonth]);
      return [...ids]
        .map((folderId) => {
          const lastMs = latest.get(folderId);
          const isLiveNow = folders.get(folderId)?.live === true;
          const source = sourceOf.get(folderId);
          return {
            folderId,
            ...(lastMs !== undefined && { lastMs }),
            live: isLiveNow,
            ...(source !== undefined && { source }),
          };
        })
        .sort(
          (a, b) =>
            (b.lastMs ?? -Infinity) - (a.lastMs ?? -Infinity) ||
            a.folderId.localeCompare(b.folderId),
        );
    });

    const starts = monthStarts(nowDate, this.historyMonths);
    // A title (workspace.yaml for ID-named folders, Copilot's `owner/repo`) is display-only:
    // the title of the most recently active titled session in that folder.
    const { projects, folderTitles } = named;
    const titles = new Map<string, { title: string; ms: number }>();
    for (const x of named.titled) {
      const ms = latest.get(x.folderId) ?? Number.NEGATIVE_INFINITY;
      const t = titles.get(x.label);
      if (t === undefined || ms > t.ms) titles.set(x.label, { title: x.title, ms });
    }
    // Which project each folder belongs to is part of what the kept results were computed from.
    if (projects !== this.projectsSeen) {
      if (!sameEntries(projects, this.projectsSeen)) this.labelsVersion++;
      this.projectsSeen = projects;
    }
    const projectOf = (r: UsageRecord) => projects.get(r.folderId) ?? NO_PROJECT;
    const { project, tool, source } = this.filter;
    const bySource = (r: UsageRecord) => source === undefined || r.source === source;
    // The source filter applies wherever the project filter does (D40).
    const byProject = (r: UsageRecord) => (project === undefined || projectOf(r) === project) && bySource(r);
    const byTool = (r: UsageRecord) => (tool === undefined || (r.tools?.[tool] ?? 0) > 0) && bySource(r);
    const keep = (r: UsageRecord) => byProject(r) && byTool(r);
    const f: Scope = { keep, projectOf, byProject, byTool, project, tool, source, labels: this.labelsVersion };
    const all = [project, tool, source, f.labels] as const;

    const current = starts.at(-1)!;
    // The current month under the filter: the newest history bucket, and the month view's own
    // total while the current month is viewed (both total the same records).
    const currentTotals = () => this.since(b, "month.current", current, keep, all);
    const history = this.history(b, starts, f, currentTotals);
    const month = this.monthView(b, nowDate, starts, f, currentTotals);
    // The month before the viewed one, when it is inside the window (A2): a past month
    // reuses its history bucket; the current month is compared up to the same point.
    const vi = starts.indexOf(month.monthStartMs);
    if (vi > 0) {
      const priorStart = starts[vi - 1]!;
      if (month.isCurrent) {
        // Same day of the month and local time of day (DST-safe), clamped to the month end.
        const p = new Date(priorStart);
        const lastDay = new Date(p.getFullYear(), p.getMonth() + 1, 0).getDate();
        const same = new Date(p.getFullYear(), p.getMonth(), Math.min(nowDate.getDate(), lastDay), nowDate.getHours(), nowDate.getMinutes(), nowDate.getSeconds(), nowDate.getMilliseconds()).getTime();
        const toMs = nowDate.getDate() > lastDay ? month.monthStartMs : Math.min(same, month.monthStartMs);
        const { totals, projects: priorProjects, tools } = this.priorSoFar(b, priorStart, toMs, month.monthStartMs, f);
        month.prior = { monthStartMs: priorStart, toMs, ...(totals !== undefined && { totals }), projects: priorProjects, tools };
      } else {
        const totals = history[vi - 1]?.totals;
        const end = month.monthStartMs;
        // v0.6 (2.1): the same period per project and per tool, under the tables' own filter
        // rules (projects ignore the project filter, tools the tool filter; D26).
        const tables = this.memo(b, "prior.tables", [v(priorStart, end), priorStart, end, ...all], () => ({
          projects: projectSummaries(this.store, priorStart, end, projectOf, byTool),
          tools: toolSummaries(this.store, priorStart, end, byProject),
        }));
        month.prior = { monthStartMs: priorStart, toMs: end, ...(totals !== undefined && { totals }), projects: tables.projects, tools: tables.tools };
      }
    }
    // Unfiltered per-day figures over the window: heatmap, Yesterday, 30-day bars (A2).
    const activity = this.activity(b, "activity", starts[0]!, undefined, undefined);
    const withTitle = (g: GroupSummary): GroupSummary => {
      const t = titles.get(g.name);
      return t === undefined ? g : { ...g, label: t.title };
    };
    month.projects = month.projects.map(withTitle);
    // The current month with no filter (D31): the status bar and the side bar read these.
    // Without a filter they equal the newest history bucket and the current month's
    // project table (which ignores the project filter), so those passes are reused.
    const unfiltered = project === undefined && tool === undefined && source === undefined;
    const thisMonth = unfiltered ? history.at(-1)?.totals : this.since(b, "thisMonth", current, undefined, []);
    const thisMonthProjects =
      month.isCurrent && tool === undefined && source === undefined ? month.projects : this.projectsSince(b, "thisMonth.projects", current, projectOf, undefined, [f.labels]).map(withTitle);
    // Unfiltered per-project figures for today and the last 7 days (A1 side bar): one pass,
    // or today's records alone on top of the kept sums of the six days before.
    const recentP = b.split
      ? {
          today: this.memo(b, "today.projects", [v(dayStartMs), last7Start, dayStartMs, f.labels], () => recentProjects(b.day, last7Start, dayStartMs, projectOf).today),
          last7: this.projectsSince(b, "last7.projects", last7Start, projectOf, undefined, [f.labels], true),
        }
      : this.memo(b, "recent.projects", [v(last7Start), last7Start, dayStartMs, f.labels], () => recentProjects(this.store, last7Start, dayStartMs, projectOf));
    const todayProjects = recentP.today.map(withTitle);
    const last7Projects = recentP.last7.map(withTitle);
    const labelOf = (folderId: string | undefined) => (folderId === undefined ? undefined : (folderTitles.get(folderId) ?? projects.get(folderId)));
    // The rows, the ledger and the insights may be kept from an earlier snapshot: a label goes on a copy.
    const rows = month.sessions;
    month.sessions = rows.map((x) => {
      const label = labelOf(x.folderId);
      return label === undefined ? x : { ...x, label };
    });
    if (month.detail) {
      const label = labelOf(month.sessions.find((x) => x.sessionId === month.detail!.sessionId)?.folderId ?? month.detail.sessionId);
      if (label !== undefined) month.detail = { ...month.detail, label };
    }
    if (month.insights?.items.some((i) => i.id === "context-growth")) {
      month.insights = {
        ...month.insights,
        items: month.insights.items.map((i) => {
          if (i.id !== "context-growth") return i;
          const top = i.top.map((t) => {
            const label = labelOf(month.sessions.find((x) => x.sessionId === t.sessionId)?.folderId ?? t.sessionId);
            return label === undefined ? t : { ...t, label };
          });
          return { ...i, top };
        }),
      };
    }
    const filter = unfiltered ? undefined : { ...this.filter };
    // v0.11.1: the panel's Today, Last 7 days, daily activity and current session follow the
    // source filter (only). Built only while one is set; the status bar and side bar keep the above.
    let sourceScope: SourceScope | undefined;
    if (source !== undefined) {
      const ofSource = (r: UsageRecord) => r.source === source;
      const sToday = this.since(b, "scope.today", dayStartMs, ofSource, [source]);
      const sLast7 = this.since(b, "scope.last7", last7Start, ofSource, [source]);
      const sPrior7 = this.memo(b, "scope.prior7", [v(prior7Start, last7Start), prior7Start, last7Start, source], () =>
        this.store.totals((r) => r.source === source && r.timestampMs >= prior7Start && r.timestampMs < last7Start),
      );
      const sCurrent = this.current(b, latest, folders, sourceOf, source).current;
      sourceScope = {
        source,
        ...(sToday !== undefined && { today: sToday }),
        ...(sLast7 !== undefined && { last7: sLast7 }),
        ...(sPrior7 !== undefined && { prior7: sPrior7 }),
        activity: this.activity(b, "scope.activity", starts[0]!, (r) => r.source === source, source),
        ...(sCurrent !== undefined && { current: sCurrent }),
      };
    }
    this.lastBuildMs = nowMs;
    this.priorFollowsClock = month.isCurrent && month.prior !== undefined;

    return {
      generatedAtMs: nowMs,
      dayStartMs,
      ...(today !== undefined && { today }),
      ...this.current(b, latest, folders, sourceOf),
      sessions,
      health,
      month,
      history,
      ...(filter && { filter }),
      ...(last7 !== undefined && { last7 }),
      ...(prior7 !== undefined && { prior7 }),
      ...(thisMonth !== undefined && { thisMonth }),
      thisMonthProjects,
      activity,
      todayProjects,
      last7Projects,
      ...(sourceScope && { sourceScope }),
    };
  }

  /**
   * Totals of the records dated from `fromMs` on that pass `keep` (every one when undefined;
   * `deps` names what `keep` depends on). They are sums and counts, so when results are kept
   * the days before today are added once and kept, and today's records are added on top.
   */
  private since(b: Build, name: string, fromMs: number, keep: ((r: UsageRecord) => boolean) | undefined, deps: readonly unknown[]): Totals | undefined {
    const day = b.dayStartMs;
    const test = (r: UsageRecord) => r.timestampMs >= fromMs && (keep === undefined || keep(r));
    if (!b.split) return this.memo(b, name, [this.store.versionOf(fromMs), fromMs, ...deps], () => this.store.totals(test));
    const ended = this.memo(b, `${name}.ended`, [this.store.versionOf(fromMs, day), fromMs, day, ...deps], () => (fromMs < day ? this.store.totals((r) => r.timestampMs < day && test(r)) : undefined));
    return this.memo(b, name, [ended, this.store.versionOf(day), fromMs, day, ...deps], () => b.day.totals(test, ended));
  }

  /** Per-project totals of the records dated from `fromMs` on that pass `keep`, costliest first; kept like `since`. */
  private projectsSince(
    b: Build,
    name: string,
    fromMs: number,
    projectOf: (r: UsageRecord) => string,
    keep: ((r: UsageRecord) => boolean) | undefined,
    deps: readonly unknown[],
    sessionTotals = false,
  ): GroupSummary[] {
    const day = b.dayStartMs;
    const open = Number.POSITIVE_INFINITY;
    if (!b.split) return this.memo(b, name, [this.store.versionOf(fromMs), fromMs, ...deps], () => projectSummaries(this.store, fromMs, open, projectOf, keep));
    const ended = this.memo(b, `${name}.ended`, [this.store.versionOf(fromMs, day), fromMs, day, ...deps], () => projectGroups(this.store, fromMs, day, projectOf, keep, { sessionTotals }));
    return this.memo(b, name, [ended, this.store.versionOf(day), fromMs, day, ...deps], () => groupSummaries(projectGroups(b.day, Math.max(fromMs, day), open, projectOf, keep, { seed: ended, sessionTotals })));
  }

  /** Per-tool totals of the records dated from `fromMs` on that pass `keep`, costliest first; kept like `since`. */
  private toolsSince(b: Build, name: string, fromMs: number, keep: (r: UsageRecord) => boolean, deps: readonly unknown[]): ToolSummary[] {
    const day = b.dayStartMs;
    const open = Number.POSITIVE_INFINITY;
    if (!b.split) return this.memo(b, name, [this.store.versionOf(fromMs), fromMs, ...deps], () => toolSummaries(this.store, fromMs, open, keep));
    const ended = this.memo(b, `${name}.ended`, [this.store.versionOf(fromMs, day), fromMs, day, ...deps], () => toolGroups(this.store, fromMs, day, keep));
    return this.memo(b, name, [ended, this.store.versionOf(day), fromMs, day, ...deps], () => toolRows(toolGroups(b.day, Math.max(fromMs, day), open, keep, ended)));
  }

  /**
   * folderId → its newest record's time. One pass over every record gives it; when results
   * are kept, the days before today are, and only today's records are read again. The two
   * hold the same times, but their folders may be listed in another order than one pass
   * lists them, so a caller that depends on that order asks the store itself (see `current`).
   */
  private latest(b: Build): Map<string, number> {
    const day = b.dayStartMs;
    return this.memo(b, "latest", [this.store.versionOf(), b.split], () => {
      if (!b.split) return this.store.latest();
      const before = this.memo(b, "latest.before", [this.store.versionOf(Number.NEGATIVE_INFINITY, day), day], () => this.store.latest((r) => r.timestampMs < day));
      const out = new Map(before);
      for (const [id, ms] of b.day.latest()) {
        const prev = out.get(id);
        if (prev === undefined || ms > prev) out.set(id, ms);
      }
      return out;
    });
  }

  /** Every session id and folder id a record dated before `cutMs` (today's start or this month's) carries. */
  private namedBefore(b: Build, cutMs: number): Set<string> {
    return this.memo(b, cutMs === b.dayStartMs ? "named.day" : "named.month", [this.store.versionOf(Number.NEGATIVE_INFINITY, cutMs), cutMs], () => {
      const out = new Set<string>();
      this.store.each((r) => {
        if (r.timestampMs >= cutMs) return;
        out.add(r.sessionId);
        out.add(r.folderId);
      });
      return out;
    });
  }

  /**
   * The prompt convention per model and each session's first call, over every call record.
   * The calls before today are scanned once and kept; today's continue that scan, and when
   * that cannot tell what one pass over them all would find (`extendScan`), one pass is made.
   * A scan that finds what the last one found is the last one, so whatever was computed from
   * it is still good.
   */
  private scan(b: Build): CallScan {
    const day = b.dayStartMs;
    const calls = (r: UsageRecord) => r.kind === "call";
    return this.memo(b, "scan", [this.store.versionOf(), b.split], () => {
      const every = () => scanCalls(this.store.records(calls));
      const before = b.split ? this.memo(b, "scan.before", [this.store.versionOf(Number.NEGATIVE_INFINITY, day), day], () => scanCalls(this.store.records((r) => calls(r) && r.timestampMs < day))) : undefined;
      const next = before === undefined ? every() : (extendScan(before, b.day.records(calls)) ?? every());
      const last = this.lastScan;
      if (last !== undefined && sameEntries(last.conventions, next.conventions) && last.firsts.size === next.firsts.size && [...next.firsts].every((k) => last.firsts.has(k))) return last;
      return (this.lastScan = { conventions: next.conventions, firsts: next.firsts });
    });
  }

  /** Totals per month of the window. A month that has ended is kept until one of its records
   * changes; the current month's bucket is `currentTotals`. */
  private history(b: Build, starts: number[], f: Scope, currentTotals: () => Totals | undefined): MonthSummary[] {
    if (!b.reuse) return byMonth(this.store, starts, f.keep);
    const current = starts.at(-1)!;
    const ended = this.memo(b, "history.ended", [this.store.versionOf(Number.NEGATIVE_INFINITY, current), starts.join(), f.project, f.tool, f.source, f.labels], () => byMonth(this.store, starts, f.keep).slice(0, -1));
    const totals = currentTotals();
    return [...ended, totals === undefined ? { monthStartMs: current } : { monthStartMs: current, totals }];
  }

  /** Days 1..today of the current month. A day's totals come from that day's records alone,
   * so the days before today are kept and only today's bucket is read again. */
  private days(b: Build, monthStartMs: number, today: number, f: Scope): DayTotals[] {
    const deps = [monthStartMs, today, f.project, f.tool, f.source, f.labels];
    if (!b.split) return this.memo(b, "days", [this.store.versionOf(monthStartMs), ...deps], () => daysOfMonth(this.store, monthStartMs, today, true, f.keep));
    const ended = this.memo(b, "days.ended", [this.store.versionOf(monthStartMs, b.dayStartMs), ...deps], () => (today > 1 ? daysOfMonth(this.store, monthStartMs, today - 1, false, f.keep) : []));
    const last = this.memo(b, "days.today", [this.store.versionOf(b.dayStartMs), ...deps], () => daysOfMonth(b.day, monthStartMs, today, true, f.keep).at(-1)!);
    return [...ended, last];
  }

  /** Per-day figures from `fromMs` through today (`keep`, named by `keepKey`, narrows them).
   * Each day's figures come from that day's records alone: the days before today are kept. */
  private activity(b: Build, name: string, fromMs: number, keep: ((r: UsageRecord) => boolean) | undefined, keepKey: string | undefined): Activity {
    const day = b.dayStartMs;
    if (!b.split) return this.memo(b, name, [this.store.versionOf(), fromMs, day, keepKey], () => dailyActivity(this.store, fromMs, day, keep));
    const before = this.memo(b, `${name}.before`, [this.store.versionOf(Number.NEGATIVE_INFINITY, day), fromMs, day, keepKey], () =>
      dailyActivity(this.store, fromMs, day, (r) => r.timestampMs < day && (keep === undefined || keep(r))),
    );
    const today = this.memo(b, `${name}.today`, [this.store.versionOf(day), fromMs, day, keepKey], () => dailyActivity(b.day, fromMs, day, keep));
    return this.memo(b, name, [before, today], () => ({ fromMs: before.fromMs, days: [...before.days, ...today.days] }));
  }

  /**
   * The month before the current one up to the same point (`toMs`), under the filter: its
   * totals and its project and tool tables. `toMs` follows the clock, but the figures change
   * only when it passes a record: the kept ones stand while no record of that month is dated
   * between the `toMs` they were computed for and this one, and none of its records changed.
   */
  private priorSoFar(b: Build, priorStart: number, toMs: number, monthStartMs: number, f: Scope): { totals: Totals | undefined; projects: GroupSummary[]; tools: ToolSummary[] } {
    const deps = [this.store.versionOf(priorStart, monthStartMs), priorStart, monthStartMs, f.project, f.tool, f.source, f.labels];
    const hit = this.priorKept;
    if (b.reuse && hit !== undefined && hit.deps.every((d, i) => Object.is(d, deps[i])) && toMs > hit.afterMs && toMs <= hit.untilMs) return hit.value;
    // The newest record time before `toMs` and the oldest from it on, among that month's records.
    let afterMs = Number.NEGATIVE_INFINITY;
    let untilMs = Number.POSITIVE_INFINITY;
    const totals = this.store.totals((r) => {
      const ts = r.timestampMs;
      if (ts < priorStart || ts >= monthStartMs) return false;
      if (ts >= toMs) {
        if (ts < untilMs) untilMs = ts;
        return false;
      }
      if (ts > afterMs) afterMs = ts;
      return f.keep(r);
    });
    // v0.6 (2.1): the same period per project and per tool, under the tables' own filter
    // rules (projects ignore the project filter, tools the tool filter; D26).
    const value = { totals, projects: projectSummaries(this.store, priorStart, toMs, f.projectOf, f.byTool), tools: toolSummaries(this.store, priorStart, toMs, f.byProject) };
    if (b.reuse) this.priorKept = { deps, afterMs, untilMs, value };
    return value;
  }

  /** The viewed month: the selected one if it is a past month in the window, else this month. */
  private monthView(b: Build, nowDate: Date, starts: number[], f: Scope, currentTotals: () => Totals | undefined): MonthView {
    const { keep, projectOf, byProject, byTool } = f;
    const v = (fromMs: number, toMs?: number) => this.store.versionOf(fromMs, toMs);
    const all = [f.project, f.tool, f.source, f.labels] as const;
    const current = starts.at(-1)!;
    const sel = this.selectedMonth;
    const past = sel !== undefined && sel !== current && starts.includes(sel) ? sel : undefined;
    if (past === undefined) {
      const inCurrent = (r: UsageRecord) => r.timestampMs >= current && r.timestampMs <= nowDate.getTime() + DAY_SLACK_MS && keep(r);
      const totals = b.reuse ? currentTotals() : this.store.totals(inCurrent);
      return {
        monthStartMs: current,
        isCurrent: true,
        days: this.days(b, current, nowDate.getDate(), f),
        ...this.sessionsAndInsights(b, b.month, current, Number.POSITIVE_INFINITY, f, copilotNano(totals)),
        projects: this.projectsSince(b, "month.projects", current, projectOf, byTool, [f.tool, f.source, f.labels]),
        tools: this.toolsSince(b, "month.tools", current, byProject, [f.project, f.source, f.labels]),
        ...(totals !== undefined && { totals }),
      };
    }
    const first = new Date(past);
    const end = new Date(first.getFullYear(), first.getMonth() + 1, 1).getTime();
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const inPast = (r: UsageRecord) => r.timestampMs >= past && r.timestampMs < end && keep(r);
    const totals = this.memo(b, "month.past", [v(past, end), past, end, ...all], () => this.store.totals(inPast));
    return {
      monthStartMs: past,
      isCurrent: false,
      days: this.memo(b, "month.past.days", [v(past, end), past, end, ...all], () => daysOfMonth(this.store, past, lastDay, false, keep)),
      ...this.sessionsAndInsights(b, this.store, past, end, f, copilotNano(totals)),
      projects: this.memo(b, "month.past.projects", [v(past, end), past, end, f.tool, f.source, f.labels], () => projectSummaries(this.store, past, end, projectOf, byTool)),
      tools: this.memo(b, "month.past.tools", [v(past, end), past, end, f.project, f.source, f.labels], () => toolSummaries(this.store, past, end, byProject)),
      ...(totals !== undefined && { totals }),
    };
  }

  /** Session rows (at most SESSION_ROWS), the session counts and the insights for [fromMs, toMs),
   * read from `src` (the whole store, or its records from `fromMs` on). */
  private sessionsAndInsights(
    b: Build,
    src: RecordSource,
    fromMs: number,
    toMs: number,
    f: Scope,
    monthNanoAiu: number,
  ): Pick<MonthView, "sessions" | "sessionCount" | "sessionsBySource" | "totalsSessions" | "insights" | "cache" | "prompts" | "cacheCost" | "modelCache" | "toolOverhead" | "detail"> {
    const { keep, byProject } = f;
    const sel = this.selectedSession;
    // The prompt convention and each session's first call come from every call read, whatever the month.
    const scan = b.reuse ? this.scan(b) : undefined;
    return this.memo(b, "month.sessions", [this.store.versionOf(fromMs, toMs), fromMs, toMs, f.project, f.tool, f.source, f.labels, sel, scan, monthNanoAiu], () => {
      const calls = src.records((r) => r.kind === "call");
      // The cache-read share uses the same per-model prompt convention as Insights (N4).
      const conventions = scan?.conventions ?? promptConventions(calls);
      const all: SessionSummary[] = b.split && fromMs === b.monthStartMs && toMs === Number.POSITIVE_INFINITY ? this.sessionRows(b, f, conventions) : sessionSummaries(src, fromMs, toMs, Number.POSITIVE_INFINITY, keep, conventions);
      // Sessions per source over every session of the month, before the SESSION_ROWS cut.
      const sessionsBySource = Object.create(null) as Partial<Record<Source, number>>;
      for (const x of all) if (x.source !== undefined) sessionsBySource[x.source] = (sessionsBySource[x.source] ?? 0) + 1;
      const inMonth = (r: UsageRecord) => r.timestampMs >= fromMs && r.timestampMs < toMs;
      // The tools table ignores the tool filter, so its "no tool data" note counts totals by project only.
      const totalsSessions = new Set(src.records((r) => r.kind === "sessionTotal" && inMonth(r) && byProject(r)).map((r) => r.sessionId)).size;
      const monthCalls = calls.filter((r) => inMonth(r) && keep(r));
      const insights = computeInsights({ sessions: all, monthRecords: monthCalls, monthNanoAiu, ...(scan !== undefined ? { scan } : { allRecords: calls }) });
      // v0.6: prompts follow the project filter only (a tool filter would cut a prompt's chain).
      const projectCalls = calls.filter((r) => inMonth(r) && byProject(r));
      const prompts = promptStats(projectCalls);
      const explain: Pick<MonthView, "prompts" | "cacheCost" | "modelCache" | "toolOverhead" | "detail"> = {
        ...(projectCalls.length > 0 && { prompts }),
        ...(monthCalls.length > 0 && { cacheCost: cacheStats(monthCalls, conventions), modelCache: modelCacheStats(monthCalls, conventions), toolOverhead: toolOverhead(monthCalls, conventions) }),
      };
      if (sel !== undefined) {
        // The ledger lists every call of the session in the viewed month (project filter only, like prompts).
        const recs = src.records((r) => r.sessionId === sel && inMonth(r) && byProject(r));
        explain.detail = sessionDetail(sel, recs, conventions);
      }
      // The cache-reuse ring (A2) sums every session of the month, not only the rows kept.
      const prompt = { sum: 0, reported: 0, missing: 0 };
      const cacheRead = { sum: 0, reported: 0, missing: 0 };
      for (const x of all) {
        for (const [into, from] of [[prompt, x.input], [cacheRead, x.cacheRead]] as const) {
          if (!from) continue;
          into.sum += from.sum;
          into.reported += from.reported;
          into.missing += from.missing;
        }
      }
      const cache = prompt.reported > 0 || cacheRead.reported > 0 ? { cache: { prompt, cacheRead } } : {};
      return { sessions: all.slice(0, SESSION_ROWS), sessionCount: all.length, sessionsBySource, totalsSessions, insights, ...cache, ...explain };
    });
  }

  /**
   * Every session of the current month under the filter, costliest first. A session's row
   * comes from its own records alone, so the rows of the sessions with no record today are
   * kept (from the records before today), and only the sessions with one are worked out
   * again, each from all its records of the month in the store's order.
   */
  private sessionRows(b: Build, f: Scope, conventions: CallScan["conventions"]): SessionSummary[] {
    const fromMs = b.monthStartMs;
    const day = b.dayStartMs;
    const open = Number.POSITIVE_INFINITY;
    const ended = this.memo(b, "sessions.ended", [this.store.versionOf(fromMs, day), fromMs, day, f.project, f.tool, f.source, f.labels, conventions], () =>
      sessionSummaries(this.store, fromMs, day, open, f.keep, conventions),
    );
    const today = new Set<string>();
    b.day.each((r) => today.add(r.sessionId));
    if (today.size === 0) return ended;
    const theirs = b.month.records((r) => today.has(r.sessionId));
    const rows = sessionSummaries({ records: (filter) => theirs.filter(filter) }, fromMs, open, open, f.keep, conventions);
    return [...ended.filter((x) => !today.has(x.sessionId)), ...rows].sort(bySessionCost);
  }

  /**
   * Pinned folder; else a PID-live Copilot session with the newest record, then any
   * mtime-live session the same way; else the folder with the newest record today (D43).
   */
  private current(
    b: Build,
    latest: Map<string, number>,
    folders: Map<string, { source: Source; live: boolean; mtimeMs: number }>,
    sourceOf: Map<string, Source>,
    only?: Source,
  ): Pick<Snapshot, "current"> {
    const dayStartMs = b.dayStartMs;
    // With `only` (the panel's source scope, v0.11.1), every choice is limited to that source.
    const ofSource = (id: string) => only === undefined || (folders.get(id)?.source ?? sourceOf.get(id)) === only;
    let folderId = this.pinned !== undefined && ofSource(this.pinned) ? this.pinned : undefined;
    const pinned = folderId !== undefined;
    const pick = (copilot: boolean): string | undefined => {
      const live = [...folders].filter(([, c]) => c.live && (c.source === "copilot") === copilot && (only === undefined || c.source === only));
      const key = (id: string) => latest.get(id) ?? -Infinity;
      live.sort(([a, ca], [b, cb]) => key(b) - key(a) || cb.mtimeMs - ca.mtimeMs);
      return live[0]?.[0];
    };
    if (folderId === undefined) folderId = pick(true) ?? pick(false);
    if (folderId === undefined) {
      // The first folder with the newest time wins, in the order the times are listed.
      const newest = (times: Map<string, number>): { id: string | undefined; tied: boolean } => {
        let bestMs = -Infinity;
        let id: string | undefined;
        let tied = false;
        for (const [k, ms] of times) {
          if (ms < dayStartMs || ms < bestMs || !ofSource(k)) continue;
          if (ms > bestMs) {
            bestMs = ms;
            id = k;
            tied = false;
          } else tied = true;
        }
        return { id, tied };
      };
      let found = newest(latest);
      // Two folders share the newest time: one pass over the store lists them in its own
      // order (`latest` may not), so that pass decides.
      if (found.tied && b.split) found = newest(this.store.latest());
      folderId = found.id;
    }
    if (folderId === undefined) return {};
    const id = folderId;
    // The folder's own records count too: a resumed or forked session's calls can name another
    // session id than the folder they are written in (review #5).
    const mine = (r: UsageRecord) => r.sessionId === id || r.folderId === id;
    // Kept between snapshots: the session's records are read in one pass, and its totals, last
    // prompt and (below) source come from that list in the same order.
    const kept = b.reuse
      ? this.memo(b, `current.${only ?? ""}`, [this.store.versionOf(), id], () => {
          // A session no record before today (or before this month) names has all its records
          // in today's (or this month's) list, in the order one pass over the store meets them.
          const src = !b.split ? this.store : !this.namedBefore(b, b.dayStartMs).has(id) ? b.day : !this.namedBefore(b, b.monthStartMs).has(id) ? b.month : this.store;
          const recs = src.records(mine);
          return { totals: totalsOf(recs), last: lastPrompt(recs.filter((r) => r.kind === "call")), source: recs[0]?.source };
        })
      : undefined;
    const totals = kept !== undefined ? kept.totals : this.store.totals(mine);
    const live = folders.get(id)?.live === true;
    const last = kept !== undefined ? kept.last : lastPrompt(this.store.records((r) => r.kind === "call" && mine(r)));
    // The candidate's source, else its files', else (a folder only records name) the records' own (fix wave F2).
    let source: Source | undefined = folders.get(id)?.source;
    if (source === undefined) for (const f of this.files.values()) if (f.folderId === id) source = f.source;
    if (source === undefined) source = sourceOf.get(id);
    if (source === undefined) {
      if (kept !== undefined) source = kept.source;
      else
        this.store.each((r) => {
          if (source === undefined && (r.folderId === id || r.sessionId === id)) source = r.source;
        });
    }
    return {
      current: {
        folderId: id,
        live,
        pinned,
        ...(totals !== undefined && { totals }),
        ...(last !== undefined && { lastPrompt: last }),
        ...(source !== undefined && { source }),
      },
    };
  }

  private emit(s: Snapshot): void {
    const signature = JSON.stringify({ ...s, generatedAtMs: 0 });
    if (signature === this.lastSignature) return;
    if (this.disposed) return;
    try {
      this.onSnapshot(s);
    } catch (err) {
      // The next tick rebuilds and delivers again, even if nothing else changed.
      this.dirty = true;
      throw err;
    }
    // Only after delivery: a callback that threw gets the same snapshot next time (v0.7).
    this.lastSignature = signature;
  }
}
