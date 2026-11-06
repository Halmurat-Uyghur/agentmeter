// The privacy gate. classifyLine looks at raw bytes only and never decodes a
// line; parseUsageLine runs only on lines the gate called "usage" and copies
// an allowlist of fields into a fresh object. parseStartLine runs only on the
// small "start" line and keeps one short project label, never a path (D25).
// Nothing else leaves this module.
import type { ParseResult, Tokens, UsageRecord } from "./types";

export type LineClass = "usage" | "start" | "activity" | "suspect" | "skip";

const USAGE_TYPE = "session.usage_record";
const USAGE_PREFIX = Buffer.from(`{"type":"${USAGE_TYPE}"`);
const ACTIVITY_PREFIX = Buffer.from(`{"type":"assistant.turn_end"`);
const START_TYPE = "session.start";
const START_PREFIX = Buffer.from(`{"type":"${START_TYPE}"`);
/** session.start lines are < 1 KB in practice; anything larger is not decoded. */
export const MAX_START_BYTES = 16 * 1024;
// A real usage event whose keys were reordered or re-spaced. Inside a JSON string
// value these quotes are escaped as \", so prompt or tool text can never match.
const SUSPECT_NEEDLES = [
  Buffer.from(`"type":"${USAGE_TYPE}"`),
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
  // subarray is a view (no copy, no decode) so the search stops at `end`.
  const line = buf.subarray(start, end);
  for (const needle of SUSPECT_NEEDLES) {
    if (line.indexOf(needle) !== -1) return "suspect";
  }
  return "skip";
}

const TYPE_PREFIX = Buffer.from(`{"type":"`);
const USAGE_TYPE_BYTES = Buffer.from(USAGE_TYPE);
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
