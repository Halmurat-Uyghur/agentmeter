# Copilot log schema

Copied from §3 of [the plan](plans/copilot-usage-monitor-plan.md). Regenerate the figures with `npm run probe` (`tools/schema-probe.mjs`, shape-only) on the machine the extension runs on.

## Verified log schema (2026-11-05, shape-only inspection, re-checked by an independent reviewer)

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
**`model`** (str), **`inputTokens`**, **`outputTokens`**, **`cacheReadTokens`**, **`cacheWriteTokens`**, **`reasoningTokens`** (int ≥ 0; real zeros occur), **`duration`** (int, ms), **`copilotUsage.totalNanoAiu`** (int), **`accounting.usageId`** (str, 46 distinct of 46), **`accounting.sequence`** (int, strictly increasing and gap-free per source session, including across `session.resume`), **`accounting.sourceSessionId`** (str, equal to the folder id in 46 of 46; since v0.4 an id not shaped like a session folder name, `^[0-9a-f-]{8,64}$`, is replaced by the folder id).
Also read since v0.3 (D25): **`toolCounts`** (object: tool name → int ≥ 0; at most 64 identifier-like names kept, zeros dropped). On the development machine: 46 of 46 records, 0–2 tools per call (`bash`, `view`, `read_bash`, `rg`, `skill`, `task_complete`, `rename_chat`).
Also read since v0.6 (numbers and two small enums only; Phase 0 probe of 46 records, see the v0.6 roadmap):
- **`initiator`** (str): mapped to `user` or `agent`; any other value, or a non-string, becomes `other`. The log's string is never kept. On the development machine: user 6, agent 40.
- **`finishReason`** (str): mapped to `stop`, `tool_calls`, `length` or `content_filter`; anything else becomes `other`. Observed: tool_calls 41, stop 5.
- **`toolTokenCount`**, **`availableToolCount`** (int ≥ 0): the tokens of the tool definitions sent with the prompt, and the number of tools offered. `toolTokenCount ≤ inputTokens` in 46 of 46 and constant within a session: tool definitions are **part of** the prompt, so the panel shows them as a share of input, never as an extra cost.
- **`copilotUsage.tokenDetails[]`** (at most 16 entries): per entry only **`tokenType`**, **`tokenCount`**, **`batchSize`** (> 0) and **`costPerBatch`** (ints ≥ 0). `tokenType` is mapped to `input` (uncached), `cache_read`, `cache_write` or `output`; any other type is summed into an `other` bucket, and the string is never kept. The entry's `model` string is **not read**. Each type's AIU is Σ `tokenCount / batchSize × costPerBatch`; the split is kept only when it adds up to `totalNanoAiu` (it did in 46 of 46), else the panel shows `—`. With exactly one cache-read rate in a record, the uncached input tokens are also priced at that rate, for the cache comparison. Any invalid entry drops the whole split.

Token semantics (Phase 0, 46 of 46): `inputTokens` = uncached input + `cacheReadTokens` + `cacheWriteTokens`, so uncached input = `inputTokens − cacheReadTokens − cacheWriteTokens` (for a model whose records show cached > input, input is taken as uncached, the same per-model inference as Insights). `reasoningTokens` is inside `outputTokens`.

Present but deliberately **not read**: `modelDisplayName`, `cost` (meaning undocumented), `aiCreditsStatus` (reads like allowance data), `tokenDetails[].model`, `isByok`, `provider.*`, `apiEndpoint`, `interactionType`, `reasoningEffort`, `reasoningSummary`, `maxPromptTokens`, `numToolCalls`, request ids, latencies, byte counts, cache expiry fields.

**`session.start` (since v0.3, D25, only with `projectNames` on).** One per log, first line, at most 829 bytes observed (lines over 16 KB are not decoded). `data.context` keys: `cwd` 39/39, `gitRoot` 33, `branch` 33, `headCommit` 30, `repository` 29, `hostType` 29, `repositoryHost` 29, `baseCommit` 27 (all strings). Only a label is kept: `repository` when it matches `owner/repo`, else the last segment of `gitRoot` or `cwd`.

**`workspace.yaml` `name:` (since v0.3.2, only with `projectNames` on).** Read only when the label above is an ID (a UUID, or 16–64 hex chars with at least one digit and one letter a-f; all-digit names are not IDs), only after that log changed, and only if it is a regular file (not a symlink) under 16 KB; at most 16 KB + 1 byte is read. If it disappears, grows past 16 KB or stops being a regular file, the title is dropped. Only the first top-level `name:` line is kept: one line, quotes removed, a trailing ` # comment` dropped, `null` / `~` / empty meaning no title, control and format characters (bidi, zero-width) removed, capped at 60 code points. The title is display-only; grouping and the project filter stay keyed by the folder label. Every other key (`cwd`, `git_root`, `branch`, `repository`, `summary`, ...) is ignored.

**`session.shutdown` (since v0.4, D29, only with `sessionTotals` on).** Written once when a session ends, by every format generation above; on the development machine 29 of 39 logs have a shutdown line but no `session.usage_record`. Observed lines are at most ~4 KB; lines over 64 KiB (`MAX_SHUTDOWN_BYTES`) are not decoded and count toward Data health's "Session-end lines too long to read" (`health.shutdownOversize`, which sets `partial` only for a log without per-call records, since otherwise the total would be hidden anyway). A line whose type key is reordered or re-spaced is `suspect`, like a usage line.
- **Removed by the `JSON.parse` reviver** (the bounded line is decoded whole, then the reviver removes these keys while it walks the parsed tree, so they are never copied, returned or logged): `filesModified` (file paths), `accountingSnapshot`, `agentMetrics`, `providerModelMetrics`, `usageAccountingWatermarks`, `currentModel`.
- **Read** (copied into fresh objects): envelope `timestamp`; `data.sessionStartTime` (int, ms; kept only if not after the timestamp); and per entry of `data.modelMetrics.<model>` (at most 64 models; the model id must match the model-id pattern and is never `__proto__`, `constructor` or `prototype`): **`usage.inputTokens`**, **`usage.outputTokens`**, **`usage.cacheReadTokens`**, **`usage.cacheWriteTokens`**, **`usage.reasoningTokens`** (ints ≥ 0), **`requests.count`** (int, the session's call count for that model) and **`totalNanoAiu`** (int). A `totalNanoAiu` of `0` next to non-zero tokens (builds before 1.0.99) is treated as not reported, so USD shows `—`. A model whose tokens are all `0` and whose `requests.count` is `0` or absent is skipped (it logged nothing); a line with only such models counts like an empty `modelMetrics`. A missing `requests.count` shows calls as `—` (or the known calls with `*`), never `0`.
- **Not read:** `requests.cost`, `totalPremiumRequests`, `totalApiDurationMs`, `codeChanges` and every other key on the line.
- Each model becomes one "session total" record keyed `shutdown:<folder id>:<model>`, dated at the shutdown `timestamp`, with no tool data. It is hidden while the same session, or the same session folder, has per-call records, and a later shutdown line for the folder replaces the earlier one. An empty `modelMetrics` counts the log as "without usage data", not as a format change.

**Gate safety:** the substring `"session.usage_record"` and `"assistant.turn_end"` occur in 0 lines of any other type.

**Never read:** `user.message`, `assistant.message`, `tool.*`, `hook.*`, `system.message`, any `session.start` field other than the project label above (branch, commits, full paths, prompt), any `session.shutdown` field other than the totals above (`codeChanges.filesModified` included; with `sessionTotals` off the line is not decoded at all), `session.db`, any `workspace.yaml` key other than `name` (above), `vscode.metadata.json`, `config.json`, `mcp-config.json`, `run/ws.token`, or any other file under the Copilot folder.
