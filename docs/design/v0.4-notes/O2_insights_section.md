# O2 — Insights section for v0.4

Reviewer focus: which insight rules ship in v0.4, how each is computed, what it says, and what it needs. Grounded in `src/core/{types,store,extract,panelHtml}.ts`, plan §14–15 (D22–D26), `docs/SCHEMA.md`, `cost_optimization_insights.md` (R1–R9), `codebase_gap_analysis.md`, `codeburn_reverse_engineering.md` and the feature report.

## Decision

Ship **four rules**. **None of them needs a change to the extractor**: they use only fields `UsageRecord` already keeps (`model`, `tokens.*`, `nanoAiu`, `timestampMs`, `sequence`, `sessionId`). The privacy surface, the canary tests and the `SCHEMA.md` allowlist stay exactly as they are.

| # | Rule id | What it points at | Confidence |
|---|---|---|---|
| I1 | `long-context` | Calls whose prompt went past a model's long-context price threshold (R7) | High: the thresholds are published, and the per-call input is logged |
| I2 | `context-growth` | ▲ sessions (D24), with a cost floor and a "growth past the starting level" figure (R5) | High: uses logged AIU only |
| I3 | `cache-reuse` | A model whose cache-read share is low across many calls (R-cache) | Medium: depends on the `inputTokens` convention, handled by a safe inference (below) |
| I4 | `reasoning-heavy` | Calls that spent most of their output on reasoning (R2) | Medium: the formula is convention-agnostic and errs toward not firing. **Cut this one first if time is short** |

Each rule's $ figure is the **logged AIU of the calls the rule points at**, shown as "cost about $X (est.)". **No rule claims a saving**: D22 ships no price table, and a "saving" needs re-pricing. Rank by that AIU, highest first. Show only the rules that fire (at most 4).

## Two convention problems, solved without new fields

The open data questions say we don't know (a) whether `inputTokens` includes cache reads and writes, or (b) whether `reasoningTokens` is inside `outputTokens`. D22 verified (a) "input includes cached" only for gpt-6-luna and mai-code-1.1-flash. Anthropic's API convention is the opposite.

**Prompt-size convention, inferred per model** (`promptConvention(model)`):

- `"separate"` if **any** record of that model in the store has `cacheRead + cacheWrite > input`. That is impossible if input includes the cache.
- `"included"` otherwise.
- `promptTokens(r) = included ? input : input + cacheRead + cacheWrite`.

Why this is safe: a misclassification can only go one way. A model that is really "separate" but never showed cached > uncached is labelled "included". Its prompt size and cache share are then *under*-stated for I1 and *over*-stated for I3, so both rules fire **less**, never more. The inferred convention is listed per model under Data health ("Prompt tokens include cache reads: yes (inferred from 412 calls)").

**Reasoning share, convention-agnostic**:

- `reasoningShare(r) = reasoning / (output + reasoning)`.
- If reasoning is separate from output, this is the true share.
- If reasoning is inside output, the true share is `reasoning / output`, which is larger, so the rule under-fires.
- A threshold of 0.4 therefore means "at least 40 in 100 output tokens were reasoning" under the separate convention, and "at least 67 in 100" under the included one. Either way the call really is reasoning-heavy.

## Shared floors and constants (`src/core/insights.ts`)

```ts
const NANO_PER_USD = 1e11;            // USD = nanoAiu / 1e9 × $0.01  (D22)
const FLOOR_NANO = 1 * NANO_PER_USD;  // $1.00 of AIU in the flagged calls
const FLOOR_MONTH_SHARE = 0.05;       // and ≥ 5 in 100 of the viewed month's AIU
```

- A rule fires only when its flagged calls clear **both** floors. I1 is the exception: it uses $0.50 and no share floor, because it is high-confidence and directly actionable.
- Records with no `nanoAiu` are left out of $ figures and floors. If none of a rule's calls has AIU, the rule does not fire. Every rule needs AIU, because the panel never shows a rule without its $ figure.
- **Scope**: the viewed month's records, with the D26 project and tool filters applied, the same as the sessions table.
- **Coverage**: sessions counted from `session.shutdown` totals (v0.4 item 1) have no per-call records and are **excluded**. The section footer says so: "Based on 6 sessions with per-call records; 31 older sessions counted from end-of-session totals are not included."

## The four rules

### I1 `long-context` — calls past a long-context price threshold

- **Table**: dated, shipped in code, exact model-id match after lower-casing, and **only the entries the GitHub table states explicitly**. Each entry is `{ id, thresholdTokens }`:
  - `claude-haiku-5.5` → 100_000
  - `gpt-6-sol` → 272_000
  - `grok-4*` (prefix) → 200_000
  
  The comment reads `// GitHub Docs "Models and pricing", as of 2026-11`.
  - Unknown ids never fire.
  - "GPT-5.6 Luna 200K" is left out because the research note is inconsistent about which Luna has a tier.
- **Computation**:
  - `over = records.filter(r => r.model in table && promptTokens(r) > threshold)`.
  - Group by model, with `calls`, `sessions` and `nanoAiu`.
  - Also keep the highest `promptTokens` seen, for the copy.
- **Fires when**: `over.length ≥ 3` and the AIU of `over` ≥ $0.50.
- **Copy**:
  > **Long prompts on claude-haiku-5.5** — 7 calls in 3 sessions sent more than 100K prompt tokens. Above that size each token is priced higher. These calls cost about $2.40 (est.).
  > Running /compact, or starting a fresh session, before 100K keeps calls in the lower price band.
- **Fields**: none new. Keeping `maxPromptTokens` (to show "how full") is **not** needed and is deferred.

Note: the local probe's maximum was 18 in 100 of the context window, so I1 will rarely fire on the owner's machine. It is cheap and high-trust, so it ships anyway.

### I2 `context-growth` — sessions that got costlier as they went

This builds on D24's `growth` (mean AIU of the last 5 priced calls ÷ the first 5, needing ≥ 10 priced calls; ▲ at ≥ 3).

- **Additions**:
  - A per-session floor: the session's AIU ≥ $0.50 (`5e10`). Cheap ▲ sessions keep the ▲ glyph in the table but never become an insight.
  - `excess(session) = Σ_{priced calls after the first 5} max(0, aiu_i − mean(first 5 aiu))`.
  - Add `excessNanoAiu?: number` to `SessionSummary` and compute it in `sessionSummaries`, which already sorts and slices `priced`. One extra loop.
- **Fires when**: at least one session in the month has `growth ≥ 3` and clears the floor, and the summed excess clears the shared floors.
- **Important**: compute this over **all** sessions in the month, not just the top 10 that `sessionSummaries(limit = 10)` returns. Call it with `limit = Infinity` inside the insights pass, or factor the per-session loop out.
- **Copy**:
  > **Sessions that grew costly** — 2 sessions got more expensive as they went on: their later calls cost 4.1× and 3.2× the first ones. The cost above each session's starting level came to about $3.10 (est.).
  > For a new task, a fresh session usually costs less. For one that must continue, /compact shrinks what each call resends.
  
  List up to 3 session labels (the existing title or ID label logic, escaped).
  - "Above the starting level" is deliberate wording. It is **not** a saving, because a fresh session also grows.

### I3 `cache-reuse` — low cache reuse on a model

- **Eligible calls**, per model in the viewed month:
  - `input` and `cacheRead` are both reported;
  - the call is **not the first call of its session** (the lowest `sequence`, else the earliest `timestampMs`), since a cold start is necessarily a cache write;
  - `promptTokens(r) ≥ 4_096`, the largest minimum cacheable prefix in the research.
- `share = Σ cacheRead / Σ promptTokens` over eligible calls.
- **Fires when** all of these hold:
  - eligible calls ≥ 20;
  - eligible calls span ≥ 3 sessions;
  - mean `promptTokens` ≥ 20_000;
  - `share < 0.60`;
  - the AIU of eligible calls clears the shared floors.
  
  The thresholds follow the research: healthy agents run at 84–92, and "low" means below 60 at ≥ 20K input.
- **Display, under the copy gate (no `%`)**: round `share × 10` down and say "about N in 10".
- **Copy**:
  > **Low cache reuse on gpt-6-sol** — Over 54 calls in 5 sessions, about 4 in 10 prompt tokens were read from cache. Other coding agents commonly reach 8 to 9 in 10. These calls cost about $6.80 (est.).
  > The cache starts over when you switch model or reasoning effort mid-session, change the enabled tools or MCP servers, or come back to a session after a long break.
- **Fields**: none new.
- **Spin-off for the Models section owner**: the same `share` can feed a "Cache reuse" column ("9 in 10") for every model with ≥ 20 eligible calls, whether or not the rule fires.

### I4 `reasoning-heavy` — calls dominated by reasoning

- **A heavy call** has `output` and `reasoning` both reported, `reasoningShare(r) ≥ 0.4` and `reasoning ≥ 2_000`.
- **Per model**:
  - heavy calls ≥ 10;
  - heavy calls make up ≥ 30 in 100 of that model's calls;
  - the heavy calls' AIU clears the shared floors.
- **Copy** (the advice is "lower effort", never "turn off", because Claude 5.x thinking cannot be disabled):
  > **Reasoning-heavy calls on claude-opus-5.5** — 18 calls spent most of their output on reasoning (240K reasoning tokens in total). These calls cost about $4.50 (est.).
  > For routine edits and searches, a lower reasoning effort is usually enough.
- **Caveat**: output is usually a small part of agentic cost, so I4 ranks last most months. The $ figure is the cost of the whole calls, not of the reasoning alone. Do not split it out until the reasoning convention is verified against AIU.

## Rejected for v0.4 (and why)

| Rule | Reason |
|---|---|
| Tool-definition overhead (`toolTokenCount`, `availableToolCount`) | Needs new allowlisted fields **and** unverified semantics: is `toolTokenCount` inside `inputTokens`? Showing it risks double counting. **Next step**: add a probe check (reconstruct AIU with and without it) in v0.4, ship the rule in v0.5 |
| R1 Overpowered model for light work | Needs a model-tier list plus a cross-model what-if, i.e. a price table (D22 ships none). Tool mix is a weak proxy for task difficulty |
| R3 Model switch mid-session / cache-miss events | Per-call cache-miss detection depends on the cacheWrite convention for Anthropic models (unverified locally). Auto routing can't be seen, so it would flag the user for Copilot's own choices |
| R4 Idle-gap re-cache | Needs TTL per provider (`cacheTtlSeconds` is not read) and the same cache-miss semantics. Revisit with I3 data |
| R6 Compaction detected | No compaction event is read; inferring it from drops needs the prompt convention per call to be right, not just to fail safe |
| R8 MCP overhead (weak signal) | Same as tool-definition overhead; first-call size alone is noise |
| R9 Auto / Fusion discount | A time-boxed promo (ends Nov 30, 2026), surface-dependent, and reads like plan or offer copy. Close to the D2 and copy-gate intent |
| What-if re-pricing | Needs a price table and reasoning or cache conventions; it's in the report's "do not build" list for cross-vendor use |

## Types (`src/core/types.ts`)

```ts
export type InsightId = "long-context" | "context-growth" | "cache-reuse" | "reasoning-heavy";

interface InsightBase {
  id: InsightId;
  /** logged AIU of the flagged calls (I2: growth above the starting level); ranking key */
  nanoAiu: number;
  calls: number;
  sessions: number;
}
export type Insight =
  | (InsightBase & { id: "long-context"; model: string; thresholdTokens: number; maxPromptTokens: number })
  | (InsightBase & { id: "context-growth"; top: { sessionId: string; growth: number }[] })   // ≤ 3
  | (InsightBase & { id: "cache-reuse"; model: string; share: number; meanPromptTokens: number })
  | (InsightBase & { id: "reasoning-heavy"; model: string; reasoningTokens: number });

export interface InsightsView {
  items: Insight[];            // fired rules, nanoAiu desc, ≤ 4 (I1/I3/I4 may fire for 2 models: keep the costliest per id)
  /** sessions in scope with per-call records / counted from end-of-session totals only */
  coverage: { callSessions: number; totalsOnlySessions: number };
  /** Data health: inferred convention per model */
  conventions: Record<string, { prompt: "included" | "separate"; records: number }>;
}
// MonthView gains: insights?: InsightsView
// SessionSummary gains: excessNanoAiu?: number
```

- Only model ids (already regex-checked by `MODEL_ID`) and session ids or labels reach the renderer. No new strings come from the logs.
- `promptConvention` is computed over **all** records in the store, not just the month or filter, so the inference uses the most evidence.

## Engine (`src/core/insights.ts`, pure)

- `computeInsights(records, allRecordsByModelConvention, monthNano, hidden: InsightId[]): InsightsView`, called from `monitor.ts` where `MonthView` is built. It uses the same `keep` filter as `sessionSummaries`.
- **Cost**: one pass over the month's records, plus the per-session sort that `sessionSummaries` already does. Refactor so the per-session grouping is shared rather than run twice.
- **Perf target**: < 15 ms extra on the 20 MB / 300-folder perf fixture.
- **Setting**: `copilotUsageMonitor.hideInsights: InsightId[]` (enum array, default `[]`). It is a user-edited setting, with no storage and no dismiss button: scripts are off, and `globalState` is on the forbidden list.

## Renderer (`panelHtml.ts`, Insights nav section)

- `renderInsights(s, view)` returns `<section class="box" id="insights"><h2>Insights<small>estimates from local logs</small></h2>…`.
  - One `<article class="ins">` per item, with three parts:
    - a **bold title**;
    - an evidence line (calls · sessions · `$X (est.)`, or, in `unit = "tokens"`, the flagged calls' input + output tokens);
    - a muted action line.
  - Model chips reuse `chipm f-${modelFamily}`. Session labels are escaped and reuse the existing ID-to-title logic.
  - A project-scoped result can link through the existing allowlisted `setFilter` command. No new command.
  - No external doc links (no-network posture). The action line names the command (`/compact`) in plain text.
- **Empty state**: "Nothing stands out this month." Not "All good!", and no emoji.
- **Footer**: the coverage line, plus "Thresholds are rules of thumb, not GitHub guidance." for I2–I4.
- **Never**:
  - Insights do not change the status bar.
  - The side bar summary (v0.4 item 3) shows at most a plain "2 insights" link line, with no badge, no colour and no icon change.
  - No pop-ups.
- **Copy-gate check**: every string is free of bill/billing/remaining/quota/limit/allowance/premium and `%`. "Threshold", "price band", "in 10" and "est." are all allowed. The `%` used in `style="width:…%"` stays outside text nodes, as it does today.

## Tests

`test/core/insights.test.ts`:

- **Convention**:
  - "separate" once any record has `cR + cW > input`; "included" otherwise;
  - `promptTokens` follows the convention;
  - a misclassified "separate" model makes I1 and I3 fire *less* (an explicit property test).
- **I1**:
  - an unknown or near-miss id (`claude-haiku-5`, `gpt-6-sol-mini`) never fires;
  - exactly at the threshold doesn't count, +1 does;
  - 2 calls doesn't fire, 3 does;
  - $0.49 doesn't fire, $0.50 does.
- **I2**:
  - a ▲ session below $0.50 is excluded;
  - `excess` arithmetic, including negatives clamped to 0;
  - the 11th-ranked session still counts (no top-10 truncation);
  - fewer than 10 priced calls gives no growth.
- **I3**:
  - the first call of each session is excluded (by `sequence`, then by timestamp);
  - calls under 4,096 prompt tokens are excluded;
  - boundaries 0.59 / 0.60, 19 / 20 calls, 2 / 3 sessions, and the 5-in-100 month floor;
  - the "N in 10" rounding goes down.
- **I4**:
  - the share formula;
  - records missing `output` or `reasoning` are skipped;
  - the ≥ 30-in-100 share of the model's calls.
- **Shared**:
  - records without AIU are skipped, and a rule doesn't fire without AIU;
  - ranking is by `nanoAiu` with ties broken by id;
  - `hideInsights` works;
  - D26 filters are honoured;
  - month boundaries (a record at 23:59:59 on the last day; a past month);
  - the coverage counts.

`panelHtml.test.ts`:

- each rule renders with extreme numbers;
- model and label values are escaped (`<script>` in a session title);
- empty state;
- tokens-unit variant;
- the section id the nav links to.

`gates.test.ts`: add a fixture snapshot with all four rules firing, and run `COPY_RE` over the rendered text. The canary and forbidden-API tests are unchanged and must stay green, since there are no new fields.

`perf.test.ts`: the cold-scan budget still holds with insights computed.

## Effort

**M, about 2–3 days.**

| Part | Size | Estimate |
|---|---|---|
| `insights.ts` | about 220 lines | 1 day |
| `SessionSummary.excessNanoAiu` and shared grouping | | 0.5 day |
| Renderer and CSS | about 100 lines | 0.5 day |
| Tests | about 350 lines | 1 day |

Each rule on its own is S. I4 can be dropped without touching the others.

## Open items for the owner

1. Whether "Other coding agents commonly reach 8 to 9 in 10" (from Requesty data, which excludes Copilot) is acceptable as a reference line, or whether to drop the comparison.
2. Add the `toolTokenCount` and reasoning-convention AIU reconstruction to the v0.4 probe (`npm run probe`), so the tool-overhead rule and an I4 cost split can land in v0.5 on verified semantics.
3. Whether to also fold shutdown-totals sessions into I3 (their `modelMetrics` carry per-model cacheRead). Recommended: **no** for v0.4. The first-call exclusion can't be applied to them, and the rules should share one coverage basis.
