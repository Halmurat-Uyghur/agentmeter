// The privacy gate. classifyLine looks at raw bytes only and never decodes a
// line; parseUsageLine runs only on lines the gate called "usage" and copies
// an allowlist of fields into a fresh object. parseStartLine runs only on the
// small "start" line and keeps one short project label, never a path (D25).
// Nothing else leaves this module.
import type { ParseResult, Tokens, UsageRecord } from "./types";

export type LineClass = "usage" | "start" | "activity" | "suspect" | "skip";

// One definition of "what a usage line looks like"; every byte pattern below
// (prefix, needles, the over-long type check) is derived from these.
const USAGE_TYPE = "session.usage_record";
const TYPE_KEY = `"type":"`;
const TYPE_PREFIX = Buffer.from(`{${TYPE_KEY}`);
const typePrefix = (name: string): Buffer => Buffer.from(`{${TYPE_KEY}${name}"`);
const USAGE_TYPE_BYTES = Buffer.from(USAGE_TYPE);
const USAGE_PREFIX = typePrefix(USAGE_TYPE);
const ACTIVITY_PREFIX = typePrefix("assistant.turn_end");
const START_TYPE = "session.start";
const START_PREFIX = typePrefix(START_TYPE);
/** session.start lines are < 1 KB in practice; anything larger is not decoded. */
export const MAX_START_BYTES = 16 * 1024;
// A real usage event whose keys were reordered or re-spaced. Inside a JSON string
// value these quotes are escaped as \", so prompt or tool text can never match.
const SUSPECT_NEEDLES = [
  Buffer.from(`${TYPE_KEY}${USAGE_TYPE}"`),
  Buffer.from(`"type": "${USAGE_TYPE}"`),
];

function startsWith(
  buf: Buffer,
  start: number,
  end: number,
  prefix: Buffer,
): boolean {
  if (end - start < prefix.length) return false;
  return (
    buf.compare(prefix, 0, prefix.length, start, start + prefix.length) === 0
  );
}

/** Classifies the line buf[start, end) by its bytes. No decoding. */
export function classifyLine(
  buf: Buffer,
  start: number,
  end: number,
): LineClass {
  if (startsWith(buf, start, end, USAGE_PREFIX)) return "usage";
  if (startsWith(buf, start, end, ACTIVITY_PREFIX)) return "activity";
  if (startsWith(buf, start, end, START_PREFIX)) return end - start <= MAX_START_BYTES ? "start" : "skip";
  return hasUsageNeedle(buf, start, end) ? "suspect" : "skip";
}

/**
 * True if the usage type appears as a `"type"` value anywhere in buf[start, end)
 * (keys reordered, re-spaced, or nested). Raw byte search, no decoding.
 */
export function hasUsageNeedle(buf: Buffer, start: number, end: number): boolean {
  // subarray is a view (no copy, no decode) so the search stops at `end`.
  const line = buf.subarray(start, end);
  return SUSPECT_NEEDLES.some((needle) => line.indexOf(needle) !== -1);
}

/** How far past `{"type":"` to look for the closing quote of the type name. */
const MAX_TYPE_NAME_BYTES = 128;
/** Bytes of a line's start that isKnownNonUsage needs to see. */
export const TYPE_HEAD_BYTES = TYPE_PREFIX.length + MAX_TYPE_NAME_BYTES + 1;

/**
 * True only when the line provably is not a usage record: it opens with
 * `{"type":"<name>"`, the name has no escapes, and it is not the usage type.
 * Used for lines too long to read, so it looks at the first bytes only.
 * Anything it can't be sure of (keys reordered or re-spaced, an escaped or
 * very long name) is false, so a skipped line that might be usage still counts.
 */
export function isKnownNonUsage(buf: Buffer, start: number, end: number): boolean {
  if (!startsWith(buf, start, end, TYPE_PREFIX)) return false;
  const from = start + TYPE_PREFIX.length;
  const stop = Math.min(end, from + MAX_TYPE_NAME_BYTES + 1);
  for (let i = from; i < stop; i++) {
    const b = buf[i];
    if (b === 0x5c) return false; // backslash: an escape we won't interpret
    if (b === 0x22) {
      if (i === from) return false;
      return buf.compare(USAGE_TYPE_BYTES, 0, USAGE_TYPE_BYTES.length, from, i) !== 0;
    }
  }
  return false;
}

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const MODEL_ID = /^[A-Za-z0-9._:\/-]{1,100}$/;
/** Tool names: identifiers only (MCP tools look like server-tool or server/tool). */
const TOOL_NAME = /^[A-Za-z0-9._:\/@-]{1,80}$/;
const MAX_TOOLS = 64;
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const FOLDER_NAME = /^[A-Za-z0-9 ._@+-]{1,80}$/;

/** Last segment of a POSIX or Windows path, or undefined. */
function baseName(p: string): string | undefined {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1);
}

/**
 * The project label of a session.start line: `context.repository` ("owner/repo")
 * if well-formed, else the last folder name of `context.gitRoot` or `context.cwd`.
 * Only that label is returned; the full path and every other field are dropped.
 */
export function parseStartLine(line: string): string | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(event) || event.type !== START_TYPE) return undefined;
  const data = event.data;
  const ctx = isObject(data) && isObject(data.context) ? data.context : undefined;
  if (!ctx) return undefined;
  if (typeof ctx.repository === "string" && REPO.test(ctx.repository)) return ctx.repository;
  for (const key of ["gitRoot", "cwd"]) {
    const v = ctx[key];
    if (typeof v !== "string") continue;
    const name = baseName(v);
    if (name !== undefined && FOLDER_NAME.test(name) && name !== "." && name !== "..") return name;
  }
  return undefined;
}

/**
 * A folder name that is an ID (UUID or long hex), which means nothing to a person.
 * Hex needs both a digit and a letter a-f: all digits is more likely a build or
 * ticket number, and all letters a word.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^(?=.*[0-9])(?=.*[a-f])[0-9a-f]+(?:-[0-9a-f]+)*$/i;
export function isIdLabel(label: string): boolean {
  return label.length >= 16 && label.length <= 64 && (UUID.test(label) || HEX_ID.test(label));
}

/** workspace.yaml files are ~200 bytes; anything larger is not read. */
export const MAX_WORKSPACE_BYTES = 16 * 1024;
export const MAX_TITLE_CHARS = 60;

/**
 * The session title from workspace.yaml: the top-level `name:` value only, on one
 * line, without control or format characters (bidi overrides, zero-width), at most
 * MAX_TITLE_CHARS code points long. A trailing ` # comment` is dropped; YAML null
 * and empty values are no title. Every other key (cwd, git_root, branch, ...) is ignored.
 */
export function parseWorkspaceName(text: string): string | undefined {
  const m = /^name:[ \t]*(.*)$/m.exec(text);
  if (!m) return undefined;
  const raw = m[1]!.trim();
  let v: string;
  if (raw.startsWith("'") || raw.startsWith('"')) {
    const q =
      /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(raw)?.[1]?.replace(/''/g, "'") ??
      /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/.exec(raw)?.[1]?.replace(/\\(["\\])/g, "$1");
    if (q === undefined) return undefined; // unbalanced or trailing junk: not a title
    v = q;
  } else {
    if (/^[|>]/.test(raw)) return undefined; // a block scalar: not a title
    v = raw.replace(/(?:^|\s)#.*$/, "").trim();
    if (/^(?:~|null|Null|NULL)$/.test(v)) return undefined;
  }
  v = v
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (v.length === 0) return undefined;
  const cps = Array.from(v);
  return cps.length > MAX_TITLE_CHARS ? `${cps.slice(0, MAX_TITLE_CHARS - 1).join("").trimEnd()}…` : v;
}

export function parseUsageLine(line: string, folderId: string): ParseResult {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    // The error message quotes input; it is discarded on purpose.
    return { kind: "malformed" };
  }
  if (!isObject(event)) return { kind: "malformed" };
  if (event.type !== USAGE_TYPE) return { kind: "ignored" };

  const data = event.data;
  const usage = isObject(data) ? data.usage : undefined;
  if (!isObject(usage))
    return { kind: "unrecognized", reason: "no-usage-object" };

  const accounting = isObject(usage.accounting) ? usage.accounting : {};
  const usageId = nonEmptyString(accounting.usageId);
  const eventId = nonEmptyString(event.id);
  const key = usageId ?? eventId;
  if (key === undefined) return { kind: "unrecognized", reason: "no-key" };

  const timestampMs =
    typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  if (!Number.isFinite(timestampMs))
    return { kind: "unrecognized", reason: "bad-timestamp" };

  const tokens: Tokens = {};
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  const cacheRead = count(usage.cacheReadTokens);
  const cacheWrite = count(usage.cacheWriteTokens);
  const reasoning = count(usage.reasoningTokens);
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
  if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite;
  if (reasoning !== undefined) tokens.reasoning = reasoning;
  if (Object.keys(tokens).length === 0)
    return { kind: "unrecognized", reason: "no-known-token-field" };

  const record: UsageRecord = {
    key,
    keySource: usageId !== undefined ? "usageId" : "eventId",
    sessionId: nonEmptyString(accounting.sourceSessionId) ?? folderId,
    folderId,
    timestampMs,
    tokens,
  };
  const sequence = count(accounting.sequence);
  if (sequence !== undefined) record.sequence = sequence;
  if (typeof usage.model === "string" && MODEL_ID.test(usage.model))
    record.model = usage.model;
  const durationMs = count(usage.duration);
  if (durationMs !== undefined) record.durationMs = durationMs;
  const nanoAiu = isObject(usage.copilotUsage)
    ? count(usage.copilotUsage.totalNanoAiu)
    : undefined;
  if (nanoAiu !== undefined) record.nanoAiu = nanoAiu;
  if (isObject(usage.toolCounts)) {
    const tools: Record<string, number> = {};
    let n = 0;
    for (const [name, v] of Object.entries(usage.toolCounts)) {
      const c = count(v);
      if (c === undefined || c === 0 || !TOOL_NAME.test(name)) continue;
      if (++n > MAX_TOOLS) break;
      tools[name] = c;
    }
    if (n > 0) record.tools = tools;
  }

  return { kind: "usage", record };
}
