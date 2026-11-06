// The privacy gate. classifyLine looks at raw bytes only and never decodes a
// line; parseUsageLine runs only on lines the gate called "usage" and copies
// an allowlist of fields into a fresh object. Nothing else leaves this module.
import type { ParseResult, Tokens, UsageRecord } from "./types";

export type LineClass = "usage" | "activity" | "suspect" | "skip";

const USAGE_TYPE = "session.usage_record";
const USAGE_PREFIX = Buffer.from(`{"type":"${USAGE_TYPE}"`);
const ACTIVITY_PREFIX = Buffer.from(`{"type":"assistant.turn_end"`);
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
  // subarray is a view (no copy, no decode) so the search stops at `end`.
  const line = buf.subarray(start, end);
  for (const needle of SUSPECT_NEEDLES) {
    if (line.indexOf(needle) !== -1) return "suspect";
  }
  return "skip";
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

  return { kind: "usage", record };
}
