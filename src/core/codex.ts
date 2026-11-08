// The Codex reader (D45). Rollout files under sessions/YYYY/MM/DD are tailed
// as raw bytes; classifyCodexLine gates each line on four type needles and
// everything else is skipped undecoded. A gated line is walked by the path
// scanner (D41) for an allowlist of absolute paths only, and only those slices
// are decoded, through parseSlice/stringAt. Prompts, replies, instructions,
// git and sandbox details, the allowance-like event fields and the per-turn and
// per-thread usage copies are never requested, so they are never decoded.
// archived_sessions/ is counted by name and never opened; nothing else under
// the Codex home is listed.
// Session totals (token_count, D45) carry the file's session id (the line has
// no session_id) and the latest model seen in the file, when one is known.
import * as fs from "node:fs";
import * as path from "node:path";
import { isSessionId } from "./extract";
import { parseSlice, MAX_SLICE_BYTES, scanJson, stringAt, type ScanPath, type ScanResult } from "./jsonScan";
import { folderLabel } from "./label";
import {
  emptyReadResult,
  RECENT_MS,
  type FileReader,
  type FileReadResult,
  type SourceCandidate,
  type SourceDiscoverResult,
  type SourceReader,
  type SourceUnreadable,
} from "./source";
import { ByteTailer, type LineHandler } from "./tailer";
import type { Tokens, UsageRecord } from "./types";

/** Longest line handed to the parser; longer lines are counted, not read. */
export const CODEX_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** turn id → model entries kept per file; past this the oldest entry is dropped. */
export const CODEX_MAX_TURNS = 1024;

export type CodexLineClass = "record" | "turn" | "meta" | "event" | "skip";

export interface CodexFileState {
  /** turn id → model, insertion order = age; at most CODEX_MAX_TURNS */
  models: Map<string, string>;
  latestModel?: string;
  /** project key from the first session_meta line (D44) */
  label?: string;
  sawTurn: boolean;
}

export type CodexParse =
  | { kind: "usage"; record: UsageRecord }
  /** from a token_count line (sessionTotal) */
  | { kind: "total"; record: UsageRecord }
  | { kind: "turn" }
  | { kind: "meta"; label?: string }
  | { kind: "ignored" }
  | { kind: "unrecognized"; reason: "no-key" | "bad-timestamp" | "no-known-token-field" | "slice-too-large" }
  | { kind: "malformed" };

export interface CodexParseOptions {
  /** stands in when payload.session_id is not a session id (the file name's UUID) */
  fileSessionId: string;
  /** read payload.cwd of a session_meta line (copilotUsageMonitor.projectNames) */
  wantLabel: boolean;
  /** read token_count totals (copilotUsageMonitor.sessionTotals) */
  readTotals: boolean;
}

const RECORD_TYPE = "token_usage_record";
const TURN_TYPE = "turn_context";
const META_TYPE = "session_meta";
const EVENT_TYPE = "event_msg";
const TOKEN_COUNT = "token_count";

// Inside a JSON string these quotes are escaped as \", so content text never matches.
const needle = (name: string): Buffer => Buffer.from(`"type":"${name}"`);
const RECORD_NEEDLE = needle(RECORD_TYPE);
const TURN_NEEDLE = needle(TURN_TYPE);
const META_NEEDLE = needle(META_TYPE);
const EVENT_NEEDLE = needle(EVENT_TYPE);

/** The only paths ever requested, per line class. */
const RECORD_PATHS: readonly ScanPath[] = [
  ["type"],
  ["timestamp"],
  ["payload", "session_id"],
  ["payload", "turn_id"],
  ["payload", "response_id"],
  ["payload", "usage"],
];
const TURN_PATHS: readonly ScanPath[] = [["type"], ["payload", "turn_id"], ["payload", "model"]];
const META_PATHS: readonly ScanPath[] = [["type"]];
const META_LABEL_PATHS: readonly ScanPath[] = [["type"], ["payload", "cwd"]];
const EVENT_TOTAL_PATHS: readonly ScanPath[] = [["type"], ["timestamp"], ["payload", "type"], ["payload", "info", "total_token_usage"]];

/** Same shape as extract.ts (review A3): seconds and a zone are required. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const MODEL_ID = /^[A-Za-z0-9._:\/-]{1,100}$/;
const RESPONSE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TURN_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Keys that resolve through the prototype chain; never kept (D28). */
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safeKey(v: unknown, re: RegExp): v is string {
  return typeof v === "string" && re.test(v) && !PROTO_KEYS.has(v);
}

function timestampOf(v: unknown): number {
  return typeof v === "string" && TIMESTAMP.test(v) ? Date.parse(v) : NaN;
}

/** Usage field → Tokens field; copied as logged (D45, D47): cache writes are not added into input. */
const TOKEN_FIELDS: readonly [string, keyof Tokens][] = [
  ["input_tokens", "input"],
  ["cached_input_tokens", "cacheRead"],
  ["cache_write_input_tokens", "cacheWrite"],
  ["output_tokens", "output"],
  ["reasoning_output_tokens", "reasoning"],
];

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Needle pre-gate on raw bytes (native Buffer.indexOf), bounded to the line: buf is often a
 * whole read chunk, so the search runs on a zero-copy view of buf[start, end) and never past
 * the line's end. The scanner later confirms the depth-1 type; parseCodexLine re-dispatches
 * when the confirmed type is another of the four (a nested needle picked the wrong class).
 */
export function classifyCodexLine(buf: Buffer, start: number, end: number): CodexLineClass {
  const line = buf.subarray(start, end);
  if (line.indexOf(RECORD_NEEDLE) !== -1) return "record";
  if (line.indexOf(TURN_NEEDLE) !== -1) return "turn";
  if (line.indexOf(META_NEEDLE) !== -1) return "meta";
  if (line.indexOf(EVENT_NEEDLE) !== -1) return "event";
  return "skip";
}

/** The depth-1 type confirmed by the scanner is another gated class: parse the line as that. */
interface Redirect {
  redirect: CodexLineClass;
}
type Parsed = CodexParse | Redirect;

const CLASS_OF_TYPE: ReadonlyMap<string, CodexLineClass> = new Map([
  [RECORD_TYPE, "record"],
  [TURN_TYPE, "turn"],
  [META_TYPE, "meta"],
  [EVENT_TYPE, "event"],
]);

/** True when any requested path matched more than once (a duplicate key). */
function hasDuplicate(res: ScanResult): boolean {
  for (const list of res.ranges.values()) if (list.length > 1) return true;
  return false;
}

/** Tokens from a usage slice; "too-large" when the slice exceeds MAX_SLICE_BYTES, undefined when nothing valid. */
function tokensAt(buf: Buffer, res: ScanResult, key: string): Tokens | "too-large" | undefined {
  const r = res.ranges.get(key)?.[0];
  if (r === undefined) return undefined;
  if (r.end - r.start > MAX_SLICE_BYTES) return "too-large";
  const v = parseSlice(buf, r);
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const tokens: Tokens = {};
  let any = false;
  for (const [from, to] of TOKEN_FIELDS) {
    const n = Object.prototype.hasOwnProperty.call(obj, from) ? obj[from] : undefined;
    if (isCount(n)) {
      tokens[to] = n;
      any = true;
    }
  }
  return any ? tokens : undefined;
}

/** Scans buf[start, end) for `paths`; undefined when the line is truncated, has a duplicate key, or its depth-1 type is not `type`. */
function scanTyped(buf: Buffer, start: number, end: number, paths: readonly ScanPath[], type: string): ScanResult | "malformed" | "other" | Redirect {
  const res = scanJson(buf, start, end, paths);
  if (!res.complete || hasDuplicate(res)) return "malformed";
  const actual = stringAt(buf, res, "type");
  if (actual === type) return res;
  const cls = actual === undefined ? undefined : CLASS_OF_TYPE.get(actual);
  return cls === undefined ? "other" : { redirect: cls };
}

function parseRecord(buf: Buffer, start: number, end: number, state: CodexFileState, o: CodexParseOptions): Parsed {
  const res = scanTyped(buf, start, end, RECORD_PATHS, RECORD_TYPE);
  if (res === "malformed") return { kind: "malformed" };
  if (res === "other") return { kind: "ignored" };
  if ("redirect" in res) return res;
  const key = stringAt(buf, res, "payload.response_id");
  if (!safeKey(key, RESPONSE_ID)) return { kind: "unrecognized", reason: "no-key" };
  const timestampMs = timestampOf(stringAt(buf, res, "timestamp"));
  if (Number.isNaN(timestampMs)) return { kind: "unrecognized", reason: "bad-timestamp" };
  const tokens = tokensAt(buf, res, "payload.usage");
  if (tokens === "too-large") return { kind: "unrecognized", reason: "slice-too-large" };
  if (tokens === undefined) return { kind: "unrecognized", reason: "no-known-token-field" };
  const sid = stringAt(buf, res, "payload.session_id");
  const sessionId = isSessionId(sid) ? sid : o.fileSessionId;
  const turn = stringAt(buf, res, "payload.turn_id");
  const model = (safeKey(turn, TURN_ID) ? state.models.get(turn) : undefined) ?? state.latestModel;
  const record: UsageRecord = {
    key,
    keySource: "codexResponseId",
    source: "codex",
    kind: "call",
    sessionId,
    folderId: sessionId,
    timestampMs,
    tokens,
  };
  if (model !== undefined) record.model = model;
  return { kind: "usage", record };
}

function parseTurn(buf: Buffer, start: number, end: number, state: CodexFileState): Parsed {
  const res = scanTyped(buf, start, end, TURN_PATHS, TURN_TYPE);
  if (res === "malformed") return { kind: "malformed" };
  if (res === "other") return { kind: "ignored" };
  if ("redirect" in res) return res;
  state.sawTurn = true;
  const model = stringAt(buf, res, "payload.model");
  if (!safeKey(model, MODEL_ID)) return { kind: "turn" };
  state.latestModel = model;
  const turn = stringAt(buf, res, "payload.turn_id");
  if (safeKey(turn, TURN_ID)) {
    // Re-inserting moves a turn to the newest end; at the cap the oldest turn is dropped.
    state.models.delete(turn);
    if (state.models.size >= CODEX_MAX_TURNS) {
      const oldest = state.models.keys().next();
      if (oldest.done !== true) state.models.delete(oldest.value);
    }
    state.models.set(turn, model);
  }
  return { kind: "turn" };
}

function parseMeta(buf: Buffer, start: number, end: number, state: CodexFileState, o: CodexParseOptions): Parsed {
  // Only the file's first label is wanted: once one is known, cwd is not requested.
  const want = o.wantLabel && state.label === undefined;
  const res = scanTyped(buf, start, end, want ? META_LABEL_PATHS : META_PATHS, META_TYPE);
  if (res === "malformed") return { kind: "malformed" };
  if (res === "other") return { kind: "ignored" };
  if ("redirect" in res) return res;
  if (!want) return { kind: "meta" };
  const cwd = stringAt(buf, res, "payload.cwd");
  const label = cwd === undefined ? undefined : folderLabel(cwd);
  return label === undefined ? { kind: "meta" } : { kind: "meta", label };
}

function parseEvent(buf: Buffer, start: number, end: number, state: CodexFileState, o: CodexParseOptions): Parsed {
  // Only token_count totals are wanted from event lines; without them the line is not scanned.
  if (!o.readTotals) return { kind: "ignored" };
  const res = scanTyped(buf, start, end, EVENT_TOTAL_PATHS, EVENT_TYPE);
  if (res === "malformed") return { kind: "malformed" };
  if (res === "other") return { kind: "ignored" };
  if ("redirect" in res) return res;
  if (stringAt(buf, res, "payload.type") !== TOKEN_COUNT) return { kind: "ignored" };
  const timestampMs = timestampOf(stringAt(buf, res, "timestamp"));
  if (Number.isNaN(timestampMs)) return { kind: "unrecognized", reason: "bad-timestamp" };
  const tokens = tokensAt(buf, res, "payload.info.total_token_usage");
  if (tokens === "too-large") return { kind: "unrecognized", reason: "slice-too-large" };
  if (tokens === undefined) return { kind: "unrecognized", reason: "no-known-token-field" };
  const sessionId = o.fileSessionId;
  const record: UsageRecord = {
    key: `codex-total:${sessionId}`,
    keySource: "codexTotal",
    source: "codex",
    kind: "sessionTotal",
    sessionId,
    folderId: sessionId,
    timestampMs,
    tokens,
  };
  if (state.latestModel !== undefined) record.model = state.latestModel;
  return { kind: "total", record };
}

/**
 * Decodes the allowlisted slices of one gated line. A turn_context line updates `state`
 * (turn → model, latest model, sawTurn); a session_meta line returns its folder label (the
 * caller keeps the first). Never throws for any input bytes.
 */
export function parseCodexLine(
  buf: Buffer,
  start: number,
  end: number,
  cls: CodexLineClass,
  state: CodexFileState,
  o: CodexParseOptions,
): CodexParse {
  const first = dispatch(buf, start, end, cls, state, o);
  if (!("redirect" in first)) return first;
  // Re-dispatch once on the confirmed type; a second mismatch cannot happen, but is ignored.
  const second = dispatch(buf, start, end, first.redirect, state, o);
  return "redirect" in second ? { kind: "ignored" } : second;
}

function dispatch(buf: Buffer, start: number, end: number, cls: CodexLineClass, state: CodexFileState, o: CodexParseOptions): Parsed {
  switch (cls) {
    case "record":
      return parseRecord(buf, start, end, state, o);
    case "turn":
      return parseTurn(buf, start, end, state);
    case "meta":
      return parseMeta(buf, start, end, state, o);
    case "event":
      return parseEvent(buf, start, end, state, o);
    case "skip":
      return { kind: "ignored" };
  }
}

// ---- discovery --------------------------------------------------------------

const YEAR = /^\d{4}$/;
const TWO_DIGITS = /^\d{2}$/;
const ROLLOUT = /^rollout-.*\.jsonl$/;
const TRAILING_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SESSIONS = "sessions";
const ARCHIVED = "archived_sessions";

function errCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "OTHER";
}

function sessionIdOf(name: string): string {
  const m = TRAILING_UUID.exec(name);
  if (m !== null && isSessionId(m[1])) return m[1];
  return name.slice(0, -".jsonl".length);
}

async function subdirs(dir: string, re: RegExp): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && re.test(e.name)).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Entries in archived_sessions/, by name only; 0 when absent. Never opens a file. */
async function archivedCount(root: string): Promise<number> {
  try {
    return (await fs.promises.readdir(path.join(root, ARCHIVED))).length;
  } catch {
    return 0;
  }
}

/**
 * Walks <root>/sessions/YYYY/MM/DD (digit folders on or after the local day of windowStartMs)
 * for regular rollout-*.jsonl files modified in the window; one candidate per file.
 */
export async function discoverCodex(root: string, windowStartMs: number, dayStartMs: number, nowMs: number): Promise<SourceDiscoverResult> {
  const sessions = path.join(root, SESSIONS);
  let dirMtimeMs: number;
  let years: string[];
  try {
    const st = await fs.promises.stat(sessions);
    if (!st.isDirectory()) return { ok: false, error: "no-dir" };
    dirMtimeMs = st.mtimeMs;
    const entries = await fs.promises.readdir(sessions, { withFileTypes: true });
    years = entries.filter((e) => e.isDirectory() && YEAR.test(e.name)).map((e) => e.name).sort();
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, error: "no-dir" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, error: "permission" };
    return { ok: false, error: "OTHER" };
  }
  // Date folders are assumed to be named by the local calendar day the session started. One
  // day of slack keeps a session begun the evening before the window's first day (or a folder
  // named by the UTC day) in reach; records dated before the window are harmless to the buckets.
  const w = new Date(windowStartMs);
  const slack = new Date(w.getFullYear(), w.getMonth(), w.getDate() - 1);
  const first = slack.getFullYear() * 10_000 + (slack.getMonth() + 1) * 100 + slack.getDate();
  const liveFrom = Math.max(dayStartMs, nowMs - RECENT_MS);
  const candidates: SourceCandidate[] = [];
  const unreadable: SourceUnreadable[] = [];
  for (const y of years) {
    const yn = Number(y) * 10_000;
    if (yn + 1231 < first) continue;
    for (const m of await subdirs(path.join(sessions, y), TWO_DIGITS)) {
      const mn = yn + Number(m) * 100;
      if (mn + 31 < first) continue;
      for (const d of await subdirs(path.join(sessions, y, m), TWO_DIGITS)) {
        if (mn + Number(d) < first) continue;
        const dir = path.join(sessions, y, m, d);
        let names: string[];
        try {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          names = entries.filter((e) => e.isFile() && ROLLOUT.test(e.name)).map((e) => e.name);
        } catch (e) {
          const code = errCode(e);
          if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push({ folderId: `${y}/${m}/${d}`, path: dir, code });
          continue;
        }
        for (const name of names) {
          const p = path.join(dir, name);
          const sessionId = sessionIdOf(name);
          let st: fs.Stats;
          try {
            st = await fs.promises.lstat(p);
          } catch (e) {
            const code = errCode(e);
            if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push({ folderId: sessionId, path: p, code });
            continue;
          }
          if (!st.isFile() || st.mtimeMs < windowStartMs) continue;
          candidates.push({
            source: "codex",
            sessionId,
            folderId: sessionId,
            files: [{ path: p, mtimeMs: st.mtimeMs, size: st.size }],
            mtimeMs: st.mtimeMs,
            live: st.mtimeMs >= liveFrom,
          });
        }
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { ok: true, candidates, unreadable, dirMtimeMs, archived: await archivedCount(root) };
}

// ---- reading ----------------------------------------------------------------

/** Reads one rollout file incrementally; state (models, label, whether a record was seen) lives until a reset. */
class CodexFileReader implements FileReader {
  private tailer: ByteTailer;
  private state: CodexFileState = { models: new Map(), sawTurn: false };
  private sawMeta = false;
  private sawRecord = false;
  private out: FileReadResult = emptyReadResult();
  private lastTotal: UsageRecord | undefined;
  /** the label last reported: it is reported once, when first known (and again after a reset) */
  private shown: string | undefined;

  constructor(
    private readonly filePath: string,
    private readonly fileSessionId: string,
    private readonly readProjects: boolean,
    private readonly readTotals: boolean,
  ) {
    this.tailer = this.newTailer();
  }

  private newTailer(): ByteTailer {
    const handler: LineHandler = {
      line: (buf, start, end) => this.line(buf, start, end),
      overlong: (buf, start, end) => this.overlong(buf, start, end),
    };
    return new ByteTailer(this.filePath, handler, { maxLineBytes: CODEX_MAX_LINE_BYTES, headBytes: MAX_SLICE_BYTES });
  }

  private line(buf: Buffer, start: number, end: number): void {
    try {
      const cls = classifyCodexLine(buf, start, end);
      if (cls === "skip") return;
      // Once the file has a record its totals are never emitted, so token_count lines need no decoding.
      const p = parseCodexLine(buf, start, end, cls, this.state, {
        fileSessionId: this.fileSessionId,
        wantLabel: this.readProjects && !this.sawMeta,
        readTotals: this.readTotals && !this.sawRecord,
      });
      const out = this.out;
      switch (p.kind) {
        case "usage":
          this.sawRecord = true;
          this.lastTotal = undefined;
          out.records.push(p.record);
          out.usage++;
          break;
        case "total":
          this.lastTotal = p.record;
          break;
        case "turn":
          out.activity++;
          break;
        case "meta":
          if (!this.sawMeta) {
            this.sawMeta = true;
            if (p.label !== undefined) this.state.label = p.label;
          }
          break;
        case "ignored":
          break;
        case "unrecognized":
          out.unrecognized++;
          break;
        case "malformed":
          out.malformed++;
          break;
      }
    } catch {
      this.out.malformed++;
    }
  }

  /** An over-long line is never read; its head shows whether it may have been a record. */
  private overlong(buf: Buffer, start: number, end: number): void {
    try {
      if (classifyCodexLine(buf, start, end) === "record") this.out.overlong++;
      else this.out.overlongOther++;
    } catch {
      this.out.overlong++;
    }
  }

  private resetState(): void {
    this.state = { models: new Map(), sawTurn: false };
    this.sawMeta = false;
    this.sawRecord = false;
    this.shown = undefined;
  }

  private async readOnce(): Promise<{ reset: boolean; error?: FileReadResult["error"] }> {
    this.out = emptyReadResult();
    this.lastTotal = undefined;
    return this.tailer.read();
  }

  async read(): Promise<FileReadResult> {
    let r = await this.readOnce();
    if (r.reset) {
      // The lines just handled came from a rewritten file but were parsed with the old
      // file's state (models, label, records seen): start over with a fresh tailer.
      this.resetState();
      this.tailer = this.newTailer();
      r = { ...(await this.readOnce()), reset: true };
    }
    const out = this.out;
    out.reset = r.reset;
    if (r.error !== undefined) out.error = r.error;
    if (this.state.label !== undefined && this.state.label !== this.shown) {
      out.label = this.state.label;
      this.shown = this.state.label;
    }
    if (this.lastTotal !== undefined && !this.sawRecord) {
      out.totals = [this.lastTotal];
      out.hasTotals = true;
    }
    this.lastTotal = undefined;
    return out;
  }
}

export class CodexSourceReader implements SourceReader {
  readonly source = "codex" as const;
  readonly root: string;
  readonly rootSource: "setting" | "env" | "default";
  private readonly readProjects: boolean;
  private readonly readTotals: boolean;

  constructor(o: { root: string; rootSource: "setting" | "env" | "default"; readProjects: boolean; readTotals: boolean }) {
    this.root = o.root;
    this.rootSource = o.rootSource;
    this.readProjects = o.readProjects;
    this.readTotals = o.readTotals;
  }

  async rootDirMtime(): Promise<number | undefined> {
    try {
      return (await fs.promises.stat(path.join(this.root, SESSIONS))).mtimeMs;
    } catch {
      return undefined;
    }
  }

  discover(windowStartMs: number, dayStartMs: number, nowMs: number): Promise<SourceDiscoverResult> {
    return discoverCodex(this.root, windowStartMs, dayStartMs, nowMs);
  }

  /** Pure path check: <root>/sessions/<4 digits>/<2 digits>/<2 digits>/rollout-*.jsonl. */
  pathAllowed(p: string): boolean {
    const rel = path.relative(path.resolve(this.root), path.resolve(p));
    if (rel === "" || path.isAbsolute(rel)) return false;
    const segs = rel.split(/[\\/]/);
    return (
      segs.length === 5 &&
      segs[0] === SESSIONS &&
      YEAR.test(segs[1]!) &&
      TWO_DIGITS.test(segs[2]!) &&
      TWO_DIGITS.test(segs[3]!) &&
      ROLLOUT.test(segs[4]!)
    );
  }

  open(p: string, c: SourceCandidate): FileReader {
    return new CodexFileReader(p, c.sessionId, this.readProjects, this.readTotals);
  }
}
