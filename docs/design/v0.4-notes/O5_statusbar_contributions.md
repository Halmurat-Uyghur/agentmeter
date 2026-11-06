# O5 — package.json contributions, status bar, extension wiring (v0.4)

Reviewer focus: contributes block, icon packaging, engines, version/CHANGELOG, low-risk status-bar tooltip upgrades, and a small controller so status bar, panel and side bar share one snapshot and view state.

Files read: `package.json`, `.vscodeignore`, `.vscode-test.mjs`, `esbuild.mjs`, `src/extension.ts`, `src/vscode/statusBar.ts`, `src/vscode/panel.ts`, `src/core/format.ts`, `src/core/panelHtml.ts` (PANEL_COMMANDS), `test/integration/extension.test.ts`, `docs/plans/copilot-usage-monitor-plan.md` (D20, D26), and the research notes `vscode_ux_patterns.md` and `codeburn_reverse_engineering.md`.

## 1. Decisions in one place

| Topic | Decision | Why |
|---|---|---|
| Side bar view type | **TreeView** (`createTreeView`), not a WebviewView | It is native, keyboard and screen-reader accessible, themed, and needs no HTML, CSP or webview process. `viewsWelcome` only renders for an empty **tree** view, so it gives us a script-free "logs not found" state. It fits "no pop-ups". |
| Container icon | Monochrome SVG `media/usage.svg` (24×24, `fill="currentColor"`) | Activity-bar containers take a file path. `$(codicon)` is documented for commands and views, not reliably for `viewsContainers.activitybar` at the 1.90 floor. **`.vscodeignore` is an allowlist (`**` then `!…`), so `media/` is excluded today**. Add `!media/usage.svg` or vsce ships no icon. |
| Command icons | Codicons (`$(refresh)`, `$(graph)`, `$(arrow-swap)`, `$(filter)`, `$(clear-all)`) | No assets needed. |
| Keybindings | **None** | No obvious key. Avoid conflicts. Users can bind `showDetails` themselves. |
| `engines.vscode` | **Keep `^1.90.0`** | Everything used exists in the pinned `@types/vscode@1.90.0`: `MarkdownString.isTrusted: { enabledCommands }` (index.d.ts:2959), `StatusBarItem.accessibilityInformation` (:7264), TreeView, `viewsWelcome`, `ViewBadge`. `.vscode-test.mjs` already runs integration tests on 1.90.0, so it checks the floor. A bump would drop users and buy nothing. |
| Version | `0.3.2` → `0.4.0` | New UI surfaces and a new counting rule (shutdown totals) make this a minor bump. |
| Activation | Keep `onStartupFinished` only | Since 1.74, contributed views and commands activate implicitly. |

## 2. Full new `contributes` block

The `configuration` block stays as it is, except for one optional new setting (see the end of this section).

```jsonc
"contributes": {
  "viewsContainers": {
    "activitybar": [
      { "id": "copilotUsageMonitor", "title": "Copilot Usage (Local)", "icon": "media/usage.svg" }
    ]
  },
  "views": {
    "copilotUsageMonitor": [
      {
        "id": "copilotUsageMonitor.summary",
        "name": "Summary",
        "type": "tree",
        "icon": "media/usage.svg",
        "contextualTitle": "Copilot Usage (Local)"
      }
    ]
  },
  "viewsWelcome": [
    {
      "view": "copilotUsageMonitor.summary",
      "contents": "Reading local Copilot session logs…",
      "when": "copilotUsageMonitor.state == loading"
    },
    {
      "view": "copilotUsageMonitor.summary",
      "contents": "No Copilot session logs were found on this computer.\n[Set Copilot Folder](command:workbench.action.openSettings?%5B%22copilotUsageMonitor.copilotHome%22%5D)\nNothing is sent or stored. Only local files are read.",
      "when": "copilotUsageMonitor.state == no-dir"
    },
    {
      "view": "copilotUsageMonitor.summary",
      "contents": "The Copilot session log folder could not be read.\n[Open Settings](command:workbench.action.openSettings?%5B%22copilotUsageMonitor.copilotHome%22%5D)",
      "when": "copilotUsageMonitor.state == permission"
    }
  ],
  "commands": [
    { "command": "copilotUsageMonitor.showDetails", "title": "Show Local Details", "category": "Copilot Usage", "icon": "$(graph)" },
    { "command": "copilotUsageMonitor.refresh",     "title": "Refresh",            "category": "Copilot Usage", "icon": "$(refresh)" },
    { "command": "copilotUsageMonitor.pinSession",  "title": "Pin Session…",       "category": "Copilot Usage" },
    { "command": "copilotUsageMonitor.selectMonth", "title": "Show Month…",        "category": "Copilot Usage", "icon": "$(calendar)" },
    { "command": "copilotUsageMonitor.toggleUnit",  "title": "Switch Tokens / USD (est.)", "category": "Copilot Usage", "icon": "$(arrow-swap)" },
    { "command": "copilotUsageMonitor.filter",      "title": "Filter by Project or Tool…", "category": "Copilot Usage", "icon": "$(filter)" },
    { "command": "copilotUsageMonitor.clearFilter", "title": "Clear Filter",       "category": "Copilot Usage", "icon": "$(clear-all)", "enablement": "copilotUsageMonitor.filterActive" },
    { "command": "copilotUsageMonitor.setUnit",     "title": "Set Unit",           "category": "Copilot Usage" },
    { "command": "copilotUsageMonitor.setFilter",   "title": "Set Filter",         "category": "Copilot Usage" },
    { "command": "copilotUsageMonitor.showSection", "title": "Show Details Section", "category": "Copilot Usage" }
  ],
  "menus": {
    "commandPalette": [
      { "command": "copilotUsageMonitor.setUnit",     "when": "false" },
      { "command": "copilotUsageMonitor.setFilter",   "when": "false" },
      { "command": "copilotUsageMonitor.showSection", "when": "false" },
      { "command": "copilotUsageMonitor.clearFilter", "when": "copilotUsageMonitor.filterActive" }
    ],
    "view/title": [
      { "command": "copilotUsageMonitor.showDetails", "when": "view == copilotUsageMonitor.summary", "group": "navigation@1" },
      { "command": "copilotUsageMonitor.refresh",     "when": "view == copilotUsageMonitor.summary", "group": "navigation@2" },
      { "command": "copilotUsageMonitor.toggleUnit",  "when": "view == copilotUsageMonitor.summary", "group": "navigation@3" },
      { "command": "copilotUsageMonitor.clearFilter", "when": "view == copilotUsageMonitor.summary && copilotUsageMonitor.filterActive", "group": "navigation@4" },
      { "command": "copilotUsageMonitor.filter",      "when": "view == copilotUsageMonitor.summary", "group": "1_view@1" },
      { "command": "copilotUsageMonitor.selectMonth", "when": "view == copilotUsageMonitor.summary", "group": "1_view@2" },
      { "command": "copilotUsageMonitor.pinSession",  "when": "view == copilotUsageMonitor.summary", "group": "1_view@3" }
    ],
    "editor/title": [
      { "command": "copilotUsageMonitor.toggleUnit", "when": "activeWebviewPanelId == copilotUsageMonitor.details", "group": "navigation@1" },
      { "command": "copilotUsageMonitor.refresh",    "when": "activeWebviewPanelId == copilotUsageMonitor.details", "group": "navigation@2" }
    ]
  },
  "configuration": { /* unchanged; optional addition below */ }
}
```

Notes:
- The `category` + short `title` form renders in the palette exactly as today ("Copilot Usage: Refresh"), and it gives short tooltips on title-bar buttons. The integration test does not assert titles.
- `clearFilter` is new: it is a no-argument wrapper around `setFilter("clear")`. A title-bar button cannot pass arguments.
- Welcome-view links point only at the built-in `workbench.action.openSettings`. No URLs and no docs links, so no network.
- I would add no new setting in v0.4. If one is added, use `copilotUsageMonitor.statusBar.show` (boolean, default true) rather than a format enum. Keep the scope small.
- In the activity bar, the badge (`TreeView.badge`) should stay **unused**. A number on the icon reads like a notification.

`.vscodeignore` addition:
```
!media/usage.svg
```
Add a packaging check to CI or a test: `npx vsce ls --no-dependencies | grep -x media/usage.svg`. A missing icon is silent in vsce. It only shows as a blank activity-bar slot.

## 3. Hidden section command

```ts
// src/core/viewState.ts (pure, vitest-covered)
export const SECTIONS = ["overview", "sessions", "models", "projects", "daily", "insights", "health"] as const;
export type SectionId = (typeof SECTIONS)[number];
export function cleanSection(v: unknown): SectionId | undefined; // allowlist; anything else → undefined
```
- `copilotUsageMonitor.showSection(section?: unknown)`: unknown or missing → `"overview"`. It sets `state.section`, opens or reveals the panel, and re-renders. It never throws and never shows a message.
- Add it to `PANEL_COMMANDS` so the scripts-off left nav can use `command:copilotUsageMonitor.showSection?["sessions"]`. This follows the D20 and D26 allowlist pattern. Record it as **D28** in the plan.
- The status-bar tooltip and side-bar tree items call the same command, so there is one entry point.

## 4. Status bar: low-risk improvements

These changes stay inside `StatusBar.update` and `format.ts`. Text, colour and priority do not change.

```ts
export const TOOLTIP_COMMANDS = [
  "copilotUsageMonitor.showSection",
  "copilotUsageMonitor.toggleUnit",
] as const;

const md = new vscode.MarkdownString(tooltipMarkdown(s, view));
md.isTrusted = { enabledCommands: [...TOOLTIP_COMMANDS] };  // allowlist, never `true`
md.supportHtml = false;
md.supportThemeIcons = true;   // safe: escapeMarkdown already escapes `$` and `(`
this.item.accessibilityInformation = { label: statusAccessibilityLabel(s, view), role: "button" };
```

`format.ts` additions (pure, testable):
```ts
export function statusAccessibilityLabel(s: Snapshot | undefined, view: ViewOptions): string;
// "Copilot usage, local today 1.2 million tokens. Over your monthly target. Opens details."
// No icon syntax, no "*"; it says "partial" in words.
export function tooltipLinks(): string;
// "[$(graph) Details](command:copilotUsageMonitor.showSection?%5B%22overview%22%5D) · [$(pulse) Sessions](…%22sessions%22…) · [$(arrow-swap) Tokens / USD](command:copilotUsageMonitor.toggleUnit)"
```
- Append a "Data health" link (`showSection health`) only when `health.partial` or the state is `format-changed`.
- The links are built by our own code, with hard-coded section IDs. Log-derived text never reaches a link target.
- Optional, still low-risk: a text bar for the target range, `▰▰▰▱▱ 62% of $60`. Show it only when `view.range.max` is set.
- Leave out the `tooltip2` lazy tooltip (proposed API) and the right/left alignment settings.
- Tests: add `tooltipMarkdown` unit tests in `test/core/format.test.ts` asserting that (a) every `command:` target is in `TOOLTIP_COMMANDS`, (b) a model id like `$(alert)evil](command:x)` stays escaped, and (c) the accessibility label has no `$(`.

## 5. extension.ts restructure: one controller

Today `extension.ts` holds `snapshot`, `view`, `selected` and `filter` as closures and pushes them to two sinks by hand (`onSnapshot`, `render`). v0.4 adds a third sink plus `section`, so this moves into a small class.

```ts
// src/vscode/controller.ts
export interface UiState {
  snapshot: Snapshot | undefined;
  view: ViewOptions;            // unit + range (from settings)
  selectedMonth?: number;       // undefined = current
  filter: Filter;
  section: SectionId;           // panel left nav; default "overview"
}

export interface UiSink extends vscode.Disposable {
  render(state: Readonly<UiState>): void;   // must be cheap and side-effect free apart from UI
}

export class UsageController implements vscode.Disposable {
  constructor(opts: { log: Logger; resolveRoot: () => { root: string; source: RootSource } });
  readonly onDidChange: vscode.Event<Readonly<UiState>>;
  get state(): Readonly<UiState>;
  addSink(sink: UiSink): void;              // renders immediately with current state

  start(): void;                            // (re)build UsageMonitor, poll 500 ms, midnight timer
  refresh(full?: boolean): Promise<void>;
  setUnit(unit?: "tokens" | "cost"): Promise<void>; // updates view, renders, writes setting
  selectMonth(key: "current" | `${number}-${number}`): void;
  setFilter(next: Filter): void;
  showSection(section: SectionId): void;
  pin(folderId: string | undefined): void;
  onConfigChange(e: vscode.ConfigurationChangeEvent): void;
}
```
- The sinks are `StatusBar`, `DetailsPanel` and `SummaryTree` (a `TreeDataProvider` firing `onDidChangeTreeData` on render). Each implements `render(state)`. The status bar ignores `filter`, `selectedMonth` and `section` (D26: the status bar is never filtered).
- **Throttle**: the poll emits about 2 snapshots per second. Only the panel and tree should re-render, and only when the snapshot identity or state actually changes. The tree diffs on a cheap key (today total, month total, filter, unit) before it fires. A full tree refresh every 500 ms would flicker and steal focus.
- **Context keys** are set in one place, after each state change: `copilotUsageMonitor.filterActive` (bool) and `copilotUsageMonitor.state` (`loading | ok | no-dir | permission | no-data | format-changed`). Call `setContext` only when the value changes.
- The quick-pick UIs (`pickMonth`, `pickFilter`, `pickSession`) move to `src/vscode/pickers.ts` as functions that take `(controller)`. Keep the existing guard that drops a pick if the monitor was replaced while the pick was open: the controller exposes `generation: number`.
- `extension.ts` shrinks to about 60 lines: build the sinks, call `registerCommands(controller, panel)`, `onDidChangeConfiguration → controller.onConfigChange`, the `_testState` command, and `controller.start()`.
- Pure parts (`cleanSection`, filter merge, month-key parse, context-key derivation `uiContext(state)`) go in `src/core/viewState.ts` so vitest covers them without the extension host.

## 6. Tests to add or update

`test/integration/extension.test.ts`:
1. Extend `_testState` with `section`, `treeItems: string[]` (labels from `SummaryTree.getChildren()`), `statusA11y`, `tooltipTrusted: string[]` (the enabledCommands) and `context: { filterActive, state }`.
2. **Contributions**: `packageJSON.contributes.viewsContainers.activitybar[0].icon === "media/usage.svg"`, the file exists in `ext.extensionPath`, and the view id is `copilotUsageMonitor.summary`.
3. **Hidden commands**: every command in `commandPalette` with `when: "false"` is registered (`getCommands(true)`), and `PANEL_COMMANDS` ⊆ registered commands.
4. `showSection("sessions")` opens the panel with `section === "sessions"`. `showSection("bogus")` gives `"overview"` with no throw.
5. **Shared state**: `setFilter("tool","x")` puts `filterActive === true` in the context, gives a tree item showing the filter, and leaves `statusText` unchanged. `clearFilter` resets all three.
6. Tooltip trust: `tooltipTrusted` deep-equals `TOOLTIP_COMMANDS`. `statusA11y` matches `/^Copilot usage/`.
7. no-dir test: also assert `context.state === "no-dir"` (that drives the welcome view).
8. Keep the existing latency test. Add an assertion that the tree's `onDidChangeTreeData` fired at most a few times per second over 20 appends (throttle check).

Unit tests (vitest): `viewState.test.ts` (cleanSection, uiContext), plus the `format.test.ts` additions in section 4.

Packaging: `npm run package` followed by `vsce ls` to check that the icon is included.

## 7. CHANGELOG 0.4.0 outline

```
## 0.4.0 - 2026-11-xx
### Added
- Copilot Usage side bar (activity-bar icon): today, current session, this month vs target, top projects and tools; click a row to open that part of the details panel. Welcome text when no logs are found.
- Details panel left-hand navigation: Overview, Sessions, Models, Projects & Tools, Daily, Insights, Data health (script-free).
- Sessions without per-call records are counted from their shutdown totals (marked as such).
- Status bar tooltip links to Details, Sessions and the unit switch; screen-reader label for the status bar item.
- Title-bar buttons: Refresh, Switch Tokens / USD, Filter, Clear Filter.
### Changed
- Command titles use the "Copilot Usage" category (same palette text).
- Tooltip command links are allowlisted (`isTrusted.enabledCommands`); still no HTML, no network.
### Unchanged
- Local only: no network, nothing stored, no notifications. VS Code 1.90 or later.
```
Move the existing "Unreleased → Daily trend" entry into 0.4.0.

## 8. Risks

- **Icon not packaged**: covered by the `.vscodeignore` line and the `vsce ls` check.
- **Tree churn every 500 ms**: covered by the diff key and the throttle test.
- **Trusted tooltip widening the attack surface**: limited to two commands with hard-coded arguments. Both commands validate their arguments (`cleanSection`, unit allowlist), and escaping is unchanged.
- **A new activity-bar icon is intrusive**: users can hide it. If others prefer, the same view can live in the Explorer container (`"views": { "explorer": [...] }`) with no code change. I would still ship the dedicated container, because the welcome view and title actions need room.
