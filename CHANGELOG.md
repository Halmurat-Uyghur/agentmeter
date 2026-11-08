# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 0.7.1 - 2026-11-08

### Added

- **A logo.** A usage gauge over three rising bars (`media/icon.svg`, `media/icon.png`, `media/activity.svg`), drawn in code with Remotion (`tools/logo`, development only; `npm run export` there rewrites the three files). It is the extension's icon, the icon on the details panel's editor tab (before, the tab had none) and the activity bar icon, in place of the generic graph glyph. The icons add about 80 KB to the .vsix; nothing else changes and no network or settings are involved.

### Fixed

- **The section nav no longer jumps when you open Data health.** Data health used to swap the one-line "Local logs on this computer only" note above the month bar for the full provenance text, so on that one section the month bar, the section nav and the content sat lower, and they moved back up on the next click. The chrome above the month bar is now the same on every section; Data health shows the full text openly at the top of its own content instead.

## 0.7.0 - 2026-11-07

A review release: ten independent reviews of the whole code base (parsing, discovery, aggregation, formatting, insights, the panel, the VS Code layer, security, docs and an end-to-end run in VS Code 1.90), each finding reproduced before it was fixed, and every fix shipped with its regression test. No new data is read; nothing is stored.

### Added

- **Collapsible section navigation.** A toggle at the top of the details panel's section nav collapses it to a narrow icon rail and expands it again. In the rail each icon keeps its section name as a tooltip and for screen readers, Data health still shows its `!` or `*` mark, and the groups are separated by a line. The choice is remembered in the `copilotUsageMonitor.panelNavCollapsed` user setting (also "Copilot Usage: Collapse or Expand Panel Navigation" in the Command Palette). A narrow panel, where the nav is already a row above the content, shows full labels and no toggle.
- **Currency in the side bar.** The side bar footer shows **Currency: USD** (or CAD, or whichever you chose) next to the unit switch; click it to open the currency picker. The picker is also in the side bar's `…` menu as **Choose Currency…**. While a non-USD rate is still being fetched, the link names the chosen currency and its tooltip says figures stay in USD until the rate arrives.

### Changed

- **Settings scopes.** `copilotUsageMonitor.currency` is now application-scoped and `copilotUsageMonitor.projectNames` machine-scoped (user settings only, like `copilotHome`, `sessionTotals` and `targetAlert`). A repository's workspace settings can no longer turn on the exchange-rate request or turn project-name reading back on. Workspace-level values of these two keys no longer apply.
- **Unit switch and workspace settings.** The Tokens / USD switch writes `display` at the scope where that setting already has a value (folder, then workspace, then user), the standard VS Code pattern, so a workspace value no longer makes the switch snap back. If the write fails, the unit rolls back. Arguments that are not `tokens` or `cost` are ignored.
- **Target state on the figures as shown.** The status bar icon and the opt-in alert say "over" (or "under") only when the shown spend differs from the shown target bound. Before, max $150 and a spend of $150.40 showed "🔥 $150 / $20.00–$150" and alerted "over your target: $150".
- **Money formatting.** The number of decimals is chosen after rounding ($1.00, not $1.000; $100, not $100.00), and an estimated cost that is not zero but rounds to zero shows `<$0.001` (read as "less than 0.001 US dollars") instead of `$0.000`. The Δ columns decide "same" in the display currency, so GBP no longer shows "▲ £0.000" and a JPY change of ¥0.06 is shown.
- **Screen readers and currencies.** Amounts in a currency whose symbol contains a dollar sign (CA$, A$, NZ$, HK$, MX$, R$) are read as "16.92 CAD", not "CA16.92 US dollars"; a bare `$` is still "US dollars", and €, £, ¥ and CHF amounts are read with their code.
- **Insights.** The long-context rule needs 3 priced calls and the cache-reuse rule 20, so a rule can no longer fire on a cost that covers a fraction of the calls it names. In the side bar, when the panel is filtered, the Insights row says its count follows the panel's filter (it links to the filtered section). A largest prompt of 999,600 tokens reads "1.0M", not "1000K".
- **Data health.** A session folder whose log cannot be checked because of a transient error (for example too many open files) keeps its records and marks the data partial, instead of being dropped silently until the next start. A log that stays unreadable (for example owned by another user) keeps Data health partial until it is fixed or removed; before, it was skipped without a word. A log that disappears drops its records at once; a log recreated afterwards counts once.
- **Ids and timestamps read more strictly.** A usage id is kept only when it is at most 1,024 characters of base64 or id punctuation (real ids are about 500 characters of base64); otherwise the event id is used, and a line with neither is counted as unrecognized. A timestamp must be `YYYY-MM-DDTHH:MM:SS[.fff]Z` (or with an offset); "1" or a zone-less time is a bad timestamp, counted in Data health, instead of a date in 2001 or a time shifted by the local offset. A session start of `0` is no longer a start in 1970.
- `docs/SCHEMA.md` documents the 1 MiB usage-line cap, the record-key policy, the timestamp rule, the case-insensitive session-id pattern, the UTF-8 BOM rule and the regular-file rule.

### Fixed

- **A session folder copied under another id counted the whole session twice.** The copy's per-call records were deduplicated against the original, so the copy never registered as having per-call records and its session total stayed visible. The store now tracks which folders hold each call, so the total is hidden and stays hidden after either folder's log is removed.
- **A throwing output sink stopped every later refresh.** If the output channel threw (for example after it was disposed), the refresh chain held a rejected promise for the rest of the session. The logger swallows sink errors, and a rejected run no longer wedges the chain.
- A UI callback that threw once suppressed later identical snapshots; the snapshot signature is now recorded only after the callback returns.
- The exchange-rate timer could fire, and fetch again, after the extension was deactivated; two overlapping currency changes left two timers and logged a failure for a currency no longer selected. Each fetch now carries a generation number and stops when superseded or disposed.
- The viewed month no longer jumps back to a stale month after `historyMonths` is lowered and raised again.
- A `copilotHome` setting that was not a string crashed activation; it is now treated as unset. `~\` is expanded on Windows.
- A UTF-8 byte-order mark at the start of a log hid the project label or the first record; one before `name:` in `workspace.yaml` hid the session title.
- A wall clock set back held a focused panel's redraws for the size of the jump plus 10 s; elapsed time is now clamped.
- The daily-activity heatmap skipped the label of a month that started within the first weeks of the grid (July, with history back to January).
- In the tokens view the side bar's `*` (may be incomplete) marker was unstyled; it now matches the USD view.
- An unknown three-letter currency code in settings caused a 15-minute retry loop; it now falls back to USD. The rate response must carry a real date and a rate of at least 0.000001.
- "Don't show again" no longer leaves an unhandled rejection when settings cannot be written.
- README: the side bar has five command links (the fifth chooses the currency) and shows the currency link; the Overview bullet names the Today figure, the daily-activity heatmap, the cache ring and the 30-day bars; the settings table gives the new scopes. The walkthrough's folder page had the folder precedence backwards. The bug-report template's example version was stale.
- `npm run package` rebuilds the bundle first (`vscode:prepublish`), so a `.vsix` can no longer ship a stale `dist/`. The opt-in perf test takes the median of five steady refreshes against a 75 ms budget instead of one sample against 50 ms. `tools/chat-schema-probe.mjs` says plainly when nothing was found and exits with code 2, like `schema-probe.mjs`.

### Security

- **Logs must be regular files.** `events.jsonl` and `workspace.yaml` are opened with `O_NOFOLLOW | O_NONBLOCK` and checked with `fstat`; a FIFO or a symlink renamed over a log after discovery is counted as unreadable instead of blocking the monitor for the rest of the session or reading a file outside the Copilot folder.
- **Bounded record keys.** A usage id is capped at 1,024 characters (see Changed), so a crafted log cannot grow memory without bound through its ids.
- **Bounded rate response.** The exchange-rate body is capped at 4 KB (`MAX_RATE_BYTES`), checked on `content-length` and again on the text, before it is parsed; an oversize or malformed reply is logged as `BAD_RESPONSE`. Redirects are still followed (the provider has moved hosts before); the response is validated as before.
- A `"type"` key with extra spaces or a tab before the type name is now counted as suspect, as `docs/SCHEMA.md` always said; the check is anchored to the start of the line, so the type name inside another event's data is not matched.
- The side bar's command allowlist grows from four to five commands (adds `selectCurrency`, which takes no arguments).
- New gates pin the setting scopes, the tailer's open flags, the response cap and `vscode:prepublish`.

## 0.6.1 - 2026-11-07

### Fixed

- **Day dates on hover.** The daily charts now name the day under the pointer at once, with its weekday: "Wed Nov 4: $0.600 USD (est.)". This covers the Overview's 30-day bars, the daily activity squares (a readout line under the grid, with a "Hover a square to see its date" hint) and the Daily section's trend bars and calendar. Before, the date was only in a native tooltip, which is slow or missing in the panel. Still no scripts: the readouts are CSS only, and readouts at either end of a chart stay inside it.

## 0.6.0 - 2026-11-07

### Added

- **Session call list.** Click a session in the Sessions table to list its calls at the top of the section: time, model, who started the call (you or the agent), uncached input, cache read, cache write, output, reasoning, tool definitions as a share of input, AIU, USD (est.) and how it ended (an answer or tool calls). Tiles above the list sum the session: calls, prompts, agent calls, cost or tokens, cache-read share, the uncached input's cost and its cost at the cache-read price, and the tool-definition share. The newest 200 calls are kept and the first 25 shown, the rest folded; older calls are counted but not listed. A session counted from a session total says it has no per-call records. **Close the call list** or clicking the row again closes it.
- **Prompts and agent calls** (Sessions): "N prompts triggered M agent calls" for the viewed month, agent calls per prompt and the average per prompt (USD est., or tokens). A prompt's chain is its own call plus the agent calls after it in the same session, up to the next prompt. Calls that logged no initiator, or that come before the first prompt in view, are named and left out, never counted as 0. The status bar tooltip adds the current session's last prompt.
- **Cache by model** (Models): cache-read share of input per model, and the exact estimated cost of the uncached input next to the same tokens at the cache-read price, plus cache-read and cache-write cost. The costs come from the per-token-type AI credits Copilot logs with each call; `—` where none were logged. A call that logged no cache-read price still shows its uncached-input cost; the cache-read comparison covers only calls with that price, and the card says so. The copy says plainly that the cache-read price is not a saving you could have had.
- **Tool definitions in the prompt** (Tools): the share of input taken by tool descriptions, overall and for the calls that used built-in tools, each server or plugin, or no tool, with tokens per call and tools offered on average. Shown as a share of input, never as an extra cost; Copilot logs one figure per call, so it is not split by server.
- **Change vs last month.** The Projects, Models and Tools tables add a "Δ vs Oct 1–6" column: the viewed month so far minus the same point last month (a past month: minus the whole month before), per row, in the active unit and display currency, under each table's own filter rules. ▲ or ▼ with the amount, never a percentage; "same" when equal at display precision; "new" (no arrow) when the row logged nothing then; `—` when either side has no figure in the unit; `*` when either side may be incomplete. Rows logged last month but not this month are counted in the fine print. No column when the month before is outside `historyMonths`, and the table says why. Screen readers hear "Change" and the amount in words.
- **Target-crossed alert** (opt-in, `copilotUsageMonitor.targetAlert`, default off): one notification when this month's estimated cost first goes above `monthlyTargetMax`, in the display currency, with **Open dashboard** and **Don't show again** (sets the setting back to `false` in user settings; the setting is application-scoped, so a workspace cannot turn it back on). At most once per calendar month per window, remembered in memory only, so a new window may say it again; it also fires once after start-up when the month is already over. Never without a target max, and never while a non-USD currency waits for its rate.
- **Getting-started walkthrough** (`contributes.walkthroughs`, works on VS Code 1.90): check that the Copilot logs are found (opens the `copilotHome` setting), choose tokens or estimated cost and a currency, set a monthly target range (with a word on the opt-in alert), and open the side bar and the panel. Each step has a short Markdown page; its buttons are built-in or own commands only.
- **Status bar content** (`copilotUsageMonitor.statusBar`, default `today`): `month` shows this month so far and `session` the current session, in tokens or estimated cost. `today` keeps the earlier text (today's tokens, or this month against the target in the cost view). The icon always shows this month's target state, the target range follows only a month figure, and the tooltip keeps every figure (with `month` in tokens it adds this month's tokens). The spoken label names the period.
- **Insight: long prompts.** Calls whose prompt went past a model's long-context price threshold (GitHub's published table as of 2026-11: claude-haiku-5.5 100K, gpt-6-sol 272K, grok-4 models 200K). Fires at 3 calls costing at least $0.50 (est.); unknown models never fire.

### Changed

- Overview's Month to date card compares with the same point last month as an amount and names both periods ("▲ $2.70 Nov 1–6 vs Oct 1–6 ($6.40)"), instead of a ratio ("▲ 1.4× vs October at this point"). A past month compares with the whole month before ("October vs September"). No arrow when either side has nothing logged.
- Each usage record now also reads `initiator`, `finishReason`, `toolTokenCount`, `availableToolCount` and, from `copilotUsage.tokenDetails[]`, each entry's token type, token count, batch size and cost per batch. The two text fields are mapped to fixed values (anything unknown becomes "other") and the log's text is never kept; the per-type split is kept only when it adds up to the logged AI credits. The entry's model name is not read. See `docs/SCHEMA.md`.
- Data health now opens with "Not covered: Copilot Chat in VS Code (only Copilot CLI logs are read), so figures are a lower bound for Chat users.", always shown. The side bar adds one compact "Copilot Chat in VS Code not counted" line that opens Data health.
- The panel's command allowlist grows from four to five commands (adds `showSession`). Its argument is only accepted when shaped like a session folder id; the selected session is kept in memory only. The command is hidden from the Command Palette.
- `toolGroup` moved to `store.ts` (still re-exported by the panel).

### Security

- The `.vsix` allowlist grows by exactly four files, `media/walkthrough/{folder,unit,target,open}.md`, each named in `.vscodeignore` (no globs). A gate checks the packaged file list, that the pages are under 2 KB with no links, HTML or URLs, and that the walkthrough's command links are exactly the six expected (settings for `copilotHome` and the targets, `toggleUnit`, `selectCurrency`, the side bar container and `showDetails`).
- New gates: a notification (`showInformationMessage` / `showWarningMessage` / `showErrorMessage`) may appear only in `src/vscode/targetAlert.ts`, once, and in the bundle once; configuration writes are allowlisted per file (`display` and `currency` in `extension.ts`, `targetAlert` only in the alert, only to `false`).

## 0.5.0 - 2026-11-06

### Added

- **Display currency** (`copilotUsageMonitor.currency`, default `USD`, or **Copilot Usage: Choose Currency…**): show estimated cost in CAD, EUR, GBP and other currencies at the daily European Central Bank USD reference rate from frankfurter.dev, refreshed every 6 hours. Applies to the status bar, side bar, panel and tooltips. The request carries only the currency code; with USD no request is made. Monthly targets are read in the chosen currency. The privacy gates now allow exactly this one fetch, pinned to one file and one URL.

## 0.4.0 - 2026-11-06

### Added

- **Session totals.** Sessions from Copilot before 1.0.99, which have no per-call records, are now counted from the per-model total Copilot writes in the `session.shutdown` line when a session ends. Each one counts once, on the day it ended, and is marked "session total". Only the five token counts, the call count and the logged AIU per model are kept, plus the line's timestamp and the session start time; file paths and every other field are removed during parsing and never copied. Builds that logged `0` AIU next to real tokens show `—` for USD, not `$0.00`. A session that also has per-call records is never counted twice. New setting `copilotUsageMonitor.sessionTotals` (default on, machine scope); off skips those lines without decoding them.
- **Section navigation** in the details panel, still script-free: Overview, Daily, Sessions, Models, Projects, Tools, Insights and Data health in a left-hand menu (a wrapping row below 720 px). Month, unit and filter changes keep the current section. New command **Copilot Usage: Show Section…**.
- **Side bar** (activity-bar icon "Copilot Usage (Local)", view "Summary"): a compact, script-free web view with small grey group headings and label/value rows. Groups: This workspace (Today and Last 7 days for the project matching an open workspace folder; hidden when none matches), All projects (Today, Last 7 days, This month with a target marker), Top projects and Top models of the last 7 days (5 each), Insights ("N findings · Review", only when there are findings) and a data-health note only when data is partial or the log format changed. An **Open dashboard** button and a unit switch link. A project row filters the panel and opens Projects; other rows open the matching section. Title buttons: Open panel, Switch unit, Refresh. Loading, no-folder and unreadable-folder states show in the page. Redrawn only while visible, at most every 250 ms, and never with unchanged HTML.
- **Insights** section: sessions that grew costly (last 5 calls 3× or more the first 5, at least $0.50 est.) and models with low cache reuse. Computed from per-call records only; session totals are excluded and the section says so.
- **Overview** adds a Last 7 days tile with the change against the 7 days before (▲/▼, never a percentage). Not filtered. No arrow when either week has nothing logged, and no comparison when the 7 days before reach back past the first month read (`historyMonths`); the side bar follows the same rule.
- **Daily trend** under the Daily section: one bar per day of the viewed month (tokens or USD est.), a dashed average-per-active-day line, the peak day highlighted and today outlined. Days still to come show as empty slots. Follows the project or tool filter, like the calendar.
- Sessions table keeps up to 50 sessions of the viewed month (top 10 shown, the rest folded), with a "session total" tag on backfilled rows. Models table gains a Share column. Tools notes that session totals have no tool data. Data health adds "Sessions counted from session totals" and "Session-end lines too long to read".

### Changed

- The panel's command allowlist grows from three to four commands (adds `showSection`). The selected section is kept in memory only, never in settings.
- The panel skips redrawing when its HTML has not changed.
- Snapshots carry unfiltered per-project figures for today and the last 7 days (one extra pass over the records), for the side bar.
- `panelHtml.ts` is split into one file per section under `src/core/panel/`.

### Fixed

- The status bar in USD view showed the filtered month when a project or tool filter was set. It now always shows this month unfiltered, as documented.

### Security

- The side bar web view runs no scripts, loads no resources (`localResourceRoots: []`), uses the panel's content security policy and allows exactly four command links (`showDetails`, `showSection`, `setFilter`, `toggleUnit`). A gate test allows `registerWebviewViewProvider` only in `src/vscode/sidebar.ts`.
- Model and tool names `__proto__`, `constructor` and `prototype` are rejected, and every map keyed by log data has no prototype, so a crafted log line cannot touch `Object.prototype`.

### Accessibility

- Panel landmarks: one `<nav aria-label="Sections">` with `aria-current="page"`, one `<main>`, a skip link, headings h1 → h2 → h3 without gaps, visible focus outlines and high-contrast borders. Problem notes are not live regions, so redraws are not re-announced.
- Nav counters, the selected unit and chart bars carry screen-reader text or are hidden from it; bars in tables are decoration only. Forced-colours mode keeps bars visible.
- The status bar item and every side bar row have a spoken label in words; side bar groups are labelled sections with visible focus outlines and high-contrast borders.

## 0.3.2 - 2026-11-06

### Changed

- A project whose folder is named by an ID (a UUID or long hex) now shows the session title as its display label, read from the `name:` line of that session's `workspace.yaml` (at most 16 KB read, regular files only). Grouping and the project filter stay per folder: sessions in one ID folder stay one row (labelled with the most recently active session's title), and a title equal to another project's name never merges into it. Only with `projectNames` on; repository and normal folder names are unchanged.
- Titles drop YAML comments, `null` / `~` / empty values, and control, bidi and zero-width characters; truncation never splits a character. A deleted, oversize or symlinked `workspace.yaml` drops the title. All-digit folder names are not treated as IDs.

### Fixed

- Log lines over 1 MiB whose type shows they are not usage records (large tool output, long prompts) no longer mark totals as "Partial data". They are listed under Data health as "Over-long lines skipped (not usage)" and noted in the status bar tooltip. Only over-long lines that could be usage records (including ones with a usage record nested inside) still set the `*`.

## 0.3.1 - 2026-11-05

### Changed

- Project, tool and model tables show their top 10 rows and fold the rest under a script-free "Show N more"; an active filter row always stays visible.
- The added-tools line is summarised per server or plugin (for example `github-mcp-server (14 tools, 30 uses)`) instead of listing every tool.

## 0.3.0 - 2026-11-05

### Added

- **By project** table: usage per GitHub repository (else folder name) for the viewed month.
- **By tool** table: each tool the model invoked, marked built-in or added (MCP servers, plugins, extensions), with uses, calls, tokens and estimated USD of the calls that used it.
- Click a project or tool row, or run **Copilot Usage: Filter by Project or Tool…**, to filter the month view, trend, model, session and calendar views; chips with ✕ clear it. Today and the status bar stay unfiltered.
- `copilotUsageMonitor.projectNames` (default on) controls reading the project label.

### Changed

- The line gate now also decodes each log's small `session.start` line (≤ 16 KB) when `projectNames` is on, and keeps only the project label. `toolCounts` on usage records is now read.
- The panel's command allowlist adds `setFilter`.

## 0.2.0 - 2026-11-05

### Added

- Month picker: read up to 24 months of history (`historyMonths`, default 12) and view any month in the panel; Today and the current session stay live.
- Tokens / USD (est.) switch for the panel and status bar. USD = logged AIU × $0.01, which matches GitHub's published per-model token prices.
- Monthly trend chart; click a bar to open that month.
- Optional personal target range (`monthlyTargetMin` / `monthlyTargetMax`): the status-bar icon shows under / in / over for this month, amber when over.
- Costliest sessions table for the viewed month, with a ▲ flag when a session's later calls cost 3× or more than its first ones (growing context).
- Per-model table: estimated USD and USD per call.

### Changed

- The copy rule now allows estimated USD (always labelled "est."); account-statement wording (bill, quota, allowance, remaining, premium) stays banned outside the banner.
- The panel enables command links for exactly two commands (show month, set unit); it still runs no scripts.

## 0.1.0 - 2026-11-05

First release.

### Added

- Status-bar item with today's input + output tokens from Copilot's local session logs (`~/.copilot/session-state/*/events.jsonl`, or `COPILOT_HOME` / the `copilotUsageMonitor` setting).
- Details panel: today, current session, month-to-date heatmap and per-model breakdown, with AIU shown "as logged".
- Honest figures: `—` where the log had no value, `*` on any figure built from partial data, and a warning when the log format changes.
- Truncation- and rotation-safe tailing with a buffer-level line gate, multi-file dedupe by `usageId`, and PID-checked session liveness.
- Privacy gates enforced by tests: no network calls, nothing persisted, no telemetry, and the `.vsix` holds only `package.json`, `README.md`, `LICENSE` and the bundle.
- `npm run probe` / `npm run probe:chat`: shape-only summaries of the logs for bug reports.
