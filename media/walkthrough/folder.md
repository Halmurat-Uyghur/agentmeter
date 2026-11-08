# Where the figures come from

The extension reads the session logs that these tools write on this computer:

- **Copilot CLI and coding agent:** `~/.copilot/session-state/*/events.jsonl`. It uses the folder in `copilotUsageMonitor.copilotHome`, else `COPILOT_HOME`, else `~/.copilot`.
- **Claude Code:** the `projects` folder. It uses the folder in `copilotUsageMonitor.claudeHome`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`. Turn off with `copilotUsageMonitor.claudeCode`.
- **Codex CLI:** the `sessions` folder. It uses the folder in `copilotUsageMonitor.codexHome`, else `CODEX_HOME`, else `~/.codex`. Turn off with `copilotUsageMonitor.codex`.

From Claude Code and Codex logs only token counts, model ids, timestamps, session ids and folder names are kept; prompts, replies, thinking and tool inputs are never decoded. A folder that is absent is not opened.

- **Found:** the status bar shows a figure such as `Local today: 1.5M tok`.
- **Not found:** the status bar reads `Local: no usage logs found`, and the side bar names the folder setting of each enabled source.

Copilot Chat in VS Code is not counted (only Copilot CLI logs are read), so if you use Chat the figures are a lower bound.

Nothing is sent or stored. Only local files are read.
