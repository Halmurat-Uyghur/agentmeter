# Settings section, daily and weekly targets, and the refused-save fix

Date: 2026-11-08. Owner request: "looks like color change is not working" and "add settings on side navigation, and all kind of setting should go there: change currency and color, daily limit settings or weekly". Decided by the lead without a panel; the owner asked for decisions, not questions.

## What was wrong with the colour change (root cause)

The 0.8.0 build the owner runs is byte-identical to `main`. Its output log (`Copilot Usage Monitor` channel, saved by VS Code under `logs/…/exthost/output_logging_*`) shows `error palette.write WRITE_FAILED` three times in the window opened at 18:36. `selectPalette` drew the picked palette, then asked VS Code to save `copilotUsageMonitor.palette`; VS Code refused, and the handler's rollback redrew the saved palette ("theme") within the same tick, so the pick looked like it did nothing. `settings.json` never gained the key.

The same code, in the same VS Code (1.145.2) with a clean user-data folder, saves the setting (the integration suite's palette test passes against the installed VS Code). The owner's `settings.json` parses and holds only ordinary keys. So the refusal was specific to the live window: VS Code rejects extension writes while `settings.json` is open with unsaved changes, or while its on-disk content is newer than the editor's model (two windows were open; `files.autoSave` is `afterDelay`). The reason itself is lost because the handler logged a fixed code.

Decisions (D1–D3):

- **D1.** A refused save never undoes the user's choice. The palette, the unit, the nav state and the status bar figure apply in this window at once and stay; the save is retried once after 1.5 s; the Settings section lists the keys whose last save was refused with one plain sentence. Nothing pops up (the notification gate stays: one opt-in alert).
- **D2.** The log keeps a fixed code, now derived from VS Code's own error text: `FILE_DIRTY`, `FILE_MODIFIED`, `UNKNOWN_KEY`, `INVALID_FILE`, `POLICY`, `INVALID_TARGET`, else `WRITE_FAILED`. No message text, path or value is logged.
- **D3.** Every settings write goes through one helper, `updateSetting(key, value, target, where)`, so the gates can check the allowlisted keys and the retry in one place.

## Settings section (panel)

- **D4.** A ninth section, `settings` ("Settings", gear icon), last in the nav under its own group label "Setup". Reached from the nav, the side bar footer ("Settings" link), the side bar's `…` menu and the Command Palette ("Copilot Usage: Settings"). The Colours… button leaves the toolbar: colours are a setting. The Tokens / USD switch stays in the toolbar because it is a view control used constantly; it is also listed in Settings.
- **D5.** The webview still runs no scripts and no forms, so every control is a command link: a value is changed through a quick pick or an input box in the extension host, then saved to settings and drawn. Links are JSON-encoded arguments to commands in `PANEL_COMMANDS`, validated by the handler like every other panel link.
- **D6.** Three cards. *Display*: unit, currency (with the rate date or "rate pending"), colours, status bar figure, section navigation (labels or icon rail). *Targets*: daily target (most), weekly target (most), monthly target (least and most), the target alert on/off; amounts are estimated cost in the chosen currency, Copilot only. *Sources and history*: Copilot's folder origin (setting / variable / default, never a path), Claude Code and Codex on/off and found/not found, history months, project names, session totals: read-only here, with one link that opens VS Code's Settings editor filtered to the extension, because those settings are machine-scoped and a path or boolean is better edited there.
- **D7.** New commands: `showSettings` (opens the section), `setStatusBar` (today | month | session, or a quick pick), `setTarget` (period day | week | month, bound min | max, an optional value: "" clears, a number saves, none asks with an input box; no arguments offers a quick pick of the four targets), `setTargetAlert` (on | off, or toggles), `openVsCodeSettings`. `selectCurrency` joins the panel allowlist. The allowlist grows from seven to twelve commands.
- **D8.** Write targets: application-scoped settings (currency, palette, panelNavCollapsed, targetAlert) are written to user settings; the others (display, statusBar, the four targets) at the scope that already holds a value, else user settings, as the unit switch does today. Turning the alert **on** from Settings is a deliberate click, so the extension now writes `targetAlert` in both directions; "Don't show again" in the alert itself stays as it was.
- **D9.** The panel receives a `Prefs` object (chosen currency, palette, nav state, status bar figure, the raw target amounts as entered, alert on/off, history months, project names, session totals, source switches, refused keys) from the extension, included in the redraw key so a change draws at once. The Settings section is the only reader. Palette and nav state remain separate parameters (already there).

## Daily and weekly targets (the owner's "daily limit settings or weekly")

The project's copy rule bans the words limit, quota and allowance in every user-facing string (the figures are local observations, not an account allowance), so these are "targets" like the monthly one.

- **D10.** Two settings, `copilotUsageMonitor.dailyTargetMax` and `copilotUsageMonitor.weeklyTargetMax` (number or null, ≥ 0, in the chosen currency, like `monthlyTargetMax`): the most estimated cost you mean to use today and over the last 7 days. A daily or weekly target is a ceiling only (a "most"); the monthly target keeps its optional floor.
- **D11.** Shown where those periods already are: the Overview's Today card and Last 7 days card (a "Daily target up to CA$5.00: Over" / "In range" line and the same over/in colouring the month card uses), the side bar's Today and Last 7 days rows (the same "over" / "in range" marker the month row has, spoken "over daily target"), the status bar tooltip (one line per set target) and the Settings section. The status bar text and icon keep showing the month, and the opt-in alert stays monthly: a daily target crossed on many days would be noise.
- **D12.** Held in `ViewOptions.dayTarget` and `ViewOptions.weekTarget` as USD like `range`, converted at the daily rate; while a non-USD rate is pending the targets are not compared, as the month target is not.

## Non-goals

Editing paths, booleans or history months inside the panel (VS Code's Settings editor does that well and keeps machine scope visible); an in-memory currency override when the save is refused (the currency drives a network fetch and the rate; the Settings page says the save failed instead); a per-day or per-week alert; workspace-level palette or nav state.

## Tests and gates

The gates test keeps an exact list of written keys and of the panel's allowed commands; both grow. New unit tests cover the refused-save path (palette kept, code logged, retry), each new command (argument validation, write target, input box and quick pick flows), the Settings section's markup and allowlist, the daily and weekly target states in the Overview and the side bar, and the view parsing of the new settings in a display currency. The integration suite gains a Settings section test.
