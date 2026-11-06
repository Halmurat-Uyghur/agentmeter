# Copilot Usage Monitor (Local)

A free, open-source VS Code extension that shows **your own GitHub Copilot usage, in tokens or estimated USD, as observed in Copilot's session logs on this computer**. It puts a status-bar item and a details panel in VS Code. It makes no network calls, stores nothing and has no runtime dependencies.

Not affiliated with, endorsed by or supported by GitHub or Microsoft.

## What it shows

- **Status bar:** `Local today: 1.5M tok`. That is input plus output tokens for today, from local midnight. In USD view it shows this month's estimate instead, for example `Local Nov: $12.40 / $20.00–$60.00`. Click it to open the panel.
- **Details panel** ("Copilot Usage (Local)"):
  - Today, the current Copilot session and the viewed month.
  - **Month picker:** step back through up to 24 months of history (12 by default) with ‹ ›, or pick one from a list. Today and the current session stay live while you look at an old month.
  - **Tokens / USD (est.) switch** for every figure.
  - **Monthly trend:** one bar per month. Click a bar to open that month.
  - **Personal target range** (optional): say how much you mean to use per month, for example $20–$60. The status bar icon shows whether this month is under (↓), in (✓) or over (🔥, amber) the range. It never stops Copilot and never pops up.
  - **Costliest sessions:** the month's top 10 sessions by estimated USD. A ▲ marks sessions whose last 5 calls cost 3× or more than their first 5, which means the context kept growing and a fresh session would likely be cheaper.
  - Per-metric tiles: input, output, cache read, cache write, reasoning, model time, AIU (as logged), USD (est.) and calls.
  - A per-model table with estimated USD per call, and a month calendar of daily tokens or USD.
  - A data-health section.
- **Updates** within about half a second of Copilot finishing a model call. Copilot writes one usage record per completed model call, so figures move in steps, not token by token.

How to read the numbers:

- `—` means the log did not report a value. It is never shown as `0`.
- `*` means a figure may be incomplete, for example because a log could not be read or some records lacked the field. Hover the figure for the reason.
- "AIU (as logged)" is the raw `totalNanoAiu / 1e9` value Copilot writes into its own log.
- "USD (est.)" is that AIU × $0.01. GitHub prices Copilot per token, converts the price to AI credits and charges $0.01 per credit. Checked against GitHub's published per-model price table, the logged AIU matched to four decimal places. It is still an estimate: it covers only calls logged on this computer and it is not an invoice.

## What this is not

> Locally observed from Copilot session logs on this computer. Not your GitHub bill, not your remaining allowance, and not usage from other devices or Copilot features that don't write these logs.

- **Not official.** These are local observations of an undocumented log format, not an account statement from GitHub. If you need the official figures, check your GitHub account settings.
- **Partial coverage.** Only Copilot clients that write `~/.copilot/session-state/*/events.jsonl` are counted: the Copilot CLI and the coding agent, including agent sessions started from VS Code. These are not counted:
  - inline completions
  - Copilot Chat surfaces that don't write these logs
  - github.com, mobile, JetBrains
  - other computers
- **Copilot 1.0.99 or newer.** Older Copilot versions write no per-call records. Their sessions are listed as "sessions without per-call data" and add nothing to the totals, so the status bar may show `—` every day until Copilot updates.
- **Local day.** "Today" starts at local midnight on this computer, while GitHub's own day may follow UTC.
- **Format changes.** If Copilot changes its log format, the status bar shows a warning icon and the panel says "Format changed". It does not quietly show smaller numbers.

## Install

The extension is not on the Marketplace yet. Build a `.vsix` and install it:

```bash
npm ci
npm run build
npm run package
code --install-extension copilot-usage-monitor-0.2.0.vsix
```

Alternatively, in VS Code use **Extensions → … → Install from VSIX…**.

## Settings and commands

| Setting | Default | Meaning |
|---|---|---|
| `copilotUsageMonitor.copilotHome` | `""` | Folder that contains Copilot's `session-state`. Empty means `COPILOT_HOME`, else `~/.copilot`. Machine-scoped, so a repository's workspace settings cannot redirect it. |
| `copilotUsageMonitor.historyMonths` | `12` | Months of logs to read, this month included (1–24). |
| `copilotUsageMonitor.display` | `"tokens"` | `"tokens"` or `"cost"` (estimated USD). The panel switch and the command change it. |
| `copilotUsageMonitor.monthlyTargetMin` | none | Optional: the least estimated USD you mean to use per month. |
| `copilotUsageMonitor.monthlyTargetMax` | none | Optional: the most estimated USD you mean to use per month. |

VS Code launched from the macOS Dock or Finder does not see variables set in `.zshrc`. If you set `COPILOT_HOME` there, also set `copilotUsageMonitor.copilotHome`.

Commands:

- **Copilot Usage: Show Local Details** opens the panel.
- **Copilot Usage: Pin Session…** chooses which session counts as "current"; pick *Automatic* to undo.
- **Copilot Usage: Refresh** rescans the logs.
- **Copilot Usage: Show Month…** picks the month the panel shows.
- **Copilot Usage: Switch Tokens / USD (est.)** flips the unit.

## What it reads

- **Files opened:** only `<copilot folder>/session-state/<session id>/events.jsonl` for sessions written within the history window (`historyMonths`, 12 months by default). Everything else in the folder is only listed. Lock-file names are used to tell live sessions apart, and nothing else is opened.
- **Line filtering:** each line is checked by its first bytes. Only `session.usage_record` lines are decoded and parsed. Prompts, replies, tool output and file paths are skipped without being decoded.
- **Fields kept:** model id, token counts, model time, AIU as logged, usage id, sequence, session id and timestamp, in memory only. Nothing is written to disk and nothing is sent anywhere.
- **Output channel:** the "Copilot Usage Monitor" output channel gets counts, error codes and timings only, never log content or paths.
- **Panel:** the details panel runs no scripts and loads no remote resources. Its only links are VS Code command links, and the panel allows exactly two commands: show a month, and set the unit.
- **Settings:** the unit switch saves `copilotUsageMonitor.display` in your VS Code user settings. That is the only thing the extension ever writes.

Automated tests enforce these rules. They scan the source and the bundle for network, persistence and telemetry APIs. They also check the exact files inside the `.vsix`, and that a canary string in synthetic logs never reaches the UI or the output channel.

## Development

```bash
npm ci
npm test                    # unit tests (Vitest)
npm run typecheck
npm run test:integration    # extension-host tests (downloads VS Code 1.90 for testing only)
NODE_OPTIONS=--expose-gc npm run test:perf
npm run package
```

`npm run probe` prints a shape-only summary of your Copilot logs: key paths, types and counts, never values. Use it to check `docs/SCHEMA.md` against a new Copilot version before relying on the numbers. `npm run probe:chat` does the same for VS Code Copilot Chat's own logs. Those logs are not read by the extension yet; see `docs/plans` §13.

When reporting a problem, include the probe output if it helps. It contains no prompts, code or paths.

## Acknowledgements

The dashboard layout was inspired by the *Copilot Usage Dashboard* VS Code extension by pvjagtap (MIT). No code or styles were copied.

## License

[MIT](LICENSE) © 2026 Halmurat Tahir
