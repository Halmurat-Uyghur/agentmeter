// The panel's sections, in nav order (D30, regrouped by A2; labels and descriptions
// from O3). Ids are a closed list: a showSection argument is only ever compared to them.
import type { IconName } from "./icons";

export const SECTIONS = ["overview", "sessions", "daily", "models", "projects", "tools", "insights", "health", "settings"] as const;
export type SectionId = (typeof SECTIONS)[number];
export const DEFAULT_SECTION: SectionId = "overview";

export function isSectionId(x: unknown): x is SectionId {
  return typeof x === "string" && (SECTIONS as readonly string[]).includes(x);
}

export interface SectionDef {
  id: SectionId;
  /** nav label and the section's h2 */
  label: string;
  /** nav group label (A2); Overview has none and sits on top; Settings closes the list (v0.9) */
  group?: "Usage" | "Insight" | "Health" | "Setup";
  icon: IconName;
  /** one line under the h2; `month` is "November" or "October 2026" */
  describe(month: string, isCurrent: boolean): string;
}

export const SECTION_DEFS: readonly SectionDef[] = [
  { id: "overview", label: "Overview", icon: "overview", describe: (m) => `Today, the current session and ${m} at a glance.` },
  { id: "sessions", label: "Sessions", group: "Usage", icon: "sessions", describe: (m) => `The current session and ${m}'s sessions, largest first.` },
  {
    id: "daily",
    label: "Daily",
    group: "Usage",
    icon: "daily",
    describe: (m, cur) => (cur ? `Each day of ${m}: today in detail, daily bars and the calendar.` : `Each day of ${m}: daily bars and the calendar.`),
  },
  { id: "models", label: "Models", group: "Usage", icon: "models", describe: (m) => `Usage by model in ${m}.` },
  { id: "projects", label: "Projects", group: "Usage", icon: "projects", describe: (m) => `Usage by repository or folder in ${m}. Click a row to filter.` },
  { id: "tools", label: "Tools", group: "Usage", icon: "tools", describe: (m) => `Built-in and added tools used by model calls in ${m}. Click a row to filter.` },
  { id: "insights", label: "Insights", group: "Insight", icon: "insights", describe: (m) => `Patterns in ${m}'s sessions that may be worth a look.` },
  { id: "health", label: "Data health", group: "Health", icon: "health", describe: () => "What was read, what was skipped and what is not counted." },
  { id: "settings", label: "Settings", group: "Setup", icon: "settings", describe: () => "Unit, currency, colours, status bar, targets and where logs are read from. Saved in your VS Code settings." },
];

export function sectionDef(id: SectionId): SectionDef {
  return SECTION_DEFS.find((d) => d.id === id)!;
}

/** Items for the "Show Section…" quick pick; text comes from SECTION_DEFS only. */
export function sectionPickItems(current?: SectionId): { label: string; description: string; id: SectionId }[] {
  return SECTION_DEFS.map((d) => ({
    label: d.label,
    description: d.describe("the month", true) + (d.id === current ? " (shown now)" : ""),
    id: d.id,
  }));
}
