# F1 — Coverage backfill from `session.shutdown` (v0.4, overrides D3)

Reviewer note, 2026-11-06. Read-only review of the worktree at `5602217` (v0.3.2 + daily trend) plus a shape-only probe of the 39 real logs on this Mac (`scratchpad/design/shutdown_probe.mjs`; prints key paths, types, counts, sizes and model ids only). Nothing from the logs is quoted here.

## 0. Decision summary (what to build)

- Decode one more gated line type: `{"type":"session.shutdown"` (≤ 64 KiB). Keep, per model in `data.modelMetrics`: the five `usage.*Tokens` ints, `requests.count`, `totalNanoAiu`; plus the line's `timestamp`, top-level `sessionStartTime` and `totalApiDurationMs`. Nothing else on the line is kept; `filesModified`, `accountingSnapshot` (holds `aiCreditsStatus`), `agentMetrics` and the id-keyed `usageAccountingWatermarks` are dropped by a `JSON.parse` reviver before the tree exists.
- Store them as `UsageRecord`s with `kind: "sessionTotal"`, one per (session, model), `key = "shutdown:<folderId>:<n>"`, dated at the shutdown `timestamp`. Every existing aggregation (today, month, days, by model, by project, costliest sessions, trend, calendar) then works unchanged.
- Dedupe in the store, not at insert time: a session-total record is invisible while the same `sessionId` holds any per-call record (order- and reset-independent). A new shutdown line for a session replaces that session's previous totals (last wins; never summed).
- `totalNanoAiu` of `0` with non-zero tokens is "not logged", not a real zero: legacy sessions get tokens but `—` for AIU/USD, so the USD view, target range and costliest-session ranking never see a fake $0.
- Marker: every `Counts` carries `sessionTotals: n`; the UI prints a footnote/chip "session total" wherever `n > 0`, and the sessions table tags whole rows. Data health gains "Sessions counted from session totals" and "Sessions without usage data".
- Setting `copilotUsageMonitor.sessionTotals` (default `true`); off restores the v0.3 read surface (shutdown lines skipped without decoding).
- Effort: ~3.5 developer-days (M), 7 source files, ~35 new or changed tests.

## 1. Evidence from real logs (shape only)

39 logs, 4,747 lines. 34 `session.shutdown` lines in 33 logs; 29 logs have a shutdown and no `session.usage_record`, 4 have both, 0 have usage records without a shutdown, 6 have neither (crashed or still-open sessions; none of those 6 has a `session.usage_checkpoint` either, so no fallback source exists for them).

**Gate.** All 34 lines start with the bytes `{"type":"session.shutdown"` (key order identical to usage lines). The substring `"session.shutdown"` occurs in 0 lines of any other type. No shutdown line carries `agentId`. 31 of 34 are the last line of their file; the other 3 are followed by a few lines (resume or close-out events).

**Size.** 472 B – 4,021 B (p50 734 B, p90 3,964 B). The big ones are the 1.0.99+ lines that also carry `accountingSnapshot`, `providerModelMetrics` and `tokenDetails`. `"codeChanges"` sits at byte 145–381 and always before `"modelMetrics"` (212–1,240). `filesModified` arrays hold 0–9 entries (p50 0). A 64 KiB cap gives 16× headroom and is still 16× under the 1 MiB carry cap.

**Shape of `data`** (count = lines where present, of 34):
- `shutdownType` str (34, enum: `routine` 34) — not read.
- `modelMetrics` obj (34; `{}` in 4 lines = sessions that never called a model). Per model (33 entries over 30 lines; 28 lines have 1 model, 1 has 2, 1 has 3):
  - `usage.inputTokens`, `usage.outputTokens`, `usage.cacheReadTokens`, `usage.cacheWriteTokens`, `usage.reasoningTokens` — int ≥ 0 in 33/33 (real zeros occur: cacheWrite 15, reasoning 6, cacheRead 2; input max 4.77 M, output max 38 K).
  - `requests.count` — int ≥ 1 in 33/33 (max 50). Verified equal to the number of usage records for that model in all 4 logs that have both.
  - `requests.cost` — int or **float** (0.25 … 72), 33/33. The old premium-request multiplier. Not read (copy ban, meaning changed with token billing).
  - `totalNanoAiu` — int in 32/33, **zero in 27 of 32**; the 5 non-zero values are exactly the 1.0.99-2 / 1.0.100-1 lines. Legacy builds wrote `0`, not an amount.
  - `tokenDetails.{input,output,cache_read,cache_write}.tokenCount` — 5 lines only (1.0.99+). Not read.
- `totalNanoAiu` int (33; zero in 28), `totalPremiumRequests` int/float (34; not read), `totalApiDurationMs` int (34; zero in 4), `sessionStartTime` **int epoch ms** at top level (34/34, ≤ the line's `timestamp` in 34/34; inside `accountingSnapshot` it is an ISO string instead — only the top-level int is read).
- `currentModel` str (31), `currentTokens`, `systemTokens`, `conversationTokens`, `toolDefinitionsTokens` int (34), `eventsFileSizeBytes` int (29) — not read (context composition is feature idea #16, separate).
- `agentMetrics.<agent>` (11 lines; only agent `main`): its `modelMetrics` equal the top-level ones and its `totalNanoAiu` equals the top-level total in every line checked. Reading it would double count. Not read.
- `accountingSnapshot` (5 lines, 1.0.99+): contains `aiCreditsStatus` strings, `currentModel`, `lastCallInputTokens`, a copy of `modelMetrics`, `providerModelMetrics[]` with `provider.*` and `modelDisplayName`, `sessionStartTime` as ISO. Not read (D2: `aiCreditsStatus` reads like allowance data).
- `usageAccountingWatermarks` (5 lines): keys are session UUIDs → int. Not read.
- `codeChanges.{linesAdded, linesRemoved}` int (34; zero in 31/32) and `filesModified[]` of **paths**. Not read; `filesModified` is removed by the reviver.
- Model ids: 7 distinct, all match `MODEL_ID` (`/^[A-Za-z0-9._:\/-]{1,100}$/`).

**Shutdown totals equal the per-call records exactly.** In the 4 logs with both sources, for every model: the five token fields, `requests.count` (= record count), `totalNanoAiu` (= Σ `copilotUsage.totalNanoAiu`) and `totalApiDurationMs` (= Σ `duration`) match to the unit. Summed over all 39 logs, the last-shutdown `totalNanoAiu` equals the usage-record AIU total (4,893,604,500 nAIU), and the 29 shutdown-only logs contribute 0 nAIU. So: (a) "ignore the shutdown when per-call records exist" loses nothing; (b) on this machine the backfill adds **tokens for 29 sessions and no USD**.

**Multiple shutdowns are cumulative.** One log (1.0.99-2) has 3 `session.resume` and 2 `session.shutdown` lines 121 h apart. Both carry identical per-model totals, identical `sessionStartTime` and `totalApiDurationMs`; only `eventsFileSizeBytes` grew. Totals are therefore running totals since session start, not per-segment deltas. Rule: the last shutdown line replaces the earlier one; never add them. (CodeBurn computes per-leg deltas between consecutive shutdowns; that is a v0.4.x refinement only if a legacy session with growing totals across shutdowns ever appears — add a probe check for it, see §9.)

**Dating.** Session length (`sessionStartTime` → shutdown): p50 0.5 h, p90 9.6 h, max 5.1 days; 3 of 34 cross a local midnight. Dating the whole total at the shutdown instant is therefore right for ~90 % of sessions and shifts ~10 % by a day; month totals are only affected at month boundaries. This is what the owner asked for and what the "session total" label must say.

**Versions.** Shutdown lines with usable `modelMetrics` exist from 1.0.43 through 1.0.100-1, including `0.0.0` and `unknown` builds. Per-call records start at 1.0.99-2.

## 2. Line gate and allowlist (`src/core/extract.ts`)

```ts
export type LineClass = "usage" | "start" | "shutdown" | "activity" | "suspect" | "skip";
const SHUTDOWN_TYPE = "session.shutdown";
const SHUTDOWN_PREFIX = typePrefix(SHUTDOWN_TYPE);          // {"type":"session.shutdown"
/** Observed max 4 KB; the cap bounds both memory and the transient path exposure. */
export const MAX_SHUTDOWN_BYTES = 64 * 1024;
const SHUTDOWN_NEEDLES = [Buffer.from(`${TYPE_KEY}${SHUTDOWN_TYPE}"`), Buffer.from(`"type": "${SHUTDOWN_TYPE}"`)];
export function hasShutdownNeedle(buf, start, end): boolean;  // same raw search as hasUsageNeedle
```

`classifyLine`: after the `start` check, `if (startsWith(SHUTDOWN_PREFIX)) return "shutdown";` (no size check here, the tailer counts oversize lines); the fallthrough becomes `hasUsageNeedle(...) || hasShutdownNeedle(...) ? "suspect" : "skip"`. A reordered or re-spaced shutdown line is therefore `suspect` → `unrecognized` → `format-changed`, the same alarm as for usage lines: losing all legacy coverage silently would contradict the README's "it does not quietly show smaller numbers". (Alternative if the owner finds the warning icon too loud for a secondary source: a separate `shutdownUnrecognized` counter that only shows in Data health. Not recommended.)

Safety argument, same as for the usage needle: inside a JSON string value every `"` is escaped as `\"`, so prompt or tool text cannot contain the raw bytes `"type":"session.shutdown"`; verified 0 hits in 4,713 non-shutdown lines.

`isKnownNonUsage` stays as is (a shutdown line over 1 MiB is "known non-usage"), but `LineTailer.countOverlong` checks `startsWith(SHUTDOWN_PREFIX)` first and counts `shutdownOversize` instead of `overlongOther` (§3).

```ts
export type UnrecognizedReason = ... | "no-model-metrics";
export type ShutdownParseResult =
  | { kind: "totals"; records: UsageRecord[] }   // ≥ 1 record
  | { kind: "empty" }                            // modelMetrics is {} — a session that never called a model
  | { kind: "ignored" }                          // valid JSON of another type
  | { kind: "unrecognized"; reason: "no-model-metrics" | "bad-timestamp" | "no-known-token-field" }
  | { kind: "malformed" };

const DROP = new Set(["filesModified", "accountingSnapshot", "agentMetrics", "providerModelMetrics", "usageAccountingWatermarks", "currentModel"]);
export function parseShutdownLine(line: string, folderId: string): ShutdownParseResult {
  // JSON.parse(line, (k, v) => DROP.has(k) ? undefined : v): the parsed tree never holds a path,
  // an aiCreditsStatus or a session-id map. (Tokenisation still touches the bytes; nothing survives it.)
  // Order of checks: malformed → ignored → no-model-metrics → bad-timestamp → per-model entries → empty / no-known-token-field.
}
```

Per model entry `i` (in `Object.entries` order):
- `model`: the key, kept only if `MODEL_ID` matches, else `undefined` → "(unknown model)".
- `tokens`: `count(usage.inputTokens)` etc. — same `count()` as usage lines (safe int ≥ 0, else absent, never 0). An entry with no valid token field at all is skipped; if every entry is skipped → `no-known-token-field`.
- `calls`: `count(requests.count)`; absent if invalid (→ `calls.missing`).
- `nanoAiu`: `count(totalNanoAiu)`, **then `0` → absent when `input + output + cacheRead + cacheWrite > 0`** (D28c below). A real `0` with zero tokens stays `0`.
- `durationMs`: `count(data.totalApiDurationMs)` only when the line has exactly one model entry (28 of 30 non-empty lines); with two or more models it is absent on every entry (the line gives no per-model split; "Model time" then shows `*` with "reported by N of M records", which is honest).
- `startedMs`: `count(data.sessionStartTime)` if `≤ timestampMs`.
- `timestampMs`: `Date.parse(event.timestamp)`; `sessionId = folderId` (no `accounting` on the line); `key = "shutdown:" + folderId + ":" + i`; `keySource: "shutdown"`; `kind: "sessionTotal"`; no `sequence`, no `tools`.

Never read: `requests.cost`, `totalPremiumRequests`, `shutdownType`, `codeChanges.*`, `currentTokens`, `systemTokens`, `conversationTokens`, `toolDefinitionsTokens`, `eventsFileSizeBytes`, `tokenDetails`, everything in `DROP`.

## 3. Tailer (`src/core/tailer.ts`)

- `TailerOptions.decodeShutdown?: boolean` (default `false`, like `decodeStart`).
- `TailResult` gains `shutdownLines: string[]` and `shutdownOversize: number`.
- `gate()`: `case "shutdown"`: if `!decodeShutdown` break; if `end - start > MAX_SHUTDOWN_BYTES` → `out.shutdownOversize++` (not decoded); else push the decoded line (trailing `\r` stripped, as for usage).
- Over-long path (> 1 MiB): in `gate()`'s over-long branch, `hasShutdownNeedle` whole-line → `shutdownOversize++` (not `overlong`); in `countOverlong` (streamed head), `startsWith(SHUTDOWN_PREFIX)` → `shutdownOversize++` before the `isKnownNonUsage` check. Both are theoretical (4 KB observed) but keep the counters truthful.

The partial-line carry, reset and resync logic is untouched; a shutdown line is one more class in the same switch.

## 4. Types and store (`src/core/types.ts`, `src/core/store.ts`)

```ts
export interface UsageRecord {
  key: string;
  keySource: "usageId" | "eventId" | "shutdown";
  /** "call": one session.usage_record; "sessionTotal": one model's running total from session.shutdown */
  kind: "call" | "sessionTotal";
  sessionId: string; folderId: string; timestampMs: number;
  /** sessionTotal only: data.sessionStartTime, for the sessions table date range */
  startedMs?: number;
  sequence?: number; model?: string; tokens: Tokens; durationMs?: number; nanoAiu?: number;
  /** model calls this record stands for: 1 for a call, requests.count for a session total; absent if not reported */
  calls?: number;
  tools?: Record<string, number>;
}
export interface Counts {
  records: number;          // rows aggregated (internal; was shown as "Calls")
  calls: Metric;            // NEW — every "Calls" cell/badge reads this
  sessionTotals: number;    // NEW — rows that are session totals (the marker)
  input: Metric; ...; nanoAiu: Metric;
}
```

`parseUsageLine` sets `kind: "call"`, `calls: 1`. `accumulate()` adds `count(c.calls, r.calls)` and `if (r.kind === "sessionTotal") c.sessionTotals++`.

`UsageStore`:
- `private callsPerSession = new Map<string, number>()` — maintained in `add()` (`kind === "call"` only, counted once per key) and `resetFile()` (decrement when an entry is deleted).
- `private visible(r): boolean { return r.kind === "call" || !this.callsPerSession.has(r.sessionId); }` applied inside `totals`, `totalsByBucket`, `records`, `latest`. One Map lookup per session-total row; call rows short-circuit.
- `setSessionTotals(sessionId: string, file: string, records: UsageRecord[]): boolean` — deletes every entry whose key starts with `shutdown:<sessionId>:`, inserts the new ones with `files = {file}`, returns whether anything changed (for the snapshot `changed` flag). This is the "last shutdown wins" rule and also drops a model that vanished between two shutdown lines.
- `sessionTotalSessions(): Set<string>` — session ids with at least one *visible* session-total record (for Data health).
- `add()` is unchanged for call records (multi-file dedupe by `usageId` stays).

`projectSummaries`: `g.s.calls += r.calls ?? 0` (the `calls` number stays a plain count). `toolSummaries`: unchanged (session totals have no `tools`, so the tool table and a tool filter never include them — stated in the panel's fine print). `sessionSummaries`: `calls` = Σ `r.calls ?? 0`; `firstMs = min(r.startedMs ?? r.timestampMs)`; add `sessionTotal: boolean` (true iff every record of the session is a session total — by construction all-or-nothing per session); `growth` stays undefined (needs ≥ 10 priced calls). Sorting unchanged: legacy sessions have no AIU, so they sort after priced sessions by tokens.

`daysOfMonth`, `byMonth`: unchanged — bucketing is by `timestampMs`, i.e. the shutdown instant.

## 5. Monitor (`src/core/monitor.ts`)

- `MonitorOptions.readTotals?: boolean` (default `false` in the core; the extension passes the setting, default `true`). Tailers are created with `decodeShutdown: this.readTotals`.
- `FileState` gains `shutdownOversize: number` and `hasTotals: boolean`. `readFile()`: after the usage loop, `for (const line of r.shutdownLines)`: `totals` → `if (store.setSessionTotals(f.folderId, path, records)) { changed = true; added += records.length; f.hasTotals = true }`; `empty` → nothing; `malformed` → `f.malformed++`; `unrecognized` → `f.unrecognized++`. `changed` also when `r.shutdownLines.length > 0 || r.shutdownOversize > 0`. On `reset`: `store.resetFile(path)` already removes the totals; zero `shutdownOversize`, clear `hasTotals`.
- `snapshot()` health loop: `shutdownOversize` summed into `Health.shutdownOversize`; `partial = unreadableFiles + malformed + overlong + shutdownOversize > 0`. The "sessions without usage" loop becomes: `if (f.activity === 0 && !f.hasTotals) continue; if (f.usage > 0) continue; if (fromTotals.has(f.folderId)) { sessionsFromTotals++; continue; } ...existing silent-live / sessionsWithoutUsage logic` where `fromTotals = store.sessionTotalSessions()` (store-derived so a hidden total never counts as coverage).
- Health state: `no-data` still means "no record dated today"; a legacy session that ended today now makes `today` defined and the state `ok`. The silent-live format-change rule (`FORMAT_ACTIVITY`) is unchanged: a live session has no shutdown yet, so nothing new can trigger or mask it.
- `current`: a session-total record is eligible exactly like a call record (`latest()` dates it at the shutdown). A legacy session that just ended can become "Current session (ended)" with its total; the badge says "ended · session total". Pinning works the same.
- Nothing else changes: discovery (mtime window), the 10 s rediscover, `emit` signature, month selection, filters (the project filter applies to session totals through the same `session.start` label; the tool filter excludes them).

```ts
export interface Health {
  ...
  /** sessions with activity but neither per-call data nor a session total (still open, crashed, or pre-1.0.43) */
  sessionsWithoutUsage: number;
  /** NEW: sessions whose figures come from a session total only */
  sessionsFromTotals: number;
  /** NEW: session.shutdown lines over MAX_SHUTDOWN_BYTES, not decoded; feeds `partial` */
  shutdownOversize: number;
}
```

## 6. Where the totals appear, and the "session total" marker

| View | Behaviour | Marker |
|---|---|---|
| Status bar | `tok` includes session totals of sessions that ended today (the number can jump by a whole session at once). USD view unchanged for legacy sessions (no AIU). | Tooltip "Local today" line appends "(incl. N session totals)". |
| Today / Current session tiles | Sums include them; "Calls" tile shows `calls` (Σ `requests.count`), not rows. AIU/USD tiles show `*` with "reported by N of M records" when mixed, `—` when only legacy. | Fine print: "Includes N session total(s): sessions without per-call records, counted once per model at the moment the session ended." |
| KPI row | Today/month values and "N calls" sub-lines use `calls`. | "· incl. N session totals" in the sub-line when `> 0`. |
| By model | Rows merge call and total records per model; "Calls" from `calls`; "Per call" = USD ÷ calls (`—` without AIU). | Footnote when any row has `sessionTotals > 0`. |
| By project | Works (label from `session.start`, present on legacy logs too); `calls` summed. | None per row; the box footnote names the count. |
| By tool | Unaffected; a tool filter hides session totals. | Fine print: "Session totals carry no tool data and are not shown here." |
| Costliest sessions | Legacy sessions appear with dates `startedMs – shutdown`, calls, tokens, USD `—`, growth `—`. | Calls cell gets a chip `session total`; growth title "Session total: no per-call records". Empty-state text becomes "No sessions in this month." |
| Daily trend / calendar | The day of the shutdown carries the whole session. | Day `title` attribute appends "incl. session total". |
| Monthly trend | Includes them. | Nothing extra (month KPI footnote covers it). |
| Data health | New facts: "Sessions counted from session totals", "Sessions without usage data" (renamed), "Session-end lines too long to read" (only when > 0, warn). | — |
| Banner | New `TOTALS_NOTE` shown under `STREAMING_NOTE` whenever `health.sessionsFromTotals > 0`: "A session without per-call records appears as one session total when it ends, dated at that moment." | — |
| `NOT_COVERED[1]` | Rewrite: "Sessions from Copilot before 1.0.99 have no per-call records; they are counted from the session total Copilot writes when the session ends (one figure per model, dated at that moment, no estimated USD). A session that is still open or that crashed adds nothing until it ends." | — |

All new copy passes `COPY_RE` (no bill/billing/remaining/quota/limit/allowance/premium, no `%`). "session total" is the only new term; it never appears on a figure built from per-call records only.

## 7. Decisions to record in the plan (D28, overriding D3)

- **D28a — Source.** `session.shutdown` per-model totals are read for every session; they count only for sessions with no per-call record (store-level visibility, §4). The `session.usage_checkpoint` line is *not* read: it would only help crashed sessions, and 0 of the 6 crashed logs here have one.
- **D28b — Dating.** A session total is dated at its shutdown `timestamp` (whole session on one day; ~10 % of sessions cross midnight). Multiple shutdown lines are cumulative; the last one replaces earlier ones.
- **D28c — AIU zero.** A per-model `totalNanoAiu` of `0` alongside non-zero tokens is treated as unreported (legacy builds wrote `0`). Legacy sessions therefore show tokens, never a fake `$0.00`, and never move the status-bar USD figure or the target state. No price table is shipped for them (D22 stands).
- **D28d — Surface.** Fields read/dropped as in §2; `filesModified`, `accountingSnapshot`, `agentMetrics` are removed by the parse reviver; the line is decoded only when ≤ 64 KiB and the setting is on. Plan §4 "Bytes in memory" and SCHEMA/README "What it reads" are updated accordingly.
- **D28e — Format alarm.** A shutdown line with reordered keys or without `modelMetrics` counts as `unrecognized` (format-changed), like a usage line.

## 8. Edge cases

1. **Session still open** (no shutdown yet): nothing counted; listed under "Sessions without usage data". When it ends, the status bar may jump by the whole session.
2. **Crashed session** (never writes a shutdown): never counted (6 of 39 here). Documented in `NOT_COVERED`.
3. **Resumed session** with a second shutdown: last wins (§1 evidence). A session that resumes on a later day moves its whole total to the later day.
4. **Legacy shutdown, then resume under a newer Copilot that writes usage records**: the per-call records hide the total as soon as the first one is added, whatever the read order (store-level rule).
5. **Empty `modelMetrics`** (`{}`, 4 of 34): `kind: "empty"`, no record, no health effect.
6. **Two or three models in one session**: one record per model; `durationMs` absent on each (no per-model split) → "Model time" starred.
7. **Model id failing `MODEL_ID`**: record under "(unknown model)"; key by ordinal, so two hostile ids never collide.
8. **`requests.count` missing or invalid**: `calls` absent → "Calls" shows `*` with the reported-by note; tokens still counted.
9. **AIU `0` with zero tokens**: kept as a real `0` (consistent with "never show 0 unless logged").
10. **Shutdown line over 64 KiB**: not decoded; `shutdownOversize` → `partial` with the reason "N session-end line(s) too long to read". Over 1 MiB: same counter via the over-long paths.
11. **Reordered keys / no `modelMetrics`**: `suspect` / `unrecognized` → `format-changed`.
12. **Month window**: the shutdown line is the file's last write, so file mtime ≈ shutdown time and discovery agrees with the dating. A log that leaves the window drops its totals with its records (existing `resetFile` on rediscover).
13. **Project filter** applies (label from `session.start`); **tool filter** excludes session totals; both documented in the panel.
14. **Setting off**: tailers are built without `decodeShutdown`; shutdown lines are counted as `skip`; `Health.sessionsFromTotals` is 0; the v0.3 numbers return exactly. Changing the setting rebuilds the monitor (same path as `projectNames`).
15. **Sub-agents**: `agentMetrics` holds only `main` here and duplicates `modelMetrics`; not read, so no double count. If a future build adds other agents to `modelMetrics` itself, the totals still match what Copilot bills the session.
16. **Existing fixture `otherEvent("session.shutdown")`** (`test/core/monitor.test.ts:288`, "legacy only") has a `data` object without `modelMetrics` → would now count as `unrecognized`. Migrate it to `shutdownEvent({ models: {} })` (becomes the `no-data` case) and add the counted variant.

## 9. Tests and fixtures

**`test/fixtures/build.ts`** — add:
```ts
export interface ShutdownModel { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; reasoningTokens; requests; totalNanoAiu }
export interface ShutdownFixture { models: Record<string, Partial<ShutdownModel>>; totalNanoAiu; totalApiDurationMs; sessionStartTime: number; id; timestamp }
export function shutdownEvent(o?: Partial<ShutdownFixture>): object
```
Defaults: one model `model-a` with the usage fixture's numbers ×6, `requests: 6`, `totalNanoAiu: 12_000_000_000`, `totalApiDurationMs: 9000`, `sessionStartTime = Date.parse(timestamp) - 3_600_000`. Always present and canary-filled: `shutdownType: "routine"`, `currentModel: CANARY`, `codeChanges: { linesAdded: 1, linesRemoved: 2, filesModified: [CANARY, CANARY] }`, `accountingSnapshot: { aiCreditsStatus: CANARY, currentModel: CANARY, sessionStartTime: CANARY }`, `agentMetrics: { main: { modelMetrics: <copy>, totalNanoAiu } }`, `usageAccountingWatermarks: { [CANARY]: 1 }`, `requests.cost: 0.25`, `totalPremiumRequests: 3`. `type` first; `undefined` keys omitted via `compact()`.

**`test/core/fixtures.test.ts`**: `shutdownEvent()` serialises starting with `{"type":"session.shutdown"`; `filesModified` and `aiCreditsStatus` contain `CANARY`; `models: {}` yields `"modelMetrics":{}`.

**`test/core/shutdown.test.ts`** (new; `classifyLine` + `parseShutdownLine`):
1. prefix → `"shutdown"`; `user.message` whose content quotes the type → `"skip"`; `{"id":"x","type":"session.shutdown",…}` and `{"type": "session.shutdown"` → `"suspect"`; bounds respected (a shutdown past `end` does not make an earlier line suspect).
2. `extracts per-model totals`: two models → two records deep-equal to the expected shape (`kind`, `key: "shutdown:f:0"/"…:1"`, `keySource`, `sessionId: "f"`, `timestampMs`, `startedMs`, `tokens` ×5, `calls`, `nanoAiu`); `durationMs` absent on both.
3. `one model gets the session duration`: `durationMs === totalApiDurationMs`.
4. `aiu zero with tokens is absent`; `aiu zero with zero tokens is kept`.
5. `real zeros kept` for the five token fields; `wrong types absent, not zero` (`"1000"`, `-5`, `1.5`, `null`, `2**60`) for tokens, `requests.count`, `sessionStartTime` (also `sessionStartTime > timestamp` → absent).
6. `canary never extracted`: `JSON.stringify(result)` lacks `CANARY`; the record has no `tools`, `sequence`, `linesAdded` keys.
7. `empty modelMetrics → empty`; `missing modelMetrics → no-model-metrics`; `entry without usage object skipped`; `all entries lack tokens → no-known-token-field`; `bad timestamp`; `malformed`; `other type → ignored`; order: missing metrics **and** bad timestamp → `no-model-metrics`.
8. `hostile model ids`: `"[x](command:y)"`, 101 chars → `model` undefined, keys still distinct.
9. `skip lines are never decoded` (existing test extended with a 200 KB shutdown-named canary line when `decodeShutdown` is off — spy `Buffer.prototype.toString`).

**`test/core/tailer.test.ts`**: `shutdown lines decoded only with decodeShutdown`; `over MAX_SHUTDOWN_BYTES counts shutdownOversize and is not decoded`; **`test/core/overlong.test.ts`**: a 5,000-byte shutdown line with `maxCarryBytes: 1024` → `shutdownOversize 1`, `overlongOther 0`, whole-chunk and split-head variants.

**`test/core/store.test.ts`**: `setSessionTotals replaces the session's previous totals` (model dropped in the second line disappears); `session totals hidden while the session has call records — both insertion orders`; `resetFile of the call file un-hides the totals; resetFile of the totals file removes them`; `calls metric: call = 1, total = requests.count, missing when absent`; `sessionTotals counted in totals and byModel`; `latest() and records() skip hidden totals`; `sessionSummaries: sessionTotal flag, firstMs from startedMs, growth undefined, calls summed`; `projectSummaries sums calls`.

**`test/core/monitor.test.ts`**: `legacy session total counted on its shutdown day` (today defined, `today.calls.sum === 6`, `today.sessionTotals === 1`, `health.sessionsFromTotals === 1`, state `ok`); `legacy only with empty metrics → no-data` (migrated test); `session with usage records and a shutdown is counted once` (today equals the usage sum; `sessionTotals 0`); `two shutdown lines count once`; `shutdown then later usage records hides the total`; `shutdown dated yesterday feeds the month, not today`; `readTotals off: shutdown lines never decoded` (fs spy unchanged, `today` undefined, `sessionsWithoutUsage 1`); `unrecognized shutdown line → format-changed, earlier records still counted`; `oversize shutdown line → partial, shutdownOversize 1`; `truncation with a shutdown line`; `month rollover forgets totals`; `project filter keeps / tool filter drops session totals` (in `filters.test.ts`); `canary: no emitted snapshot contains log content` (fixture now includes `shutdownEvent`).

**`test/core/format.test.ts` / `panelHtml.test.ts`**: tooltip shows "(incl. N session totals)" and the health line only when `> 0`; `TOTALS_NOTE` present iff `sessionsFromTotals > 0`; tiles footnote; "Calls" cells read `calls` (per-call-only snapshots render the same numbers as before); sessions row has the `session total` chip and `—` growth; Data health facts renamed; copy check on every state; `JSON.stringify(snapshot)` and HTML lack `CANARY`. **`gates.test.ts`**: README copy check still passes after the README edits. **`perf.test.ts`**: one `shutdownEvent` per synthetic log (40) plus 20 legacy-only logs; budgets unchanged (≤ 4 KB per line; ~60 extra records).

**Integration (`extension.test.ts`)**, optional: a legacy session folder with a shutdown dated now → `_testState().snapshot.today.sessionTotals === 1` within 3 s.

**Probe (`tools/schema-probe.mjs`)**: print shutdown line size percentiles, models per line, the zero-AIU count, and for logs with > 1 shutdown whether per-model totals are non-decreasing (cumulative check). `docs/SCHEMA.md` gets a "`session.shutdown` (since v0.4, D28)" section from §1 above.

## 10. Files and effort

| File | Change | Effort |
|---|---|---|
| `src/core/extract.ts` | `SHUTDOWN_PREFIX`, `hasShutdownNeedle`, `classifyLine`, `MAX_SHUTDOWN_BYTES`, `parseShutdownLine` + reviver; `parseUsageLine` sets `kind`/`calls` | 0.5 d |
| `src/core/tailer.ts` | `decodeShutdown`, `shutdownLines`, `shutdownOversize`, over-long paths | 0.25 d |
| `src/core/types.ts`, `src/core/store.ts` | `kind`, `calls`, `startedMs`, `Counts.calls/sessionTotals`, `callsPerSession` + `visible()`, `setSessionTotals`, `sessionTotalSessions`, summaries | 0.5 d |
| `src/core/monitor.ts` | `readTotals`, `FileState.hasTotals/shutdownOversize`, `readFile` loop, health counts | 0.5 d |
| `src/core/format.ts`, `src/core/panelHtml.ts` | `TOTALS_NOTE`, `NOT_COVERED[1]`, tooltip lines, `formatCalls`, footnotes, chips, health facts | 0.5 d |
| `src/extension.ts`, `package.json` | setting `copilotUsageMonitor.sessionTotals`, rebuild on change, version 0.4.0 | 0.25 d |
| Tests + fixtures (above) | ~35 cases | 1 d |
| `README.md`, `CHANGELOG.md`, `docs/SCHEMA.md`, plan §4 + D28, `tools/schema-probe.mjs` | docs | 0.25 d |
| **Total** | | **≈ 3.5 d (M)** |

Order: extract → tailer → store → monitor → UI → docs, each with its tests first (the plan's TDD convention). The store-level dedupe and the `calls` metric are the two changes that touch existing behaviour; everything else is additive.

## 11. Risks and open points for the owner

- **No USD for legacy sessions** (D28c): on this machine the feature adds tokens for 29 sessions and nothing to the USD view. If the owner expected cost history, the only route is a bundled price table (rejected by D22) — flag before building.
- **Coarse dating**: ~10 % of sessions land a day late; acceptable per the brief, but the daily chart's peak day can now be a session-end day. The marker makes it explainable.
- **One-sample evidence for "cumulative"**: a single resumed session, and it was a 1.0.99+ one (ignored anyway). The probe check in §9 keeps this verifiable on the target machine.
- **Transient path exposure**: a shutdown line is decoded whole; the reviver and the 64 KiB cap bound it, and nothing is kept. This widens plan §4 the same way `session.start` did in v0.3; the setting lets a user opt out.
- **Format alarm sensitivity** (D28e): a Copilot update that changes only the shutdown line would raise the warning icon; this is the intended behaviour but is new noise for users on current Copilot who already have per-call data for every session.
