# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- Log lines over 1 MiB whose type shows they are not usage records (large tool output, long prompts) no longer mark totals as "Partial data". They are listed under Data health as "Over-long lines skipped (not usage)". Only over-long lines that could be usage records still set the `*`.

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
