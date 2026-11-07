// The privacy gate. classifyLine looks at raw bytes only and never decodes a
// line; parseUsageLine runs only on lines the gate called "usage" and copies
// an allowlist of fields into a fresh object. parseStartLine runs only on the
// small "start" line and keeps one short project label, never a path (D25).
// parseShutdownLine runs only on bounded "shutdown" lines and keeps per-model
// totals; content-bearing keys are dropped while parsing (D29).
// Nothing else leaves this module.
import type { FinishReason, Initiator, ParseResult, ShutdownParseResult, Tokens, TypeCost, UsageRecord } from "./types";

export type LineClass = "usage" | "start" | "shutdown" | "activity" | "suspect" | "skip";

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
const SHUTDOWN_TYPE = "session.shutdown";
const SHUTDOWN_PREFIX = typePrefix(SHUTDOWN_TYPE);
/** Observed max 4 KB; the cap bounds memory and the transient exposure of the paths these lines carry. */
export const MAX_SHUTDOWN_BYTES = 64 * 1024;
// A real usage event whose keys were reordered or re-spaced. Inside a JSON string
// value these quotes are escaped as \", so prompt or tool text can never match.
const SUSPECT_NEEDLES = [
  Buffer.from(`${TYPE_KEY}${USAGE_TYPE}"`),
  Buffer.from(`"type": "${USAGE_TYPE}"`),
];
const SHUTDOWN_NEEDLES = [
  Buffer.from(`${TYPE_KEY}${SHUTDOWN_TYPE}"`),
  Buffer.from(`"type": "${SHUTDOWN_TYPE}"`),
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
  // No size check here: the tailer counts an oversize shutdown line instead of decoding it.
  if (startsWith(buf, start, end, SHUTDOWN_PREFIX)) return "shutdown";
  return hasUsageNeedle(buf, start, end) || hasShutdownNeedle(buf, start, end) ? "suspect" : "skip";
}

/** True if buf[start, end) opens with `{"type":"session.shutdown"`. No decoding. */
export function isShutdownHead(buf: Buffer, start: number, end: number): boolean {
  return startsWith(buf, start, end, SHUTDOWN_PREFIX);
}

/** Like hasUsageNeedle, for the shutdown type. Raw byte search, no decoding. */
export function hasShutdownNeedle(buf: Buffer, start: number, end: number): boolean {
  const line = buf.subarray(start, end);
  return SHUTDOWN_NEEDLES.some((needle) => line.indexOf(needle) !== -1);
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
/** Keys that resolve through the prototype chain; never used as a map key (D28). */
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** A log-supplied id that matches `re` and is not a prototype key (D28). */
function safeKey(v: unknown, re: RegExp): v is string {
  return typeof v === "string" && re.test(v) && !PROTO_KEYS.has(v);
}
/** Session ids: the same shape discover accepts for a session folder name. */
const SESSION_ID = /^[0-9a-f-]{8,64}$/i;

/** A session id as a panel link may carry it (v0.6 showSession): the shape above, never a prototype key. */
export function isSessionId(v: unknown): v is string {
  return safeKey(v, SESSION_ID);
}
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

/** Keys of a shutdown line that hold paths, names or allowance data; dropped while parsing. */
const SHUTDOWN_DROP = new Set([
  "filesModified",
  "accountingSnapshot",
  "agentMetrics",
  "providerModelMetrics",
  "usageAccountingWatermarks",
  "currentModel",
]);
const MAX_MODELS = 64;

/**
 * Per-model totals of a session.shutdown line (D29). The line (at most
 * MAX_SHUTDOWN_BYTES) is decoded whole; JSON.parse's reviver then removes the
 * SHUTDOWN_DROP keys while it walks the parsed tree, so they are never copied,
 * returned or logged. Per model, only the five usage token counts,
 * requests.count and totalNanoAiu are copied into fresh objects, plus the
 * line's timestamp and data.sessionStartTime. A model whose tokens are all
 * zero and that logged no requests is dropped (it logged nothing). Never read:
 * requests.cost, totalPremiumRequests, totalApiDurationMs, codeChanges, and
 * everything else on the line.
 */
export function parseShutdownLine(line: string, folderId: string): ShutdownParseResult {
  let event: unknown;
  try {
    event = JSON.parse(line, (k, v) => (SHUTDOWN_DROP.has(k) ? undefined : v));
  } catch {
    return { kind: "malformed" };
  }
  if (!isObject(event)) return { kind: "malformed" };
  if (event.type !== SHUTDOWN_TYPE) return { kind: "ignored" };
  const data = event.data;
  const metrics = isObject(data) ? data.modelMetrics : undefined;
  if (!isObject(data) || !isObject(metrics)) return { kind: "unrecognized", reason: "no-model-metrics" };
  const timestampMs = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  if (!Number.isFinite(timestampMs)) return { kind: "unrecognized", reason: "bad-timestamp" };
  const entries = Object.entries(metrics);
  if (entries.length === 0) return { kind: "empty" };

  const started = count(data.sessionStartTime);
  const out: UsageRecord[] = [];
  let idle = 0;
  for (const [i, [name, m]] of entries.entries()) {
    if (out.length >= MAX_MODELS) break;
    const usage = isObject(m) ? m.usage : undefined;
    if (!isObject(m) || !isObject(usage)) continue;
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
    if (Object.keys(tokens).length === 0) continue;
    const requests = isObject(m.requests) ? count(m.requests.count) : undefined;
    // All-zero tokens and no requests: an entry that logged nothing, not a $0.00 row (N2).
    if ((requests ?? 0) === 0 && Object.values(tokens).every((t) => t === 0)) {
      idle++;
      continue;
    }
    const model = safeKey(name, MODEL_ID) ? name : undefined;
    const record: UsageRecord = {
      // A rejected id never reaches the key; `#i` cannot collide with a valid model id.
      key: `shutdown:${folderId}:${model ?? `#${i}`}`,
      keySource: "shutdown",
      kind: "sessionTotal",
      sessionId: folderId,
      folderId,
      timestampMs,
      tokens,
    };
    if (started !== undefined && started <= timestampMs) record.startedMs = started;
    if (model !== undefined) record.model = model;
    if (requests !== undefined) record.calls = requests;
    let nanoAiu = count(m.totalNanoAiu);
    // Builds before 1.0.99 wrote 0 here next to real token counts: not reported, not $0.
    if (nanoAiu === 0 && Object.values(tokens).some((t) => t > 0)) nanoAiu = undefined;
    if (nanoAiu !== undefined) record.nanoAiu = nanoAiu;
    out.push(record);
  }
  if (out.length === 0) return idle > 0 ? { kind: "empty" } : { kind: "unrecognized", reason: "no-known-token-field" };
  return { kind: "totals", records: out };
}

/** Known initiator values; anything else (any other string, or a non-string) is "other". */
const INITIATOR_VALUES: ReadonlyMap<string, Initiator> = new Map([["user", "user"], ["agent", "agent"]]);
/** Known finish reasons; anything else is "other". */
const FINISH_VALUES: ReadonlyMap<string, FinishReason> = new Map([
  ["stop", "stop"],
  ["tool_calls", "tool_calls"],
  ["length", "length"],
  ["content_filter", "content_filter"],
]);
/** tokenDetails[].tokenType → TypeCost bucket; anything else is "other". */
const TOKEN_TYPES: ReadonlyMap<string, "input" | "cacheRead" | "cacheWrite" | "output"> = new Map([
  ["input", "input"],
  ["cache_read", "cacheRead"],
  ["cache_write", "cacheWrite"],
  ["output", "output"],
]);
/** Observed: 4 entries per call. More than this is not a shape we know: no split. */
export const MAX_TOKEN_DETAILS = 16;

/** A small enum read from the log: only the mapped constant is returned, never the log's string. */
function enumValue<T>(v: unknown, known: ReadonlyMap<string, T>, other: T): T | undefined {
  // JSON null is "not logged", like an absent field (review fix 6).
  if (v === undefined || v === null) return undefined;
  return (typeof v === "string" && known.get(v)) || other;
}

/**
 * The per-type split of `totalNanoAiu` from copilotUsage.tokenDetails[] (v0.6). Every
 * entry needs integer tokenCount ≥ 0, batchSize > 0 and costPerBatch ≥ 0, else there is
 * no split; tokenType is mapped to a fixed bucket and never kept; the entry's model
 * string is not read. The split is kept only when it adds up to `total` (within one
 * nanoAIU per entry for rounding), so a shown part is exact.
 */
function typeCostOf(details: unknown, total: number | undefined): TypeCost | undefined {
  if (total === undefined || !Array.isArray(details) || details.length === 0 || details.length > MAX_TOKEN_DETAILS) return undefined;
  const cost: TypeCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let other = 0;
  let inputTokens = 0;
  let readRate: number | undefined;
  let rates = 0;
  for (const d of details) {
    if (!isObject(d)) return undefined;
    const tokens = count(d.tokenCount);
    const batch = count(d.batchSize);
    const per = count(d.costPerBatch);
    if (tokens === undefined || batch === undefined || batch === 0 || per === undefined) return undefined;
    const nano = (tokens / batch) * per;
    const kind = typeof d.tokenType === "string" ? TOKEN_TYPES.get(d.tokenType) : undefined;
    if (kind === undefined) {
      other += nano;
      continue;
    }
    cost[kind] += nano;
    if (kind === "input") inputTokens += tokens;
    if (kind === "cacheRead") {
      const rate = per / batch;
      if (readRate === undefined || rate !== readRate) rates++;
      readRate = rate;
    }
  }
  const sum = cost.input + cost.cacheRead + cost.cacheWrite + cost.output + other;
  if (Math.abs(sum - total) > Math.max(1, details.length)) return undefined;
  if (other > 0) cost.other = other;
  if (rates === 1 && readRate !== undefined) cost.inputAtReadRate = inputTokens * readRate;
  return cost;
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
    kind: "call",
    // An id not shaped like a session folder name is not trusted: the folder stands in.
    sessionId: safeKey(accounting.sourceSessionId, SESSION_ID) ? accounting.sourceSessionId : folderId,
    folderId,
    timestampMs,
    tokens,
  };
  const sequence = count(accounting.sequence);
  if (sequence !== undefined) record.sequence = sequence;
  if (safeKey(usage.model, MODEL_ID)) record.model = usage.model;
  const durationMs = count(usage.duration);
  if (durationMs !== undefined) record.durationMs = durationMs;
  const nanoAiu = isObject(usage.copilotUsage)
    ? count(usage.copilotUsage.totalNanoAiu)
    : undefined;
  if (nanoAiu !== undefined) record.nanoAiu = nanoAiu;
  // v0.6: two small enums mapped to constants, two counts, and the per-type split of AIU.
  const initiator = enumValue(usage.initiator, INITIATOR_VALUES, "other");
  if (initiator !== undefined) record.initiator = initiator;
  const finishReason = enumValue(usage.finishReason, FINISH_VALUES, "other");
  if (finishReason !== undefined) record.finishReason = finishReason;
  const toolTokens = count(usage.toolTokenCount);
  if (toolTokens !== undefined) record.toolTokens = toolTokens;
  const availableTools = count(usage.availableToolCount);
  if (availableTools !== undefined) record.availableTools = availableTools;
  const typeCost = isObject(usage.copilotUsage) ? typeCostOf(usage.copilotUsage.tokenDetails, nanoAiu) : undefined;
  if (typeCost !== undefined) record.typeCost = typeCost;
  if (isObject(usage.toolCounts)) {
    const tools: Record<string, number> = Object.create(null);
    let n = 0;
    for (const [name, v] of Object.entries(usage.toolCounts)) {
      const c = count(v);
      if (c === undefined || c === 0 || !safeKey(name, TOOL_NAME)) continue;
      if (++n > MAX_TOOLS) break;
      tools[name] = c;
    }
    if (n > 0) record.tools = tools;
  }

  return { kind: "usage", record };
}
