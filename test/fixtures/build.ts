// Synthetic log fixtures. Nothing here comes from real Copilot logs: every
// content-bearing string is CANARY so tests can prove it never leaks.
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CANARY = "SYNTHETIC-CANARY-7f3a";

export interface UsageFixture {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  duration: number;
  totalNanoAiu: number;
  usageId: string;
  sequence: number;
  sourceSessionId: string;
  id: string;
  timestamp: string;
  /** v0.6 fields; absent unless set */
  initiator?: unknown;
  finishReason?: unknown;
  toolTokenCount?: unknown;
  availableToolCount?: unknown;
  tokenDetails?: unknown;
}

/** tokenDetails[] entries for `usageEvent`, shaped as Copilot logs them; `model` is CANARY
 * (that string must never be kept). Cost per entry = tokenCount / batchSize × costPerBatch. */
export function tokenDetails(parts: { tokenType: string; tokenCount: number; batchSize?: number; costPerBatch: number }[]): object[] {
  return parts.map((p) => ({ batchSize: 1, ...p, model: CANARY }));
}

type Plain = Record<string, unknown>;

/** Drops keys whose value is undefined, and nested objects left empty by that. */
function compact(obj: Plain): Plain {
  const out: Plain = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const inner = compact(value as Plain);
      if (Object.keys(inner).length === 0 && Object.keys(value as Plain).length > 0) continue;
      out[key] = inner;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A `session.usage_record` event; `type` is always the first key. */
export function usageEvent(o: Partial<UsageFixture> = {}): object {
  const f: UsageFixture = {
    model: "model-a",
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 50,
    reasoningTokens: 30,
    duration: 1500,
    totalNanoAiu: 2_000_000_000,
    usageId: "u-1",
    sequence: 1,
    sourceSessionId: "0000aaaa-0000-4000-8000-000000000001",
    id: "e-1",
    timestamp: new Date().toISOString(),
  };
  // Spread keeps explicit `undefined` overrides, which compact() then removes.
  const v = { ...f, ...o };
  return compact({
    type: "session.usage_record",
    id: v.id,
    parentId: null,
    timestamp: v.timestamp,
    data: {
      usage: {
        model: v.model,
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
        cacheReadTokens: v.cacheReadTokens,
        cacheWriteTokens: v.cacheWriteTokens,
        reasoningTokens: v.reasoningTokens,
        duration: v.duration,
        copilotUsage: { totalNanoAiu: v.totalNanoAiu, tokenDetails: v.tokenDetails },
        accounting: { usageId: v.usageId, sequence: v.sequence, sourceSessionId: v.sourceSessionId },
        initiator: v.initiator,
        finishReason: v.finishReason,
        toolTokenCount: v.toolTokenCount,
        availableToolCount: v.availableToolCount,
      },
    },
  });
}

/**
 * Any other event type. Every content-bearing string is CANARY; the timestamp
 * stays a valid ISO string. `o` is shallow-merged over the envelope after `type`.
 */
export function otherEvent(type: string, o: object = {}): object {
  return compact({
    type,
    id: CANARY,
    parentId: CANARY,
    timestamp: new Date().toISOString(),
    data: {
      content: CANARY,
      message: CANARY,
      context: { cwd: CANARY, repository: CANARY, branch: CANARY },
    },
    ...o,
  });
}

/** Newline-terminated JSON lines (LF only), as Copilot writes them. */
export function jsonl(events: object[]): string {
  return events.map((e) => JSON.stringify(e) + "\n").join("");
}

/** Creates `<root>/session-state/<id>/events.jsonl` (+ optional lock file and mtime). */
export async function sessionTree(
  root: string,
  sessions: { id: string; lines: string; lockPid?: number; mtime?: Date }[],
): Promise<void> {
  for (const s of sessions) {
    const dir = join(root, "session-state", s.id);
    await mkdir(dir, { recursive: true });
    const events = join(dir, "events.jsonl");
    await writeFile(events, s.lines);
    if (s.lockPid !== undefined) await writeFile(join(dir, `inuse.${s.lockPid}.lock`), "");
    if (s.mtime !== undefined) await utimes(events, s.mtime, s.mtime);
  }
}

/** One model's totals in a `session.shutdown` line (`requests` is requests.count). */
export interface ShutdownModel {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requests: number;
  totalNanoAiu: number;
}

export interface ShutdownFixture {
  /** model id → totals; `null` omits modelMetrics, `{}` writes an empty one */
  models: Record<string, Partial<ShutdownModel>> | null;
  totalNanoAiu: number;
  totalApiDurationMs: number;
  /** epoch ms; default one hour before `timestamp` */
  sessionStartTime: number;
  id: string;
  timestamp: string;
}

/** The usage fixture's numbers × 6, with requests.count 6. */
export const SHUTDOWN_DEFAULTS: ShutdownModel = {
  inputTokens: 6000,
  outputTokens: 1200,
  cacheReadTokens: 3000,
  cacheWriteTokens: 300,
  reasoningTokens: 180,
  requests: 6,
  totalNanoAiu: 12_000_000_000,
};

/**
 * A `session.shutdown` event; `type` is always the first key. Every field the
 * extension must never keep is present and CANARY-filled: paths in
 * filesModified, aiCreditsStatus, currentModel, agentMetrics, watermarks.
 */
export function shutdownEvent(o: Partial<ShutdownFixture> = {}): object {
  const timestamp = o.timestamp ?? new Date().toISOString();
  const models = o.models === undefined ? { "model-a": {} } : o.models;
  const modelMetrics =
    models === null
      ? undefined
      : Object.fromEntries(
          Object.entries(models).map(([name, m]) => {
            const v = { ...SHUTDOWN_DEFAULTS, ...m };
            return [
              name,
              {
                requests: { count: v.requests, cost: 0.25 },
                usage: {
                  inputTokens: v.inputTokens,
                  outputTokens: v.outputTokens,
                  cacheReadTokens: v.cacheReadTokens,
                  cacheWriteTokens: v.cacheWriteTokens,
                  reasoningTokens: v.reasoningTokens,
                },
                totalNanoAiu: v.totalNanoAiu,
              },
            ];
          }),
        );
  const totalNanoAiu = o.totalNanoAiu ?? SHUTDOWN_DEFAULTS.totalNanoAiu;
  return compact({
    type: "session.shutdown",
    id: o.id ?? "e-shutdown",
    parentId: null,
    timestamp,
    data: {
      shutdownType: "routine",
      totalPremiumRequests: 3,
      totalApiDurationMs: o.totalApiDurationMs ?? 9000,
      sessionStartTime: o.sessionStartTime ?? Date.parse(timestamp) - 3_600_000,
      codeChanges: { linesAdded: 1, linesRemoved: 2, filesModified: [CANARY, `/${CANARY}/src/x.ts`] },
      modelMetrics,
      totalNanoAiu,
      currentModel: CANARY,
      currentTokens: 1234,
      accountingSnapshot: { aiCreditsStatus: CANARY, currentModel: CANARY, sessionStartTime: CANARY, modelMetrics },
      agentMetrics: { main: { modelMetrics, totalNanoAiu }, [CANARY]: { note: CANARY } },
      usageAccountingWatermarks: { [CANARY]: 1 },
    },
  });
}
