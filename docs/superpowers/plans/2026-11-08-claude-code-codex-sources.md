# Claude Code and Codex Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count Claude Code and Codex CLI usage from their local logs next to Copilot's, in the same status bar, side bar and panel, without ever decoding a prompt, reply, thinking block, tool input or path.

**Architecture:** A `SourceReader` per tool (Copilot adapter around today's code; new Claude Code and Codex readers) feeds one `UsageStore` whose records carry `source`. New readers gate lines with a native byte needle and extract only allowlisted slices through a depth-tracking JSON byte scanner. The monitor composes the enabled readers, polls hot files every tick and cold files on discovery, and the snapshot gains per-source totals, a source filter and per-source health.

**Tech Stack:** TypeScript 7 (strict), Node 20 APIs only (`node:fs`, `node:path`, `node:os`), esbuild bundle, Vitest unit tests with the `vscode` fake, `@vscode/test-cli` integration tests, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-08-claude-code-codex-sources-design.md` (D40–D54). Read it before any task; it is the authority when this plan and the spec disagree.

## Global Constraints

- No new runtime dependency; `package.json` `dependencies` stays `{}`.
- Bundle imports only `node:fs`, `node:os`, `node:path` and `vscode`; no network module, no `fetch(` outside `src/vscode/exchangeRate.ts`, no `console.`, no `writeFile`/`appendFile`/`mkdir`/`unlink`/`rename(`/`copyFile` in `src/` (gate list in `test/core/gates.test.ts`).
- No hardcoded `/Users/` or `/home/` anywhere under `src/`, `test/`, `tools/`.
- Copy rule for README and every manifest string: no `bill`, `billing`, `remaining`, `quota`, `limit`, `allowance`, `premium` (as whole words) and no `%`. `LOCAL_BANNER` is exempt only inside README's "What this is not".
- Settings that read files are scope `machine`; `currency` and `targetAlert` stay `application`.
- `PANEL_COMMANDS` (6) and `SIDEBAR_COMMANDS` (5) are unchanged; the `.vsix` holds exactly `package.json`, `README.md`, `LICENSE`, `dist/extension.js` and the four walkthrough markdown files.
- "—" means not reported, never 0; "*" means some contributing records did not report the field.
- Every log-derived object key goes through `safeKey` (no `__proto__`, `constructor`, `prototype`) and into `Object.create(null)` maps.
- Timestamps must match `TIMESTAMP` (`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$`) before `Date.parse`.
- Claude Code and Codex lines are never decoded whole: only `parseSlice` in `src/core/jsonScan.ts` calls `JSON.parse`, on slices of at most `MAX_SLICE_BYTES` (4096).
- Fixtures: every content-bearing string is `CANARY` (`SYNTHETIC-CANARY-7f3a`) or a per-source canary, and tests assert it never reaches a record, snapshot, HTML, tooltip or log line.
- Every task: `npm run typecheck` and `npx vitest run` pass before its commit; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- TZ for tests is `America/Toronto` (vitest.config.ts).

## Review Focus

1. A Claude Code assistant line whose `message.content[*].input` holds `{"type":"assistant","message":{"usage":{"input_tokens":1}}}` must produce exactly one record from the real top-level fields and never a second one (Task 4 structure-attack test).
2. A Claude Code log with 20,000 assistant lines of one streamed message id must yield one record whose usage is the last line's and whose tools are the union (Task 1 store merge test; Task 4 reader test).
3. A Copilot-only machine (both new folders absent, settings on) must show the same figures and `health.state` as 0.7.0, with `Health.sources` rows saying "folder not found" (Task 8 test).
4. A Codex `rate_limits` object and a `session_meta.payload.instructions` string holding the canary must never reach any output, including the Output channel (Task 5 and Task 12 canary tests).
5. 3,000 cold Claude Code files and one hot file: an idle tick must cost < 5 ms CPU and open at most the hot file (Task 8 fs-spy test; Task 12 perf budget).

---

### Task 1: Source dimension in types, store, insights; label and source contracts

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/store.ts`
- Modify: `src/core/insights.ts` (`promptConventions`, `promptTokens`, `scanCalls`)
- Create: `src/core/source.ts`
- Create: `src/core/label.ts`
- Modify: `test/fixtures/build.ts` (record helper defaults), every `test/core/*.test.ts` that builds a `UsageRecord` literal (add `source: "copilot"`)
- Test: `test/core/store.test.ts`, `test/core/insights.test.ts`, new `test/core/label.test.ts`, new `test/core/source.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export type Source = "copilot" | "claude-code" | "codex";
  export const SOURCES: readonly Source[] = ["copilot", "claude-code", "codex"];
  export const SOURCE_LABEL: Record<Source, string> = { copilot: "Copilot", "claude-code": "Claude Code", codex: "Codex" };
  export function isSource(x: unknown): x is Source;
  // UsageRecord: + source: Source (required); keySource: "usageId" | "eventId" | "shutdown" | "claudeMessageId" | "claudeRequestId" | "codexResponseId" | "codexTotal"
  // Counts: + sources?: Partial<Record<Source, number>>        (records per source)
  // Totals: + bySource?: Partial<Record<Source, Counts>>
  // Filter: + source?: Source
  // GroupSummary, ToolSummary: + sources?: Partial<Record<Source, number>>
  // SessionSummary: + source?: Source      (the first record's)
  // Snapshot.sessions[]: + source?: Source; Snapshot.current: + source?: Source
  export type SourceState = "ok" | "no-data" | "no-dir" | "permission" | "off" | "format-changed";
  export interface SourceHealth { state: SourceState; rootSource: "setting" | "env" | "default"; files: number; sessions: number; unreadableFiles: number; unrecognized: number; malformed: number; overlong: number; overlongOther: number; capped?: number; archived?: number }
  // Health: + sources?: Partial<Record<Source, SourceHealth>>; + reading?: { done: number; total: number }
  ```
- Produces (store.ts): `entryKey` = `${kind}|${source}|${key}`; `accumulate` fills `c.sources` and counts `nanoAiu`/`callNanoAiu` only for `source === "copilot"`; `totals()`/`totalsByBucket()` fill `bySource`; `add(r, file): boolean` merges a same-file repeat (D42: tokens, timestampMs, model, finishReason, sequence, durationMs, nanoAiu, typeCost, initiator, toolTokens, availableTools from the new record; `tools` counts summed per name, at most 64 names) and returns `true` when anything changed; `export const BUILT_IN_TOOLS: Record<Source, ReadonlySet<string>>` (Copilot's set as today; Claude Code's per spec D52; Codex empty); `toolSummaries` sets `builtIn` when any using source's set has the name and fills `sources`; `projectSummaries`, `recentProjects` fill `sources`; `sessionSummaries` sets `source`; `dailyActivity` counts `nanoAiu` for Copilot records only.
- Produces (insights.ts): `promptConventions(records)` considers Copilot records only; `promptTokens(r, convention)` and `store.promptOf(r, conventions)` return `r.tokens.input` for every non-Copilot record.
- Produces (label.ts):
  ```ts
  export const FOLDER_NAME = /^[A-Za-z0-9 ._@+-]{1,80}$/;
  /** Last segment of a POSIX or Windows path after a trailing /.claude/worktrees/<x> or /.worktrees/<x> is removed; undefined when it is empty, ".", ".." or fails FOLDER_NAME. Never returns the path. */
  export function folderLabel(path: string): string | undefined;
  ```
- Produces (source.ts):
  ```ts
  import type { ReadErrorCode } from "./tailer";
  export const RECENT_MS = 300_000;
  export interface SourceFile { path: string; mtimeMs: number; size: number }
  export interface SourceCandidate { source: Source; sessionId: string; folderId: string; files: SourceFile[]; mtimeMs: number; live: boolean }
  export interface SourceUnreadable { folderId: string; path: string; code: string }
  export type SourceDiscoverResult =
    | { ok: true; candidates: SourceCandidate[]; unreadable: SourceUnreadable[]; dirMtimeMs: number; capped?: number; archived?: number }
    | { ok: false; error: "no-dir" | "permission" | "OTHER" };
  export interface FileReadResult {
    reset: boolean; error?: ReadErrorCode;
    records: UsageRecord[];            // call records (same-file repeats are merged by the store)
    totals?: UsageRecord[];            // the file's session totals, last line wins; undefined = none in this read
    label?: string;                    // project key (D44), once known
    title?: string | null;             // Copilot only: workspace.yaml title; null clears
    activity: number; suspect: number; unrecognized: number; malformed: number; overlong: number; overlongOther: number;
    shutdownOversize: number; hasTotals: boolean; usage: number;
  }
  export interface FileReader { read(): Promise<FileReadResult> }
  export interface SourceReader {
    readonly source: Source; readonly root: string; readonly rootSource: "setting" | "env" | "default";
    rootDirMtime(): Promise<number | undefined>;
    discover(windowStartMs: number, dayStartMs: number, nowMs: number): Promise<SourceDiscoverResult>;
    pathAllowed(path: string): boolean;
    open(path: string, c: SourceCandidate): FileReader;
  }
  export function emptyReadResult(): FileReadResult;
  ```

- [ ] **Step 1: Write failing tests** in `test/core/store.test.ts`: store keys are namespaced (a `copilot` record and a `claude-code` record with key `k` both count); same-file repeat replaces tokens and sums tools and returns true; a cross-file repeat returns false and keeps the first; `nanoAiu.missing` stays 0 when only Claude Code records lack AIU, and bumps for a Copilot session total without AIU; `bySource` and `sources` are filled; `toolSummaries` marks `Read` built-in for Claude Code and `bash` for Copilot. In `test/core/insights.test.ts`: a Claude Code record with input 100, cacheRead 100,000, cacheWrite 5,000 gives prompt tokens 100 (included convention) and uncached input = 100 − 100,000 − 5,000 is NOT used — assert `promptOf` returns 100 and that `promptConventions` ignores the record. In `test/core/label.test.ts`: `folderLabel("/a/b/repo/.claude/worktrees/x")` is `repo`; `folderLabel("C:\\w\\repo\\.worktrees\\y")` is `repo`; `folderLabel("/")`, `folderLabel("/a/..")` undefined; `folderLabel("/a/b/na me")` is `na me`.
- [ ] **Step 2: Run** `npx vitest run test/core/store.test.ts test/core/insights.test.ts test/core/label.test.ts` — expect failures (type errors / missing module).
- [ ] **Step 3: Implement** the types, `label.ts`, `source.ts`, the store and insights changes; add `source: "copilot"` to every record literal in tests and to `test/fixtures/build.ts` helpers that build records (not to log-line builders).
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run` — expect all green (802 + new).
- [ ] **Step 5: Commit** `feat(core): source dimension in records, store and insights; label and source contracts`.

### Task 2: JSON byte scanner

**Files:**
- Create: `src/core/jsonScan.ts`
- Test: `test/core/jsonScan.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_SLICE_BYTES = 4096;
  export const MAX_SCAN_DEPTH = 8;
  /** A path: object keys and "[]" for any array element. */
  export type ScanPath = readonly string[];
  export interface SliceRange { start: number; end: number; /** element index at the first "[]" of the path, when the path has one */ idx?: number }
  export interface ScanResult { ranges: Map<string, SliceRange[]>; complete: boolean }
  /** Walks buf[start, end) once, tracking depth and keys; string bodies are skipped by bytes (on "\\" skip one byte; an unescaped '"' ends the string) and never decoded. Records the byte range of every value at an absolute requested path (key joined by "."). Keys are compared as raw bytes to the ASCII path segments; a key with an escape never matches. Never throws: malformed or truncated input ends the scan with complete=false. */
  export function scanJson(buf: Buffer, start: number, end: number, paths: readonly ScanPath[]): ScanResult;
  /** The one JSON.parse in the new readers: refuses end - start > maxBytes (returns undefined) and returns undefined for invalid JSON. */
  export function parseSlice(buf: Buffer, r: SliceRange, maxBytes?: number): unknown;
  /** The string at a path, when it is exactly one JSON string of at most maxBytes; else undefined. */
  export function stringAt(buf: Buffer, res: ScanResult, path: string, maxBytes?: number): string | undefined;
  ```
- The differential test compares every range's `parseSlice` with the value `JSON.parse(line)` yields at that path.

- [ ] **Step 1: Write failing tests**: top-level scalar, nested object slice, array element pairs (`message.content[].type` and `.name` share `idx`), a key with the same name at depth 2 is not matched for a depth-1 path and vice versa, strings containing `{`, `}`, `"` (escaped), `\\` and `"type":"assistant"` are skipped, a tool-input object holding `"usage":{…}` is not matched for `message.usage`, UTF-8 multibyte text inside strings, a line truncated mid-string returns `complete: false` with earlier ranges intact, deeply nested input beyond `MAX_SCAN_DEPTH` is skipped, `parseSlice` refuses 4,097 bytes, a differential test over 200 random JSON objects (seeded) with the needles inside strings and objects.
- [ ] **Step 2: Run** `npx vitest run test/core/jsonScan.test.ts` — expect failure (module missing).
- [ ] **Step 3: Implement** `scanJson` as a single pass with a frame stack `{ kind: "obj" | "arr"; node: TrieNode | undefined; idx: number; key?: TrieNode | undefined }` over a trie built from `paths`; values outside the trie are skipped by balanced-bracket counting with string skipping. Implement `parseSlice` and `stringAt`.
- [ ] **Step 4: Run** the test file — expect green; run `npx vitest run` for the whole suite.
- [ ] **Step 5: Commit** `feat(core): depth-tracking JSON byte scanner with bounded slice decoding`.

### Task 3: Byte tailer core under the Copilot LineTailer

**Files:**
- Modify: `src/core/tailer.ts`
- Test: `test/core/tailer.test.ts` (existing cases unchanged; add ByteTailer cases)

**Interfaces:**
- Produces:
  ```ts
  export interface LineHandler {
    /** one complete line buf[start, end) without its \n (a trailing \r may be present) */
    line(buf: Buffer, start: number, end: number): void;
    /** a line longer than maxLineBytes: `whole` true when the entire line is in buf[start, end) (it arrived complete), false when only its first headBytes are */
    overlong(buf: Buffer, start: number, end: number, whole: boolean): void;
  }
  export interface ByteTailerOptions { maxLineBytes?: number /* default 1_048_576 */; chunkBytes?: number /* 262_144 */; headBytes?: number /* TYPE_HEAD_BYTES */ }
  export interface ByteTailResult { reset: boolean; error?: ReadErrorCode }
  export class ByteTailer { constructor(path: string, handler: LineHandler, opts?: ByteTailerOptions); read(): Promise<ByteTailResult>; get carryLength(): number }
  // LineTailer keeps its constructor, TailerOptions, TailResult and read() exactly as today, implemented as a ByteTailer plus a Copilot LineHandler.
  ```
- Behaviour kept: O_RDONLY | O_NOFOLLOW | O_NONBLOCK open, regular-file check, cursor `{dev, ino, offset, tail}` reset rules, BOM skip at offset 0, chunked reads, carry cap, skip-until-newline for over-long lines, error mapping to `ReadErrorCode`.

- [ ] **Step 1: Write failing tests** for `ByteTailer`: lines delivered once across two reads split mid-line; `overlong(…, whole=true)` for a long line that arrived in one read, `whole=false` with exactly `headBytes` bytes when it streamed across chunks; reset on truncation re-delivers from offset 0; a FIFO path yields `error: "OTHER"`; `headBytes: 4096` honoured.
- [ ] **Step 2: Run** `npx vitest run test/core/tailer.test.ts` — new cases fail, old pass.
- [ ] **Step 3: Implement** `ByteTailer` by moving the core out of `LineTailer`; re-express `LineTailer` over it (its `gate`/`countOverlong` logic becomes the Copilot handler). Do not change `TailResult`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run` — all green, including the untouched 463-line tailer suite.
- [ ] **Step 5: Commit** `refactor(core): byte tailer core with a line handler; LineTailer unchanged on top`.

### Task 4: Claude Code reader

**Files:**
- Create: `src/core/claude.ts`
- Create: `test/fixtures/claude.ts`
- Test: `test/core/claude.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Source`, `UsageRecord`, `source.ts` contracts, `folderLabel`, `RECENT_MS`), Task 2 (`scanJson`, `parseSlice`, `stringAt`), Task 3 (`ByteTailer`, `LineHandler`). From `extract.ts` import `isSessionId`, and export from `extract.ts` nothing new (use local copies of `MODEL_ID`-shaped and `TOOL_NAME`-shaped regexes if not exported; Task 6 may export them later).
- Produces:
  ```ts
  export const CLAUDE_MAX_LINE_BYTES = 4 * 1024 * 1024;
  export const CLAUDE_HEAD_BYTES = 4096;
  export const CLAUDE_MAX_FILES = 10_000;
  export const CLAUDE_MAX_DEPTH = 6;
  export type ClaudeLineClass = "assistant" | "user" | "skip";
  /** Native needle pre-gate: `"type":"assistant"` anywhere → "assistant"; else `"type":"user"` within the first 256 bytes → "user"; else "skip". No decoding. */
  export function classifyClaudeLine(buf: Buffer, start: number, end: number): ClaudeLineClass;
  export type ClaudeParse =
    | { kind: "usage"; record: UsageRecord; label?: string }
    | { kind: "ignored" }                       // zero usage, or depth-1 type is not "assistant"
    | { kind: "unrecognized"; reason: "no-usage-object" | "no-key" | "bad-timestamp" | "no-known-token-field" | "slice-too-large" }
    | { kind: "malformed" };
  /** Scans the line (Task 2) for exactly the D42 paths and copies the allowlist; `fileSessionId` is the UUID from the file name or parent directory; with `wantLabel` the cwd slice is reduced by folderLabel and dropped. */
  export function parseClaudeLine(buf: Buffer, start: number, end: number, o: { fileSessionId: string; wantLabel: boolean }): ClaudeParse;
  /** "assistant" | "other" from the first CLAUDE_HEAD_BYTES of an over-long line: `"role":"assistant"` inside message → assistant. */
  export function classifyClaudeHead(buf: Buffer, start: number, end: number): "assistant" | "other";
  export function discoverClaude(root: string, windowStartMs: number, dayStartMs: number, nowMs: number): Promise<SourceDiscoverResult>;
  export class ClaudeSourceReader implements SourceReader { constructor(o: { root: string; rootSource: "setting" | "env" | "default"; readProjects: boolean }); … }
  ```
- Discovery: `projects/` entries that are directories; inside each, regular `*.jsonl` files at depth 1 are sessions (`sessionId` = file stem when it matches `SESSION_ID`); directories named by a `SESSION_ID`-shaped id are descended (depth ≤ `CLAUDE_MAX_DEPTH` below `projects/`) and their `*.jsonl` files join that session; other directories (`memory`, `tool-results`, …) are skipped; symlinks skipped; files with `mtimeMs < windowStartMs` skipped; `live` = any file `mtimeMs ≥ max(dayStartMs, nowMs − RECENT_MS)`; `capped` counts files beyond `CLAUDE_MAX_FILES`. `pathAllowed(p)` = regular `.jsonl` under `<root>/projects/`.
- Mapping per D42/D47: `tokens.input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `cacheRead`, `cacheWrite`, `output`, `reasoning = output_tokens_details.thinking_tokens` when present; `finishReason` map `end_turn→stop`, `tool_use→tool_calls`, `max_tokens→length`, `refusal→content_filter`, other string→`other`, null→absent; tools from `message.content[].type == "tool_use"` names; `key = message.id` else `requestId`; `keySource` accordingly; `source: "claude-code"`; `sessionId` = depth-1 `sessionId` if `isSessionId` else `fileSessionId`; `folderId = sessionId`; `kind: "call"`.
- The `FileReader`: a `ByteTailer` with `maxLineBytes: CLAUDE_MAX_LINE_BYTES`, `headBytes: CLAUDE_HEAD_BYTES`; `line` → classify → parse; `user` → `activity++`; `overlong` → `classifyClaudeHead` → `overlong++` or `overlongOther++`; `label` set once from the first usage record's cwd (when `readProjects`).

- [ ] **Step 1: Write `test/fixtures/claude.ts`**: `claudeAssistantLine(o)`, `claudeUserLine(o)`, `claudeOtherLine(type, o)`, `claudeTree(root, sessions: { slug, sessionId, lines, subagents?: { id, lines }[], mtime? })`; every content field (text, thinking, tool_use input, toolUseResult, gitBranch, every cwd segment but the last, the slug) holds `CLAUDE_CANARY = "CLAUDE-CANARY-2b9e"`; key order mirrors real logs (`parentUuid, isSidechain, message, …, type, uuid, timestamp, sessionId, cwd`).
- [ ] **Step 2: Write failing tests** (`test/core/claude.test.ts`): gate classes; a full record with the D47 sums; `<synthetic>` zero usage → ignored; missing usage → unrecognized; a nested `{"type":"assistant","message":{"usage":{…}}}` inside a tool input yields exactly one record from the top level; a user line whose `toolUseResult` holds `"type":"assistant"` yields nothing; `stop_reason` mapping; tool names counted, inputs never read (canary absent from `JSON.stringify(record)`); `cwd` → `folderLabel` with the worktree suffix stripped and `wantLabel:false` yields no label; `sessionId` fallback to the file id; discovery folds `subagents/agent-*.jsonl` and `subagents/workflows/wf_x/agent-*.jsonl` into the parent session, skips `memory/` and symlinks, prunes by mtime, counts `capped`, computes `live`; `pathAllowed` rejects `history.jsonl` at the root and `.json` files; an over-long user line → overlongOther, an over-long assistant line → overlong; a streamed message across two reads produces two `records` entries with the same key (the store merges).
- [ ] **Step 3: Run** `npx vitest run test/core/claude.test.ts` — fails.
- [ ] **Step 4: Implement** `src/core/claude.ts`.
- [ ] **Step 5: Run** `npm run typecheck && npx vitest run` — green.
- [ ] **Step 6: Commit** `feat(core): Claude Code source reader (byte-gated, slice-decoded)`.

### Task 5: Codex reader

**Files:**
- Create: `src/core/codex.ts`
- Create: `test/fixtures/codex.ts`
- Test: `test/core/codex.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 as Task 4 does.
- Produces:
  ```ts
  export const CODEX_MAX_LINE_BYTES = 4 * 1024 * 1024;
  export const CODEX_MAX_TURNS = 1024;
  export type CodexLineClass = "record" | "turn" | "meta" | "event" | "skip";
  export function classifyCodexLine(buf: Buffer, start: number, end: number): CodexLineClass;   // needle pre-gate on the four type names
  export interface CodexFileState { models: Map<string, string>; latestModel?: string; label?: string; sawTurn: boolean }
  export type CodexParse =
    | { kind: "usage"; record: UsageRecord }
    | { kind: "total"; record: UsageRecord }      // from a token_count line (sessionTotal)
    | { kind: "turn" } | { kind: "meta"; label?: string } | { kind: "ignored" }
    | { kind: "unrecognized"; reason: "no-key" | "bad-timestamp" | "no-known-token-field" | "slice-too-large" }
    | { kind: "malformed" };
  export function parseCodexLine(buf: Buffer, start: number, end: number, cls: CodexLineClass, state: CodexFileState, o: { fileSessionId: string; wantLabel: boolean; readTotals: boolean }): CodexParse;
  export function discoverCodex(root: string, windowStartMs: number, dayStartMs: number, nowMs: number): Promise<SourceDiscoverResult>;
  export class CodexSourceReader implements SourceReader { constructor(o: { root: string; rootSource: …; readProjects: boolean; readTotals: boolean }); … }
  ```
- Discovery: `sessions/YYYY/MM/DD` digit directories, descended only when the directory date ≥ the local day of `windowStartMs`; regular files `rollout-*.jsonl`; `sessionId` = the UUID at the end of the file name when it matches `SESSION_ID`, else the file stem; one candidate per file; `live` as in Task 4; `archived` = count of entries in `archived_sessions/` (names only, never opened); `pathAllowed(p)` = regular `.jsonl` under `<root>/sessions/<4 digits>/<2>/<2>/rollout-…`.
- Mapping per D45: `input = input_tokens`, `cacheRead = cached_input_tokens`, `cacheWrite = cache_write_input_tokens`, `output = output_tokens`, `reasoning = reasoning_output_tokens`; `key = response_id`, `keySource "codexResponseId"`, `source: "codex"`, `sessionId = payload.session_id` if `isSessionId` else `fileSessionId`; model from `state.models.get(turn_id) ?? state.latestModel`; a `turn_context` line updates `state` (validated turn ids, cap `CODEX_MAX_TURNS`, `sawTurn = true`); `session_meta` (first only) yields `label` from `payload.cwd` via `folderLabel`; `event_msg` with `payload.type == "token_count"` and `readTotals` yields `{ kind: "total" }` with key `codex-total:<sessionId>`, `keySource "codexTotal"`, `kind: "sessionTotal"`, no `calls`; the reader emits it as `totals` only for a file that has produced no usage record, and a later line replaces an earlier one. `sawTurn` without any record counts as activity for the format-change rule.

- [ ] **Step 1: Write `test/fixtures/codex.ts`**: `codexMeta(o)`, `codexTurn(o)`, `codexRecord(o)`, `codexTokenCount(o)`, `codexOther(type, payloadType, o)`, `codexTree(root, files: { date: "YYYY/MM/DD", sessionId, lines, mtime? }[], archived?: string[])`; `CODEX_CANARY = "CODEX-CANARY-5d1c"` fills `instructions`, `cwd` segments but the last, `git.*`, sandbox paths, `rate_limits.*` (as strings and numbers), `last_token_usage`, content text.
- [ ] **Step 2: Write failing tests**: classes; a record takes the model of its turn id and the latest as fallback; `(unknown model)` before any turn; a token_count-only file yields one total, replaced by a later line, and none once a record exists; `rate_limits` canary absent from every record; `archived` counted, never opened (fs spy); date pruning skips `2025/01/01` for a window starting 2026-10-01 and keeps the window's first day; `pathAllowed` rejects `history.jsonl`, `archived_sessions/x.jsonl`, `sessions/2026/11/08/notes.txt`.
- [ ] **Step 3: Run** `npx vitest run test/core/codex.test.ts` — fails.
- [ ] **Step 4: Implement** `src/core/codex.ts`.
- [ ] **Step 5: Run** `npm run typecheck && npx vitest run` — green.
- [ ] **Step 6: Commit** `feat(core): Codex source reader with per-turn models and session totals`.

### Task 6: Copilot adapter and the folder-name project key

**Files:**
- Create: `src/core/copilot.ts`
- Modify: `src/core/extract.ts` (`parseStartLine` → key + label; use `folderLabel`)
- Modify: `src/core/discover.ts` (no behaviour change; export what the adapter needs)
- Test: `test/core/extract.test.ts` (start-line cases), new `test/core/copilot.test.ts`

**Interfaces:**
- Consumes: Task 1 (`source.ts`, `folderLabel`), Task 3 (`LineTailer` unchanged).
- Produces:
  ```ts
  // extract.ts
  export interface StartLabel { key: string; label?: string }
  /** key: folderLabel(context.gitRoot) ?? folderLabel(context.cwd) ?? repo part of context.repository; label: context.repository when it matches REPO and differs from key. */
  export function parseStartLine(line: string): StartLabel | undefined;
  // copilot.ts
  export class CopilotSourceReader implements SourceReader { constructor(o: { root: string; rootSource: …; readProjects: boolean; readTotals: boolean; isLive?: typeof isLive; parse?: typeof parseUsageLine }); … }
  ```
- `CopilotSourceReader.discover` wraps `discover(root, windowStartMs, isLive, dayStartMs)` into `SourceCandidate`s (one file each; `sessionId = folderId`); `open` returns a `FileReader` over `LineTailer` that runs today's `monitor.readFile` logic: usage lines → `parseUsageLine` (set `source: "copilot"`), shutdown lines → `parseShutdownLine` → `totals`, start lines → `label` (and the `owner/repo` display label is carried as `title` only when the key differs; see D44), the `workspace.yaml` title logic (`readTitle`/`readBoundedTitle` moved here) → `title`, counters mapped 1:1.
- `parseUsageLine` and `parseShutdownLine` set `source: "copilot"` on every record (required field from Task 1).

- [ ] **Step 1: Write failing tests**: `parseStartLine` with gitRoot `/x/repo/.claude/worktrees/f` and repository `o/repo` → `{ key: "repo", label: "o/repo" }`; cwd only → key; repository only → `{ key: "repo", label: "o/repo" }`; `copilot.test.ts`: one fixture session read through the adapter yields the same records, totals, label and counters as the pre-refactor monitor (compare against `parseUsageLine` directly), `pathAllowed` accepts only `<root>/session-state/<id>/events.jsonl`.
- [ ] **Step 2: Run** the two test files — fail.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run` — green (update the start-line expectations in existing tests).
- [ ] **Step 5: Commit** `refactor(core): Copilot source reader; projects keyed by folder name with owner/repo as label`.

### Task 7: Settings, manifest, config resolution, walkthrough

**Files:**
- Modify: `src/core/config.ts`
- Modify: `package.json` (`contributes.configuration`, `description`, `keywords`, walkthrough step 1 text)
- Modify: `media/walkthrough/folder.md`
- Test: `test/core/config.test.ts`, `test/core/gates.test.ts` (manifest cases only)

**Interfaces:**
- Produces (config.ts):
  ```ts
  export type RootKind = "copilot" | "claude" | "codex";
  export interface ResolvedRoot { root: string; source: "setting" | "env" | "default" }
  /** copilot: setting → COPILOT_HOME → ~/.copilot; claude: setting → CLAUDE_CONFIG_DIR → ~/.claude; codex: setting → CODEX_HOME → ~/.codex. Same tilde/relative/non-string rules as today. */
  export function resolveRoot(kind: RootKind, o: { setting?: unknown; env: Record<string, string | undefined>; homedir: string }): ResolvedRoot;
  export const resolveCopilotRoot = …;   // kept as a thin alias for existing callers/tests
  ```
- Manifest: `copilotUsageMonitor.claudeCode` (boolean, default true, scope machine), `copilotUsageMonitor.codex` (boolean, default true, scope machine), `copilotUsageMonitor.claudeHome` (string, default "", scope machine), `copilotUsageMonitor.codexHome` (string, default "", scope machine), descriptions per spec D48 and the copy rule; `description` per D51; keywords add `claude`, `codex`; walkthrough step `folder` title "Check that your usage logs are found", description naming the three folders and settings; `folder.md` keeps the sentence "the folder in `copilotUsageMonitor.copilotHome`, else `COPILOT_HOME`, else `~/.copilot`" and adds the Claude Code and Codex equivalents (under 2048 chars, no links).
- Gates: extend "manifest scopes" to the four new keys; add a case that the two booleans default to `true` and the two strings to `""`; the copy gate already covers all property descriptions.

- [ ] **Step 1: Write failing tests** (config: `resolveRoot("claude", …)` precedence and `~` expansion; gates: the manifest cases).
- [ ] **Step 2: Run** `npx vitest run test/core/config.test.ts test/core/gates.test.ts` — fail.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run` — green.
- [ ] **Step 5: Commit** `feat: settings and manifest for Claude Code and Codex sources`.

### Task 8: Multi-source monitor with hot and cold polling

**Files:**
- Modify: `src/core/monitor.ts`
- Test: `test/core/monitor.test.ts` (existing cases green), new `test/core/monitorSources.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 6.
- Produces:
  ```ts
  export interface MonitorOptions {
    root: string; rootSource: Health["rootSource"];                       // Copilot, always on
    sources?: { claude?: { root: string; rootSource: Health["rootSource"] }; codex?: { root: string; rootSource: Health["rootSource"] } };
    now?: () => Date; isLive?: typeof realIsLive; parse?: typeof parseUsageLine; log: Logger; onSnapshot: (s: Snapshot) => void;
    historyMonths?: number; readProjects?: boolean; readTotals?: boolean;
    /** test hook: replaces the readers built from root/sources */ readers?: SourceReader[];
  }
  export const RECENT_MS (re-exported from source.ts);
  // UsageMonitor API unchanged: refresh({full}), pin, selectMonth, selectSession, setFilter (now honours filter.source), dispose.
  ```
- Behaviour: one `FileState` per path `{ source, sessionId, folderId, reader: FileReader, primed, counters…, label?, title?, lastMtimeMs, lastSize, hot }`; discovery per enabled reader every `REDISCOVER_MS` or when any `rootDirMtime()` changed; a tick reads a file when `hot` (its candidate `mtimeMs ≥ now − RECENT_MS`) or when discovery saw a new mtime/size, or when not yet primed; Copilot files are always read each tick (today's behaviour); first read of the window processes candidates newest first and emits a snapshot at most every 500 ms with `health.reading = { done, total }` until every file is primed; `health.sources` per enabled source with the D49 state rules and counters; global `health.state` per D49; `partial` unchanged in meaning (sums); `current` per D43 (PID-live Copilot, then mtime-live, then newest today) with `source`; `sessions[]` carry `source`; the `source` filter joins `keep`; `projectOf(r)` reads the file label as today, and Copilot `owner/repo` display labels flow through the existing `titles` mechanism; `byProject`, `byTool`, `bySource` filters apply to history, month view, projects and tools as the project/tool filters do today (the source filter applies everywhere the project filter does).
- Keep `clampHistory`, `SESSION_ROWS`, `MAX_HISTORY_MONTHS` exports.

- [ ] **Step 1: Write failing tests** in `test/core/monitorSources.test.ts` using the three fixture trees: a Copilot-only machine (new roots absent) yields identical `today`, `month`, `history` to a monitor without `sources` and `health.sources["claude-code"].state === "no-dir"`; three sources together: `today.bySource` sums per source, `sources` counts on `byModel` entries, `setFilter({ source: "codex" })` narrows `month.totals` and `month.projects`; a Claude Code streamed message across two refreshes counts once with the last usage; a subagent file's records join the parent session in `month.sessions`; `current` prefers a PID-live Copilot session over an mtime-live Claude session and reports `source`; fs-spy with `vi.spyOn(fs.promises, "open")`: after priming, 20 idle refreshes open only the hot Claude file (mtime now) and the Copilot files, never the 50 cold Claude files; a cold file edited (mtime bumped) is re-read after the next discovery; `health.reading` is set during the first read of 200 files and absent after; `health.state` is `no-dir` only when all three roots are missing; `source: "x"` is ignored by `setFilter`.
- [ ] **Step 2: Run** `npx vitest run test/core/monitorSources.test.ts` — fail.
- [ ] **Step 3: Implement** the refactor.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run` — green including the existing 939-line monitor suite.
- [ ] **Step 5: Commit** `feat(core): multi-source monitor with hot/cold polling and per-source health`.

### Task 9: Source in the panel, side bar and status bar

**Files:**
- Modify: `src/core/format.ts` (`LOCAL_BANNER`, `costNotes`, `statusText`/`statusAccessibilityLabel` no-dir wording, `tooltipMarkdown` per-source lines, `healthLines`)
- Create: `src/core/panel/sources.ts` (By source card, Sources health box, `sourceChip(sources)` helper, `sourceFilterChip`)
- Modify: `src/core/panel/overview.ts`, `models.ts`, `projects.ts`, `sessions.ts`, `tools.ts`, `health.ts`, `chrome.ts` (filter chip, folder chip, "Reading history (n of N files)…"), `insights.ts` (footer), `links.ts` (`filterHref` kind `"source"`), `panelCss.ts` (chips, card), `panelHtml.ts` (exports)
- Modify: `src/core/sidebarModel.ts` (group `"sources"`, notices, `SidebarGroup.id` union), `src/core/sidebarHtml.ts` if needed
- Test: `test/core/format.test.ts`, `test/core/panelHtml.test.ts`, new `test/core/panelSources.test.ts`, `test/core/sidebarModel.test.ts`

**Interfaces:**
- Consumes: Task 1 types only (build snapshots by hand in tests).
- Produces: `filterHref("source", value)`; `renderSourcesCard(s, view): string`; `sourcesHealthBox(s): string`; `sourceChips(sources: Partial<Record<Source, number>> | undefined): string` (one chip per source present, in `SOURCES` order, label from `SOURCE_LABEL`, class `src-<source>`); side bar group id `"sources"` with rows `sources/<i>` linking `setFilter("source", id, "overview")`; `COST_SOURCES_NOTE = "USD (est.) covers Copilot only: Claude Code and Codex log no cost; their figures are tokens."`; `INSIGHTS_SOURCES_NOTE = "Insights use Copilot's logged AI credits; Claude Code and Codex calls are not examined."`; `LOCAL_BANNER` per D49; status bar no-dir text `"$(circle-slash) Local: no usage logs found"` and spoken `"No usage logs found. Opens details."`.
- Rules: notes and chips appear only when a non-Copilot source has records in scope (`totals.sources` has a key other than `copilot`) or, for health rows, when the source is enabled; "idle" instead of "ended" when `current.source !== "copilot"`; `health.reading` renders the loading line; every string obeys the copy gate.

- [ ] **Step 1: Write failing tests**: the By source card lists sources in `SOURCES` order with "—" USD for Claude Code; the Models row for a model used by two sources shows two chips; the source filter chip and its clear link; Sources health box rows for off / no-dir / ok with counters; `tooltipMarkdown` adds per-source lines only when two sources have records today; `statusText` no-dir wording; `costNotes` includes `COST_SOURCES_NOTE` only when a non-Copilot source is in scope; side bar group present only when a non-Copilot source is enabled and found, rows link to `setFilter("source", …)`; `LOCAL_BANNER` appears in README (keep the gate green by updating README's "What this is not" in Task 11 — in this task assert only the constant).
- [ ] **Step 2: Run** the test files — fail.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run` — green except the README gate, which Task 11 fixes (if the gate fails here, update the README's "What this is not" paragraph to the new `LOCAL_BANNER` in this task).
- [ ] **Step 5: Commit** `feat(ui): source filter, By source card, source chips, per-source Data health, side bar group`.

### Task 10: Extension wiring and integration test

**Files:**
- Modify: `src/extension.ts`
- Modify: `.vscode-test.mjs` (env `CLAUDE_CONFIG_DIR`, `CODEX_HOME` → fixture roots)
- Modify: `test/integration/extension.test.ts`
- Test: `test/core/extensionLifecycle.test.ts`

**Interfaces:**
- Consumes: Task 7 (`resolveRoot`), Task 8 (`MonitorOptions.sources`).
- Behaviour: `start()` resolves the Copilot root and, when `copilotUsageMonitor.claudeCode` / `codex` are not `false`, the Claude Code and Codex roots, and passes `sources`; `rootKey` covers all three; `onDidChangeConfiguration` restarts on `claudeCode`, `codex`, `claudeHome`, `codexHome`; the `setFilter` command accepts kind `"source"` with a value validated by `isSource` (`""` clears); the filter quick pick lists the three sources (label from `SOURCE_LABEL`, description `source · <calls>`); the `pinSession` items show `SOURCE_LABEL[x.source]` in the description; nothing else changes.
- Integration: seed one Claude Code session and one Codex session beside the Copilot fixtures; assert the side bar `sources` group rows, the status bar text unchanged in tokens view, the By source card in the panel HTML (via `_testState.snapshot.today.bySource`), and that turning `copilotUsageMonitor.codex` off removes Codex records within one poll.

- [ ] **Step 1: Write failing tests** (lifecycle: a config change of `claudeCode` restarts the monitor exactly once; `setFilter("source", "codex")` sets `snapshot.filter.source`; `setFilter("source", "nope")` is ignored).
- [ ] **Step 2: Run** `npx vitest run test/core/extensionLifecycle.test.ts` — fail.
- [ ] **Step 3: Implement**; then `npm run test:integration` (~35 s; VS Code 1.90 cached in `.vscode-test/`).
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run test:integration` — green.
- [ ] **Step 5: Commit** `feat: wire Claude Code and Codex sources into the extension`.

### Task 11: Docs, schema, probes, version 0.8.0

**Files:**
- Modify: `README.md`, `docs/SCHEMA.md`, `CHANGELOG.md`, `package.json` (`version`, scripts `probe:claude`, `probe:codex`), `.github/ISSUE_TEMPLATE/bug_report.md`
- Create: `tools/claude-schema-probe.mjs`, `tools/codex-schema-probe.mjs`
- Test: `test/core/gates.test.ts` ("README copy check", "README and walkthrough facts" stay green)

- README per spec D53: "What it reads" per source (files opened, line filtering, fields kept, never read; "No Claude Code or Codex line is ever decoded whole"), settings table rows for the four settings, "What this is not" quoting the new `LOCAL_BANNER` verbatim and listing other computers, Claude.ai and ChatGPT web usage, Codex archived sessions, Agent SDK apps counting as Claude Code, the same-name-folder caveat, the first-scan note and the 30-day cleanup note, "Not affiliated with, endorsed by or supported by GitHub, Microsoft, Anthropic or OpenAI.", `.vsix` name with 0.8.0. SCHEMA.md: "Claude Code log schema" and "Codex log schema" sections (facts from the spec, dated 2026-11-08), the token convention note, the never-read lists, the unverified items (token_count-only files, cache writes in input, archived plain `.jsonl`). CHANGELOG `## 0.8.0 - 2026-11-08` with Added / Changed (project key by folder name; USD covers Copilot only; banner wording) / Fixed sections. Probes: shape-only, same rules as `tools/schema-probe.mjs` (key paths, types, counts, lengths, masked shapes; never a value, name or path; abort on `/` in output).

- [ ] **Step 1: Run** `npx vitest run test/core/gates.test.ts` — note the current state.
- [ ] **Step 2: Write** the documents, probes, version bump; `npm run probe:claude` and `npm run probe:codex` run against synthetic trees made in `os.tmpdir()` and print no path.
- [ ] **Step 3: Run** `npm run typecheck && npx vitest run && npm run build` — green; `npx vsce ls --no-dependencies` lists only the allowed files.
- [ ] **Step 4: Commit** `docs: README, schema and changelog for 0.8.0; shape-only probes for Claude Code and Codex`.

### Task 12: Privacy gates, canary end-to-end, performance budget

**Files:**
- Modify: `test/core/gates.test.ts` (privacy gates), `test/core/perf.test.ts`
- Create: `test/core/sourcesCanary.test.ts`

- Gates: `JSON.parse(` count is exactly 1 in `src/core/jsonScan.ts` and 0 in `src/core/claude.ts` and `src/core/codex.ts`; `parseSlice` enforces `end - start <= maxBytes`; the strings `auth.json`, `history.jsonl`, `rate_limits`, `settings.json` occur in `src/` only inside comments or deny-list arrays (assert the lines containing them start with `//`, `*` or are inside a `NEVER_READ` constant); `pathAllowed(` is called in `src/core/monitor.ts` before any `open(`; the bundle still has exactly one `fetch(`; the `.vsix` list is unchanged.
- Canary end-to-end: a monitor over all three fixture trees (Copilot `CANARY`, `CLAUDE_CANARY`, `CODEX_CANARY`) renders panel HTML for every section, side bar HTML, tooltip markdown and the status text; none contains any canary; the log sink lines never contain a path or canary; with `readProjects: false` no label is produced for the new sources.
- Perf (`PERF=1`): a synthetic Claude-shaped corpus (3,000 files, ≥ 200 MB, 1 % assistant lines, content lines of `CLAUDE_CANARY`) cold scans in < 1 s per 100 MB; steady tick with one hot file < 50 ms; idle poll < 5 ms CPU; heap growth < 64 MB for 100,000 records.

- [ ] **Step 1: Write the tests** — the gates may already pass; the canary and perf tests must run.
- [ ] **Step 2: Run** `npx vitest run test/core/gates.test.ts test/core/sourcesCanary.test.ts` and `npm run test:perf` — green; if a budget fails, fix the reader or monitor (not the budget) and record why in the commit.
- [ ] **Step 3: Commit** `test: privacy gates, canary end-to-end and performance budgets for the new sources`.

---

## Waves (the lead dispatches these in parallel; file ownership is disjoint within a wave)

- Wave 1: Task 1, Task 2, Task 3.
- Wave 2: Task 4, Task 5, Task 6, Task 7, Task 9.
- Wave 3: Task 8.
- Wave 4: Task 10, Task 11, Task 12.
- Wave 5: independent reviews (parsing and privacy; store and monitor; UI and copy; docs and gates; end-to-end in VS Code), fixers on disjoint files, a final whole-branch review, then PR and merge.
