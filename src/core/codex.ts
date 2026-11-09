// The Codex reader (D45). Rollout files under sessions/YYYY/MM/DD are tailed
// as raw bytes; classifyCodexLine gates each line on four type needles and
// everything else is skipped undecoded. A gated line is walked by the path
// scanner (D41) for an allowlist of absolute paths only, and only those slices
// are decoded, through parseSlice/stringAt. Prompts, replies, instructions,
// git and sandbox details, the allowance-like event fields and the per-turn and
// per-thread usage copies are never requested, so they are never decoded. Usage
// counts are requested one scalar path each; the usage objects are never decoded.
// archived_sessions/ is counted by name and never opened; nothing else under
// the Codex home is listed.
// Session totals (token_count, D45) carry the file's session id (the line has
// no session_id) and the latest model seen in the file, when one is known.
// Records carry folderId = the file's session id and sessionId = payload.session_id
// when it is one (like Copilot's folder vs source session id).
import * as fs from "node:fs";
import * as path from "node:path";
import { isSessionId } from "./extract";
import { parseSlice, MAX_SLICE_BYTES, scanJson, stringAt, type ScanPath, type ScanResult, type SliceRange } from "./jsonScan";
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
import { estimateNanoAiu } from "./pricing";
import { ByteTailer, type LineHandler } from "./tailer";
import type { Tokens, UsageRecord } from "./types";

/** Longest line handed to the parser; longer lines are counted, not read. */
export const CODEX_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** turn id → model entries kept per file; past this the oldest entry is dropped. */
export const CODEX_MAX_TURNS = 1024;
/** Bytes of an over-long line's head classifyCodexHead looks at. */
export const CODEX_HEAD_BYTES = 4096;

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

/** Usage field → Tokens field; copied as logged (D45, D47): cache writes are not added into input. */
const TOKEN_FIELDS: readonly [string, keyof Tokens][] = [
  ["input_tokens", "input"],
  ["cached_input_tokens", "cacheRead"],
  ["cache_write_input_tokens", "cacheWrite"],
  ["output_tokens", "output"],
  ["reasoning_output_tokens", "reasoning"],
];

const USAGE_BASE: ScanPath = ["payload", "usage"];
const TOTAL_BASE: ScanPath = ["payload", "info", "total_token_usage"];
/** The five scalar paths under `base`: the usage object itself is never requested. */
const scalarPaths = (base: ScanPath): ScanPath[] => TOKEN_FIELDS.map(([from]) => [...base, from]);

/** The only paths ever requested, per line class. */
const RECORD_PATHS: readonly ScanPath[] = [
  ["type"],
  ["timestamp"],
  ["payload", "session_id"],
  ["payload", "turn_id"],
  ["payload", "response_id"],
  ...scalarPaths(USAGE_BASE),
];
const TURN_PATHS: readonly ScanPath[] = [["type"], ["payload", "turn_id"], ["payload", "model"]];
const META_PATHS: readonly ScanPath[] = [["type"]];
const META_LABEL_PATHS: readonly ScanPath[] = [["type"], ["payload", "cwd"]];
const EVENT_TOTAL_PATHS: readonly ScanPath[] = [["type"], ["timestamp"], ["payload", "type"], ...scalarPaths(TOTAL_BASE)];

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

/** "record" | "other" from the first CODEX_HEAD_BYTES of an over-long line only (never the whole line). Raw bytes only. */
export function classifyCodexHead(buf: Buffer, start: number, end: number): "record" | "other" {
  return classifyCodexLine(buf, start, Math.min(end, start + CODEX_HEAD_BYTES)) === "record" ? "record" : "other";
}

const TOKEN_COUNT_NEEDLE = needle(TOKEN_COUNT);

/** An event-class line whose raw bytes name token_count: a candidate for a session total. */
function isTokenCountLine(buf: Buffer, start: number, end: number): boolean {
  return buf.subarray(start, end).indexOf(TOKEN_COUNT_NEEDLE) !== -1;
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

const MINUS = 0x2d;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
/** A token count: a safe integer has at most 16 digits. */
const MAX_COUNT_BYTES = 32;

/** One count slice: only a slice that starts like a number is decoded, so a string there never becomes a JS value. */
function countOf(buf: Buffer, r: SliceRange): number | undefined {
  const c = buf[r.start];
  if (c === undefined || !(c === MINUS || (c >= DIGIT_0 && c <= DIGIT_9))) return undefined;
  const v = parseSlice(buf, r, MAX_COUNT_BYTES);
  return isCount(v) ? v : undefined;
}

/** Tokens from the five scalar paths under `base`: "too-large" when a slice exceeds MAX_SLICE_BYTES, undefined when none is valid. */
function tokensAt(buf: Buffer, res: ScanResult, base: ScanPath): Tokens | "too-large" | undefined {
  const prefix = base.join(".");
  const tokens: Tokens = {};
  let any = false;
  for (const [from, to] of TOKEN_FIELDS) {
    const r = res.ranges.get(`${prefix}.${from}`)?.[0];
    if (r === undefined) continue;
    if (r.end - r.start > MAX_SLICE_BYTES) return "too-large";
    const n = countOf(buf, r);
    if (n === undefined) continue;
    tokens[to] = n;
    any = true;
  }
  return any ? tokens : undefined;
}

const allZero = (t: Tokens): boolean => Object.values(t).every((v) => v === 0);

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
  const tokens = tokensAt(buf, res, USAGE_BASE);
  if (tokens === "too-large") return { kind: "unrecognized", reason: "slice-too-large" };
  if (tokens === undefined) return { kind: "unrecognized", reason: "no-known-token-field" };
  // Zero usage (every present count 0): not a call.
  if (allZero(tokens)) return { kind: "ignored" };
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
    folderId: o.fileSessionId,
    timestampMs,
    tokens,
  };
  if (model !== undefined) record.model = model;
  priced(record);
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
  const tokens = tokensAt(buf, res, TOTAL_BASE);
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
  priced(record);
  return { kind: "total", record };
}

/** Codex logs no cost: the record's cost is estimated from its tokens at the model's list price (v0.10). */
function priced(record: UsageRecord): void {
  const cost = estimateNanoAiu(record);
  if (cost !== undefined) record.nanoAiu = cost;
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

/** The trailing session-id-shaped UUID of a rollout file name; undefined when it has none (the file is skipped). */
function sessionIdOf(name: string): string | undefined {
  const m = TRAILING_UUID.exec(name);
  return m !== null && isSessionId(m[1]) ? m[1] : undefined;
}

/** Sorted names of the subfolders of `dir` matching `re`; a listing error other than ENOENT/ENOTDIR is reported as unreadable under `folderId` (the YYYY or YYYY/MM segment). */
async function subdirs(dir: string, re: RegExp, folderId?: string, unreadable?: SourceUnreadable[]): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && re.test(e.name)).map((e) => e.name).sort();
  } catch (e) {
    const code = errCode(e);
    if (unreadable !== undefined && folderId !== undefined && code !== "ENOENT" && code !== "ENOTDIR") {
      unreadable.push({ folderId, path: dir, code });
    }
    return [];
  }
}

/** The two newest day folders under sessions/ by name (newest first); listing errors are skipped. */
async function newestDayDirs(sessions: string): Promise<string[]> {
  const out: string[] = [];
  for (const y of (await subdirs(sessions, YEAR)).reverse()) {
    for (const m of (await subdirs(path.join(sessions, y), TWO_DIGITS)).reverse()) {
      for (const d of (await subdirs(path.join(sessions, y, m), TWO_DIGITS)).reverse()) {
        out.push(path.join(sessions, y, m, d));
        if (out.length === 2) return out;
      }
    }
  }
  return out;
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
 * How often CodexSourceReader walks the date folders older than the window. A resumed session
 * appends to its rollout file in the folder of the day it started, so those folders can hold
 * usage in the window; between walks only the old files last found in the window are re-stat'ed.
 */
export const CODEX_OLD_SCAN_MS = 5 * 60_000;

/** What a discovery found in the date folders older than the window. */
export interface CodexOldFolders {
  /** rollout files there modified in the window, or whose lstat failed (re-stat'ed until the next walk) */
  paths: string[];
  /** unreadable year, month or day folders there */
  unreadable: SourceUnreadable[];
}

/** The window's first day less one day of slack, as YYYYMMDD. */
function firstDayOf(windowStartMs: number): number {
  // Date folders are assumed to be named by the local calendar day the session started. One
  // day of slack keeps a session begun the evening before the window's first day (or a folder
  // named by the UTC day) in the cheap walk.
  const w = new Date(windowStartMs);
  const slack = new Date(w.getFullYear(), w.getMonth(), w.getDate() - 1);
  return slack.getFullYear() * 10_000 + (slack.getMonth() + 1) * 100 + slack.getDate();
}

/**
 * Walks <root>/sessions/YYYY/MM/DD for regular rollout-*.jsonl files modified in the window;
 * one candidate per file. A folder's name is the day its session started, not the day it was
 * last written (a resumed session appends to the old file), so folders older than the window
 * are walked too, unless `old` is given: then only its paths are re-stat'ed there and its
 * unreadable folders reported again. Records dated before the window are filtered later.
 */
export async function discoverCodex(
  root: string,
  windowStartMs: number,
  dayStartMs: number,
  nowMs: number,
  old?: CodexOldFolders,
): Promise<SourceDiscoverResult> {
  return (await discoverCodexWalk(root, windowStartMs, dayStartMs, nowMs, old)).result;
}

async function discoverCodexWalk(
  root: string,
  windowStartMs: number,
  dayStartMs: number,
  nowMs: number,
  known: CodexOldFolders | undefined,
): Promise<{ result: SourceDiscoverResult; old?: CodexOldFolders }> {
  const sessions = path.join(root, SESSIONS);
  let dirMtimeMs: number;
  let years: string[];
  try {
    const st = await fs.promises.stat(sessions);
    if (!st.isDirectory()) return { result: { ok: false, error: "no-dir" } };
    dirMtimeMs = st.mtimeMs;
    const entries = await fs.promises.readdir(sessions, { withFileTypes: true });
    years = entries.filter((e) => e.isDirectory() && YEAR.test(e.name)).map((e) => e.name).sort();
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { result: { ok: false, error: "no-dir" } };
    if (code === "EACCES" || code === "EPERM") return { result: { ok: false, error: "permission" } };
    return { result: { ok: false, error: "OTHER" } };
  }
  const first = firstDayOf(windowStartMs);
  const liveFrom = Math.max(dayStartMs, nowMs - RECENT_MS);
  const candidates: SourceCandidate[] = [];
  const unreadable: SourceUnreadable[] = [];
  // Found in folders older than the window (wholly so, for a year or month folder).
  const old: CodexOldFolders = { paths: [], unreadable: [] };
  const walkOld = known === undefined;

  /** Adds the rollout file `p` when it is a regular file modified in the window; an lstat error other than ENOENT/ENOTDIR is reported. */
  const consider = async (p: string, sessionId: string, errors: SourceUnreadable[]): Promise<"added" | "skipped" | "error"> => {
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(p);
    } catch (e) {
      const code = errCode(e);
      if (code === "ENOENT" || code === "ENOTDIR") return "skipped";
      errors.push({ folderId: sessionId, path: p, code });
      return "error";
    }
    if (!st.isFile() || st.mtimeMs < windowStartMs) return "skipped";
    candidates.push({
      source: "codex",
      sessionId,
      folderId: sessionId,
      files: [{ path: p, mtimeMs: st.mtimeMs, size: st.size }],
      mtimeMs: st.mtimeMs,
      live: st.mtimeMs >= liveFrom,
    });
    return "added";
  };

  for (const y of years) {
    const yn = Number(y) * 10_000;
    const oldYear = yn + 1231 < first;
    if (oldYear && !walkOld) continue;
    for (const m of await subdirs(path.join(sessions, y), TWO_DIGITS, y, oldYear ? old.unreadable : unreadable)) {
      const mn = yn + Number(m) * 100;
      const oldMonth = mn + 31 < first;
      if (oldMonth && !walkOld) continue;
      for (const d of await subdirs(path.join(sessions, y, m), TWO_DIGITS, `${y}/${m}`, oldMonth ? old.unreadable : unreadable)) {
        const oldDay = mn + Number(d) < first;
        if (oldDay && !walkOld) continue;
        const errors = oldDay ? old.unreadable : unreadable;
        const dir = path.join(sessions, y, m, d);
        let names: string[];
        try {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          names = entries.filter((e) => e.isFile() && ROLLOUT.test(e.name)).map((e) => e.name);
        } catch (e) {
          const code = errCode(e);
          if (code !== "ENOENT" && code !== "ENOTDIR") errors.push({ folderId: `${y}/${m}/${d}`, path: dir, code });
          continue;
        }
        for (const name of names) {
          const sessionId = sessionIdOf(name);
          if (sessionId === undefined) continue;
          const p = path.join(dir, name);
          // An old file is re-stat'ed by the quick walks when found in the window, and also when
          // its lstat failed: its error is this walk's only, so it clears once a re-stat succeeds.
          const found = await consider(p, sessionId, unreadable);
          if (oldDay && found !== "skipped") old.paths.push(p);
        }
      }
    }
  }
  if (known !== undefined) {
    // Between walks of the old folders: the old files last found in the window are re-stat'ed
    // (one that fails is kept, to be tried again) and the last walk's unreadable folders carried.
    // A cached path is only re-stat'ed while each of its year, month and day folders is still a
    // real folder: one replaced by a symlink (which a full walk never descends into) would
    // otherwise lead the lstat, and the reader, outside the root. Checks are shared within a walk.
    old.unreadable.push(...known.unreadable);
    const dirChecks = new Map<string, Promise<"ok" | "gone" | string>>();
    const realDir = (dir: string): Promise<"ok" | "gone" | string> => {
      let c = dirChecks.get(dir);
      if (c === undefined) {
        c = fs.promises.lstat(dir).then(
          (st) => (st.isDirectory() ? "ok" : "gone"),
          (e: unknown) => {
            const code = errCode(e);
            return code === "ENOENT" || code === "ENOTDIR" ? "gone" : code;
          },
        );
        dirChecks.set(dir, c);
      }
      return c;
    };
    paths: for (const p of known.paths) {
      const sessionId = sessionIdOf(path.basename(p));
      if (sessionId === undefined) continue;
      const segs = path.relative(sessions, p).split(/[\\/]/);
      if (segs.length !== 4) continue;
      let dir = sessions;
      for (const seg of segs.slice(0, 3)) {
        dir = path.join(dir, seg);
        const check = await realDir(dir);
        if (check === "gone") continue paths;
        if (check !== "ok") {
          // Not verifiable now (e.g. EACCES): kept, to be tried again, and reported like a failed lstat.
          unreadable.push({ folderId: sessionId, path: p, code: check });
          old.paths.push(p);
          continue paths;
        }
      }
      if ((await consider(p, sessionId, unreadable)) !== "skipped") old.paths.push(p);
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    result: { ok: true, candidates, unreadable: [...old.unreadable, ...unreadable], dirMtimeMs, archived: await archivedCount(root) },
    old,
  };
}

// ---- reading ----------------------------------------------------------------

/** Reads one rollout file incrementally; state (models, label, whether a record was seen) lives until a reset. */
class CodexFileReader implements FileReader {
  private tailer: ByteTailer;
  private state: CodexFileState = { models: new Map(), sawTurn: false };
  private sawMeta = false;
  private sawRecord = false;
  /** set when sawRecord first flips true: the next read() clears the file's session total */
  private clearTotals = false;
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
    return new ByteTailer(this.filePath, handler, { maxLineBytes: CODEX_MAX_LINE_BYTES, headBytes: CODEX_HEAD_BYTES });
  }

  private line(buf: Buffer, start: number, end: number): void {
    try {
      const cls = classifyCodexLine(buf, start, end);
      if (cls === "skip") return;
      // Record-class lines and token_count events could have yielded usage (D42 sessions without usage).
      if (cls === "record" || (cls === "event" && isTokenCountLine(buf, start, end))) {
        this.out.candidates = (this.out.candidates ?? 0) + 1;
      }
      // Once the file has a record its totals are never emitted, so token_count lines need no decoding.
      const p = parseCodexLine(buf, start, end, cls, this.state, {
        fileSessionId: this.fileSessionId,
        wantLabel: this.readProjects && !this.sawMeta,
        readTotals: this.readTotals && !this.sawRecord,
      });
      const out = this.out;
      switch (p.kind) {
        case "usage":
          if (!this.sawRecord) {
            this.sawRecord = true;
            // The file's total is replaced by its records from now on: drop any stored total,
            // whatever session id the records carry (the store keys it by this file).
            if (this.readTotals) this.clearTotals = true;
          }
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

  /** An over-long line is never read; its first CODEX_HEAD_BYTES show whether it may have been a record. */
  private overlong(buf: Buffer, start: number, end: number): void {
    try {
      if (classifyCodexHead(buf, start, end) === "record") this.out.overlong++;
      else this.out.overlongOther++;
    } catch {
      this.out.overlong++;
    }
  }

  private resetState(): void {
    this.state = { models: new Map(), sawTurn: false };
    this.sawMeta = false;
    this.sawRecord = false;
    this.clearTotals = false;
    this.shown = undefined;
  }

  private async readOnce(): Promise<{ reset: boolean; error?: FileReadResult["error"] }> {
    this.out = { ...emptyReadResult(), candidates: 0 };
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
    } else if (this.clearTotals) {
      out.totals = [];
      out.hasTotals = true;
    }
    this.clearTotals = false;
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
  /** what the last discovery found in date folders older than the window; undefined forces a walk of them */
  private old: CodexOldFolders | undefined;
  /** when, and for which window, the old folders were last walked */
  private oldScanAt = 0;
  private oldWindowStartMs = Number.NaN;

  constructor(o: { root: string; rootSource: "setting" | "env" | "default"; readProjects: boolean; readTotals: boolean }) {
    this.root = o.root;
    this.rootSource = o.rootSource;
    this.readProjects = o.readProjects;
    this.readTotals = o.readTotals;
  }

  /**
   * The cheap change check (D50): the newest mtime of sessions/ and of its two newest day
   * folders (by name). A new rollout file bumps its day folder; an append does not.
   * undefined when sessions/ is missing or unreadable.
   */
  async rootDirMtime(): Promise<number | undefined> {
    const sessions = path.join(this.root, SESSIONS);
    let max: number;
    try {
      max = (await fs.promises.stat(sessions)).mtimeMs;
    } catch {
      return undefined;
    }
    for (const dir of await newestDayDirs(sessions)) {
      try {
        max = Math.max(max, (await fs.promises.stat(dir)).mtimeMs);
      } catch {
        // gone since the listing: the next check sees the change
      }
    }
    return max;
  }

  /**
   * Walks the date folders older than the window on the first discovery, when the window
   * changes, and every CODEX_OLD_SCAN_MS; in between it re-stats only the old files the last
   * walk found in the window, so a long history is not stat'ed file by file every minute. A full
   * refresh (`opts.full`) walks them at once, so a just-resumed old session shows without delay.
   */
  async discover(windowStartMs: number, dayStartMs: number, nowMs: number, opts?: { full?: boolean }): Promise<SourceDiscoverResult> {
    const due =
      opts?.full === true ||
      this.old === undefined ||
      this.oldWindowStartMs !== windowStartMs ||
      Math.abs(nowMs - this.oldScanAt) >= CODEX_OLD_SCAN_MS;
    const { result, old } = await discoverCodexWalk(this.root, windowStartMs, dayStartMs, nowMs, due ? undefined : this.old);
    if (!result.ok || old === undefined) {
      this.old = undefined;
      return result;
    }
    if (due) {
      this.oldScanAt = nowMs;
      this.oldWindowStartMs = windowStartMs;
    }
    this.old = old;
    return result;
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
