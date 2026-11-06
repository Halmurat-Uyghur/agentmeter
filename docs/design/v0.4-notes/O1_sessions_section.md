# O1 — v0.4 Sessions section (list + "why it cost")

Reviewer focus: the content of the **Sessions** nav section. Base: worktree at 5602217 (v0.3.2 + daily trend). Read: README, plan §14 (D20–D27), `types.ts`, `store.ts`, `monitor.ts`, `extract.ts`, `panelHtml.ts`, `extension.ts`, research notes (codeburn §Sessions, gap analysis #2/#5/#8/#15).

## 0. Decisions (summary)

| # | Decision | Why |
|---|---|---|
| S1 | Detail is a **selected-session state** set by a new allowlisted command `copilotUsageMonitor.showSession` (arg = session id, `""` clears). Not inline `<details>`. | A `<details>` cannot span a table row cleanly; inline detail for 50 rows bloats HTML and snapshot. One selected detail keeps the snapshot small, is reusable from the side bar and the Current-session KPI, and matches the `setFilter` pattern. |
| S2 | Detail renders at the **top** of the Sessions section, the selected row gets `class="on"`. | Every command re-renders the webview (`retainContextWhenHidden: false`, full HTML replace), so scroll resets to the top. Detail below the table would be off-screen after the click. |
| S3 | **Fixed sort, no sort command.** Rows sort by the headline unit: est. USD in cost view, tokens in tokens view; ties → tokens, then newest `lastMs`, then id. | The unit switch already exists; a sort command widens the allowlist for little gain. "Newest" is answered by the side bar and Daily. Revisit only if users ask. |
| S4 | Snapshot carries **≤ 50 rows**; panel shows 10 and folds 11–50 into the existing `foldedTable` (D27). Beyond 50: one "N more sessions · $X est." line so the list reconciles with the month. The selected session is always kept (`keep: true`). | Reuses D27; snapshot ≈ 15 KB. |
| S5 | "Why it cost" shows **USD split only where AIU is exact** (by model, by initiator, by call) and a **token** split by type. No USD by token type. | AIU is logged per call, not per token type, and D22 ships no price table. A USD-by-type figure would be invented. |
| S6 | Add **one** field to the allowlist: `initiator` (`"user"`/`"agent"` exact match, else dropped). Everything else in the gap list (`maxPromptTokens`, `toolTokenCount`, `finishReason`, latency) stays out of the Sessions section for v0.4. | Initiator is the single field that answers "how much did one of my prompts cost". Others belong to Insights if anywhere. SCHEMA.md lists `initiator` as "deliberately not read" → needs a D-entry and a SCHEMA/README update. |
| S7 | Backfilled ("session total") rows show `—` for calls, growth, tools, initiator and curve; marked with a `Σ total` chip. | `session.shutdown` has no per-call data; `requests.count` is not proven to equal model calls. |

## 1. Sessions list (viewed month)

Columns (left → right):

| Column | Source | Render |
|---|---|---|
| Session | `label` (session title, else project label) + muted `shortId`; `●` if live; `Σ total` chip if `source: "total"` | link → `showSession(id)`; selected row → link clears (`""`) |
| Started | `firstMs` (first in-month call; for totals `sessionStartTime`) | `Nov 4 14:02` |
| Span | `lastMs − firstMs` | `formatDuration`; `—` if one call |
| Calls | `calls` | `—` for totals |
| Models | `models` (≤ 3, costliest first) + `+N` | existing model chips |
| Tokens | `tokens` (input+output, as today) | `.sum` in tokens view |
| USD (est.) | `nanoAiu` | `.sum` in cost view; share bar of month USD (as today) |
| Cache read | `cacheRead.sum / input.sum` (D22: input includes cached) clamped 0..1 | mini bar + `0.62` text, title "6.2 of every 10 input tokens were cache reads". **Not `%`** — the copy gate (`gates.test.ts` `COPY_RE`) bans `%`. `—` if either unreported. |
| Growth | `growth` | as today, `▲` at ≥ `GROWTH_FLAG` |

Dropped from today's table: "Per call" (it is USD ÷ calls; moves into the detail). Header `<small>`: `November 2026 · 37 sessions · 3 session totals · click a row for why it cost`.

Footer `.fine`: growth explanation (existing), "Σ total = Copilot's end-of-session summary for a session without per-call records; it lands on the day the session ended", the "N more" line, and the active filter.

Filters (D26): rows honour project and tool filter like today. Tool filter hides `total` rows (no tool data) and says so once in the footer.

Cross-month sessions: a session with calls in Oct and Nov shows in both months with only that month's calls (current behaviour). Known limitation; no "continues" marker (YAGNI).

Empty month: keep current copy "No per-call records in this month." → "No sessions with usage in this month."

## 2. Session detail — "Why it cost"

One box above the table, title `<label> · <shortId>` + `✕` link (clears). Blocks, in order; each block is omitted when it has no data:

1. **Headline line**: `$2.14 est. · 46 calls · 1.8M tokens · 52 min · $0.047 per call`.
2. **By token type** (tokens, not USD): uncached input (`input − cacheRead`, only if both reported), cache read, cache write, output, reasoning. Bars relative to the largest row, **not** shares that sum to 1 — whether cache write and reasoning are inside input/output is unverified. Fine print says so.
3. **By model**: model chip, calls, tokens, USD est. (exact AIU sums). Reuses `Totals.byModel`.
4. **Who started the calls** (only if ≥ 1 record has `initiator`): "You: 6 calls · $0.31 · Agent loop: 40 calls · $1.83 · ≈ 6.7 agent calls per prompt". Unknown initiator counted as "not logged: N".
5. **Cost per call** (calls source only): ≤ 30 static CSS bars in call order; each bar = mean AIU per call in its bucket (mean, so uneven buckets don't mislead). Peak call: "Costliest call: $0.40 (call 41 of 46)". This is the picture behind ▲.
6. **Top tools**: ≤ 8 tools by uses: name, uses, calls that used it. Row links → `setFilter("tool", name)` (existing command).
7. **Context**: input tokens of the first call vs the last call ("first call 18k → last 142k input"). First-call input is codeburn's "large first-call prefix" without reading `toolTokenCount`.

For `total` rows: blocks 1 (no calls/per call), 2, 3 only, from `modelMetrics`, with "End-of-session summary: no per-call detail."

Copy check: no `%`, no "bill/quota/limit/premium"; "est." on every USD.

## 3. Types (`src/core/types.ts`)

```ts
// UsageRecord: add
initiator?: "user" | "agent";

export interface SessionRow {
  sessionId: string;
  /** display only: workspace title of the session's folder, else project label */
  label?: string;
  source: "calls" | "total";
  firstMs: number;
  lastMs: number;
  /** undefined for "total" */
  calls?: number;
  /** costliest first, at most 3 */
  models: string[];
  modelCount: number;
  tokens: Metric;     // input + output (as SessionSummary today)
  nanoAiu: Metric;
  input: Metric;      // for cache-read share
  cacheRead: Metric;
  growth?: number;
  live?: boolean;
}

export interface SessionDetail {
  sessionId: string;
  source: "calls" | "total";
  /** whole session in the viewed month, filters applied; byModel = by-model block */
  totals: Totals;
  initiator?: { user: Counts; agent: Counts; unknown: number };
  /** mean nanoAiu per call per bucket, ≤ 30, call order; undefined = no AIU in bucket */
  curve?: (number | undefined)[];
  peak?: { nanoAiu: number; index: number };   // 1-based call index
  tools?: { name: string; uses: number; calls: number }[]; // ≤ 8
  firstInput?: number;
  lastInput?: number;
}

// MonthView: replace `sessions: SessionSummary[]` with
sessions: SessionRow[];                                   // ≤ 50, sorted (S3)
sessionsRest?: { count: number; tokens: Metric; nanoAiu: Metric };
// Snapshot: add
session?: SessionDetail;   // only when a selected session is in the viewed month
```

`SessionSummary` is removed (or kept as an alias during the change); the Overview "costliest" mini-list, if any, uses `month.sessions.slice(0, 5)`.

## 4. Store and monitor

**Memory budget.**
- Per-call sessions: **no new long-lived state.** Rows and detail are computed at snapshot time from records the store already holds (the same pass `sessionSummaries` does today). Only cost per record: `initiator` (one short interned string) — negligible against the 50k-record perf suite.
- Session totals (backfill, owned by the backfill reviewer): one `SessionTotal` per folder, `{ folderId, startMs?, endMs, byModel: Record<model, Counts> (≤ 16 models), nanoAiu?: number }` ≈ < 1 KB each; 2,000 sessions ≈ 2 MB worst case. Dropped with its file (`resetFile`). The Sessions section only consumes it; a session with any usage record ignores its total (per-call wins).
- Snapshot: ≤ 50 rows ≈ 15 KB JSON + detail ≈ 3 KB. Stays well inside the `emit` signature cost.

**Store function** (replaces `sessionSummaries`; one pass, pure, exported for tests):

```ts
export function sessionRows(
  store: UsageStore,
  fromMs: number, toMs: number,
  o: {
    keep?: (r: UsageRecord) => boolean;
    totals?: SessionTotal[];          // already filtered to [fromMs, toMs) by endMs and by project
    labelOf?: (sessionId: string, folderId: string) => string | undefined;
    liveOf?: (folderId: string) => boolean;
    unit: "tokens" | "cost";
    limit?: number;                    // default SESSION_ROWS = 50
    selected?: string;
  },
): { rows: SessionRow[]; rest?: MonthView["sessionsRest"]; detail?: SessionDetail };

export function sessionDetail(sessionId: string, recs: UsageRecord[]): SessionDetail; // recs sorted
export function totalDetail(t: SessionTotal): SessionDetail;
```

Note: sort depends on `unit`, so the monitor needs the unit (pass it with `setView`/`setFilter`-style setter), **or** — simpler — sort in the store by AIU-then-tokens and let the renderer re-sort the ≤ 50 rows by tokens in tokens view. Recommend the latter: no unit in the monitor; the top-50 cut is by cost in both views (fine: rows 51+ are the cheap tail either way; documented).

Label: `labelOf` = that folder's `f.title` (read only when the project folder is an ID, unchanged privacy surface) else `projects.get(folderId)`. Label is display-only, never a key.

**Monitor**: `private selectedSession?: string`; `selectSession(id: string | undefined)` sets it, `dirty = true`, refresh. Kept across month/filter changes; if not in the viewed month, `snapshot.session` is undefined and the panel shows nothing (no error).

**Extension** (`showSession` handler): accept only `typeof arg === "string"` and either `""` (clear) or `/^[A-Za-z0-9._-]{1,128}$/` **and** present in `snapshot.month.sessions` or equal to `snapshot.current.folderId`; anything else ignored. Also switches the nav to the Sessions section (whatever O-nav defines) and calls `panel.show()`. Add to `PANEL_COMMANDS` and `enableCommandUris`; README "exactly three commands" → list four; plan gets D28 (Sessions section) and D29 (initiator read).

## 5. Renderer (`panelHtml.ts`)

- `sessionsSection(s, view)` replaces `sessionsBox`: `sessionDetailBox(s, view)` (if `s.session`) + `sessionsTable(s, view)`.
- `sessionsTable`: builds rows with `keep: x.sessionId === s.session?.sessionId`, passes to `foldedTable(head, rows)`; appends the rest line.
- `sessionDetailBox`: the 7 blocks above; small helpers `typeBars(c: Counts)`, `curveBars(curve)`, `initiatorLine(i)`. All strings through `escapeHtml`, all hrefs through `commandHref`.
- `sessionHref(id)` = `commandHref("copilotUsageMonitor.showSession", id)`.
- CSS: reuse `.bar`, `.chipm`, `.on`, `.flag`; add `.curve` (flex row of fixed-width bars, heights via inline `style="height:N%"` — style attribute values are not visible copy, but confirm `COPY_RE` scans text only; current bars already use `width:N%`, so it does).

## 6. Tests

`test/core/store.test.ts` (or new `sessions.test.ts`):
1. Rows group by `sessionId`, sort AIU → tokens → newest → id; cap at 50; `rest` sums count/tokens/AIU of the tail exactly.
2. Selected session beyond the cap is still returned in `detail` (and as a kept row).
3. Cache-read inputs: unreported → share undefined (renders `—`), never 0.
4. `models` costliest first, ≤ 3, `modelCount` correct, unknown model as `(unknown model)`.
5. `total` rows: only for sessions with no usage records; a session with both shows one `calls` row; total lands in the month of `endMs`; tool filter excludes totals; project filter applies.
6. `sessionDetail`: byModel sums equal row; initiator split (user/agent/unknown); curve ≤ 30 buckets with means, `undefined` for unpriced buckets; peak index 1-based; tools top 8 by uses; first/last input.
7. Filter `keep` applies to detail as to row (tool filter → only calls using the tool).

`test/core/extract.test.ts`: `initiator` kept only for exact `"user"`/`"agent"`; `"User"`, `"x"`, numbers, objects, long strings dropped; canary in `initiator` never survives.

`test/core/monitor.test.ts`: `selectSession` → `snapshot.session` set; unknown id → undefined; month switch away → undefined, back → restored; live session detail updates after a new record.

`test/core/panelHtml.test.ts`:
1. Section renders detail **before** the table; selected row has `class="on"` and its link clears (`%5B%22%22%5D`).
2. Every row link is a `command:copilotUsageMonitor.showSession?…` href with the id JSON-encoded; hostile id/label/model/tool escaped.
3. `Σ total` row shows `—` in Calls/Growth and no curve/tools/initiator blocks.
4. Copy check (`COPY_RE`) on visible text of the section in every state — no `%`.
5. Fold: 10 visible, 11–50 inside `<details>`, rest line when `sessionsRest`.
6. Canary never reaches the HTML (labels, ids).

`test/core/gates.test.ts`: `PANEL_COMMANDS` equals the four expected commands and matches `panel.ts` `enableCommandUris`.

Integration (`test/integration`): `showSession` with a non-string, a regex-failing string, and an id not in the snapshot are no-ops.

## 7. Out of scope / later

Sort command; per-session latency, finish reason, context-window fill (`maxPromptTokens`), tool-definition overhead (`toolTokenCount`) — candidates for Insights, not this section; sub-agent cost (`agentMetrics`); codeburn's prompt-level view (needs prompt text — never).
