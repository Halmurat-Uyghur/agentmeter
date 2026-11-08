// The Claude Code reader (D42, D43, D52). Claude Code logs mix usage numbers
// with prompts, replies, thinking, tool inputs and whole files, so a line is
// never decoded whole. classifyClaudeLine gates on raw bytes; parseClaudeLine
// asks the path scanner (D41) for the D42 allowlist only and decodes just
// those small slices through parseSlice/stringAt, copying numbers and short
// ids into a fresh record. The cwd slice is reduced to a folder label (D44)
// and dropped; tool_use inputs, text, thinking and every other field are
// never turned into a string. Discovery lists directories and lstat's files:
// it never opens a file and never follows a symlink.
import * as fs from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isSessionId } from "./extract";
import { MAX_SLICE_BYTES, parseSlice, scanJson, stringAt, type ScanPath, type ScanResult, type SliceRange } from "./jsonScan";
import { folderLabel } from "./label";
import {
  emptyReadResult,
  RECENT_MS,
  type FileReader,
  type FileReadResult,
  type SourceCandidate,
  type SourceDiscoverResult,
  type SourceFile,
  type SourceReader,
  type SourceUnreadable,
} from "./source";
import { ByteTailer, type LineHandler } from "./tailer";
import type { FinishReason, Tokens, UsageRecord } from "./types";

/** Longest line handed to the parser; longer ones are counted from their head (D42). */
export const CLAUDE_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Bytes of an over-long line's head classifyClaudeHead looks at. */
export const CLAUDE_HEAD_BYTES = 4096;
/** Files lstat'ed per discovery; the rest are counted as `capped` (D50). */
export const CLAUDE_MAX_FILES = 10_000;
/** Deepest file below projects/ (projects/<slug>/<id>/subagents/workflows/wf_x/agent-y.jsonl is 6). */
export const CLAUDE_MAX_DEPTH = 6;

export type ClaudeLineClass = "assistant" | "user" | "skip";

export type ClaudeParse =
  | { kind: "usage"; record: UsageRecord; label?: string }
  | { kind: "ignored" }
  | { kind: "unrecognized"; reason: "no-usage-object" | "no-key" | "bad-timestamp" | "no-known-token-field" | "slice-too-large" }
  | { kind: "malformed" };

// Raw needles. Inside a JSON string value quotes are escaped as \", so prompt
// or tool text can never match them.
const ASSISTANT_NEEDLE = Buffer.from(`"type":"assistant"`);
const USER_NEEDLE = Buffer.from(`"type":"user"`);
/** Real user lines carry `type` within their first 152 bytes. */
const USER_HEAD_BYTES = 256;
const MESSAGE_OPEN = Buffer.from(`"message":{`);
const ROLE_ASSISTANT = Buffer.from(`"role":"assistant"`);
const CR = 0x0d;

/** Native needle pre-gate: `"type":"assistant"` anywhere → "assistant"; else `"type":"user"` within the first 256 bytes → "user"; else "skip". No decoding. */
export function classifyClaudeLine(buf: Buffer, start: number, end: number): ClaudeLineClass {
  if (buf.subarray(start, end).includes(ASSISTANT_NEEDLE)) return "assistant";
  return hasUserHead(buf, start, end) ? "user" : "skip";
}

function hasUserHead(buf: Buffer, start: number, end: number): boolean {
  return buf.subarray(start, Math.min(end, start + USER_HEAD_BYTES)).includes(USER_NEEDLE);
}

/** "assistant" | "other" from the first CLAUDE_HEAD_BYTES of an over-long line: `"role":"assistant"` inside message → assistant. Raw bytes only. */
export function classifyClaudeHead(buf: Buffer, start: number, end: number): "assistant" | "other" {
  const head = buf.subarray(start, Math.min(end, start + CLAUDE_HEAD_BYTES));
  const m = head.indexOf(MESSAGE_OPEN);
  return m >= 0 && head.indexOf(ROLE_ASSISTANT, m + MESSAGE_OPEN.length) >= 0 ? "assistant" : "other";
}

// The D42 allowlist: the only paths ever matched. `cwd` only when a label is wanted.
const P_TYPE = "type";
const P_REQUEST_ID = "requestId";
const P_TIMESTAMP = "timestamp";
const P_SESSION_ID = "sessionId";
const P_CWD = "cwd";
const P_ID = "message.id";
const P_MODEL = "message.model";
const P_STOP = "message.stop_reason";
const P_USAGE = "message.usage";
const P_CONTENT_TYPE = "message.content[].type";
const P_CONTENT_NAME = "message.content[].name";
const BASE_PATHS: readonly ScanPath[] = [
  ["type"],
  ["requestId"],
  ["timestamp"],
  ["sessionId"],
  ["message", "id"],
  ["message", "model"],
  ["message", "stop_reason"],
  ["message", "usage"],
  ["message", "content", "[]", "type"],
  ["message", "content", "[]", "name"],
];
const LABEL_PATHS: readonly ScanPath[] = [...BASE_PATHS, ["cwd"]];
/** Paths that hold one value; more than one range there means duplicate keys. */
const SINGLE_PATHS = [P_TYPE, P_REQUEST_ID, P_TIMESTAMP, P_SESSION_ID, P_CWD, P_ID, P_MODEL, P_STOP, P_USAGE];

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const MODEL_ID = /^[A-Za-z0-9._:\/-]{1,100}$/;
/** Tool names: identifiers only (MCP tools look like mcp__server__tool). */
const TOOL_NAME = /^[A-Za-z0-9._:\/@-]{1,80}$/;
/** message.id and requestId: 28 chars observed. */
const CLAUDE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TOOLS = 64;
/** Keys that resolve through the prototype chain; never used as a map key (D28). */
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Byte bounds for decoded slices: a string slice includes its two quotes. */
const MAX_ID_BYTES = 130;
const MAX_MODEL_BYTES = 102;
const MAX_TOOL_BYTES = 82;
const MAX_TIMESTAMP_BYTES = 64;
const MAX_SESSION_BYTES = 66;

const ASSISTANT_VALUE = Buffer.from(`"assistant"`);
const TOOL_USE_VALUE = Buffer.from(`"tool_use"`);
const NULL_VALUE = Buffer.from("null");
const QUOTE = 0x22;
/** stop_reason compared as raw bytes; the log's string is never kept. */
const STOP_REASONS: readonly [Buffer, FinishReason][] = [
  [Buffer.from(`"end_turn"`), "stop"],
  [Buffer.from(`"tool_use"`), "tool_calls"],
  [Buffer.from(`"max_tokens"`), "length"],
  [Buffer.from(`"refusal"`), "content_filter"],
];

function safeKey(v: unknown, re: RegExp): v is string {
  return typeof v === "string" && re.test(v) && !PROTO_KEYS.has(v);
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sliceEquals(buf: Buffer, r: SliceRange, value: Buffer): boolean {
  return r.end - r.start === value.length && buf.compare(value, 0, value.length, r.start, r.end) === 0;
}

function only(res: ScanResult, path: string): SliceRange | undefined {
  const list = res.ranges.get(path);
  return list?.length === 1 ? list[0] : undefined;
}

function finishReasonOf(buf: Buffer, r: SliceRange | undefined): FinishReason | undefined {
  if (r === undefined || sliceEquals(buf, r, NULL_VALUE)) return undefined;
  for (const [bytes, reason] of STOP_REASONS) if (sliceEquals(buf, r, bytes)) return reason;
  // Any other string is "other"; a non-string is not reported.
  return buf[r.start] === QUOTE ? "other" : undefined;
}

/** tool_use names from message.content[]: the name slice is decoded only for an element whose type slice is "tool_use". */
function toolsOf(buf: Buffer, res: ScanResult): Record<string, number> | undefined {
  const types = res.ranges.get(P_CONTENT_TYPE) ?? [];
  const names = res.ranges.get(P_CONTENT_NAME) ?? [];
  if (types.length === 0 || names.length === 0) return undefined;
  const typeCount = new Map<number, number>();
  for (const t of types) if (t.idx !== undefined) typeCount.set(t.idx, (typeCount.get(t.idx) ?? 0) + 1);
  const nameAt = new Map<number, SliceRange | null>();
  for (const n of names) if (n.idx !== undefined) nameAt.set(n.idx, nameAt.has(n.idx) ? null : n);
  const tools: Record<string, number> = Object.create(null);
  let distinct = 0;
  for (const t of types) {
    if (t.idx === undefined || typeCount.get(t.idx) !== 1 || !sliceEquals(buf, t, TOOL_USE_VALUE)) continue;
    const n = nameAt.get(t.idx);
    if (!n || buf[n.start] !== QUOTE) continue;
    const name = parseSlice(buf, n, MAX_TOOL_BYTES);
    if (!safeKey(name, TOOL_NAME)) continue;
    const c = tools[name];
    if (c !== undefined) tools[name] = c + 1;
    else if (distinct < MAX_TOOLS) {
      tools[name] = 1;
      distinct++;
    }
  }
  return distinct > 0 ? tools : undefined;
}

/** Scans the line for exactly the D42 paths and copies the allowlist; `fileSessionId` is the UUID from the file name or parent directory; with `wantLabel` the cwd slice is reduced by folderLabel and dropped. */
export function parseClaudeLine(
  buf: Buffer,
  start: number,
  end: number,
  o: { fileSessionId: string; wantLabel: boolean },
): ClaudeParse {
  const stop = end > start && buf[end - 1] === CR ? end - 1 : end;
  const res = scanJson(buf, start, stop, o.wantLabel ? LABEL_PATHS : BASE_PATHS);
  if (!res.complete) return { kind: "malformed" };
  for (const p of SINGLE_PATHS) if ((res.ranges.get(p)?.length ?? 0) > 1) return { kind: "malformed" };

  const type = only(res, P_TYPE);
  if (type === undefined || !sliceEquals(buf, type, ASSISTANT_VALUE)) return { kind: "ignored" };

  const usageRange = only(res, P_USAGE);
  if (usageRange === undefined) return { kind: "unrecognized", reason: "no-usage-object" };
  if (usageRange.end - usageRange.start > MAX_SLICE_BYTES) return { kind: "unrecognized", reason: "slice-too-large" };
  const usage = parseSlice(buf, usageRange);
  if (usage === undefined) return { kind: "malformed" };
  if (!isObject(usage)) return { kind: "unrecognized", reason: "no-usage-object" };

  const raw = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens, usage.output_tokens];
  const [input, cacheRead, cacheWrite, output] = raw.map(count);
  const valid = [input, cacheRead, cacheWrite, output].filter((v): v is number => v !== undefined);
  if (valid.length === 0) {
    return raw.some((v) => v !== undefined)
      ? { kind: "unrecognized", reason: "no-known-token-field" }
      : { kind: "ignored" };
  }
  // Zero usage (e.g. model <synthetic>): not a call.
  if (valid.every((v) => v === 0)) return { kind: "ignored" };

  const id = stringAt(buf, res, P_ID, MAX_ID_BYTES);
  const requestId = stringAt(buf, res, P_REQUEST_ID, MAX_ID_BYTES);
  let key: string;
  let keySource: UsageRecord["keySource"];
  if (safeKey(id, CLAUDE_KEY)) {
    key = id;
    keySource = "claudeMessageId";
  } else if (safeKey(requestId, CLAUDE_KEY)) {
    key = requestId;
    keySource = "claudeRequestId";
  } else return { kind: "unrecognized", reason: "no-key" };

  const ts = stringAt(buf, res, P_TIMESTAMP, MAX_TIMESTAMP_BYTES);
  const timestampMs = ts !== undefined && TIMESTAMP.test(ts) ? Date.parse(ts) : NaN;
  if (!Number.isFinite(timestampMs)) return { kind: "unrecognized", reason: "bad-timestamp" };

  // D47: input includes cached tokens; input_tokens alone is the uncached part.
  const tokens: Tokens = {};
  const inputParts = [input, cacheRead, cacheWrite].filter((v): v is number => v !== undefined);
  const inputSum = inputParts.reduce((a, b) => a + b, 0);
  if (inputParts.length > 0 && Number.isSafeInteger(inputSum)) tokens.input = inputSum;
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
  if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite;
  if (output !== undefined) tokens.output = output;
  const details = usage.output_tokens_details;
  const reasoning = isObject(details) ? count(details.thinking_tokens) : undefined;
  if (reasoning !== undefined) tokens.reasoning = reasoning;

  const sid = stringAt(buf, res, P_SESSION_ID, MAX_SESSION_BYTES);
  const sessionId = isSessionId(sid) ? sid : o.fileSessionId;
  const record: UsageRecord = {
    key,
    keySource,
    source: "claude-code",
    kind: "call",
    sessionId,
    folderId: sessionId,
    timestampMs,
    tokens,
  };
  const model = stringAt(buf, res, P_MODEL, MAX_MODEL_BYTES);
  if (safeKey(model, MODEL_ID)) record.model = model;
  const finishReason = finishReasonOf(buf, only(res, P_STOP));
  if (finishReason !== undefined) record.finishReason = finishReason;
  const tools = toolsOf(buf, res);
  if (tools !== undefined) record.tools = tools;

  if (o.wantLabel) {
    // The path is reduced to its folder name here and never leaves this function.
    const cwd = stringAt(buf, res, P_CWD);
    const label = cwd === undefined ? undefined : folderLabel(cwd);
    if (label !== undefined) return { kind: "usage", record, label };
  }
  return { kind: "usage", record };
}

// ---------------------------------------------------------------------------
// Discovery

/** Folders under a slug or a session folder that are never listed (D53 never-read list). */
const SKIP_DIRS = new Set(["memory", "tool-results"]);
const JSONL = ".jsonl";

function codeOf(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

async function listDir(dir: string): Promise<fs.Dirent[] | undefined> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return undefined;
  }
}

class Walk {
  readonly sessions = new Map<string, SourceFile[]>();
  readonly unreadable: SourceUnreadable[] = [];
  capped = 0;
  private seen = 0;

  constructor(private readonly windowStartMs: number) {}

  /** lstat's the *.jsonl regular files among `entries` (symlinks are not files here) for session `sid`. */
  async files(dir: string, entries: fs.Dirent[], sid: (name: string) => string | undefined): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(JSONL)) continue;
      const id = sid(e.name);
      if (id === undefined) continue;
      if (this.seen >= CLAUDE_MAX_FILES) {
        this.capped++;
        continue;
      }
      this.seen++;
      pending.push(this.file(join(dir, e.name), id));
    }
    await Promise.all(pending);
  }

  private async file(path: string, sid: string): Promise<void> {
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(path);
    } catch (err) {
      const code = codeOf(err);
      if (code !== "ENOENT" && code !== "ENOTDIR") this.unreadable.push({ folderId: sid, path, code: code ?? "OTHER" });
      return;
    }
    if (!st.isFile() || st.mtimeMs < this.windowStartMs) return;
    const list = this.sessions.get(sid);
    const f: SourceFile = { path, mtimeMs: st.mtimeMs, size: st.size };
    if (list) list.push(f);
    else this.sessions.set(sid, [f]);
  }

  /** A session folder at `depth` below projects/: its *.jsonl files join `sid`; subfolders are descended while files stay within CLAUDE_MAX_DEPTH. */
  async sessionDir(dir: string, sid: string, depth: number): Promise<void> {
    const entries = await listDir(dir);
    if (entries === undefined) return;
    await this.files(dir, entries, () => sid);
    if (depth + 1 >= CLAUDE_MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await this.sessionDir(join(dir, e.name), sid, depth + 1);
    }
  }
}

/** Lists Claude Code sessions under <root>/projects/ with a file modified at or after `windowStartMs` (D42, D43). */
export async function discoverClaude(
  root: string,
  windowStartMs: number,
  dayStartMs: number,
  nowMs: number,
): Promise<SourceDiscoverResult> {
  const base = join(root, "projects");
  let slugs: fs.Dirent[];
  let dirMtimeMs: number;
  try {
    // stat before listing, so a folder created in between bumps the mtime past this value.
    dirMtimeMs = (await fs.promises.stat(base)).mtimeMs;
    slugs = await fs.promises.readdir(base, { withFileTypes: true });
  } catch (err) {
    const code = codeOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, error: "no-dir" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, error: "permission" };
    return { ok: false, error: "OTHER" };
  }
  slugs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const walk = new Walk(windowStartMs);
  // The slug names a path; it is joined to reach the files and never kept.
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(base, slug.name);
    const entries = await listDir(slugDir);
    if (entries === undefined) continue;
    await walk.files(slugDir, entries, (name) => {
      const stem = name.slice(0, -JSONL.length);
      return isSessionId(stem) ? stem : undefined;
    });
    for (const e of entries) {
      if (e.isDirectory() && isSessionId(e.name)) await walk.sessionDir(join(slugDir, e.name), e.name, 2);
    }
  }

  const liveSinceMs = Math.max(dayStartMs, nowMs - RECENT_MS);
  const candidates: SourceCandidate[] = [];
  for (const [sessionId, files] of walk.sessions) {
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    candidates.push({
      source: "claude-code",
      sessionId,
      folderId: sessionId,
      files,
      mtimeMs: Math.max(...files.map((f) => f.mtimeMs)),
      live: files.some((f) => f.mtimeMs >= liveSinceMs),
    });
  }
  candidates.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return { ok: true, candidates, unreadable: walk.unreadable, dirMtimeMs, capped: walk.capped };
}

// ---------------------------------------------------------------------------
// Reading

class ClaudeFileReader implements FileReader, LineHandler {
  private out: FileReadResult = emptyReadResult();
  private label: string | undefined;
  private readonly tailer: ByteTailer;

  constructor(
    path: string,
    private readonly fileSessionId: string,
    private readonly readProjects: boolean,
  ) {
    this.tailer = new ByteTailer(path, this, { maxLineBytes: CLAUDE_MAX_LINE_BYTES, headBytes: CLAUDE_HEAD_BYTES });
  }

  async read(): Promise<FileReadResult> {
    const out = emptyReadResult();
    this.out = out;
    const { reset, error } = await this.tailer.read();
    out.reset = reset;
    if (error !== undefined) out.error = error;
    if (this.label !== undefined) out.label = this.label;
    return out;
  }

  // Never throws: a throw mid-chunk would make the tailer re-deliver lines.
  line(buf: Buffer, start: number, end: number): void {
    try {
      this.onLine(buf, start, end);
    } catch {
      this.out.malformed++;
    }
  }

  overlong(buf: Buffer, start: number, end: number): void {
    try {
      if (classifyClaudeHead(buf, start, end) === "assistant") this.out.overlong++;
      else this.out.overlongOther++;
    } catch {
      this.out.malformed++;
    }
  }

  private onLine(buf: Buffer, start: number, end: number): void {
    const out = this.out;
    const c = classifyClaudeLine(buf, start, end);
    if (c === "user") {
      out.activity++;
      return;
    }
    if (c !== "assistant") return;
    // The label is pinned from the first usage record (D44); cwd is not matched after that.
    const wantLabel = this.readProjects && this.label === undefined;
    const p = parseClaudeLine(buf, start, end, { fileSessionId: this.fileSessionId, wantLabel });
    switch (p.kind) {
      case "usage":
        out.records.push(p.record);
        out.usage++;
        if (wantLabel && p.label !== undefined) this.label = p.label;
        break;
      case "ignored":
        // A user line whose tool result quotes an assistant line is still activity.
        if (hasUserHead(buf, start, end)) out.activity++;
        break;
      case "unrecognized":
        out.unrecognized++;
        break;
      case "malformed":
        out.malformed++;
        break;
    }
  }
}

export class ClaudeSourceReader implements SourceReader {
  readonly source = "claude-code" as const;
  readonly root: string;
  readonly rootSource: "setting" | "env" | "default";
  private readonly readProjects: boolean;
  private readonly projects: string;

  constructor(o: { root: string; rootSource: "setting" | "env" | "default"; readProjects: boolean }) {
    this.root = o.root;
    this.rootSource = o.rootSource;
    this.readProjects = o.readProjects;
    this.projects = join(o.root, "projects");
  }

  async rootDirMtime(): Promise<number | undefined> {
    try {
      return (await fs.promises.stat(this.projects)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  discover(windowStartMs: number, dayStartMs: number, nowMs: number): Promise<SourceDiscoverResult> {
    return discoverClaude(this.root, windowStartMs, dayStartMs, nowMs);
  }

  /** A pure path check: a *.jsonl below projects/<slug>/, within CLAUDE_MAX_DEPTH, outside never-read folders. Regular-file-ness is checked when the tailer opens it. */
  pathAllowed(path: string): boolean {
    if (!isAbsolute(path) || !isAbsolute(this.projects)) return false;
    const rel = relative(this.projects, path);
    if (rel === "" || isAbsolute(rel)) return false;
    const parts = rel.split(sep);
    if (parts.length < 2 || parts.length > CLAUDE_MAX_DEPTH) return false;
    const name = parts[parts.length - 1]!;
    if (!name.endsWith(JSONL) || name.length === JSONL.length) return false;
    return parts.every((p) => p !== "" && p !== "." && p !== ".." && !SKIP_DIRS.has(p));
  }

  open(path: string, c: SourceCandidate): FileReader {
    return new ClaudeFileReader(path, c.sessionId, this.readProjects);
  }
}
