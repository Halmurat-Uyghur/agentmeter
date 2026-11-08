# Copilot Usage Monitor (Local)

A free, open-source VS Code extension that shows **your own GitHub Copilot usage, in tokens or estimated USD, as observed in Copilot's session logs on this computer**. It puts a status-bar item, a side bar summary and a details panel in VS Code. It reads no credentials, stores nothing and has no runtime dependencies. It makes no network calls, unless you choose a display currency other than USD (see [Currency](#currency)).

Not affiliated with, endorsed by or supported by GitHub or Microsoft.

## What it shows

- **Status bar:** `Local today: 1.5M tok`. That is input plus output tokens for today, from local midnight. In USD view it shows this month's estimate instead, for example `Local Nov: $12.40 / $20.00–$60.00`. The month figure is never filtered. Set `copilotUsageMonitor.statusBar` to `month` or `session` to show this month or the current session instead, in either unit; the icon always shows this month's target state. The tooltip keeps every figure, says when a figure includes session totals, and gives the current session's last prompt (its own call plus the agent calls it triggered). Click it to open the panel.
- **Side bar** (the graph icon in the activity bar, "Copilot Usage (Local)" → **Summary**): a compact summary in small groups, label on the left and figure on the right, in the Tokens / USD (est.) unit. Nothing in it is filtered except the Insights count, which follows the panel's filter.
  - **This workspace · *folder***: Today and Last 7 days for the project that matches an open workspace folder (by folder name, or the repository part of `owner/repo`). Hidden when nothing matches.
  - **All projects**: Today, Last 7 days and This month, with a small marker for your target state (under, in range or over).
  - **Top projects, last 7 days** (5) and **Top models, last 7 days** (5). Click a project to filter the panel to it and open Projects (click again to clear); click a model to open Models.
  - **Insights**: "N findings · Review" when the panel's month has any. A data-health note appears only when data is partial or the log format changed. A small "Copilot Chat in VS Code not counted" line, always there, opens Data health.
  - **Open dashboard** opens the details panel; the link under it switches the unit. The **Currency: USD** footer link (it shows the chosen code) opens the currency picker, also in the side bar's `…` menu as **Choose Currency…**. Hover a row for its calls, session totals and other details. Title buttons: Open panel, Switch unit, Refresh.
  - While loading, or when no logs are found or the folder cannot be read, the view says so and names the `copilotUsageMonitor.copilotHome` setting.
- **Details panel** ("Copilot Usage (Local)"): a left-hand section menu (a wrapping row of links when the panel is narrow), with the month picker, the Tokens / USD (est.) switch and any filter chips at the top of every section. Pick a section by clicking it, from a side bar row, or with **Copilot Usage: Show Section…**. Month, unit and filter changes keep the section you are on.
  - **Overview:** opens with the **Today** hero figure (with yesterday, the 7-day average and the change against yesterday) beside a daily-activity heatmap (one square per day, the last 20 weeks) and a cache ring (the viewed month's cache-read share of input). Then tiles for the current session, the last 7 days (with the change against the 7 days before, as ▲ or ▼; no arrow when either week has nothing logged, and no comparison when the 7 days before reach back past the first month read) and the viewed month (with your target range, if set, and the change against the same point last month as an amount, for example `▲ $2.70 Nov 1–6 vs Oct 1–6 ($6.40)`; a past month compares with the whole month before). Then the **last 30 days** as bars (a dashed average line, today highlighted), and the **monthly trend**: one bar per month; click a bar to open that month.
  - **Daily:** today in detail (input, output, cache read, cache write, reasoning, model time, AIU (as logged), USD (est.) and calls), the **daily trend** (one bar per day of the viewed month, a dashed line at the average per active day and the peak day highlighted) and a month calendar of daily tokens or USD. Session totals count on the day the session ended.
  - **Sessions:** the current session, then the viewed month's sessions, largest first: the top 10, with the rest folded under "Show N more". A ▲ marks sessions whose last 5 calls cost 3× or more than their first 5, which means the context kept growing and a fresh session would likely be cheaper. Rows counted from a session total carry a "session total" tag. Click a session to list its calls at the top of the section: time, model, who started it (you or the agent), uncached input, cache read, cache write, output, reasoning, the share of input taken by tool definitions, AIU, USD (est.) and how the call ended (an answer or tool calls). The newest 200 calls of a session are kept; older ones are counted but not listed. A **Prompts and agent calls** card says how many agent calls your prompts triggered in the viewed month and what a prompt cost on average (a prompt plus the agent calls after it, up to your next prompt).
  - **Models:** the viewed month's per-model table, with each model's share, estimated USD and USD per call (from per-call records only). **Cache by model** shows the cache-read share of input, and the exact estimated cost of the uncached input next to what the same tokens would cost at the cache-read price, from the per-token-type AI credits Copilot logs with each call (`—` where none were logged).
  - **Change vs last month:** the Projects, Models and Tools tables add a **Δ vs Oct 1–6** column: this month so far minus the same point last month (a past month: minus the whole month before), in the active unit and currency, under the same filters as the table. It is ▲ or ▼ with the amount, never a percentage; "new" when nothing was logged then, and no arrow when either side has nothing logged. With `historyMonths` at 1 (or the month before outside the window) there is no column, and the table says why.
  - **Projects:** usage per GitHub repository, else folder name. Click a row to filter the month view, trend and tables to that project; click the chip's ✕ to clear.
  - **Tools:** each tool the model used, built-in or added by MCP servers, plugins and extensions (added tools summarised per server or plugin). Click a row to filter by that tool. Session totals have no tool data, so a tool filter leaves them out. **Tool definitions in the prompt** shows how much of the input the tool descriptions took, overall and for the calls that used each server or plugin. It is a share of input, already in every total, not an extra cost.
  - **Insights:** calls past a model's long-context price threshold, sessions that grew costly and models with low cache reuse in the viewed month. Built from per-call records only; session totals are left out.
  - **Data health:** what was read, what was skipped (including sessions counted from session totals) and what is not counted. It always opens with "Not covered: Copilot Chat in VS Code (only Copilot CLI logs are read), so figures are a lower bound for Chat users."
  - **Month picker:** step back through up to 24 months of history (12 by default) with ‹ ›, or pick one from a list. Today and the current session stay live while you look at an old month.
  - **Personal target range** (optional): say how much you mean to use per month, for example $20–$60. The status bar icon shows whether this month is under (↓), in (✓) or over (🔥, amber) the range. It never stops Copilot, and it never pops up unless you opt in: with `copilotUsageMonitor.targetAlert` on (off by default), one notification says when this month's estimated cost first goes above your target max, at most once per calendar month per VS Code window, with **Open dashboard** and **Don't show again** (which turns the setting off). Nothing is stored to remember it; a new window may say it again. It needs a target max, and with a non-USD currency it waits for the exchange rate.
  - Today, the current session, the last 7 days and the status bar are never filtered. Long tables show their top 10 rows and fold the rest; an active filter row always stays visible.
- **Getting started** walkthrough (**Help → Welcome**, or **Welcome: Open Walkthrough…** → "Get started with Copilot Usage Monitor (Local)"): check that your Copilot logs are found (opens the `copilotHome` setting), pick tokens or estimated cost and a currency, set a monthly target range, and open the side bar and the panel. Its pages are four short Markdown files shipped in the `.vsix`; they hold no links or images.
- **Updates** within about half a second of Copilot finishing a model call. Copilot writes one usage record per completed model call, so figures move in steps, not token by token.

How to read the numbers:

- `—` means the log did not report a value. It is never shown as `0`.
- `*` means a figure may be incomplete, for example because a log could not be read or some records lacked the field. Hover the figure for the reason.
- **session total** marks a session from Copilot before 1.0.99. Those builds write no per-call records, only one total per model when the session ends, so the whole session counts once, on the day it ended. It has no per-call, growth or tool figures. Older Copilot also logged no AI credits there, so its USD shows `—`, never `$0.00`; its tokens and calls still count.
- "AIU (as logged)" is the raw `totalNanoAiu / 1e9` value Copilot writes into its own log.
- "USD (est.)" is that AIU × $0.01. GitHub prices Copilot per token, converts the price to AI credits and charges $0.01 per credit. Checked against GitHub's published per-model price table, the logged AIU matched to four decimal places. It is still an estimate: it covers only calls logged on this computer and it is not an invoice.

## What this is not

> Locally observed from Copilot, Claude Code and Codex session logs on this computer. Not an account statement from any of them, not your remaining allowance, and not usage from other devices or features that don't write these logs.

- **Not official.** These are local observations of an undocumented log format, not an account statement from GitHub. If you need the official figures, check your GitHub account settings.
- **Partial coverage.** Only Copilot clients that write `~/.copilot/session-state/*/events.jsonl` are counted: the Copilot CLI and the coding agent, including agent sessions started from VS Code. These are not counted:
  - inline completions
  - Copilot Chat in VS Code and other Chat surfaces that don't write these logs, so if you use Chat the figures are a lower bound
  - github.com, mobile, JetBrains
  - other computers
- **Older Copilot is counted coarsely.** Before 1.0.99, Copilot writes one total per session when it ends. Those sessions count on their end day, show nothing while still open (or if they crashed) and have no estimated USD. Turn `sessionTotals` off to leave them out.
- **Local day.** "Today" starts at local midnight on this computer, while GitHub's own day may follow UTC.
- **Format changes.** If Copilot changes its log format, the status bar shows a warning icon and the panel says "Format changed". It does not quietly show smaller numbers.

## Install

The extension is not on the Marketplace yet. Build a `.vsix` and install it:

```bash
npm ci
npm run build
npm run package
code --install-extension copilot-usage-monitor-0.7.0.vsix
```

Alternatively, in VS Code use **Extensions → … → Install from VSIX…**.

## Settings and commands

| Setting | Default | Meaning |
|---|---|---|
| `copilotUsageMonitor.copilotHome` | `""` | Folder that contains Copilot's `session-state`. Empty means `COPILOT_HOME`, else `~/.copilot`. Machine-scoped, so a repository's workspace settings cannot redirect it. |
| `copilotUsageMonitor.historyMonths` | `12` | Months of logs to read, this month included (1–24). |
| `copilotUsageMonitor.display` | `"tokens"` | `"tokens"` or `"cost"` (estimated USD). The panel switch and the command change it, writing the setting at the scope where it is set (user, workspace or folder). |
| `copilotUsageMonitor.statusBar` | `"today"` | What the status bar text shows: `"today"` (today's tokens, or this month against your target in the cost view, as before 0.6), `"month"` (this month so far) or `"session"` (the current session). The tooltip keeps every figure. |
| `copilotUsageMonitor.currency` | `"USD"` | Currency for estimated cost, for example `"CAD"`. See [Currency](#currency). Application-scoped: user settings only, so a workspace cannot turn on the network request. |
| `copilotUsageMonitor.monthlyTargetMin` | none | Optional: the least estimated cost you mean to use per month, in the chosen currency. |
| `copilotUsageMonitor.monthlyTargetMax` | none | Optional: the most estimated cost you mean to use per month, in the chosen currency. |
| `copilotUsageMonitor.targetAlert` | `false` | Opt-in: one notification when this month's estimated cost first goes above `monthlyTargetMax`, at most once per calendar month per window, remembered in memory only. "Don't show again" sets it back to `false`. Application-scoped: user settings only, so a workspace cannot turn it on. |
| `copilotUsageMonitor.projectNames` | `true` | Label sessions with a project (GitHub repository, else folder name; a folder named by an ID shows the session title instead). Off: every call is "(no project)" and neither the start line nor `workspace.yaml` is read. Machine-scoped. |
| `copilotUsageMonitor.sessionTotals` | `true` | Count sessions from Copilot before 1.0.99 from the per-model total written when a session ends ("session total"). Off: `session.shutdown` lines are skipped without being decoded, as in 0.3. Machine-scoped. |

VS Code launched from the macOS Dock or Finder does not see variables set in `.zshrc`. If you set `COPILOT_HOME` there, also set `copilotUsageMonitor.copilotHome`.

Commands:

- **Copilot Usage: Show Local Details** opens the panel.
- **Copilot Usage: Pin Session…** chooses which session counts as "current"; pick *Automatic* to undo.
- **Copilot Usage: Refresh** rescans the logs.
- **Copilot Usage: Show Month…** picks the month the panel shows.
- **Copilot Usage: Switch Tokens / USD (est.)** flips the unit. It writes `display` at the scope where it is set (user, workspace or folder), so it never adds a workspace setting.
- **Copilot Usage: Choose Currency…** picks the display currency.
- **Copilot Usage: Filter by Project or Tool…** picks a filter (or clears all).
- **Copilot Usage: Show Section…** opens the panel at a section (Overview, Daily, Sessions, Models, Projects, Tools, Insights or Data health).

## Currency

Estimated cost is always worked out in USD, from Copilot's logged AI credits. Set `copilotUsageMonitor.currency` (or run **Copilot Usage: Choose Currency…**) to show it in another currency, for example `CAD` shows `CA$17.36` instead of `$12.34`.

- **Rate:** the European Central Bank daily USD reference rate, fetched from `https://api.frankfurter.dev` (free, no key, open source) when VS Code starts, when you change the currency, and every 6 hours after that. The rate and its date are shown under the cost note in the panel and in the status bar tooltip.
- **What is sent:** one HTTPS GET with only the currency code, for example `?base=USD&symbols=CAD`. No usage figures, paths, project names or identifiers. With the default `USD` no request is ever made.
- **Targets:** `monthlyTargetMin` / `monthlyTargetMax` are read in the chosen currency.
- **Offline:** until a rate arrives, cost stays in USD with a note, and targets are not compared. A failed fetch is retried every 15 minutes.

## What it reads

- **Files opened:** only `<copilot folder>/session-state/<session id>/events.jsonl` for sessions written within the history window (`historyMonths`, 12 months by default). Everything else in the folder is only listed. Lock-file names are used to tell live sessions apart. The one other file ever opened is that session's `workspace.yaml`, and only when `projectNames` is on and the project folder name is an ID (a UUID or long hex): at most 16 KB is read (a larger file is ignored), and only its `name:` line is kept. Nothing else is opened.
- **Line filtering:** each line is checked by its first bytes. Only `session.usage_record` lines are decoded and parsed, plus, when `projectNames` is on, each log's single `session.start` line (under 16 KB; larger ones are skipped), and, when `sessionTotals` is on, `session.shutdown` lines (up to 64 KB; a longer one is not decoded and is listed under Data health). Prompts, replies, tool output and file contents are skipped without being decoded.
- **Session totals:** from a `session.shutdown` line, per model, only the five token counts (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`), `requests.count` and `totalNanoAiu` are kept, plus the line's timestamp and `sessionStartTime`. The line (at most 64 KB) is decoded whole; the keys `filesModified`, `accountingSnapshot`, `agentMetrics`, `providerModelMetrics`, `usageAccountingWatermarks` and `currentModel` are removed during parsing and never copied, and nothing else on the line (such as `requests.cost`, `totalApiDurationMs` or `codeChanges`) is ever copied. When a session, or its session folder, also has per-call records, its session total is hidden, so nothing is counted twice; a later shutdown line replaces an earlier one instead of adding to it.
- **Project label:** from `session.start` only `context.repository` (if it looks like `owner/repo`) or the last folder name of `context.gitRoot` / `context.cwd` is kept. The full path, branch, commits and everything else on that line are dropped. When that folder name is an ID (a UUID or long hex), the session title is shown instead: only the `name:` line of that session's `workspace.yaml` (under 16 KB), capped at 60 characters, with control, bidi and zero-width characters removed. The title is a display label only: sessions are still grouped and filtered by that folder, so two sessions in one folder stay one row (labelled with the most recently active session's title) and a title can never merge into another project's row. Copilot writes a short title there; for a session you never renamed it can be the start of your first prompt.
- **Tool use:** the per-call `toolCounts` map (tool name → number of invocations). Tool arguments and output are never read.
- **Per-call detail (since 0.6):** `initiator` and `finishReason` are mapped to a few fixed values (`user` / `agent` / `other`; `stop` / `tool_calls` / `length` / `content_filter` / `other`), so the log's text is never kept. `toolTokenCount` and `availableToolCount` are numbers. From `copilotUsage.tokenDetails[]` only each entry's token type, token count, batch size and cost per batch are read, to split the call's AI credits by token type; the split is kept only when it adds up to the logged total, and the entry's model name is not read.
- **Fields kept:** model id, token counts, model time, AIU as logged and its split by token type, tool names with counts, tool-definition tokens and tools offered, who started the call and how it ended (fixed values), usage id, sequence, session id, timestamp, the project label and, for session totals, the call count and session start time, in memory only. Nothing is written to disk and no usage data is sent anywhere.
- **Output channel:** the "Copilot Usage Monitor" output channel gets counts, error codes and timings only, never log content or paths.
- **Panel:** the details panel runs no scripts and loads no remote resources. Its only links are VS Code command links, and the panel allows exactly five commands: show a month, show a section, set the unit, set a filter, and list a session's calls. The selected section and session are kept in memory only.
- **Side bar:** a web view with the same rules as the panel: no scripts, no local or remote resources, the same content security policy, and only five command links (open the panel, show a section, set the project filter, switch the unit, choose the currency). It shows figures the extension already holds and opens no other file; every name from the logs is escaped. Open workspace folder names are used only to pick the "This workspace" project and are never stored.
- **No credentials, no network:** unlike tools that read your sign-in tokens, this extension never reads credentials. It works only from the log files above. Its one network request is the optional exchange rate described under [Currency](#currency); with the default USD it never uses the network.
- **Settings:** the unit switch saves `copilotUsageMonitor.display` (at the scope where it is set; user settings when it is set nowhere) and **Choose Currency…** saves `copilotUsageMonitor.currency` in your VS Code user settings; the target alert's **Don't show again** sets `copilotUsageMonitor.targetAlert` to `false`. Those are the only things the extension ever writes.
- **Notifications:** none, unless you turn on `copilotUsageMonitor.targetAlert`; then at most one per calendar month per window, as described under the target range. Which month was already announced is kept in memory only.

Automated tests enforce these rules. They scan the source and the bundle for network, persistence and telemetry APIs, allowing exactly one `fetch`, in `src/vscode/exchangeRate.ts`, pinned to the exchange-rate URL. They allow a notification only in the target alert's file and a settings write only for those three keys. They also check the exact files inside the `.vsix` (the bundle, `package.json`, `README.md`, `LICENSE` and the walkthrough's four Markdown files), and that a canary string in synthetic logs never reaches the UI or the output channel.

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
