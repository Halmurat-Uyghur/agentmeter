// Ties discovery, tailing, extraction and the store together and emits a
// Snapshot whenever what it would show changes. Missing data stays undefined,
// incomplete data sets `health.partial`, and only error codes are logged.
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { discover, isLive as realIsLive, type Candidate } from "./discover";
import { isIdLabel, MAX_WORKSPACE_BYTES, parseShutdownLine, parseStartLine, parseUsageLine, parseWorkspaceName } from "./extract";
import type { Logger } from "./log";
import { cacheStats, lastPrompt, modelCacheStats, promptStats, sessionDetail, toolOverhead } from "./explain";
import { computeInsights, promptConventions } from "./insights";
import { byMonth, dailyActivity, daysOfMonth, localDayStart, localDaysBefore, localMonthStart, monthStarts, NO_PROJECT, projectSummaries, recentProjects, sessionSummaries, toolSummaries, UsageStore } from "./store";
import { LineTailer, type ReadErrorCode, type TailResult } from "./tailer";
import type { Filter, GroupSummary, Health, MonthView, SessionSummary, Snapshot, UsageRecord } from "./types";

export interface MonitorOptions {
  root: string;
  rootSource: Health["rootSource"];
  now?: () => Date;
  isLive?: typeof realIsLive;
  /** injectable for tests; defaults to the real extractor */
  parse?: typeof parseUsageLine;
  log: Logger;
  onSnapshot: (s: Snapshot) => void;
  /** months of history to read, this month included (D21); default 1 = this month only */
  historyMonths?: number;
  /** decode each log's session.start line for a project label (D25); default false */
  readProjects?: boolean;
  /** decode session.shutdown lines and count sessions without per-call records from their
   * session totals (D29); default false here, the extension passes its setting (default on) */
  readTotals?: boolean;
}

export const MAX_HISTORY_MONTHS = 24;

/** Session rows a snapshot keeps for the viewed month; the panel shows 10 and folds the rest (D32). */
export const SESSION_ROWS = 50;

/** Clamps a history setting to 1..MAX_HISTORY_MONTHS; anything invalid is 1. */
export function clampHistory(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_HISTORY_MONTHS, Math.max(1, Math.floor(n))) : 1;
}

interface FileState {
  folderId: string;
  tailer: LineTailer;
  /** false until a read without error; that read's lines are history, not "since start" */
  primed: boolean;
  malformed: number;
  unrecognized: number;
  overlong: number;
  overlongOther: number;
  /** session.shutdown lines too long to decode */
  shutdownOversize: number;
  /** a session.shutdown line of this log gave session totals */
  hasTotals: boolean;
  /** activity / usage lines over the whole file (since the last reset) */
  activity: number;
  usage: number;
  /** activity / usage lines read after the first read (the format-change window) */
  windowActivity: number;
  windowUsage: number;
  error?: ReadErrorCode;
  /** project label from this log's session.start line (D25) */
  project?: string;
  /** session title from workspace.yaml, read only when `project` is an ID */
  title?: string;
  /** mtime of the workspace.yaml last read for `title` */
  titleMtimeMs?: number;
}

/**
 * Reads at most MAX_WORKSPACE_BYTES + 1 bytes of workspace.yaml (never following a
 * symlink where the OS allows) and returns its title; a longer file has no title.
 */
async function readBoundedTitle(path: string): Promise<string | undefined> {
  const fh = await fs.promises.open(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await fh.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(MAX_WORKSPACE_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return n > MAX_WORKSPACE_BYTES ? undefined : parseWorkspaceName(buf.toString("utf8", 0, n));
  } finally {
    await fh.close();
  }
}

const REDISCOVER_MS = 10_000;
const FORMAT_ACTIVITY = 3;
/** "today" has no upper bound (a clock-skewed record still counts today); the month mirrors that. */
const DAY_SLACK_MS = Number.POSITIVE_INFINITY;
const CODE = /^[A-Z0-9_]{1,40}$/;

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && CODE.test(code) ? code : "EXCEPTION";
}

export class UsageMonitor {
  private readonly root: string;
  private readonly rootSource: Health["rootSource"];
  private readonly now: () => Date;
  private readonly isLiveFn: typeof realIsLive;
  private readonly parse: typeof parseUsageLine;
  private readonly log: Logger;
  private readonly onSnapshot: (s: Snapshot) => void;
  private readonly historyMonths: number;
  /** month start of the viewed month; undefined = follow the current month */
  private selectedMonth: number | undefined;
  private readonly readProjects: boolean;
  private readonly readTotals: boolean;
  private filter: Filter = {};
  /** session whose calls the Sessions section lists (v0.6); in memory only */
  private selectedSession: string | undefined;

  private readonly store = new UsageStore();
  /** eventsPath → state; kept for the life of the monitor, dropped only on ENOENT */
  private readonly files = new Map<string, FileState>();
  /** folderId → candidate from the last successful discover */
  private candidates = new Map<string, Candidate>();
  private discoverError: "no-dir" | "permission" | undefined;
  private discovered = false;
  private lastDiscoverAt = 0;
  private lastDirMtimeMs: number | undefined;
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
    this.root = o.root;
    this.rootSource = o.rootSource;
    this.now = o.now ?? (() => new Date());
    this.isLiveFn = o.isLive ?? realIsLive;
    this.parse = o.parse ?? parseUsageLine;
    this.log = o.log;
    this.onSnapshot = o.onSnapshot;
    this.historyMonths = clampHistory(o.historyMonths ?? 1);
    this.readProjects = o.readProjects === true;
    this.readTotals = o.readTotals === true;
  }

  /**
   * Serialised: a call while a run is busy queues exactly one more run, which
   * every later caller joins; each promise resolves after the work it asked for.
   */
  refresh(opts: { full?: boolean } = {}): Promise<void> {
    if (opts.full) this.wantFull = true;
    if (this.queued) return this.queued;
    const run = this.chain.then(() => {
      this.queued = undefined;
      return this.run();
    });
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

  /** Narrows the month view, trend and tables; empty values clear (D26). */
  setFilter(filter: Filter): void {
    this.filter = {
      ...(filter.project ? { project: filter.project } : {}),
      ...(filter.tool ? { tool: filter.tool } : {}),
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
      let changed = this.dirty || dayStartMs !== this.lastDayStartMs;
      this.dirty = false;
      if (await this.shouldDiscover(full, nowMs, dayStartMs)) {
        await this.rediscover(nowMs, dayStartMs);
        changed = true;
      }
      let added = 0;
      for (const [path, f] of [...this.files]) {
        const r = await this.readFile(path, f);
        added += r.added;
        if (r.changed) changed = true;
      }
      if (added > 0) this.log.count("usage", added);
      this.lastDayStartMs = dayStartMs;
      // Idle polls (nothing read, nothing rediscovered) skip the rebuild.
      if (changed) this.emit(this.snapshot(nowMs, dayStartMs));
    } catch (err) {
      this.log.error("refresh", errCode(err));
    }
    this.log.timing("refresh", performance.now() - started);
  }

  private async shouldDiscover(
    full: boolean,
    nowMs: number,
    dayStartMs: number,
  ): Promise<boolean> {
    if (full || !this.discovered || this.discoverError !== undefined)
      return true;
    if (dayStartMs !== this.lastDayStartMs) return true;
    if (Math.abs(nowMs - this.lastDiscoverAt) >= REDISCOVER_MS) return true;
    let mtimeMs: number | undefined;
    try {
      mtimeMs = (await fs.promises.stat(join(this.root, "session-state")))
        .mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    return mtimeMs !== this.lastDirMtimeMs;
  }

  private async rediscover(nowMs: number, dayStartMs: number): Promise<void> {
    const windowStartMs = monthStarts(new Date(nowMs), this.historyMonths)[0]!;
    const result = await discover(this.root, windowStartMs, this.isLiveFn, dayStartMs);
    this.discovered = true;
    this.lastDiscoverAt = nowMs;
    if (!result.ok) {
      this.lastDirMtimeMs = undefined;
      if (result.error === "OTHER") {
        this.log.error("discover", "OTHER");
        return; // keep the last known candidates and state
      }
      this.discoverError = result.error;
      this.candidates = new Map();
      return;
    }
    this.discoverError = undefined;
    this.lastDirMtimeMs = result.dirMtimeMs;
    this.candidates = new Map(result.candidates.map((c) => [c.folderId, c]));
    // Logs that left the window (e.g. last month's, after the 1st) are forgotten
    // with their records and counters.
    const keep = new Set(result.candidates.map((c) => c.eventsPath));
    for (const path of [...this.files.keys()]) {
      if (keep.has(path)) continue;
      this.files.delete(path);
      this.store.resetFile(path);
    }
    for (const c of result.candidates) {
      if (this.files.has(c.eventsPath)) continue;
      this.files.set(c.eventsPath, {
        folderId: c.folderId,
        tailer: new LineTailer(c.eventsPath, { decodeStart: this.readProjects, decodeShutdown: this.readTotals }),
        primed: false,
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
      });
    }
  }

  /** One read of one file: new records, and whether anything shown may have changed. */
  private async readFile(path: string, f: FileState): Promise<{ added: number; changed: boolean }> {
    const r: TailResult = await f.tailer.read();
    if (r.error === "ENOENT") {
      this.files.delete(path);
      return { added: 0, changed: true };
    }
    const changed =
      r.reset ||
      r.error !== f.error ||
      r.usageLines.length > 0 ||
      r.shutdownLines.length > 0 ||
      r.shutdownOversize > 0 ||
      r.activity > 0 ||
      r.suspect > 0 ||
      r.overlong > 0 ||
      r.overlongOther > 0;
    if (r.error !== undefined && f.error === undefined)
      this.log.error("read", r.error);
    f.error = r.error;
    // A reset re-delivers the whole file: apply it first, and treat its lines
    // as history (like a first read) so old activity never looks like new.
    if (r.reset) {
      this.store.resetFile(path);
      f.malformed = f.unrecognized = f.overlong = f.overlongOther = f.shutdownOversize = 0;
      f.hasTotals = false;
      delete f.project;
      delete f.title;
      delete f.titleMtimeMs;
      f.activity = f.usage = f.windowActivity = f.windowUsage = 0;
      f.primed = false;
    }
    const inWindow = f.primed;
    let added = 0;
    let usage = 0;
    for (const line of r.startLines) {
      const label = parseStartLine(line);
      if (label !== undefined && f.project === undefined) {
        f.project = label;
        this.dirty = true;
      }
    }
    // A folder named by an ID says nothing: show the session's title instead.
    // Checked only when the log moved, so idle polls touch no extra file.
    if (f.project !== undefined && isIdLabel(f.project) && (r.startLines.length > 0 || r.usageLines.length > 0 || r.activity > 0))
      await this.readTitle(path, f);
    for (const line of r.usageLines) {
      const p = this.parse(line, f.folderId);
      if (p.kind === "usage") {
        usage++;
        if (this.store.add(p.record, path)) added++;
      } else if (p.kind === "malformed") f.malformed++;
      else if (p.kind === "unrecognized") f.unrecognized++;
    }
    // Each shutdown line carries the session's running totals: the last one wins.
    for (const line of r.shutdownLines) {
      const p = parseShutdownLine(line, f.folderId);
      if (p.kind === "totals") {
        if (this.store.setSessionTotals(f.folderId, path, p.records)) added += p.records.length;
        f.hasTotals = true;
      } else if (p.kind === "malformed") f.malformed++;
      else if (p.kind === "unrecognized") f.unrecognized++;
    }
    f.unrecognized += r.suspect;
    f.shutdownOversize += r.shutdownOversize;
    f.overlong += r.overlong;
    f.overlongOther += r.overlongOther;
    f.activity += r.activity;
    f.usage += usage;
    if (inWindow) {
      f.windowActivity += r.activity;
      f.windowUsage += usage;
    }
    if (r.error === undefined) f.primed = true;
    return { added, changed };
  }

  /**
   * Reads the `name:` of the session's workspace.yaml when that file changed. A file
   * that is gone, unreadable, not a regular file (e.g. a symlink) or over
   * MAX_WORKSPACE_BYTES drops the title, so the folder name shows again.
   */
  private async readTitle(eventsPath: string, f: FileState): Promise<void> {
    const ws = join(dirname(eventsPath), "workspace.yaml");
    let title: string | undefined;
    let mtimeMs: number | undefined;
    try {
      const st = await fs.promises.lstat(ws);
      if (st.isFile() && st.size <= MAX_WORKSPACE_BYTES) {
        if (st.mtimeMs === f.titleMtimeMs) return;
        title = await readBoundedTitle(ws);
        mtimeMs = st.mtimeMs;
      }
    } catch {
      // No workspace.yaml (older Copilot) or unreadable: the folder name shows.
    }
    if (mtimeMs === undefined) delete f.titleMtimeMs;
    else f.titleMtimeMs = mtimeMs;
    if (title !== f.title) {
      if (title === undefined) delete f.title;
      else f.title = title;
      this.dirty = true;
    }
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

    let malformed = 0;
    let unrecognized = 0;
    let overlong = 0;
    let overlongOther = 0;
    let shutdownOversize = 0;
    /** oversize shutdown lines in logs without per-call records: only there was the total needed */
    let shutdownOversizeNeeded = 0;
    let unreadableFiles = 0;
    let silentLive = false;
    let sessionsWithoutUsage = 0;
    let sessionsFromTotals = 0;
    // Store-derived, so a total hidden by per-call records never counts as coverage.
    const fromTotals = this.store.sessionTotalSessions();
    for (const f of this.files.values()) {
      malformed += f.malformed;
      unrecognized += f.unrecognized;
      overlong += f.overlong;
      overlongOther += f.overlongOther;
      shutdownOversize += f.shutdownOversize;
      if (f.usage === 0) shutdownOversizeNeeded += f.shutdownOversize;
      if (f.error !== undefined) unreadableFiles++;
      if ((f.activity === 0 && !f.hasTotals) || f.usage > 0) continue;
      if (fromTotals.has(f.folderId)) {
        sessionsFromTotals++;
        continue;
      }
      const live = this.candidates.get(f.folderId)?.live === true;
      const flags =
        live &&
        f.windowActivity >= FORMAT_ACTIVITY &&
        f.windowUsage === 0 &&
        this.store.totals(
          (r) => isToday(r.timestampMs) && r.folderId !== f.folderId,
        ) !== undefined;
      if (flags) silentLive = true;
      else sessionsWithoutUsage++;
    }

    const health: Health = {
      state:
        this.discoverError ??
        (unrecognized > 0 || silentLive
          ? "format-changed"
          : today === undefined
            ? "no-data"
            : "ok"),
      rootSource: this.rootSource,
      // A log with per-call records hides its session total anyway, so an unread
      // shutdown line there loses nothing (review 3); Data health still counts it.
      partial: unreadableFiles + malformed + overlong + shutdownOversizeNeeded > 0,
      unrecognized,
      malformed,
      overlong,
      overlongOther,
      unreadableFiles,
      sessionsWithoutUsage,
      sessionsFromTotals,
      shutdownOversize,
    };

    const monthStart = localMonthStart(new Date(nowMs));
    const inMonth = [...latest].filter(([, ms]) => ms >= monthStart).map(([id]) => id);
    // Older logs in the history window are read for totals but are not "this month's" sessions.
    const recent = [...this.candidates.values()].filter((c) => c.mtimeMs >= monthStart).map((c) => c.folderId);
    const ids = new Set<string>([...recent, ...inMonth]);
    const sessions = [...ids]
      .map((folderId) => {
        const lastMs = latest.get(folderId);
        const live = this.candidates.get(folderId)?.live === true;
        return lastMs === undefined
          ? { folderId, live }
          : { folderId, lastMs, live };
      })
      .sort(
        (a, b) =>
          (b.lastMs ?? -Infinity) - (a.lastMs ?? -Infinity) ||
          a.folderId.localeCompare(b.folderId),
      );

    const nowDate = new Date(nowMs);
    const starts = monthStarts(nowDate, this.historyMonths);
    // Grouping and the project filter are keyed by the project folder label only.
    // A session title (ID-named folders) is display-only: the title of the most
    // recently active titled session in that folder.
    const projects = new Map<string, string>();
    const titles = new Map<string, { title: string; ms: number }>();
    for (const f of this.files.values()) {
      if (f.project === undefined) continue;
      projects.set(f.folderId, f.project);
      if (f.title === undefined) continue;
      const ms = latest.get(f.folderId) ?? Number.NEGATIVE_INFINITY;
      const t = titles.get(f.project);
      if (t === undefined || ms > t.ms) titles.set(f.project, { title: f.title, ms });
    }
    const projectOf = (r: UsageRecord) => projects.get(r.folderId) ?? NO_PROJECT;
    const { project, tool } = this.filter;
    const byProject = (r: UsageRecord) => project === undefined || projectOf(r) === project;
    const byTool = (r: UsageRecord) => tool === undefined || (r.tools?.[tool] ?? 0) > 0;
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
    const thisMonth = project === undefined && tool === undefined ? history.at(-1)?.totals : this.store.totals((r) => r.timestampMs >= current);
    const thisMonthProjects =
      month.isCurrent && tool === undefined ? month.projects : projectSummaries(this.store, current, Number.POSITIVE_INFINITY, projectOf).map(withTitle);
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
    const filter = project !== undefined || tool !== undefined ? { ...this.filter } : undefined;

    return {
      generatedAtMs: nowMs,
      dayStartMs,
      ...(today !== undefined && { today }),
      ...this.current(latest, dayStartMs),
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
  ): Pick<MonthView, "sessions" | "sessionCount" | "totalsSessions" | "insights" | "cache" | "prompts" | "cacheCost" | "modelCache" | "toolOverhead" | "detail"> {
    const calls = this.store.records((r) => r.kind === "call");
    // The cache-read share uses the same per-model prompt convention as Insights (N4).
    const conventions = promptConventions(calls);
    const all: SessionSummary[] = sessionSummaries(this.store, fromMs, toMs, Number.POSITIVE_INFINITY, keep, conventions);
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
    return { sessions: all.slice(0, SESSION_ROWS), sessionCount: all.length, totalsSessions, insights, ...cache, ...explain };
  }

  /** Pinned folder; else the live candidate with the newest record; else the newest folder today. */
  private current(
    latest: Map<string, number>,
    dayStartMs: number,
  ): Pick<Snapshot, "current"> {
    let folderId = this.pinned;
    const pinned = folderId !== undefined;
    if (folderId === undefined) {
      // Live candidates by newest record, then by newest file write.
      const live = [...this.candidates.values()].filter((c) => c.live);
      const key = (c: Candidate) => latest.get(c.folderId) ?? -Infinity;
      live.sort((a, b) => key(b) - key(a) || b.mtimeMs - a.mtimeMs);
      folderId = live[0]?.folderId;
    }
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
    const live = this.candidates.get(id)?.live === true;
    const last = lastPrompt(this.store.records((r) => r.kind === "call" && r.sessionId === id));
    return {
      current: {
        folderId: id,
        live,
        pinned,
        ...(totals !== undefined && { totals }),
        ...(last !== undefined && { lastPrompt: last }),
      },
    };
  }

  private emit(s: Snapshot): void {
    const signature = JSON.stringify({ ...s, generatedAtMs: 0 });
    if (signature === this.lastSignature) return;
    if (this.disposed) return;
    this.lastSignature = signature;
    this.onSnapshot(s);
  }
}
