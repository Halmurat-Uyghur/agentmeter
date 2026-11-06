// Ties discovery, tailing, extraction and the store together and emits a
// Snapshot whenever what it would show changes. Missing data stays undefined,
// incomplete data sets `health.partial`, and only error codes are logged.
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { discover, isLive as realIsLive, type Candidate } from "./discover";
import { isIdLabel, MAX_WORKSPACE_BYTES, parseStartLine, parseUsageLine, parseWorkspaceName } from "./extract";
import type { Logger } from "./log";
import { byMonth, daysOfMonth, localDayStart, localMonthStart, monthStarts, NO_PROJECT, projectSummaries, sessionSummaries, toolSummaries, UsageStore } from "./store";
import { LineTailer, type ReadErrorCode, type TailResult } from "./tailer";
import type { Filter, Health, MonthView, Snapshot, UsageRecord } from "./types";

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
}

export const MAX_HISTORY_MONTHS = 24;

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
  private filter: Filter = {};

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
        tailer: new LineTailer(c.eventsPath, { decodeStart: this.readProjects }),
        primed: false,
        malformed: 0,
        unrecognized: 0,
        overlong: 0,
        overlongOther: 0,
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
      r.reset || r.error !== f.error || r.usageLines.length > 0 || r.activity > 0 || r.suspect > 0 || r.overlong > 0 || r.overlongOther > 0;
    if (r.error !== undefined && f.error === undefined)
      this.log.error("read", r.error);
    f.error = r.error;
    // A reset re-delivers the whole file: apply it first, and treat its lines
    // as history (like a first read) so old activity never looks like new.
    if (r.reset) {
      this.store.resetFile(path);
      f.malformed = f.unrecognized = f.overlong = f.overlongOther = 0;
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
    f.unrecognized += r.suspect;
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
    const latest = this.store.latest();

    let malformed = 0;
    let unrecognized = 0;
    let overlong = 0;
    let overlongOther = 0;
    let unreadableFiles = 0;
    let silentLive = false;
    let sessionsWithoutUsage = 0;
    for (const f of this.files.values()) {
      malformed += f.malformed;
      unrecognized += f.unrecognized;
      overlong += f.overlong;
      overlongOther += f.overlongOther;
      if (f.error !== undefined) unreadableFiles++;
      if (f.activity === 0 || f.usage > 0) continue;
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
      partial: unreadableFiles + malformed + overlong > 0,
      unrecognized,
      malformed,
      overlong,
      overlongOther,
      unreadableFiles,
      sessionsWithoutUsage,
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
    month.projects = month.projects.map((g) => {
      const t = titles.get(g.name);
      return t === undefined ? g : { ...g, label: t.title };
    });
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
        sessions: sessionSummaries(this.store, current, Number.POSITIVE_INFINITY, 10, keep),
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
      sessions: sessionSummaries(this.store, past, end, 10, keep),
      projects: projectSummaries(this.store, past, end, projectOf, byTool),
      tools: toolSummaries(this.store, past, end, byProject),
      ...(totals !== undefined && { totals }),
    };
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
    return {
      current: {
        folderId: id,
        live,
        pinned,
        ...(totals !== undefined && { totals }),
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
