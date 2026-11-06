// The panel's command links (D20, D26, D30). The webview allows exactly
// PANEL_COMMANDS; every argument is JSON-encoded, then URI-encoded, and the
// receiving handler validates it (a section id is only compared to a closed list).
import type { SectionId } from "./sections";

/** Commands the panel may link to; the webview allows exactly these. */
export const PANEL_COMMANDS = [
  "copilotUsageMonitor.selectMonth",
  "copilotUsageMonitor.setUnit",
  "copilotUsageMonitor.setFilter",
  "copilotUsageMonitor.showSection",
] as const;

export type PanelCommand = (typeof PANEL_COMMANDS)[number];

export function commandHref(command: PanelCommand, ...args: string[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

/** A link that sets (or, with "", clears) one filter. */
export function filterHref(kind: "project" | "tool", value: string): string {
  return commandHref("copilotUsageMonitor.setFilter", kind, value);
}

/** A link that switches the panel to one section. */
export function sectionHref(id: SectionId): string {
  return commandHref("copilotUsageMonitor.showSection", id);
}
