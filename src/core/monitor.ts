// Ties the source readers (D54), the store and health together and emits a
// Snapshot whenever what it would show changes. Missing data stays undefined,
// incomplete data sets `health.partial`, and only counts, codes and timings are
// logged: never a path, never a root.
import { ClaudeSourceReader } from "./claude";
import { CodexSourceReader } from "./codex";
import { CopilotSourceReader } from "./copilot";
import { isLive as realIsLive } from "./discover";
import { parseUsageLine } from "./extract";
import type { Logger } from "./log";
import { sep } from "node:path";
import { cacheStats, lastPrompt, modelCacheStats, promptStats, sessionDetail, toolOverhead } from "./explain";
import { computeInsights, promptConventions } from "./insights";
import { RECENT_MS, type FileReader, type FileReadResult, type SourceCandidate, type SourceDiscoverResult, type SourceFile, type SourceReader } from "./source";
import { byMonth, dailyActivity, daysOfMonth, localDayStart, localDaysBefore, localMonthStart, monthStarts, NO_PROJECT, projectSummaries, recentProjects, sessionSummaries, toolSummaries, UsageStore } from "./store";
import type { ReadErrorCode } from "./tailer";
import { isSource, SOURCES, type Filter, type GroupSummary, type Health, type HealthState, type MonthView, type SessionSummary, type Snapshot, type Source, type SourceHealth, type UsageRecord } from "./types";

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

/** One enabled source: its reader and what its last discovery found. */
interface ReaderState {
  reader: SourceReader;
  discovered: boolean;
  lastDiscoverAt: number;
  lastDirMtimeMs: number | undefined;
  error: "no-dir" | "permission" | undefined;
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
  private disposed = false;
  /** set when something other than new lines can change the snapshot */
  private dirty = true;

  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | undefined;
  private wantFull = false;

  constructor(o: MonitorOptions) {
    this.rootSource = o.rootSource;
    this.now = o.now ?? (() => new Date());
    this.log = o.log;
    this.onSnapshot = o.onSnapshot;
    this.historyMonths = clampHistory(o.historyMonths ?? 1);
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
      // A full refresh (a command, a settings change) always rebuilds the snapshot.
      let changed = full || this.dirty || dayStartMs !== this.lastDayStartMs;
      this.dirty = false;
      for (const rs of this.readers) {
        if (await this.shouldDiscover(rs, full, nowMs, dayStartMs)) {
          if (await this.rediscover(rs, nowMs, dayStartMs)) changed = true;
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

  private async shouldDiscover(rs: ReaderState, full: boolean, nowMs: number, dayStartMs: number): Promise<boolean> {
    if (full || !rs.discovered || rs.error !== undefined) return true;
    if (dayStartMs !== this.lastDayStartMs) return true;
    if (Math.abs(nowMs - rs.lastDiscoverAt) >= REDISCOVER_MS) return true;
    return (await rs.reader.rootDirMtime()) !== rs.lastDirMtimeMs;
  }

  /** What a discovery found, as one string: error, candidate files, unreadable and refused paths, extras. */
  private fingerprint(rs: ReaderState): string {
    if (rs.error !== undefined) return rs.error;
    const files: string[] = [];
    for (const c of rs.candidates.values()) for (const f of c.files) files.push(`${f.path}\0${c.sessionId}\0${f.mtimeMs}\0${f.size}\0${c.live ? 1 : 0}`);
    files.sort();
    return JSON.stringify([files, [...rs.unreadable].sort(), [...rs.refused].sort(), rs.capped ?? null, rs.archived ?? null]);
  }

  /** Discovers one reader's files; true when the outcome differs from the last discovery's. */
  private async rediscover(rs: ReaderState, nowMs: number, dayStartMs: number): Promise<boolean> {
    this.discoverOnce(rs, await rs.reader.discover(monthStarts(new Date(nowMs), this.historyMonths)[0]!, dayStartMs, nowMs), nowMs);
    const fp = this.fingerprint(rs);
    if (fp === rs.fingerprint) return false;
    rs.fingerprint = fp;
    return true;
  }

  private discoverOnce(rs: ReaderState, result: SourceDiscoverResult, nowMs: number): void {
    const reader = rs.reader;
    rs.discovered = true;
    rs.lastDiscoverAt = nowMs;
    if (!result.ok) {
      rs.lastDirMtimeMs = undefined;
      if (result.error === "OTHER") {
        this.log.error("discover", "OTHER");
        return; // keep the last known candidates and state
      }
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
    // A root that recovers re-reads its files once, so errors of the locked period clear.
    if (rs.error !== undefined) for (const f of this.files.values()) if (f.source === reader.source) f.changed = true;
    rs.error = undefined;
    rs.lastDirMtimeMs = result.dirMtimeMs;
    if (result.capped !== undefined) rs.capped = result.capped;
    else delete rs.capped;
    if (result.archived !== undefined) rs.archived = result.archived;
    else delete rs.archived;
    // One candidate per session: files of the same session id join it.
    const candidates = new Map<string, SourceCandidate>();
    for (const c of result.candidates) {
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
    for (const [path, f] of [...this.files]) {
      if (f.source !== reader.source || keep.has(path)) continue;
      this.files.delete(path);
      this.store.resetFile(path);
    }
    const refused = new Set<string>();
    const hotSinceMs = nowMs - RECENT_MS;
    for (const [path, { c, mtimeMs, size }] of inWindow) {
      const f = this.files.get(path);
      if (f !== undefined) {
        if (mtimeMs !== f.lastMtimeMs || size !== f.lastSize) f.changed = true;
        f.lastMtimeMs = mtimeMs;
        f.lastSize = size;
        f.hot = mtimeMs >= hotSinceMs;
        continue;
      }
      // Only a path the reader itself vouches for is ever opened.
      if (!reader.pathAllowed(path)) {
        refused.add(path);
        if (!rs.refused.has(path)) this.log.error("discover", "PATH_REFUSED");
        continue;
      }
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
        windowActivity: 0,
        windowUsage: 0,
        lastMtimeMs: mtimeMs,
        lastSize: size,
        hot: mtimeMs >= hotSinceMs,
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
      f.activity = f.usage = f.windowActivity = f.windowUsage = 0;
      f.primed = false;
    }
    const inWindow = f.primed;
    if (r.label !== undefined && r.label !== f.label) {
      f.label = r.label;
      this.dirty = true;
    }
    // A title is reported only when it changes; null clears it.
    if (r.title !== undefined && (r.title ?? undefined) !== f.title) {
      if (r.title === null) delete f.title;
      else f.title = r.title;
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
  private health(isToday: (ms: number) => boolean, live: Map<string, boolean>): Health {
    const fromTotals = this.store.sessionTotalSessions();
    // Records dated today, per source and per (source, folder), for the no-data and silent-live rules.
    const todayBySource = new Set<Source>();
    const todayFolders = new Map<Source, Set<string>>();
    this.store.each((r) => {
      if (!isToday(r.timestampMs)) return;
      todayBySource.add(r.source);
      let s = todayFolders.get(r.source);
      if (!s) todayFolders.set(r.source, (s = new Set()));
      s.add(r.folderId);
    });
    const sources = Object.create(null) as Partial<Record<Source, SourceHealth>>;
    const g = { malformed: 0, unrecognized: 0, overlong: 0, overlongOther: 0, shutdownOversize: 0, shutdownOversizeNeeded: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0 };
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
        // An unreadable directory (a listing that failed) counts as one file here.
        unreadableFiles: rs.unreadable.size + rs.refused.size,
        unrecognized: 0,
        malformed: 0,
        overlong: 0,
        overlongOther: 0,
        ...(rs.capped !== undefined && { capped: rs.capped }),
        ...(rs.archived !== undefined && { archived: rs.archived }),
      };
      /** per session: the files' activity and usage summed (a Claude session has several files) */
      const sessions = new Map<string, { activity: number; usage: number; hasTotals: boolean; windowActivity: number; windowUsage: number }>();
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
        const s = sessions.get(f.folderId) ?? { activity: 0, usage: 0, hasTotals: false, windowActivity: 0, windowUsage: 0 };
        s.activity += f.activity;
        s.usage += f.usage;
        s.hasTotals ||= f.hasTotals;
        s.windowActivity += f.windowActivity;
        s.windowUsage += f.windowUsage;
        sessions.set(f.folderId, s);
      }
      let silentLive = false;
      for (const [folderId, s] of sessions) {
        if ((s.activity === 0 && !s.hasTotals) || s.usage > 0) continue;
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
      partial: g.unreadableFiles + g.malformed + g.overlong + g.shutdownOversizeNeeded > 0,
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

  private snapshot(nowMs: number, dayStartMs: number): Snapshot {
    const isToday = (ms: number) => ms >= dayStartMs;
    const today = this.store.totals((r) => isToday(r.timestampMs));
    // Unfiltered, like Today: the last 7 local days (open-ended) and the 7 before them.
    const last7Start = localDaysBefore(new Date(nowMs), 6);
    const prior7Start = localDaysBefore(new Date(nowMs), 13);
    const last7 = this.store.totals((r) => r.timestampMs >= last7Start);
    const prior7 = this.store.totals((r) => r.timestampMs >= prior7Start && r.timestampMs < last7Start);
    const latest = this.store.latest();

    // Every candidate of every source, by folder: liveness, newest write, source.
    const folders = new Map<string, { source: Source; live: boolean; mtimeMs: number }>();
    const live = new Map<string, boolean>();
    for (const rs of this.readers) {
      for (const c of rs.candidates.values()) {
        const prev = folders.get(c.folderId);
        folders.set(c.folderId, prev === undefined ? { source: c.source, live: c.live, mtimeMs: c.mtimeMs } : { source: prev.source, live: prev.live || c.live, mtimeMs: Math.max(prev.mtimeMs, c.mtimeMs) });
        if (c.live) live.set(`${c.source}|${c.folderId}`, true);
      }
    }
    const sourceOf = new Map<string, Source>();
    for (const f of this.files.values()) if (!sourceOf.has(f.folderId)) sourceOf.set(f.folderId, f.source);
    for (const [id, c] of folders) if (!sourceOf.has(id)) sourceOf.set(id, c.source);

    const health = this.health(isToday, live);
    const reading = this.reading();
    if (reading !== undefined) health.reading = reading;

    const monthStart = localMonthStart(new Date(nowMs));
    const inMonth = [...latest].filter(([, ms]) => ms >= monthStart).map(([id]) => id);
    // Older logs in the history window are read for totals but are not "this month's" sessions.
    const recent = [...folders].filter(([, c]) => c.mtimeMs >= monthStart).map(([id]) => id);
    const ids = new Set<string>([...recent, ...inMonth]);
    const sessions = [...ids]
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

    const nowDate = new Date(nowMs);
    const starts = monthStarts(nowDate, this.historyMonths);
    // Grouping and the project filter are keyed by the project folder name only (D44).
    // A title (workspace.yaml for ID-named folders, Copilot's `owner/repo`) is display-only:
    // the title of the most recently active titled session in that folder.
    const projects = new Map<string, string>();
    const titles = new Map<string, { title: string; ms: number }>();
    for (const f of this.files.values()) {
      if (f.label === undefined) continue;
      if (!projects.has(f.folderId)) projects.set(f.folderId, f.label);
      if (f.title === undefined) continue;
      const ms = latest.get(f.folderId) ?? Number.NEGATIVE_INFINITY;
      const t = titles.get(f.label);
      if (t === undefined || ms > t.ms) titles.set(f.label, { title: f.title, ms });
    }
    const projectOf = (r: UsageRecord) => projects.get(r.folderId) ?? NO_PROJECT;
    const { project, tool, source } = this.filter;
    const bySource = (r: UsageRecord) => source === undefined || r.source === source;
    // The source filter applies wherever the project filter does (D40).
    const byProject = (r: UsageRecord) => (project === undefined || projectOf(r) === project) && bySource(r);
    const byTool = (r: UsageRecord) => (tool === undefined || (r.tools?.[tool] ?? 0) > 0) && bySource(r);
    const keep = (r: UsageRecord) => byProject(r) && byTool(r);
    const history = byMonth(this.store, starts, keep);
    const month = this.monthView(nowDate, starts, keep, projectOf, byProject, byTool);
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
        const totals = this.store.totals((r) => r.timestampMs >= priorStart && r.timestampMs < toMs && keep(r));
        month.prior = { monthStartMs: priorStart, toMs, ...(totals !== undefined && { totals }) };
      } else {
        const totals = history[vi - 1]?.totals;
        month.prior = { monthStartMs: priorStart, toMs: month.monthStartMs, ...(totals !== undefined && { totals }) };
      }
      // v0.6 (2.1): the same period per project and per tool, under the tables' own filter
      // rules (projects ignore the project filter, tools the tool filter; D26).
      month.prior.projects = projectSummaries(this.store, priorStart, month.prior.toMs, projectOf, byTool);
      month.prior.tools = toolSummaries(this.store, priorStart, month.prior.toMs, byProject);
    }
    // Unfiltered per-day figures over the window: heatmap, Yesterday, 30-day bars (A2).
    const activity = dailyActivity(this.store, starts[0]!, dayStartMs);
    const withTitle = (g: GroupSummary): GroupSummary => {
      const t = titles.get(g.name);
      return t === undefined ? g : { ...g, label: t.title };
    };
    month.projects = month.projects.map(withTitle);
    // The current month with no filter (D31): the status bar and the side bar read these.
    // Without a filter they equal the newest history bucket and the current month's
    // project table (which ignores the project filter), so those passes are reused.
    const current = starts.at(-1)!;
    const unfiltered = project === undefined && tool === undefined && source === undefined;
    const thisMonth = unfiltered ? history.at(-1)?.totals : this.store.totals((r) => r.timestampMs >= current);
    const thisMonthProjects =
      month.isCurrent && tool === undefined && source === undefined ? month.projects : projectSummaries(this.store, current, Number.POSITIVE_INFINITY, projectOf).map(withTitle);
    // Unfiltered per-project figures for today and the last 7 days, one pass (A1 side bar).
    const recentP = recentProjects(this.store, last7Start, dayStartMs, projectOf);
    const todayProjects = recentP.today.map(withTitle);
    const last7Projects = recentP.last7.map(withTitle);
    // Display label of a session row: its folder's title, else its project label.
    const folderTitles = new Map<string, string>();
    for (const f of this.files.values()) if (f.title !== undefined) folderTitles.set(f.folderId, f.title);
    const labelOf = (folderId: string | undefined) => (folderId === undefined ? undefined : (folderTitles.get(folderId) ?? projects.get(folderId)));
    month.sessions = month.sessions.map((x) => {
      const label = labelOf(x.folderId);
      return label === undefined ? x : { ...x, label };
    });
    if (month.detail) {
      const label = labelOf(month.sessions.find((x) => x.sessionId === month.detail!.sessionId)?.folderId ?? month.detail.sessionId);
      if (label !== undefined) month.detail.label = label;
    }
    for (const i of month.insights?.items ?? []) {
      if (i.id !== "context-growth") continue;
      i.top = i.top.map((t) => {
        const label = labelOf(month.sessions.find((x) => x.sessionId === t.sessionId)?.folderId ?? t.sessionId);
        return label === undefined ? t : { ...t, label };
      });
    }
    const filter = unfiltered ? undefined : { ...this.filter };

    return {
      generatedAtMs: nowMs,
      dayStartMs,
      ...(today !== undefined && { today }),
      ...this.current(latest, dayStartMs, folders),
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
    };
  }

  /** The viewed month: the selected one if it is a past month in the window, else this month. */
  private monthView(
    nowDate: Date,
    starts: number[],
    keep: (r: UsageRecord) => boolean,
    projectOf: (r: UsageRecord) => string,
    byProject: (r: UsageRecord) => boolean,
    byTool: (r: UsageRecord) => boolean,
  ): MonthView {
    const current = starts.at(-1)!;
    const sel = this.selectedMonth;
    const past = sel !== undefined && sel !== current && starts.includes(sel) ? sel : undefined;
    if (past === undefined) {
      const totals = this.store.totals((r) => r.timestampMs >= current && r.timestampMs <= nowDate.getTime() + DAY_SLACK_MS && keep(r));
      return {
        monthStartMs: current,
        isCurrent: true,
        days: daysOfMonth(this.store, current, nowDate.getDate(), true, keep),
        ...this.sessionsAndInsights(current, Number.POSITIVE_INFINITY, keep, byProject, totals?.nanoAiu.sum ?? 0),
        projects: projectSummaries(this.store, current, Number.POSITIVE_INFINITY, projectOf, byTool),
        tools: toolSummaries(this.store, current, Number.POSITIVE_INFINITY, byProject),
        ...(totals !== undefined && { totals }),
      };
    }
    const first = new Date(past);
    const end = new Date(first.getFullYear(), first.getMonth() + 1, 1).getTime();
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const totals = this.store.totals((r) => r.timestampMs >= past && r.timestampMs < end && keep(r));
    return {
      monthStartMs: past,
      isCurrent: false,
      days: daysOfMonth(this.store, past, lastDay, false, keep),
      ...this.sessionsAndInsights(past, end, keep, byProject, totals?.nanoAiu.sum ?? 0),
      projects: projectSummaries(this.store, past, end, projectOf, byTool),
      tools: toolSummaries(this.store, past, end, byProject),
      ...(totals !== undefined && { totals }),
    };
  }

  /** Session rows (at most SESSION_ROWS), the session counts and the insights for [fromMs, toMs). */
  private sessionsAndInsights(
    fromMs: number,
    toMs: number,
    keep: (r: UsageRecord) => boolean,
    byProject: (r: UsageRecord) => boolean,
    monthNanoAiu: number,
  ): Pick<MonthView, "sessions" | "sessionCount" | "sessionsBySource" | "totalsSessions" | "insights" | "cache" | "prompts" | "cacheCost" | "modelCache" | "toolOverhead" | "detail"> {
    const calls = this.store.records((r) => r.kind === "call");
    // The cache-read share uses the same per-model prompt convention as Insights (N4).
    const conventions = promptConventions(calls);
    const all: SessionSummary[] = sessionSummaries(this.store, fromMs, toMs, Number.POSITIVE_INFINITY, keep, conventions);
    // Sessions per source over every session of the month, before the SESSION_ROWS cut.
    const sessionsBySource = Object.create(null) as Partial<Record<Source, number>>;
    for (const x of all) if (x.source !== undefined) sessionsBySource[x.source] = (sessionsBySource[x.source] ?? 0) + 1;
    const inMonth = (r: UsageRecord) => r.timestampMs >= fromMs && r.timestampMs < toMs;
    // The tools table ignores the tool filter, so its "no tool data" note counts totals by project only.
    const totalsSessions = new Set(this.store.records((r) => r.kind === "sessionTotal" && inMonth(r) && byProject(r)).map((r) => r.sessionId)).size;
    const monthCalls = calls.filter((r) => inMonth(r) && keep(r));
    const insights = computeInsights({ sessions: all, monthRecords: monthCalls, allRecords: calls, monthNanoAiu });
    // v0.6: prompts follow the project filter only (a tool filter would cut a prompt's chain).
    const projectCalls = calls.filter((r) => inMonth(r) && byProject(r));
    const prompts = promptStats(projectCalls);
    const explain: Pick<MonthView, "prompts" | "cacheCost" | "modelCache" | "toolOverhead" | "detail"> = {
      ...(projectCalls.length > 0 && { prompts }),
      ...(monthCalls.length > 0 && { cacheCost: cacheStats(monthCalls, conventions), modelCache: modelCacheStats(monthCalls, conventions), toolOverhead: toolOverhead(monthCalls, conventions) }),
    };
    const sel = this.selectedSession;
    if (sel !== undefined) {
      // The ledger lists every call of the session in the viewed month (project filter only, like prompts).
      const recs = this.store.records((r) => r.sessionId === sel && inMonth(r) && byProject(r));
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
  }

  /**
   * Pinned folder; else a PID-live Copilot session with the newest record, then any
   * mtime-live session the same way; else the folder with the newest record today (D43).
   */
  private current(
    latest: Map<string, number>,
    dayStartMs: number,
    folders: Map<string, { source: Source; live: boolean; mtimeMs: number }>,
  ): Pick<Snapshot, "current"> {
    let folderId = this.pinned;
    const pinned = folderId !== undefined;
    const pick = (copilot: boolean): string | undefined => {
      const live = [...folders].filter(([, c]) => c.live && (c.source === "copilot") === copilot);
      const key = (id: string) => latest.get(id) ?? -Infinity;
      live.sort(([a, ca], [b, cb]) => key(b) - key(a) || cb.mtimeMs - ca.mtimeMs);
      return live[0]?.[0];
    };
    if (folderId === undefined) folderId = pick(true) ?? pick(false);
    if (folderId === undefined) {
      let bestMs = -Infinity;
      for (const [id, ms] of latest) {
        if (ms >= dayStartMs && ms > bestMs) {
          bestMs = ms;
          folderId = id;
        }
      }
    }
    if (folderId === undefined) return {};
    const id = folderId;
    const totals = this.store.totals((r) => r.sessionId === id);
    const live = folders.get(id)?.live === true;
    const last = lastPrompt(this.store.records((r) => r.kind === "call" && r.sessionId === id));
    let source: Source | undefined = folders.get(id)?.source;
    if (source === undefined) for (const f of this.files.values()) if (f.folderId === id) source = f.source;
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
