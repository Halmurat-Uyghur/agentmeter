# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
