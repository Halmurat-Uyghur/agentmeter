# F4 — Adversarial privacy and security review of the v0.4 design (before build)

Reviewer focus: privacy boundary (§4 of the plan), the guard tests, and the four owner-approved v0.4 items:
(1) count sessions without per-call records from `session.shutdown` per-model totals,
(2) left-hand section navigation in the scripts-off details panel via new command URIs,
(3) a side-bar summary view (TreeView or webview view),
(4) local only.

Repo read: README, CHANGELOG, package.json, docs/plans (§2, §4, Tasks 2/3/7/8/9, D20–D27), docs/SCHEMA.md, all of `src/**`, all of `test/**`, `tools/schema-probe.mjs`, the codeburn reverse-engineering note and the gap analysis. Nothing in the repo was modified. Scratch files live only under `…/scratchpad/design/`.

Attacker model used throughout: a process that can write under `COPILOT_HOME` (`~/.copilot`). This is not exotic. Copilot's own agent runs shell commands, so a prompt injection in a cloned repository can append a crafted line to `~/.copilot/session-state/<id>/events.jsonl`, create a folder with a crafted `workspace.yaml`, or drop an `inuse.1.lock`. Every string the extension shows or keys on (model id, tool name, project label, session title, folder id, lock PID) is therefore attacker-chosen.

---

## 0. Verification of the current code base (grep, bundle, tests)

Ran on the worktree at `/Users/halmurat-max/IdeaProjects/copilot-usage-monitor-public/.claude/worktrees/app-feature-research-a18a73`.

| Check | Command / pattern | Result |
|---|---|---|
| Network and credential strings in `src/` | `grep -rniE "https?://\|fetch(\|XMLHttpRequest\|WebSocket\|node:(http\|https\|net\|tls\|dgram\|dns\|child_process)\|hosts\.json\|apps\.json\|\.credentials\|find-generic-password\|keychain\|oauth\|access_token\|accessToken\|Authorization\|Bearer\|api\.github\.com\|api\.anthropic\|secrets\|globalState\|workspaceState\|clipboard\|openExternal\|asExternalUri\|createTelemetryLogger\|writeFile\|appendFile\|createWriteStream" src/` | **0 matches** |
| Non-relative imports in `src/` | `grep -rnE "^import .* from" src/` | only `node:fs`, `node:os`, `node:path`, `vscode` |
| Bundle requires | `grep -oE 'require\("[^"]+"\)' dist/extension.js \| sort \| uniq -c` | `node:fs` ×3, `node:os` ×1, `node:path` ×3, `vscode` ×4; nothing else |
| Bundle strings | same credential/network pattern over `dist/extension.js` (106 KB, built 15:27 today) | **0 matches** |
| Every file-system call in `src/` | `grep -rnE "fs\.(promises\.)?(open\|readFile\|readdir\|stat\|lstat\|…)"` | `discover.ts`: `stat(session-state)`, `readdir(session-state)`, `lstat(<folder>/events.jsonl)`, `readdir(<folder>)`; `tailer.ts`: `open(events.jsonl,"r")` + `handle.stat()`; `monitor.ts`: `stat(session-state)`, `lstat(workspace.yaml)`, `open(workspace.yaml, O_RDONLY\|O_NOFOLLOW)`. No other path is ever opened. |
| `process.env` access | `grep -rnE "process\.env\|env\." src/` | `extension.ts:64` passes `process.env` into the pure resolver; `config.ts:24` reads only `COPILOT_HOME` |
| Writes of any kind | — | the single write is `getConfiguration("copilotUsageMonitor").update("display", …, Global)` (`extension.ts:144`) |
| `MarkdownString` sites | `grep -rn MarkdownString src/` | one, `statusBar.ts:23–26`, with `isTrusted=false`, `supportHtml=false`, `supportThemeIcons=false` |
| Webview options | `panel.ts:22` | `enableScripts:false`, `enableCommandUris: PANEL_COMMANDS` (3 names), `localResourceRoots: []`, `retainContextWhenHidden:false`; CSP `default-src 'none'; style-src <cspSource> 'unsafe-inline'` |
| Dev-only tools | `tools/*.mjs` | `readFileSync` of `events.jsonl` only; no network; not in the `.vsix` (gate test pins the 4 files) |
| Guard tests | `npx vitest run test/core/gates.test.ts test/core/extract.test.ts test/core/overlong.test.ts` | 49/49 pass |

**Result: the current code base makes no network calls, imports no network or child-process module, and reads no credential file.** The only files opened are `session-state/<hex-id>/events.jsonl` and (with `projectNames` on, ID-named folders only) that folder's `workspace.yaml`. This is the exact opposite of codeburn, which reads `~/.config/github-copilot/hosts.json`, `.credentials.json` and the macOS Keychain and calls `api.github.com/copilot_internal/user` and `api.anthropic.com/api/oauth/usage`. The v0.4 design must keep this property; the mitigations below are written so that the guard tests prove it rather than the README asserting it.

---

## 1. Finding 0 — pre-existing, blocking, must be fixed before any v0.4 work touches `byModel`

**Prototype pollution and denial of service from one log line.** `MODEL_ID = /^[A-Za-z0-9._:\/-]{1,100}$/` accepts `__proto__`. `UsageStore.totals()` and `totalsByBucket()` then run `totals.byModel[model] ??= emptyCounts()`; for `"__proto__"` the read returns `Object.prototype`, so `??=` does not assign and `accumulate(Object.prototype, record)` runs.

Proof of concept (scratchpad `design/poc_proto.ts`, bundled with the repo's esbuild and run with node, against the unmodified `src/core/extract.ts` and `src/core/store.ts`):

```
parse kind: usage model: __proto__
totals threw: TypeError Cannot read properties of undefined (reading 'sum')
Object.prototype.records after: NaN | ({}).records === NaN
```

Consequences in the running extension: `snapshot()` throws inside `run()`'s catch → `error refresh EXCEPTION` on every poll, no snapshot is ever emitted again while that record is in memory (status bar frozen on the last state or on "loading"), and `Object.prototype.records` is now `NaN` for **every object in the extension-host process, shared with every other extension**. A single appended line `{"type":"session.usage_record",…,"data":{"usage":{"model":"__proto__","inputTokens":1,…}}}` is enough; a prompt-injected Copilot agent can write it.

The v0.4 shutdown extractor iterates `Object.entries(data.modelMetrics)` whose keys are attacker-chosen model ids, so it reproduces the bug unless the fix lands first.

Required fix (either is sufficient; do both):
- Reject the keys `__proto__`, `constructor`, `prototype` in `MODEL_ID` and `TOOL_NAME` handling (a `safeKey(s)` helper), falling back to `(unknown model)` / dropping the tool.
- Build `byModel` and every log-keyed record map with `Object.create(null)` (or a `Map`) so a hostile key can never resolve through the prototype chain. Use `Object.hasOwn` / `Object.entries` wherever a parsed object is indexed by a log-supplied key.

Required tests (`extract.test.ts`, `store.test.ts`):
- `model id allowlist` table gains `["__proto__", false], ["constructor", false], ["prototype", false]`.
- `store: hostile keys never reach the prototype`: add a record whose `model` is forced to `"__proto__"` (bypassing the extractor) → `totals()` returns, the key is listed under `Object.keys(t.byModel)` or under `(unknown model)`, `Object.getPrototypeOf(t.byModel)` is unchanged, and `({}).records === undefined` afterwards (assert in `afterEach` too, so a leak fails the suite loudly).
- `monitor: a __proto__ model line does not stop snapshots`: append the PoC line → next `refresh()` still emits and `logLines` contains no `EXCEPTION`.

---

## 2. Threat list for the v0.4 design

Severity: H = data leaves the privacy boundary or the extension host is compromised/DoS'd; M = wrong or spoofed figures, nuisance DoS; L = cosmetic.

### 2.1 Item 1 — `session.shutdown` per-model totals

| ID | Threat | Sev | Required mitigation | Guard test |
|---|---|---|---|---|
| **S1** | **Path leakage into memory.** The shutdown line carries `codeChanges.filesModified[]` (absolute paths), `agentMetrics.<agentName>` (user-named agents), `currentModel`, `shutdownType`, `sessionStartTime`, `eventsFileSizeBytes`, `totalPremiumRequests`, `modelMetrics.<m>.requests.cost`. Decoding the whole line puts paths into a JS string and a parsed object. | H | (a) **Byte-cap before decode**: `MAX_SHUTDOWN_BYTES` (propose 64 KB; the probe must report the real p100 — the gap analysis says these lines are "under 1 KB by type", but `filesModified` grows with the session). A shutdown line over the cap is **never decoded**, counts as `overlong` (feeds `partial`), and the session stays in "without per-call data". (b) **Preferred, stronger**: a byte-level sub-object extractor that finds `"modelMetrics":` in the buffer and parses only the balanced `{…}` after it (string-escape-aware brace matcher, bounded by the cap), plus `"totalNanoAiu":<int>` and `"timestamp":"…"` by anchored regex on the head. `codeChanges` is then never decoded at all. (c) Whichever path: the extractor copies allowlisted numbers into a **fresh object literal** and never stores a reference to any parsed sub-object. | `parseShutdownLine: canary never extracted` (canary in `filesModified[0]`, `agentMetrics.<CANARY>`, `currentModel`, `shutdownType`, `modelMetrics.<m>.extra`, `data.summary`; `JSON.stringify(result)` lacks it). `shutdown line over cap is counted overlong and not decoded` (spy `Buffer.prototype.toString` + `TextDecoder.prototype.decode` → 0 calls). Static test: `src/core/extract.ts` source does **not contain** the strings `filesModified`, `codeChanges`, `agentMetrics`, `PremiumRequests`, `requests.cost`, `currentModel` (proves they are not even referenced). |
| **S2** | **Exact shape of what survives.** A future "just one more field" edit silently widens the surface. | H | Record type `ShutdownRecord = { key, keySource:"shutdown", sessionId, folderId, timestampMs, byModel: Record<model, { tokens: Tokens; nanoAiu?: number }> }` and nothing else. Allowed sources: `modelMetrics.<m>.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}` (names to be confirmed by the probe), `modelMetrics.<m>.totalNanoAiu` or top-level `totalNanoAiu`, envelope `id` and `timestamp`. Numbers via the existing `count()` (safe non-negative integers; wrong type → absent, never 0). | `extracts allowlisted fields` uses `toStrictEqual` on the whole record so any extra key fails; `Object.keys(record)` equals the fixed list; `Object.keys(record.byModel[m])` equals `["tokens","nanoAiu"]` or `["tokens"]`. |
| **S3** | **Prototype-key model ids in `modelMetrics`** (`__proto__`, `constructor`) — Finding 0 again, now with keys the attacker controls directly. | H | `safeKey` + `Object.create(null)` as in §1; iterate with `Object.entries`, never index `modelMetrics[name]`. | `shutdown model keys: __proto__/constructor/prototype go to (unknown model) and leave Object.prototype untouched`. |
| **S4** | **Forbidden fields and copy gate.** `totalPremiumRequests`, `requests.cost`, `aiCreditsStatus`-like data are allowance/billing data (D2). "premium" is a banned word. | M | Never read them (S1 static test). Any new tile/label must pass `COPY_RE`. | Existing `panelHtml copy check` and `manifest copy check` cover new labels automatically; add the shutdown-counted states to the `states[]` list. |
| **S5** | **Over-long shutdown lines misclassified as harmless.** Today `isKnownNonUsage()` says a head that names `session.shutdown` is "provably not usage" → counted `overlongOther` → **does not set `partial`**. Once shutdown lines carry totals, a shutdown line over 1 MiB (or over the new cap) would be dropped **silently** and the session would look like "no data" instead of "incomplete". | M | Rename/extend to `isKnownNonData()` with a set of data-bearing types `{session.usage_record, session.shutdown}`; a skipped line whose head names either counts as `overlong`. Add the needle `"type":"session.shutdown"` (and the re-spaced variant) to the `suspect` search only after the probe re-runs `GATE_STRINGS` with it and confirms 0 hits in other line types (quotes inside JSON strings are escaped, so echoed log lines cannot match — but verify). | `overlong.test.ts`: `shutdown line over the limit counts as overlong, not overlongOther` (whole-in-one-chunk, and the existing split-at-every-byte loop extended with `["session.shutdown", 1]`); `nested shutdown type inside a long line is not silently non-data`. `classifyLine`: `{"id":"x","type":"session.shutdown",…}` → `suspect`. |
| **S6** | **Double counting / misattribution (integrity, not leakage).** A session can have usage records *and* a shutdown line; a resumed session can have several shutdown lines; `modelMetrics` may be cumulative or per-leg (codeburn treats them as "per-leg deltas", which suggests cumulative totals it diffs). A crafted shutdown line with huge totals also flips the status bar to "over target". | M | Policy: shutdown totals count **only** for a folder with 0 usage records **in that file**; when the first usage record for the folder arrives the shutdown-derived totals are dropped (both arrival orders). Key = `sd:<folderId>:<eventId>`; "last shutdown wins" vs "sum of legs" is decided by the probe (count lines per file, check monotonicity) — until then, **take the last line only** (never sums). Day attribution = the shutdown `timestamp`; the UI must say "counted at session end". Shutdown-derived figures are shown with a distinct mark (not `*`, which already means "incomplete") and the tooltip/panel name the count: "N sessions counted from session totals". | `monitor.test.ts`: `shutdown-only session counted once`; `usage records win over a shutdown line (shutdown first, usage appended later; and the reverse)`; `two shutdown lines in one file count once`; `format-changed is not raised by a shutdown line without modelMetrics` (it becomes `sessionsWithoutUsage`); `today/current/status bar: shutdown-derived totals are marked and named in the tooltip`. The existing `legacy only: no-data` test flips to the new behaviour — change it deliberately and keep a variant with the setting **off**. |
| **S7** | **Setting that widens decoding is workspace-settable.** If `countSessionTotals` (or whatever it is called) has default `window` scope, a repository's `.vscode/settings.json` can turn decoding of path-bearing lines on or off in that workspace. | M | Every setting that changes what is opened or decoded (`copilotHome` already, `projectNames`, the new toggle) gets `"scope": "machine"`. | `gates.test.ts`: for `READ_WIDENING = ["copilotHome","projectNames","<new toggle>"]`, assert `properties[k].scope === "machine"`. Integration: open a workspace fixture whose `.vscode/settings.json` sets `copilotHome` to a canary folder and assert `_testState().snapshot.health.rootSource !== "setting"` (the plan's Task 8 test; the current integration test only checks `package.json`). |
| **S8** | **Timestamps.** `sessionStartTime` and `timestamp` are attacker-chosen; `DAY_SLACK_MS = ∞` means a record dated 2099 counts as "today" and "this month" forever (pre-existing for usage records too). | L–M | Validate with `Date.parse` finite and ≤ now + 24 h; later → `unrecognized: bad-timestamp`. | `extract: far-future timestamp is unrecognized`; `store: a record 25 h ahead is not today`. |

### 2.2 Item 2 — left-hand section navigation via new command URIs

| ID | Threat | Sev | Required mitigation | Guard test |
|---|---|---|---|---|
| **N1** | **Argument injection into the new command.** If the section id is ever built from, or concatenated with, a log-derived string (e.g. "jump to project X"), the handler receives attacker text; if that text is echoed into HTML, used as a selector, or persisted, it is an injection or a settings write. | H | The section argument is a **closed enum**: `SECTIONS = ["overview","trend","daily","today","session","models","calendar","projects","tools","sessions","health"] as const` (ids match `/^[a-z][a-z0-9-]{1,30}$/`). Handler: `const id = SECTIONS.includes(arg) ? arg : undefined; if (!id) return;` — no render, no log, no echo. State lives in memory only (never `update()`d into settings; the README promises `display` is the only write). | `parseSection("<img>")`, `("__proto__")`, `({})`, `(["overview"])` → `undefined`; `("projects")` → `"projects"`. Integration: `executeCommand("copilotUsageMonitor.showSection","<img src=x>")` leaves `_testState().section` unchanged and writes no setting (`inspect` shows no `globalValue`). |
| **N2** | **Prefer no new command at all.** VS Code's webview host script handles same-document `#fragment` links without content scripts (it `scrollIntoView`s the element with that id). That removes the new command-URI surface entirely. | — | Use `<a href="#projects">` for navigation; add the command only if a "single section at a time" re-render is wanted. If kept, `enableCommandUris` becomes exactly `[selectMonth, setUnit, setFilter, showSection]` — still an array, never `true`. | `panelHtml: every href is either "#<id>" with id ∈ SECTIONS or "command:copilotUsageMonitor.<name>?…" with name ∈ PANEL_COMMANDS; the count of href= attributes equals the count that match` (so no third kind can appear). `gates`: token `enableCommandUris: true` banned; `panel.ts` must contain `enableCommandUris: PANEL_COMMANDS`. |
| **N3** | **Command-URI argument content.** Today `setFilter` hrefs embed project keys and tool names from logs (JSON → `encodeURIComponent` → `escapeHtml`), validated on receipt (`filterValue` ≤ 200 chars). Titles must never enter an href. | M | Keep: hrefs carry only *keys* (folder label / tool name, already regex-limited), never titles; handler validation stays. | `panelHtml: decoding every command href's %5B…%5D yields an array of strings, each ≤ 200 chars, matching /^[A-Za-z0-9 ._@+:\/-]*$/, and never containing the hostile title fixture`. |
| **N4** | **External links.** A webview with scripts off still opens `http(s)` hrefs in the system browser via VS Code; a log string rendered unescaped as a link is a phishing/exfil path. | M | All text escaped (already); the href-allowlist test above makes any non-`command:`/non-`#` href fail. Keep `html not match /https?:\/\//` (exists). | Covered by N2's test. |

### 2.3 Item 3 — side-bar summary view

| ID | Threat | Sev | Required mitigation | Guard test |
|---|---|---|---|---|
| **V1** | **Markdown injection in TreeItem tooltips.** `TreeItem.tooltip` accepts a `MarkdownString`; with `isTrusted: true` or `{ enabledCommands }` (codeburn's pattern) a log-derived string can become a clickable `command:` link. Titles may contain `[`, `]`, `(`, `)`, backticks, `<`, `>`, `$(` (only Cc/Cf are stripped). | H | Tooltips are **plain strings**, or `MarkdownString` built through `escapeMarkdown()` with `isTrusted=false`, `supportHtml=false`, `supportThemeIcons=false`. No `enabledCommands` anywhere. | `gates`: tokens `isTrusted = true`, `isTrusted: true`, `enabledCommands`, `supportHtml = true` banned; static count of `new vscode.MarkdownString(` equals the count of `.isTrusted = false`. Pure `sidebarModel(snapshot, view)` test: hostile title/project/tool/model → no tooltip contains an unescaped `[ ] < >` or `](`. |
| **V2** | **HTML injection, if a webview view is chosen.** Same class as the panel; one more renderer to keep locked down. | H | **Prefer a TreeView** (no HTML, no CSP, no command URIs, native accessibility). If a WebviewView is chosen anyway: identical options to the panel (`enableScripts:false`, `enableCommandUris: PANEL_COMMANDS`, `localResourceRoots: []`), same CSP, rendered by a pure core function, and the whole `panelHtml.test.ts` suite parametrised over both renderers. | `gates`: `enableScripts: true`, `postMessage`, `onDidReceiveMessage`, `asWebviewUri`, `registerWebviewPanelSerializer`, `registerWebviewViewProvider` (if TreeView is chosen) banned. |
| **V3** | **`resourceUri`, `iconPath`, `contextValue`, `id` from log data.** `resourceUri` makes VS Code resolve decorations and icons for a path taken from the log (reveals and acts on paths); `iconPath` could point at a file; `contextValue` feeds `when` clauses. | M | Never set `resourceUri`; icons only as `ThemeIcon` with fixed ids; `contextValue` from a fixed enum; `id` from folder id (hex) or fixed strings, never from titles. | `gates`: `resourceUri` banned token; `sidebarModel` test: every item's `icon` ∈ fixed set, `contextValue` ∈ fixed set. |
| **V4** | **Item commands with arguments.** Rows that run `setFilter("project", name)` pass arguments directly (no URI encoding) — fine as long as the handler validates (it does). | L | Reuse the existing handlers; arguments are keys only. | `sidebarModel`: every `command` ∈ `{showDetails, selectMonth, setUnit, setFilter, showSection, pinSession}` and args pass `filterValue` / `parseSection`. |
| **V5** | **QuickPick / tree label codicon spoofing.** QuickPick labels render `$(icon)`; a title `$(warning) Your usage is blocked` shows a warning icon. Cosmetic, but it is the same string that the pin/filter pickers already show. | L | Strip `$(`…`)` sequences from titles in `parseWorkspaceName` (one regex), or render pickers with `label: escaped`. | `parseWorkspaceName("name: $(warning) x")` → `"x"` (or `"$ (warning) x"`); copy check on labels. |
| **V6** | **Welcome view and container contributions.** `viewsWelcome[].contents` supports Markdown command links; `views[].name`, `viewsContainers[].title` are user-visible copy. | L | Static text only (never log data); only `command:copilotUsageMonitor.*` links. | `gates manifest copy check` extended to `viewsWelcome[].contents`, `views[].name`, `viewsContainers[].title`; every `command:` in `viewsWelcome` ∈ contributed commands. |
| **V7** | **Packaging.** An activity-bar SVG adds a file to the `.vsix`; the 4-file gate must change deliberately; an SVG can carry `<script>` or external `href`s. | L | Prefer a codicon or place the view in the Explorer container (no icon). If an SVG ships: list it explicitly in the `.vsix` test and assert it contains no `<script`, `on*=`, `http`, `@import`, `url(`. | `.vsix` test set updated by hand; new `media svg is inert` test. |
| **V8** | **Rendering from the wrong input.** A renderer that reads `FileState`/raw lines instead of `Snapshot` bypasses every canary test. | H | Structural rule: core renderers take `(Snapshot, ViewOptions)` only; the vscode layer maps 1:1. | `sidebarModel canary`: build from the monitor's canary fixtures (add a shutdown line with canary paths) → `JSON.stringify(items)` lacks `CANARY`. |

### 2.4 Malicious logs under `COPILOT_HOME` (cross-cutting)

| ID | Threat | Sev | Status / mitigation | Guard test |
|---|---|---|---|---|
| **L1** | Prototype pollution via model id — **confirmed live** (§1). | H | Fix before v0.4. | §1 tests. |
| **L2** | Crafted `session.shutdown` with huge totals or far-future timestamps flips the target state / "today" (S6, S8). | M | Timestamp upper bound; shutdown figures marked and named. | S6/S8 tests. |
| **L3** | DoS by size/count: 1 MiB carry cap, 256 KB chunks, perf budget; `JSON.parse` of a 1 MiB nested array → `RangeError` caught → `malformed` (OK). A `historyMonths=24` plus thousands of folders is bounded by the perf test only. | L | Keep caps; add the shutdown byte cap (S1). | Existing perf test; add 1 MiB nested-array usage line → `malformed`, no throw. |
| **L4** | Spoofed liveness: `inuse.1.lock` → `kill(1,0)` → `EPERM` → "live" (`isLive` treats EPERM as alive). Signal 0 is harmless; effect is a wrong "current session". | L | Accept (documented D7), or require the lock PID to be ≥ 2 and owned by the user (`process.getuid`-free check not available) — leave as is. | `discover: pid 1 is live by EPERM` already implied; no change. |
| **L5** | Symlinks: `session-state` itself as a symlink is followed (`stat`), folder symlinks skipped, `events.jsonl` symlinks skipped, `workspace.yaml` opened `O_NOFOLLOW`. A hard link named `events.jsonl` to a foreign file is read, but only gated lines are decoded and only numbers survive. | L | Keep. | Existing `symlinked events.jsonl skipped`; add `session-state symlink to a folder outside root still opens only events.jsonl` (fs spy). |
| **L6** | Regex DoS on title/label parsing: `parseWorkspaceName`'s quoted-scalar regexes are linear (disjoint first characters), inputs ≤ 16 KB; label regexes are simple classes ≤ 100 chars. | L | Keep inputs capped. | Add `parseWorkspaceName` on 16 KB of `'` and of `\"` returns within 50 ms. |
| **L7** | Output channel: `Logger` only emits identifiers/ints/codes. Risk is a future call like `log.count(folderId, 1)` — a lowercase hex id starting with a letter passes `IDENT`. | M | Static rule: first argument of every `log.count/error/timing` call is a string literal. | `log.test.ts`: grep `src/**` for `log\.(count\|error\|timing)\(` and assert the first argument matches `/^"[a-z][a-z0-9_.-]*"$/`. |

### 2.5 Egress by proxy (item 4, "local only")

| ID | Threat | Sev | Mitigation |
|---|---|---|---|
| **E1** | The UX research note suggests a Language Model tool (`vscode.lm.registerTool`) or an MCP server so Copilot can answer "how much have I spent". Anything handed to Copilot is sent to GitHub inside Copilot's own requests — a network egress of the extension's data by proxy, and it would put project labels and session titles into prompts. | H | **Veto for v0.4.** Ban tokens `registerTool`, `registerMcpServerDefinitionProvider`, `lm.` in `gates.test.ts`. |
| **E2** | "Copy summary" / export (clipboard, untitled document) are deferred owner decisions and not in v0.4. | M | Keep `clipboard`, `writeFile`, `openTextDocument` (add) banned until the owner decides. |

---

## 3. Guard tests

### 3.1 Existing tests to extend (file by file)

**`test/core/gates.test.ts`**
- `TOKENS` += `enableCommandUris: true`, `retainContextWhenHidden: true`, `isTrusted = true`, `isTrusted: true`, `enabledCommands`, `supportHtml = true`, `supportHtml: true`, `postMessage`, `onDidReceiveMessage`, `asWebviewUri`, `registerWebviewPanelSerializer`, `registerUriHandler`, `resourceUri`, `registerTool`, `registerMcpServerDefinitionProvider`, `lm.`, `openTextDocument`, `userInfo`, `hostname`, `networkInterfaces`, `showInformationMessage`, `showWarningMessage`, `showErrorMessage` (no pop-ups is a product rule; QuickPick stays allowed). Extend the self-test so each new token is proven to match.
- New: `webview options are locked` — `src/vscode/panel.ts` (and any view provider file) contains `enableScripts: false`, `enableCommandUris: PANEL_COMMANDS`, `localResourceRoots: []`.
- New: `read-widening settings are machine-scoped` (S7).
- New: `every MarkdownString is untrusted` (V1 static count).
- New: `extractor never references content-bearing shutdown keys` (S1 static grep on `src/core/extract.ts`).
- Extend `manifest copy check` to `views`, `viewsContainers`, `viewsWelcome`, `menus` titles; assert every command in `package.json` is registered in `src/extension.ts` and vice versa (prevents a registered-but-unlisted command, and an `enableCommandUris` entry that is not a real command).
- `.vsix` set updated only if a media file is added, with the inert-SVG check (V7).

**`test/core/extract.test.ts`**
- Finding 0 rows in the model allowlist table; same for `toolCounts` keys.
- New `parseShutdownLine` block (S1–S4, S8): `extracts allowlisted fields` (`toStrictEqual`), `real zero kept`, `wrong type absent not zero`, `canary never extracted`, `no model with a token field → no-known-token-field`, `missing id → no-key`, `bad/far-future timestamp`, `prototype keys → (unknown model)`, `modelMetrics not an object → unrecognized`, `more than 64 models → capped` (match `MAX_TOOLS` style).
- `classifyLine`: `shutdown` prefix → `"shutdown"`; over `MAX_SHUTDOWN_BYTES` → overlong path, never decoded (spy); key-order variant → `suspect` (after probe confirmation).

**`test/core/overlong.test.ts`** — S5 cases: `isKnownNonData` false for `session.shutdown`; split-at-every-byte loop gains the shutdown type expecting `overlong: 1, other: 0`.

**`test/core/tailer.test.ts`** — `decodeShutdown` option: off → shutdown lines neither decoded nor delivered (0 `toString` calls on them); on → delivered once, CRLF stripped.

**`test/core/monitor.test.ts`**
- fs-spy tests unchanged in their regex (no new file may be opened) — re-run with the shutdown setting on.
- `canary` fixture gains `otherEvent("session.shutdown", { data: { codeChanges: { filesModified: [CANARY] }, agentMetrics: { [CANARY]: {} }, currentModel: CANARY, modelMetrics: { "model-a": { usage: {...} } } } })`; snapshots and `logLines` lack `CANARY`.
- S6 dedupe/ordering tests; `legacy only` test split into setting-off (`no-data`) and setting-on (counted, marked).
- Finding 0: `a __proto__ model line does not stop snapshots`.

**`test/core/panelHtml.test.ts`**
- `href allowlist` (N2/N3), `section nav ids ∈ SECTIONS and every <section id> ∈ SECTIONS`, hostile **title**, **project label** and **tool name** fixtures (today only the model id is tested) checked in the chip, both tables, `title=` attributes, the filter chip and the "Only project X" fine print; `states[]` gains shutdown-counted and section-selected snapshots for the copy check.

**`test/core/format.test.ts`** — tooltip with hostile title/project in `current`/`byModel`; new "N sessions counted from session totals" line passes the copy regex.

**`test/core/log.test.ts`** — L7 static test.

**`test/integration/extension.test.ts`** — `showSection` bad-arg no-op and no settings write (N1); machine-scope with a real workspace settings file (S7); sidebar: `_testState()` exposes the tree model, assert it contains no `CANARY` and no `http`.

### 3.2 New test files
- `test/core/shutdown.test.ts` — the `parseShutdownLine` block above plus the byte-level sub-object extractor tests if S1(b) is built: `modelMetrics object found by bytes; codeChanges bytes never decoded (spy)`, `unbalanced braces → malformed`, `string containing "}" inside modelMetrics handled`, `cap enforced`.
- `test/core/sidebar.test.ts` — pure `sidebarModel(snapshot, view)`: canary, hostile strings, command/args allowlist, icon/contextValue allowlist, no `resourceUri`, copy check on every label/description/tooltip.
- `test/core/sections.test.ts` — `SECTIONS` shape, `parseSection`, nav HTML ids, and that selecting a section does not change any figure (render equality outside the nav).

---

## 4. Vetoes (anything in the design I would block)

1. **Keeping any parsed shutdown sub-object or any field outside the S2 allowlist** — in particular `codeChanges.*`, `agentMetrics.*`, `currentModel`, `shutdownType`, `totalPremiumRequests`, `requests.cost`, `eventsFileSizeBytes`. Also decoding a shutdown line above the byte cap, or counting such a line as `overlongOther`.
2. **A trusted `MarkdownString` (`isTrusted: true` or `{ enabledCommands }`) anywhere that can contain a log-derived string** — codeburn's tooltip pattern is not acceptable here; put the "open" affordance in the item's `command` instead.
3. **A WebviewView with scripts, `postMessage`, or `enableCommandUris: true`;** a TreeView `resourceUri`/`iconPath`/`contextValue` derived from log data.
4. **A section-navigation command whose argument is anything but a closed enum**, or that persists the selected section to settings.
5. **Any new setting that widens what is opened or decoded with `window`/`resource` scope** — it must be `machine`.
6. **A Language Model tool or MCP server exposing usage to Copilot in v0.4** (E1): it is network egress by proxy.
7. **Shipping v0.4 with Finding 0 unfixed.**

---

## 5. Design recommendations (positive guidance)

- **Shutdown extractor shape**: `classifyLine` returns `"shutdown"` for the prefix when the line is ≤ `MAX_SHUTDOWN_BYTES`; the tailer delivers `shutdownLines` only when `decodeShutdown` is on; `parseShutdownLine(line, folderId)` mirrors `parseUsageLine` (same `ParseResult` kinds, `keySource: "shutdown"`). Store keeps `ShutdownRecord`s in a separate map keyed by folder, consulted by `totals()` only for folders with no usage record in the window. Mark derived figures distinctly and name the count in tooltip, panel and the tree.
- **Navigation**: `#fragment` anchors first (zero new attack surface); the command only if single-section mode is wanted, with `SECTIONS` enum and in-memory state.
- **Sidebar**: TreeView in the Explorer container, items built by a pure `sidebarModel()` in `src/core/`, plain-string tooltips, fixed `ThemeIcon`s, commands with key-only args.
- **Probe before code** (`npm run probe` extended): for `session.shutdown` report lines per file (0/1/n), line-size p50/p100, whether `modelMetrics.<m>.usage` counts are monotonic across several shutdown lines in one file, the exact key names/types under `usage`, whether `totalNanoAiu` exists per model and top level, and `GATE_STRINGS` hits for `"session.shutdown"` in other line types. Stop if the usage keys are not integers or if `modelMetrics` is absent from most pre-1.0.99 shutdown lines (then the coverage gain is smaller than D3 assumed).
- **Docs**: README "What it reads" and `docs/SCHEMA.md` "Never read" must list the shutdown fields kept and dropped, exactly as they do for `session.start`.
