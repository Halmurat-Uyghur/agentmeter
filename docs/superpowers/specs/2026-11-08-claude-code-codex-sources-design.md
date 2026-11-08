# v0.8 design: Claude Code and Codex as usage sources

Date: 2026-11-08. Owner request: "introduce Claude Code and Codex" to the extension, with the same privacy stance, in one PR that is merged. Decided by a two-seat panel (one Fable, one Opus) over two rounds; the lead ruled on the remaining splits. Where a decision below says "ruling", that is the lead's call after the panel.

Verified facts come from shape-only probes of the owner's machine on 2026-11-08 (key paths, types, counts, lengths; no value was printed). They are recorded in `docs/SCHEMA.md` by the implementation (D53).

## Why

- The owner uses the Copilot CLI, Claude Code and the Codex CLI in the same repositories and wants one local view of all three: tokens per day, per project, per model, per session.
- Each tool writes append-only JSONL under the home folder. Copilot: `~/.copilot/session-state/<id>/events.jsonl` (read today). Claude Code: `~/.claude/projects/<slug>/<sessionId>.jsonl` plus `<sessionId>/subagents/**/agent-*.jsonl`. Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- Those files hold prompts, replies, thinking and tool inputs (whole files) next to the usage numbers. The product promise, "content lines are never decoded", must hold for them too.

## Goals

1. Count Claude Code and Codex model calls (tokens, model, session, project, tools) next to Copilot's, in the status bar, side bar and every panel section.
2. Never decode a prompt, reply, thinking block, tool input or path from either tool. Copy only allowlisted numbers, ids and short labels.
3. Stay fast on a heavy machine: 3,600+ Claude Code files, 4.5 GB, 500 ms polling.
4. Keep every existing gate green and extend it to the new code; the 802 existing tests stay meaningful.

## Non-goals (0.8)

A price table or any cost figure for Claude Code or Codex; reading Codex `function_call` items as tools; reading Codex `archived_sessions/` (listed, never opened); prompts/agent-call chains for the new sources (`initiator` stays undefined); `$XDG_CONFIG_HOME/claude` as a second default root (follow-up; `claudeHome` covers it); keeping the head and tail of over-long assistant lines (follow-up); renaming the extension.

## Anti-goals (a failure even if it works)

- Any byte of prompt, reply, thinking, tool input, path, branch, `instructions`, `rate_limits` or sandbox policy turned into a JavaScript string, kept, rendered or logged.
- A Claude Code or Codex call shown as $0.00, or Copilot's USD figure starred forever because another source logged no cost.
- The same model call counted twice (streamed blocks, resumed sessions, subagent files).
- The extension host stalling on activation, or thousands of file opens per second while idle.
- A Copilot-only user seeing changed figures.

## Verified facts the design rests on

Claude Code (3,655 files, 4.76 GB; 167,544 assistant lines):
- Every line is one JSON object. Key order starts `parentUuid, isSidechain, …`; `type` sits late (median offset past 200 bytes). Line types include `assistant`, `user`, `attachment`, `api-request`, `api-request-blob`, `last-prompt`, `custom-title`, `ai-title`, `queue-operation`, `bridge-session`; 2,368 telemetry lines in `vercel-plugin/` have no `type` key.
- `"type":"assistant"` appears as raw bytes in 0 lines of any other type. `"type":"user"` appears within the first 152 bytes of every user line. `"usage":{` appears in `attachment` and `user` lines too, so it is not a gate.
- Assistant lines: `message.model` (`claude-…`, or the sentinel `<synthetic>`), `message.id` (28 chars `[A-Za-z0-9_-]`, present on every line), `message.stop_reason` (null on streamed blocks, a string on the last), `message.usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}` (always present), `message.usage.output_tokens_details.thinking_tokens` (85 %), `requestId` (28 chars), `uuid`, `timestamp` (`YYYY-MM-DDTHH:MM:SS.sssZ`, 100 %), `sessionId` (UUID), `cwd` (absolute path, 100 %), `isSidechain` (true in 44 %), `agentId`. No `costUSD`.
- `input_tokens` is uncached input only (Anthropic convention). `thinking_tokens` is inside `output_tokens`.
- A streamed message is several lines with one `message.id`: 56,805 ids repeat; 3,471 repeats differ in usage, and in 3,470 the later line has more output tokens; the first has `stop_reason: null`, the last a string. 2 repeats span two files (a resumed session copies history).
- 46 lines have all four token counts 0 (43 are `<synthetic>`).
- Largest assistant line 297 KB (p99 26 KB). Lines over 1 MiB: 164, all `user` (109) or `api-request-blob` (55).
- Nested files: `<slug>/<uuid>/subagents/agent-*.jsonl` and `<slug>/<uuid>/subagents/workflows/wf_*/agent-*.jsonl`; their `sessionId` equals the `<uuid>` directory in 114,528 of 114,528 lines. Other directories under a slug: `memory/`, `tool-results/`, `vercel-plugin/`, `remote-agents/`, `scripts/`.
- Bytes modified in the last 7 / 30 / 90 days: 1.5 / 4.1 / 4.8 GB. 4 files modified in the last 5 minutes. A warm `Buffer.indexOf` scan of the 30-day set took 2.4 s (1.7 GB/s).

Codex (33 files, 252 MB):
- Every line starts `{"timestamp":"…","ordinal":N,"type":"…","payload":{…}}`. Top-level types: `event_msg`, `response_item`, `token_usage_record`, `inter_agent_communication_metadata`, `world_state`, `turn_context`, `session_meta`, `compacted`. The raw bytes `"type":"token_usage_record"`, `"type":"turn_context"` and `"type":"session_meta"` appear in 0 lines of another type.
- `token_usage_record.payload`: `thread_id`, `turn_id`, `session_id` (UUID), `root_turn_id`, `response_id` (55 chars `[A-Za-z0-9_-]`, 1,978 distinct of 1,978), `usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`, `turn_token_usage`, `thread_token_usage`. No model field.
- `turn_context.payload.model` carries the model (one distinct model per file at most); a `turn_context` precedes the first record in every file. `session_meta.payload` has `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `model_provider`, `git`, `instructions`, …; a file may hold more than one `session_meta`.
- `event_msg` with `payload.type == "token_count"` carries `payload.info.{total_token_usage, last_token_usage, model_context_window}` and `payload.rate_limits` (allowance-like; never read). Every file with `token_count` also has `token_usage_record` here; older Codex wrote only `token_count`. In 4 of 18 files the last total is 2–4 % below the sum of the records.
- `cached_input_tokens ≤ input_tokens` in 1,978 of 1,978 (input includes cache reads); `reasoning_output_tokens ≤ output_tokens` in all. `cache_write_input_tokens` was 0 in every record, so whether input includes cache writes is unverified.
- `archived_sessions/`: 9 plain `.jsonl`, 13 `.jsonl.zst`. Largest line 723 KB.

## Decisions

### D40: the source dimension

- `export type Source = "copilot" | "claude-code" | "codex"`; `export const SOURCES: readonly Source[] = ["copilot", "claude-code", "codex"]` (UI order); `export const SOURCE_LABEL: Record<Source, string> = { copilot: "Copilot", "claude-code": "Claude Code", codex: "Codex" }`. Labels come only from this table, never from a log.
- `UsageRecord.source: Source` is required; every parser sets it. `keySource` gains `"claudeMessageId" | "claudeRequestId" | "codexResponseId" | "codexTotal"`.
- The store key becomes `${kind}|${source}|${key}`, so an id from one tool's log can never equal, and drop, another tool's record (extends N10).
- `Filter.source?: Source`; `setFilter("source", v)` accepts only members of `SOURCES` (anything else is ignored); `""` clears it. The filter rides on the existing `setFilter` command and link shape, so `PANEL_COMMANDS` and `SIDEBAR_COMMANDS` are unchanged.
- Aggregates: `Totals.bySource?: Partial<Record<Source, Counts>>` (filled like `byModel`) and `Counts.sources?: Partial<Record<Source, number>>` (records per source, for chips). `GroupSummary.sources?`, `ToolSummary.sources?` (records per source), `SessionSummary.source`, `Snapshot.sessions[].source`, `Snapshot.current.source`. New aggregate fields are optional so snapshot literals in existing tests stay valid; `UsageRecord.source` is required and the fixture builders default it to `"copilot"`.
- The UI word is **Source** everywhere: filter chip "Source: Claude Code", card "By source", health box "Sources".

### D41: the JSON path scanner (`src/core/jsonScan.ts`)

Claude Code and Codex lines are never decoded whole. A depth-tracking byte scanner walks a line's bytes once:
- It tracks `{ } [ ]` depth and the current key at each depth. String bodies are skipped by bytes: on `\` skip one byte, on an unescaped `"` the string ends. UTF-8 continuation bytes are ≥ 0x80 and never equal a structural ASCII byte, so nothing is decoded to find structure.
- The caller passes an allowlist of absolute key paths (for example `message.usage`, `message.content[].name`). The scanner returns, per matched path, the byte range of the value; array elements are addressed with `[]`.
- Only matched slices are decoded, and only through one helper in this module, `parseSlice(buf, start, end, maxBytes)`, which refuses a slice over `maxBytes` (4 KiB, `MAX_SLICE_BYTES`) before parsing; a refused slice leaves the record `unrecognized`. `JSON.parse(` appears exactly once in `src/core/jsonScan.ts` (inside `parseSlice`) and never in `src/core/claude.ts` or `src/core/codex.ts` (gate, D53).
- A key with the same name at another depth (a tool input holding `"model"`, `"usage"` or `"type":"assistant"`) never matches, because paths are absolute.
- Malformed input never throws or loops: an unterminated string or unbalanced brackets end the scan with what was matched so far; the caller treats a missing required path as `malformed` or `unrecognized`.
- Tests: a differential test (every slice equals the value `JSON.parse(line)` yields at that path, over every fixture), a fuzz test over random nested JSON with the needles inside strings and inside objects, and canary tests (D53).

### D42: the Claude Code reader (`src/core/claude.ts`)

- **Files.** Under `<claudeHome>/projects/`: regular files named `*.jsonl`, found by a `withFileTypes` walk of depth ≤ 6 below `projects/` (symlinks skipped, not followed), at most 10,000 files per discovery (the rest are counted as not read, D50). Nothing else under `<claudeHome>` is listed or opened.
- **Gate.** A line is a candidate only if `Buffer.indexOf` finds the bytes `"type":"assistant"` anywhere in it (native, no decoding). A candidate is **assistant** only when the scanner finds `type` at depth 1 with that value. A line whose depth-1 `type` is `user` (found by `"type":"user"` in its first 256 bytes) counts as activity, undecoded. Every other line is skipped undecoded.
- **Fields.** From an assistant line only these paths are matched: depth 1 `type`, `requestId`, `timestamp`, `sessionId`, `cwd`; under `message`: `id`, `model`, `stop_reason`, `usage`; under `message.content[]`: `type` and `name`. Everything else (`content[].text`, `thinking`, `input`, `signature`, `gitBranch`, `version`, `userType`, `agentId`, `isSidechain`, `uuid`, `message.usage.service_tier`, …) is never turned into a string.
- **Mapping** (D47 normalises tokens): `tokens.input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `cacheRead = cache_read_input_tokens`, `cacheWrite = cache_creation_input_tokens`, `output = output_tokens`, `reasoning = output_tokens_details.thinking_tokens` (absent → not reported). `model` must match `MODEL_ID`. `stop_reason` maps to `FinishReason`: `end_turn → stop`, `tool_use → tool_calls`, `max_tokens → length`, `refusal → content_filter`, other strings → `other`, null → undefined. `timestamp` goes through the existing `TIMESTAMP` rule. `sessionId` must match `SESSION_ID`, else the file name stem (a UUID) stands in. `cwd` is reduced to a project label (D44) and dropped.
- **Identity.** Key = `message.id` (`^[A-Za-z0-9_-]{1,128}$`, `keySource "claudeMessageId"`), else `requestId` (`"claudeRequestId"`); never `uuid` (it would count each streamed block). Without both → `unrecognized: no-key`.
- **Repeats.** Within one file, a later line with the same key replaces the record's usage, timestamp and finish reason (last line wins) and merges its `tool_use` names into the record's tools; the store's `add` reports the change so the snapshot redraws. Across files the record counts once and the first file keeps it (the D29 "held by several files" mechanism). A tailer reset (truncation, rotation, rewrite) drops the file's records before the re-read, as today, so a line is applied once per file lifetime and tool names never merge twice.
- **Zero usage.** A line whose four token counts are all 0 or absent (e.g. model `<synthetic>`) is `ignored`: not a record, not unrecognized. An assistant line without a `usage` object is `unrecognized`.
- **Line cap.** 4 MiB for Claude Code (Copilot keeps 1 MiB). An over-long line whose first 4 KiB shows `"role":"assistant"` inside `message` counts as `overlong` (may be usage; sets `partial`); any other head counts as `overlongOther`.
- **Format change.** A file with activity lines and no usage record contributes to the source's `format-changed` state through the same rule as Copilot (live, at least `FORMAT_ACTIVITY` activity lines after the first read, no usage, while another session logged usage today), so one interrupted turn never flags it. For Codex the activity signal is a `turn_context` line.

### D43: Claude Code sessions, subagents and liveness

- A session is every file whose records carry the same `sessionId`: the main file plus `subagents/**/agent-*.jsonl` under its folder. `folderId` = `sessionId`, so pinning and `showSession` validation (`^[0-9a-f-]{8,64}$`) work unchanged. Discovery candidates are keyed `(source, sessionId)` with `mtimeMs` = the newest of its files; a subagent file is never a session of its own.
- `isSidechain` lines are real API calls and count fully; the flag is not kept.
- Liveness (no PID lock files): `RECENT_MS = 300_000`. A Claude Code or Codex session is `live` when any of its files has `mtimeMs ≥ now − RECENT_MS` and was modified today. `current` picks a PID-live Copilot session first (newest record), then an mtime-live session, then the newest record today. For mtime-based sources the chip and the session badge read "idle", never "ended", when not live (`Snapshot.current.source` tells the renderer which wording applies).

### D44: one project key across sources

- The grouping and filter key is the **folder name** for every source: Copilot: last segment of `context.gitRoot`, else of `context.cwd`; Claude Code: last segment of the first usage record's `cwd` in the session (pinned per session, so a `cd` does not split it); Codex: last segment of the first `session_meta.payload.cwd`.
- Before taking the last segment, a trailing `/.claude/worktrees/<x>` or `/.worktrees/<x>` is removed, so a worktree counts under its repository.
- Copilot's `context.repository` (`owner/repo`) becomes a display-only label on the row, applied when every Copilot session in the group agrees on it, through the same `label` mechanism session titles use. `FOLDER_NAME` validation, the ID-label rule and the `workspace.yaml` title lookup (Copilot only) are unchanged. The `projects/<slug>` directory name is never used; full paths are dropped inside the reader.
- This changes Copilot's grouping key from `owner/repo` to the folder name; the CHANGELOG says so. Two different repositories cloned into folders of the same name share one row; the README says so in one line. The side bar's "This workspace" match becomes a folder-name match. All of it honours `copilotUsageMonitor.projectNames`; with it off no `cwd` or `session_meta` path is read.

### D45: the Codex reader (`src/core/codex.ts`)

- **Files.** `<codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl` only; the date directories must be digits and are descended only when the date is on or after the history window start. `archived_sessions/` is listed by name for a Data health count ("archived sessions, not read") and never opened; SCHEMA.md notes that its plain `.jsonl` files are a lower-bound gap and a possible follow-up. Nothing else under `<codexHome>` (`auth.json`, `config.toml`, `history.jsonl`, `log/`, sqlite files) is listed or opened.
- **Gate.** A line is a candidate when `Buffer.indexOf` finds `"type":"token_usage_record"`, `"type":"turn_context"`, `"type":"session_meta"` or `"type":"event_msg"`; the scanner confirms the depth-1 `type`. Everything else is skipped undecoded.
- **Fields.** `token_usage_record`: `timestamp`, `payload.session_id`, `payload.turn_id`, `payload.response_id`, `payload.usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}`. `turn_context`: `payload.turn_id`, `payload.model`. `session_meta`: `payload.cwd` (first line only, reduced to a label per D44). `event_msg`: `payload.type`, and when it is `token_count`, `payload.info.total_token_usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}`. Never matched: `rate_limits`, `last_token_usage`, `model_context_window`, `turn_token_usage`, `thread_token_usage`, `total_tokens`, `instructions`, `git`, sandbox and permission fields, `cli_version`, `originator`.
- **Mapping.** Copied as logged: `input = input_tokens` (already includes cache reads), `cacheRead = cached_input_tokens`, `cacheWrite = cache_write_input_tokens` (not added into input: unverified), `output = output_tokens`, `reasoning = reasoning_output_tokens`.
- **Identity.** Key = `response_id` (`^[A-Za-z0-9_-]{1,128}$`, `keySource "codexResponseId"`); without it → `unrecognized: no-key`. `sessionId` = `payload.session_id` when it matches `SESSION_ID`, else the UUID in the file name; `folderId` = `sessionId`.
- **Model.** Per file, `turn_context` lines build a map `turn_id → model` (turn ids validated `^[A-Za-z0-9_-]{1,128}# v0.8 design: Claude Code and Codex as usage sources

Date: 2026-11-08. Owner request: "introduce Claude Code and Codex" to the extension, with the same privacy stance, in one PR that is merged. Decided by a two-seat panel (one Fable, one Opus) over two rounds; the lead ruled on the remaining splits. Where a decision below says "ruling", that is the lead's call after the panel.

Verified facts come from shape-only probes of the owner's machine on 2026-11-08 (key paths, types, counts, lengths; no value was printed). They are recorded in `docs/SCHEMA.md` by the implementation (D53).

## Why

- The owner uses the Copilot CLI, Claude Code and the Codex CLI in the same repositories and wants one local view of all three: tokens per day, per project, per model, per session.
- Each tool writes append-only JSONL under the home folder. Copilot: `~/.copilot/session-state/<id>/events.jsonl` (read today). Claude Code: `~/.claude/projects/<slug>/<sessionId>.jsonl` plus `<sessionId>/subagents/**/agent-*.jsonl`. Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- Those files hold prompts, replies, thinking and tool inputs (whole files) next to the usage numbers. The product promise, "content lines are never decoded", must hold for them too.

## Goals

1. Count Claude Code and Codex model calls (tokens, model, session, project, tools) next to Copilot's, in the status bar, side bar and every panel section.
2. Never decode a prompt, reply, thinking block, tool input or path from either tool. Copy only allowlisted numbers, ids and short labels.
3. Stay fast on a heavy machine: 3,600+ Claude Code files, 4.5 GB, 500 ms polling.
4. Keep every existing gate green and extend it to the new code; the 802 existing tests stay meaningful.

## Non-goals (0.8)

A price table or any cost figure for Claude Code or Codex; reading Codex `function_call` items as tools; reading Codex `archived_sessions/` (listed, never opened); prompts/agent-call chains for the new sources (`initiator` stays undefined); `$XDG_CONFIG_HOME/claude` as a second default root (follow-up; `claudeHome` covers it); keeping the head and tail of over-long assistant lines (follow-up); renaming the extension.

## Anti-goals (a failure even if it works)

- Any byte of prompt, reply, thinking, tool input, path, branch, `instructions`, `rate_limits` or sandbox policy turned into a JavaScript string, kept, rendered or logged.
- A Claude Code or Codex call shown as $0.00, or Copilot's USD figure starred forever because another source logged no cost.
- The same model call counted twice (streamed blocks, resumed sessions, subagent files).
- The extension host stalling on activation, or thousands of file opens per second while idle.
- A Copilot-only user seeing changed figures.

## Verified facts the design rests on

Claude Code (3,655 files, 4.76 GB; 167,544 assistant lines):
- Every line is one JSON object. Key order starts `parentUuid, isSidechain, …`; `type` sits late (median offset past 200 bytes). Line types include `assistant`, `user`, `attachment`, `api-request`, `api-request-blob`, `last-prompt`, `custom-title`, `ai-title`, `queue-operation`, `bridge-session`; 2,368 telemetry lines in `vercel-plugin/` have no `type` key.
- `"type":"assistant"` appears as raw bytes in 0 lines of any other type. `"type":"user"` appears within the first 152 bytes of every user line. `"usage":{` appears in `attachment` and `user` lines too, so it is not a gate.
- Assistant lines: `message.model` (`claude-…`, or the sentinel `<synthetic>`), `message.id` (28 chars `[A-Za-z0-9_-]`, present on every line), `message.stop_reason` (null on streamed blocks, a string on the last), `message.usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}` (always present), `message.usage.output_tokens_details.thinking_tokens` (85 %), `requestId` (28 chars), `uuid`, `timestamp` (`YYYY-MM-DDTHH:MM:SS.sssZ`, 100 %), `sessionId` (UUID), `cwd` (absolute path, 100 %), `isSidechain` (true in 44 %), `agentId`. No `costUSD`.
- `input_tokens` is uncached input only (Anthropic convention). `thinking_tokens` is inside `output_tokens`.
- A streamed message is several lines with one `message.id`: 56,805 ids repeat; 3,471 repeats differ in usage, and in 3,470 the later line has more output tokens; the first has `stop_reason: null`, the last a string. 2 repeats span two files (a resumed session copies history).
- 46 lines have all four token counts 0 (43 are `<synthetic>`).
- Largest assistant line 297 KB (p99 26 KB). Lines over 1 MiB: 164, all `user` (109) or `api-request-blob` (55).
- Nested files: `<slug>/<uuid>/subagents/agent-*.jsonl` and `<slug>/<uuid>/subagents/workflows/wf_*/agent-*.jsonl`; their `sessionId` equals the `<uuid>` directory in 114,528 of 114,528 lines. Other directories under a slug: `memory/`, `tool-results/`, `vercel-plugin/`, `remote-agents/`, `scripts/`.
- Bytes modified in the last 7 / 30 / 90 days: 1.5 / 4.1 / 4.8 GB. 4 files modified in the last 5 minutes. A warm `Buffer.indexOf` scan of the 30-day set took 2.4 s (1.7 GB/s).

Codex (33 files, 252 MB):
- Every line starts `{"timestamp":"…","ordinal":N,"type":"…","payload":{…}}`. Top-level types: `event_msg`, `response_item`, `token_usage_record`, `inter_agent_communication_metadata`, `world_state`, `turn_context`, `session_meta`, `compacted`. The raw bytes `"type":"token_usage_record"`, `"type":"turn_context"` and `"type":"session_meta"` appear in 0 lines of another type.
- `token_usage_record.payload`: `thread_id`, `turn_id`, `session_id` (UUID), `root_turn_id`, `response_id` (55 chars `[A-Za-z0-9_-]`, 1,978 distinct of 1,978), `usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`, `turn_token_usage`, `thread_token_usage`. No model field.
- `turn_context.payload.model` carries the model (one distinct model per file at most); a `turn_context` precedes the first record in every file. `session_meta.payload` has `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `model_provider`, `git`, `instructions`, …; a file may hold more than one `session_meta`.
- `event_msg` with `payload.type == "token_count"` carries `payload.info.{total_token_usage, last_token_usage, model_context_window}` and `payload.rate_limits` (allowance-like; never read). Every file with `token_count` also has `token_usage_record` here; older Codex wrote only `token_count`. In 4 of 18 files the last total is 2–4 % below the sum of the records.
- `cached_input_tokens ≤ input_tokens` in 1,978 of 1,978 (input includes cache reads); `reasoning_output_tokens ≤ output_tokens` in all. `cache_write_input_tokens` was 0 in every record, so whether input includes cache writes is unverified.
- `archived_sessions/`: 9 plain `.jsonl`, 13 `.jsonl.zst`. Largest line 723 KB.

## Decisions

### D40: the source dimension

- `export type Source = "copilot" | "claude-code" | "codex"`; `export const SOURCES: readonly Source[] = ["copilot", "claude-code", "codex"]` (UI order); `export const SOURCE_LABEL: Record<Source, string> = { copilot: "Copilot", "claude-code": "Claude Code", codex: "Codex" }`. Labels come only from this table, never from a log.
- `UsageRecord.source: Source` is required; every parser sets it. `keySource` gains `"claudeMessageId" | "claudeRequestId" | "codexResponseId" | "codexTotal"`.
- The store key becomes `${kind}|${source}|${key}`, so an id from one tool's log can never equal, and drop, another tool's record (extends N10).
- `Filter.source?: Source`; `setFilter("source", v)` accepts only members of `SOURCES` (anything else is ignored); `""` clears it. The filter rides on the existing `setFilter` command and link shape, so `PANEL_COMMANDS` and `SIDEBAR_COMMANDS` are unchanged.
- Aggregates: `Totals.bySource?: Partial<Record<Source, Counts>>` (filled like `byModel`) and `Counts.sources?: Partial<Record<Source, number>>` (records per source, for chips). `GroupSummary.sources?`, `ToolSummary.sources?` (records per source), `SessionSummary.source`, `Snapshot.sessions[].source`, `Snapshot.current.source`. New aggregate fields are optional so snapshot literals in existing tests stay valid; `UsageRecord.source` is required and the fixture builders default it to `"copilot"`.
- The UI word is **Source** everywhere: filter chip "Source: Claude Code", card "By source", health box "Sources".

### D41: the JSON path scanner (`src/core/jsonScan.ts`)

Claude Code and Codex lines are never decoded whole. A depth-tracking byte scanner walks a line's bytes once:
- It tracks `{ } [ ]` depth and the current key at each depth. String bodies are skipped by bytes: on `\` skip one byte, on an unescaped `"` the string ends. UTF-8 continuation bytes are ≥ 0x80 and never equal a structural ASCII byte, so nothing is decoded to find structure.
- The caller passes an allowlist of absolute key paths (for example `message.usage`, `message.content[].name`). The scanner returns, per matched path, the byte range of the value; array elements are addressed with `[]`.
- Only matched slices are decoded, and only through one helper in this module, `parseSlice(buf, start, end, maxBytes)`, which refuses a slice over `maxBytes` (4 KiB, `MAX_SLICE_BYTES`) before parsing; a refused slice leaves the record `unrecognized`. `JSON.parse(` appears exactly once in `src/core/jsonScan.ts` (inside `parseSlice`) and never in `src/core/claude.ts` or `src/core/codex.ts` (gate, D53).
- A key with the same name at another depth (a tool input holding `"model"`, `"usage"` or `"type":"assistant"`) never matches, because paths are absolute.
- Malformed input never throws or loops: an unterminated string or unbalanced brackets end the scan with what was matched so far; the caller treats a missing required path as `malformed` or `unrecognized`.
- Tests: a differential test (every slice equals the value `JSON.parse(line)` yields at that path, over every fixture), a fuzz test over random nested JSON with the needles inside strings and inside objects, and canary tests (D53).

### D42: the Claude Code reader (`src/core/claude.ts`)

- **Files.** Under `<claudeHome>/projects/`: regular files named `*.jsonl`, found by a `withFileTypes` walk of depth ≤ 6 below `projects/` (symlinks skipped, not followed), at most 10,000 files per discovery (the rest are counted as not read, D50). Nothing else under `<claudeHome>` is listed or opened.
- **Gate.** A line is a candidate only if `Buffer.indexOf` finds the bytes `"type":"assistant"` anywhere in it (native, no decoding). A candidate is **assistant** only when the scanner finds `type` at depth 1 with that value. A line whose depth-1 `type` is `user` (found by `"type":"user"` in its first 256 bytes) counts as activity, undecoded. Every other line is skipped undecoded.
- **Fields.** From an assistant line only these paths are matched: depth 1 `type`, `requestId`, `timestamp`, `sessionId`, `cwd`; under `message`: `id`, `model`, `stop_reason`, `usage`; under `message.content[]`: `type` and `name`. Everything else (`content[].text`, `thinking`, `input`, `signature`, `gitBranch`, `version`, `userType`, `agentId`, `isSidechain`, `uuid`, `message.usage.service_tier`, …) is never turned into a string.
- **Mapping** (D47 normalises tokens): `tokens.input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `cacheRead = cache_read_input_tokens`, `cacheWrite = cache_creation_input_tokens`, `output = output_tokens`, `reasoning = output_tokens_details.thinking_tokens` (absent → not reported). `model` must match `MODEL_ID`. `stop_reason` maps to `FinishReason`: `end_turn → stop`, `tool_use → tool_calls`, `max_tokens → length`, `refusal → content_filter`, other strings → `other`, null → undefined. `timestamp` goes through the existing `TIMESTAMP` rule. `sessionId` must match `SESSION_ID`, else the file name stem (a UUID) stands in. `cwd` is reduced to a project label (D44) and dropped.
- **Identity.** Key = `message.id` (`^[A-Za-z0-9_-]{1,128}$`, `keySource "claudeMessageId"`), else `requestId` (`"claudeRequestId"`); never `uuid` (it would count each streamed block). Without both → `unrecognized: no-key`.
- **Repeats.** Within one file, a later line with the same key replaces the record's usage, timestamp and finish reason (last line wins) and merges its `tool_use` names into the record's tools; the store's `add` reports the change so the snapshot redraws. Across files the record counts once and the first file keeps it (the D29 "held by several files" mechanism). A tailer reset (truncation, rotation, rewrite) drops the file's records before the re-read, as today, so a line is applied once per file lifetime and tool names never merge twice.
- **Zero usage.** A line whose four token counts are all 0 or absent (e.g. model `<synthetic>`) is `ignored`: not a record, not unrecognized. An assistant line without a `usage` object is `unrecognized`.
- **Line cap.** 4 MiB for Claude Code (Copilot keeps 1 MiB). An over-long line whose first 4 KiB shows `"role":"assistant"` inside `message` counts as `overlong` (may be usage; sets `partial`); any other head counts as `overlongOther`.
- **Format change.** A file with activity lines and no usage record contributes to the source's `format-changed` state the same way Copilot's silent-live rule does.

### D43: Claude Code sessions, subagents and liveness

- A session is every file whose records carry the same `sessionId`: the main file plus `subagents/**/agent-*.jsonl` under its folder. `folderId` = `sessionId`, so pinning and `showSession` validation (`^[0-9a-f-]{8,64}$`) work unchanged. Discovery candidates are keyed `(source, sessionId)` with `mtimeMs` = the newest of its files; a subagent file is never a session of its own.
- `isSidechain` lines are real API calls and count fully; the flag is not kept.
- Liveness (no PID lock files): `RECENT_MS = 300_000`. A Claude Code or Codex session is `live` when any of its files has `mtimeMs ≥ now − RECENT_MS` and was modified today. `current` picks a PID-live Copilot session first (newest record), then an mtime-live session, then the newest record today. For mtime-based sources the chip and the session badge read "idle", never "ended", when not live (`Snapshot.current.source` tells the renderer which wording applies).

### D44: one project key across sources

- The grouping and filter key is the **folder name** for every source: Copilot: last segment of `context.gitRoot`, else of `context.cwd`; Claude Code: last segment of the first usage record's `cwd` in the session (pinned per session, so a `cd` does not split it); Codex: last segment of the first `session_meta.payload.cwd`.
- Before taking the last segment, a trailing `/.claude/worktrees/<x>` or `/.worktrees/<x>` is removed, so a worktree counts under its repository.
- Copilot's `context.repository` (`owner/repo`) becomes a display-only label on the row, applied when every Copilot session in the group agrees on it, through the same `label` mechanism session titles use. `FOLDER_NAME` validation, the ID-label rule and the `workspace.yaml` title lookup (Copilot only) are unchanged. The `projects/<slug>` directory name is never used; full paths are dropped inside the reader.
- This changes Copilot's grouping key from `owner/repo` to the folder name; the CHANGELOG says so. Two different repositories cloned into folders of the same name share one row; the README says so in one line. The side bar's "This workspace" match becomes a folder-name match. All of it honours `copilotUsageMonitor.projectNames`; with it off no `cwd` or `session_meta` path is read.

### D45: the Codex reader (`src/core/codex.ts`)

- **Files.** `<codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl` only; the date directories must be digits and are descended only when the date is on or after the history window start. `archived_sessions/` is listed by name for a Data health count ("archived sessions, not read") and never opened. Nothing else under `<codexHome>` (`auth.json`, `config.toml`, `history.jsonl`, `log/`, sqlite files) is listed or opened.
- **Gate.** A line is a candidate when `Buffer.indexOf` finds `"type":"token_usage_record"`, `"type":"turn_context"`, `"type":"session_meta"` or `"type":"event_msg"`; the scanner confirms the depth-1 `type`. Everything else is skipped undecoded.
- **Fields.** `token_usage_record`: `timestamp`, `payload.session_id`, `payload.turn_id`, `payload.response_id`, `payload.usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}`. `turn_context`: `payload.turn_id`, `payload.model`. `session_meta`: `payload.cwd` (first line only, reduced to a label per D44). `event_msg`: `payload.type`, and when it is `token_count`, `payload.info.total_token_usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}`. Never matched: `rate_limits`, `last_token_usage`, `model_context_window`, `turn_token_usage`, `thread_token_usage`, `total_tokens`, `instructions`, `git`, sandbox and permission fields, `cli_version`, `originator`.
- **Mapping.** Copied as logged: `input = input_tokens` (already includes cache reads), `cacheRead = cached_input_tokens`, `cacheWrite = cache_write_input_tokens` (not added into input: unverified), `output = output_tokens`, `reasoning = reasoning_output_tokens`.
- **Identity.** Key = `response_id` (`^[A-Za-z0-9_-]{1,128}$`, `keySource "codexResponseId"`); without it → `unrecognized: no-key`. `sessionId` = `payload.session_id` when it matches `SESSION_ID`, else the UUID in the file name; `folderId` = `sessionId`.
, never rendered; at most 1,024 entries) and remember the latest model. A record takes the model of its `turn_id`, else the latest model seen earlier in the file, else none ("(unknown model)").
- **Session totals.** Only with `copilotUsageMonitor.sessionTotals` on, mirroring D29: a file with `token_count` lines and no `token_usage_record` yields one `kind: "sessionTotal"` record (`keySource "codexTotal"`, key `codex-total:<sessionId>`, `calls` unknown → "—") from the last `token_count` line's totals, dated at that line. It is hidden once the session has a per-call record, and a later line replaces an earlier one.

### D46: cost covers Copilot only

- Claude Code and Codex log no cost. In 0.8 their records carry no `nanoAiu`, and USD metrics (`nanoAiu`, `callNanoAiu`) are aggregated over Copilot records only: in `accumulate`, `sessionSummaries`, `projectSummaries`, `toolSummaries`, `recentProjects` and `dailyActivity`, the `nanoAiu` and `callNanoAiu` metrics are counted only for `source === "copilot"` records, so a non-Copilot record neither reports nor is "missing" and a USD figure is starred only when a Copilot record lacked its credits (a pre-1.0.99 Copilot session total still bumps `missing`: that is genuinely not reported). "Per call" USD already divides by `callNanoAiu.reported`, so it stays Copilot-only without change.
- Wherever a USD figure is shown while a non-Copilot record is in scope, the notes add: "USD (est.) covers Copilot only: Claude Code and Codex log no cost; their figures are tokens." The target line reads "Target … (Copilot only)" under the same condition. The "By source" card shows "—" for USD on those sources.
- Follow-up (separate PR, opt-in, separately labelled "at API list prices", never merged into "USD (est.)"): a bundled price table.

### D47: one token convention

- `tokens.input` means prompt tokens including cached tokens for every source (the Copilot convention; uncached = `input − cacheRead − cacheWrite`). Claude Code is normalised as in D42; Codex is copied as logged.
- `promptConventions` returns `"included"` for every non-Copilot record and keeps its per-model inference for Copilot records only. SCHEMA.md documents the Claude Code sum as derived arithmetic on allowlisted ints, like USD from AIU. A test with Claude Code cache reads far larger than input asserts that the derived uncached input (`input − cacheRead − cacheWrite`) equals the logged `input_tokens` exactly.

### D48: settings

- `copilotUsageMonitor.claudeCode` (boolean, default `true`, scope `machine`): "Also read Claude Code's local session logs (the projects folder under claudeHome). Only token counts, model ids, timestamps, session ids and folder names are kept; prompts, replies, thinking and tool inputs are never decoded."
- `copilotUsageMonitor.codex` (boolean, default `true`, scope `machine`): likewise for the Codex CLI's sessions folder.
- `copilotUsageMonitor.claudeHome` (string, default `""`, scope `machine`): empty = `CLAUDE_CONFIG_DIR`, else `~/.claude`. `copilotUsageMonitor.codexHome` (string, default `""`, scope `machine`): empty = `CODEX_HOME`, else `~/.codex`. Both resolve like `copilotHome` (`~` expanded, relative values against the home folder, non-string = unset).
- Ruling on defaults: on. The owner asked for both; the extension is `"publisher": "local"`, `"private": true`, installed from a `.vsix` built from this repo; nothing is opened when a folder is absent; each source is disclosed in Data health, the side bar and the setting text; the privacy guarantee is the read surface. A source that is off causes zero `fs` calls under its root (fs-spy test). Copilot is always on. Turning a source off forgets its records at once (a monitor restart, like `copilotHome`).

### D49: the source in the UI

- **Panel.** Filter chip and quick-pick entries for the three sources. Overview gets a **By source** card for the viewed month (one row per source with records: tokens or USD, calls, sessions; click a row to filter to that source). The Models, Projects, Sessions and Tools tables show a small source chip per row (several when a model id is shared by two sources). Insights footer: "Insights use Copilot's logged AI credits; Claude Code and Codex calls are not examined." Data health gets a **Sources** box with one row per source: off (names the setting) / folder not found (names the setting) / unreadable / "N files, M sessions read", then that source's counters (unknown-format lines, malformed lines, over-long lines that may be usage, files beyond the cap, archived sessions not read). The "Folder: …" chip in the top bar lists each enabled source's folder origin.
- **Side bar.** A group **By source, last 7 days** with one row per enabled source whose folder exists (value "—" when it has no record), each a link that filters the panel to that source and opens Overview. Shown only when a non-Copilot source is enabled and found. Notices for no-dir name all enabled sources' settings.
- **Status bar.** Text unchanged. The tooltip adds one line per source with records today under "Local today" when more than one source has records. No-logs wording: "Local: no usage logs found" (spoken: "No usage logs found. Opens details.").
- **Health.** `Health.sources?: Partial<Record<Source, SourceHealth>>` with `SourceHealth = { state: "ok" | "no-data" | "no-dir" | "permission" | "off" | "format-changed"; rootSource: "setting" | "env" | "default"; files: number; sessions: number; unreadableFiles: number; unrecognized: number; malformed: number; overlong: number; overlongOther: number; capped?: number; archived?: number }`. The global `Health.state` is `no-dir` only when every enabled source is `no-dir`; `permission` when every enabled source is `no-dir` or `permission` and at least one is `permission`; `format-changed` when any source is; else `no-data` / `ok` as today. The global counters stay as sums; `Health.rootSource` keeps Copilot's value. `Health.reading?: { done: number; total: number }` is set while the first read of the window is in progress (D50).
- Copy: `LOCAL_BANNER` becomes "Locally observed from Copilot, Claude Code and Codex session logs on this computer. Not an account statement from any of them, not your remaining allowance, and not usage from other devices or features that don't write these logs." The README's "What this is not" section quotes it verbatim (gate). Every new string obeys the copy gate (no bill, billing, remaining*, quota, limit, allowance, premium, no `%`; `remaining allowance` stays only inside `LOCAL_BANNER`, which the gate exempts).

### D50: discovery, hot and cold files, first read, budgets

- The monitor composes one reader per enabled source (D54). Discovery runs every 10 s, or when a root directory's mtime changes, for every enabled source: Copilot as today; Claude Code by the capped walk of D42; Codex by the date-pruned walk of D45. Candidates in the window (mtime ≥ window start) become file states; files that leave the window are forgotten with their records, as today.
- Each 500 ms tick tails only **hot** files: `mtimeMs ≥ now − RECENT_MS` at the last discovery, or a size or mtime change seen by the last discovery. Cold files are read once when first seen and again only when discovery sees them change (so a session idle for over 5 minutes shows its next call within 10 s, then is hot again). Copilot files keep today's behaviour (they are few).
- The first read of the window reads newest file first, chunk by chunk with awaits between chunks, emits a snapshot at most every 500 ms with `health.reading = { done, total }`, and the panel and side bar show "Reading history (n of N files)…" until it completes.
- Caps: walk depth 6, 10,000 Claude Code files (the rest counted in `SourceHealth.capped`), 1,024 Codex turns per file, 4 KiB slices, 4 MiB lines, 64 tools per record.
- Perf budgets (test/core/perf.test.ts, `PERF=1`): a synthetic Claude-shaped corpus of ≥ 200 MB (content lines with CANARY, 1 % assistant lines, 3,000 files) scans cold in < 1 s per 100 MB; a steady tick with 3,000 cold files and one hot file takes < 50 ms and < 5 ms CPU when idle; heap growth stays bounded (< 64 MB over the Copilot test's baseline for 100,000 records).
- README: "The first scan reads your logs once; several GB of Claude Code logs take a few seconds of background reading per VS Code window. Claude Code deletes its own transcripts after its cleanup period (30 days by default), so older Claude Code months may be empty."

### D51: branding, copy, version

- Extension id, settings prefix, display name and activity bar title unchanged. `description`: "Shows your own Copilot, Claude Code and Codex CLI usage, in tokens (and Copilot's estimated USD), as observed in their local session logs on this computer. …" Keywords add `claude`, `codex`. "Not affiliated with, endorsed by or supported by GitHub, Microsoft, Anthropic or OpenAI." in README and the manifest.
- Version 0.8.0; CHANGELOG entry dated 2026-11-08; README `.vsix` name and the issue template's example version follow (existing gate). Walkthrough step 1 names all three folders and keeps the sentence the gate checks.

### D52: Claude Code tools

- For each `message.content[]` object whose `type` slice is `"tool_use"`, the `name` slice (≤ 80 bytes, `TOOL_NAME`, not a prototype key) is decoded and counted into `record.tools` (at most 64 names). `input` and `id` are never decoded. Repeated lines of one message merge their names (D42).
- `BUILT_IN_TOOLS` becomes per source: Copilot's set as today; Claude Code's `Bash, Read, Edit, Write, MultiEdit, Glob, Grep, LS, Task, Agent, WebFetch, WebSearch, TodoWrite, TodoRead, NotebookEdit, NotebookRead, Skill, AskUserQuestion, ExitPlanMode, EnterPlanMode, KillShell, BashOutput, SlashCommand`; `mcp__server__tool` names group through `toolGroup` as "added". `ToolSummary.builtIn` is judged by the record's source. Codex tools are a non-goal.

### D53: privacy gates and tests

- **Canary.** Fixture builders `test/fixtures/claude.ts` and `test/fixtures/codex.ts` put a unique canary into every content-bearing field: prompt text, `thinking`, tool_use `input`, `toolUseResult`, `gitBranch`, every `cwd` segment but the last, the `projects/<slug>` directory name, Codex `instructions`, `rate_limits`, `git`, sandbox paths, `last_token_usage`. Tests assert the canary never appears in any record, snapshot (`JSON.stringify`), panel HTML, side bar HTML, tooltip or the log sink.
- **Structure attacks.** Fixtures with `"type":"assistant"`, `"usage":{…}` and `"model":"…"` nested inside a tool input object, inside a user line's `toolUseResult`, and as escaped text inside strings: none produces or alters a record.
- **Never-open list.** Only paths that match the source's pattern (`projects/**/*.jsonl`; `sessions/YYYY/MM/DD/rollout-*.jsonl`; Copilot's `session-state/<id>/events.jsonl`) reach a tailer; `pathAllowed(source, path)` is checked before a tailer is created and a gate test proves the check exists. SCHEMA.md lists what is never read per source: `auth.json`, `config.toml`, `history.jsonl`, `settings*.json`, `CLAUDE.md`, `todos/`, `file-history/`, `shell-snapshots/`, `log/`, `archived_sessions/`, sqlite files, `memory/`, `tool-results/`.
- **fs-spy.** With `claudeCode: false` or `codex: false` the monitor makes zero `fs` calls under that root; with both on and both folders absent, Copilot figures are unchanged and the Sources box says "folder not found".
- **Gates (test/core/gates.test.ts).** `JSON.parse(` appears in `src/core/claude.ts` and `src/core/codex.ts` only on scanner slices (count-limited) and not at all in `src/core/jsonScan.ts`; the strings `auth.json`, `history.jsonl`, `rate_limits`, `settings.json` appear in `src/` only in deny-lists or comments; the four new settings have the stated types, defaults and `machine` scope; the copy gate covers the new descriptions; `PANEL_COMMANDS`, `SIDEBAR_COMMANDS` and the `.vsix` list are unchanged; the existing "no hardcoded home folder" gate covers the new files.
- **Probe.** `tools/claude-schema-probe.mjs` and `tools/codex-schema-probe.mjs` (shape-only, same rules as `schema-probe.mjs`: never a value, never a path; abort if an output token contains `/`), wired as `npm run probe:claude` and `probe:codex`. SCHEMA.md gains "Claude Code log schema" and "Codex log schema" sections (verified 2026-11-08) and an explicit note that `token_count`-only Codex files were not observed on this machine.
- **README.** "What it reads" per source (files opened, line filtering, fields kept, never read), the settings table, "What this is not" (other computers, Claude.ai and ChatGPT web usage, Codex archived sessions, that apps built on the Claude Agent SDK write to the same folder and count as Claude Code), and the automated-tests paragraph naming the canary, fs-spy and scanner gates.

### D54: monitor architecture

- `src/core/source.ts` defines the contract: a `SourceReader` per source with `discover(windowStartMs, dayStartMs, nowMs)` returning candidates (`{ sessionId, folderId, path, mtimeMs, live }`), unreadable entries, the root directory mtime, and extras (`archived`, `capped`); and `open(candidate)` returning a `FileReader` whose `read()` yields `{ reset, error, records, totals?, label?, activity, suspect, unrecognized, malformed, overlong, overlongOther }`. a repeated key from the file that first held it is merged by the store (D42); the reader does not flag repeats.
- `src/core/tailer.ts` splits into a byte-level core (`ByteTailer`: open flags, cursor, reset detection, BOM, chunking, carry, over-long skipping, a `LineHandler` callback per complete line and per over-long head) and the existing `LineTailer` as the Copilot handler with its `TailResult` unchanged, so the existing tailer tests stay green.
- `src/core/copilot.ts` wraps `discover.ts`, `extract.ts`, `LineTailer` and the `workspace.yaml` title logic as the Copilot `SourceReader`; its behaviour is unchanged.
- `UsageMonitor` owns one `UsageStore`, the readers for the enabled sources, per-file states keyed by path, hot/cold scheduling, per-source health, and the snapshot. `MonitorOptions` gains `sources: { claude?: { root; rootSource }; codex?: { root; rootSource } }` (absent = off) and keeps `root`/`rootSource` for Copilot. `extension.ts` resolves the two new roots like `copilotHome` and restarts the monitor when any of the four new settings changes.
- Commits land in this order so reviewers can bisect: types + store + scanner + tailer core → Claude Code reader → Codex reader → Copilot adapter + monitor → UI → settings and wiring → docs, probe, perf, version.

## What is left to the builder

Exact signatures and test names (the plan fixes them); the CSS of the chips and the By-source card (follow the Models chips); the exact wording of Data health rows within the copy rules; the perf corpus generator; the order of rows in the Sources box (SOURCES order).
