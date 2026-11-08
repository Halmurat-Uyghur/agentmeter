// The panel's command links (D20, D26, D30; showSession v0.6; selectPalette v0.8). The webview
// allows exactly PANEL_COMMANDS; every argument is JSON-encoded, then URI-encoded, and the
// receiving handler validates it (a section id is only compared to a closed list).
import type { SectionId } from "./sections";

/** Commands the panel may link to; the webview allows exactly these. */
export const PANEL_COMMANDS = [
  "copilotUsageMonitor.selectMonth",
  "copilotUsageMonitor.setUnit",
  "copilotUsageMonitor.setFilter",
  "copilotUsageMonitor.showSection",
  "copilotUsageMonitor.showSession",
  "copilotUsageMonitor.toggleNav",
  "copilotUsageMonitor.selectPalette",
] as const;

export type PanelCommand = (typeof PANEL_COMMANDS)[number];

export function commandHref(command: PanelCommand, ...args: string[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

/** A link that sets (or, with "", clears) one filter; a source value is a member of SOURCES (D40). */
export function filterHref(kind: "project" | "tool" | "source", value: string): string {
  return commandHref("copilotUsageMonitor.setFilter", kind, value);
}

/** A link that switches the panel to one section. */
export function sectionHref(id: SectionId): string {
  return commandHref("copilotUsageMonitor.showSection", id);
}

/** A link that lists one session's calls in the Sessions section ("" closes the list). The
 * id comes from a session row, which the extractor already limited to `^[0-9a-f-]{8,64}$`;
 * the handler checks that shape again. */
export function sessionCallsHref(sessionId: string): string {
  return commandHref("copilotUsageMonitor.showSession", sessionId);
}

/** A link that collapses or expands the section nav; the handler takes no argument. */
export function navToggleHref(): string {
  return commandHref("copilotUsageMonitor.toggleNav");
}

/** A link that opens the colour palette picker (no argument: the handler shows a quick pick). */
export function paletteHref(): string {
  return commandHref("copilotUsageMonitor.selectPalette");
}
