// The panel's command links (D20, D26, D30; showSession v0.6; selectPalette v0.8; the Settings
// section's commands v0.9). The webview allows exactly PANEL_COMMANDS; every argument is
// JSON-encoded, then URI-encoded, and the receiving handler validates it (a section id is only
// compared to a closed list).
import type { SectionId } from "./sections";
import type { StatusBarContent } from "../types";

/** Commands the panel may link to; the webview allows exactly these. */
export const PANEL_COMMANDS = [
  "copilotUsageMonitor.selectMonth",
  "copilotUsageMonitor.setUnit",
  "copilotUsageMonitor.setFilter",
  "copilotUsageMonitor.showSection",
  "copilotUsageMonitor.showSession",
  "copilotUsageMonitor.toggleNav",
  "copilotUsageMonitor.selectPalette",
  "copilotUsageMonitor.selectCurrency",
  "copilotUsageMonitor.setStatusBar",
  "copilotUsageMonitor.setTarget",
  "copilotUsageMonitor.setTargetAlert",
  "copilotUsageMonitor.openVsCodeSettings",
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

/** A link that opens the currency picker (the handler takes no argument). */
export function currencyHref(): string {
  return commandHref("copilotUsageMonitor.selectCurrency");
}

/** A link that sets what the status bar shows, or with no value opens a quick pick. */
export function statusBarHref(value?: StatusBarContent): string {
  return value === undefined ? commandHref("copilotUsageMonitor.setStatusBar") : commandHref("copilotUsageMonitor.setStatusBar", value);
}

export type TargetPeriod = "day" | "week" | "month";
export type TargetBound = "min" | "max";

/** A link that sets one target bound: no value asks with an input box, "" clears it. The
 * handler validates the period and the bound against their closed lists and the value as a
 * non-negative number. */
export function targetHref(period: TargetPeriod, bound: TargetBound, value?: string): string {
  return value === undefined ? commandHref("copilotUsageMonitor.setTarget", period, bound) : commandHref("copilotUsageMonitor.setTarget", period, bound, value);
}

/** A link that turns the opt-in target alert on or off. */
export function targetAlertHref(on: boolean): string {
  return commandHref("copilotUsageMonitor.setTargetAlert", on ? "on" : "off");
}

/** A link that opens VS Code's Settings editor filtered to this extension (the handler takes no argument). */
export function vsCodeSettingsHref(): string {
  return commandHref("copilotUsageMonitor.openVsCodeSettings");
}
