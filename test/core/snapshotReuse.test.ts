// The figures of a snapshot do not depend on how it was built. A monitor that keeps results
// between snapshots (the default) and one that aggregates the whole store for every snapshot
// (`fullRebuild`, as every snapshot was built before) read the same scripted logs, step by
// step, and must report equal snapshots after each: through appended calls, repeated lines,
// session totals, rewritten and vanished logs, logs leaving the history window, a source's
// folder going away and coming back, filter, month, session and pin changes, and the day and
// the month rolling over. A seeded random run mixes all of them.
import { afterEach, describe, expect, it } from "vitest";
import { statusText, tooltipMarkdown } from "../../src/core/format";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { SECTIONS } from "../../src/core/panel/sections";
import { renderPanelHtml } from "../../src/core/panelHtml";
import { buildSidebarModel } from "../../src/core/sidebarModel";
import { emptyReadResult, type FileReader, type FileReadResult, type SourceCandidate, type SourceDiscoverResult, type SourceReader } from "../../src/core/source";
import { SOURCES, type Filter, type Snapshot, type Source, type UsageRecord, type ViewOptions } from "../../src/core/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Wednesday 18 November 2026, 15:00 local: mid-month, so the last 7 and the 7 days before stay inside it. */
const T0 = new Date(2026, 10, 18, 15, 0, 0).getTime();
const dayStart = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const monthStart = (ms: number, back = 0) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() - back, 1).getTime();
};

interface LogFile {
  source: Source;
  sessionId: string;
  folderId: string;
  path: string;
  mtimeMs: number;
  live: boolean;
  /** what a reader that has read nothing of this file yet is given, in order */
  content: Partial<FileReadResult>[];
  /** grows when the file is rewritten: a reader that read an older one starts over, with `reset` */
  generation: number;
}

/** Scripted logs that any number of monitors read, each through its own readers. */
class World {
  now = T0;
  readonly files = new Map<string, LogFile>();
  /** sources whose folder is missing: discovery finds no folder and every read finds no file */
  readonly down = new Set<Source>();
  /** While true, a change to a log does not show in its folder's listing time (an append never
   * does in a real folder): the monitor then meets it by reading the log, without discovering
   * its folder again first. */
  quiet = false;
  private listing = 1;

  private listed(): void {
    if (!this.quiet) this.listing++;
  }

  file(source: Source, sessionId: string, o: { folderId?: string; live?: boolean; name?: string } = {}): LogFile {
    const path = `/logs/${source}/${o.name ?? sessionId}.jsonl`;
    const f: LogFile = { source, sessionId, folderId: o.folderId ?? sessionId, path, mtimeMs: this.now, live: o.live ?? false, content: [], generation: 0 };
    this.files.set(path, f);
    this.listing++;
    return f;
  }

  /** Appends lines to `f`: its next read delivers `r`. `at` backdates the write (a log last written long ago). */
  write(f: LogFile, r: Partial<FileReadResult>, at = this.now): void {
    f.content.push(r);
    f.mtimeMs = at;
    this.listed();
  }

  /** Replaces `f`'s content: a reader that read the old content starts over. */
  rewrite(f: LogFile, r: Partial<FileReadResult>): void {
    f.content = [r];
    f.generation++;
    f.mtimeMs = this.now;
    this.listed();
  }

  remove(f: LogFile): void {
    this.files.delete(f.path);
    this.listed();
  }

  reader(source: Source): SourceReader {
    return {
      source,
      root: `/logs/${source}`,
      rootSource: "default",
      rootDirMtime: async () => (this.down.has(source) ? undefined : this.listing),
      discover: async (windowStartMs: number): Promise<SourceDiscoverResult> => {
        if (this.down.has(source)) return { ok: false, error: "no-dir" };
        const candidates: SourceCandidate[] = [];
        for (const f of this.files.values()) {
          if (f.source !== source || f.mtimeMs < windowStartMs) continue;
          candidates.push({ source, sessionId: f.sessionId, folderId: f.folderId, files: [{ path: f.path, mtimeMs: f.mtimeMs, size: f.content.length + 1000 * f.generation }], mtimeMs: f.mtimeMs, live: f.live });
        }
        return { ok: true, candidates, unreadable: [], dirMtimeMs: this.listing };
      },
      pathAllowed: () => true,
      open: (path: string): FileReader => {
        let generation = -1;
        let next = 0;
        return {
          read: async (): Promise<FileReadResult> => {
            const f = this.files.get(path);
            if (f === undefined || this.down.has(source)) return { ...emptyReadResult(), error: "ENOENT" };
            const out = emptyReadResult();
            if (generation !== f.generation) {
              out.reset = generation !== -1;
              generation = f.generation;
              next = 0;
            }
            for (const r of f.content.slice(next)) {
              // every monitor gets its own copy of each record
              out.records.push(...structuredClone(r.records ?? []));
              if (r.totals !== undefined) out.totals = structuredClone(r.totals);
              if (r.label !== undefined) out.label = r.label;
              if (r.title !== undefined) out.title = r.title;
              out.hasTotals ||= r.hasTotals ?? r.totals !== undefined;
              out.activity += r.activity ?? 0;
              out.usage += r.usage ?? r.records?.length ?? 0;
              out.candidates = (out.candidates ?? 0) + (r.candidates ?? r.records?.length ?? 0);
              out.unrecognized += r.unrecognized ?? 0;
              out.malformed += r.malformed ?? 0;
            }
            next = f.content.length;
            return out;
          },
        };
      },
    };
  }
}

let n = 0;
function call(f: LogFile, timestampMs: number, o: Partial<UsageRecord> = {}): UsageRecord {
  n++;
  return {
    key: `k-${n}`,
    keySource: f.source === "copilot" ? "usageId" : f.source === "codex" ? "codexResponseId" : "claudeMessageId",
    source: f.source,
    kind: "call",
    sessionId: f.sessionId,
    folderId: f.folderId,
    timestampMs,
    model: "model-a",
    tokens: { input: 1000 + n, output: 100, cacheRead: 400, cacheWrite: 20 },
    nanoAiu: 1_000_000 + n,
    ...o,
  };
}

function total(f: LogFile, timestampMs: number, model: string, o: Partial<UsageRecord> = {}): UsageRecord {
  return {
    key: f.source === "codex" ? `codex-total:${f.folderId}` : `shutdown:${f.folderId}:${model}`,
    keySource: f.source === "codex" ? "codexTotal" : "shutdown",
    source: f.source,
    kind: "sessionTotal",
    sessionId: f.folderId,
    folderId: f.folderId,
    timestampMs,
    model,
    calls: 6,
    tokens: { input: 6000, output: 600 },
    nanoAiu: 9_000_000,
    ...o,
  };
}

/** A Copilot per-type split with fractional parts, so sums depend on the order they are added in. */
const typeCost = (k: number) => ({ input: 0.1 * k + 1 / 3, cacheRead: 0.7 * k, cacheWrite: 1 / 7, output: 2.2 * k + 0.05, inputAtReadRate: 0.013 * k });

const strip = (s: Snapshot | undefined) => (s === undefined ? undefined : { ...s, generatedAtMs: 0 });

const VIEWS: ViewOptions[] = [{ unit: "tokens", statusBar: "session" }, { unit: "cost", range: { min: 1, max: 5 }, dayTarget: { max: 1 }, weekTarget: { max: 3 }, statusBar: "month" }];

/** Everything a snapshot is shown as: the status bar's text and tooltip, the side bar's model
 * and every section of the panel, in tokens and in cost. Equal snapshots that listed their
 * models or sources in another order would show here if anything read that order. */
function shown(s: Snapshot): string[] {
  const out: string[] = [];
  for (const view of VIEWS) {
    out.push(statusText(s, view), tooltipMarkdown(s, view), JSON.stringify(buildSidebarModel(s, view, ["webapp"])));
    for (const section of SECTIONS) out.push(renderPanelHtml(s, "csp", view, section));
  }
  return out;
}

/** Two monitors over `world`: `kept` keeps results between snapshots, `full` rebuilds every one from the store. */
class Pair {
  readonly kept: Snapshot[] = [];
  readonly full: Snapshot[] = [];
  /** "error refresh …" lines of either monitor: a build that threw delivers nothing */
  readonly failures: string[] = [];
  private readonly monitors: UsageMonitor[];
  steps = 0;

  private readonly showEvery: number;

  constructor(
    private readonly world: World,
    o: { historyMonths?: number; sources?: readonly Source[]; showEvery?: number } = {},
  ) {
    this.showEvery = o.showEvery ?? 1;
    const make = (fullRebuild: boolean) =>
      new UsageMonitor({
        root: "/logs/copilot",
        rootSource: "default",
        log: new Logger((line) => {
          if (line.startsWith("error refresh")) this.failures.push(`${fullRebuild ? "full" : "kept"}: ${line}`);
        }),
        now: () => new Date(world.now),
        historyMonths: o.historyMonths ?? 4,
        readers: (o.sources ?? SOURCES).map((s) => world.reader(s)),
        onSnapshot: (s) => (fullRebuild ? this.full : this.kept).push(s),
        fullRebuild,
      });
    this.monitors = [make(false), make(true)];
  }

  /** Applies a change (a filter, a month, a session, a pin) to both. Each change starts a refresh
   * of its own: it is awaited here, one monitor after the other, so both go through the same
   * runs at the same times (a run started while another monitor's is under way would be
   * followed by one more). */
  async each(fn: (m: UsageMonitor) => void): Promise<void> {
    for (const m of this.monitors) {
      fn(m);
      await m.refresh();
    }
  }

  /** Lets `ms` pass (long enough for every source to look at its folder again), refreshes both,
   * compares the snapshots and, every `showEvery` steps, everything they are shown as. */
  async step(ms = 15_000, full = false): Promise<void> {
    this.world.now += ms;
    this.steps++;
    // A snapshot already delivered is never changed by a later build (parts of it are kept and shared).
    const delivered = this.kept.at(-1);
    const was = JSON.stringify(delivered);
    for (const m of this.monitors) await m.refresh(full ? { full: true } : {});
    expect(this.failures, `step ${this.steps}`).toEqual([]);
    expect(this.kept.length).toBeGreaterThan(0);
    expect(JSON.stringify(delivered), `step ${this.steps}: the snapshot before it`).toBe(was);
    const kept = strip(this.kept.at(-1))!;
    const whole = strip(this.full.at(-1))!;
    expect(kept, `step ${this.steps}`).toEqual(whole);
    if (this.steps % this.showEvery === 0) expect(shown(kept), `step ${this.steps}, as shown`).toEqual(shown(whole));
  }

  get last(): Snapshot {
    return this.kept.at(-1)!;
  }

  dispose(): void {
    for (const m of this.monitors) m.dispose();
  }
}

let pair: Pair | undefined;
afterEach(() => {
  pair?.dispose();
  pair = undefined;
});

/** Three sources over four months: Copilot with sequences and per-type cost, Claude Code with tools, Codex, and a session counted from its total. */
function seed(w: World): { copilot: LogFile; claude: LogFile; codex: LogFile; old: LogFile; legacy: LogFile } {
  const copilot = w.file("copilot", "c0000001-0000-4000-8000-000000000001", { live: true });
  const claude = w.file("claude-code", "c1a00001-0000-4000-8000-000000000001", { live: true });
  const codex = w.file("codex", "c0de0001-0000-4000-8000-000000000001");
  const old = w.file("claude-code", "c1a00002-0000-4000-8000-000000000002");
  const legacy = w.file("copilot", "c0000002-0000-4000-8000-000000000002");
  const days = [0, 0, 1, 3, 6, 7, 9, 13, 14, 17];
  w.write(copilot, {
    label: "webapp",
    title: "owner/webapp",
    activity: 4,
    records: days.map((d, i) => call(copilot, T0 - d * DAY - i * MIN, { sequence: 20 - i, model: i % 2 ? "gpt-6-sol" : "model-a", typeCost: typeCost(i + 1), initiator: i % 3 ? "agent" : "user", toolTokens: 900, availableTools: 30, durationMs: 1500 + i })),
  });
  w.write(claude, {
    label: "api",
    activity: 3,
    records: days.map((d, i) => call(claude, T0 - d * DAY - i * MIN - 30_000, { model: i % 3 ? "claude-sonnet-4-5" : "claude-opus-4-1", tools: i % 2 ? { Bash: 2, Read: 1 } : { mcp__srv__lookup: 1 }, initiator: i % 4 ? "agent" : "user" })),
  });
  w.write(codex, { label: "webapp", records: [1, 2, 8, 20, 40].map((d, i) => call(codex, T0 - d * DAY - i * HOUR, { model: "gpt-5-codex", nanoAiu: i === 2 ? undefined : 2_000_000 })) });
  // Last written in early October: only records of September and October, and most of the
  // store's records, as in a real history (the store keeps a list of recent records only
  // while it is the smaller part).
  const before = [45, 46, 47, 70, 71, 72].flatMap((d) => Array.from({ length: 10 }, (_, i) => T0 - d * DAY - i * MIN));
  w.write(old, { label: "api", records: before.map((ms) => call(old, ms, { model: "claude-opus-4-1", tools: { Edit: 1 } })) }, T0 - 45 * DAY);
  w.write(legacy, { label: "tools", activity: 2, totals: [total(legacy, T0 - 5 * DAY, "model-a"), total(legacy, T0 - 5 * DAY, "model-b", { calls: undefined })] }, T0 - 5 * DAY);
  return { copilot, claude, codex, old, legacy };
}

describe("a snapshot built from kept results equals one built from the whole store", () => {
  it("appended calls, repeated lines and lines without usage", async () => {
    const w = new World();
    const f = seed(w);
    pair = new Pair(w);
    await pair.step();
    // August (nothing), September, October, November
    expect(pair.last.history?.map((h) => h.totals?.records)).toEqual([undefined, 30, 32, 25]);
    const [, september, october] = pair.last.history!.map((h) => h.totals);

    // a new call today, in each source
    w.write(f.claude, { records: [call(f.claude, w.now, { tools: { Bash: 1 } })] });
    await pair.step();
    w.write(f.copilot, { records: [call(f.copilot, w.now, { sequence: 21, typeCost: typeCost(9), initiator: "user" })] });
    w.write(f.codex, { records: [call(f.codex, w.now, { model: "gpt-5-codex" })] });
    await pair.step();
    // a month that has ended is not aggregated again: the same objects as before
    expect(pair.last.history![1]!.totals).toBe(september);
    expect(pair.last.history![2]!.totals).toBe(october);

    // a model, a tool and a project the month has not seen; a session with no earlier record
    const fresh = w.file("claude-code", "c1a00003-0000-4000-8000-000000000003", { live: true });
    w.write(fresh, { label: "newproj", records: [call(fresh, w.now, { model: "claude-haiku-4-5", tools: { WebFetch: 3 } })] });
    await pair.step();

    // the same call again in its own log: later figures, more tools, a later time (D42 repeats)
    const again = call(f.claude, w.now - 5000, { tools: { Grep: 1 } });
    w.write(f.claude, { records: [again] });
    await pair.step();
    w.write(f.claude, { records: [{ ...again, timestampMs: w.now, tokens: { input: 5000, output: 900 }, tools: { Grep: 2, Read: 1 } }] });
    await pair.step();

    // a repeat that moves a call across midnight, and one across the 1st of the month
    const late = call(f.claude, dayStart(w.now) - 1000);
    const lateMonth = call(f.claude, monthStart(w.now) - 1000);
    w.write(f.claude, { records: [late, lateMonth] });
    await pair.step();
    w.write(f.claude, { records: [{ ...late, timestampMs: dayStart(w.now) + 1000 }, { ...lateMonth, timestampMs: monthStart(w.now) + 1000 }] });
    await pair.step();

    // lines that add no call: only the activity counters move
    w.write(f.claude, { activity: 2, candidates: 0, usage: 0 });
    w.write(f.copilot, { activity: 1 });
    await pair.step();

    // a call dated in a month that has ended (a log read late): that month is added up again
    w.write(f.codex, { records: [call(f.codex, T0 - 50 * DAY, { model: "gpt-5-codex" })] });
    await pair.step();
    expect(pair.last.history![1]!.totals?.records).toBe(31);
    expect(pair.last.history![1]!.totals?.bySource?.codex?.records).toBe(1);

    // a project label that arrives after the calls it names (no record changes)
    const unnamed = w.file("claude-code", "c1a00004-0000-4000-8000-000000000004");
    w.write(unnamed, { records: [call(unnamed, w.now - 2 * DAY), call(unnamed, w.now - 40 * DAY), call(unnamed, w.now)] });
    await pair.step();
    expect(pair.last.month?.projects.some((p) => p.name === "(no project)")).toBe(true);
    w.write(unnamed, { label: "late" });
    await pair.step();
    expect(pair.last.month?.projects.find((p) => p.name === "late")?.calls).toBe(2);
    expect(pair.last.month?.projects.some((p) => p.name === "(no project)")).toBe(false);

    // The comparison with last month runs up to the same point of it: calls dated there are
    // counted one by one as the clock passes them (a line without usage has each step rebuild).
    const d = new Date(w.now);
    const samePoint = new Date(d.getFullYear(), d.getMonth() - 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()).getTime();
    w.write(f.codex, { records: [20_000, 35_000, 50_000, 5 * MIN].map((ahead) => call(f.codex, samePoint + ahead, { model: "gpt-5-codex" })) });
    const counted: (number | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      w.write(f.claude, { activity: 1, candidates: 0, usage: 0 });
      await pair.step();
      expect(pair.last.month?.prior?.toMs).toBe(samePoint + 15_000 * (i + 1));
      counted.push(pair.last.month?.prior?.totals?.bySource?.codex?.records);
    }
    // the one dated 40 days back, then those 20, 35 and 50 seconds past the point
    expect(counted).toEqual([1, 2, 3, 4, 4]);

    // nothing new: the minute passes, the prior-month comparison follows the clock
    await pair.step(61_000);
    await pair.step(61_000);
  });

  it("resetFile and resetFiles: a rewritten log, a vanished log, logs leaving the history window", async () => {
    const w = new World();
    const f = seed(w);
    pair = new Pair(w);
    await pair.step();

    // rewritten with fewer calls: the log is read again from its start
    w.rewrite(f.claude, { label: "api", records: [call(f.claude, w.now - HOUR), call(f.claude, w.now - 2 * DAY, { tools: { Bash: 4 } })] });
    await pair.step();
    expect(pair.last.month?.totals?.bySource?.["claude-code"]?.records).toBe(2);

    // a copy of a log (the same keys in another folder), then the original goes: its calls move to the copy
    const original = f.copilot.content.flatMap((r) => r.records ?? []);
    const copy = w.file("copilot", "c0000009-0000-4000-8000-000000000009");
    w.write(copy, { label: "webapp", records: original.map((r) => ({ ...r, folderId: copy.folderId })) });
    await pair.step();
    w.remove(f.copilot);
    await pair.step();
    expect(pair.last.sessions.some((s) => s.folderId === f.copilot.folderId)).toBe(false);

    // a log that vanishes with its calls
    w.remove(f.codex);
    await pair.step();
    expect(pair.last.health.sources?.codex?.files).toBe(0);

    // The window is 4 months: on 1 February the log last written in early October leaves it,
    // and every record it held goes in one pass.
    expect(pair.last.health.sources?.["claude-code"]?.files).toBe(2);
    w.now = new Date(2027, 1, 1, 9, 0, 0).getTime();
    await pair.step();
    expect(pair.last.health.sources?.["claude-code"]?.files).toBe(1);
    w.write(f.claude, { records: [call(f.claude, w.now)] });
    await pair.step();
  });

  it("a source turned off and on: its folder goes away and comes back, and a monitor without it", async () => {
    const w = new World();
    const f = seed(w);
    pair = new Pair(w);
    await pair.step();
    const before = pair.last.thisMonth?.records;

    w.down.add("claude-code");
    await pair.step();
    expect(pair.last.health.sources?.["claude-code"]?.state).toBe("no-dir");
    expect(pair.last.thisMonth?.bySource?.["claude-code"]).toBeUndefined();
    w.write(f.copilot, { records: [call(f.copilot, w.now, { sequence: 30 })] });
    await pair.step();

    w.down.delete("claude-code");
    w.write(f.claude, { records: [call(f.claude, w.now)] });
    await pair.step();
    expect(pair.last.thisMonth?.records).toBe(before! + 2);

    // every source off but Copilot, then all of them again (the extension starts a new monitor for each)
    for (const sources of [["copilot"], ["copilot", "codex"], SOURCES] as const) {
      pair.dispose();
      pair = new Pair(w, { sources });
      await pair.step();
      w.write(f.codex, { records: [call(f.codex, w.now, { model: "gpt-5-codex" })] });
      await pair.step();
      expect(Object.keys(pair.last.health.sources ?? {})).toEqual([...sources]);
    }
  });

  it("filter, month, session and pin changes", async () => {
    const w = new World();
    const f = seed(w);
    pair = new Pair(w);
    await pair.step();
    const filters: Filter[] = [
      { project: "webapp" },
      { project: "webapp", source: "codex" },
      { tool: "Bash" },
      { tool: "Bash", project: "api" },
      { source: "claude-code" },
      { source: "copilot" },
      { project: "no-such-project" },
      {},
    ];
    for (const filter of filters) {
      await pair.each((m) => m.setFilter(filter));
      await pair.step();
      // a call arrives under each filter
      w.write(f.claude, { records: [call(f.claude, w.now, { tools: { Bash: 1 } })] });
      w.write(f.copilot, { records: [call(f.copilot, w.now, { sequence: 40 + pair.steps, typeCost: typeCost(pair.steps) })] });
      await pair.step();
    }
    expect(pair.last.filter).toBeUndefined();

    // a past month, the month before it, a month outside the window, and back
    for (const back of [1, 2, 3, 9, 0]) {
      await pair.each((m) => m.selectMonth(back === 0 ? undefined : monthStart(w.now, back)));
      await pair.step();
      w.write(f.codex, { records: [call(f.codex, w.now, { model: "gpt-5-codex" })] });
      await pair.step();
    }
    await pair.each((m) => m.selectMonth(monthStart(w.now, 1)));
    await pair.each((m) => m.setFilter({ source: "claude-code" }));
    await pair.step();
    await pair.each((m) => m.selectMonth(undefined));
    await pair.each((m) => m.setFilter({}));

    // the ledger of a session, of one counted from its total, of none
    for (const id of [f.claude.sessionId, f.legacy.sessionId, "no-such-session", undefined]) {
      await pair.each((m) => m.selectSession(id));
      await pair.step();
      w.write(f.claude, { records: [call(f.claude, w.now)] });
      await pair.step();
    }

    // the ledger's label follows the session's title, with no record changing
    await pair.each((m) => m.selectSession(f.copilot.sessionId));
    await pair.step();
    expect(pair.last.month?.detail?.label).toBe("owner/webapp");
    w.write(f.copilot, { title: "owner/renamed" });
    await pair.step();
    expect(pair.last.month?.detail?.label).toBe("owner/renamed");
    w.write(f.copilot, { title: null });
    await pair.step();
    expect(pair.last.month?.detail?.label).toBe("webapp");
    await pair.each((m) => m.selectSession(undefined));

    // pinned: a live session, a session with no record today, a folder no log names, unpinned
    for (const id of [f.claude.folderId, f.old.folderId, "no-such-folder", undefined]) {
      await pair.each((m) => m.pin(id));
      await pair.step();
    }
  });

  it("the day and the month roll over", async () => {
    const w = new World();
    const f = seed(w);
    pair = new Pair(w, { historyMonths: 6 });
    await pair.step();
    // midnight: yesterday's calls are no longer today's
    w.now = dayStart(w.now) + DAY - 5000;
    w.write(f.claude, { records: [call(f.claude, w.now)] });
    await pair.step(1000);
    await pair.step(10_000);
    expect(pair.last.today).toBeUndefined();
    w.write(f.claude, { records: [call(f.claude, w.now)] });
    await pair.step();
    expect(pair.last.today?.records).toBe(1);

    // day by day to the end of the month, a call a day in one source or another
    for (let d = 0; d < 11; d++) {
      w.now += DAY;
      const log = [f.claude, f.copilot, f.codex][d % 3]!;
      w.write(log, { records: [call(log, w.now, { ...(log === f.copilot && { sequence: 100 + d, typeCost: typeCost(d) }) })] });
      await pair.step();
    }
    expect(new Date(w.now).getDate()).toBe(30);

    // the 1st: the month that was current has ended, the last 7 days reach back into it
    w.now = new Date(2026, 11, 1, 0, 0, 20).getTime();
    await pair.step();
    expect(pair.last.month?.monthStartMs).toBe(new Date(2026, 11, 1).getTime());
    expect(pair.last.month?.totals).toBeUndefined();
    w.write(f.codex, { records: [call(f.codex, w.now, { model: "gpt-5-codex" })] });
    await pair.step();
    expect(pair.last.month?.totals?.records).toBe(1);
    expect(pair.last.last7?.records).toBeGreaterThan(1);
    // the 31st of a month after a 30-day one: the comparison covers all of last month
    w.now = new Date(2026, 11, 31, 23, 59, 30).getTime();
    w.write(f.claude, { records: [call(f.claude, w.now)] });
    await pair.step();
    w.now = new Date(2027, 0, 1, 0, 0, 30).getTime();
    await pair.step();
    w.write(f.claude, { records: [call(f.claude, w.now)] });
    await pair.step();
  });

  it("session totals appear, change, hide behind calls and go", async () => {
    const w = new World();
    const f = seed(w);
    pair = new Pair(w);
    await pair.step();
    expect(pair.last.health.sessionsFromTotals).toBe(1);

    // a Codex log with no per-call records: its total is replaced as it grows
    const totalsOnly = w.file("codex", "c0de0007-0000-4000-8000-000000000007", { live: true });
    w.write(totalsOnly, { label: "webapp", activity: 1, totals: [total(totalsOnly, w.now, "gpt-5-codex")] });
    await pair.step();
    w.write(totalsOnly, { totals: [total(totalsOnly, w.now, "gpt-5-codex", { tokens: { input: 9000, output: 900 }, calls: 9 })] });
    await pair.step();
    expect(pair.last.health.sessionsFromTotals).toBe(2);

    // its first per-call record: the total is dropped
    w.write(totalsOnly, { records: [call(totalsOnly, w.now, { model: "gpt-5-codex" })], totals: [] });
    await pair.step();
    expect(pair.last.health.sessionsFromTotals).toBe(1);

    // a call arrives for the session counted from a shutdown total: the total hides (it is dated five days ago)
    const days = pair.last.month!.days.filter((d) => d.totals?.sessionTotals).length;
    expect(days).toBe(1);
    w.write(f.legacy, { records: [call(f.legacy, w.now, { sequence: 1 })] });
    await pair.step();
    expect(pair.last.month!.days.filter((d) => d.totals?.sessionTotals).length).toBe(0);
    expect(pair.last.health.sessionsFromTotals).toBe(0);

    // the log is rewritten without the call: the total shows again
    w.rewrite(f.legacy, { label: "tools", activity: 2, totals: [total(f.legacy, T0 - 5 * DAY, "model-a")] });
    await pair.step();
    expect(pair.last.month!.days.filter((d) => d.totals?.sessionTotals).length).toBe(1);

    // a call in another folder names the total's session: it hides again
    w.write(f.copilot, { records: [call(f.copilot, w.now, { sessionId: f.legacy.sessionId, sequence: 99 })] });
    await pair.step();
    expect(pair.last.health.sessionsFromTotals).toBe(0);
  });

  it("ties, where the order records are read in decides: equal times, sequences across midnight, two newest folders", async () => {
    const w = new World();
    // nothing is live, so the current session is the folder with the newest record today
    const a = w.file("claude-code", "c1a0000a-0000-4000-8000-00000000000a");
    const b = w.file("claude-code", "c1a0000b-0000-4000-8000-00000000000b");
    const c = w.file("copilot", "c000000c-0000-4000-8000-00000000000c");
    const yesterday = dayStart(T0) - HOUR;
    // Twelve calls of one session at only two times, costs rising: which five are "first" and
    // which five "last" (growth) depends on the order equal times are kept in.
    w.write(a, { label: "p", records: Array.from({ length: 12 }, (_, i) => call(a, i < 6 ? yesterday : T0 - HOUR, { nanoAiu: 1e10 * (i + 1), initiator: i % 2 ? "agent" : "user" })) });
    w.write(b, { label: "q", records: [call(b, T0 - HOUR), call(b, yesterday)] });
    // Copilot: sequences that restart, calls without one, and prompts at equal times
    w.write(c, { label: "p", records: [call(c, yesterday, { sequence: 3, initiator: "user" }), call(c, yesterday, { sequence: 1, initiator: "agent" }), call(c, yesterday + 1, { initiator: "user" })] });
    // Most of the store is older, so the lists of today's and this month's records are kept.
    const bulk = w.file("codex", "c0de000f-0000-4000-8000-00000000000f");
    w.write(bulk, { label: "q", records: Array.from({ length: 150 }, (_, i) => call(bulk, T0 - 40 * DAY - i * HOUR, { model: "gpt-5-codex" })) }, T0 - 40 * DAY);
    // Two folders whose newest records share the newest time of all. `first` has only today's
    // records and is read first (the newer log); `second` also has yesterday's. One pass over
    // the store meets `first` first; the days before today name `second` first.
    const second = w.file("claude-code", "c1a0000e-0000-4000-8000-00000000000e");
    w.write(second, { label: "q", records: [call(second, yesterday), call(second, T0 - MIN)] }, T0 - 1000);
    const first = w.file("claude-code", "c1a0000d-0000-4000-8000-00000000000d");
    w.write(first, { label: "p", records: [call(first, T0 - MIN)] });
    pair = new Pair(w);
    await pair.step();
    // the two folders' newest records share a time: the first in the store's order is current
    expect(pair.last.current?.folderId).toBe(first.folderId);

    // today's calls of the Copilot session tie with yesterday's on sequence
    w.write(c, { records: [call(c, w.now, { sequence: 1, initiator: "user" }), call(c, w.now, { sequence: 3, initiator: "agent" })] });
    await pair.step();
    w.write(c, { records: [call(c, w.now, { initiator: "user" }), call(c, w.now, { sequence: 0, initiator: "agent" })] });
    await pair.step();
    // the same newest time in both folders again, the other one written first
    w.write(b, { records: [call(b, w.now)] });
    await pair.step();
    w.write(a, { records: [call(a, w.now - 15_000, { nanoAiu: 5e11 })] });
    await pair.step();
    await pair.each((m) => m.setFilter({ source: "claude-code" }));
    await pair.step();
    // a session id used by two sources
    const x = w.file("codex", a.sessionId, { name: "shared" });
    w.write(x, { label: "q", records: [call(x, w.now), call(x, yesterday)] });
    await pair.step();
    await pair.each((m) => m.setFilter({}));
    await pair.step();
  });
});

describe("between two discoveries of a folder (a second apart, as the monitor polls)", () => {
  it("a log's label, title, calls, rewrite and removal are met by reading it alone", async () => {
    const w = new World();
    const f = seed(w);
    // a second Copilot log of the same project, without a title, and a Claude Code log without a label yet
    const plain = w.file("copilot", "c0000005-0000-4000-8000-000000000005");
    w.write(plain, { label: "webapp", records: [call(plain, T0 - 2 * HOUR, { sequence: 1 })] });
    const unnamed = w.file("claude-code", "c1a00006-0000-4000-8000-000000000006", { live: true });
    w.write(unnamed, { records: [call(unnamed, T0 - MIN), call(unnamed, T0 - 2 * DAY)] });
    pair = new Pair(w);
    await pair.step();
    const project = (name: string) => pair!.last.thisMonthProjects?.find((p) => p.name === name);
    const row = (id: string) => pair!.last.sessions.find((x) => x.folderId === id);
    expect(project("webapp")?.label).toBe("owner/webapp");
    expect(project("(no project)")?.calls).toBe(2);

    w.quiet = true;
    // calls: the session list follows the newest record
    w.write(unnamed, { records: [call(unnamed, w.now + 500)] });
    await pair.step(1000);
    expect(row(unnamed.folderId)?.lastMs).toBe(w.now - 500);
    // the label arrives
    w.write(unnamed, { label: "late" });
    await pair.step(1000);
    expect(project("late")?.calls).toBe(3);
    expect(project("(no project)")).toBeUndefined();
    // the title changes, then goes
    w.write(f.copilot, { title: "owner/renamed" });
    await pair.step(1000);
    expect(project("webapp")?.label).toBe("owner/renamed");
    w.write(f.copilot, { title: null });
    await pair.step(1000);
    expect(project("webapp")?.label).toBeUndefined();
    w.write(f.copilot, { title: "owner/again" });
    await pair.step(1000);
    expect(project("webapp")?.label).toBe("owner/again");
    // rewritten without a label
    w.rewrite(unnamed, { records: [call(unnamed, w.now)] });
    await pair.step(1000);
    expect(project("late")).toBeUndefined();
    expect(project("(no project)")?.calls).toBe(1);
    // the titled log vanishes: its project keeps the other log's calls and loses the title
    w.remove(f.copilot);
    await pair.step(1000);
    expect(project("webapp")?.label).toBeUndefined();
    w.remove(unnamed);
    await pair.step(1000);
    expect(project("(no project)")).toBeUndefined();
    // the next walk of the folder no longer finds the log
    w.quiet = false;
    await pair.step(61_000);
    expect(row(unnamed.folderId)).toBeUndefined();
  });
});

describe("a store that is mostly today's records (each figure is then one pass, kept until a record changes)", () => {
  it("appends, a late label, a repeat, a total, a filter, a rewrite and midnight", async () => {
    const w = new World();
    const a = w.file("claude-code", "c1a000a1-0000-4000-8000-0000000000a1", { live: true });
    const b = w.file("copilot", "c00000a2-0000-4000-8000-0000000000a2");
    const c = w.file("codex", "c0de00a3-0000-4000-8000-0000000000a3");
    w.write(a, { records: [...Array.from({ length: 12 }, (_, i) => call(a, T0 - i * MIN, { tools: { Bash: 1 } })), call(a, T0 - 3 * DAY)] });
    w.write(b, { label: "webapp", title: "owner/webapp", records: [...Array.from({ length: 9 }, (_, i) => call(b, T0 - i * MIN, { sequence: 9 - i, typeCost: typeCost(i + 1) })), call(b, T0 - 40 * DAY, { sequence: 0 })] });
    w.write(c, { label: "webapp", records: [call(c, T0 - HOUR, { model: "gpt-5-codex" }), call(c, T0 - 8 * DAY, { model: "gpt-5-codex" })] });
    pair = new Pair(w);
    await pair.step();
    expect(pair.last.today?.records).toBe(22);
    expect(pair.last.todayProjects?.map((p) => p.name).sort()).toEqual(["(no project)", "webapp"]);

    w.write(a, { records: [call(a, w.now, { model: "claude-haiku-4-5" })] });
    await pair.step();
    // the label of the log arrives after its calls
    w.write(a, { label: "api" });
    await pair.step();
    expect(pair.last.todayProjects?.map((p) => p.name).sort()).toEqual(["api", "webapp"]);
    expect(pair.last.last7Projects?.find((p) => p.name === "api")?.calls).toBe(14);

    const again = call(b, w.now, { sequence: 10 });
    w.write(b, { records: [again] });
    await pair.step();
    w.write(b, { records: [{ ...again, timestampMs: w.now, tokens: { input: 7, output: 7 } }] });
    w.write(c, { activity: 2 });
    await pair.step();
    const legacy = w.file("copilot", "c00000a4-0000-4000-8000-0000000000a4");
    w.write(legacy, { label: "tools", activity: 1, totals: [total(legacy, w.now, "model-a")] });
    await pair.step();
    expect(pair.last.health.sessionsFromTotals).toBe(1);
    for (const filter of [{ project: "api" }, { tool: "Bash", source: "claude-code" as const }, {}]) {
      await pair.each((m) => m.setFilter(filter));
      await pair.step();
      w.write(a, { records: [call(a, w.now, { tools: { Bash: 2, Read: 1 } })] });
      await pair.step();
    }
    w.rewrite(a, { label: "renamed", records: [call(a, w.now), call(a, w.now - DAY)] });
    await pair.step();
    expect(pair.last.todayProjects?.map((p) => p.name).sort()).toEqual(["renamed", "tools", "webapp"]);
    w.now = dayStart(w.now) + DAY + 30_000;
    await pair.step();
    expect(pair.last.today).toBeUndefined();
    w.write(c, { records: [call(c, w.now, { model: "gpt-5-codex" })] });
    await pair.step();
    expect(pair.last.today?.records).toBe(1);
  });
});

describe("each session's first call, which the cache-reuse insight leaves out", () => {
  const yesterday = dayStart(T0) - HOUR;
  const heavy = (f: LogFile, ms: number, o: Partial<UsageRecord>) => call(f, ms, { model: "gpt-6-sol", tokens: { input: 30_000, output: 100, cacheRead: 1000 }, ...o });
  /** Low cache reuse on one Copilot model: three sessions of seven calls, and a longer history on another source. */
  function lowReuse(w: World): void {
    const bulk = w.file("codex", "c0de000f-0000-4000-8000-00000000000f");
    w.write(bulk, { label: "q", records: Array.from({ length: 150 }, (_, i) => call(bulk, T0 - 40 * DAY - i * HOUR, { model: "gpt-5-codex" })) }, T0 - 40 * DAY);
    for (const k of [1, 2, 3]) {
      const f = w.file("copilot", `c00000a${k}-0000-4000-8000-00000000000${k}`);
      w.write(f, { label: "p", records: Array.from({ length: 7 }, (_, i) => heavy(f, yesterday - k * HOUR + i * MIN, { sequence: i + 1, nanoAiu: 1e10 + i })) });
    }
  }
  const insight = () => pair!.last.month?.insights?.items.find((i) => i.id === "cache-reuse");
  /** the three sessions' calls less their first ones */
  const base = 3 * (6e10 + 21);

  it("two calls share the lowest sequence, one before today and one today: the one read first", async () => {
    const w = new World();
    lowReuse(w);
    // written out of order: today's call first
    const tied = w.file("copilot", "c00000b1-0000-4000-8000-0000000000b1");
    w.write(tied, { label: "p", records: [heavy(tied, T0 - 2 * MIN, { sequence: 1, nanoAiu: 3e10 }), heavy(tied, yesterday, { sequence: 1, nanoAiu: 5e10 }), heavy(tied, yesterday, { sequence: 2, nanoAiu: 7e10 })] });
    pair = new Pair(w);
    await pair.step();
    expect(insight()).toMatchObject({ model: "gpt-6-sol", calls: 18 + 2, sessions: 4 });
    expect(insight()!.nanoAiu).toBe(base + 5e10 + 7e10);
    // a lower sequence today: that call is the first now
    w.write(tied, { records: [heavy(tied, w.now, { sequence: 0, nanoAiu: 9e10 })] });
    await pair.step();
    expect(insight()!.nanoAiu).toBe(base + 3e10 + 5e10 + 7e10);
  });

  it("only some calls of a session carry a sequence: the order they are read in decides", async () => {
    const w = new World();
    lowReuse(w);
    const mixed = w.file("copilot", "c00000b2-0000-4000-8000-0000000000b2");
    w.write(mixed, {
      label: "p",
      records: [
        heavy(mixed, yesterday + 30_000, { sequence: 2, nanoAiu: 11e10 }),
        heavy(mixed, T0 - 3 * MIN, { sequence: 0, nanoAiu: 13e10 }),
        heavy(mixed, yesterday + 35_000, { sequence: undefined, nanoAiu: 17e10 }),
        heavy(mixed, yesterday + 40_000, { sequence: 1, nanoAiu: 19e10 }),
      ],
    });
    pair = new Pair(w);
    await pair.step();
    // read in that order, the call without a sequence ends up first
    expect(insight()).toMatchObject({ model: "gpt-6-sol", calls: 18 + 3, sessions: 4 });
    expect(insight()!.nanoAiu).toBe(base + 11e10 + 13e10 + 19e10);
    w.write(mixed, { records: [heavy(mixed, w.now, { sequence: undefined, nanoAiu: 23e10 })] });
    await pair.step();
    expect(insight()!.nanoAiu).toBe(base + 11e10 + 13e10 + 19e10 + 23e10);
  });

  it("a model found to report cached tokens apart from input changes the rows of sessions that ended before today", async () => {
    const w = new World();
    lowReuse(w);
    const other = w.file("copilot", "c00000b3-0000-4000-8000-0000000000b3");
    w.write(other, { label: "p", records: [call(other, T0, { model: "model-a", sequence: 1 })] });
    pair = new Pair(w);
    await pair.step();
    const row = () => pair!.last.month!.sessions.find((x) => x.sessionId === "c00000a1-0000-4000-8000-000000000001")!;
    expect(row().input?.sum).toBe(7 * 30_000);
    // one call today, in another session, whose cache reads exceed its input
    w.write(other, { records: [call(other, w.now, { model: "gpt-6-sol", sequence: 2, tokens: { input: 1000, output: 10, cacheRead: 5000 } })] });
    await pair.step();
    expect(row().input?.sum).toBe(7 * 31_000);
  });

  it("and the rows of a past month being viewed, none of whose records changed", async () => {
    const w = new World();
    lowReuse(w);
    const october = w.file("copilot", "c00000b4-0000-4000-8000-0000000000b4");
    w.write(october, { label: "p", records: Array.from({ length: 4 }, (_, i) => heavy(october, T0 - 30 * DAY + i * MIN, { sequence: i + 1, nanoAiu: 1e10 })) }, T0 - 30 * DAY);
    const other = w.file("copilot", "c00000b3-0000-4000-8000-0000000000b3");
    w.write(other, { label: "p", records: [call(other, T0, { model: "model-a", sequence: 1 })] });
    pair = new Pair(w);
    await pair.each((m) => m.selectMonth(monthStart(T0, 1)));
    await pair.step();
    const row = () => pair!.last.month!.sessions.find((x) => x.sessionId === october.sessionId)!;
    expect(pair.last.month?.isCurrent).toBe(false);
    expect(row().input?.sum).toBe(4 * 30_000);
    w.write(other, { records: [call(other, w.now, { model: "gpt-6-sol", sequence: 2, tokens: { input: 1000, output: 10, cacheRead: 5000 } })] });
    await pair.step();
    expect(row().input?.sum).toBe(4 * 31_000);
  });
});

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("a seeded random run", () => {
  const MODELS: Record<Source, string[]> = { copilot: ["gpt-6-sol", "model-a"], "claude-code": ["claude-opus-4-1", "claude-sonnet-4-5", "gpt-6-sol"], codex: ["gpt-5-codex", "gpt-5"] };
  const TOOLS = ["Bash", "Read", "Edit", "mcp__srv__lookup", "view"];
  const LABELS = ["webapp", "api", "tools"];
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  /** what the runs' snapshots held, so the comparison is known to have covered it */
  const seen = new Map<string, number>();
  const note = (what: string, when: unknown) => {
    if (when) seen.set(what, (seen.get(what) ?? 0) + 1);
  };

  for (const seedNo of SEEDS) {
    it(`seed ${seedNo}: every step's snapshots are equal`, async () => {
      const r = rng(seedNo * 7919);
      const int = (k: number) => Math.floor(r() * k);
      const one = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
      const w = new World();
      // Even seeds: a long history with little of it today (the store then keeps lists of
      // today's and this month's records); odd seeds: mostly today's records (it reads the whole store).
      const today = seedNo % 2 === 0 ? 0.12 : 0.55;
      const logs: LogFile[] = [];
      /** every call a log holds, newest version of each */
      const held = new Map<LogFile, UsageRecord[]>();
      let sessions = 0;
      const newLog = (): LogFile => {
        const source = one(SOURCES);
        sessions++;
        const id = `5e550000-0000-4000-8000-${String(seedNo * 1000 + sessions).padStart(12, "0")}`;
        // sometimes a second log of an existing session's folder (a sub-agent's)
        const parent = r() < 0.15 ? logs.find((x) => x.source === source) : undefined;
        const f = parent ? w.file(source, parent.sessionId, { folderId: parent.folderId, name: `${parent.sessionId}-agent-${sessions}`, live: r() < 0.3 }) : w.file(source, id, { live: r() < 0.3 });
        logs.push(f);
        held.set(f, []);
        if (r() < 0.8) w.write(f, { label: one(LABELS), ...(source === "copilot" && r() < 0.5 && { title: `title-${sessions}` }) });
        return f;
      };
      /** A time on a coarse grid, so calls tie: mostly today, else within the window, sometimes on a day or month boundary. */
      const when = (): number => {
        const p = r();
        if (p < today) return dayStart(w.now) + int(Math.max(1, Math.floor((w.now - dayStart(w.now)) / (10 * MIN)))) * 10 * MIN;
        if (p < today + 0.1) return one([dayStart(w.now), dayStart(w.now) - 1, monthStart(w.now), monthStart(w.now) - 1, dayStart(w.now) - 6 * DAY, dayStart(w.now) - 13 * DAY]);
        return dayStart(w.now) - int(100) * DAY + int(24) * HOUR;
      };
      const newCall = (f: LogFile): UsageRecord => {
        const tools: Record<string, number> = {};
        if (f.source !== "codex") for (let i = int(3); i > 0; i--) tools[one(TOOLS)] = 1 + int(3);
        return call(f, when(), {
          model: r() < 0.05 ? undefined : one(MODELS[f.source]),
          tokens: { ...(r() < 0.95 && { input: 4000 * int(80) }), ...(r() < 0.95 && { output: 10 * int(500) }), ...(r() < 0.8 && { cacheRead: 1000 * int(50) }), ...(r() < 0.5 && { cacheWrite: 100 * int(20) }) },
          ...(r() < 0.9 ? { nanoAiu: 1e9 * int(400) } : { nanoAiu: undefined }),
          ...(Object.keys(tools).length > 0 && { tools }),
          ...(f.source === "copilot" && r() < 0.7 && { sequence: int(40) }),
          ...(f.source === "copilot" && r() < 0.6 && { typeCost: typeCost(1 + int(30)) }),
          ...(r() < 0.8 && { initiator: one(["user", "agent", "agent", "other"] as const) }),
          ...(r() < 0.3 && { toolTokens: 100 * int(30), availableTools: int(60) }),
          // a call that names another session than its log's (a resumed or forked session)
          ...(r() < 0.05 && logs.length > 1 && { sessionId: one(logs).sessionId }),
        });
      };
      for (let i = 0; i < 8; i++) {
        const f = newLog();
        const calls = Array.from({ length: 5 + int(30) }, () => newCall(f));
        held.get(f)!.push(...calls);
        w.write(f, { records: calls, activity: int(4) });
      }
      pair = new Pair(w, { historyMonths: 1 + int(5), showEvery: 6 });
      await pair.step();

      for (let step = 0; step < 70; step++) {
        const f = one(logs.filter((x) => w.files.has(x.path)).length > 0 ? logs.filter((x) => w.files.has(x.path)) : [newLog()]);
        const mine = held.get(f)!;
        const p = r();
        if (p < 0.34) {
          const calls = Array.from({ length: 1 + int(3) }, () => newCall(f));
          mine.push(...calls);
          w.write(f, { records: calls, activity: int(2) });
        } else if (p < 0.42 && mine.length > 0) {
          // a repeated line of a call: other figures, perhaps another time
          const i = int(mine.length);
          const next = { ...newCall(f), key: mine[i]!.key, sessionId: mine[i]!.sessionId, ...(r() < 0.5 && { timestampMs: mine[i]!.timestampMs }) };
          mine[i] = next;
          w.write(f, { records: [next] });
        } else if (p < 0.46) {
          w.write(f, { activity: 1 + int(3), candidates: int(2), usage: 0 });
        } else if (p < 0.48) {
          // another project label, or a title, with no record
          w.write(f, r() < 0.7 ? { label: one(LABELS) } : { title: r() < 0.3 ? null : `title-${step}` });
        } else if (p < 0.54) {
          const g = newLog();
          if (g.source !== "claude-code" && r() < 0.4) {
            // a log counted from its session total: no per-call records
            w.write(g, { totals: [total(g, when(), g.source === "codex" ? "gpt-5-codex" : one(MODELS.copilot))], activity: 2 });
          } else {
            const calls = Array.from({ length: int(6) }, () => newCall(g));
            held.get(g)!.push(...calls);
            w.write(g, { records: calls, activity: 1 });
          }
        } else if (p < 0.58 && mine.length > 0) {
          // a copy of a log in another folder: the same keys
          const g = newLog();
          const copies = mine.slice(0, 1 + int(mine.length)).map((x) => ({ ...x, source: g.source, folderId: g.folderId }));
          held.get(g)!.push(...copies);
          w.write(g, { records: copies });
        } else if (p < 0.64 && f.source !== "claude-code") {
          const models = f.source === "codex" ? ["gpt-5-codex"] : [one(MODELS.copilot), "model-z"].slice(0, 1 + int(2));
          w.write(f, { totals: r() < 0.2 ? [] : models.map((m) => total(f, when(), m, { calls: r() < 0.8 ? 1 + int(9) : undefined, nanoAiu: r() < 0.8 ? 1e9 * int(90) : undefined })), activity: 1 });
        } else if (p < 0.68) {
          const keep = mine.filter(() => r() < 0.6);
          held.set(f, keep);
          w.rewrite(f, { records: keep, label: one(LABELS), activity: int(3) });
        } else if (p < 0.71) {
          w.remove(f);
        } else if (p < 0.77) {
          const filter: Filter = { ...(r() < 0.4 && { project: one(LABELS) }), ...(r() < 0.3 && { tool: one(TOOLS) }), ...(r() < 0.3 && { source: one(SOURCES) }) };
          await pair.each((m) => m.setFilter(filter));
        } else if (p < 0.81) {
          const back = int(6);
          await pair.each((m) => m.selectMonth(back === 0 ? undefined : monthStart(w.now, back)));
        } else if (p < 0.84) {
          const id = r() < 0.3 ? undefined : one(logs).sessionId;
          await pair.each((m) => m.selectSession(id));
        } else if (p < 0.87) {
          const id = r() < 0.4 ? undefined : one(logs).folderId;
          await pair.each((m) => m.pin(id));
        } else if (p < 0.9) {
          const s = one(SOURCES);
          if (w.down.has(s)) w.down.delete(s);
          else w.down.add(s);
        } else if (p < 0.93) {
          f.live = !f.live;
          w.write(f, { activity: 1 });
        } else if (p < 0.96) {
          // to just before midnight, or just before the 1st
          w.now = r() < 0.6 ? dayStart(w.now) + DAY - 20_000 : monthStart(w.now, -1) - 20_000;
        } else {
          w.now += int(3) * DAY + int(20) * HOUR;
        }
        await pair.step(one([1000, 1000, 2000, 15_000, 15_000, 15_000, 61_000, 6 * MIN]), r() < 0.04);
        // Half the steps change logs without their folders' listings showing it.
        w.quiet = r() < 0.5;
        const s = pair.last;
        note("a filter", s.filter);
        note("a source scope", s.sourceScope);
        note("a past month", s.month?.isCurrent === false);
        note("a comparison with last month", s.month?.prior?.totals);
        note("a session ledger", s.month?.detail?.calls);
        note("a current session", s.current?.totals);
        note("a last prompt", s.current?.lastPrompt);
        note("session totals", s.health.sessionsFromTotals > 0);
        note("a missing folder", s.health.sources && Object.values(s.health.sources).some((h) => h.state === "no-dir"));
        note("several months", (s.history ?? []).filter((h) => h.totals).length >= 3);
        note("project titles", s.thisMonthProjects?.some((x) => x.label !== undefined));
        note("tools", s.month?.tools.length);
        note("cache cost", s.month?.cacheCost?.uncachedNano.reported);
        note("prompts", s.month?.prompts?.prompts);
        for (const i of s.month?.insights?.items ?? []) note(`insight ${i.id}`, true);
        note("a growing session", s.month?.sessions.some((x) => x.growth !== undefined));
      }
    });
  }

  it("the runs covered every part of a snapshot", () => {
    const parts = [
      "a filter", "a source scope", "a past month", "a comparison with last month", "a session ledger", "a current session", "a last prompt", "session totals",
      "a missing folder", "several months", "project titles", "tools", "cache cost", "prompts", "insight long-context", "insight context-growth", "insight cache-reuse", "a growing session",
    ];
    expect(parts.filter((x) => !seen.has(x))).toEqual([]);
  });
});
