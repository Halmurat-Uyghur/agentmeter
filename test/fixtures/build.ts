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
        copilotUsage: { totalNanoAiu: v.totalNanoAiu },
        accounting: { usageId: v.usageId, sequence: v.sequence, sourceSessionId: v.sourceSessionId },
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
