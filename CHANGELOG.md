# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
