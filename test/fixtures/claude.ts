// Synthetic Claude Code log fixtures. Nothing here comes from real logs: every
// content-bearing field (prompt and reply text, thinking, tool_use input,
// toolUseResult, gitBranch, every cwd segment but the last, the projects/<slug>
// directory name) holds CLAUDE_CANARY so tests can prove it never leaks.
// Key order mirrors real logs: parentUuid, isSidechain, message, …, type, uuid,
// timestamp, sessionId, cwd (user lines carry `type` early, as real ones do).
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CLAUDE_CANARY = "CLAUDE-CANARY-2b9e";

export const CLAUDE_SESSION = "0b7c2a1e-5d3f-4e8a-9b6c-1f2e3d4c5b6a";
export const CLAUDE_TS = "2026-11-08T14:30:00.000Z";
/** cwd whose label is "myrepo"; every other segment is the canary. */
export const CLAUDE_CWD = `/${CLAUDE_CANARY}/${CLAUDE_CANARY}/myrepo`;
/** default projects/<slug> name (the canary: the slug is never used). */
export const CLAUDE_SLUG = `-${CLAUDE_CANARY}-${CLAUDE_CANARY}-myrepo`;

const PARENT = "11111111-2222-4333-8444-555555555555";
const UUID = "66666666-7777-4888-9999-aaaaaaaaaaaa";

/** Absent fields are dropped; `null` stays when the option is explicitly null. */
type Plain = Record<string, unknown>;

export interface ClaudeAssistantOptions {
  model?: string;
  /** message.id; null omits it */
  id?: string | null;
  /** requestId; null omits it */
  requestId?: string | null;
  stopReason?: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** output_tokens_details.thinking_tokens; undefined omits the details object */
  thinking?: number;
  /** replaces message.usage wholesale; null omits it */
  usage?: unknown;
  /** tool_use names, one content block each */
  tools?: string[];
  /** tool_use input object (default holds the canary) */
  toolInput?: unknown;
  timestamp?: unknown;
  /** depth-1 sessionId; null omits it */
  sessionId?: unknown;
  cwd?: unknown;
  /** depth-1 type (default "assistant") */
  type?: string;
  isSidechain?: boolean;
}

/** One assistant line object as Claude Code writes it. */
export function claudeAssistant(o: ClaudeAssistantOptions = {}): Plain {
  const usage: Plain = {
    input_tokens: o.input ?? 3,
    cache_creation_input_tokens: o.cacheWrite ?? 200,
    cache_read_input_tokens: o.cacheRead ?? 1000,
    cache_creation: { ephemeral_5m_input_tokens: o.cacheWrite ?? 200, ephemeral_1h_input_tokens: 0 },
    output_tokens: o.output ?? 50,
    service_tier: "standard",
  };
  if (o.thinking !== undefined) usage.output_tokens_details = { thinking_tokens: o.thinking };
  const content: unknown[] = [
    { type: "thinking", thinking: CLAUDE_CANARY, signature: CLAUDE_CANARY },
    { type: "text", text: CLAUDE_CANARY },
  ];
  for (const [i, name] of (o.tools ?? []).entries()) {
    content.push({ type: "tool_use", id: `toolu_${i}`, name, input: o.toolInput ?? { command: CLAUDE_CANARY, description: CLAUDE_CANARY } });
  }
  const message: Plain = {
    model: o.model ?? "claude-opus-4-1",
    ...(o.id === null ? {} : { id: o.id ?? "msg_01AbCdEfGhIjKlMnOpQrStUv" }),
    type: "message",
    role: "assistant",
    content,
    stop_reason: o.stopReason === undefined ? "end_turn" : o.stopReason,
    stop_sequence: null,
    ...(o.usage === null ? {} : { usage: o.usage ?? usage }),
  };
  return {
    parentUuid: PARENT,
    isSidechain: o.isSidechain ?? false,
    message,
    ...(o.requestId === null ? {} : { requestId: o.requestId ?? "req_011CVabcdefghijklmnopqrs" }),
    userType: "external",
    version: "2.0.31",
    gitBranch: CLAUDE_CANARY,
    type: o.type ?? "assistant",
    uuid: UUID,
    timestamp: "timestamp" in o ? o.timestamp : CLAUDE_TS,
    ...(o.sessionId === null ? {} : { sessionId: o.sessionId ?? CLAUDE_SESSION }),
    cwd: o.cwd ?? CLAUDE_CWD,
  };
}

export function claudeAssistantLine(o: ClaudeAssistantOptions = {}): string {
  return JSON.stringify(claudeAssistant(o));
}

export interface ClaudeUserOptions {
  /** toolUseResult value (default holds the canary) */
  toolUseResult?: unknown;
  /** padding text in the prompt, to make long lines */
  text?: string;
  sessionId?: string;
  cwd?: string;
}

/** A user line: `type` sits early, as in real logs. */
export function claudeUserLine(o: ClaudeUserOptions = {}): string {
  return JSON.stringify({
    parentUuid: PARENT,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: o.text ?? CLAUDE_CANARY },
        { type: "tool_result", tool_use_id: "toolu_0", content: CLAUDE_CANARY },
      ],
    },
    toolUseResult: o.toolUseResult ?? { stdout: CLAUDE_CANARY, stderr: CLAUDE_CANARY },
    userType: "external",
    gitBranch: CLAUDE_CANARY,
    uuid: UUID,
    timestamp: CLAUDE_TS,
    sessionId: o.sessionId ?? CLAUDE_SESSION,
    cwd: o.cwd ?? CLAUDE_CWD,
  });
}

/** Any other line type (attachment, last-prompt, api-request, …), with content and a usage-like object. */
export function claudeOtherLine(type: string, o: { extra?: Plain } = {}): string {
  return JSON.stringify({
    parentUuid: PARENT,
    isSidechain: false,
    attachment: { content: CLAUDE_CANARY, usage: { input_tokens: 9, output_tokens: 9 } },
    ...o.extra,
    type,
    uuid: UUID,
    timestamp: CLAUDE_TS,
    sessionId: CLAUDE_SESSION,
    cwd: CLAUDE_CWD,
  });
}

export interface ClaudeSessionFixture {
  slug?: string;
  sessionId: string;
  /** lines of <slug>/<sessionId>.jsonl; undefined = no main file */
  lines?: string[];
  /** <slug>/<sessionId>/subagents/agent-<id>.jsonl, or …/subagents/workflows/wf_<workflow>/agent-<id>.jsonl */
  subagents?: { id: string; lines: string[]; workflow?: string }[];
  /** mtime of every file of this session (ms since epoch) */
  mtime?: number;
}

/** Writes sessions under <root>/projects/; returns every file path written. */
export async function claudeTree(root: string, sessions: ClaudeSessionFixture[]): Promise<string[]> {
  const paths: string[] = [];
  const write = async (path: string, lines: string[], mtime: number | undefined): Promise<void> => {
    await writeFile(path, lines.map((l) => `${l}\n`).join(""));
    if (mtime !== undefined) await utimes(path, mtime / 1000, mtime / 1000);
    paths.push(path);
  };
  for (const s of sessions) {
    const slugDir = join(root, "projects", s.slug ?? CLAUDE_SLUG);
    await mkdir(slugDir, { recursive: true });
    if (s.lines !== undefined) await write(join(slugDir, `${s.sessionId}.jsonl`), s.lines, s.mtime);
    for (const a of s.subagents ?? []) {
      const dir =
        a.workflow === undefined
          ? join(slugDir, s.sessionId, "subagents")
          : join(slugDir, s.sessionId, "subagents", "workflows", `wf_${a.workflow}`);
      await mkdir(dir, { recursive: true });
      await write(join(dir, `agent-${a.id}.jsonl`), a.lines, s.mtime);
    }
  }
  return paths;
}
