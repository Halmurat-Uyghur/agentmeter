// Synthetic Codex rollout fixtures (D45, D53). Nothing here comes from real
// Codex logs: every content-bearing string is CODEX_CANARY (instructions, every
// cwd segment but the last, git.*, sandbox paths, rate_limits.*, model_provider,
// content text, compacted summaries, inter-agent metadata, user messages and
// reasoning events)
// so tests can prove it never reaches a record. Numbers the reader must never
// keep (last_token_usage, turn/thread usage, rate limits) use the NEVER_* values.
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CODEX_CANARY = "CODEX-CANARY-5d1c";
/** A number that appears only in fields the reader must never read. */
export const NEVER_NUMBER = 987_654_321;

export const CODEX_SESSION = "0199a213-81c0-7800-8aa1-bbab2a035a53";
export const CODEX_TS = "2026-11-08T15:00:00.000Z";

/** Every segment but the last is the canary; the last is the project folder. */
export function canaryCwd(last = "codex-proj"): string {
  return `/${CODEX_CANARY}/src/${CODEX_CANARY}/${last}`;
}

export interface CodexUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
}

const DEFAULT_USAGE: CodexUsage = {
  input_tokens: 1200,
  cached_input_tokens: 800,
  cache_write_input_tokens: 0,
  output_tokens: 300,
  reasoning_output_tokens: 120,
  total_tokens: 1500,
};

const NEVER_USAGE = {
  input_tokens: NEVER_NUMBER,
  cached_input_tokens: NEVER_NUMBER,
  cache_write_input_tokens: NEVER_NUMBER,
  output_tokens: NEVER_NUMBER,
  reasoning_output_tokens: NEVER_NUMBER,
  total_tokens: NEVER_NUMBER,
};

function line(timestamp: string, ordinal: number, type: string, payload: object): string {
  return JSON.stringify({ timestamp, ordinal, type, payload });
}

export function codexMeta(o: { cwd?: string; timestamp?: string; ordinal?: number; id?: string } = {}): string {
  const ts = o.timestamp ?? CODEX_TS;
  return line(ts, o.ordinal ?? 0, "session_meta", {
    id: o.id ?? CODEX_SESSION,
    timestamp: ts,
    cwd: o.cwd ?? canaryCwd(),
    originator: CODEX_CANARY,
    cli_version: CODEX_CANARY,
    model_provider: CODEX_CANARY,
    instructions: `${CODEX_CANARY} instructions`,
    git: { commit_hash: CODEX_CANARY, branch: CODEX_CANARY, repository_url: `https://${CODEX_CANARY}.example/repo` },
    sandbox_policy: { mode: "workspace-write", writable_roots: [`/${CODEX_CANARY}/tmp`] },
  });
}

export function codexTurn(o: { turnId?: unknown; model?: unknown; timestamp?: string; ordinal?: number } = {}): string {
  return line(o.timestamp ?? CODEX_TS, o.ordinal ?? 1, "turn_context", {
    turn_id: o.turnId ?? "turn-1",
    cwd: canaryCwd(),
    approval_policy: "on-request",
    sandbox_policy: { mode: "workspace-write", writable_roots: [`/${CODEX_CANARY}/tmp`] },
    model: o.model ?? "gpt-5-codex",
    effort: "medium",
    summary: CODEX_CANARY,
    user_instructions: CODEX_CANARY,
  });
}

export function codexRecord(
  o: {
    sessionId?: unknown;
    turnId?: unknown;
    responseId?: unknown;
    usage?: CodexUsage | null;
    timestamp?: unknown;
    ordinal?: number;
  } = {},
): string {
  const payload: Record<string, unknown> = {
    thread_id: CODEX_CANARY,
    turn_id: o.turnId ?? "turn-1",
    session_id: o.sessionId ?? CODEX_SESSION,
    root_turn_id: CODEX_CANARY,
    response_id: o.responseId ?? "resp_0123456789abcdefABCDEF_-0123456789abcdefABCDEFghijk",
    turn_token_usage: NEVER_USAGE,
    thread_token_usage: NEVER_USAGE,
  };
  if (o.usage !== null) payload.usage = o.usage ?? DEFAULT_USAGE;
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return JSON.stringify({ timestamp: o.timestamp ?? CODEX_TS, ordinal: o.ordinal ?? 2, type: "token_usage_record", payload });
}

export function codexTokenCount(o: { total?: CodexUsage; timestamp?: string; ordinal?: number } = {}): string {
  return line(o.timestamp ?? CODEX_TS, o.ordinal ?? 3, "event_msg", {
    type: "token_count",
    info: {
      total_token_usage: o.total ?? DEFAULT_USAGE,
      last_token_usage: NEVER_USAGE,
      model_context_window: NEVER_NUMBER,
    },
    rate_limits: {
      primary: { used_percent: NEVER_NUMBER, window_minutes: NEVER_NUMBER, resets_at: CODEX_CANARY },
      secondary: { used_percent: NEVER_NUMBER, window_minutes: NEVER_NUMBER, resets_at: CODEX_CANARY },
      plan_type: CODEX_CANARY,
    },
  });
}

/** Any other line: `type` at the top, `payload.type` inside, content text as the canary. */
export function codexOther(type: string, payloadType: string, o: { timestamp?: string; ordinal?: number; text?: string } = {}): string {
  return line(o.timestamp ?? CODEX_TS, o.ordinal ?? 4, type, {
    type: payloadType,
    message: o.text ?? CODEX_CANARY,
    content: [{ type: "input_text", text: o.text ?? CODEX_CANARY }],
  });
}

/** A compacted line: the summary that replaces history (canary text). */
export function codexCompacted(o: { timestamp?: string; ordinal?: number } = {}): string {
  return line(o.timestamp ?? CODEX_TS, o.ordinal ?? 5, "compacted", {
    message: CODEX_CANARY,
    replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: CODEX_CANARY }] }],
  });
}

/** An inter_agent_communication_metadata line (canary ids and text). */
export function codexInterAgent(o: { timestamp?: string; ordinal?: number } = {}): string {
  return line(o.timestamp ?? CODEX_TS, o.ordinal ?? 6, "inter_agent_communication_metadata", {
    from_agent: CODEX_CANARY,
    to_agent: CODEX_CANARY,
    message: CODEX_CANARY,
    usage: { input_tokens: NEVER_NUMBER, output_tokens: NEVER_NUMBER },
  });
}

/** An event_msg user_message line (the user's prompt). */
export function codexUserMessage(o: { timestamp?: string; ordinal?: number } = {}): string {
  return line(o.timestamp ?? CODEX_TS, o.ordinal ?? 7, "event_msg", { type: "user_message", message: CODEX_CANARY, images: [CODEX_CANARY] });
}

/** An event_msg agent_reasoning line (reasoning text). */
export function codexAgentReasoning(o: { timestamp?: string; ordinal?: number } = {}): string {
  return line(o.timestamp ?? CODEX_TS, o.ordinal ?? 8, "event_msg", { type: "agent_reasoning", text: CODEX_CANARY });
}

export interface CodexFileFixture {
  /** "YYYY/MM/DD" */
  date: string;
  sessionId: string;
  lines: string[];
  /** a Date, or ms since epoch */
  mtime?: Date | number;
  /** file name override (default rollout-<date>T10-00-00-<sessionId>.jsonl) */
  name?: string;
}

/** Writes sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl files and optional archived_sessions/<name> files; returns the session file paths in order. */
export async function codexTree(root: string, files: CodexFileFixture[], archived?: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const f of files) {
    const dir = join(root, "sessions", ...f.date.split("/"));
    await mkdir(dir, { recursive: true });
    const name = f.name ?? `rollout-${f.date.replaceAll("/", "-")}T10-00-00-${f.sessionId}.jsonl`;
    const p = join(dir, name);
    await writeFile(p, f.lines.map((l) => `${l}\n`).join(""));
    if (f.mtime !== undefined) {
      // utimes takes seconds for a number (like claudeTree).
      const t = typeof f.mtime === "number" ? f.mtime / 1000 : f.mtime;
      await utimes(p, t, t);
    }
    paths.push(p);
  }
  if (archived !== undefined) {
    const dir = join(root, "archived_sessions");
    await mkdir(dir, { recursive: true });
    for (const a of archived) await writeFile(join(dir, a), `${codexMeta()}\n`);
  }
  return paths;
}
