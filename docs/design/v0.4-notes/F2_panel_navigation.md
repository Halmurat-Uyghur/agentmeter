# F2 — Left-hand section navigation in the details panel (scripts off)

Reviewer note for v0.4 of Copilot Usage Monitor (Local). Read-only review of the worktree at
`copilot-usage-monitor-public/.claude/worktrees/app-feature-research-a18a73` (v0.3.2 + daily trend).
Scope: owner-approved item 2 (codeburn-style left nav inside the details panel). Items 1, 3 are
other reviewers' focus; this note only defines the hooks they need (deep links, the Sessions and
Insights slots).

## 1. Decision in one paragraph

Add a seven-item left navigation (Overview · Sessions · Models · Projects & tools · Daily · Insights ·
Data health) rendered server-side into the existing static HTML. The selected section is held in the
extension host (`DetailsPanel.section`), never persisted, and changed through one new allowlisted
command URI, `copilotUsageMonitor.showSection` with a validated string argument. The month picker,
Tokens/USD switch and filter chips stay in a shared toolbar above every section. Below 760 px the
nav becomes a top tab row. `panelHtml.ts` is split into per-section renderers behind a small
registry; `renderPanelHtml` keeps its signature plus an optional `section` parameter so the existing
tests keep compiling. `PANEL_COMMANDS` grows from three to four, the README's "exactly three"
becomes "exactly four", and a new test pins the allowlist. Nothing else in the privacy boundary
moves: scripts stay off, CSP stays `default-src 'none'`, no fragment links, no fonts, no icons.

## 2. Facts in the current code that constrain the design

| Fact | Where | Consequence |
|---|---|---|
| The poll runs every 500 ms, but `UsageMonitor.emit()` drops a snapshot whose JSON signature (with `generatedAtMs` zeroed) equals the last one. `panel.update()` therefore runs only on a real change: a new usage record, a pin / month / filter change, a day change, or a unit/range setting change. | `src/core/monitor.ts:546-552`, `src/extension.ts:67-76` | "Re-render every 500 ms" is not what happens. Re-renders happen once per model call while a session is live (seconds to minutes apart) and are otherwise idle. Section state must still live outside the DOM, because every `webview.html =` assignment reloads the document (scroll, focus and `<details>` open state are lost). |
| `enableCommandUris` is an allowlist array given once in `createWebviewPanel`. Command handlers already validate args and ignore anything else (`selectMonth`, `setFilter`). | `src/vscode/panel.ts:22`, `src/extension.ts:79-138` | A new section command follows the same pattern: allowlist by id, validate in the handler, ignore silently. |
| No test pins the *count* of allowed commands. `history.test.ts:255-267` and `filters.test.ts:279` assert every `href` is in `PANEL_COMMANDS`; README line 88 says "exactly three"; D20 says exactly two (superseded by D26). | tests, README, plan | Growing the list to four needs a README edit, a CHANGELOG line, a D28 entry, and (new) a test that pins the exact array. |
| `renderPanelHtml(s, cspSource, view)` renders 13 blocks in one fixed order; `panelHtml.test.ts:173-183` asserts that order. Tests in `panelHtml`, `history`, `filters` locate blocks by heading text. | `src/core/panelHtml.ts:626-654` | Per-section rendering breaks the "every section in order" test and any test that expects two blocks that will now live in different sections. They need a `section` argument, not a rewrite. |
| CSS already uses `--vscode-*` variables with fallbacks and has breakpoints at 1100 px and 560 px. The gate bans `url(`, `@import`, `@font-face`, `<script`, `on*=`, and `%` in visible text. | `src/core/panelCss.ts`, `test/core/panelHtml.test.ts:162-171`, `gates.test.ts` | No codicons (they need a font), no SVG sprites via `url()`. Nav items are text only; badges are digits. |
| The integration test pins the panel title `Copilot Usage (Local)`. | `test/integration/extension.test.ts:78-82` | Do not put the section name in the tab title. |
| `StatusBarItem.command` is a plain string; tooltip is `isTrusted: false`. | `src/vscode/statusBar.ts` | Deep links from the status bar use `item.command = { command, arguments }` (a `vscode.Command`), which needs no trust change. Deep links *inside the tooltip* would need `isTrusted: { enabledCommands }`; not proposed for v0.4. |

## 3. Section model and mapping of existing renderers

```ts
// src/core/panel/sections.ts
export const SECTIONS = ["overview", "sessions", "models", "projects", "daily", "insights", "health"] as const;
export type SectionId = (typeof SECTIONS)[number];
export const DEFAULT_SECTION: SectionId = "overview";
export function isSectionId(x: unknown): x is SectionId;

export interface SectionDef {
  id: SectionId;
  /** nav label */
  label: string;
  /** one-line description; the nav link's title attribute */
  hint: string;
  /** the section body: one or more <section class="box"> strings; never the chrome */
  render(s: Snapshot, view: ViewOptions): string;
  /** optional nav badge: a count, and/or a warning dot */
  badge?(s: Snapshot): { count?: number; warn?: boolean } | undefined;
}
export const SECTION_DEFS: readonly SectionDef[];   // in nav order
```

| Nav section | Existing renderer(s) that move there | Notes |
|---|---|---|
| **Overview** (default) | `kpis` (Today, Current session, Month, AIU or Target) · `trend` (monthly bars) · `tilesBox("Today in detail")` | Each card gets a one-line footer link into its section ("All sessions →", "By day →"). Keeps the first screen close to today's top half. |
| **Sessions** | `tilesBox("Current session", badge)` · `sessionsBox` (costliest) | Item 1 (session totals from `session.shutdown`, "session total" mark) lands here as extra rows; `health.sessionsWithoutUsage` moves here as a line. Badge = `month.sessions.length`. |
| **Models** | `modelTable` | Today the table shows *today* for the current month and the *month* for a past month. In a Models section both are expected: render "Today by model" and "<Month> by model" (the second from `month.totals.byModel`, which already exists and honours the filter). Flag for the Models reviewer; it is a small behaviour change. |
| **Projects & tools** | `projectsBox` · `toolsBox` (the `cols even` pair) | Row links keep calling `setFilter`; the section stays selected. Badge = projects count. |
| **Daily** | `dailyTrend` · `calendar` | Both already honour the filter. |
| **Insights** | new: the ▲ growth tip now in `sessionsBox`'s footer becomes the first finding; other findings are another reviewer's scope | Badge = number of findings; warn dot if any. The registry slot is defined here so the Insights work is additive. |
| **Data health** | `healthBox` + "Not covered" (`NOT_COVERED`) | Badge: warn dot when `health.partial` or `health.state !== "ok"`. The alert `stateNote` stays in the shared chrome on every section. |

Shared chrome, rendered on every section: `topBar` (title, "Local" pill, chips, banner `LOCAL_BANNER` + `STREAMING_NOTE` + cost note) → `stateNote` → **toolbar** (= today's `navBar`: filter chips, ‹ Month ›, This month, Pick month…, Tokens | USD) → the two-column shell (nav | content). AC7 ("every surface carries the banner") is satisfied per section because the banner is chrome, not content.

## 4. Where the selected section lives and how it changes

**State.** `DetailsPanel` (one instance for the extension's life; the inner `WebviewPanel` is recreated on open) gains `section: SectionId = DEFAULT_SECTION`. It survives closing and reopening the tab within one VS Code session and resets on reload. Not `globalState`, not a setting (gates ban the former; D22 says `ViewOptions` is "from settings, never from the logs", and a section is neither). It is deliberately *not* added to `ViewOptions`: `ViewOptions` is shared with the status bar and tooltip, which do not care about sections.

```ts
// src/vscode/panel.ts
export class DetailsPanel implements vscode.Disposable {
  section: SectionId = DEFAULT_SECTION;
  /** Reveal the panel; with `section`, switch to it first (no re-render when unchanged). */
  show(section?: SectionId): void;
  update(s: Snapshot | undefined, view?: ViewOptions): void;
  private render(): void;   // guards: skip when the produced HTML equals the last one
}
```

**Command.** One new command, allowlisted for the webview and visible in the palette as
"Copilot Usage: Show Section…" (no argument → QuickPick of `SECTION_DEFS`, mirroring `selectMonth`'s
`pick`):

```ts
// src/extension.ts
/** A SectionId switches the panel to that section; no argument opens a picker; anything else is ignored. */
const showSection = async (arg?: unknown): Promise<void> => {
  let id: SectionId | undefined;
  if (arg === undefined) {
    const pick = await vscode.window.showQuickPick(
      SECTION_DEFS.map((d) => ({ label: d.label, description: d.hint, id: d.id })),
      { placeHolder: "Section of the Copilot usage panel" });
    id = pick?.id;
  } else if (isSectionId(arg)) {
    id = arg;
  }
  if (id !== undefined) panel.show(id);
};
vscode.commands.registerCommand("copilotUsageMonitor.showSection", showSection);
```

The argument is only ever *compared* against the constant list; the label and hint shown come from
`SECTION_DEFS`, never from the argument, so a crafted URI cannot put text on screen. Same posture as
`setFilter` values (D26: "only ever compared, never executed").

**Allowlist.** Move the command list and the href helper out of `panelHtml.ts` so the side-bar view
(item 3) can share them:

```ts
// src/core/commandLinks.ts
export const PANEL_COMMANDS = [
  "copilotUsageMonitor.selectMonth",
  "copilotUsageMonitor.setUnit",
  "copilotUsageMonitor.setFilter",
  "copilotUsageMonitor.showSection",
] as const;
export type PanelCommand = (typeof PANEL_COMMANDS)[number];
export function commandHref(command: PanelCommand, ...args: string[]): string;   // command:<id>?<encodeURIComponent(JSON.stringify(args))>
export function sectionHref(id: SectionId): string;                              // commandHref("copilotUsageMonitor.showSection", id)
```

`panelHtml.ts` keeps re-exporting `PANEL_COMMANDS` so `panel.ts` and the tests do not change their
imports. `package.json` adds the command (title "Copilot Usage: Show Section…", palette-visible).

**Plan entry.** D28 (v0.4): "The panel's command allowlist is exactly `selectMonth`, `setUnit`,
`setFilter`, `showSection`. `showSection` takes one of seven fixed section ids; the selected section
is extension-host state for the VS Code session and is never written anywhere."

## 5. HTML and CSS

Document shape (scripts off, same CSP):

```html
<div class="page">
  <header class="top">…title, Local pill, chips…</header>
  <section class="note">…LOCAL_BANNER, STREAMING_NOTE, COST_NOTE…</section>
  {stateNote}
  <div class="toolbar">{filters}{month nav}{unit switch}</div>      <!-- today's navBar, unchanged -->
  <div class="shell">
    <nav class="sidenav" aria-label="Panel sections">
      <ul>
        <li><a href="command:copilotUsageMonitor.showSection?%5B%22overview%22%5D" aria-current="page" title="Today, this session and the month at a glance">Overview</a></li>
        <li><a href="…%5B%22sessions%22%5D" title="…">Sessions <span class="cnt num">10</span></a></li>
        …
        <li><a href="…%5B%22health%22%5D" title="…">Data health <i class="dot warn"></i></a></li>
      </ul>
    </nav>
    <main class="content" aria-labelledby="sec-title">
      <h2 id="sec-title" class="sec">Sessions <small>November 2026 · filtered</small></h2>
      …section boxes…
    </main>
  </div>
</div>
```

Points:

- The active item is still an `<a>` (consistent Tab order) with `aria-current="page"`; its href is its
  own section, and `DetailsPanel.show(sameId)` is a no-op, so activating it costs nothing.
- The nav is first in DOM order after the toolbar; after a re-render a keyboard user reaches it in a
  handful of Tabs. No `autofocus`: Chromium blocks it in cross-origin iframes (webviews are), and
  it would steal focus from the editor on every usage record anyway.
- No `#fragment` links (skip-link or in-page anchors): VS Code's webview link handling for fragments
  is not something the scripts-off panel should depend on, and the CSP-safe path is the command URI.
- The `<h2 class="sec">` names the section and repeats the viewed month and "filtered", so a
  screenshot or screen-reader pass of any section states its scope.

CSS additions (append to `PANEL_CSS`, same variable style as the file):

```css
.toolbar { margin-top: 10px; }
.shell { display: grid; grid-template-columns: 172px minmax(0, 1fr); gap: 16px; align-items: start; margin-top: 14px; }
.sidenav { position: sticky; top: 8px; }
.sidenav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.sidenav a { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px;
  color: var(--vscode-sideBar-foreground, var(--fg)); text-decoration: none; border: 1px solid transparent; }
.sidenav a:hover { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--accent) 8%, transparent)); }
.sidenav a[aria-current="page"] { background: var(--vscode-list-activeSelectionBackground, var(--accent));
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground, #fff)); font-weight: 600;
  border-color: var(--vscode-contrastActiveBorder, transparent); }
.sidenav a:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: -1px; }
.sidenav .cnt { font-size: 11px; opacity: .8; }
.sidenav .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.sidenav .dot.warn { background: var(--warn); }
.content { container-type: inline-size; min-width: 0; }
.sec { margin: 0 0 10px; font-size: 15px; font-weight: 650; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.sec small { font-weight: 400; color: var(--muted); font-size: 11.5px; }

/* high contrast: borders, not fills, carry the state */
body.vscode-high-contrast .sidenav a { border-color: var(--vscode-contrastBorder, var(--line)); }
body.vscode-high-contrast .sidenav a[aria-current="page"] { background: transparent; color: var(--fg); border-color: var(--vscode-contrastActiveBorder, var(--accent)); border-width: 2px; }
@media (forced-colors: active) { .sidenav a[aria-current="page"] { forced-color-adjust: none; background: Highlight; color: HighlightText; } }

/* narrow panel (side-by-side editor groups are often 500–700 px): tab row on top */
@media (max-width: 760px) {
  .shell { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .sidenav { position: static; overflow-x: auto; }
  .sidenav ul { flex-direction: row; gap: 0; border-bottom: 1px solid var(--line); }
  .sidenav a { border-radius: 6px 6px 0 0; border-bottom: 2px solid transparent; white-space: nowrap; }
  .sidenav a[aria-current="page"] { background: transparent; color: var(--accent); border-bottom-color: var(--accent); }
}
```

Two follow-on CSS changes:

- The existing `.cols` / `.kpis` breakpoints are viewport-based; with a 172 px nav the content is
  narrower than the viewport. Change them to container queries on `.content`
  (`@container (max-width: 900px) { .cols {…} }`), which VS Code's Chromium (≥ 1.76) supports.
  This is also what keeps the two-column card grid sane in a half-width editor group.
- The sticky nav needs `align-items: start` on `.shell` (already in the snippet) or it stretches and
  never sticks.

Badges: digits only (`.num`), so the copy gate (`%` banned) and the escape rules are unaffected.
Hostile strings never reach the nav: labels and hints are constants.

## 6. Re-rendering and the 500 ms poll

What actually happens: the poll is 500 ms; `webview.html` is reassigned only when the snapshot
signature changes or the unit/range setting changes. With a live agent session that is once per
model call. Each assignment reloads the webview document, which:

1. resets scroll to the top,
2. drops keyboard focus (back to the workbench),
3. closes every `<details class="more">` fold.

With one long page this was tolerable because most reading happened above the fold. With sections
it is *better*: each section is a screenful or two, so (1) is mostly invisible; (3) is unchanged;
(2) is addressed in §7. The section itself cannot be lost because it is extension state and the
render always starts from `panel.section`.

Mitigations worth their cost:

- `DetailsPanel.render()` compares the new HTML with the last one and skips identical output. This
  catches `show(sameSection)`, repeated `setUnit` with the same unit, and any future caller.
- Per-section rendering is lazy: only `SECTION_DEFS[active].render` runs, so each re-render builds
  roughly a third of today's string. (Today's render is already sub-millisecond; this is about
  keeping it that way when Sessions grows with item 1.)
- Not proposed: debouncing updates while a session streams. One re-render per model call is the
  product promise (R3, "Updates within about half a second"); hiding a record for a second to save a
  scroll reset is the wrong trade.
- Known limit to state in the CHANGELOG: a fold opened with "Show N more" closes when the next
  usage record lands. If that proves annoying, the follow-up is an `expand` flag in `DetailsPanel`
  driven by a `showSection` argument form such as `"projects+all"`; not in v0.4.

## 7. Keyboard accessibility of command links

- `<a href="command:…">` elements are in the Tab order and Enter activates them; VS Code intercepts
  the navigation and runs the allowlisted command exactly as a click does. Nothing extra is needed
  for the links themselves. Focus ring: `:focus-visible` with `--vscode-focusBorder` (above).
- The weak spot is focus loss on re-render (§6). Two non-webview keyboard paths cover it:
  - the palette command "Copilot Usage: Show Section…" (QuickPick, arrow keys + Enter);
  - `editor/title` buttons gated by `activeWebviewPanelId == copilotUsageMonitor.details`
    (codeburn does this; the context key exists in 1.90): one "Section…" button that runs
    `showSection` with no argument. Cheap, native, keyboard-reachable through the editor title
    focus command.
- Optional, off by default: contribute `copilotUsageMonitor.nextSection` / `previousSection`
  commands (wrap around the registry order) and document that users can bind them. Do not ship
  default keybindings: bare digit keys would collide with typing, and modifier combos vary by
  platform. Decide after the owner has used it.
- Landmarks: `<nav aria-label>`, `<main aria-labelledby>`, one `<h2>` per section. Every nav item
  has a `title` hint; `aria-current="page"` marks the active one.

## 8. Deep links into a section

| Surface | Mechanism | Proposal |
|---|---|---|
| Status bar click | `item.command` as a `vscode.Command` with arguments; no trust change | Default stays `showDetails` (reveals the panel on whatever section the user left). When `health.state` is `no-dir`, `permission` or `format-changed`, or `health.partial`, set `{ command: "copilotUsageMonitor.showSection", arguments: ["health"], title: "Show data health" }` so the warning icon lands on its explanation. `StatusBar.update()` already receives the snapshot; the constructor's string becomes the default. |
| Status bar tooltip | would need `isTrusted: { enabledCommands: [...] }` | Not in v0.4. The tooltip holds log-derived model ids; keeping `isTrusted: false` is the simpler privacy story. Revisit with the side bar. |
| Side bar view (item 3) | TreeView: `TreeItem.command = { command: "copilotUsageMonitor.showSection", arguments: [id] }`. Scripts-off WebviewView: `webview.options = { enableCommandUris: PANEL_COMMANDS }` and `sectionHref(id)` from `commandLinks.ts` | Either way the side bar reuses the same allowlist and validator. Each summary row links to its section (Today → overview, Session → sessions, Month → daily, Target → overview, a warning row → health). |
| Palette | `Copilot Usage: Show Section…` | QuickPick of the seven sections. |
| Inside the panel | `sectionHref` footers on Overview cards | "All sessions →", "By model →", "By day →", "Projects & tools →". |
| Month and filter links | unchanged | `selectMonth` / `setFilter` keep calling `panel.show()` with no section, so they never move the user. |

## 9. Refactor plan for `panelHtml.ts`

Two PRs, so the first can be reviewed as a pure move:

**PR A — split, no behaviour change.** New folder `src/core/panel/`:

```
src/core/panel/shared.ts     escapeHtml, monthKey, val, withStar, headline*, unitWord, plural, pad2, clock, shortDate,
                             monthTitle, shortId, titleAttr, foldedTable, TABLE_LIMIT, GROWTH_FLAG, DASH, MONTHS, DOW
src/core/panel/chrome.ts     page(), topBar(), stateNote(), toolbar() (= navBar), sideNav(), shell()
src/core/panel/overview.ts   kpis(), targetKpi(), trend(), todayTiles()      (tilesBox lives in shared)
src/core/panel/sessions.ts   currentSessionTiles(), sessionsBox()
src/core/panel/models.ts     modelTable()
src/core/panel/projects.ts   projectsBox(), toolsBox(), toolGroup()
src/core/panel/daily.ts      dailyTrend(), calendar()
src/core/panel/insights.ts   renderInsights()   (v0.4: growth findings; slot for more)
src/core/panel/health.ts     healthBox(), notCovered()
src/core/panel/sections.ts   SECTIONS, SectionId, SectionDef, SECTION_DEFS, isSectionId
src/core/commandLinks.ts     PANEL_COMMANDS, PanelCommand, commandHref, sectionHref
src/core/panelHtml.ts        façade: renderPanelHtml + re-exports (PANEL_COMMANDS, TABLE_LIMIT, GROWTH_FLAG,
                             escapeHtml, monthKey, toolGroup) so extension.ts, panel.ts and the tests import as before
src/core/panelCss.ts         unchanged in PR A
```

In PR A `renderPanelHtml` still concatenates every block in today's order; the whole existing test
suite is the regression net (it locates every block by heading and pins order, links, escaping and
copy). Import sites that change: none (façade). Lines moved: ~600; lines written: ~40.

**PR B — navigation.**

```ts
// src/core/panelHtml.ts (façade)
export function renderPanelHtml(
  s: Snapshot | undefined,
  cspSource: string,
  view: ViewOptions = DEFAULT_VIEW,
  section: SectionId = DEFAULT_SECTION,
): string;
// loading state (s undefined): chrome + nav without badges + "Loading…"
```

```ts
// src/core/panel/chrome.ts
export function sideNav(s: Snapshot | undefined, active: SectionId): string;
export function toolbar(s: Snapshot, view: ViewOptions): string;          // today's navBar, renamed
export function sectionHeading(def: SectionDef, s: Snapshot): string;   // <h2 class="sec">label <small>scope</small></h2>
export function shell(nav: string, main: string): string;
```

`src/vscode/panel.ts`: `section` field, `show(section?)`, HTML-equality guard.
`src/extension.ts`: `showSection` handler, registration, `_testState().panelSection`.
`src/vscode/statusBar.ts`: `update()` chooses the command object (§8).
`package.json`: command + `editor/title` menu entry.
`src/core/panelCss.ts`: §5 rules; `.cols`/`.kpis` breakpoints become container queries.

## 10. Tests

**Changed (PR B):**

| Test | Change |
|---|---|
| `panelHtml.test.ts` "has every section in order" | becomes two: Overview order (`Copilot Usage, Local, Today, Current session, November, AIU (as logged), Monthly trend, Today in detail`) and nav order (seven labels, in registry order, before the `<main>`). |
| `panelHtml.test.ts` daily-trend, calendar, "empty day renders —", "no today and no month" (calendar/`Today by model` assertions) | pass `"daily"` or `"models"` as the fourth argument. |
| `panelHtml.test.ts` over-long / health-row assertions | pass `"health"`. |
| `panelHtml.test.ts` "copy check passes on visible text in every state" and "is static, locked down and carries the banner" | loop over `SECTIONS` × states: banner, `STREAMING_NOTE`, CSP, no `<script`, no `on*=`, no `http`, copy regex, canary absent. (`NOT_COVERED` items move to the `"health"` case.) |
| `history.test.ts` "costliest sessions" | `"sessions"`. "links only to allowlisted commands" and the trend tests stay on the default; add the expectation that the hrefs include a `showSection` link. |
| `filters.test.ts` row-link, active-row (`tr class="on"`) and fold (D27) tests | `"projects"` (and `"models"` for the model fold). The chip assertions stay on the default because chips are chrome. |
| `test/integration/extension.test.ts` | new case: `showSection "sessions"` → `_testState().panelSection === "sessions"` and `panelOpen`; `showSection "bogus"` leaves it unchanged; `showDetails` afterwards keeps `"sessions"`. |

**New `test/core/panelNav.test.ts`:**

1. `PANEL_COMMANDS` deep-equals the four ids (pins the README's "exactly four"; today nothing pins the count).
2. Nav renders seven `<li><a>` in registry order; exactly one `aria-current="page"`; every nav href is `command:copilotUsageMonitor.showSection?` + `encodeURIComponent(JSON.stringify([id]))`; the active link's href is its own id.
3. For every `SectionId`: the toolbar (‹ › month buttons, `Tokens` / `USD (est.)`, filter chips when a filter is set) is present; the `<h2 class="sec">` names the section; the alert `stateNote` shows on every section for `no-dir`.
4. Badges: Sessions shows `month.sessions.length`; Projects shows `month.projects.length`; Data health has `dot warn` when `partial` or `format-changed` and no dot when ok; Insights shows the finding count and no badge when zero.
5. `isSectionId`: the seven ids true; `"Overview"`, `""`, `1`, `null`, `"health "` false.
6. Loading state (`undefined` snapshot) renders the nav with no badges and "Loading…".
7. Section-specific content does not leak: `"overview"` lacks "By tool"; `"sessions"` lacks "Daily trend"; `"health"` lacks `<table` (regression guard for the registry mapping).
8. CSS: `PANEL_CSS` contains `@media (max-width: 760px)` with `.sidenav`, `@media (forced-colors: active)`, no `url(`.

**`gates.test.ts` addition:** `src/vscode/panel.ts` contains the literal `enableScripts: false` and `enableCommandUris: PANEL_COMMANDS` (pins the wiring; one-line test). The forbidden-token scan already bans `enableScripts: true`.

## 11. Docs

- README "What it reads → Panel": "the panel allows exactly four commands: show a month, set the unit, set a filter, and show a section". README "What it shows": one bullet for the sections. Commands list: add "Copilot Usage: Show Section…".
- CHANGELOG Unreleased → 0.4.0: Added (left navigation, Show Section command, status-bar warning deep-links to Data health); Changed (allowlist is four commands; Models section shows today and the month); Known (a fold closes when the next record lands).
- Plan: §16 "v0.4 decisions" with D28 (§4 above) and the mapping table of §3.

## 12. Effort

| Step | Size |
|---|---|
| PR A: split into `src/core/panel/*` + façade, run the suite | 0.5 day |
| PR B: registry, chrome (nav, toolbar, heading), CSS incl. container queries, `DetailsPanel.section`, `showSection`, status-bar command object, manifest | 0.75 day |
| Tests: edits listed in §10, `panelNav.test.ts`, integration case, gate line | 0.5 day |
| Manual pass: light / dark / HC themes, 500 px and 1300 px panel widths, keyboard-only walk, palette and `editor/title` paths | 0.25 day |
| **Total** | **≈ 2 days**, one developer; PR A mergeable on day 1 |

Items 1 and 3 can start in parallel after PR A lands: item 1 only touches `panel/sessions.ts` and the
monitor; item 3 imports `commandLinks.ts` and `sections.ts`.

## 13. Risks and open points

- **Width.** Many users keep the panel in a half-width editor group, so the tab-row fallback will be
  the common case, not the exception. Try 700 px before 1300 px in the manual pass; if the row wraps
  awkwardly, drop the badges below 760 px.
- **`activeWebviewPanelId`** for the `editor/title` button: verify the exact value is the viewType
  `copilotUsageMonitor.details` in 1.90 before relying on it; the nav itself does not depend on it.
- **Models behaviour change** (today + month tables) is a product choice for the Models reviewer;
  the nav design works either way.
- **Fold state loss** on re-render is pre-existing and listed as known; not a blocker.
- **Allowlist growth** is the only privacy-boundary change: one more command id, one validator,
  argument compared and never rendered. The pinning test (§10 new #1) keeps the README truthful.
