# F5 — Test and verification strategy, and performance (v0.4)

Reviewer focus: which tests to add or extend per feature, the fixtures, how the side bar and section navigation are driven from the integration harness, the performance budget, and an ordered TDD sequence that keeps the suite green at every step. Read-only review; nothing in the repo was changed. Where this note names ids or shapes it uses the ones the other reviewers settled on (O3: host-state `showSection`; O4: synthetic `session-total` records; O5: TreeView `copilotUsageMonitor.summary` in container `copilotUsageMonitor`, icon `media/usage.svg`), so the tests below pin one design, not three.

## 0. Baseline on this machine (2026-11-06, worktree `app-feature-research-a18a73`, Node 22.23.1)

| Command | Result | Time |
|---|---|---|
| `npm test` (`vitest run`, test/core/**) | **15 files, 326 tests, 326 passed** | 0.66 s (gates `.vsix ls` step 404 ms) |
| `npm run typecheck` (`tsc --noEmit -p .`) | clean, exit 0 | 0.56 s |
| `npm run build` (`node esbuild.mjs`) | `dist/extension.js` 103.9 kB | 10 ms |
| `NODE_OPTIONS=--expose-gc PERF=1 npx vitest run test/core/perf.test.ts` | **2 passed**: cold 25 ms, steady 2.8 ms, idle 1.91 ms CPU/poll, heap +0.6 MB; busy month (50k records): steady 19.9 ms, idle 2.03 ms | 0.5 s |
| `npm run pretest:integration` (`build && tsc -p tsconfig.test.json`) | `out/test/integration/extension.test.js`, `out/test/fixtures/build.js` | 0.35 s |
| `npx vscode-test --config <scratchpad>/design/vscode-test-run/config.mjs` | **8 passing (10 s)**; `latency median 498ms p95 523ms max 523ms` | 11.9 s wall |

Integration deviation: no VS Code build is cached (`.vscode-test/` is absent in the main checkout and every worktree) and the repo's `.vscode-test.mjs` would download 1.90.0, so the baseline ran against the installed VS Code **1.145.2** through a scratchpad copy of the config with `useInstallation: { fromPath: "/Applications/Visual Studio Code.app/Contents/MacOS/Code" }`, `--disable-extensions`, a temp `--extensions-dir`, and the explicit compiled file path (an absolute glob is passed to Mocha literally). The config, log and a `node_modules` symlink live under `<scratchpad>/design/vscode-test-run/` and `F5_integration_baseline.log`; the repo config is unchanged and the CI run should keep 1.90.0 (engine floor). `git status --porcelain` after everything: only the pre-existing untracked `reports/` and `research_notes/`.

Real-log cold scan (timing-only bundle `F5_realscan.mjs`, same `UsageMonitor` the extension runs, no content printed): **127 session-state folders, 39 logs, 18.6 MB**; `historyMonths=12`: cold **40 ms** first run (19 ms warm), steady 1.9–2.6 ms, idle ~2.0 ms CPU/poll, heap +0.6 MB, state `no-data`, `sessionsWithoutUsage 33`. Budgets (cold < 2 s, steady < 50 ms, idle < 5 ms CPU, heap < 64 MB) have roughly 50× headroom today.

## 1. Facts from the real shutdown lines that fix the fixtures (shape-only probe, `F5_shutdown_probe_out.txt`)

- 39 logs: **29 shutdown-only, 4 both, 6 neither** (all six are `unknown`/crashed builds, 0.1–3.5 MB), 0 usage-only. 34 shutdown lines in 33 logs; 31 are the last line of the file.
- Shutdown lines are **472 B min, p50 734 B, p90 3.9 KB, max 4.0 KB**; `type` is always the first key; the substring `"session.shutdown"` occurs in **0** other lines (gate-safe, same as the usage gate); never carries `agentId`.
- `modelMetrics.<model>.usage` has exactly `inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens` (33 of 33 non-empty). **4 of 34 have an empty `modelMetrics`** (not a format change; just no totals).
- In all 4 both-logs the shutdown totals **equal the summed usage records exactly** (tokens and AIU), so "per-call wins, shutdown ignored" loses nothing and can be pinned by exact equality.
- The one resumed log (3 resumes) has **2 shutdowns that are identical and cumulative** (same `sessionStartTime`, same totals, 121 h apart). "Last shutdown wins" is right; summing would double it.
- **Every shutdown-only log has `totalNanoAiu` 0** (older builds never computed AIU) while its token counts are large. Under the "real zero is kept" rule this would render **$0.00 est.** for 29 sessions. Tests must pin: a session-total `totalNanoAiu` of 0 is *not reported* (absent), so USD shows `—`/`*`, never `$0.00`.
- `codeChanges.filesModified` (paths) sits at byte offset 145–381, before `modelMetrics` (212–1240): the line is parsed whole, so the canary test must put CANARY there and in `accountingSnapshot.aiCreditsStatus`, `currentModel` and `agentMetrics` keys.
- Session durations p50 0.5 h, p90 9.6 h, max 122 h; 3 of 34 cross a local midnight: day attribution is coarse by nature and must be pinned (whole session on the day of its last shutdown).

## 2. Test files per feature

| Feature | Add | Extend |
|---|---|---|
| (1) Session totals from `session.shutdown` | `test/core/shutdown.test.ts` (monitor-level scenarios, ~25 cases) | `fixtures.test.ts`, `extract.test.ts`, `tailer.test.ts`, `overlong.test.ts`, `store.test.ts`, `monitor.test.ts` (canary, fs-spy, legacy-only), `format.test.ts`, `panelHtml.test.ts`, `filters.test.ts`, `history.test.ts`, `gates.test.ts`, `perf.test.ts` |
| (2) Section navigation (host state) | `test/core/sections.test.ts` (`SECTIONS`, `cleanSection`, nav/main structure) | `panelHtml.test.ts`, `history.test.ts` (links allowlist), `gates.test.ts` (`PANEL_COMMANDS` = 4 and `panel.ts` uses it), `test/integration/extension.test.ts` |
| (3) Side bar summary view | `test/core/sidebar.test.ts` (pure item model + diff key), `test/core/renderGate.test.ts` (shared hidden/unchanged/throttle logic) | `gates.test.ts` (`.vsix` = 5 files, manifest copy check over `viewsContainers`/`views`/`viewsWelcome`), `test/integration/extension.test.ts` |
| (4) Local files only | — (no new read surface beyond one more line type of the same file) | `monitor.test.ts` fs-spy tests keep the exact allowed-open regex; `gates.test.ts` forbidden-API scan unchanged; README copy check |

## 3. Fixtures (`test/fixtures/build.ts`)

```ts
export interface ShutdownModelFixture {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  reasoningTokens: number; totalNanoAiu: number; requests: number;   // requests is written but NOT read
}
/** A `session.shutdown` event; `type` first. `models: null` omits modelMetrics; `{}` writes an empty one. */
export function shutdownEvent(o: {
  id?: string; timestamp?: string;
  models?: Record<string, Partial<ShutdownModelFixture>> | null;   // default { "model-a": defaults }
  filesModified?: string[];                                         // default [CANARY]
  extra?: object;                                                   // shallow-merged into data
} = {}): object
```
Defaults: `model-a` with `inputTokens 7000, outputTokens 1400, cacheReadTokens 3500, cacheWriteTokens 350, reasoningTokens 210, totalNanoAiu 14_000_000_000, requests 7` (hand-computable sums, 7× the usage fixture). `data` also carries, every string CANARY except model ids and ISO times: `shutdownType`, `currentModel: CANARY`, `sessionStartTime`, `totalNanoAiu`, `totalPremiumRequests`, `totalApiDurationMs`, `currentTokens`, `codeChanges { linesAdded, linesRemoved, filesModified: [CANARY], filesModifiedCount }`, `agentMetrics { [CANARY]: { modelMetrics } }`, `accountingSnapshot { aiCreditsStatus: CANARY, modelMetrics }`, `eventsFileSizeBytes`. `undefined` keys are dropped by `compact()` as today.

Scenario helpers in `shutdown.test.ts` (built from `sessionTree`):
- `legacy(id, at)` = `[session.start, turn_end×3, shutdownEvent({timestamp: at})]` (the 29-of-39 case).
- `resumed(id, [at1, at2], models2?)` = `[start, turn_end, shutdown#1, otherEvent("session.resume"), turn_end, shutdown#2]`; `models2` defaults to the same totals (the real case), or larger / with an extra model.
- `both(id)` = `[start, usageEvent×8, shutdownEvent({ models: { "model-a": <exact sum of the 8> } })]`.
- `emptyTotals(id)` with `models: {}`; `noTotals(id)` with `models: null`.
- Malformed: `'{"type":"session.shutdown","data":{"modelMetrics":{"model-a":{"usage":{' + "\n"` (gated prefix, cut JSON).
- Over-cap: a shutdown line with `filesModified` of 20 000 CANARY paths (~500 KB, under 1 MiB); over-carry: the same with 60 000 paths (> 1 MiB).
- Fixtures test: `shutdownEvent()` serialises starting `{"type":"session.shutdown"`; contains CANARY; `models: null` has no `modelMetrics` key; `models: {}` has `"modelMetrics":{}`.

## 4. Feature 1 — tests by layer (all pure, Vitest)

**Gate (`extract.test.ts`):** `classifyLine` returns `"shutdown"` for the prefix; a `user.message` whose text contains `session.shutdown` is `skip` (quotes are escaped, as the usage test does); a key-reordered shutdown line (`{"id":…,"type":"session.shutdown"`) is **`suspect`** (add the type to `SUSPECT_NEEDLES`; otherwise legacy totals vanish silently on a key-order change — decision T3); `isKnownNonUsage` is **false** for the shutdown type (so a > 1 MiB shutdown counts as `overlong`, may-be-usage, not `overlongOther`); the 200 KB canary `skip` line still has 0 decode calls.

**Parser (`extract.test.ts`, `parseShutdownLine(line, folderId)`):** result deep-equals exactly `{ kind: "shutdown", timestampMs, totals: [{ model: "model-a", tokens: {input: 7000, output: 1400, cacheRead: 3500, cacheWrite: 350, reasoning: 210}, nanoAiu: 14e9 }] }` — i.e. `requests.count`, `requests.cost`, `aiCreditsStatus`, `agentMetrics`, `codeChanges.*`, `currentTokens`, `tokenDetails` are not in the result (YAGNI per O4: session totals add to sums, never to calls). Cases: real zero token kept (`cacheWriteTokens: 0` → 0); **`totalNanoAiu: 0` → `nanoAiu` absent** (T1); wrong types absent, not zero; model id failing `MODEL_ID` → `model` undefined (lands in "(unknown model)"); `models: {}` and `models: null` → `{ kind: "no-totals" }` (never `unrecognized`); a model with no known token field → skipped, and if *no* model yields one → `unrecognized: no-known-token-field`; bad timestamp → `bad-timestamp`; `{not json` → `malformed`; different type → `ignored`; canary never in `JSON.stringify(result)`.

**Tailer (`tailer.test.ts`, `overlong.test.ts`):** `TailResult` gains `shutdownLines: string[]` and `shutdownOverlong: number`; `TailerOptions.decodeShutdown` (default false, like `decodeStart`) — with it off, shutdown lines are never decoded (0 `toString` calls). CRLF stripped; a shutdown line split across chunks and across reads decodes intact (reuse the UTF-8 split pattern). A shutdown line over `MAX_SHUTDOWN_BYTES` (propose 64 KB; observed max 4 KB) is **counted in `shutdownOverlong` and not decoded**. In `overlong.test.ts` add `session.shutdown` to the "type name split at every byte" matrix with expected `overlong 1, other 0`, and a > 1 MiB shutdown line in the mixed-kinds file → `overlong`.

**Store (`store.test.ts`):** `UsageRecord.source?: "session-total"`, `key = "end:<sessionId>:<model>"`, `keySource: "shutdown"`; `accumulate` adds the record to the metric sums and to `Counts.ended { rows, sessions, counts }` but **not** to `records`. Pin: sums include it, `records` unchanged, `ended.sessions` is distinct per session, `nanoAiu.missing` grows when a session-total has no AIU (so month USD carries `*`); `projectSummaries` counts it in tokens/USD and `sessions` but not `calls`; `toolSummaries` ignores it (no `tools`); `sessionSummaries` row has `calls 0` and no `growth`; `latest()` includes its timestamp; `resetFile` drops it with the file; `totals()` keep-predicate removes a session's synthetic rows when that session has any per-call record.

**Monitor (`shutdown.test.ts`, injected `now`/`isLive`, T0 = 2026-01-15 as `monitor.test.ts`):**
1. `legacy` today → `today.input.sum 7000`, `today.records 0`, `today.ended.rows 1`, state **`ok`** (was `no-data`), `sessionsWithoutUsage 0`, `health.sessionTotals 1`; status text shows `8.4K tok` (not `—`).
2. `both` → today equals the 8 usage records exactly (no doubling), `ended` undefined, `records 8`.
3. Late per-call record: `legacy` first (synthetic counted), then append one `usageEvent` for the same folder → next snapshot: synthetic gone, totals = that record only, exactly one new snapshot.
4. `resumed` identical → counted once, `ended.rows 1`.
5. `resumed` with second totals 9000 → 9000 (last wins), never 16000; 6. second shutdown adds `model-b` → both models with the last line's values.
7. Two shutdowns on different local days → the session lands on the **last** shutdown's day; the earlier day bucket is empty (T2).
8. `emptyTotals` and 9. `noTotals` → `sessionsWithoutUsage 1`, `unrecognized 0`, state unchanged.
10. No known token field → `unrecognized 1` → `format-changed`, earlier records still counted.
11. Malformed gated shutdown → `malformed 1`, `partial true`. 12. Over-cap → `shutdownOverlong 1`, `partial true`, nothing decoded. 13. > 1 MiB → `overlong 1`, `overlongOther 0`, `partial true`.
14. `totalNanoAiu 0` → month `nanoAiu.reported 0` → `formatUsd` `—`; with one priced session beside it → `*`; never `$0.00`.
15. Truncate/rewrite the legacy log → reset drops and re-adds the synthetic rows (`today.ended.rows` matches the rewritten file). 16. Month rollover forgets last month's synthetic rows (mirror the existing test).
17. Project filter keeps session totals (label from the same log's `session.start`); tool filter hides them and `month.hiddenEnded` (or the agreed name) counts them.
18. fs spy (both `projectNames` variants): opened paths still match only `/session-state/[0-9a-f-]+/events\.jsonl$/` (+ `workspace.yaml` for ID folders); the regex is unchanged.
19. Canary: with shutdown fixtures in the tree, `JSON.stringify` of every snapshot, `tooltipMarkdown`, `renderPanelHtml` (every section) and the log sink lack CANARY.
20. `decodeShutdown`/`sessionTotals` off (if the owner wants a setting, T4): no shutdown line is decoded, state back to `no-data`, `sessionsWithoutUsage 1`.

**Format and panel:** `Health.sessionTotals` and `Health.shutdownOverlong` (feeds `partial`); tooltip and Data health name them ("Sessions counted from end-of-session totals"; "Over-long session-total lines skipped"); `partialNote`-style reason sentence singular/plural; `NOT_COVERED[1]` reworded (A3) and the copy regex still passes in every state and unit; "Calls" tile shows `—`, not `0`, when `records 0` and `ended` set; the `endedNote` footnote appears exactly where sums include session totals (Overview, Models, Daily, Projects, calendar) and nowhere in per-call figures; `README copy check` passes with the new "Line filtering" and A3 wording.

## 5. Feature 2 — section navigation (host state, scripts off)

Rendering: `renderPanelHtml(s, cspSource, view, section = "overview")`; `SECTIONS` (8 ids in nav order) and `cleanSection(unknown): SectionId` in `src/core/sections.ts`; `PANEL_COMMANDS` gains `copilotUsageMonitor.showSection` (4 entries).

Unit (`sections.test.ts`, `panelHtml.test.ts`):
- `cleanSection`: each id round-trips; `"bogus"`, `42`, `""`, `undefined`, a 300-char string → `"overview"`.
- Every snapshot state × every section: exactly one `<nav aria-label="Sections">` whose links are `command:copilotUsageMonitor.showSection?<encoded [id]>` in `SECTIONS` order (count 8, no duplicates), exactly one `aria-current="page"` on the current id, exactly one `<main>`; the current section's `h2` is present and the other seven sections' `h2` text is absent; persistent header, `stateNote` and the banner/footer appear on every section; loading state (no snapshot) renders no nav.
- The links allowlist test (`history.test.ts`) still passes and now sees the 4th command; `gates.test.ts` reads `src/vscode/panel.ts` and asserts `enableCommandUris: PANEL_COMMANDS` and `PANEL_COMMANDS.length === 4`; README says four commands.
- Copy check (`COPY_RE`) on the visible text of every section; canary never in any section's HTML; `is static, locked down` unchanged (no `<script`, `http`, `url(`, `@import`).
- Quick-pick item builder for "Show Section…" is a pure function tested here (the integration harness cannot drive a QuickPick: do not call the command with no args there, the promise would wait for the pick).

Integration (`extension.test.ts`, `_testState` gains `section: string`, `panelRenders: number`, `panelVisible: boolean`):
- `showSection("sessions")` → `section === "sessions"` and `panelOpen`; `showSection("bogus")` → `"overview"`; `showSection(42)` does not throw.
- Section survives `setUnit("cost")`, `selectMonth("current")`, `setFilter("tool","x")`/clear (assert `section` unchanged after each).
- Re-render discipline: `panelRenders` is unchanged across 1.5 s of idle polls; exactly +1 within 2 s after one appended usage line; hide the panel by opening an untitled document in the same column (`openTextDocument({content:""})` + `showTextDocument`) → `panelVisible false`; append a line, wait 2 s → `panelRenders` unchanged; `showDetails` (reveal) → +1.

What the harness cannot do: click inside the webview. Manual acceptance (owner): click each nav link in light, dark and high-contrast themes; the section switches without the page jumping; keyboard Tab reaches the nav. Note for the design: a fragment/`#id` approach was rejected by O3 because every snapshot re-render would reset `:target` and scroll; the host-state design renders one section per snapshot, which is also cheaper (see §7).

## 6. Feature 3 — side bar summary view

Shape: `src/core/sidebar.ts` with `sidebarItems(s: Snapshot | undefined, view: ViewOptions): SidebarItem[]` (`{ id, label, description?, tooltip?: string, command?: { command, args }, children? }`) and `sidebarKey(items): string` (cheap diff key: today total, current, month total, target state, filter, unit, health state). `src/vscode/sidebar.ts` is a thin `TreeDataProvider` created with `vscode.window.createTreeView("copilotUsageMonitor.summary", …)` that fires `onDidChangeTreeData` only when `sidebarKey` changes and the view is visible.

Unit (`sidebar.test.ts`): loading → one "Reading Copilot session logs…" item; `no-dir` → one item whose tooltip names `copilotUsageMonitor.copilotHome`; `permission`; ok → `Today`, `Current session` (live/ended/pinned in the description), `This month` (+ target state text in USD mode), `Top projects` ≤ 3, `Top tools` ≤ 3, `Filter` row only when active with a clear command, `Data health` with `*`/`!` text markers; unreported shows `—`, never `0`; every label/description/tooltip passes `COPY_RE` and carries "Local" somewhere at the root; tooltips are plain strings (no `MarkdownString`, so nothing to trust); every `command` is one of the extension's own commands and `showSection` args are valid `SECTIONS` ids; `sidebarKey` equal for equal snapshots and different when Today changes; canary never in any item.

Integration (`_testState` gains `sidebar: { visible, fires, items: { label, description, command? }[] }`, `context: { state, filterActive }` from the controller's last-set values):
- Contributions: `packageJSON.contributes.viewsContainers.activitybar[0].id === "copilotUsageMonitor"`, `views.copilotUsageMonitor[0].id === "copilotUsageMonitor.summary"`, the icon file exists at `join(ext.extensionPath, icon)`, `viewsWelcome` has a `no-dir` entry; `(await commands.getCommands(true))` contains `copilotUsageMonitor.summary.focus` (VS Code registers `<viewId>.focus` for every contributed view).
- `executeCommand("copilotUsageMonitor.summary.focus")` → `waitFor(x => x.sidebar.visible)`; labels start with `Today` and include `Current session`, `This month`.
- Latency: 5 appended usage lines, each time `sidebar.items[0].description` changes within 2 s.
- Throttle: `fires` unchanged over 1.5 s idle; ≤ 1 fire per appended line over 20 appends (O5 #8).
- Row → panel: take `items[k].command` from `_testState` and `executeCommand(command, ...args)` → `section` equals that row's id and `panelOpen`.
- no-dir: after the existing setting change, `context.state === "no-dir"` (drives the welcome view).

Gates: `.vsix` test becomes exactly `{package.json, README.md, LICENSE, dist/extension.js, media/usage.svg}` and `.vscodeignore` gains `!media/usage.svg` (vsce is silent when the icon is missing — the test is the only guard); manifest copy check extends to `viewsContainers[].title`, `views[].name`, `viewsWelcome[].contents`; forbidden-token scan unchanged (`createTreeView`, `TreeItem`, `ThemeIcon` are fine). If the owner prefers the Explorer container instead, the `.vsix` stays at 4 files and the icon assertions go away.

## 7. Performance

Measured today: cold scan 25 ms on the 20 MB synthetic perf tree and **40 ms on the real 18.6 MB / 127-folder tree**; steady 2–3 ms; idle ~2 ms CPU per 500 ms poll; heap +0.6 MB. The 1 MiB carry cap and chunked reads keep memory flat.

Expected deltas and how to pin them:
- **Gate:** one extra 26-byte prefix compare per line (4,747 lines locally): unmeasurable. **Decode:** ≤ 1 shutdown line per session, p50 0.7 KB, max 4 KB → `JSON.parse` well under 0.1 ms each, < 5 ms for all 34 at cold start; nothing per poll (a shutdown line arrives once, when a session ends). **Memory:** one `UsageRecord` per (session, model) ≈ 40 small objects locally. Cold-start on the full 12-month window stays far inside 2 s.
- **Extend `perf.test.ts`:** (a) add 1 shutdown line (3 models, ~4 KB, 200 CANARY paths) to each of the 40 logs plus **260 shutdown-only legacy logs** of 500 KB canary lines (300 logs, ~150 MB total, 300 folders) → cold < 2 s, steady < 50 ms, idle < 5 ms, heap < 64 MB; (b) one 2 MB shutdown line → counted, not decoded, no heap step; (c) `renderPanelHtml` for each of the 8 sections and `sidebarItems` on the busy-month snapshot: < 5 ms each, printed.
- **Re-render cost is the real risk, not reading.** `renderPanelHtml` itself is < 1 ms (22 panel tests with dozens of renders finish in 17 ms), but `webview.html = …` reloads the webview document (tens of ms on the renderer, a visible flash, scroll and focus reset). Today it already runs only when the snapshot *changed* (`emit` compares a signature with `generatedAtMs` zeroed), i.e. once per model call during a live session (model calls take p50 3.8 s), never on an idle poll. Keep that invariant and add the two missing guards in one pure class so both sinks share it: `RenderGate` in `src/core/renderGate.ts` — `update(key)` returns `render | skip`; `hidden()`/`shown()` defer and flush once; optional `minIntervalMs` (propose 1 s) with an injected clock so two changes inside the interval produce one trailing render. `renderGate.test.ts` pins: same key → skip; hidden → skip and one render on show; burst of 5 keys in 300 ms → 2 renders (leading + trailing). The panel renders **one section** per snapshot, roughly 1/5 of today's HTML. The tree fires `onDidChangeTreeData` only on a `sidebarKey` change and only while `TreeView.visible`; VS Code then asks for ~10 root items, which `getChildren` answers synchronously from the cached snapshot (no await, no fs).
- Startup: `createTreeView` and the status bar are created in `activate`; nothing in the tree provider does I/O, so `onStartupFinished` → first status text stays within AC1's 3 s (today: first snapshot after a 40 ms cold scan).

## 8. Ordered implementation sequence (suite green after every step)

Each step: write the failing tests, run `npm test` (red), implement, run `npm test && npm run typecheck` (green), commit. Steps 1–7 are pure core; the integration suite runs at steps 10, 12 and 13.

1. **Fixtures** — `shutdownEvent`, `fixtures.test.ts` cases. `chore(test): synthetic session.shutdown fixture`.
2. **Gate** — `classifyLine` "shutdown", suspect needle, `isKnownNonUsage` false; `extract.test.ts`, `overlong.test.ts`. (Monitor still ignores the new class: green.) `feat(core): gate session.shutdown lines`.
3. **Tailer** — `shutdownLines`, `shutdownOverlong`, `decodeShutdown`, `MAX_SHUTDOWN_BYTES`; `tailer.test.ts`. `feat(core): deliver bounded shutdown lines`.
4. **Parser** — `parseShutdownLine` allowlist (T1 zero-AIU rule); `extract.test.ts`. `feat(core): allowlist extractor for session totals`.
5. **Store** — `source: "session-total"`, `Counts.ended`, keep-predicate, summaries; `store.test.ts`, `history.test.ts`, `filters.test.ts`. `feat(core): session-total records in the store`.
6. **Monitor** — wire decode, dedupe, health counters, filters; `shutdown.test.ts`, extend `monitor.test.ts`. `feat(core): count sessions without per-call records from session totals`.
7. **Format + panel copy** — `sessionTotals`/`shutdownOverlong` in tooltip and Data health, `endedNote`, A3 wording, `—` for Calls; `format.test.ts`, `panelHtml.test.ts`, README "What it reads"/"What this is not", `docs/SCHEMA.md`, CHANGELOG. `feat(ui): show session totals honestly`.
8. **Perf** — extend `perf.test.ts`; run `PERF=1`. `test(perf): session totals and 300 legacy logs`.
9. **Sections (core)** — `sections.ts`, `renderPanelHtml(…, section)`, nav/main, `PANEL_COMMANDS` ×4; `sections.test.ts`, `panelHtml.test.ts`, `history.test.ts`, `gates.test.ts`. `feat(panel): section navigation`.
10. **Sections (host)** — `showSection` command + quick pick, `_testState.section`; integration tests. `npm run test:integration`. `feat(ext): Show Section command`.
11. **RenderGate** — `renderGate.ts` + tests; `DetailsPanel` uses `visible`/`onDidChangeViewState`; `_testState.panelRenders/panelVisible`; integration render-discipline tests. `perf(panel): skip renders when hidden or unchanged`.
12. **Side bar** — `sidebar.ts` + `sidebar.test.ts`; `src/vscode/sidebar.ts` TreeView through the same gate; `package.json` contributions, `media/usage.svg`, `.vscodeignore`; gates (`.vsix` 5 files, manifest copy); `_testState.sidebar`/`context`; integration tests. `feat(ext): side bar summary view`.
13. **Release** — version 0.4.0, CHANGELOG, README section list; `npm run package`; manual acceptance (§5, §6) on the target machine with `npm run probe` diffed against `docs/SCHEMA.md`.

## 9. Final verification commands

```bash
npm run typecheck
npm test                                      # expect 15+4 files, all green (today 326)
npm run build
NODE_OPTIONS=--expose-gc PERF=1 npx vitest run test/core/perf.test.ts   # cold < 2000 ms, steady < 50 ms, idle < 5 ms, heap < 64 MB
npm run test:integration                      # build + tsc -p tsconfig.test.json + vscode-test (VS Code 1.90.0; first run downloads it)
npm run package                               # copilot-usage-monitor-0.4.0.vsix
npx vsce ls --no-dependencies                 # exactly package.json README.md LICENSE dist/extension.js media/usage.svg
git status --porcelain                        # nothing unexpected (dist/, out/, *.vsix are ignored)
```
Local alternative for the integration suite without a download: a copy of `.vscode-test.mjs` with `useInstallation: { fromPath: "/Applications/Visual Studio Code.app/Contents/MacOS/Code" }` (see `<scratchpad>/design/vscode-test-run/config.mjs`); keep the pinned 1.90.0 for CI.

## 10. Decisions the tests depend on (owner)

- **T1** Session-total `totalNanoAiu` of 0 is "not reported" (every shutdown-only log here has 0 with large token counts). Alternative: keep the zero and show $0.00 est. — not recommended.
- **T2** A session counted from totals is dated on its **last** shutdown; a resumed session that shuts down again on a later day moves there.
- **T3** A key-reordered shutdown line is `suspect` (raises format-changed) rather than silently skipped.
- **T4** Session totals always on, or a `copilotUsageMonitor.sessionTotals` setting (default on). A setting adds one monitor test and a README line; the read surface is the same file either way, one more line type decoded (≤ 64 KB).
- **T5** `MAX_SHUTDOWN_BYTES` = 64 KB (16× the observed maximum).
- **T6** Own activity-bar container with `media/usage.svg` (`.vsix` becomes 5 files) versus a view in the Explorer container (no icon, 4 files).
