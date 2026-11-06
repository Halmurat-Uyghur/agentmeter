# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 0.1.0 - 2026-11-05

First release.

### Added

- Status-bar item with today's input + output tokens from Copilot's local session logs (`~/.copilot/session-state/*/events.jsonl`, or `COPILOT_HOME` / the `copilotUsageMonitor` setting).
- Details panel: today, current session, month-to-date heatmap and per-model breakdown, with AIU shown "as logged".
- Honest figures: `—` where the log had no value, `*` on any figure built from partial data, and a warning when the log format changes.
- Truncation- and rotation-safe tailing with a buffer-level line gate, multi-file dedupe by `usageId`, and PID-checked session liveness.
- Privacy gates enforced by tests: no network calls, nothing persisted, no telemetry, and the `.vsix` holds only `package.json`, `README.md`, `LICENSE` and the bundle.
- `npm run probe` / `npm run probe:chat`: shape-only summaries of the logs for bug reports.
