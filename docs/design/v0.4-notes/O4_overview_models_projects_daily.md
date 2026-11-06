# O4 — v0.4 content: Overview, Models, Projects & Tools, Daily

Reviewer focus: what each of these four nav sections shows, how session-total (shutdown) data appears in each, which filters apply, plus types, renderer signatures, tests and effort. Read-only review of `src/core/{types,store,monitor,panelHtml,format}.ts` at 5602217.

## 0. One cross-cutting decision: how session totals flow through aggregation

The ingest design belongs to another reviewer. My sections only need this contract. It is also the cheapest option, because every existing aggregator (`totals`, `totalsByBucket`, `daysOfMonth`, `byMonth`, `projectSummaries`) then works unchanged:

- Ingest turns each `session.shutdown` `modelMetrics.<model>` into one **synthetic `UsageRecord`**: `key = "end:<sessionId>:<model>"`, `timestampMs = shutdown time`, tokens and `nanoAiu` from that model's sums, **no `tools`**, and a new marker field.
- The synthetic record is kept only if the session has **no** per-call record (per-call wins; no residual math, YAGNI). The dedupe is a `keep` predicate built in `snapshot()` from the set of sessionIds that have per-call records. That way a late-arriving per-call record removes the session's synthetic row on the next snapshot without store surgery.

```ts
// types.ts
export interface UsageRecord {
  // ...existing
  /** v0.4: "session-total" = one model's sums from session.shutdown, for a session with no per-call record. */
  source?: "session-total";
}

export interface Counts {
  /** per-call records only (unchanged meaning: "calls") */
  records: number;
  // input/output/cacheRead/cacheWrite/reasoning/durationMs/nanoAiu now INCLUDE session totals
  // ...
  /** v0.4: the session-total part of the sums above; undefined when there is none */
  ended?: { rows: number; sessions: number; counts: Omit<Counts, "ended"> };
}
```

`accumulate()` puts a synthetic record into the main metrics (so headline numbers are complete everywhere: status bar, KPIs, trend, calendar, daily) and into `ended.counts`. It does **not** increment `records`. `ended.sessions` needs distinct ids: track a `Set` during the pass and drop it before returning (or count in `snapshot()` if keeping `Counts` plain is preferred).

Rule of thumb for every renderer below:
- **Sums** (tokens, USD, AIU, shares, day and month totals) include session totals.
- **Per-call figures** (calls, per call, growth, tools, hour of day) exclude them. Compute them from `total − ended.counts`.
- Wherever session totals are part of a figure, a footnote gives the count: "includes N ended sessions without per-call detail (whole session dated on the day it ended)".

`format.ts` helper: `endedNote(c: Counts | undefined): string | undefined`. It returns `"Includes 3 sessions logged only as totals at session end (dated on their end day)."` or undefined. One string, reused in every section, so the copy-rule tests cover it once.

Filters with session totals:
- Project filter applies to them. The project label comes from `session.start` in the same log.
- Tool filter excludes them automatically (`byTool` needs `r.tools`). Each section that honours the tool filter then adds "N ended sessions hidden: no per-tool detail".

## 1. Overview

**Shows:** the KPI row, the monthly trend (existing `trend()`), and one "Biggest this month" line. Nothing else; the details live in the other sections.

KPI row (4 tiles; existing `kpi()` helper):
1. **Today** — unchanged (unfiltered, live).
2. **Current session** — unchanged.
3. **Last 7 days** — new. Value = sum of the last 7 local days including today. Sub-line: `▲ 18% vs prior 7` / `▼ 4%` / `new` (prior = 0 or undefined) / `—` (neither period has data). Session totals are included and dated on their end day.
4. **<Month>** — existing tile. The sub-line gains a pace comparison: `Nov 1–6 $9.10 vs Oct 1–6 $6.40 (+42%)`. When a target range is set, the existing `targetKpi` state moves into the sub-line as `· target $20–40: in range`. The status-bar icon logic is unchanged. When no range is set, the AIU tile is dropped from Overview (AIU stays in the Models table and the Today detail tiles). Four tiles still fit the grid.

Pace definition: `[prevMonthStart, prevMonthStart + (now − monthStart))`, clamped to the end of the previous month (so Mar 30 compares against all of Feb). For a past viewed month: the full month vs the full previous month, labelled "vs October". If the previous month is outside `historyMonths`, show `—` with the title "previous month not loaded (historyMonths)". If the prior period contains session totals and no per-call data, add `†` to the comparison: it is still comparable, because sums include session totals, but day attribution is coarse.

"Biggest this month" line (fine text, one line): `Top model claude-sonnet-5.5 (61%) · top project api-server (44%) · top tool github-mcp-server (12 calls)`. Each name links to its section anchor or nav item, per the nav reviewer. The data comes from `month.totals.byModel`, `month.projects[0]` and `month.tools[0]`, so there is no new aggregation.

**Filters:** Today and Current session ignore filters (existing rule D26). Last 7 days, Month+pace, trend and Biggest follow the project/tool filter. Last 7 days ignores the month picker (it is "now", like Today); Month+pace follows the picker.

```ts
// types.ts
export interface PeriodCompare {
  fromMs: number; toMs: number;           // current period [from, to)
  priorFromMs: number; priorToMs: number; // comparison period
  current?: Totals;                       // undefined = no record
  prior?: Totals;
  /** false when the prior period starts before the history window */
  priorLoaded: boolean;
}
export interface Snapshot { /* ... */ last7?: PeriodCompare; }
export interface MonthView { /* ... */ pace?: PeriodCompare; }

// store.ts
export function lastNDays(now: Date, n: number): { fromMs: number; priorFromMs: number }; // local-midnight, DST-safe
export function compare(store: UsageStore, cur: [number, number], prior: [number, number], windowStartMs: number, keep: Keep): PeriodCompare;

// format.ts
export function changePct(cur: number | undefined, prior: number | undefined): { text: string; dir: "up" | "down" | "flat" | "new" | "none" };

// panelHtml.ts
function overviewSection(s: Snapshot, view: ViewOptions): string; // = kpis() + trend() + biggestLine()
function kpis(s: Snapshot, view: ViewOptions): string;             // modified
function biggestLine(s: Snapshot, view: ViewOptions): string;
```

`changePct` rules: integer %, `+` or `−` sign, "new" when prior ≤ 0 and cur > 0, and `—` when either side is undefined. Never "∞". Use ▲ and ▼ text symbols plus words in the title attribute, never colour alone. Up is *not* coloured red: more usage is not "bad" by itself. The only amber state stays target "over".

Effort: about 1 day (store helpers 2h, kpis rework 3h, tests 3h).

## 2. Models

**Scope change:** today the table shows *Today* for the current month and the month for a past month (`modelTable`). For v0.4, the Models section shows the **viewed month** always. "Today by model" is already covered by the Today detail tiles, and a whole-month scope makes share and cache figures meaningful. Keep the existing renderer and widen its scope.

Columns: `Model | Share | Input | Output | Cache read | Cache share | Tokens | USD (est.) | Per call | Calls`
- **Share** = % of the month's headline unit (tokens or USD). The existing inline bar becomes an explicit number too.
- **Cache share** = cache-read share of prompt input. The formula depends on whether Copilot's `inputTokens` includes cached tokens (open, see `cost_optimization_insights.md` §Gaps). Implement both in one function with a constant, and decide it with the fixture test "any record with `cacheRead > input` ⇒ input is uncached-only". Uncached-only convention: `cacheRead / (input + cacheRead + cacheWrite)`. Otherwise `cacheRead / input`. Show `—` when cacheRead is not reported. No colour judgement in v0.4 (the Insights reviewer owns "low cache" advice).
- **Per call** and **Calls** use per-call data only (`c − c.ended`). A model with only session totals shows `—` / `0` and gets the `†` marker.
- **Session-total split:** show **no separate column**. Rows whose `ended` is set get `†` after the model chip, with a title like "includes 2 sessions logged only as totals at session end". If every row has session totals, the footnote says so once. A separate "per-call vs session-total" sub-row per model doubles the table for little gain; YAGNI.
- Footer row: `All models`, with the month totals (it reuses the same cell code with `month.totals`).

**Filters:** follow project and tool (it uses `month.totals.byModel`, which is already filtered). With a tool filter, session totals drop out and the footnote says how many were hidden.

```ts
// format.ts
export const INPUT_INCLUDES_CACHE: boolean; // set from the fixture investigation
export function cacheShare(c: Counts): number | undefined;
export function perCall(c: Counts): number | undefined; // USD of per-call part ÷ records; undefined if records == 0
// store.ts
export function perCallPart(c: Counts): Counts;         // c minus c.ended.counts (metrics: sum, reported, missing subtract)
// panelHtml.ts
function modelsSection(s: Snapshot, view: ViewOptions): string; // replaces modelTable(); viewed-month scope
```

Effort: about 0.5–0.75 day (most of it is the cache-share decision plus tests).

## 3. Projects & Tools

Two existing tables (`projectsBox`, `toolsBox`) side by side, as today. The changes are small:

**By project**
- Columns: `Project | Share | Sessions | Calls | Tokens | USD (est.)`. Add the Share %; the bar exists already.
- Session totals: they count toward Sessions, Tokens and USD, but not Calls. `GroupSummary` gains `endedSessions: number`. A row with `endedSessions > 0` shows `Sessions` as `5 (2†)`. `projectSummaries` must skip `calls++` for synthetic records. That is a one-line change, and it is the main regression risk.
- `(no project)` will grow, because shutdown-only sessions from old Copilot builds may lack a `session.start` project line. That is fine; it is already labelled.

**By tool**
- No change to columns. Session totals never appear (no per-tool data). Add a footnote when the month has any: "N sessions logged only as totals at session end have no tool detail and are not in this table." That makes it obvious why the tool table sums to less than the month.

**Filters (unchanged D26 semantics):** projects ignore the project filter and honour the tool filter; tools the reverse. Clicking a row sets the filter as today. With a tool filter, project rows drop session totals (via `byTool`), and the footnote says how many.

```ts
export interface GroupSummary { /* ... */ endedSessions: number; }
function projectsBox(s: Snapshot, view: ViewOptions): string; // + share col, † sessions
function toolsBox(s: Snapshot, view: ViewOptions): string;    // + ended footnote
```

Defer: a "Δ vs last month" column (FinOps notes §comparison). It needs a second `projectSummaries` pass over the previous month and a prior-month filter story. It is better in v0.5 if Overview pace proves useful.

Effort: about 0.5 day.

## 4. Daily

**Shows:** the existing `dailyTrend()` bars, the existing `calendar()` heatmap, and optionally a weekday×hour punchcard.

**Daily bars:** session totals are included in the day they ended. Bars become **two-segment stacks**: solid = per-call, hatched or lighter = session totals. Both values come from `DayTotals.totals` and `totals.ended`, so no new aggregation is needed. Tooltip: `Nov 4: $3.10 (est.) — $1.20 from 1 session logged at session end`. Legend item: "▨ session totals (dated on end day)". The avg-per-active-day line and peak use the combined value. Footnote when any day has them: `endedNote`. Why a stack and not just a footnote: without it, a session that ran for 5 days and ended on the 4th looks like a spike on the 4th, and the hatch tells the reader it is an attribution artefact.

**Calendar heatmap:** it uses combined values. A cell with session totals gets a `†` in its title only, not a visual mark (it would overload the grid).

**Punchcard (weekday × hour):** cheap, so include it. One pass over the viewed month's **per-call** records only (`source !== "session-total"`, because shutdown time is not activity time). 7×24 cells, `heatLevel()` and the existing `.month-sw` swatch CSS. It sits inside a native `<details>` that starts closed ("When you use Copilot"), so it costs nothing visually. Honours the project and tool filters. Footnote: "Per-call records only; N sessions logged as totals are not placed by hour." About 70 lines.

```ts
export interface MonthView { /* ... */ punchcard?: number[][]; } // [weekday 0=Mon..6][hour 0..23] headline-unit sums; undefined if no per-call record
// store.ts
export function punchcard(store: UsageStore, fromMs: number, toMs: number, value: (r: UsageRecord) => number | undefined, keep: Keep): number[][] | undefined;
// panelHtml.ts
function dailySection(s: Snapshot, view: ViewOptions): string;   // dailyTrend() + calendar() + punchcardBox()
function dailyTrend(s: Snapshot, view: ViewOptions): string;     // + stacked ended segment
function punchcardBox(s: Snapshot, view: ViewOptions): string;
```

Note: `punchcard` needs the unit at aggregation time. Either store both tokens and AIU per cell (`{tokens:number; aiu:number}[][]`), which is simpler and avoids a re-snapshot on a unit switch (preferred), or recompute on unit change.

Effort: about 1 day (stack 3h, punchcard 3h, tests 2h).

## 5. Tests (vitest, existing files)

- `store.test.ts`: a synthetic record adds to sums and `ended` but not `records`; `projectSummaries` calls exclude synthetic and `endedSessions` counts; `toolSummaries` ignores synthetic; `perCallPart` subtraction; `lastNDays` across a DST change; `punchcard` buckets in local time and skips synthetic.
- `monitor.test.ts` / `history.test.ts`: the dedupe drops a session's synthetic rows once a per-call record for it exists; pace clamps Mar 30 → all of Feb; `priorLoaded=false` when `historyMonths=1`; a tool filter hides session totals while a project filter keeps them.
- `format.test.ts`: `changePct` table (0→x "new", undefined "—", negative, rounding); `cacheShare` for both conventions; `endedNote` passes the copy rule (no bill/quota/allowance/premium wording).
- `panelHtml.test.ts`: the 7-day tile shows ▲/▼ plus the title text; the Models `†` and footnote appear only when `ended` is set; Per call is `—` for an ended-only model; the daily stack segment and legend render only when needed; punchcard is inside `<details>` and absent with no per-call data; every new string is HTML-escaped; no `<script>`.
- `filters.test.ts`: each section's filter matrix (Today ignores, 7-day follows, tool filter shows the hidden-ended footnote).
- Fixture: add one pre-1.0.99 log (shutdown only) and one mixed log (per-call + shutdown) to `test/fixtures`.

## 6. Effort summary

| Section | Effort | Risk |
|---|---|---|
| Aggregation contract (`source`, `ended`, `perCallPart`, dedupe keep) | 0.75 d | Medium: every `records`/calls consumer must be checked (sessionSummaries growth too — flag to the Sessions reviewer) |
| Overview (7-day, pace, biggest line) | 1 d | Low |
| Models (month scope, share, cache share, †) | 0.5–0.75 d | Low; cache formula needs the fixture check |
| Projects & Tools | 0.5 d | Low |
| Daily (stack, punchcard) | 1 d | Low |
| **Total** | **≈ 4 d** | |

## 7. Explicitly not doing (YAGNI)

Forecast or projection bands, Δ-vs-last-month columns in tables, a per-model per-call vs session-total sub-rows, treemaps or donuts, colour-coded "bad" deltas, a day drill-down (bars stay link-less), and residual math for mixed sessions (per-call simply wins).
