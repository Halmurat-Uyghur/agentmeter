# O3 — v0.4 information architecture, copy and accessibility

Reviewer focus: section list, nav labels, content placement, the "session total" marker, empty states, side bar rows, README outline, accessibility. Read: README.md, plan (§1 copy rules, D3, D20–D27), dashboard-mockup.html, src/core/panelHtml.ts, panelCss.ts, format.ts, test/core/{format,panelHtml,gates,history}.test.ts, research notes vscode_ux_patterns.md and codeburn_reverse_engineering.md, codebase_gap_analysis.md (shutdown fields).

All proposed strings were checked by eye against both banned-word regexes:
- panel/README/manifest (D22): `/\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i`
- status bar/tooltip (format.test): adds `credits?|cost|spend` and `\$\d`. The side bar must use the **stricter** of the two in tokens view (see §6).

---

## 1. Decision: 8 sections, not 7

Split "Projects & Tools" into **Projects** and **Tools**. Reasons:
1. Session totals (feature 1) carry a project (from `session.start`) but **no tool counts**. The two tables need different coverage notes and different empty states. One combined section would have to explain both at once.
2. "Projects & Tools" is the longest label and wraps first at narrow widths.
3. Each is a separate filter source; separate sections keep "click a row to filter" unambiguous.

Merge nothing else. Insights stays even though it starts thin: nav items must not appear and disappear between renders (people navigate by position), so it always shows, with an empty state.

### Final order and labels

| # | Nav label | id (command arg) | Visible description under the h2 |
|---|---|---|---|
| 1 | Overview | `overview` | Today, the current session and {Month} at a glance. |
| 2 | Daily | `daily` | Each day of {Month}: today in detail, daily bars and the calendar. |
| 3 | Sessions | `sessions` | The current session and {Month}'s sessions, largest first. |
| 4 | Models | `models` | Usage by model in {Month} and today. |
| 5 | Projects | `projects` | Usage by repository or folder in {Month}. Click a row to filter. |
| 6 | Tools | `tools` | Built-in and added tools used by model calls in {Month}. Click a row to filter. |
| 7 | Insights | `insights` | Patterns in {Month}'s sessions that may be worth a look. |
| — | (separator) | | |
| 8 | Data health | `health` | What was read, what was skipped and what is not counted. |

`{Month}` = "November" for the current month, "October 2026" for a past month (same rule as the KPI today).

Order: summary → time → the four "by X" breakdowns, largest question first (which session? which model? which repo? which tool?) → interpretation → plumbing. Data health is last and visually separated because it is about the logs, not about usage.

Nav item extra text (small, muted, after the label, inside the same link so it is read with it):
- Insights: ` · 2` when there are findings (screen-reader text: "2 findings"). Nothing when 0.
- Data health: ` · *` when `health.partial` (SR: "partial data"), ` · !` when format-changed / no-dir / permission (SR: "needs attention"). Text, not colour only.

### Mechanism (forced by scripts-off + full re-render)

The panel re-renders its whole HTML on every snapshot (~0.5 s after each model call). In-page `#fragment` links and `:target` CSS would lose the selected section on the next update. So the selected section must be **host state**, like the month:
- New allowlisted command `copilotUsageMonitor.showSection` with one arg from the id list above; any other value → `overview`. That makes `PANEL_COMMANDS` four entries. README "exactly three commands" must become four.
- Kept in memory only (not a setting). Opening the panel from the status bar → Overview. Opening it from a side bar row → that row's section (and filter, if any).
- Month, unit and filter changes keep the current section.
- Command palette: **Copilot Usage: Show Section…** (quick pick of the 8 labels) for keyboard users who don't want to Tab through the panel.

---

## 2. Inventory: every current panelHtml.ts block and where it goes

| Current block (function) | v0.4 home | Notes |
|---|---|---|
| `topBar` h1 "Copilot Usage" + "Local" pill, "Last change hh:mm:ss · day starts at local midnight" | **Persistent header** (every section) | unchanged |
| `topBar` chips: Current session live/ended/(pinned), Partial data, Format changed | Persistent header | |
| `topBar` chip "Folder: setting / COPILOT_HOME / default" | **Data health** | low value on every page; frees header width |
| `.note` LOCAL_BANNER + STREAMING_NOTE (+ COST_NOTE in USD) | Top of **Overview**; LOCAL_BANNER (+ COST_NOTE in USD) also in a `<footer>` on every other section | R6: every total must stay labelled local. Footer keeps it on all 8 without eating the top of narrow views |
| `stateNote` (no-dir, permission, format-changed alerts) | Persistent, above the section content on every section | not `role="alert"` (see §7) |
| `navBar` filter chips ("Filtered month view, trend and tables: …") | Persistent toolbar, shown only on sections the filter affects (all except Data health; on Overview add "Today and the status bar are not filtered.") | |
| `navBar` month ‹ › / This month / Pick month… and Tokens / USD (est.) switch | Persistent toolbar | currently a second `<nav>`; must change (see §7) |
| `kpis` Today / Current session / Month / AIU or Target | **Overview** | |
| `trend` Monthly trend | **Overview** | it is also the month picker |
| `dailyTrend` Daily trend | **Daily** | |
| `tilesBox` "Today in detail" (9 metrics) + partial reasons | **Daily** (top) | a day view; Overview already has today's headline |
| `tilesBox` "Current session" | **Sessions** (top) | |
| `modelTable` (today, or the month when a past month is viewed) | **Models** | fix the scope switch: always show "{Month} by model" first, then "Today by model" when viewing the current month. Today-vs-month silently switching is confusing |
| `calendar` Daily tokens / USD calendar | **Daily** | below the daily trend |
| `projectsBox` | **Projects** | |
| `toolsBox` + added-tools summary | **Tools** | |
| `sessionsBox` "Costliest sessions" | **Sessions** | rename table "{Month} sessions" (it now includes session totals and sorts by the chosen unit). Keep ▲ in the Growth column |
| `sessionsBox` ▲ growth tip paragraph | **Insights** (as the first finding type); Sessions keeps a one-line legend | |
| `healthBox` facts + "Not covered" list | **Data health** | facts renamed, see §4 |
| Loading state ("Reading Copilot session logs…" / "Loading…") | Header + main of whichever section was requested | |

**New Overview content (small, links only):** "Top 3" lists for Sessions, Models and Projects, each ending in a link "All sessions", "All models", "All projects" (→ `showSection`). Plus an Insights line: "2 findings this month. See Insights." (or nothing). This is what makes Overview worth landing on without duplicating whole tables.

---

## 3. The "session total" marker

Context: pre-1.0.99 Copilot writes one `session.shutdown` per session with `modelMetrics.<model>.usage.*` and `totalNanoAiu`, no per-call records and no `toolCounts`. It lands on the day the session ended, and shows nothing until it ends.

**Marker = the words "session total"** as a tag, not a new symbol. `*` and `—` already mean things; a third glyph (†, Σ, ◆) would be unreadable to screen readers and to most people. Text survives high contrast and copy-paste.

Where it appears:
- **Per-session rows (Sessions table, Overview top 3):** tag after the short id: `<span class="tag total">session total</span>`. Dates cell: end date only, e.g. `Nov 3 (ended)`. Calls, Per call, Growth: `—` (the existing rule: not reported, never 0).
- **Aggregates (KPIs, model/project rows, days, months):** no glyph on the number. A count in the sub-line or fine print:
  - Today KPI sub: `input + output tokens · 12 calls + 1 session total`
  - Month KPI sub: `18 active days · 3 session totals · 410K per active day`
  - Model / Projects / Daily fine print: `Includes 3 session totals from older Copilot, each counted on the day its session ended.`
  - Calendar cell / daily bar title: `Nov 3: 840K tokens (includes 1 session total)`
  - Status bar tooltip line: `Includes 1 session total from older Copilot, counted when that session ended.`
- **Daily bars / calendar visual:** the session-total part of a bar is hatched (CSS `repeating-linear-gradient`), per-call part solid; legend `▨ Session total`. Hatch is not colour-only, so it works in high contrast.
- **Calls columns everywhere** count per-call records only. A row made only of session totals shows `—` in Calls. Projects "Sessions" column counts both kinds.

**Hover text (exact; used as `title` on the tag and repeated once as visible fine print in each section that has any, because `title` is not reliably read by screen readers or reachable by keyboard):**

> Session total: Copilot before 1.0.99 writes one total when a session ends instead of a record per model call. The whole session is counted on the day it ended. Calls, per-call figures, growth and tool use are not available for it.

Short form (side bar tooltip, status tooltip): `Session total: counted once, on the day the session ended (older Copilot).`

Interaction with existing marks: a session-total field the log did not report → `—`; partial health → `*` as today. A figure can be `840K*` with "includes 1 session total" in its sub-line; the two never merge into one sign.

Open session from older Copilot: it adds nothing until it ends. Say so (Data health, §4) rather than silently showing smaller numbers.

---

## 4. Empty states (exact strings)

General rule: say what is missing, for which scope, and (only if useful) what will make it appear. Never "0". Filter variant appends ` for this filter` before the full stop.

| Section | Condition | String |
|---|---|---|
| Any | snapshot not ready | `Reading Copilot session logs…` |
| Any | `no-dir` | existing stateNote text (unchanged) |
| Overview | month has no data at all | `No Copilot usage logged in {Month}. Figures appear here after Copilot finishes a model call, or when an older Copilot session ends.` |
| Overview | Today none (KPI) | value `—`, sub `input + output tokens · no calls yet` (unchanged) |
| Daily | no days with data | `No usage logged in {Month}.` (replaces "No usage records this month") |
| Daily | Today in detail, nothing today | tiles `—`; caption `Nothing logged today yet.` |
| Sessions | current session none | `No current session. A session becomes current when Copilot logs a model call in it.` |
| Sessions | table empty | `No sessions with usage in {Month}.` |
| Models | month empty | `No model usage logged in {Month}.` |
| Models | today empty (current month) | `No model usage logged today.` |
| Projects | empty | `No project usage logged in {Month}.` |
| Projects | `projectNames` off (all rows "(no project)") | fine print: `Project names are off (copilotUsageMonitor.projectNames), so every session is listed as (no project).` |
| Tools | empty, no session totals | `No tool use logged in {Month}.` |
| Tools | empty, only session totals | `No tool use logged in {Month}. Tool use is logged per model call; the {N} sessions counted from session totals have no tool data.` |
| Tools | non-empty, some session totals | fine print: `{N} sessions counted from session totals are not in this table: they have no tool data.` |
| Insights | no findings | `Nothing to point out in {Month}.` + `Insights check session growth and other patterns using only the numbers on this computer.` |
| Data health | never empty | — |

**Data health facts (renamed / new):**
- `Sessions this month` (unchanged)
- `Sessions with per-call records` (new)
- `Sessions counted from session totals` (new; replaces "Sessions without per-call data")
- `Older sessions still open (counted when they end)` (new)
- `Sessions with no usage data` (ended without a total, or crashed)
- `Months of history`, `Unreadable logs`, `Lines in an unknown format`, `Malformed lines`, `Over-long lines skipped (may be usage)`, `Over-long lines skipped (not usage)` (unchanged)
- `Folder` → `setting` / `COPILOT_HOME` / `default` (moved from header chip)
- Line: `Read-only. Nothing leaves this computer.` (existing badge, now a sentence)

**NOT_COVERED item 2 (replace):**
> Sessions from Copilot before 1.0.99 have no per-call records. They are counted from the total Copilot writes when the session ends, on the day it ended, and have no per-call, growth or tool figures. A session that is still open, or ended without writing a total, adds nothing yet.

---

## 5. Section-level copy changes worth making while moving things

- "Costliest sessions" → `{Month} sessions` with sub `top 10 by {unit}` (it now sorts by tokens in tokens view; "costliest" is wrong there).
- Sessions legend (replaces tip paragraph): `▲ = the last 5 calls cost 3× or more than the first 5. See Insights.` Growth `—` title: `Needs at least 10 calls with logged AI credits; not available for session totals.`
- Insights finding format (one per `<li>`): **title** · scope · one sentence · link.
  - `Context grew in 2 sessions` · `The last 5 calls cost 3× or more than the first 5. Starting a fresh session for a new task is usually cheaper.` · links to those sessions' rows in Sessions.
  - Do not use "save", "waste" or any figure framed as money left over.
- Overview title for KPI 4 unchanged ("AIU (as logged)" / "Target …").

---

## 6. Side bar summary view

Recommend a **native TreeView** (not a webview view): free keyboard navigation, screen-reader support and theming, no CSP surface. View id `copilotUsageMonitor.summary`, name `Copilot Usage (Local)`, placed in the Explorer container (no new activity-bar icon; users can drag it). Title actions: `$(link-external)` "Open Local Details", `$(refresh)` "Refresh".

Rows (label · description · click). Values follow the unit setting; `*` and `—` rules apply unchanged.

| Label | Description (tokens view / USD view) | Click |
|---|---|---|
| `Today` | `1.5M tok` / `$3.10 (est.)` | Overview |
| `Current session` | `420K tok · live` / `$0.84 (est.) · ended` / `—` | Sessions |
| `{Month}` e.g. `November` | `12.4M tok · 18 days` / `$12.40 (est.) · 18 days` | Daily |
| `Target $20–$60` (only when set) | `Under` / `In range` / `Over` | Overview |
| `Top projects` (collapsed, 3 children) | child: label `owner/repo`, desc `5.2M tok` | Projects, filtered |
| `Top models` (collapsed, 3 children) | child: label `model id`, desc `6.1M tok` | Models |
| `Top tools` (collapsed, 3 children) | child: label `tool`, desc `214 uses` | Tools, filtered |
| `Insights` (only when ≥1) | `2 findings` | Insights |
| `Data health` | `OK` / `Partial data *` / `Format changed` / `Logs not found` | Data health |

- No percentage, no bars made of `%`. Copy check for the side bar = the format.test regex in tokens view (no "cost", "credits", "$") and the D22 regex in USD view; add a test over every row in every state.
- Each TreeItem sets `accessibilityInformation.label` in words: `Today: 1.5 million input plus output tokens, locally observed` · `Today: about 3 dollars 10, estimated, locally observed` · `may be incomplete` for `*` · `not reported` for `—` · `includes 1 session total` when relevant.
- Tooltips (MarkdownString, untrusted): first line LOCAL_BANNER short form `Local estimate from Copilot logs on this computer.` (must avoid "bill/remaining" so it can sit outside the full banner), then the session-total short form when relevant.
- Welcome view (`viewsWelcome`) for `no-dir`: `No Copilot session logs were found on this computer.` + button `[Set Copilot folder](command:workbench.action.openSettings?…copilotHome)`; for no data: `No Copilot usage logged yet. Figures appear after Copilot finishes a model call.`

---

## 7. Accessibility requirements (testable)

**Landmarks and structure**
- `<header>` (banner): h1 `Copilot Usage <span class="pill">Local</span>`, last-change line, status chips.
- Toolbar: month/unit/filter controls in `<div role="group" aria-label="Month, unit and filter">`. **Not** a second `<nav>` (today's `<nav class="nav">` must change, or give it `aria-label="Month"`; two unlabelled navs are ambiguous).
- `<nav aria-label="Sections">` containing a `<ul>` of 8 `<a>` command links. The current one has `aria-current="page"`; indicator is a 2px left border + bold, not colour only.
- First focusable element: skip link `Skip to {Section}` → `#main` (visible on focus). Needed because every section change re-renders and focus returns to the top.
- `<main id="main" aria-labelledby="section-title">` with `<h2 id="section-title">{Label}</h2>` + description `<p>`.
- Cards: `<section aria-labelledby>` with **h3** (today they are h2; they move down one level). Exactly one h1, one h2 per page, no skipped levels. The "Not covered" heading becomes h3.
- `<footer>`: LOCAL_BANNER (+ COST_NOTE in USD).
- `<title>`: `{Section} · Copilot Usage (Local)`.
- stateNote: plain `<section aria-labelledby>` with h3 `Problem reading logs`. **No `role="alert"` or `aria-live`**: the page re-renders after every model call and would re-announce.

**Marks for screen readers**
- Every `—` renders as `<span aria-hidden="true">—</span><span class="sr">not reported</span>`.
- Every `*` adds `<span class="sr"> (may be incomplete)</span>`.
- `.sr` = standard visually-hidden class. Tests matching `<div class="big">—</div>` need updating.
- Icon-only links get `aria-label`: ‹ `Previous month`, › `Next month`, filter chip ✕ `Clear project filter: {name}`. Disabled ‹ › stay non-focusable spans with `aria-hidden` on the glyph and sr text `(no earlier month)`.
- Unit switch: selected segment gets sr text ` (selected)`.

**Charts (no scripts, so text alternatives are static)**
- Monthly trend: an `<ol aria-label="Monthly trend">` of links; each link has `aria-label="{Month Year}: {value} {unit}{, under/in/over target}{, viewing}"`. Bars `aria-hidden`.
- Daily trend: wrapper `role="img"` with `aria-label="{Month}: {n} of {d} days active, average {x} per active day, peak {y} on {date}"`, followed by `<details><summary>Daily figures as a table</summary><table>…</table></details>` (one row per day, includes the session-total count column).
- Calendar: a real `<table>` with `<caption>`, weekday `<th scope="col">`, each cell "3 · 120K" as text; heat level is decoration. Check text contrast on the two darkest heat levels (≥ 4.5:1) or move the number off the coloured fill.
- All data tables: `<caption>` (can be `.sr` since the h3 says it), `<th scope="col">`, first column `<th scope="row">`. Horizontal-scroll wrappers `.tablewrap` get `tabindex="0" role="region" aria-label="{table name}, scrolls sideways"` so keyboard users can scroll.
- Bars inside table cells (`.bar` share) are `aria-hidden`; the share is in the number.
- Range state (under/in/over) and peak day: always in text (legend, stats line), never colour only.

**Focus, contrast, motion**
- Add `a:focus-visible, summary:focus-visible, .tablewrap:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }`. There is no focus style today.
- High contrast: under `body.vscode-high-contrast` (and `.vscode-high-contrast-light`) give `.fill`, `.bar`, `.tile`, `.kpi`, `.chip`, nav current item a `1px solid var(--vscode-contrastBorder)`; current nav item `var(--vscode-contrastActiveBorder)`. Hatching for session-total parts stays visible.
- `@media (forced-colors: active)`: bars drawn with background vanish; add `forced-color-adjust: none` on bars or draw them with borders.
- No animation is used; keep it that way (respects `vscode-reduce-motion` by default).
- Hit targets for nav links and ‹ › at least 24×24 px.

**Narrow widths**
- ≥ 720px: nav as a 168px left column, sticky.
- < 720px: nav becomes a wrapping row of links under the header (same `<nav>`, same order; no hamburger since there are no scripts). Current item keeps its border (bottom border instead of left).
- < 560px: KPIs and tiles one column (existing); tables keep horizontal scroll inside their region; the toolbar wraps month controls above the unit switch.
- Test at 360px (split editor) for no page-level horizontal scroll.

**Tests to add** (panelHtml.test.ts): for every section × every existing state: copy check; exactly one `<main>`, one `<nav aria-label="Sections">`, one `aria-current="page"`; heading sequence h1→h2→h3 with no skips; every `—` has sr text; no `title` that is the only carrier of a session-total explanation; `showSection` with an unknown id renders Overview; the webview allowlist equals the 4 commands.

---

## 8. README update outline

1. Intro: unchanged, plus "a side bar summary".
2. **What it shows** → restructure as:
   - Status bar (unchanged text; add the tooltip session-total line).
   - **Side bar** ("Copilot Usage (Local)" in Explorer): the rows from §6, click to open the matching section.
   - **Details panel**: one bullet per section in nav order (Overview, Daily, Sessions, Models, Projects, Tools, Insights, Data health), one sentence each, moving the current bullets under them. Mention "Copilot Usage: Show Section…".
3. How to read the numbers: add a bullet after `*`: "`session total` marks a session from Copilot before 1.0.99, counted once from the total Copilot writes when the session ends, on the day it ended. It has no per-call, growth or tool figures."
4. What this is not → **replace** "Copilot 1.0.99 or newer" bullet: "**Older Copilot is counted coarsely.** Before 1.0.99, Copilot writes one total per session when it ends. Those sessions count on their end day and show nothing while still open."
5. Settings and commands: add `Show Section…`; no new setting expected.
6. What it reads: add `session.shutdown` lines (which fields are kept; that `codeChanges` paths and context fields are dropped; parse rule for the line). Panel bullet: "the panel allows exactly **four** commands: show a month, show a section, set the unit, and set a filter." Add a side bar bullet: tree view, no webview, no new files read.
7. Keep the "AIU (as logged)" and "USD (est.)" explanations as they are.

README must still pass the gates.test README copy check (no "limit", "remaining", "%").
