# Where the figures come from

The extension reads the session logs that the Copilot CLI and coding agent write on this computer:

`~/.copilot/session-state/*/events.jsonl`

It uses the folder in `copilotUsageMonitor.copilotHome`, else `COPILOT_HOME`, else `~/.copilot`.

- **Found:** the status bar shows a figure such as `Local today: 1.5M tok`.
- **Not found:** the status bar says `Copilot logs not found`, and the side bar names the setting.

Copilot Chat in VS Code is not counted (only Copilot CLI logs are read), so if you use Chat the figures are a lower bound.

Nothing is sent or stored. Only local files are read.
