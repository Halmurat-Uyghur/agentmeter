# F3 — Summary view in the VS Code side bar (v0.4 item 3)

Reviewer note, 2026-11-06. Read-only review of the worktree at `main`+`5602217` (v0.3.2 + daily trend). Sources: `README.md`, `docs/plans/copilot-usage-monitor-plan.md` (§2 constraints, §4 privacy boundary, D20–D27), `package.json`, `src/extension.ts`, `src/vscode/{panel,statusBar,outputSink}.ts`, `src/core/{types,format,panelHtml,monitor,store}.ts`, `test/core/{gates,panelHtml,monitor}.test.ts`, `test/integration/extension.test.ts`, `test/fixtures/build.ts`, `node_modules/@types/vscode/index.d.ts` (1.90.0), the codeburn and VS Code UX research notes, and VS Code `release/1.90` `viewsExtensionPoint.ts` (fetched to settle the icon question).

## 1. Decision: native TreeView, not a WebviewView

**Build the side-bar summary as a `TreeDataProvider` + `window.createTreeView`, fed by a pure core function `buildSidebarModel(snapshot, view)`.** Do not add a second webview.

| Criterion | TreeView (`TreeDataProvider`) | Scripts-off `WebviewView` |
|---|---|---|
| Accessibility | Native list: ARIA tree roles, arrow-key navigation, Enter to run the row command, screen-reader label per row via `TreeItem.accessibilityInformation`. Free. | An iframe with no focusable element except `<a href="command:…">`. Values are plain text that a screen reader reads in document order; no row semantics; keyboard reaches only the links. |
| Theming | Workbench theme, high contrast, `ThemeIcon` + `ThemeColor` for coloured icons. Zero CSS. | Needs a second CSS set: the panel CSS is a 1100 px two-column dashboard, the side bar is ~250–350 px wide. `--vscode-*` variables work but every tile/bar needs a narrow layout and HC overrides. |
| Testability in the existing harness | The whole model is a pure function in `src/core/` (no `vscode` import), tested by Vitest exactly like `renderPanelHtml` and `statusText`. The extension-host test reads nodes through `_testState` (`provider.getChildren()`), so a Mocha test can assert the Today row text and the "fires only when visible" rule. | Scripts are off, so the extension-host test can only assert on the HTML string; nothing can observe the rendered DOM. Same as the panel today. |
| No scripts / privacy surface | No HTML at all. Nothing to CSP, no `enableCommandUris` allowlist, no `localResourceRoots`. The gates tests need no new exceptions. | A second locked-down webview: CSP, `enableCommandUris` allowlist, `localResourceRoots: []`, and a second place where log-derived strings are interpolated into HTML. Doubles the surface the plan §4 "Shown" rule protects. |
| Re-render cost at the 500 ms poll | `onDidChangeTreeData.fire()` makes VS Code re-request only the visible/expanded elements and diffs by `TreeItem.id`; expansion and selection survive. The monitor already emits only when the snapshot signature changes, and the adapter debounces and skips while hidden (§6). | Reassigning `webview.html` reloads the iframe: flicker, scroll reset, `<details>` fold state lost, on every snapshot. (The panel has this problem today; the UX note recommends fixing it, not copying it.) |
| Icons | Row icons are codicons (`new ThemeIcon("calendar")`), optionally coloured. The container icon can be a codicon reference: VS Code 1.90 `registerCustomViewContainers` does `ThemeIcon.fromString(descriptor.icon) || joinPath(extensionLocation, icon)`, so `"icon": "$(graph)"` is valid. **No SVG file ships, so the `.vsix` gate (`exactly package.json, README.md, LICENSE, dist/extension.js`) and `.vscodeignore` stay as they are.** | Same container icon answer; row icons would be Unicode or inline SVG. |
| What you give up | No bars, sparklines or big-number tiles. Values live in `TreeItem.description` (muted) and `tooltip`. | Richer visuals, if the narrow layout were built. |

The missing bars are the only real cost, and the details panel (one click away, title-bar button) already has every chart. codeburn's own sidebar is a scripted React `WebviewView`; the research note already ranked a TreeView "the most constraint-friendly" adaptation. Keep a scripts-off `WebviewView` as a possible later "mini trend" view only if users ask.

Container placement: a dedicated activity-bar container, as the owner's direction says. Users can drag the view into Explorer or the Panel themselves (`canMoveView` is true for custom containers). With one view, VS Code merges the view with its container (`mergeViewWithContainerWhenSingleView`), so the header shows the container title and the `view/title` actions.

## 2. `package.json` contributions

```jsonc
"contributes": {
  "viewsContainers": {
    "activitybar": [
      { "id": "copilotUsageMonitor", "title": "Copilot Usage (Local)", "icon": "$(graph)" }
    ]
  },
  "views": {
    "copilotUsageMonitor": [
      {
        "id": "copilotUsageMonitor.summary",
        "name": "Summary",
        "contextualTitle": "Copilot Usage (Local)",
        "icon": "$(graph)",
        "visibility": "visible"
      }
    ]
  },
  "viewsWelcome": [
    {
      "view": "copilotUsageMonitor.summary",
      "when": "copilotUsageMonitor.state == 'loading'",
      "contents": "Reading Copilot session logs on this computer…"
    },
    {
      "view": "copilotUsageMonitor.summary",
      "when": "copilotUsageMonitor.state == 'no-dir'",
      "contents": "No Copilot session logs were found on this computer.\nOnly Copilot clients that write session-state/*/events.jsonl are counted (the Copilot CLI and coding agent).\nIf Copilot keeps its folder elsewhere, set the folder setting.\n[Set Copilot folder](command:workbench.action.openSettings?%22copilotUsageMonitor.copilotHome%22)\n[Refresh](command:copilotUsageMonitor.refresh)"
    },
    {
      "view": "copilotUsageMonitor.summary",
      "when": "copilotUsageMonitor.state == 'permission'",
      "contents": "The Copilot session log folder could not be read on this computer.\n[Refresh](command:copilotUsageMonitor.refresh)"
    }
  ],
  "commands": [
    // existing entries gain icon + shortTitle so the view title bar renders them as buttons:
    { "command": "copilotUsageMonitor.showDetails", "title": "Copilot Usage: Show Local Details", "shortTitle": "Open panel", "icon": "$(dashboard)" },
    { "command": "copilotUsageMonitor.refresh",     "title": "Copilot Usage: Refresh",            "shortTitle": "Refresh",    "icon": "$(refresh)" },
    { "command": "copilotUsageMonitor.toggleUnit",  "title": "Copilot Usage: Switch Tokens / USD (est.)", "shortTitle": "Switch unit", "icon": "$(arrow-swap)" }
    // pinSession, selectMonth, filter: unchanged
  ],
  "menus": {
    "view/title": [
      { "command": "copilotUsageMonitor.showDetails", "when": "view == copilotUsageMonitor.summary", "group": "navigation@1" },
      { "command": "copilotUsageMonitor.toggleUnit",  "when": "view == copilotUsageMonitor.summary", "group": "navigation@2" },
      { "command": "copilotUsageMonitor.refresh",     "when": "view == copilotUsageMonitor.summary", "group": "navigation@3" },
      { "command": "copilotUsageMonitor.filter",      "when": "view == copilotUsageMonitor.summary", "group": "1_view@1" },
      { "command": "copilotUsageMonitor.selectMonth", "when": "view == copilotUsageMonitor.summary", "group": "1_view@2" },
      { "command": "copilotUsageMonitor.pinSession",  "when": "view == copilotUsageMonitor.summary", "group": "1_view@3" }
    ],
    "view/item/context": [
      { "command": "copilotUsageMonitor.pinSession", "when": "view == copilotUsageMonitor.summary && viewItem == session", "group": "inline" }
    ],
    "commandPalette": [ /* unchanged: setUnit and setFilter stay hidden */ ]
  }
}
```

Notes.

- `viewsWelcome` content shows only while `getChildren()` returns `[]`, so the provider returns `[]` exactly in the `loading`, `no-dir` and `permission` states and rows otherwise (`no-data` and `format-changed` show rows with `—` and a warning row; a welcome page would hide the health information). The context key `copilotUsageMonitor.state` is set with `vscode.commands.executeCommand("setContext", "copilotUsageMonitor.state", state)` from `extension.ts` before the first refresh (`loading`) and on every snapshot. `setContext` is not on the §2 forbidden list. The three `when` clauses are mutually exclusive.
- The welcome links are built-in commands (`workbench.action.openSettings`) and the extension's own `refresh`; no `openExternal`. The `[Set Copilot folder]` text names the setting in the body so the "no-dir names the setting" rule holds here too.
- Copy: all `name`, `title`, `shortTitle` and `contents` strings above pass `COPY_RE` (`bill|billing|remaining|quota|limit|allowance|premium|%`). The manifest copy gate (§8) must be widened to scan them.
- `activationEvents` stays `["onStartupFinished"]`; VS Code adds the implicit `onView:` event itself.
- `TreeView.title` is left as the contributed name; `TreeView.description` is set to the unit (`"tokens"` or `"USD (est.)"`) so the header always states the unit the rows use.

## 3. Rows and groups

Flat list of KPI rows, then two collapsible groups, then a health row. Stable `id`s so VS Code keeps expansion and selection across refreshes. Values go in `description`; the name is the `label`; `tooltip` carries detail and the banner; `accessibilityInformation.label` is a spoken sentence.

```
Summary · tokens                                   [⊞ Open panel] [⇄ Switch unit] [⟳ Refresh] […]
message: "Locally observed from Copilot session logs on this computer."
├─ $(calendar)     Today            1.5M tok · 12 calls
├─ $(history)      Last 7 days      6.2M tok · 5 active days
├─ $(pass)         This month       $12.40 est. · in target $20.00–$60.00     ← icon = range state, same as status bar
├─ $(pulse)        Current session  1.2M tok · live · 8 calls                 [📌 inline: Pin session…]
├─ ▾ $(repo)       Top projects     5 · November
│   ├─ owner/repo                   $5.10 · 3 sessions
│   ├─ my-folder                    $3.20 · 1 session · filtered               ← active filter row, $(filter) icon
│   └─ (no project)                 $0.90 · 2 sessions
├─ ▸ $(symbol-misc) Top models      3 · November
│   ├─ claude-sonnet-4.6            $8.00 · 40 calls
│   └─ gpt-5.5                      $4.40 · 12 calls
└─ $(warning)      Data health      Partial data · 1 log could not be read     ← only when there is something to say
```

Row by row (unit = `view.unit`; `H(c)` = headline of `Counts c`: `formatCount(input+output)` in tokens, `formatUsd(nanoAiu)` in cost; `S(text)` = add `*` when `health.partial` (the `withStar` rule from `panelHtml.ts`); `†` = session-total mark, §5):

| id | label | description | tooltip (Markdown, `isTrusted:false`) | click |
|---|---|---|---|---|
| `today` | Today | `S(H(today))` + ` · N calls`; `—` when `today` undefined (`"— · no calls yet"`) | `LOCAL_BANNER`, `STREAMING_NOTE`, Input/Output lines (reuse `countsLines`), partial reason, by-model lines (reuse the tooltip pieces of `format.ts`) | `showDetails("today")` |
| `week` | Last 7 days | `S(H(last7.totals))` + ` · N active days`; append `*` and a tooltip line when `last7.complete === false` (history window shorter than 7 days) | Window dates, average per active day | `showDetails("trend")` |
| `month` | This month | cost unit: `S(formatUsd)` + ` est.` + (` · ${RANGE_LABEL[state]} ${formatRange}` when a range is set); tokens unit: `S(formatCount)` + ` · N active days` + (` · ${RANGE_LABEL[state]}` when a range is set) | `COST_NOTE` in cost unit; month name; target line as the status-bar tooltip | `showDetails("month")` |
| `session` | Current session | `S(H(current.totals))` + ` · live|ended` + (` · pinned`) + ` · N calls`; `"— · no session yet"` when none; `contextValue: "session"` | folder id (first 8), first/last call time if in `month.sessions`, growth flag text when ≥ 3× (reuse `GROWTH_FLAG` wording) | `showDetails("session")`; inline action → `pinSession` |
| `projects` | Top projects | `${n} · ${month name}` (n = projects shown, max 5); expanded by default | — | none (group) |
| `projects:<name>` | project `label ?? name` (`(no project)` muted via `description` only; labels are plain strings, never Markdown) | `S(H)` + ` · N sessions` + (` · filtered` when `name === filter.project`) | repository/folder note from `projectsBox` | `setFilter("project", name, "projects")`; on the active row `setFilter("project", "", "projects")` (toggle, as the panel rows do) |
| `models` | Top models | `${n} · ${month name}`; collapsed by default | — | none |
| `models:<id>` | model id (already allowlisted `[A-Za-z0-9._:/-]{1,100}` by the extractor; `(unknown model)` otherwise) | `S(H)` + ` · N calls` | per-call USD as the model table | `showDetails("models")` — D26 has no model filter; do not invent one here |
| `health` | Data health | one of: `Format changed · N lines unknown`, `Partial data · <first reason>`, `N sessions without per-call data`, `N sessions counted from session totals†`; the row is omitted when `state === "ok"`, `partial` is false and both counts are 0 | full `healthLines(h)` text | `showDetails("health")` |

Top projects/models come from the **current month, unfiltered**, like the status bar (D26: "Today, the current session and the status bar are never filtered"). The panel's `snapshot.month` is the *viewed* month with the filter applied, so the sidebar needs its own fields (§4). Models are the top 5 of `thisMonth.totals.byModel` sorted by headline value (same sort as `modelTable`); projects are the top 5 of an unfiltered `projectSummaries` for the current month with the ID-folder titles applied as `label`.

Optional, cheap: `treeView.badge = { value: health.unrecognized, tooltip: "lines in a format this version doesn't recognize" }` only in the `format-changed` state, `undefined` otherwise. It puts the one warning the README promises never to hide on the activity-bar icon. Not for `partial` (too noisy).

Spoken labels (`accessibilityInformation.label`): a pure `spoken(text)` turns `1.5M` into `1.5 million`, `12.3K` into `12.3 thousand`, `*` into `, may be incomplete`, `—` into `not reported`, `†` into `, includes session totals`, so the row reads "Today: 1.5 million tokens, 12 calls, local estimate" instead of "one point five M tok star".

## 4. Snapshot additions (core, pure)

```ts
// src/core/types.ts
export interface WindowSummary {
  startMs: number;
  endMs: number;            // exclusive; nowMs for open windows
  /** undefined iff no record in the window */
  totals?: Totals;
  activeDays: number;
  /** false when the discover window starts after startMs (historyMonths too short) */
  complete: boolean;
}

export interface Snapshot {
  /* …existing… */
  /** the current calendar month, never filtered: status bar, target state and side bar (D26) */
  thisMonth?: WindowSummary & { topProjects: GroupSummary[] /* ≤ 5, label applied */ };
  /** the last 7 local days including today, never filtered */
  last7?: WindowSummary;
}

// src/core/store.ts
export function windowTotals(store: UsageStore, startMs: number, endMs: number): { totals?: Totals; activeDays: number };
```

`monitor.snapshot()` fills both from `this.store` with `keep = ALL` and marks `complete = windowStartMs <= startMs` using the same `monthStarts(...)[0]` it passes to `discover`. Cost: one more `store.totals` pass and one `projectSummaries` per *emitted* snapshot (snapshots are emitted only on change), well inside the 50 ms steady-refresh budget (AC8).

**Found while reviewing (fix in the same change):** `byMonth(this.store, starts, keep)` applies the active filter, and `statusText` / `currentRangeState` read `s.history.at(-1)` for the cost-unit month figure and the target icon. So with a project or tool filter active, the status bar in USD mode shows a *filtered* month total and a filtered target state, contrary to the README ("Today and the status bar are never filtered"). `statusText`, `currentRangeState` and `tooltipMarkdown` should read `s.thisMonth` instead, with `s.history.at(-1)` kept only as a fallback for old snapshots in tests. This is also what makes "unit consistency with the status bar" (§7) hold for the sidebar.

## 5. Session-total marker (backfilled data, v0.4 item 1)

Item 1 adds sessions counted from `session.shutdown` totals. Those figures are coarse: one lump per session, dated by the shutdown day, no tool counts, no per-call growth. The sidebar needs to show that without a third ambiguous glyph.

Assumed contract with the item-1 design (adjust to whatever F1 ships): `UsageRecord.granularity?: "call" | "session"` and `Counts.sessionTotals: number` (records in the count that are session-level). If F1 puts the flag elsewhere, the sidebar only needs the integer per `Counts`.

Rule, shared with the panel through `format.ts`:

```ts
export const SESSION_TOTAL_MARK = "†";
export function sessionTotalNote(c: Counts): string | undefined;   // "includes 2 sessions counted from their end-of-session totals (dated by the day they ended)"
export function markSessionTotals(text: string, c: Counts): string; // text + "†" unless text is "—"; keeps "*" first: "1.5M*†"
```

Applied to every description that aggregates `Counts` (Today, Last 7 days, This month, project and model rows). The Current session row, when the current session itself has only a session total, reads `1.2M tok† · ended · session total`. The health row says `N sessions counted from session totals†` so the mark is explained one row away; the row tooltip carries `sessionTotalNote`. Order of marks is fixed: `*` (partial) then `†` (coarse), and the spoken label names both.

## 6. Refresh discipline

The monitor keeps polling at 500 ms regardless (the status bar needs it). "Refresh only when visible" applies to the tree re-render:

```ts
// src/vscode/sidebar.ts
export class SummaryView implements vscode.TreeDataProvider<SidebarNode>, vscode.Disposable {
  constructor(opts: { debounceMs?: number /* 250 */ });
  update(s: Snapshot | undefined, view: ViewOptions): void;   // stores; if visible → debounced fire; else stale = true
  readonly visible: boolean;                                   // treeView.visible
  readonly fires: number;                                      // test counter
  getChildren(node?: SidebarNode): SidebarNode[];              // from the last built model; [] in loading/no-dir/permission
  getTreeItem(node: SidebarNode): vscode.TreeItem;
  getParent(node: SidebarNode): SidebarNode | undefined;       // needed for reveal(); cheap
  dispose(): void;
}
```

- `update()` rebuilds the model (`buildSidebarModel`, < 1 ms) and compares `model.signature` (a string of all labels/descriptions) with the last one; identical → no fire. The monitor already dedupes snapshots, so this mostly catches unit-only no-ops.
- Visible: trailing debounce of 250 ms (clear + `setTimeout`), one `onDidChangeTreeData.fire()` (whole tree; VS Code re-requests only visible nodes). Hidden: set `stale = true`, no timer. `onDidChangeVisibility` → `visible && stale` → fire at once and clear `stale`.
- Title-bar `Refresh` is the existing `copilotUsageMonitor.refresh` (full rediscover), identical to the palette command.
- `dispose()` clears the timer and disposes the `TreeView`.

## 7. Unit (tokens / USD) consistency with the status bar

One `ViewOptions` object, owned by `extension.ts`, is passed to all three surfaces in `onSnapshot` and `render()`: `status.update(s, view)`, `panel.update(s, view)`, `sidebar.update(s, view)`. The title-bar switch calls the existing `toggleUnit`, which writes `copilotUsageMonitor.display` and re-renders everything, so the three can never disagree. Invariants pinned by tests (§8):

- Tokens unit: the Today row description starts with exactly the figure in `statusText(s, view)` (`"$(pulse) Local today: 1.5M* tok"` → `"1.5M* tok"`).
- Cost unit: the This-month row description starts with exactly the status-bar figure and its range suffix, and the row icon id equals the status-bar icon (`pass` / `arrow-down` / `flame` / `pulse`, `warning` when `format-changed`). Export `rangeIconId(state): string` from `format.ts` (today `RANGE_ICON` is private and wrapped in `$()`), and use it in both.
- Both use `thisMonth` (unfiltered, §4).
- `TreeView.description` = the unit word, so the header says which unit the rows are in.

## 8. Click behaviour and command contracts

- `copilotUsageMonitor.showDetails` gains an optional argument `section?: PanelSection` where `PanelSection = "today" | "session" | "month" | "trend" | "models" | "projects" | "tools" | "sessions" | "health"`, validated against an exported `PANEL_SECTIONS` tuple (anything else → open at the default). This is the same hook item 2 (left-hand section navigation, scripts-off) needs: `DetailsPanel.show(section?)` stores the selected section and `renderPanelHtml(s, csp, view, { section })` renders it selected. If F2 chooses a different state carrier, the sidebar only needs `panel.show(section)`.
- `copilotUsageMonitor.setFilter(kind, value, section?)`: third optional argument, ignored by the panel's own links, so a project row opens the panel at "projects" after filtering. Values stay ≤ 200 chars and are only compared (D26). A tree row command passes `arguments: ["project", name, "projects"]`.
- Row commands are `TreeItem.command` objects, never Markdown links; the row tooltips stay `isTrusted: false`.

## 9. Core model (pure) — signatures

```ts
// src/core/sidebarModel.ts  (no vscode import)
export type SidebarState = "loading" | "no-dir" | "permission" | "ready";
export type RowId = "today" | "week" | "month" | "session" | "projects" | "models" | "health";

export interface SidebarNode {
  id: string;                               // "today" | "projects" | "projects:<name>" | "models:<model>" | …
  label: string;                            // plain text, never Markdown
  description?: string;                     // formatted value line; "—" never "0"
  icon?: { id: string; color?: "warning" | "charts.green" | "charts.red" | "charts.yellow" };
  tooltip?: string;                         // Markdown source, escapeMarkdown() applied to log-derived strings
  spoken: string;                           // accessibilityInformation.label
  command?: { command: "copilotUsageMonitor.showDetails" | "copilotUsageMonitor.setFilter"; args: string[] };
  contextValue?: "session" | "project" | "model";
  collapsible?: "expanded" | "collapsed";   // groups only
  children?: SidebarNode[];
}

export interface SidebarModel {
  state: SidebarState;                      // drives the setContext key and the [] → viewsWelcome rule
  message: string;                          // TreeView.message
  unitWord: "tokens" | "USD (est.)";        // TreeView.description
  badge?: { value: number; tooltip: string };
  nodes: SidebarNode[];                     // [] unless state === "ready"
  signature: string;                        // for the adapter's no-op check
}

export const TOP_N = 5;
export function buildSidebarModel(s: Snapshot | undefined, view: ViewOptions = DEFAULT_VIEW): SidebarModel;
export function spoken(text: string): string;
```

The adapter maps `icon` → `new vscode.ThemeIcon(id, color && new vscode.ThemeColor(colorName))` (`warning` → `list.warningForeground`, `charts.*` → the chart colours; all exist in 1.90), `tooltip` → `MarkdownString` with `isTrusted = false`, `supportHtml = false`, and `collapsible` → `TreeItemCollapsibleState`.

## 10. Tests

Unit (`test/core/sidebarModel.test.ts`, Vitest, reuse the `snap()`/`health()` builders from `panelHtml.test.ts`):

1. Row order and ids for a full snapshot; groups capped at `TOP_N`, sorted by headline value then name; ids stable between two snapshots that differ only in values.
2. `today.description` begins with the `statusText` figure in tokens; `month.description` and `month.icon.id` match `statusText`/`rangeIconId` in cost, with and without a range; `format-changed` → icon `warning`.
3. `—` for undefined `today`, `current.totals`, `last7.totals`; never `0`; `*` on every aggregated row under `health.partial`, exactly one star; `last7.complete === false` → `*` and a tooltip sentence.
4. `†` when `sessionTotals > 0` on the row's `Counts`, placed after `*`; the health row names the count; `spoken()` reads both marks.
5. Active filter: the matching project row has ` · filtered`, icon `filter`, and `command.args === ["project", "", "projects"]`; others carry their name.
6. Hostile strings: a model key `[x](command:y)<b>` and a project name with Markdown punctuation appear verbatim in `label` (plain) and escaped in `tooltip` (no raw `[`, `]`, `<`); `JSON.stringify(model)` lacks `CANARY`.
7. States: `undefined` snapshot → `loading`, `nodes: []`; `no-dir`/`permission` → `[]` with the matching state; `no-data` → rows with `—`; `health` row omitted when nothing to say.
8. Copy check: every `label`, `description`, `tooltip`, `message` and `spoken` string in every state, after removing `LOCAL_BANNER`, passes `COPY_RE`.

Also: `format.test.ts` — `statusText` in cost unit ignores a filter (uses `thisMonth`); `monitor.test.ts` — `thisMonth` and `last7` are unfiltered when a filter is set, `last7.complete` is false under `historyMonths: 1` on the 3rd of a month, `thisMonth.topProjects` ≤ 5 with titles applied; `gates.test.ts` — the manifest copy check also scans `viewsContainers[].title`, `views[].name`, `views[].contextualTitle`, `commands[].shortTitle`, `viewsWelcome[].contents`; the `.vsix` set stays exactly the four files; `src/vscode/sidebar.ts` passes the forbidden-token scan (it uses `setTimeout`, no storage).

Integration (`test/integration/extension.test.ts`, Mocha; extend `_testState` with `sidebar: { state, visible, fires, nodes: SidebarNode[] }` where `nodes` comes from `provider.getChildren()` recursively):

1. Manifest: `contributes.viewsContainers.activitybar[0].icon === "$(graph)"`, the view id, and the three `viewsWelcome` entries exist.
2. `workbench.view.extension.copilotUsageMonitor` (focus the container) → `sidebar.visible` within 3 s, `state === "ready"`, Today row description ends with `tok` and equals the status-bar figure.
3. Latency: same loop as "updates within 2 s", asserting on the Today row description instead of the status text (p95 < 2 000 ms).
4. Visibility: `workbench.action.closeSidebar` → append three usage lines over 2 s → `fires` unchanged and the status text moved; reopen the container → exactly one more fire and the row is current.
5. Row command: `executeCommand("copilotUsageMonitor.setFilter", "project", <seeded name>, "projects")` → `snapshot.filter.project` set, `panelOpen`, and the sidebar's Today row unchanged (unfiltered).
6. Unit switch via `toggleUnit` → `sidebar.unitWord` and the status text change together; reset afterwards.

## 11. Files to add and change

Add: `src/core/sidebarModel.ts`, `src/vscode/sidebar.ts`, `test/core/sidebarModel.test.ts`.

Change: `src/core/types.ts` (`WindowSummary`, `Snapshot.thisMonth`, `Snapshot.last7`; `Counts.sessionTotals` per F1), `src/core/store.ts` (`windowTotals`), `src/core/monitor.ts` (fill `thisMonth`/`last7`, apply titles to `topProjects`), `src/core/format.ts` (`rangeIconId`, `SESSION_TOTAL_MARK`, `markSessionTotals`, `sessionTotalNote`; `statusText`/`currentRangeState`/`tooltipMarkdown` read `thisMonth`), `src/vscode/panel.ts` (`show(section?)`), `src/extension.ts` (construct `SummaryView`, push to subscriptions, `sidebar.update` in `onSnapshot`/`render`, `setContext` state, `showDetails(section)` validation, `setFilter` third arg, `_testState.sidebar`), `package.json` (§2; version 0.4.0), `README.md` ("Side bar" bullet under *What it shows*; the commands list; nothing changes under *What it reads*), `CHANGELOG.md`, `test/core/{format,monitor,gates}.test.ts`, `test/integration/extension.test.ts`, `docs/plans/copilot-usage-monitor-plan.md` (a D28 entry: TreeView chosen, codicon container icon, unfiltered `thisMonth` as the status-bar source).

Not changed: `.vscodeignore`, `esbuild.mjs`, `src/core/panelCss.ts`, the privacy boundary (§4): the view reads nothing new; every string it shows already exists in the snapshot.

## 12. Effort and risks

About 2 developer-days (S–M): core model + tests 0.5, adapter + manifest 0.5, snapshot fields + status-bar fix + tests 0.5, integration tests + docs 0.5. Independent of item 1 except the `sessionTotals` integer (ship the marker code behind `c.sessionTotals ?? 0` so it is a no-op until F1 lands) and of item 2 except the `section` argument (defaults to the current behaviour).

Risks: (1) `viewsWelcome` only shows for an empty tree, so the state rule in §2 must be exact or the welcome text never appears; pinned by unit test 7 and integration test 1. (2) The `thisMonth` change alters the status bar when a filter is active (it becomes correct); note it in the changelog. (3) `TreeView.badge` and `description` exist in 1.90 (checked in the local typings), so the engine floor stays `^1.90.0`. (4) If the owner later wants bars in the side bar, that is a separate scripts-off `WebviewView` next to this tree, not a replacement.
