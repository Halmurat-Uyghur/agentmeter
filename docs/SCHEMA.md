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
**`model`** (str), **`inputTokens`**, **`outputTokens`**, **`cacheReadTokens`**, **`cacheWriteTokens`**, **`reasoningTokens`** (int ≥ 0; real zeros occur), **`duration`** (int, ms), **`copilotUsage.totalNanoAiu`** (int), **`accounting.usageId`** (str, 46 distinct of 46), **`accounting.sequence`** (int, strictly increasing and gap-free per source session, including across `session.resume`), **`accounting.sourceSessionId`** (str, equal to the folder id in 46 of 46).
Also read since v0.3 (D25): **`toolCounts`** (object: tool name → int ≥ 0; at most 64 identifier-like names kept, zeros dropped). On the development machine: 46 of 46 records, 0–2 tools per call (`bash`, `view`, `read_bash`, `rg`, `skill`, `task_complete`, `rename_chat`).
Present but deliberately **not read**: `modelDisplayName`, `cost` (meaning undocumented), `aiCreditsStatus` (reads like allowance data), `copilotUsage.tokenDetails[]`, `initiator`, `isByok`, `provider.*`, `apiEndpoint`, request ids, latencies, byte counts, cache expiry fields.

**`session.start` (since v0.3, D25, only with `projectNames` on).** One per log, first line, at most 829 bytes observed (lines over 16 KB are not decoded). `data.context` keys: `cwd` 39/39, `gitRoot` 33, `branch` 33, `headCommit` 30, `repository` 29, `hostType` 29, `repositoryHost` 29, `baseCommit` 27 (all strings). Only a label is kept: `repository` when it matches `owner/repo`, else the last segment of `gitRoot` or `cwd`.

**Gate safety:** the substring `"session.usage_record"` and `"assistant.turn_end"` occur in 0 lines of any other type.

**Never read:** `user.message`, `assistant.message`, `tool.*`, `hook.*`, `system.message`, any `session.start` field other than the project label above (branch, commits, full paths, prompt), `codeChanges.filesModified`, `session.db`, `workspace.yaml`, `vscode.metadata.json`, `config.json`, `mcp-config.json`, `run/ws.token`, or any other file under the Copilot folder.
