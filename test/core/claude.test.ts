import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, chmod, mkdir, mkdtemp, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as jsonScan from "../../src/core/jsonScan";
import {
  CLAUDE_HEAD_BYTES,
  CLAUDE_MAX_DEPTH,
  CLAUDE_MAX_FILES,
  CLAUDE_MAX_LINE_BYTES,
  ClaudeSourceReader,
  classifyClaudeHead,
  classifyClaudeLine,
  discoverClaude,
  parseClaudeLine,
  type ClaudeParse,
} from "../../src/core/claude";
import { RECENT_MS, type SourceCandidate } from "../../src/core/source";
import {
  CLAUDE_CANARY,
  CLAUDE_SESSION,
  CLAUDE_SLUG,
  CLAUDE_TS,
  claudeAssistant,
  claudeAssistantLine,
  CLAUDE_META_KINDS,
  claudeMetaLine,
  claudeOtherLine,
  claudeTree,
  claudeUserLine,
} from "../fixtures/claude";

const FILE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function parse(line: string, wantLabel = true): ClaudeParse {
  const buf = Buffer.from(line);
  return parseClaudeLine(buf, 0, buf.length, { fileSessionId: FILE_ID, wantLabel });
}

function usageOf(line: string, wantLabel = true): Extract<ClaudeParse, { kind: "usage" }> {
  const p = parse(line, wantLabel);
  if (p.kind !== "usage") throw new Error(`expected usage, got ${JSON.stringify(p)}`);
  return p;
}

function cls(line: string): string {
  const buf = Buffer.from(line);
  return classifyClaudeLine(buf, 0, buf.length);
}

describe("constants", () => {
  it("match the brief", () => {
    expect(CLAUDE_MAX_LINE_BYTES).toBe(4 * 1024 * 1024);
    expect(CLAUDE_HEAD_BYTES).toBe(4096);
    expect(CLAUDE_MAX_FILES).toBe(10_000);
    expect(CLAUDE_MAX_DEPTH).toBe(6);
  });
});

describe("classifyClaudeLine", () => {
  it("gates by raw needles", () => {
    expect(cls(claudeAssistantLine())).toBe("assistant");
    expect(cls(claudeUserLine())).toBe("user");
    expect(cls(claudeOtherLine("attachment"))).toBe("skip");
    expect(cls(claudeOtherLine("last-prompt"))).toBe("skip");
    expect(cls(JSON.stringify({ hook: CLAUDE_CANARY, usage: { input_tokens: 1 } }))).toBe("skip");
  });

  it("finds the assistant needle anywhere, the user needle only in the first 256 bytes", () => {
    const late = JSON.stringify({ pad: "x".repeat(300), type: "user" });
    expect(cls(late)).toBe("skip");
    const nested = claudeUserLine({ toolUseResult: { type: "assistant" } });
    expect(cls(nested)).toBe("assistant");
  });

  it("does not match escaped needles inside strings", () => {
    expect(cls(JSON.stringify({ text: '"type":"assistant"', type: "attachment" }))).toBe("skip");
  });
});

describe("parseClaudeLine", () => {
  it("builds a full record with the D47 sums", () => {
    const p = usageOf(claudeAssistantLine({ input: 3, cacheRead: 1000, cacheWrite: 200, output: 50, thinking: 20 }));
    expect(p.record).toEqual({
      key: "msg_01AbCdEfGhIjKlMnOpQrStUv",
      keySource: "claudeMessageId",
      source: "claude-code",
      kind: "call",
      sessionId: "0b7c2a1e-5d3f-4e8a-9b6c-1f2e3d4c5b6a",
      folderId: FILE_ID,
      timestampMs: Date.parse(CLAUDE_TS),
      model: "claude-opus-4-1",
      tokens: { input: 1203, cacheRead: 1000, cacheWrite: 200, output: 50, reasoning: 20 },
      finishReason: "stop",
    });
    expect(p.label).toBe("myrepo");
  });

  it("leaves reasoning unreported without thinking_tokens and a missing field absent, not 0", () => {
    const usage = { input_tokens: 7, output_tokens: 2 };
    const p = usageOf(claudeAssistantLine({ usage }));
    expect(p.record.tokens).toEqual({ input: 7, output: 2 });
    expect("reasoning" in p.record.tokens).toBe(false);
    expect("cacheRead" in p.record.tokens).toBe(false);
  });

  it("ignores zero-usage lines, such as <synthetic>", () => {
    const zero = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    expect(parse(claudeAssistantLine({ model: "<synthetic>", usage: zero }))).toEqual({ kind: "ignored" });
    expect(parse(claudeAssistantLine({ usage: {} }))).toEqual({ kind: "ignored" });
  });

  it("drops a model that is not MODEL_ID-shaped", () => {
    const p = usageOf(claudeAssistantLine({ model: "<synthetic>" }));
    expect(p.record.model).toBeUndefined();
    expect("model" in p.record).toBe(false);
  });

  it("reports a missing or non-object usage as no-usage-object", () => {
    expect(parse(claudeAssistantLine({ usage: null }))).toEqual({ kind: "unrecognized", reason: "no-usage-object" });
    expect(parse(claudeAssistantLine({ usage: 5 }))).toEqual({ kind: "unrecognized", reason: "no-usage-object" });
  });

  it("reports token fields with no valid count as no-known-token-field", () => {
    expect(parse(claudeAssistantLine({ usage: { input_tokens: "3", output_tokens: -1 } }))).toEqual({
      kind: "unrecognized",
      reason: "no-known-token-field",
    });
  });

  it("refuses a usage scalar slice over 4096 bytes; a large usage object is fine (never decoded)", () => {
    const big = claudeAssistantLine({ usage: { input_tokens: 1, output_tokens: 1 } }).replace('"input_tokens":1', `"input_tokens":${"1".repeat(5000)}`);
    expect(parse(big)).toEqual({ kind: "unrecognized", reason: "slice-too-large" });
    const usage = { input_tokens: 1, output_tokens: 1, pad: "x".repeat(5000) };
    expect(usageOf(claudeAssistantLine({ usage })).record.tokens).toEqual({ input: 1, output: 1 });
  });

  it("reads usage counts as scalar paths: a duplicate count is malformed, a non-number count is not decoded", () => {
    const dup = claudeAssistantLine({ usage: { input_tokens: 1, output_tokens: 1 } }).replace('"output_tokens":1', '"output_tokens":1,"output_tokens":2');
    expect(parse(dup)).toEqual({ kind: "malformed" });
    expect(parse(claudeAssistantLine({ usage: { input_tokens: { n: 1 }, output_tokens: [2] } }))).toEqual({
      kind: "unrecognized",
      reason: "no-known-token-field",
    });
    const p = usageOf(claudeAssistantLine({ usage: { input_tokens: 4, output_tokens: 2, output_tokens_details: { thinking_tokens: "9" } } }));
    expect(p.record.tokens).toEqual({ input: 4, output: 2 });
  });

  it("never decodes a usage string field (service_tier and the rest stay raw bytes)", () => {
    const spy = vi.spyOn(JSON, "parse");
    try {
      const lines = [claudeAssistantLine({ tools: ["Bash"], thinking: 5 }), claudeAssistantLine({ usage: { input_tokens: CLAUDE_CANARY, output_tokens: 1 } })];
      // Without a label the cwd (which also holds the canary) is not requested either.
      for (const l of lines) parse(l, false);
      expect(spy).toHaveBeenCalled();
      for (const [text] of spy.mock.calls) expect(String(text)).not.toContain(CLAUDE_CANARY);
    } finally {
      spy.mockRestore();
    }
  });

  it("keys by message.id, else requestId, else no-key", () => {
    const byReq = usageOf(claudeAssistantLine({ id: null }));
    expect(byReq.record.key).toBe("req_011CVabcdefghijklmnopqrs");
    expect(byReq.record.keySource).toBe("claudeRequestId");
    const badId = usageOf(claudeAssistantLine({ id: "bad id!" }));
    expect(badId.record.keySource).toBe("claudeRequestId");
    expect(parse(claudeAssistantLine({ id: null, requestId: null }))).toEqual({ kind: "unrecognized", reason: "no-key" });
    expect(parse(claudeAssistantLine({ id: "__proto__", requestId: null }))).toEqual({ kind: "unrecognized", reason: "no-key" });
  });

  it("rejects a bad timestamp", () => {
    for (const timestamp of ["2026-11-08 14:30:00", 1762612200000, "2026-11-08T14:30:00", null]) {
      expect(parse(claudeAssistantLine({ timestamp }))).toEqual({ kind: "unrecognized", reason: "bad-timestamp" });
    }
  });

  it("maps stop_reason", () => {
    const cases: [string | null, string | undefined][] = [
      ["end_turn", "stop"],
      ["tool_use", "tool_calls"],
      ["max_tokens", "length"],
      ["refusal", "content_filter"],
      ["pause_turn", "other"],
      [CLAUDE_CANARY, "other"],
      [null, undefined],
    ];
    for (const [stopReason, want] of cases) {
      const r = usageOf(claudeAssistantLine({ stopReason })).record;
      expect(r.finishReason).toBe(want);
      if (want === undefined) expect("finishReason" in r).toBe(false);
    }
  });

  it("counts tool_use names and never reads their inputs", () => {
    const p = usageOf(
      claudeAssistantLine({ tools: ["Bash", "Read", "Bash", "mcp__srv__tool", "__proto__", "bad name!", CLAUDE_CANARY + "/x".repeat(60)] }),
    );
    expect(p.record.tools).toEqual({ Bash: 2, Read: 1, mcp__srv__tool: 1 });
    expect(Object.getPrototypeOf(p.record.tools)).toBeNull();
    expect(JSON.stringify(p)).not.toContain(CLAUDE_CANARY);
  });

  it("omits tools when there is no tool_use block", () => {
    expect("tools" in usageOf(claudeAssistantLine()).record).toBe(false);
  });

  it("caps tool names at 64", () => {
    const names = Array.from({ length: 70 }, (_, i) => `tool${i}`);
    const p = usageOf(claudeAssistantLine({ tools: names }));
    expect(Object.keys(p.record.tools ?? {})).toHaveLength(64);
  });

  it("takes exactly one record from the top level when a tool input nests an assistant line", () => {
    const toolInput = { type: "assistant", message: { id: "msg_evil", model: "evil-model", usage: { input_tokens: 999999, output_tokens: 999999 } } };
    const line = claudeAssistantLine({ tools: ["Task"], toolInput, input: 1, cacheRead: 0, cacheWrite: 0, output: 2 });
    const p = usageOf(line);
    expect(p.record.key).toBe("msg_01AbCdEfGhIjKlMnOpQrStUv");
    expect(p.record.model).toBe("claude-opus-4-1");
    expect(p.record.tokens).toEqual({ input: 1, cacheRead: 0, cacheWrite: 0, output: 2 });
    expect(p.record.tools).toEqual({ Task: 1 });
  });

  it("ignores a user line whose toolUseResult holds an assistant line", () => {
    const line = claudeUserLine({ toolUseResult: { type: "assistant", message: { id: "msg_x", usage: { input_tokens: 5, output_tokens: 5 } } } });
    expect(parse(line)).toEqual({ kind: "ignored" });
  });

  it("is not fooled by escaped needles in text", () => {
    const line = JSON.stringify({ ...claudeAssistant(), type: "attachment", note: '{"type":"assistant","message":{"usage":{"input_tokens":1}}}' });
    expect(parse(line)).toEqual({ kind: "ignored" });
  });

  it("reduces cwd to its folder label, stripping a worktree suffix", () => {
    expect(usageOf(claudeAssistantLine({ cwd: `/${CLAUDE_CANARY}/myrepo/.claude/worktrees/${CLAUDE_CANARY}` })).label).toBe("myrepo");
    expect(usageOf(claudeAssistantLine({ cwd: `/${CLAUDE_CANARY}/myrepo/.worktrees/${CLAUDE_CANARY}` })).label).toBe("myrepo");
    const off = usageOf(claudeAssistantLine(), false);
    expect(off.label).toBeUndefined();
    expect("label" in off).toBe(false);
    expect(usageOf(claudeAssistantLine({ cwd: 42 })).label).toBeUndefined();
  });

  it("keeps the file's id as folderId and the line's session id as sessionId (a resumed file)", () => {
    const OLDER = "99999999-8888-4777-8666-555555555555";
    const r = usageOf(claudeAssistantLine({ sessionId: OLDER })).record;
    expect(r.sessionId).toBe(OLDER);
    expect(r.folderId).toBe(FILE_ID);
  });

  it("falls back to the file's session id", () => {
    expect(usageOf(claudeAssistantLine({ sessionId: null })).record.sessionId).toBe(FILE_ID);
    expect(usageOf(claudeAssistantLine({ sessionId: "not a session" })).record.sessionId).toBe(FILE_ID);
    const r = usageOf(claudeAssistantLine({ sessionId: "__proto__" })).record;
    expect(r.sessionId).toBe(FILE_ID);
    expect(r.folderId).toBe(FILE_ID);
  });

  it("treats truncated lines and duplicate top-level keys as malformed", () => {
    const line = claudeAssistantLine();
    expect(parse(line.slice(0, line.length - 10))).toEqual({ kind: "malformed" });
    expect(parse(line.replace('"type":"assistant"', '"type":"assistant","type":"assistant"'))).toEqual({ kind: "malformed" });
    expect(parse(line.replace('"id":"msg_', '"id":"msg_dup","id":"msg_'))).toEqual({ kind: "malformed" });
    expect(parse("not json")).toEqual({ kind: "malformed" });
  });

  it("accepts a trailing CR", () => {
    expect(usageOf(claudeAssistantLine() + "\r").record.key).toBe("msg_01AbCdEfGhIjKlMnOpQrStUv");
  });

  it("never lets the canary through", () => {
    const lines = [
      claudeAssistantLine({ tools: ["Bash"], thinking: 5 }),
      claudeAssistantLine({ cwd: `/${CLAUDE_CANARY}/repo/.claude/worktrees/${CLAUDE_CANARY}` }),
      claudeUserLine(),
      claudeUserLine({ toolUseResult: CLAUDE_CANARY }),
      claudeUserLine({ contentString: true }),
      claudeOtherLine("attachment"),
      ...CLAUDE_META_KINDS.map(claudeMetaLine),
    ];
    for (const l of lines) expect(JSON.stringify(parse(l))).not.toContain(CLAUDE_CANARY);
  });

  it("the fixture carries the canary in every new content field", () => {
    const a = claudeAssistant() as { agentId: unknown; message: { stop_sequence: unknown; usage: Record<string, unknown> } };
    expect(a.agentId).toBe(CLAUDE_CANARY);
    expect(a.message.stop_sequence).toBe(CLAUDE_CANARY);
    expect(a.message.usage.service_tier).toBe(CLAUDE_CANARY);
    expect(JSON.stringify(a.message.usage.cache_creation)).toContain(CLAUDE_CANARY);
    expect(JSON.stringify(a.message.usage.server_tool_use)).toContain(CLAUDE_CANARY);
    expect(claudeMetaLine("telemetry")).not.toContain('"type"');
    for (const k of CLAUDE_META_KINDS) expect(cls(claudeMetaLine(k))).toBe("skip");
    expect(cls(claudeUserLine({ contentString: true }))).toBe("user");
  });
});

describe("classifyClaudeHead", () => {
  const head = (line: string): string => {
    const buf = Buffer.from(line);
    return classifyClaudeHead(buf, 0, Math.min(buf.length, CLAUDE_HEAD_BYTES));
  };
  it("sees role assistant inside message", () => {
    expect(head(claudeAssistantLine())).toBe("assistant");
    expect(head(claudeUserLine())).toBe("other");
    expect(head(claudeOtherLine("api-request-blob"))).toBe("other");
    expect(head(JSON.stringify({ role: "assistant", type: "x" }))).toBe("other");
  });
});

// ---------------------------------------------------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-test-"));
});
afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";

describe("discoverClaude", () => {
  const now = Date.parse("2026-11-08T15:00:00.000Z");
  const dayStart = Date.parse("2026-11-08T05:00:00.000Z");
  const windowStart = Date.parse("2026-11-01T04:00:00.000Z");

  it("folds subagent files into the parent session and computes live", async () => {
    await claudeTree(root, [
      {
        sessionId: S1,
        lines: [claudeAssistantLine()],
        subagents: [
          { id: "a1", lines: [claudeAssistantLine()] },
          { id: "a2", lines: [claudeAssistantLine()], workflow: "x" },
        ],
        mtime: now - 60_000,
      },
      { sessionId: S2, lines: [claudeAssistantLine()], mtime: now - RECENT_MS - 60_000 },
    ]);
    const res = await discoverClaude(root, windowStart, dayStart, now);
    if (!res.ok) throw new Error("not ok");
    expect(res.candidates.map((c) => c.sessionId)).toEqual([S1, S2]);
    const c1 = res.candidates[0]!;
    expect(c1.source).toBe("claude-code");
    expect(c1.folderId).toBe(S1);
    expect(c1.live).toBe(true);
    expect(c1.mtimeMs).toBe(now - 60_000);
    const rel = c1.files.map((f) => f.path.slice(root.length + 1)).sort();
    expect(rel).toEqual(
      [
        join("projects", CLAUDE_SLUG, `${S1}.jsonl`),
        join("projects", CLAUDE_SLUG, S1, "subagents", "agent-a1.jsonl"),
        join("projects", CLAUDE_SLUG, S1, "subagents", "workflows", "wf_x", "agent-a2.jsonl"),
      ].sort(),
    );
    expect(res.candidates[1]!.live).toBe(false);
    expect(res.dirMtimeMs).toBe(Math.max((await stat(join(root, "projects"))).mtimeMs, (await stat(join(root, "projects", CLAUDE_SLUG))).mtimeMs));
    expect(res.unreadable).toEqual([]);
    for (const c of res.candidates) {
      expect(c.sessionId).not.toContain(CLAUDE_CANARY);
      expect(c.folderId).not.toContain(CLAUDE_CANARY);
    }
  });

  it("a session whose only fresh file is a subagent is still found", async () => {
    await claudeTree(root, [{ sessionId: S1, subagents: [{ id: "a", lines: [claudeAssistantLine()] }], mtime: now - 1000 }]);
    const res = await discoverClaude(root, windowStart, dayStart, now);
    if (!res.ok) throw new Error("not ok");
    expect(res.candidates.map((c) => [c.sessionId, c.files.length])).toEqual([[S1, 1]]);
  });

  it("is not live when the recent write was before today", async () => {
    const lateNight = dayStart - 60_000;
    await claudeTree(root, [{ sessionId: S1, lines: [claudeAssistantLine()], mtime: lateNight }]);
    const res = await discoverClaude(root, windowStart, dayStart, dayStart + 60_000);
    if (!res.ok) throw new Error("not ok");
    expect(res.candidates[0]!.live).toBe(false);
  });

  it("skips memory/, tool-results/, other folders, non-session files, symlinks and old files", async () => {
    await claudeTree(root, [
      { sessionId: S1, lines: [claudeAssistantLine()], mtime: now - 1000 },
      { sessionId: S2, lines: [claudeAssistantLine()], mtime: windowStart - 1000 },
    ]);
    const slugDir = join(root, "projects", CLAUDE_SLUG);
    for (const d of ["memory", "tool-results", "vercel-plugin", "remote-agents", join(S1, "tool-results"), join(S1, "memory")]) {
      await mkdir(join(slugDir, d), { recursive: true });
      await writeFile(join(slugDir, d, `${S3}.jsonl`), claudeAssistantLine() + "\n");
    }
    await writeFile(join(slugDir, "notes.jsonl"), claudeAssistantLine() + "\n");
    await writeFile(join(slugDir, `${S3}.json`), claudeAssistantLine() + "\n");
    // A symlinked session file and a symlinked session folder are not followed.
    const outside = await mkdtemp(join(tmpdir(), "claude-outside-"));
    try {
      await writeFile(join(outside, "x.jsonl"), claudeAssistantLine() + "\n");
      await symlink(join(outside, "x.jsonl"), join(slugDir, `${S3}.jsonl`));
      await mkdir(join(outside, "sub"));
      await writeFile(join(outside, "sub", "agent-z.jsonl"), claudeAssistantLine() + "\n");
      await symlink(outside, join(slugDir, "44444444-4444-4444-8444-444444444444"));
      await symlink(outside, join(root, "projects", "linked-slug"));
      const res = await discoverClaude(root, windowStart, dayStart, now);
      if (!res.ok) throw new Error("not ok");
      expect(res.candidates.map((c) => c.sessionId)).toEqual([S1]);
      expect(res.candidates[0]!.files).toHaveLength(1);
      expect(res.capped ?? 0).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not descend past CLAUDE_MAX_DEPTH", async () => {
    const deep = join(root, "projects", CLAUDE_SLUG, S1, "a", "b", "c", "d");
    await mkdir(deep, { recursive: true });
    await writeFile(join(root, "projects", CLAUDE_SLUG, S1, "a", "b", "c", "ok.jsonl"), "\n");
    await writeFile(join(deep, "too-deep.jsonl"), "\n");
    const res = await discoverClaude(root, 0, dayStart, now);
    if (!res.ok) throw new Error("not ok");
    expect(res.candidates[0]!.files.map((f) => f.path.split(/[\\/]/).at(-1))).toEqual(["ok.jsonl"]);
  });

  it("merges one session id found under two slugs", async () => {
    await claudeTree(root, [
      { slug: "slug-a", sessionId: S1, lines: [claudeAssistantLine()], mtime: now - 2000 },
      { slug: "slug-b", sessionId: S1, lines: [claudeAssistantLine()], mtime: now - 1000 },
    ]);
    const res = await discoverClaude(root, windowStart, dayStart, now);
    if (!res.ok) throw new Error("not ok");
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.files).toHaveLength(2);
    expect(res.candidates[0]!.mtimeMs).toBe(now - 1000);
  });

  it("counts files beyond CLAUDE_MAX_FILES as capped", async () => {
    const dir = join(root, "projects", "slug", S1, "subagents");
    await mkdir(dir, { recursive: true });
    const n = CLAUDE_MAX_FILES + 5;
    for (let i = 0; i < n; i += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, n - i) }, (_, j) => writeFile(join(dir, `agent-${i + j}.jsonl`), "")),
      );
    }
    const res = await discoverClaude(root, 0, dayStart, Date.now());
    if (!res.ok) throw new Error("not ok");
    expect(res.candidates[0]!.files).toHaveLength(CLAUDE_MAX_FILES);
    expect(res.capped).toBe(5);
  }, 60_000);

  it("reports a slug or session folder that cannot be listed as unreadable, never naming the slug", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await claudeTree(root, [
      { sessionId: S1, lines: [claudeAssistantLine()], mtime: now - 1000 },
      { slug: "other-slug", sessionId: S2, subagents: [{ id: "a", lines: [claudeAssistantLine()] }], mtime: now - 1000 },
    ]);
    const slugDir = join(root, "projects", CLAUDE_SLUG);
    const sessionDir = join(root, "projects", "other-slug", S2);
    await chmod(slugDir, 0o000);
    await chmod(sessionDir, 0o000);
    try {
      const res = await discoverClaude(root, windowStart, dayStart, now);
      if (!res.ok) throw new Error("not ok");
      expect(res.candidates).toEqual([]);
      expect(res.unreadable).toEqual([
        { folderId: "", path: slugDir, code: "EACCES" },
        { folderId: S2, path: sessionDir, code: "EACCES" },
      ]);
      for (const u of res.unreadable) expect(u.folderId).not.toContain(CLAUDE_CANARY);
    } finally {
      await chmod(slugDir, 0o755);
      await chmod(sessionDir, 0o755);
    }
  });

  it("reports lstat errors as unreadable", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await claudeTree(root, [{ sessionId: S1, lines: [claudeAssistantLine()], mtime: now - 1000 }]);
    const slugDir = join(root, "projects", CLAUDE_SLUG);
    await chmod(slugDir, 0o444);
    try {
      const res = await discoverClaude(root, windowStart, dayStart, now);
      if (!res.ok) throw new Error("not ok");
      expect(res.candidates).toEqual([]);
      expect(res.unreadable).toEqual([{ folderId: S1, path: join(slugDir, `${S1}.jsonl`), code: "EACCES" }]);
    } finally {
      await chmod(slugDir, 0o755);
    }
  });

  it("reports a missing projects folder", async () => {
    expect(await discoverClaude(root, windowStart, dayStart, now)).toEqual({ ok: false, error: "no-dir" });
    expect(await discoverClaude(join(root, "nope"), windowStart, dayStart, now)).toEqual({ ok: false, error: "no-dir" });
  });
});

describe("ClaudeSourceReader", () => {
  const make = (readProjects = true): ClaudeSourceReader => new ClaudeSourceReader({ root, rootSource: "default", readProjects });
  const candidate = (path: string): SourceCandidate => ({
    source: "claude-code",
    sessionId: S1,
    folderId: S1,
    files: [{ path, mtimeMs: 0, size: 0 }],
    mtimeMs: 0,
    live: false,
  });

  it("describes itself", async () => {
    const r = make();
    expect(r.source).toBe("claude-code");
    expect(r.root).toBe(root);
    expect(r.rootSource).toBe("default");
    expect(await r.rootDirMtime()).toBeUndefined();
    await mkdir(join(root, "projects"));
    expect(await r.rootDirMtime()).toBe((await stat(join(root, "projects"))).mtimeMs);
  });

  it("discover delegates to discoverClaude", async () => {
    await claudeTree(root, [{ sessionId: S1, lines: [claudeAssistantLine()] }]);
    const res = await make().discover(0, 0, Date.now());
    if (!res.ok) throw new Error("not ok");
    expect(res.candidates.map((c) => c.sessionId)).toEqual([S1]);
  });

  it("pathAllowed admits only .jsonl under projects/", () => {
    const r = make();
    expect(r.pathAllowed(join(root, "projects", "slug", `${S1}.jsonl`))).toBe(true);
    expect(r.pathAllowed(join(root, "projects", "slug", S1, "subagents", "workflows", "wf_x", "agent-a.jsonl"))).toBe(true);
    expect(r.pathAllowed(join(root, "history.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "projects", "slug", `${S1}.json`))).toBe(false);
    expect(r.pathAllowed(join(root, "projects", `${S1}.jsonl`))).toBe(false);
    expect(r.pathAllowed(join(root, "projects", "slug", "..", "..", "history.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "projects", "slug", "memory", "x.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "projects", "slug", S1, "tool-results", "x.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root + "x", "projects", "slug", `${S1}.jsonl`))).toBe(false);
    expect(r.pathAllowed("relative/projects/slug/a.jsonl")).toBe(false);
  });

  it("pathAllowed needs a session-id stem at slug level or a session-id folder under the slug", () => {
    const r = make();
    expect(r.pathAllowed(join(root, "projects", "slug", "plugin-dir", "x.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "projects", "slug", "notes.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "projects", "slug", "plugins", "cache", "y.jsonl"))).toBe(false);
    expect(r.pathAllowed(join(root, "projects", "slug", S1, "subagents", "agent-a.jsonl"))).toBe(true);
    expect(r.pathAllowed(join(root, "projects", "slug", S1, "agent-a.jsonl"))).toBe(true);
  });

  it("rootDirMtime is the newest of projects/ and every slug folder: a new file changes it, an append does not", async () => {
    const [path] = await claudeTree(root, [{ sessionId: S1, lines: [claudeAssistantLine()] }]);
    const slugDir = join(root, "projects", CLAUDE_SLUG);
    const old = new Date(Date.now() - 3_600_000);
    await utimes(slugDir, old, old);
    await utimes(join(root, "projects"), old, old);
    const r = make();
    const before = await r.rootDirMtime();
    expect(before).toBe((await stat(slugDir)).mtimeMs);
    await appendFile(path!, claudeAssistantLine({ id: "msg_more" }) + "\n");
    expect(await r.rootDirMtime()).toBe(before);
    await writeFile(join(slugDir, `${S2}.jsonl`), claudeAssistantLine() + "\n");
    const after = await r.rootDirMtime();
    expect(after).toBe((await stat(slugDir)).mtimeMs);
    expect(after).toBeGreaterThan(before!);
  });

  it("discover's dirMtimeMs is the same newest mtime as rootDirMtime, so the monitor's baseline and check agree", async () => {
    await claudeTree(root, [{ sessionId: S1, lines: [claudeAssistantLine()] }]);
    const slugDir = join(root, "projects", CLAUDE_SLUG);
    const old = new Date(Date.now() - 3_600_000);
    const newer = new Date(Date.now() - 60_000);
    await utimes(join(root, "projects"), old, old);
    await utimes(slugDir, newer, newer);
    const r = make();
    const res = await r.discover(0, 0, Date.now());
    if (!res.ok) throw new Error("not ok");
    expect(res.dirMtimeMs).toBe((await stat(slugDir)).mtimeMs);
    expect(res.dirMtimeMs).toBeGreaterThan((await stat(join(root, "projects"))).mtimeMs);
    expect(await r.rootDirMtime()).toBe(res.dirMtimeMs);
  });

  it("reads records, activity and counters, with the label set from the first usage record", async () => {
    const [path] = await claudeTree(root, [
      {
        sessionId: S1,
        lines: [
          claudeUserLine(),
          claudeOtherLine("attachment"),
          claudeAssistantLine({ id: "msg_a", tools: ["Bash"], cwd: `/${CLAUDE_CANARY}/first` }),
          claudeAssistantLine({ id: "msg_b", cwd: `/${CLAUDE_CANARY}/second` }),
          claudeAssistantLine({ model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } }),
          claudeAssistantLine({ usage: null }),
          claudeAssistantLine().slice(0, -10),
          claudeUserLine({ toolUseResult: { type: "assistant", message: { usage: { input_tokens: 1 } } } }),
        ],
      },
    ]);
    const fr = make().open(path!, candidate(path!));
    const res = await fr.read();
    expect(res.records.map((r) => r.key)).toEqual(["msg_a", "msg_b"]);
    expect(res.records.every((r) => r.source === "claude-code" && r.sessionId === CLAUDE_SESSION)).toBe(true);
    expect(res.usage).toBe(2);
    expect(res.label).toBe("first");
    expect(res.activity).toBe(2);
    expect(res.unrecognized).toBe(1);
    expect(res.malformed).toBe(1);
    expect(res.reset).toBe(false);
    expect(res.error).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain(CLAUDE_CANARY);

    await appendFile(path!, claudeAssistantLine({ id: "msg_c", cwd: "/x/third" }) + "\n");
    const again = await fr.read();
    expect(again.records.map((r) => r.key)).toEqual(["msg_c"]);
    // The label is reported once, in the read that first finds it (source.ts contract).
    expect(again.label).toBeUndefined();
  });

  it("a resumed file's lines keep their older session id; folderId is the file's id", async () => {
    const OLDER = "99999999-8888-4777-8666-555555555555";
    const [path] = await claudeTree(root, [{ sessionId: S1, lines: [claudeAssistantLine({ sessionId: OLDER })] }]);
    const res = await make().open(path!, candidate(path!)).read();
    expect(res.records.map((r) => [r.sessionId, r.folderId])).toEqual([[OLDER, S1]]);
  });

  it("counts assistant-class gated lines as candidates; user lines and other lines are not", async () => {
    const [path] = await claudeTree(root, [
      {
        sessionId: S1,
        lines: [
          claudeUserLine(),
          claudeUserLine({ toolUseResult: { type: "assistant", message: { usage: { input_tokens: 1 } } } }),
          claudeOtherLine("attachment"),
          ...CLAUDE_META_KINDS.map(claudeMetaLine),
          claudeAssistantLine({ id: "msg_a" }),
          claudeAssistantLine({ model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } }),
          claudeAssistantLine({ usage: null }),
          claudeAssistantLine().slice(0, -10),
        ],
      },
    ]);
    const fr = make().open(path!, candidate(path!));
    const res = await fr.read();
    expect(res.candidates).toBe(4);
    expect(res.usage).toBe(1);
    expect(res.activity).toBe(2);
    expect((await fr.read()).candidates).toBe(0);
    await appendFile(path!, claudeUserLine() + "\n");
    const next = await fr.read();
    expect(next.candidates).toBe(0);
    expect(next.activity).toBe(1);
  });

  it("uses the candidate's session id when a line has none", async () => {
    const [path] = await claudeTree(root, [{ sessionId: S1, lines: [claudeAssistantLine({ sessionId: null })] }]);
    const res = await make().open(path!, candidate(path!)).read();
    expect(res.records[0]!.sessionId).toBe(S1);
  });

  it("gives no label when project names are off", async () => {
    const [path] = await claudeTree(root, [{ sessionId: S1, lines: [claudeAssistantLine()] }]);
    const res = await make(false).open(path!, candidate(path!)).read();
    expect(res.records).toHaveLength(1);
    expect(res.label).toBeUndefined();
  });

  it("emits a streamed message's lines as separate records with one key (the store merges)", async () => {
    const [path] = await claudeTree(root, [{ sessionId: S1, lines: [claudeAssistantLine({ stopReason: null, output: 10, tools: ["Read"] })] }]);
    const fr = make().open(path!, candidate(path!));
    const first = await fr.read();
    await appendFile(path!, claudeAssistantLine({ stopReason: "end_turn", output: 50, tools: ["Bash"] }) + "\n");
    const second = await fr.read();
    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    expect(first.records[0]!.key).toBe(second.records[0]!.key);
    expect(first.records[0]!.finishReason).toBeUndefined();
    expect(second.records[0]!.finishReason).toBe("stop");
    expect(second.records[0]!.tokens.output).toBe(50);
  });

  it("emits every repeat within one read, without merging", async () => {
    const [path] = await claudeTree(root, [
      { sessionId: S1, lines: [claudeAssistantLine({ stopReason: null, output: 1 }), claudeAssistantLine({ output: 2 })] },
    ]);
    const res = await make().open(path!, candidate(path!)).read();
    expect(res.records.map((r) => r.tokens.output)).toEqual([1, 2]);
  });

  it("counts an over-long user line as overlongOther and an over-long assistant line as overlong", async () => {
    const big = "y".repeat(CLAUDE_MAX_LINE_BYTES + 10);
    const [path] = await claudeTree(root, [
      {
        sessionId: S1,
        lines: [
          claudeUserLine({ text: big }),
          JSON.stringify({ ...claudeAssistant(), message: { ...(claudeAssistant().message as object), content: [{ type: "text", text: big }] } }),
          claudeAssistantLine({ id: "msg_after" }),
        ],
      },
    ]);
    const res = await make().open(path!, candidate(path!)).read();
    expect(res.overlongOther).toBe(1);
    expect(res.overlong).toBe(1);
    expect(res.records.map((r) => r.key)).toEqual(["msg_after"]);
  }, 30_000);

  it("re-reads a rewritten file from the start with fresh per-file state", async () => {
    const [path] = await claudeTree(root, [
      {
        sessionId: S1,
        lines: [
          claudeAssistantLine({ id: "msg_old1", cwd: `/${CLAUDE_CANARY}/oldrepo` }),
          claudeAssistantLine({ id: "msg_old2" }),
          claudeUserLine(),
          claudeAssistantLine({ usage: null }),
        ],
      },
    ]);
    const fr = make().open(path!, candidate(path!));
    const first = await fr.read();
    expect(first.label).toBe("oldrepo");
    expect(first.records).toHaveLength(2);
    await truncate(path!, 0);
    await writeFile(path!, claudeAssistantLine({ id: "msg_new", cwd: `/${CLAUDE_CANARY}/newrepo` }) + "\n");
    const second = await fr.read();
    expect(second.reset).toBe(true);
    expect(second.label).toBe("newrepo");
    expect(second.records.map((r) => r.key)).toEqual(["msg_new"]);
    expect(second.usage).toBe(1);
    expect(second.activity).toBe(0);
    expect(second.unrecognized).toBe(0);
    expect(second.malformed).toBe(0);
    const third = await fr.read();
    expect(third.reset).toBe(false);
    expect(third.records).toEqual([]);
    expect(third.label).toBeUndefined();
  });

  it("counts a line whose parsing throws as malformed and keeps reading", async () => {
    const [path] = await claudeTree(root, [
      { sessionId: S1, lines: [claudeAssistantLine({ id: "msg_boom" }), claudeAssistantLine({ id: "msg_ok" })] },
    ]);
    const spy = vi.spyOn(jsonScan, "scanJson").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    try {
      const res = await make().open(path!, candidate(path!)).read();
      expect(spy).toHaveBeenCalled();
      expect(res.malformed).toBe(1);
      expect(res.records.map((r) => r.key)).toEqual(["msg_ok"]);
      expect(res.error).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a missing file as an error", async () => {
    const path = join(root, "projects", "slug", `${S1}.jsonl`);
    const res = await make().open(path, candidate(path)).read();
    expect(res.error).toBe("ENOENT");
    expect(res.records).toEqual([]);
  });
});
