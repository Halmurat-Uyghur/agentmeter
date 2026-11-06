# Copilot Usage Monitor (VS Code extension) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension that shows *your own* GitHub Copilot usage, as observed in local Copilot session logs on this computer, in a status-bar item and a details panel, for the current session and for today, with a per-model breakdown.

**Architecture:** A pure-TypeScript core (buffer-level line gate → incremental tailer → allowlist extractor → deduplicating in-memory store → formatter and panel HTML) with no VS Code dependency, wrapped by a thin VS Code layer (poll timer, status bar, webview, output channel). Nothing is persisted and nothing leaves the machine: on every start the extension rescans today's logs.

**Tech Stack:** TypeScript (strict), Node `fs` only at runtime (zero runtime dependencies), esbuild bundle, Vitest for the core, `@vscode/test-cli` + `@vscode/test-electron` (Mocha) for extension-host tests, `@vscode/vsce` to build a local `.vsix`.

**Spec:** the owner's brief (§1) plus the verified schema (§3). §1–§5 are the spec; there is no separate design document.

**Amendment A (2026-11-05):** §13 adds an optional, off-by-default second source (VS Code Copilot Chat `debug-logs`), its probe findings, Task 10 and decisions D13–D19.

**Status (2026-11-05, v0.1.0):** Tasks 0–9 and 8a implemented and merged to `main`. The owner made the extension free and delegated the remaining decisions; they were settled after an independent second-opinion review (§11 D8, §13.4). Task 10 is deferred to v0.2, blocked on its Step 1 re-probe.

**Revision 2 (2026-11-05):** revised after four independent reviews (two Fable 5.1, two Opus 5.5). Changes: corrected §3 counts (4 of 39 logs have per-call records, not 13); stale-lock liveness rule; multi-file dedupe; `partial` health flag; buffer-level gate in the tailer; poll-only change detection; `vscode`-free core for panel HTML and logging; build/test plumbing; tighter model-id and Markdown handling; wider network/persistence gates; D7–D9.

---

## 1. Requirements

| ID | Requirement |
|---|---|
| R1 | Watch local Copilot session logs; update a status-bar indicator and a details panel. |
| R2 | Show usage for the **current session** and **today**, with a **per-model breakdown** where the data has a model. |
| R3 | Update within **2 seconds** of a complete usage event being written, under normal local conditions. |
| R4 | No billing API, no admin credentials, no backend service, no external telemetry. No network calls at all. |
| R5 | Read only the files needed; extract only allowlisted usage fields; never store or transmit prompts, source code, raw events or credentials. Tests use synthetic fixtures only. |
| R6 | Label every total as *locally observed*; never claim it is the official bill, remaining allowance, or activity from other devices or unsupported Copilot clients. |
| R7 | Handle incomplete lines, new sessions, rotation/truncation, restarts, duplicate events, missing fields, permission errors, and event-format changes. **Never show missing data as zero.** |
| R8 | Find the Copilot folder from `COPILOT_HOME`, otherwise `~/.copilot`. No hardcoded user name or path. |

**Non-goals (MVP):** official billing or remaining-allowance figures; org/enterprise usage; other devices; Copilot features that do not write `session-state/*/events.jsonl` (§5 A2); history before the first day of the current month (D10); usage from pre-1.0.99 sessions (D3); script-driven charts or filters (the Task 8a heatmap is static HTML/CSS); persistence; Marketplace publishing.

**Anti-goals (a failure even if it "works"):** a `0` shown where the log had no value; a total shown without a mark when some data could not be read; any prompt, code, file path from an event body, or raw event text kept beyond one line's parse, or written to a log, the UI or disk; any network request; wording a manager or finance person could read as "the bill" or "what's left".

### What "near real time" means here (R3)

In the current log format Copilot writes **one `session.usage_record` per assistant turn, after that turn's model call completes** (verified order: `assistant.turn_start` → `session.usage_record` → `assistant.turn_end`). The extension shows it within 2 s of that line being fully written (newline included). It does **not** stream tokens while a reply is generated: a long agent task appears as a sequence of steps, one per model call. The panel says this in one sentence (`STREAMING_NOTE`).

---

## 2. Global Constraints

- Root folder: setting `copilotUsageMonitor.copilotHome` (`"scope": "machine"`, so a repository's `.vscode/settings.json` cannot redirect it; non-empty → used, `~` expanded) → env `COPILOT_HOME` → `os.homedir() + "/.copilot"`. Relative values resolve against the home folder. Logs: `<root>/session-state/<folder-id>/events.jsonl`.
- Engine `"vscode": "^1.90.0"`; `@types/vscode` pinned to `1.90.0`. Activation `onStartupFinished`.
- Runtime dependencies: **none** (`"dependencies": {}`). Dev dependencies installed with `npm install -E -D`, lockfile committed.
- Forbidden in `src/` (Task 9 gate): `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `child_process`, `worker_threads`, `cluster`, `process.binding`, dynamic `require(` with a non-literal argument, `fetch(`, `XMLHttpRequest`, `WebSocket`, `createTelemetryLogger`, `openExternal`, `asExternalUri`, `globalState`, `workspaceState`, `secrets`, `writeFile`, `appendFile`, `createWriteStream`, `console.`.
- Banner, used verbatim in the tooltip, panel and README (`LOCAL_BANNER`):
  > "Locally observed from Copilot session logs on this computer. Not your GitHub bill, not your remaining allowance, and not usage from other devices or Copilot features that don't write these logs."
- Status bar always says **"Local"**. Missing value: `—`. A value or total that may be incomplete: suffix `*` and a sentence saying why. Never `0` unless every contributing record reported a literal `0` (real zeros exist in the logs).
- Status-bar figure: `tok` = input + output tokens. AIU appears **only in the panel** (D2), as `totalNanoAiu / 1e9`, labelled **"AIU (as logged)"**. Never the words "credits", "cost", "spend", "premium", "$", "%", "remaining", "quota", "limit".
- Day boundary: local midnight in the extension host's time zone, computed as `new Date(y, m, d)`; next midnight as `new Date(y, m, d + 1)` (never `+ 24h`). A record belongs to the local day of its event `timestamp`.
- Conventional Commits; no `Co-Authored-By` lines.

## 3. Verified log schema (2026-11-05, shape-only inspection, re-checked by an independent reviewer)

Inspected on a development machine with scripts that print only key paths, value types, counts, sizes and an allowlist of short enum values. Nothing from the logs is in this repo. **Re-run `npm run probe` on the machine the extension will actually run on (D6) before relying on this section.**

**Layout.** `~/.copilot/session-state/` holds about 125 session folders plus `.session-operation-locks/`; **only 39 have `events.jsonl`** (others hold `workspace.yaml`, `session.db`, `checkpoints/`, etc.). Logs are 1.6 KB – 3.5 MB (median 160 KB); the longest line of any type is ~210 KB; the longest usage line is ~3 KB. All 4,747 lines: newline-terminated, LF only, valid JSON, start with the bytes `{"type":"`, timestamps in file order, no duplicate `id`s.

**`inuse.<pid>.lock` files are not reliable liveness signals.** All 10 lock files found belong to dead processes (9–143 days old). Liveness must check the PID (§6 Task 6).

**Envelope:** `{ type: string, id: string, parentId: string | null, timestamp: "YYYY-MM-DDTHH:MM:SS.sssZ", data: object, agentId?: string }` (`agentId` on sub-agent events; never on a usage record).

**Format generations** (`session.start.data.copilotVersion`; producer always `copilot-agent`):

| Copilot version | Per-call `session.usage_record` | `session.usage_checkpoint` | `session.shutdown` totals |
|---|---|---|---|
| 1.0.43 – 1.0.85 | no | some (1.0.80+) | yes (`modelMetrics.<model>.usage.*`) |
| 1.0.99-2, 1.0.100-1 (current) | **yes** (one per assistant turn) | yes | yes |
| `0.0.0` / unknown (dev builds, crashed sessions) | no | some | some |

**Only 4 of 39 logs (46 records) have `session.usage_record`.** 35 of 39 logs predate it. The format changed once in five months; plan for it to change again.

**`session.usage_record` → `data.usage`** (allowlisted fields in bold; every one present with the stated type in 46 of 46 records):
**`model`** (str), **`inputTokens`**, **`outputTokens`**, **`cacheReadTokens`**, **`cacheWriteTokens`**, **`reasoningTokens`** (int ≥ 0; real zeros occur), **`duration`** (int, ms), **`copilotUsage.totalNanoAiu`** (int), **`accounting.usageId`** (str, 46 distinct of 46), **`accounting.sequence`** (int, strictly increasing and gap-free per source session, including across `session.resume`), **`accounting.sourceSessionId`** (str, equal to the folder id in 46 of 46).
Present but deliberately **not read**: `modelDisplayName`, `cost` (meaning undocumented), `aiCreditsStatus` (reads like allowance data), `copilotUsage.tokenDetails[]`, `initiator`, `isByok`, `provider.*`, `apiEndpoint`, request ids, latencies, byte counts, `toolCounts.*`, cache expiry fields.

**Gate safety:** the substring `"session.usage_record"` and `"assistant.turn_end"` occur in 0 lines of any other type.

**Never read:** `user.message`, `assistant.message`, `tool.*`, `hook.*`, `system.message`, `session.start.data.context` (cwd, repository, branch, commits), `codeChanges.filesModified`, `session.db`, `workspace.yaml`, `vscode.metadata.json`, `config.json`, `mcp-config.json`, `run/ws.token`, or any other file under the Copilot folder.

## 4. Privacy boundary

- **Opened:** `events.jsonl` files of candidate sessions (§6 Task 6) only. The only other file-system calls are `readdir`/`lstat` on `session-state/` and its folders (names and metadata, no contents). Pinned by a test that spies on `fs` (Task 7).
- **Bytes in memory:** the tailer reads chunks into a `Buffer`, finds each `\n`, and checks the line's first bytes **on the buffer** (`classifyLine`, Task 2). Only lines classified `usage` are decoded to a string and `JSON.parse`d; `activity` lines are counted and dropped without decoding; everything else is skipped without decoding. The partial-line carry is the only raw data retained between reads, capped at 1 MiB; an over-long line is discarded and the tailer resyncs at the next `\n`. Since v0.4 (D29), bounded `session.shutdown` lines (at most 64 KiB) are decoded too: the line is decoded whole and `JSON.parse`'s reviver removes the content-bearing keys (`filesModified`, `accountingSnapshot`, `agentMetrics`, `providerModelMetrics`, `usageAccountingWatermarks`, `currentModel`) during parsing, so they are never copied; only the allowlist in §16 is kept.
- **Kept:** `UsageRecord`s (numbers, model id, timestamp, dedupe key, session ids) and per-file cursors and counters, in memory only. No `globalState`, files or caches.
- **Logged:** the Output channel "Copilot Usage Monitor" (VS Code writes Output channels to its own log folder on disk) gets counts, error codes, `rootSource` and timings only — never line content, field values, the root path, or `Error.message`/stack (parse errors quote their input). All `refresh()` work runs inside a top-level catch that logs only an error code, so nothing propagates to the extension-host log.
- **Sent:** nothing (Task 9 gate).
- **Shown:** the `model` id is accepted only if it matches `/^[A-Za-z0-9._:\/-]{1,100}$/`; otherwise the record counts under "(unknown model)". Tooltips are `MarkdownString` with `isTrusted: false`, `supportHtml: false`, and model ids escaped. The webview has scripts disabled and all dynamic text HTML-escaped.
- **Tests:** synthetic fixtures only (`test/fixtures/build.ts`). Every content-bearing fixture field holds `SYNTHETIC-CANARY-7f3a`; tests assert the canary never reaches a snapshot, tooltip, panel HTML, or log sink. The dev-only schema probe prints key paths and allowlisted enums only, skips the `context` and `codeChanges` subtrees, masks UUID-shaped keys, and aborts if any printed token contains `/`.

## 5. Assumptions and limitations

- **A1 — Undocumented format.** `events.jsonl` is internal to the Copilot agent/CLI, not a public API; any field can change in an update. Unknown shapes raise the `format-changed` state instead of producing smaller numbers.
- **A2 — Coverage.** Only Copilot clients that write `session-state/*/events.jsonl` (the Copilot CLI / coding agent, including agent sessions started from VS Code) are covered. Inline completions, Copilot Chat surfaces that do not write these logs, github.com, mobile, JetBrains (`~/.copilot/jb/`, a different format), and other machines are not. The panel lists this.
- **A3 — Older clients.** Sessions from Copilot before 1.0.99 have no per-call records; they are counted as "sessions without per-call data", not added to totals (D3). Until Copilot on the target machine is 1.0.99+, the status bar may show `—` every day (D9).
- **A4 — Current session.** VS Code does not tell an extension which Copilot session belongs to its window. "Current" = the live session (Task 6) with the newest usage record; if none is live, the session with the newest usage record today, labelled "(ended)". The user can pin one. `current` is keyed by **folder id**; records belong to a folder via `sessionId = accounting.sourceSessionId ?? folderId` (equal in all observed data).
- **A5 — Day and clock.** "Today" is local; GitHub's billing day may be UTC. Stated in the panel's limitations list.
- **A6 — Sub-agents (unverified assumption).** No observed usage record came from a sub-agent and `sourceSessionId` always equals the folder. If records are ever copied into a parent log, global dedupe by `usageId` counts them once. Records without `usageId` fall back to the event `id`; a copy of such a record would be counted twice (accepted limitation).
- **A7 — Latency conditions.** Local disk, host awake, ≤ ~300 session folders. Change detection is a 500 ms `stat` poll, which works on every file system.
- **A8 — Managed device.** The target may be an employer-managed machine where Copilot runs. Installing a locally built `.vsix` there may be governed by the employer's policy (D6).

---

## 6. File structure

```
copilot-usage-monitor/
  package.json  package-lock.json  LICENSE  README.md
  tsconfig.json            # src → bundled by esbuild (noEmit for type-check)
  tsconfig.test.json       # test/integration → out/ (CommonJS) for Mocha
  esbuild.mjs              # src/extension.ts → dist/extension.js; --platform=node --format=cjs --external:vscode
  vitest.config.ts         # include test/core/**; exclude test/integration/**; env TZ=America/Toronto
  .vscode-test.mjs         # files: out/test/integration/**/*.test.js; env COPILOT_HOME=<fixture root>
  .vscodeignore  .gitignore
  src/
    core/
      types.ts        # Tokens, UsageRecord, ParseResult, Metric, Totals, Health, Snapshot
      config.ts       # resolveCopilotRoot()
      extract.ts      # classifyLine() (Buffer gate) + parseUsageLine() (allowlist)
      tailer.ts       # LineTailer
      store.ts        # UsageStore, addMetrics(), localDayStart(), nextLocalMidnight()
      discover.ts     # discover(), isLive()
      monitor.ts      # UsageMonitor
      format.ts       # formatCount(), formatAiu(), statusText(), tooltipMarkdown(), copy constants
      panelHtml.ts    # renderPanelHtml() — pure
      panelCss.ts     # dashboard CSS constant (Task 8a)
      log.ts          # Logger with injected sink — pure
    vscode/
      statusBar.ts  panel.ts  outputSink.ts
    extension.ts
  test/
    fixtures/build.ts
    core/*.test.ts            # Vitest
    integration/*.test.ts     # Mocha in the extension host
  tools/schema-probe.mjs      # dev-only, shape-only
  tools/chat-schema-probe.mjs # dev-only, shape-only probe of VS Code Chat logs (§13, Task 10)
  docs/plans/copilot-usage-monitor-plan.md
  docs/design/dashboard-mockup.html   # Task 8a visual target (synthetic data)
  docs/SCHEMA.md              # §3, regenerated from the probe
```

---

## 7. Review Focus

The five failure modes most likely to bite a real user, each pinned by a test in its owning task.

1. **Leftover lock files from crashed sessions** make a months-old session "live": a wrong current session and a permanent false `format-changed` warning. → Task 6 `dead-pid lock is not live`, Task 7 `stale legacy session never flags format change`.
2. **Copilot updates and the record shape changes**: the status bar must warn, not show a smaller total. → Task 2 `unrecognized when usage object lacks every known token field`, `key-order change is suspect`; Task 7 `format-changed health`.
3. **One unreadable or half-written log**: the total must carry `*`, not look complete. → Task 7 `unreadable file marks partial`, `malformed gated line marks partial`.
4. **VS Code launched from the Dock doesn't see `COPILOT_HOME` from `.zshrc`**: the setting must override it, and the "not found" message must name the setting. → Task 1 `setting overrides env`; Task 8 `no-dir tooltip names the setting`.
5. **Midnight while VS Code stays open**: "today" resets without a reload; the ended current session keeps its numbers. → Task 4 `today excludes records before local midnight`, Task 7 `day change re-snapshots and keeps current`.

---

## 8. Phased tasks

**Phase 1 — pure core (Tasks 0–7)**, all tested under Node with Vitest. **Phase 2 — VS Code layer (Tasks 8, 8a).** **Phase 3 — gates, performance, packaging (Task 9).**

Dependencies: 0 → everything. 1, 2, 3, 6 are independent after 0. 4 needs 2. 5 needs 4. 7 needs 1–6. 8 needs 5 and 7. 8a needs 8. 9 needs 8a.

### Task 0: Scaffold, fixtures, schema probe

**Files:** Create every config file in §6, `LICENSE` (owner's choice; default "Copyright (c) 2026 Halmurat Tahir. All rights reserved."), `src/extension.ts` (empty `activate`/`deactivate`), `test/fixtures/build.ts`, `test/core/fixtures.test.ts`, `tools/schema-probe.mjs`, `docs/SCHEMA.md`.

**Interfaces:**
- Produces scripts: `build` (esbuild), `typecheck` (`tsc --noEmit -p .`), `test` (`vitest run`), `pretest:integration` (`npm run build && tsc -p tsconfig.test.json`), `test:integration` (`vscode-test`), `test:perf` (`PERF=1 vitest run test/core/perf.test.ts`), `package` (`vsce package --no-dependencies --allow-missing-repository`), `probe` (`node tools/schema-probe.mjs`).
- `package.json`: `name: "copilot-usage-monitor"`, `displayName: "Copilot Usage Monitor (Local)"`, `publisher: "local"`, `version: "0.1.0"`, `private: true`, `license: "SEE LICENSE IN LICENSE"`, `main: "./dist/extension.js"`, `engines.vscode: "^1.90.0"`, `activationEvents: ["onStartupFinished"]`, `dependencies: {}`.
- Fixtures: `export const CANARY = "SYNTHETIC-CANARY-7f3a"`; `usageEvent(o?: Partial<UsageFixture>): object`; `otherEvent(type: string, o?: object): object` (every string field = `CANARY`); `jsonl(events: object[]): string`; `sessionTree(root: string, sessions: { id: string; lines: string; lockPid?: number; mtime?: Date }[]): Promise<void>`. `UsageFixture` defaults: `{model:"model-a", inputTokens:1000, outputTokens:200, cacheReadTokens:500, cacheWriteTokens:50, reasoningTokens:30, duration:1500, totalNanoAiu:2_000_000_000, usageId:"u-1", sequence:1, sourceSessionId:"0000aaaa-0000-4000-8000-000000000001", id:"e-1", timestamp:<now ISO>}`; any key set to `undefined` is omitted; serialisation always puts `type` first.

- [ ] **Step 1:** Test: `usageEvent()` serialises starting with `{"type":"session.usage_record"`; `otherEvent("user.message")` contains `CANARY`; `usageEvent({inputTokens: undefined})` has no `inputTokens` key.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Scaffold. Install dev deps: `npm install -E -D typescript esbuild vitest @types/node@20 @types/vscode@1.90.0 @vscode/test-cli @vscode/test-electron @vscode/vsce`.
- [ ] **Step 4:** `tools/schema-probe.mjs` (rules in §4 "Tests"), output = §3's tables; `docs/SCHEMA.md` = §3.
- [ ] **Step 5:** `npm test`, `npm run typecheck`, `npm run build` → PASS, `dist/extension.js` exists.
- [ ] **Step 6:** Commit `chore: scaffold extension, fixtures and schema probe`.

### Task 1: Resolve the Copilot folder

**Files:** `src/core/config.ts`; test `test/core/config.test.ts`

**Interfaces:** `resolveCopilotRoot(o: { setting?: string; env: Record<string, string | undefined>; homedir: string }): { root: string; source: "setting" | "env" | "default" }`

- [ ] **Step 1: Tests:** `{env:{}, homedir:"/h"}` → `{"/h/.copilot","default"}`; `{env:{COPILOT_HOME:"/x/cp"}}` → `{"/x/cp","env"}`; `setting overrides env`: `{setting:"~/alt", env:{COPILOT_HOME:"/x"}}` → `{"/h/alt","setting"}`; blank (`"  "`, `""`) setting/env fall through; `{env:{COPILOT_HOME:"cp"}}` → `"/h/cp"`.
- [ ] **Steps 2–5:** FAIL → implement with `path.resolve(homedir, value)` → PASS → commit `feat: resolve Copilot folder from setting, COPILOT_HOME or ~/.copilot`.

### Task 2: Line gate and allowlist extractor

**Files:** `src/core/types.ts`, `src/core/extract.ts`; test `test/core/extract.test.ts`

**Interfaces:**
```ts
// types.ts
export interface Tokens { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }
export interface UsageRecord {
  key: string; keySource: "usageId" | "eventId";
  sessionId: string;     // accounting.sourceSessionId ?? folderId
  folderId: string;
  timestampMs: number; sequence?: number; model?: string;
  tokens: Tokens; durationMs?: number; nanoAiu?: number;
}
export type UnrecognizedReason = "no-usage-object" | "no-key" | "bad-timestamp" | "no-known-token-field" | "suspect-line";
export type ParseResult =
  | { kind: "usage"; record: UsageRecord }
  | { kind: "ignored" }        // valid JSON, but type is not session.usage_record
  | { kind: "unrecognized"; reason: UnrecognizedReason }
  | { kind: "malformed" };     // not JSON, or not an object
// extract.ts
export type LineClass = "usage" | "activity" | "suspect" | "skip";
export function classifyLine(buf: Buffer, start: number, end: number): LineClass;
export function parseUsageLine(line: string, folderId: string): ParseResult;
```
`classifyLine`: `usage` if the line starts with the bytes `{"type":"session.usage_record"`; `activity` if it starts with `{"type":"assistant.turn_end"`; `suspect` if neither but `"session.usage_record"` occurs anywhere in the line (`buf.indexOf` bounded by `end`); else `skip`. No decoding. The monitor counts `suspect` as `unrecognized` with reason `suspect-line` (signals a key-order change).
`parseUsageLine` checks in this order and returns the first failure: JSON/object → `malformed`; `type` ≠ `session.usage_record` → `ignored`; `data.usage` not an object → `no-usage-object`; neither `usageId` nor event `id` a non-empty string → `no-key`; `Date.parse(timestamp)` not finite → `bad-timestamp`; none of the five token fields valid → `no-known-token-field`. A numeric field is valid only if `Number.isSafeInteger(v) && v >= 0`; otherwise it is absent (never `0`). `JSON.parse` errors are caught and discarded.

- [ ] **Step 1: Tests:**
  - `extracts allowlisted fields`: default fixture → record deep-equals `{key:"u-1", keySource:"usageId", sessionId:<src id>, folderId:"f", timestampMs:Date.parse(ts), sequence:1, model:"model-a", tokens:{input:1000, output:200, cacheRead:500, cacheWrite:50, reasoning:30}, durationMs:1500, nanoAiu:2_000_000_000}`.
  - `real zero kept`: `cacheReadTokens: 0` → `tokens.cacheRead === 0`.
  - `canary never extracted`: fixture with `data.usage.prompt = CANARY`, `modelDisplayName = CANARY` → `JSON.stringify(result)` lacks `CANARY`.
  - `classifyLine`: usage / activity / skip for the three prefixes; a `user.message` line whose text contains `session.usage_record` → `suspect`; `key-order change is suspect`: `{"id":"x","type":"session.usage_record",…}` → `suspect`.
  - `skip lines are never decoded`: spy `Buffer.prototype.toString` and `TextDecoder.prototype.decode` → 0 calls when classifying a 200 KB canary line.
  - `missing field stays absent`: `cacheWriteTokens: undefined` → `"cacheWrite" in tokens === false`.
  - `wrong type is absent, not zero`: `"1000"`, `-5`, `1.5`, `null`, `2**60` → absent.
  - `unrecognized when usage object lacks every known token field`: `data.usage = {tokens:{in:5}}` → `no-known-token-field`; no `data.usage` → `no-usage-object`; `timestamp:"yesterday"` → `bad-timestamp`; both ids missing → `no-key`; order test: missing usage **and** bad timestamp → `no-usage-object`.
  - `falls back to event id`: no `usageId` → `key === "e-1"`, `keySource === "eventId"`.
  - `sessionId falls back to folder`.
  - `malformed`: `{not json` and `[]` → `malformed`; `different type with gate prefix-free JSON` (`{"type":"session.other"}`) → `ignored`.
  - `model id allowlist`: `"gpt-6-luna"` kept; `"[x](command:y)"`, `"a b"`, `"<img>"`, 101 chars → `model` undefined.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat: buffer-level line gate and allowlist extractor`.

### Task 3: Incremental tailer

**Files:** `src/core/tailer.ts`; test `test/core/tailer.test.ts` (real temp files)

**Interfaces:**
```ts
export type ReadErrorCode = "ENOENT" | "EACCES" | "EPERM" | "EIO" | "OTHER";
export interface TailResult {
  usageLines: string[];   // decoded, complete lines classified "usage"
  activity: number; suspect: number;
  overlong: number;       // over-long lines that may be usage (feeds partial)
  overlongOther: number;  // over-long lines whose type shows they are not usage (informational)
  reset: boolean; error?: ReadErrorCode;
}
export class LineTailer {
  constructor(path: string, opts?: { maxCarryBytes?: number /* 1_048_576 */; chunkBytes?: number /* 262_144 */ });
  read(): Promise<TailResult>;
  readonly carryLength: number;   // for tests
}
```
Cursor = `{dev, ino, offset, tail: Buffer}` where `tail` = up to 64 bytes ending at `offset`. On each `read()`: `open`, then `handle.stat()` (never `stat(path)`); **reset** (offset 0, clear carry and skip state) when `dev`/`ino` changed, `size < offset`, or the bytes at `[offset - tail.length, offset)` differ from `tail`. Read to the size seen by that `stat` in `chunkBytes` chunks; for each complete line call `classifyLine`; decode only `usage` lines (strip a trailing `\r`). When the carry would exceed `maxCarryBytes`, drop it, count the line **at that moment**, and skip until the next `\n`. A skipped line counts as `overlongOther` only when its first bytes provably name a non-usage type (`isKnownNonUsage`) and, when the whole line is in memory (it arrived in one chunk), it contains no usage-type needle (the same search `classifyLine` uses for `suspect`); otherwise it counts as `overlong`. A line streamed across chunks is judged by its head only, so a usage type nested past the head can't be seen there. Errors map to `ReadErrorCode`; `read()` never throws.

- [ ] **Step 1: Tests** (lines built from fixtures):
  - `complete lines only`: usage line without `\n` → none; append `\n` → one; a second `read()` with no change → none, `reset false`.
  - `small file grows without false reset`: write 3 bytes of a line, read, append the rest → `reset false`, one line.
  - `truncation resets`: 3 usage lines, read, truncate and write 1 → `reset true`, 1 line.
  - `in-place rewrite is detected`: overwrite the file through the same inode (`r+` handle) with different bytes and a larger size → `reset true`.
  - `rotation by rename`: rename away, new file at the path → `reset true`, read from 0.
  - `deleted file`: → `error "ENOENT"`, no throw; re-created → `reset true`.
  - `permission error` (skipped when `process.getuid?.() === 0`): `chmod 000` → `error "EACCES"`; restore → lines delivered.
  - `skips over-long line and resyncs`: `maxCarryBytes: 1024`, append 5 000 bytes without `\n`, then `\n` and a usage line → `overlong === 1`, the usage line delivered, `carryLength <= 1024` after every read.
  - `activity counted, not decoded`: 3 `turn_end` lines → `activity 3`, `usageLines []`.
  - `CRLF` and `UTF-8 split across reads` (model id with `é` is rejected later, but the line must decode intact).
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat: truncation- and rotation-safe tailer with buffer-level gate`.

### Task 4: Deduplicating store and metrics

**Files:** `src/core/store.ts`, extend `types.ts`; test `test/core/store.test.ts`

**Interfaces:**
```ts
// types.ts
export interface Metric { sum: number; reported: number; missing: number }   // sum meaningful only if reported > 0
export interface Counts {
  records: number;
  input: Metric; output: Metric; cacheRead: Metric; cacheWrite: Metric; reasoning: Metric;
  durationMs: Metric; nanoAiu: Metric;
}
export interface Totals extends Counts { byModel: Record<string, Counts> }   // "(unknown model)" key when model undefined
// store.ts
export class UsageStore {
  add(r: UsageRecord, file: string): boolean;   // false if key already known (file is still recorded)
  resetFile(file: string): void;                 // remove file from each record's file set; delete records whose set is empty
  totals(filter: (r: UsageRecord) => boolean): Totals | undefined;   // undefined iff no record matches
  latest(): Map<string, number>;                 // folderId → newest timestampMs
}
export function addMetrics(a: Metric, b: Metric): Metric;  // sum a+b; reported = max(a.reported, b.reported); missing = max(a.missing, b.missing)
export function localDayStart(now: Date): number;          // new Date(y, m, d).getTime()
export function nextLocalMidnight(now: Date): number;      // new Date(y, m, d + 1).getTime()
```
Internally `Map<key, { record, files: Set<string> }>`.

- [ ] **Step 1: Tests:**
  - `same usageId in two files counted once`.
  - `reset of first file keeps record seen in second`: add from f1, duplicate from f2, `resetFile(f1)` → still 1 record; `resetFile(f2)` too → `totals` undefined.
  - `resetFile then re-add`: add f1, reset f1, add again → `true`, 1 record.
  - `missing is not zero`: one record lacks `cacheWrite` → `{sum:50, reported:1, missing:1}`; all lack it → `{sum:0, reported:0, missing:2}`.
  - `addMetrics`: `{100,3,0} + {0,0,3}` → `{100,3,3}` (input known, output never reported → shown as `100*`, not `—` and not complete); `{0,0,3} + {0,0,3}` → `{0,0,3}` (shown as `—`).
  - `per-model breakdown`: models a, b, undefined → keys `model-a`, `model-b`, `(unknown model)` with correct sums.
  - `today excludes records before local midnight` (TZ America/Toronto): `now = 2026-11-05T05:30:00Z` → `localDayStart(now) === Date.parse("2026-11-05T05:00:00Z")`; records at `04:59:59Z` excluded, `05:00:01Z` included.
  - `DST`: `localDayStart(new Date("2026-11-01T17:00:00Z")) === Date.parse("2026-11-01T04:00:00Z")`; `nextLocalMidnight` of the same → `Date.parse("2026-11-02T05:00:00Z")` (25-hour day).
  - `large sums stay finite`: records summing past `Number.MAX_SAFE_INTEGER` → `Number.isFinite(sum)`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat: multi-file dedupe store with honest missing-field metrics`.

### Task 5: Labels and formatting

**Files:** `src/core/format.ts`, extend `types.ts` with `Health` and `Snapshot` (exact shapes in Task 7's Interfaces); test `test/core/format.test.ts`

**Interfaces:**
```ts
export const LOCAL_BANNER: string;   // §2, verbatim
export const STREAMING_NOTE = "Updates when Copilot finishes each model call, not token by token.";
export const NOT_COVERED: string[];  // A2 + A3 + A5 one-liners
export function formatCount(m: Metric): string;   // see rules
export function formatAiu(m: Metric): string;     // (sum / 1e9).toFixed(2), "—", or with "*"
export function partialNote(m: Metric): string | undefined;  // "reported by 1 of 2 records"
export function statusText(s: Snapshot | undefined): string;
export function tooltipMarkdown(s: Snapshot | undefined): string;   // Markdown source; model ids escaped
```
`formatCount`: `reported === 0` → `"—"`. Otherwise n = sum: n < 1 000 → `String(n)`; else pick K then M by **rounded** value: `k = (n/1e3).toFixed(1)`; if `Number(k) >= 1000` use `(n/1e6).toFixed(1) + "M"` else `k + "K"`; strip nothing (`"1.0K"`). Append `*` when `missing > 0`.
`statusText` (first match): no snapshot yet → `"$(sync~spin) Copilot usage: loading"`; `no-dir` → `"$(circle-slash) Copilot logs not found"`; `permission` → `"$(lock) Copilot logs unreadable"`; no `today` → `"$(pulse) Local today: —"`; else `"<icon> Local today: <n> tok"` where `n = formatCount(addMetrics(input, output))`, with `*` appended to `n` if `health.partial` and `n` has none; icon `$(warning)` when `format-changed`, else `$(pulse)`.

- [ ] **Step 1: Tests:**
  - `formatCount`: `{0,0,3}` → `"—"`; `{0,2,0}` → `"0"`; `999` → `"999"`; `1000` → `"1.0K"`; `1234` → `"1.2K"`; `999_950` → `"1.0M"`; `{1_250_000,3,1}` → `"1.3M*"`.
  - `formatAiu`: `{2e9,1,0}` → `"2.00"`; reported 0 → `"—"`.
  - `statusText` exact strings for: loading; ok with input `{1_200_000,2,0}` + output `{300_000,2,0}` → `"$(pulse) Local today: 1.5M tok"`; output `{0,0,2}` → `"$(pulse) Local today: 1.2M* tok"` (the star always sits on the number); `partial` health with complete metrics → `"$(pulse) Local today: 1.5M* tok"`; partial health **and** a starred number → still one star; `format-changed` → `"$(warning) Local today: 1.5M tok"`; no today → `"$(pulse) Local today: —"`; `no-dir`; `permission`.
  - `tooltip always carries LOCAL_BANNER and STREAMING_NOTE` (every state); `format-changed` tooltip contains `"N line(s) in a format this version doesn't recognize"` with the count; `partial` tooltip names each reason (unreadable files, malformed lines, over-long lines).
  - `hostile model is escaped`: a `byModel` key `"[x](command:y)<b>"` (bypassing the extractor) → tooltip contains no raw `[`, `]`, `<` from it.
  - `copy check`: after removing `LOCAL_BANNER`, no output in any state matches `/\b(bill|billing|remaining|quota|limit|allowance|credits?|cost|spend|premium)\b|\$\d|%/i`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat: local-only labels, dash for missing, star for partial`.

### Task 6: Session discovery and liveness

**Files:** `src/core/discover.ts`; test `test/core/discover.test.ts`

**Interfaces:**
```ts
export interface Candidate { folderId: string; eventsPath: string; mtimeMs: number; live: boolean }
export type DiscoverResult =
  | { ok: true; candidates: Candidate[]; foldersWithoutEvents: number; dirMtimeMs: number }
  | { ok: false; error: "no-dir" | "permission" | "OTHER" };
export function isLive(pid: number, kill?: (pid: number, sig: 0) => void): boolean;   // true if kill succeeds or throws EPERM
export function discover(root: string, dayStartMs: number, isLiveFn?: typeof isLive): Promise<DiscoverResult>;
```
Folder names must match `/^[0-9a-f-]{8,64}$/i` (others skipped). `events.jsonl` must be a regular file (`lstat`; symlinks and directories skipped). `live` = some `inuse.<pid>.lock` name in the folder has `isLive(pid)` **and** `mtimeMs >= dayStartMs`. A folder is a candidate iff `mtimeMs >= dayStartMs` (live implies this). Never opens a file.

- [ ] **Step 1: Tests:** `no-dir`; `permission` (`chmod 000`, skipped as root); file modified yesterday excluded; today's included; `dead-pid lock is not live` (lock name with a PID where the injected `kill` throws `ESRCH`, file modified today → `live false`); `live lock` (injected `kill` succeeds) → `live true`; `old file with live lock` (mtime yesterday) → not a candidate; `EPERM` counts as alive; `.session-operation-locks` and `.DS_Store` skipped; folder without log counted; symlinked `events.jsonl` skipped.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat: discover today's sessions with PID-checked liveness`.

### Task 7: UsageMonitor

**Files:** `src/core/monitor.ts`, `src/core/log.ts`; test `test/core/monitor.test.ts`, `test/core/log.test.ts`

**Interfaces:**
```ts
// types.ts (defined in Task 5)
export type HealthState = "ok" | "no-data" | "no-dir" | "permission" | "format-changed";
export interface Health {
  state: HealthState; rootSource: "setting" | "env" | "default";
  partial: boolean;                 // unreadableFiles + malformed + overlong > 0 (overlongOther never sets it)
  unrecognized: number; malformed: number; overlong: number; overlongOther: number; unreadableFiles: number;
  sessionsWithoutUsage: number;
}
export interface Snapshot {
  generatedAtMs: number; dayStartMs: number;
  today?: Totals;                   // undefined iff no record is dated today
  current?: { folderId: string; live: boolean; pinned: boolean; totals?: Totals };
  sessions: { folderId: string; lastMs?: number; live: boolean }[];
  health: Health;
}
// log.ts
export type LogSink = (line: string) => void;
export class Logger { constructor(sink: LogSink); count(event: string, n: number): void; error(where: string, code: string): void; timing(what: string, ms: number): void }
// monitor.ts
export class UsageMonitor {
  constructor(o: { root: string; rootSource: Health["rootSource"]; now?: () => Date; isLive?: typeof isLive;
                   log: Logger; onSnapshot: (s: Snapshot) => void });   // does not refresh on construction
  refresh(opts?: { full?: boolean }): Promise<void>;
  pin(folderId: string | undefined): void;
  dispose(): void;                  // after dispose, no onSnapshot call ever fires
}
```
Behaviour:
- `refresh({full:true})` runs `discover`; a plain `refresh()` re-reads known tailers and re-runs `discover` only if `session-state`'s mtime changed or 10 s passed since the last full run.
- Tailers are created per candidate and kept for the life of the monitor; a tailer is dropped only after `ENOENT`. A tailer `reset` → `store.resetFile(path)` and that file's counters (`malformed`, `unrecognized`, `overlong`, `activity`) are zeroed before re-reading.
- `suspect` lines count as `unrecognized` (`suspect-line`).
- Health, first match: `no-dir`/`permission` from discover; `format-changed` if `unrecognized > 0`, **or** a `live` session has ≥ 3 `activity` lines read **since this monitor started tailing it** with 0 usage records in the same window while some other session has a usage record today; `no-data` if `today` undefined; else `ok`. `partial` is computed independently. A candidate with activity and no usage that does not trigger `format-changed` adds 1 to `sessionsWithoutUsage`.
- `current`: pinned folder if set; else the live candidate with the newest record; else the folder with the newest record today ("(ended)", `live: false`). `current.totals` filters records by `r.sessionId === folderId`.
- `dayStartMs` is computed on every refresh; a change counts as "changed" and re-emits.
- Emits `onSnapshot` only when something changed. Concurrent calls are serialised (a call during a run sets a dirty flag; one more run follows). Every refresh body is wrapped in `try/catch` that calls `log.error("refresh", code)` with `err.code ?? "EXCEPTION"` — never `err.message`.
- `Logger` writes lines like `count usage=3` / `error refresh EACCES` / `timing refresh 12ms`; it never accepts free text.

- [ ] **Step 1: Tests** (fixture trees via `sessionTree`, injected `now` and `isLive`):
  - `restart rescan`: two usage lines → `await refresh({full:true})` → `today.records === 2`.
  - `incremental`: append one → `refresh()` → 3, exactly one new snapshot.
  - `partial line waits`, `duplicate events` (+1 only), `new session` (live by injected `isLive`) becomes `current`.
  - `current falls back to newest ended session` (`live:false`); `pin` and unpin.
  - `truncation` → `today.records` matches the rewritten file.
  - `format-changed health`: a gated line with `data.usage = {tokens:{}}` → `format-changed`, `unrecognized 1`, earlier records still counted.
  - `silent live session flags format change`: session A has today's records; live session B gets 3 `turn_end` lines after the first refresh, no usage → `format-changed`.
  - `stale legacy session never flags format change`: B has 5 `turn_end` lines, a lock with a dead PID, and today's mtime → state `ok`, `sessionsWithoutUsage 1`.
  - `legacy only`: only `turn_end`/`session.shutdown` lines today → `no-data`, `today` undefined.
  - `unreadable file marks partial`: `chmod 000` on one of two logs → `health.partial`, `unreadableFiles 1`, the other log still counted.
  - `malformed gated line marks partial`: a line starting `{"type":"session.usage_record"` but cut and joined to another (`{"type":"session.usage_record","id":{"type":"assistant.turn_end"}\n`-style garbage) → `partial`.
  - `no-dir` / `permission` recover to `ok` after the folder appears / is readable.
  - `day change re-snapshots and keeps current`: clock moves past local midnight → new snapshot, `today` undefined, `current.totals.records` unchanged.
  - `reads only events.jsonl`: decoy `config.json`, `session.db`, `workspace.yaml`, `inuse.1.lock` (each containing `CANARY`) in the tree; spy `fs.promises.open`, `fs.promises.readFile`, `fs.openSync`, `fs.readFileSync` → every opened path matches `/session-state\/[0-9a-f-]+\/events\.jsonl$/`.
  - `exception never leaks`: inject a `parseUsageLine` that throws `new Error(CANARY)` → log sink output contains `error refresh EXCEPTION` and no `CANARY`; monitor still emits later snapshots.
  - `no snapshot after dispose`: start a refresh, `dispose()`, await → `onSnapshot` not called.
  - `canary`: `JSON.stringify` of every emitted snapshot lacks `CANARY`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat: usage monitor with health, partial flag and current-session rule`.

### Task 8: VS Code layer

**Files:** `src/core/panelHtml.ts`, `src/vscode/statusBar.ts`, `src/vscode/panel.ts`, `src/vscode/outputSink.ts`, modify `src/extension.ts` and `package.json`; tests `test/core/panelHtml.test.ts`, `test/integration/extension.test.ts`

**Interfaces:**
- `renderPanelHtml(s: Snapshot | undefined, cspSource: string): string` (pure). Content: banner, streaming note, **Today** table and **Current session** table (rows Input, Output, Cache read, Cache write, Reasoning, Model time, AIU (as logged), Records; each cell `formatCount`/`formatAiu`, with `partialNote` as a title attribute and a footnote), a **By model** table for each, a **Data health** section (`rootSource`, counts, `partial` reasons, sessions without per-call data) and a **Not covered** list (`NOT_COVERED`). CSP meta `default-src 'none'; style-src ${cspSource} 'unsafe-inline';`. No `<script`. All dynamic text HTML-escaped.
- `package.json` `contributes`: commands `copilotUsageMonitor.showDetails` ("Copilot Usage: Show Local Details"), `copilotUsageMonitor.pinSession` ("Copilot Usage: Pin Session…", QuickPick of `snapshot.sessions` plus "Automatic"), `copilotUsageMonitor.refresh`; configuration `copilotUsageMonitor.copilotHome` (`type: string`, `default: ""`, `scope: "machine"`, description: "Folder that contains Copilot's session-state. Empty: use COPILOT_HOME, else ~/.copilot.").
- `extension.ts`: resolve root (setting, `process.env`, `os.homedir()`); `Logger(outputSink)`; `UsageMonitor`; status bar item (left, priority 100, `command: showDetails`, text `statusText`, tooltip `new MarkdownString(tooltipMarkdown(s))` with `isTrusted = false`, `supportHtml = false`); `refresh({full:true})` once, then `setInterval(() => monitor.refresh(), 500)`; a midnight `setTimeout` to `nextLocalMidnight(now)` that calls `refresh()` and re-arms (backup; the monitor detects the day change itself); `onDidChangeConfiguration('copilotUsageMonitor.copilotHome')` → dispose the monitor and rebuild; test-only command `copilotUsageMonitor._testState` returning `{ statusText, snapshot }`, registered only when `context.extensionMode === vscode.ExtensionMode.Test`.
- Panel title `Copilot Usage (Local)`; `enableScripts: false`, `localResourceRoots: []`; re-rendered on each snapshot while open.

- [ ] **Step 1: Unit tests (`panelHtml.test.ts`):** contains `LOCAL_BANNER`, `STREAMING_NOTE`, every `NOT_COVERED` item; no `<script`; CSP has `default-src 'none'`; `<img src=x onerror=1>` as a model key is escaped; unreported metric renders `—` and never `>0<`; partial metric renders `*` and the `reported by` note; **Today**, **Current session** and both **By model** tables present with one row per model; `undefined` snapshot renders a loading message.
- [ ] **Step 2: Integration tests** (`.vscode-test.mjs` sets `env.COPILOT_HOME` to a temp fixture root seeded with 200 session folders, a few live via a lock holding the test process's own PID; fixtures use the current time):
  - `activates and shows status text`: within 3 s, `_testState().statusText` starts with `$(pulse) Local today:`.
  - `updates within 2 s`: 20 iterations, each appending one complete usage line (new `usageId`, current timestamp) and polling `_testState()` every 25 ms until the status text changes; append the next only after the previous registered. Assert p95 < 2 000 ms and max < 5 000 ms; print the median.
  - `no-dir tooltip names the setting`: update `copilotHome` (Global target) to a missing folder → status text is `$(circle-slash) Copilot logs not found` and the tooltip contains `copilotUsageMonitor.copilotHome`; reset the setting afterwards.
  - `setting change re-roots` without reload.
  - `showDetails` opens a webview panel titled `Copilot Usage (Local)`.
  - `setting is machine-scoped`: `inspect('copilotHome')` reports no `workspaceValue` even when a workspace `.vscode/settings.json` sets it.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** `npm test && npm run test:integration` → PASS. **Step 6:** Commit `feat: status bar, details panel and polling`.

### Task 8a: Dashboard panel (visual redesign of the details panel)

**Origin.** The owner liked the dashboard of the `pvjagtap.copilot-usage-dashboard` 1.11.14 VS Code extension. It was inspected statically with REA (`analyze_javascript_application`, Evidence `ev_56356e48…`; nothing executed) plus its shipped CSS and screenshot. **Adopted:** the layout and visual language — top bar with status chips, a row of KPI stat cards (label + sub-line left, large monospace value right, coloured left edge), a two-column card grid, metric tiles, a per-model table with colour-coded model chips, a month calendar heatmap with a Less→More legend, warm-paper light theme and GitHub-style dark theme. **Not adopted** (conflicts with §2/§4): credits/overage/budget/projection figures, red-to-green "pace" colouring, dollar amounts, live OTel receiver, settings auto-config, `<script>`-driven filters and refresh dropdowns, web fonts, Chart.js. Their reader of VS Code `workspaceStorage/*/chatSessions` and `debug-logs` is a different data source and stays out of scope (see D12).

**Target:** [`docs/design/dashboard-mockup.html`](../design/dashboard-mockup.html) — synthetic data, scripts-free, CSP `default-src 'none'`. `renderPanelHtml` must produce this structure.

**Files:** modify `src/core/panelHtml.ts`, `src/core/types.ts`, `src/core/store.ts`, `src/core/discover.ts`, `src/core/monitor.ts`; add `src/core/panelCss.ts` (CSS string constant); tests `test/core/panelHtml.test.ts`, `test/core/store.test.ts`, `test/core/monitor.test.ts`.

**Interfaces (additions):**
```ts
// types.ts
export interface DayTotals { dayStartMs: number; totals?: Totals }   // totals undefined = no record that day ("—", not 0)
export interface Snapshot { /* …existing… */ month?: { monthStartMs: number; days: DayTotals[]; totals?: Totals } }
// store.ts
export function localMonthStart(now: Date): number;                    // new Date(y, m, 1).getTime()
export function byLocalDay(store: UsageStore, monthStartMs: number, now: Date): DayTotals[];  // one entry per day 1..today
export function heatLevel(value: number | undefined, max: number): 0 | 1 | 2 | 3 | 4;        // undefined/0 → 0; else ceil(4·v/max)
export function modelFamily(model: string): "claude" | "gpt" | "gemini" | "other";          // prefix match, lowercase
```
- `discover(root, windowStartMs)` is called with `localMonthStart(now)` instead of `localDayStart(now)` (D10). Liveness still requires today's mtime.
- Panel sections, in order: top bar (title, "Local" pill, updated time, chips: current session live/ended, `Partial data` when `health.partial`, `Format changed` when so, root source) → banner (`LOCAL_BANNER` + `STREAMING_NOTE`) → KPI row (Today tok, Current session tok, <Month> tok with active days and per-active-day average, AIU (as logged) today with month in the sub-line) → left column: *Today in detail* tiles and *Current session* tiles (Input, Output, Cache read, Cache write, Reasoning, Model time, AIU (as logged), Calls) → right column: *Today by model* table (chip, Input, Output, Cache read, Tokens, AIU, Calls, share bar) and *Daily tokens — <Month YYYY>* heatmap (Mon-first grid, past days coloured by `heatLevel` of input+output, today outlined, future days dashed, `—` for days with no records) → *Data health* tiles and *Not covered* list.
- Theme: CSS custom properties; dark tokens under `body.vscode-dark, body.vscode-high-contrast` (classes VS Code sets on webview bodies). No external fonts: system UI stack and `ui-monospace`. Responsive: single column below 1100 px, single-column KPIs below 560 px.
- Every `—` / `*` rule from Tasks 4–5 applies to every tile, cell and calendar day; the partial reason goes in a `title` attribute and a footnote.

- [ ] **Step 1: Tests:** `localMonthStart` (Nov 1 2026 Toronto, across the DST change); `byLocalDay` returns one entry per elapsed day with `totals` undefined for empty days; `heatLevel` (undefined → 0, max → 4, 1 % of max → 1); `modelFamily`; panel contains each section title in order; calendar has 7 `dow` headers, the right number of leading blanks for the month's first weekday, exactly one `.today`; an empty day renders `—`, never `0`; a hostile model key is escaped in the chip, the table and the `title` attribute; still no `<script`, no `http`, no `@import`, no `url(`; the copy check (Task 5 regex) passes on the panel's **text content** (tags and `<style>` removed — CSS widths use `%`); `JSON.stringify(snapshot)` and the HTML lack `CANARY`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (port the mockup's CSS verbatim into `panelCss.ts`). **Step 4:** PASS; open the panel in VS Code in a light and a dark theme and compare with the mockup. **Step 5:** Commit `feat: dashboard-style details panel with month heatmap`.

### Task 9: Gates, performance, packaging

**Files:** `test/core/gates.test.ts`, `test/core/perf.test.ts`, `README.md`; modify `.vscodeignore`

- [ ] **Step 1: Gate tests (`gates.test.ts`)**
  - `forbidden APIs`: scan `src/**/*.ts` and `dist/extension.js` (built first) for every §2 forbidden token; the only allowed `fs` writes are none.
  - `no hardcoded home`: no `/Users/` or `/home/` in `src/`, `test/`, `tools/`.
  - `README copy check`: README minus `LOCAL_BANNER` passes Task 5's copy regex, except inside the "What this is not" section, which must contain `LOCAL_BANNER` verbatim.
  - `.vsix contents`: run `npx vsce ls --no-dependencies --allow-missing-repository`, drop lines that are not paths, and assert the set equals `{package.json, README.md, LICENSE, dist/extension.js}`.
- [ ] **Step 2: Perf test (`perf.test.ts`, runs only when `PERF=1`):** 40 synthetic logs, 20 MB total (99 % canary non-usage lines up to 200 KB, 1 % usage lines) plus 300 folders → cold `refresh({full:true})` < 2 000 ms; steady `refresh()` with one appended line < 50 ms; idle polling for 10 s at 500 ms uses < 1 % CPU (`process.cpuUsage()` delta / wall time); heap growth after `global.gc?.()` (run with `--expose-gc`) < 64 MB.
- [ ] **Step 3:** Run `npm test && npm run test:integration && PERF=1 npm run test:perf && npm run package` → all PASS, `copilot-usage-monitor-0.1.0.vsix` produced.
- [ ] **Step 4: README:** what it shows; the banner; "What this is not" (A1–A5); install (`code --install-extension copilot-usage-monitor-0.1.0.vsix`, or *Extensions → … → Install from VSIX*); the `copilotHome` setting and why the Dock-launched VS Code may not see `COPILOT_HOME`; "What it reads" (§4); how to re-check the schema (`npm run probe`).
- [ ] **Step 5: Manual acceptance on the target machine** (owner, ~10 minutes): run `npm run probe` and diff against `docs/SCHEMA.md` (stop if the usage shape differs); install the `.vsix`; run one Copilot agent prompt; confirm the status bar changes within 2 s of the model call finishing, the panel's per-model row names the model used, and the Output channel shows only counts, codes and timings.
- [ ] **Step 6:** Commit `chore: privacy gates, perf budget, README and packaging`.

---

## 9. Acceptance criteria

| # | Criterion | Measured by |
|---|---|---|
| AC1 | Status bar shows local today's tokens within 3 s of VS Code startup | `activates and shows status text` |
| AC2 | p95 < 2 000 ms (max < 5 000 ms) from a complete usage line being written to the status bar text changing, over 20 samples with 200 session folders | `updates within 2 s` |
| AC3 | Current-session, today and per-model numbers equal hand-computed values for the fixtures | `monitor.test.ts`, `panelHtml.test.ts` |
| AC4 | An unreported metric never shows `0`; incomplete totals show `*` with a reason (missing fields, unreadable file, malformed or over-long line) | `store`, `format`, `monitor`, `panelHtml` tests |
| AC5 | No forbidden API in source or bundle; no canary in snapshots, tooltip, panel or log; only `events.jsonl` files opened; `.vsix` holds exactly 4 files | `gates.test.ts`, `monitor.test.ts` |
| AC6 | Each of: partial line, new session, truncation, in-place rewrite, rotation, deletion, restart, duplicate (same and different file), missing field, wrong type, permission denied (folder and file), missing folder, unknown shape, key-order change, stale lock, day change has a passing test | Tasks 2–7 |
| AC7 | Every surface carries the banner or "Local"; copy check passes on all states and the README | `format`, `panelHtml`, `gates` tests |
| AC8 | Cold scan of 20 MB / 300 folders < 2 s; steady refresh < 50 ms; idle CPU < 1 %; heap growth < 64 MB | `PERF=1 npm run test:perf` |
| AC9 | On the target machine, one real agent prompt shows up within 2 s of the model call finishing | Task 9 Step 5 |

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Copilot changes `events.jsonl` (already happened between 1.0.85 and 1.0.99) | High | Wrong or missing numbers | Strict extractor; anchored gate with `suspect` fallback; `format-changed` state; probe + `docs/SCHEMA.md` diff before each use on a new Copilot version |
| Usage moves out of `events.jsonl` (28 folders already have `session.db`) | Medium | Extension goes quiet | `no-data` / `sessionsWithoutUsage` make silence visible; a new reader is a separate, reviewed task |
| Target machine runs Copilot < 1.0.99 | Medium | Status bar shows `—` | D9; README explains |
| Local AIU read as the bill | Medium | Misleading decisions | AIU panel-only (D2), banner everywhere, copy-check tests |
| Partial coverage (other clients/devices) | Certain | Totals below GitHub's | A2 in panel and README |
| Stale locks or PID reuse mark a dead session live | Low after fix | Wrong current session | PID check + modified-today rule (D7); pin command |
| Large logs (210 KB tool-output lines) | Medium | CPU/memory spikes | Buffer gate, 1 MiB carry cap, chunked reads, perf test |
| Two VS Code windows | Certain | Two pollers (each < 1 % CPU) | Acceptable; counts are per window and identical |
| Employer policy on side-loaded extensions | Medium | Can't install at work | D6 before installing |
| Month window (D10) makes the cold start read every log written since the 1st (review 2026-11-05) | Medium late in a busy month | Slower first refresh, more heap | Buffer gate keeps it linear; perf suite covers 20 MB + 50k records; a size cap is a v0.2 candidate |
| A session last written yesterday and resumed today shows "ended" for up to 10 s | Low | Brief wrong live chip | Accepted; the 10 s rediscover corrects it |

## 11. Decisions that need the owner's approval

**Status: all defaults below approved by the owner on 2026-11-05.** D6 and D9 still need the owner to act on the target machine (policy check, `copilot --version`, `npm run probe`) at Task 9 Step 5.

- **D1 — Repo.** Standalone private repo `Halmurat-Uyghur/copilot-usage-monitor`, not inside any other repo.
- **D2 — Figures shown.** Status bar: input + output tokens only. AIU (`totalNanoAiu / 1e9`, "AIU (as logged)") in the panel only. The undocumented `cost` and `aiCreditsStatus` fields are never shown.
- **D3 — Pre-1.0.99 sessions** (superseded in v0.4 by D29, §16) (35 of 39 logs here) are listed as "sessions without per-call data" and not added to totals. Alternative: add `session.shutdown` totals for sessions that ended today (coarse: a whole session lands on its shutdown day, and nothing shows until it ends).
- **D4 — Current session.** Live (PID-checked) session with the newest record, else newest today "(ended)"; manual pin available.
- **D5 — Day boundary.** Local midnight (system time zone), not UTC.
- **D6 — Managed machine.** Confirm that installing a locally built `.vsix` and reading `~/.copilot` on an employer-managed machine is allowed, and re-run the probe there.
- **D7 — Liveness rule.** A lock counts only if its PID is running and the log was modified today.
- **D8 — License.** ~~Default "All rights reserved"~~ → **MIT** (2026-11-05: the owner made the extension free). `publisher` stays `local` until a Marketplace publisher exists; the README says it is not affiliated with GitHub or Microsoft.
- **D9 — Coverage expectation.** Per-call data needs Copilot 1.0.99+ on the target machine; confirm the version there (`copilot --version`) or accept `—` until it updates.

**Added 2026-11-05 with Task 8a (dashboard). Approved by the owner on 2026-11-05:**

- **D10 — Month window.** Scan logs modified since local midnight on the 1st of the current month (not just today) so the panel can show a month total and calendar. Still nothing persisted; the cold scan covers more files (perf budget AC8 unchanged).
- **D11 — AIU on a KPI card.** AIU (as logged) gets a KPI card in the panel (today, with month-to-date in the sub-line). Still panel-only per D2; the status bar is unchanged.
- **D12 — Data source.** Keep `~/.copilot/session-state/*/events.jsonl` only. The reference extension also reads VS Code `workspaceStorage/*/chatSessions` and `GitHub.copilot-chat/debug-logs`, which would cover Copilot Chat in VS Code; that is a separate reader with its own schema probe and privacy review, proposed as a follow-up, not part of 8a.

## 12. Execution notes

- Recommended: subagent-driven execution, one task per subagent, reviewer after each of Tasks 3, 7 and 8 (the three with the most state).
- Integration tests download a VS Code build through `@vscode/test-electron` at test time; the extension itself never touches the network. The `code` CLI is not on PATH on the development machine; `vscode-test` does not need it.
- Run `npm run probe` on the target machine before Task 2 if it differs from the development machine.

---

## 13. Amendment A — optional second source: VS Code Copilot Chat logs (proposed 2026-11-05, not approved)

**Status:** D13–D19 decided 2026-11-05 (owner delegated; see §13.4). Task 10 is **deferred to v0.2** and stays blocked on Step 1. D12 (approved) keeps `~/.copilot/session-state` as the only source; this section is the separate follow-up D12 asked for: its own schema probe, privacy review and task. Nothing here changes Tasks 0–9 (or 8a) until the owner approves D13–D19. It assumes D10 (month window) and Task 8a (dashboard panel) from the dashboard revision of this plan; if those are not merged, read "month" as "today" and skip the panel items.

### 13.1 What the probe found (2026-11-05, a development machine, `npm run probe:chat`)

Shape only: `tools/chat-schema-probe.mjs` prints key paths, types, counts, sizes and allowlisted enums (event names, Copilot Chat / VS Code version strings, agent ids); never values, names, paths or model ids. Its output was reviewed; every printed key is a product schema key.

**Layout.** One root present: `~/Library/Application Support/Code/User/workspaceStorage` (Insiders and remote-server roots absent). 42 workspace folders (40 hex-hash named); 30 have `chatSessions/` (46 `*.jsonl`); **1** has `GitHub.copilot-chat/` (`debug-logs/`, `transcripts/`, `chat-session-resources/`, one other file). `debug-logs/` holds 11 UUID-named session folders, each with `main.jsonl` and one `.json` file; no `runSubagent-*.jsonl`, no `title-*.jsonl`.

**`debug-logs/<session>/main.jsonl` — the per-call source, but empty here.**
- 11 files, 11 lines total, 264 bytes each, LF, valid JSON, every line starts `{"v":`. Envelope: `v` int, `ts` int (epoch ms), `dur` int, `sid` str, `type` str, `name` str, `spanId` str, `status` str, `attrs` object.
- Event types: **`session_start` × 11 only** (`attrs.copilotVersion` = Copilot Chat 0.66.0, `attrs.vscodeVersion` = 1.138.0, all started before this month). **0 `llm_request` lines**, so `attrs.model / inputTokens / outputTokens / cachedTokens / copilotUsageNanoAiu` are **unverified on this machine**; the only description is the third-party `ARCHITECTURE.md` of `pvjagtap.copilot-usage-dashboard` 1.11.14. Whether Copilot Chat writes `llm_request` only in newer versions or behind a setting is unknown (U1).

**`chatSessions/*.jsonl` — per-request snapshots, not per-call usage.**
- 46 files, 104 lines: `kind=0` (full session snapshot, 46, up to 234 KB), `kind=1` (set value at path `k`, 50, up to 741 KB), `kind=2` (append array at path `k`, 8, up to 151 KB). Replaying patches gives 12 requests (all before this month, all `agent.id = github.copilot.editsAgent`, mode `agent`).
- Per request: `promptTokens`, `completionTokens`, `result.metadata.promptTokens`, `result.metadata.outputTokens`, `elapsedMs`, `timestamp` and `modelState.completedAt` (epoch ms), `modelId`, `result.metadata.resolvedModel`. **No cache tokens, no AIU.**
- Problems: a request spans 1–30 `toolCallRounds` (model calls) but carries one `promptTokens`; `completionTokens` ≠ `result.metadata.outputTokens` in 11 of 12; `modelId` ≠ `resolvedModel` in 12 of 12; for 7 of 12 requests the tokens exist **only inside a `kind=0` snapshot line that also contains the prompt, responses and tool output**. Token patches themselves are tiny and byte-gateable (`{"kind":1,"k":["requests",<n>,"promptTokens"],"v":` × 5, same for `completionTokens`), but the model id arrives in `kind=2` lines that carry the user message.

**Overlap with `~/.copilot/session-state` (125 folders, 46 usage records).** 0 debug-log session folder names, 0 chat `sessionId`s and 0 `result.metadata.sessionId`s equal a session-state folder id; 0 token-tuple matches; 0 session-state records within ±5 s of any chat request. The time windows don't overlap, so this proves nothing either way. Side check: in all 46 session-state records `cacheReadTokens ≤ inputTokens` (consistent with input *including* cache reads; not proof).

**Conclusion.** On this Mac the second source would add nothing today: VS Code Chat was not used this month and no `llm_request` exists. The only usable per-call source is `debug-logs/*/main.jsonl` `llm_request`; `chatSessions` is unsuitable (per-request not per-call, ambiguous token semantics, usage mixed into prompt-bearing lines). Task 10 is therefore **blocked on a re-probe that finds real `llm_request` lines** (Step 1).

### 13.2 Privacy boundary additions (extend §4)

- **Root:** setting `copilotUsageMonitor.vscodeChat.storageRoot` (`scope: "machine"`, `~` expanded) → else derived from the extension's own `context.storageUri` / `globalStorageUri` (`…/User/workspaceStorage/<hash>/<ext>` → two levels up; `…/User/globalStorage/<ext>` → `../../workspaceStorage`). This follows stable, Insiders, portable and remote-server installs without hardcoding a product name. No probing of other products' folders.
- **Opened:** only `<root>/<hash>/GitHub.copilot-chat/debug-logs/<uuid>/main.jsonl`, `runSubagent-*.jsonl`, `title-*.jsonl` (regular files via `lstat`; folder names must match `/^[0-9a-f]{16,64}$/i` and the UUID pattern). Everything else under the root is `readdir`/`lstat` only. **Never opened:** `chatSessions/`, `transcripts/`, `chat-session-resources/`, `workspace.json` (holds the workspace path), `state.vscdb`, any `.json` beside the logs, anything under `globalStorage`.
- **Line gate (`classifyChatLine`, Buffer only):** `usage` iff the line starts with `{"v":` **and** the bytes `"type":"llm_request"` occur before the first `"attrs":` and within the first 512 bytes; `suspect` iff not `usage` but `"llm_request"` occurs anywhere (key-order or envelope change → `unrecognized`); else `skip`. Re-verify on the real format (Step 1); if `type` is not the field that holds `llm_request`, the gate is rewritten from the probe output before any code is merged.
- **Allowlist (`parseChatUsageLine`):** `ts` (epoch ms), `spanId`, `sid`, `attrs.model`, `attrs.inputTokens`, `attrs.outputTokens`, `attrs.cachedTokens`, `attrs.copilotUsageNanoAiu`. Not read: everything else in `attrs` (request/response bodies, tool data, endpoints, latencies), `status`, `dur` (meaning unverified), `child_session_ref` contents beyond the linked session id (Step 1 decides whether it is read at all).
- **Kept:** `UsageRecord` with `source: "vscode-chat"`; `spanId`/`sid` only as in-memory keys, never shown, logged or put in snapshots (snapshots carry a session count, not ids). The root path is never logged; `rootSource` gains `"vscode-setting" | "vscode-derived"`.
- **Tests:** synthetic fixtures with the canary in every content-bearing field, including a `attrs.prompt`, `attrs.messages[]` and a decoy `chatSessions/x.jsonl` and `workspace.json` whose contents are the canary; the fs spy (Task 7) widens its allowed-open regex to the three file names above and must still reject everything else.

### 13.3 Merging without double counting

1. **Namespaced keys.** Session-state records keep `key = usageId` (or event id). VS Code records use `key = "vsc:" + spanId` (fallback `"vsc:" + sid + ":" + ts + ":" + lineOrdinal`, `keySource: "chatSpan" | "chatFallback"`). A key collision across sources is impossible by construction; within VS Code the existing multi-file dedupe applies (a span copied into `main.jsonl` and `runSubagent-*.jsonl` counts once — Step 1 must confirm whether such copies exist).
2. **Session-level exclusion (agent sessions already counted from `~/.copilot`).** A VS Code debug-log session is dropped as a whole, and counted in `health.vscodeChat.linkedSessions`, if its folder name, its `sid`, or a `child_session_ref` target equals a session-state folder id or any `accounting.sourceSessionId` seen today/this month. Session-state wins because its records carry `usageId`/`sequence`.
3. **Record-level fingerprint (safety net for links we can't see).** A VS Code record is dropped, and counted in `health.vscodeChat.fingerprintMatches`, if a session-state record has the same `model`, `inputTokens`, `outputTokens` and (`cachedTokens` = `cacheReadTokens` when both present) with `|Δt| ≤ 5 s`. Matching is one-to-one (each session-state record absorbs at most one VS Code record). Order-independent: whichever source is read first, the result is the same set — implemented as a pass in `totals()` over the union, not at insert time, so a late session-state record still removes an earlier VS Code one.
4. **Metric mapping.** `input ← inputTokens`, `output ← outputTokens`, `nanoAiu ← copilotUsageNanoAiu`; `cacheRead`, `cacheWrite`, `reasoning`, `durationMs` stay **absent** (VS Code reports one undifferentiated `cachedTokens`, D16). Merged Today / month / per-model metrics therefore show `*` with "reported by N of M records" on the cache rows whenever VS Code records are included — never a `0`. If D16's alternative is chosen, `cachedTokens` goes to a new `cached` metric shown only in the per-source view.
5. **Totals.** `today`, `month`, `byLocalDay` and `byModel` are computed over the deduplicated union with the existing `addMetrics` rules. Model ids are not normalised across sources (an id in two spellings shows as two rows). The status-bar number (`input + output`) includes VS Code records only when the source is on (D13); the tooltip and panel add the line "Includes VS Code Copilot Chat (N calls)" when any are counted.
6. **Current session** stays session-state only (A4 unchanged): VS Code gives no liveness signal and no window↔session mapping (D17).
7. **Health.** `health.vscodeChat: { state: "off" | "no-root" | "no-debug-logs" | "no-llm-requests" | "permission" | "ok"; files; unreadableFiles; malformed; overlong; unrecognized; linkedSessions; fingerprintMatches }`. Its `unreadableFiles + malformed + overlong` feed `partial`; its `unrecognized` feeds `format-changed`. `no-root` / `no-debug-logs` / `no-llm-requests` are not errors: the VS Code row shows `—` with the reason, and the session-state numbers are unaffected. "Not covered" (`NOT_COVERED`) changes from "Copilot Chat surfaces that do not write these logs" to name exactly what is still missing (inline completions, Chat when the source is off or writes no `llm_request`).

### Task 10: VS Code Chat reader (optional, off by default)

**Depends on:** 7 (monitor), 8 (settings, `context.storageUri`), D10/8a for month and panel. **Blocked until Step 1 passes.**

**Files:** `tools/chat-schema-probe.mjs` (exists, dev-only), `src/core/vscodeChat.ts` (`resolveChatRoot`, `discoverChat`, `classifyChatLine`, `parseChatUsageLine`), extend `types.ts` (`UsageRecord.source`, `keySource` values, `Health.vscodeChat`), `store.ts` (`totals()` fingerprint pass), `monitor.ts` (second discovery + tailers), `tailer.ts` (gate injected: `new LineTailer(path, { classify })`), `format.ts` / `panelHtml.ts` (source line, VS Code health), `package.json` (settings `copilotUsageMonitor.vscodeChat.enabled` boolean default `false`, `copilotUsageMonitor.vscodeChat.storageRoot` string `""`, both `scope: "machine"`; script `probe:chat`); tests `test/core/vscodeChat.test.ts`, extend `store`, `monitor`, `panelHtml`, `gates`, `perf` tests.

**Interfaces:**
```ts
export type Source = "cli" | "vscode-chat";
// UsageRecord gains: source: Source; keySource: "usageId" | "eventId" | "chatSpan" | "chatFallback"
export function resolveChatRoot(o: { setting?: string; storageUri?: string; globalStorageUri?: string; homedir: string }):
  { root: string; source: "vscode-setting" | "vscode-derived" } | undefined;
export function discoverChat(root: string, windowStartMs: number): Promise<
  | { ok: true; files: { sessionId: string; path: string; mtimeMs: number }[]; workspaces: number; withDebugLogs: number }
  | { ok: false; error: "no-dir" | "permission" | "OTHER" }>;
export function classifyChatLine(buf: Buffer, start: number, end: number): LineClass;   // "usage" | "suspect" | "skip" ("activity" unused)
export function parseChatUsageLine(line: string, sessionId: string): ParseResult;      // same reasons as parseUsageLine
```

- [ ] **Step 1 (owner + dev, blocking): re-probe with real data.** On the target machine (D6), use VS Code Copilot Chat in agent mode for one prompt that calls a tool and spawns a sub-agent, then run `npm run probe:chat`. Extend the probe first to report for `llm_request`: line sizes; full `attrs` key paths and types (it already walks them); which envelope field holds `llm_request`; byte offset of `"attrs":`; `spanId` uniqueness within and across files of a session; presence and shape of `child_session_ref`; whether `attrs` holds any content-bearing key (prompt, messages, body — must be **not read**, and must not push the gate past 512 bytes); per-field int/zero/absent counts; overlap counts with session-state when a Copilot CLI agent session ran in the same window. **Stop** if: no `llm_request` appears (record U1, keep D12); the event name is not in a fixed-position envelope field; or token fields are not integers. Paste the probe output (shape only) into `docs/SCHEMA.md` §"VS Code Chat".
- [ ] **Step 2: Tests:**
  - `resolveChatRoot`: setting wins; derived from `storageUri` (`/h/Code/User/workspaceStorage/abc/local.copilot-usage-monitor` → `/h/Code/User/workspaceStorage`); from `globalStorageUri`; Insiders and `.vscode-server` paths derive the same way; nothing → `undefined`.
  - `discoverChat`: opens nothing; ignores `chatSessions`, `transcripts`, `workspace.json`, `.json` beside logs, symlinks, non-hex workspace names, non-UUID session names; month window by mtime.
  - `classifyChatLine`: `llm_request` line → `usage`; `session_start` → `skip`; `llm_request` named only inside `attrs` (e.g. a tool output quoting it) → `suspect`; envelope with `attrs` before `type` → `suspect`; 200 KB canary line → `skip` with 0 decode calls.
  - `parseChatUsageLine`: allowlisted fields extracted; real zero kept; wrong types absent, not zero; `cachedTokens` never lands in `cacheRead`; canary in `attrs.prompt` never in the result; bad `ts` → `bad-timestamp`; no token fields → `no-known-token-field`; model allowlist as Task 2.
  - `store` merge: same span in `main.jsonl` and `runSubagent-x.jsonl` → once; VS Code session whose `sid` equals a session-state folder → excluded, `linkedSessions 1`; fingerprint match within 5 s → VS Code record dropped (both insertion orders), `fingerprintMatches 1`; same tuple 6 s apart → both counted; two identical VS Code records vs one session-state record → only one dropped; per-model rows sum across sources; cache rows show `*` when VS Code records are present and `—` when only VS Code records exist.
  - `monitor`: source off → no VS Code fs call at all (fs spy); on with no root → state `no-root`, session-state totals unchanged; unreadable `main.jsonl` → `partial`; `suspect` VS Code line → `format-changed`; canary absent from snapshots, tooltip, panel, log sink.
  - `panelHtml`/`format`: "Includes VS Code Copilot Chat (N calls)" only when N > 0; VS Code `—` row with reason when `no-llm-requests`; copy check still passes.
  - `gates`: forbidden-API scan unchanged; fs-open allowlist regex covers exactly `session-state/<id>/events.jsonl` and `debug-logs/<uuid>/(main|runSubagent-[^/]+|title-[^/]+)\.jsonl`.
  - `perf`: add 300 workspace folders (20 with debug-logs, 5 MB of canary non-usage lines) → cold scan still < 2 s, steady refresh < 50 ms.
- [ ] **Steps 3–5:** FAIL → implement → PASS (`npm test`, `npm run test:integration`, `PERF=1 npm run test:perf`).
- [ ] **Step 6: Manual acceptance** (owner, target machine, source on): one VS Code Chat prompt appears in Today within 2 s of its `llm_request` line being written, under the right model; one Copilot CLI agent prompt started from VS Code is counted once (check `fingerprintMatches`/`linkedSessions` in Data health); Output channel shows only counts, codes, timings.
- [ ] **Step 7:** Commit `feat: optional VS Code Copilot Chat source with cross-source dedupe`.

**Acceptance additions:** AC10 — with the source off, the extension opens no file under `workspaceStorage` (fs spy). AC11 — a call present in both sources is counted once in Today, month and per-model (store and monitor tests). AC12 — VS Code records never turn a missing cache or reasoning metric into `0` (store and panel tests).

**Risks added:** VS Code Chat log format is internal and changes faster than the CLI's (High / wrong numbers → gate + `suspect` + Step 1 re-probe per Copilot Chat version). `llm_request` may never be written on the target machine (Medium / feature does nothing → `no-llm-requests` state, off by default). Missed cross-source link double counts agent work (Low–Medium / totals too high → session link + fingerprint, both surfaced in Data health). `workspaceStorage` holds workspace paths and full chat transcripts next to the logs (Certain / privacy → open-allowlist + fs-spy gate).

### 13.4 Decisions (decided 2026-11-05 under the owner's delegation, after an independent review)

**Outcome:** D13 — defer: Task 10 is not built until a real `llm_request` is probed; off by default when it ships. D14 — accepted, `chatSessions` is never read. D15 — accepted in principle, only together with Task 10. D16, D17, D18 — accepted as recommended. D19 — **alternative chosen**: the status bar stays Copilot CLI only for the first release of the source; VS Code calls appear in the panel only until the source has been proven.

Original options:

- **D13 — Enable the second source at all, and default.** Recommended: build Task 10 only after Step 1 finds real `llm_request` lines; ship it **off by default** behind `copilotUsageMonitor.vscodeChat.enabled`. Alternative: keep D12 as is and drop Task 10.
- **D14 — `chatSessions` is never read.** Recommended: yes — its tokens are per request (up to 30 model calls each), its two output counts disagree in 11 of 12 requests, there are no cache or AIU fields, and 7 of 12 requests only have tokens inside lines that also hold the prompt and responses. Alternative: a byte-gated reader of the tiny `promptTokens`/`completionTokens` patch lines only, model "(unknown model)", shown as a separate approximate "VS Code Chat requests" row never added to totals.
- **D15 — Wider read surface.** Approve reading `workspaceStorage/*/GitHub.copilot-chat/debug-logs/*/{main,runSubagent-*,title-*}.jsonl` (decoding only gated `llm_request` lines, as §4 does for `session.usage_record`). This folder tree also holds workspace paths and chat transcripts that the extension never opens. On an employer-managed machine this is part of the D6 policy question.
- **D16 — `cachedTokens`.** Recommended: not mapped to "Cache read" (it may mix reads and writes); merged cache rows carry `*`. Alternative: a separate "Cached (VS Code)" row in a per-source view.
- **D17 — Current session.** Recommended: remains Copilot CLI only; VS Code Chat counts in Today, month and per-model, not in "Current session".
- **D18 — Dedupe precedence.** Recommended: when a call is seen in both sources, the session-state record wins (it has `usageId`/`sequence`); link by session id first, then by (model, input, output, cached, ±5 s) fingerprint; both counts shown in Data health.
- **D19 — Status-bar figure.** Recommended: when the source is on, the status-bar `tok` figure includes VS Code calls and the tooltip says so. Alternative: status bar stays CLI-only and VS Code appears only in the panel.

**Unknowns to close in Step 1:** U1 — what makes Copilot Chat write `llm_request` (version or setting); U2 — whether `inputTokens` includes `cachedTokens` (needed before any "net input" figure; none is planned); U3 — whether sub-agent and title calls also appear in `main.jsonl` (affects in-source dedupe); U4 — whether Copilot CLI sessions started from VS Code's chat UI also produce `llm_request` lines (the double-count case §13.3 guards against).

## 14. v0.2 decisions — history, USD estimate and target range (2026-11-05, owner request)

The owner asked for past-month selection, a trend, a tokens ⇄ money view and a personal target range (employer pays; the goal is to stay within a self-set range, neither overspending nor under-using). These supersede the matching parts of D2, D10 and the non-goals list.

- **D20 — Month selection, script-free.** The panel stays `enableScripts: false`. Navigation uses `command:` links, and `enableCommandUris` is an allowlist of exactly `copilotUsageMonitor.selectMonth` and `copilotUsageMonitor.setUnit`. Arguments are a month key (`YYYY-MM`), `current`, `pick`, `tokens` or `cost`; anything else is ignored.
- **D21 — History window.** `historyMonths` (default 12, 1–24) replaces D10's "this month only" window. Logs modified since the 1st of the oldest month are read; nothing is persisted, so the cold start reads more files. "Sessions this month" and the pin list still show this month only.
- **D22 — USD estimate.** USD = logged `totalNanoAiu / 1e9` × $0.01. Verified on 46 real records (gpt-6-luna, mai-code-1.1-flash): the AIU equals GitHub's published per-token prices (input includes cached tokens) to four decimal places, so no price table is shipped. Every USD figure is labelled "est." and the panel carries a cost note ("not an invoice"). The copy gate now bans only account-statement words (bill, billing, remaining, quota, limit, allowance, premium) and `%`.
- **D23 — Target range.** `monthlyTargetMin` / `monthlyTargetMax` in USD, both optional. The state (under / in / over) uses spend so far this month — no projection (owner's choice). Status-bar icon: ↓ under, ✓ in, 🔥 over with the warning background. Nothing blocks Copilot and nothing pops up.
- **D24 — Costliest sessions.** Picked from two independent subagent proposals (both converged on per-session cost). Top 10 sessions of the viewed month by AIU; growth = mean AIU of the last 5 calls ÷ the first 5 (needs ≥ 10 priced calls); ▲ at ≥ 3×, with the advice that a fresh session is usually cheaper.

## 15. v0.3 decisions — project and tool filters (2026-11-05, owner request)

The owner asked to filter by project and by tool use, to manage tools and plugins efficiently.

- **D25 — Wider read surface, kept minimal.** `toolCounts` on `session.usage_record` is now read (names matching `[A-Za-z0-9._:/@-]{1,80}`, positive integers, at most 64). Each log's `session.start` line is decoded when `projectNames` is on (default), only if ≤ 16 KB, and reduced to one label: `context.repository` if it matches `owner/repo`, else the last segment of `gitRoot` / `cwd`. Full paths, branch, commits and prompt are dropped inside the extractor. Turning the setting off restores the v0.2 surface (start lines are skipped without decoding).
- **D26 — Filters.** One optional project and one optional tool, AND-ed. They narrow the viewed month (KPI, calendar, model table for past months, sessions), the trend and each other's table; the project table ignores the project filter and the tool table ignores the tool filter so you can switch. Today, the current session and the status bar (target range) are never filtered. A tool filter keeps whole model calls that invoked the tool; a call that used two tools counts for both, so tool rows do not add up to the month. Tools are tagged built-in (Copilot CLI's own) or added (anything else: MCP servers, plugins, extensions). Panel links use the allowlisted `copilotUsageMonitor.setFilter` command; values are strings ≤ 200 chars and only ever compared, never executed.

- **D27 — Long lists (v0.3.1).** Project, tool and model tables show `TABLE_LIMIT` = 10 rows, sorted costliest first; the rest fold into a native `<details>` ("Show N more"), so the panel stays script-free. A row matching the active filter always shows in its sorted place. Costliest sessions stays capped at 10. Added tools are summarised per group: "server/tool" → server, "mcp__server__tool" → server, else the part before the first "-" or "_"; at most 10 groups are named.

## 16. v0.4 decisions — section navigation, side bar summary, session totals (2026-11-06, owner request)

The owner asked for a left-hand section menu (as in CodeBurn) and for older sessions to count, as one total per session, while keeping local files only, no network and no credentials. Full detail: [the v0.4 spec](../superpowers/specs/2026-11-06-v0.4-sections-sidebar-session-totals-design.md) and the design notes in `docs/design/v0.4-notes/` (F1–F5, O1–O5).

- **D28 — Prototype-key hardening.** Model and tool ids reject `__proto__`, `constructor` and `prototype`; every object keyed by log data is `Object.create(null)` or a `Map`. A regression test feeds a `"model":"__proto__"` line.
- **D29 — Session totals from `session.shutdown` (overrides D3 and A3).** Sessions without per-call records are counted from the per-model totals in their shutdown line, labelled "session total", dated at the shutdown timestamp. Bounded gate (64 KiB, oversize counted in health), a reviver that removes content-bearing keys during parsing (the bounded line is decoded whole; those keys are never copied), then an allowlist (five token counts, `requests.count`, `totalNanoAiu`, timestamp, `sessionStartTime`). `0` AIU next to real tokens means not reported (USD `—`). Hidden when the session or its session folder has per-call records; the last shutdown wins. The tool filter excludes them. Setting `sessionTotals` (default on, machine scope); off restores the v0.3 read surface.
- **D30 — Section navigation.** Overview, Daily, Sessions, Models, Projects, Tools, Insights, Data health. The section is host state (in memory, not a setting), switched by the new `showSection` command, so `PANEL_COMMANDS` is exactly four. Scripts stay off; fragment anchors are not used. The panel is split into `src/core/panel/*.ts`.
- **D31 — Side bar view.** A native TreeView in its own activity-bar container (codicon, no media file), built by the pure `buildSidebarModel`. Rows: Today, Last 7 days, This month, Current session, top projects, top models, Data health. `Snapshot` gains unfiltered `thisMonth` and `last7`; the status bar reads `thisMonth`, fixing the filtered USD month.
- **D32 — Section content.** Overview tiles (with a Last 7 days change shown as ▲/▼, no percentage), sessions table from up to 50 kept sessions, a model Share column, Insights I2 (sessions that grew costly) and I3 (low cache reuse) from per-call records only, and new Data health facts.
- **D33 — Status bar.** Text and colour unchanged; the tooltip stays untrusted; `accessibilityInformation` added; the month figure comes from `thisMonth`.
