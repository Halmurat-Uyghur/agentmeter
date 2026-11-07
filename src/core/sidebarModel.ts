// The side bar summary (A1, replacing the D31 TreeView): a pure model of the
// no-script webview's groups and rows, built from a Snapshot, the view options and
// the open workspace folder names only (no vscode import, no file access). Same
// value rules as the panel and the status bar: "—" means not reported (never 0),
// "*" means incomplete, and figures that include session totals say so in their
// title tooltip. Every string is plain text; renderSidebarHtml escapes it.
import {
  CHAT_NOT_COVERED,
  CHAT_NOT_COVERED_SHORT,
  costLabel,
  costNotes,
  currencyCode,
  DEFAULT_VIEW,
  formatCount,
  formatRange,
  formatUsd,
  PRIOR_SHORT_NOTE,
  RANGE_LABEL,
  SESSION_TOTAL_SHORT,
  spoken,
  statusParts,
  thisMonthTotals,
  WEEK_SHORT_NOTE,
  weekChange,
  weekCoverage,
} from "./format";
import { CALLS_MISSING_NOTE, callsCell, callsPhrase, DASH, headlineValue, MONTHS, partialReasons, plural, tokens, withStar } from "./panel/shared";
import type { SectionId } from "./panel/sections";
import type { Counts, GroupSummary, Health, Metric, RangeState, Snapshot, ViewOptions } from "./types";

export type SidebarState = "loading" | "no-dir" | "permission" | "ready";

/** Rows per top-N group. */
export const TOP_N = 5;

/** Commands the side bar may link to; the webview allows exactly these (F4 V4). */
export const SIDEBAR_COMMANDS = [
  "copilotUsageMonitor.showDetails",
  "copilotUsageMonitor.showSection",
  "copilotUsageMonitor.setFilter",
  "copilotUsageMonitor.toggleUnit",
] as const;
export type SidebarCommand = (typeof SIDEBAR_COMMANDS)[number];

export interface SidebarLink {
  command: SidebarCommand;
  /** a section id, or ("project", key or "", "projects"); none for showDetails and toggleUnit */
  args: string[];
}

/** First sentence of LOCAL_BANNER: every title tooltip opens with it. */
export const SIDEBAR_BANNER = "Locally observed from Copilot session logs on this computer.";

export type MarkerKind = Exclude<RangeState, "none"> | "filtered";

export interface SidebarRow {
  /** fixed or positional ("projects/0"); never log-derived */
  id: string;
  /** plain text */
  label: string;
  /** the figure: "1.5M tok", "$3.10* est.", "—" */
  value: string;
  /** a small chip after the value: the target state or "filtered" */
  marker?: { kind: MarkerKind; text: string };
  /** title tooltip, plain text, lines separated by "\n" */
  title: string;
  /** aria-label */
  spoken: string;
  link?: SidebarLink;
}

export interface SidebarGroup {
  id: "workspace" | "all" | "projects" | "models";
  /** plain text; the workspace heading carries the folder name */
  heading: string;
  title: string;
  rows: SidebarRow[];
  /** shown instead of rows when there are none */
  empty?: string;
}

export interface SidebarModel {
  state: SidebarState;
  /** WebviewView.description: the unit the figures use */
  unitWord: string;
  /** paragraphs shown instead of the groups when state is not "ready" */
  notice: string[];
  /** set only when there is something to say (an active panel filter) */
  message?: string;
  /** [] unless state is "ready" */
  groups: SidebarGroup[];
  /** "N findings · Review"; only when N > 0 */
  insights?: { text: string; title: string; spoken: string; link: SidebarLink };
  /** only when the data is partial or the log format changed */
  health?: { text: string; title: string; link: SidebarLink };
  /** the Copilot Chat coverage line (2.6); every ready state */
  coverage?: { text: string; title: string; link: SidebarLink };
  /** the unit switch link under the button */
  unitSwitch: { text: string; link: SidebarLink };
  /** footer words before the unit switch: "Local logs only", plus "USD is estimated" in USD view */
  footNote: string;
  /** equal models have equal signatures; the adapter skips a redraw when unchanged */
  signature: string;
}

/** Every row of every group, in page order. */
export function sidebarRows(m: SidebarModel): SidebarRow[] {
  return m.groups.flatMap((g) => g.rows);
}

const NOTICES: Record<Exclude<SidebarState, "ready">, string[]> = {
  loading: ["Reading Copilot session logs on this computer…"],
  "no-dir": [
    "No Copilot session logs were found on this computer.",
    "Only Copilot clients that write session-state/*/events.jsonl are counted (the Copilot CLI and coding agent). If Copilot keeps its folder elsewhere, set copilotUsageMonitor.copilotHome in Settings, then use Refresh in this view's title bar.",
  ],
  permission: [
    "The Copilot session log folder could not be read on this computer.",
    "Check the folder's permissions, or set copilotUsageMonitor.copilotHome in Settings, then use Refresh in this view's title bar.",
  ],
};

function section(id: SectionId): SidebarLink {
  return { command: "copilotUsageMonitor.showSection", args: [id] };
}

/** "1.5M* tok" / "$3.10*" / "—" for a metric pair in the chosen unit. USD figures carry no
 * " est." each: the footer says it once and the spoken label says "estimated" (design #6). */
function figure(tok: Metric | undefined, nano: Metric | undefined, view: ViewOptions, partial: boolean): string {
  if (view.unit === "cost") {
    const t = nano ? formatUsd(nano) : DASH;
    return t === DASH ? DASH : withStar(t, partial);
  }
  const t = tok ? formatCount(tok) : DASH;
  return t === DASH ? DASH : `${withStar(t, partial)} tok`;
}

function countsFigure(c: Counts | undefined, view: ViewOptions, partial: boolean): string {
  return figure(c ? tokens(c) : undefined, c?.nanoAiu, view, partial);
}

/** Title lines shared by every aggregated row. */
function detailLines(c: Counts | undefined, view: ViewOptions, h: Health): string[] {
  const out: string[] = [];
  if (c) {
    if (view.unit === "cost") out.push(`Estimated ${currencyCode()}: ${formatUsd(c.nanoAiu)}`);
    out.push(`Input: ${formatCount(c.input)} tok`, `Output: ${formatCount(c.output)} tok`, `Calls: ${callsCell(c.calls, c.callsMissing)}`);
    if (c.callsMissing > 0) out.push(CALLS_MISSING_NOTE);
    if (c.sessionTotals > 0) out.push(`Includes ${plural(c.sessionTotals, "session total")}. ${SESSION_TOTAL_SHORT}`);
  } else {
    out.push("Nothing logged.");
  }
  if (h.partial) out.push(partialReasons(h));
  if (view.unit === "cost") out.push(...costNotes(view));
  return out;
}

/** Title lines for one project's figures. */
function groupLines(g: GroupSummary | undefined, view: ViewOptions, h: Health): string[] {
  const out: string[] = [];
  if (g) {
    if (view.unit === "cost") out.push(`Estimated ${currencyCode()}: ${formatUsd(g.nanoAiu)}`);
    out.push(`Tokens: ${formatCount(g.tokens)}`, `${callsPhrase(g.calls, g.callsMissing)} in ${plural(g.sessions, "session")}.`);
    if ((g.callsMissing ?? 0) > 0) out.push(CALLS_MISSING_NOTE);
    if ((g.sessionTotals ?? 0) > 0) out.push(`Includes ${plural(g.sessionTotals!, "session total")}. ${SESSION_TOTAL_SHORT}`);
  } else {
    out.push("Nothing logged.");
  }
  if (h.partial) out.push(partialReasons(h));
  if (view.unit === "cost") out.push(...costNotes(view));
  return out;
}

function row(o: Omit<SidebarRow, "spoken" | "title"> & { title: string[]; said?: string }, cost: boolean): SidebarRow {
  const { said: name, ...rest } = o;
  const mark = o.marker && (o.marker.kind === "filtered" ? "filtered" : RANGE_LABEL[o.marker.kind]);
  const value = cost && o.value !== DASH ? `${o.value} est.` : o.value;
  const said = [`${name ?? o.label}: ${spoken(value)}`, mark].filter(Boolean).join(", ");
  return { ...rest, title: [SIDEBAR_BANNER, ...o.title].join("\n"), spoken: said };
}

/** "owner/repo" → "repo" when no other listed project ends in the same repo name (design #6). */
export function shortProjectLabels(names: readonly string[]): Map<string, string> {
  const repo = (n: string) => (n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n);
  const count = new Map<string, number>();
  for (const n of names) count.set(repo(n).toLowerCase(), (count.get(repo(n).toLowerCase()) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const n of names) out.set(n, n.includes("/") && count.get(repo(n).toLowerCase()) === 1 && repo(n) !== "" ? repo(n) : n);
  return out;
}

/** Rows sorted by the unit's headline figure, highest first, then by name; unknown last. */
function byHeadline<T>(rows: T[], value: (r: T) => number | undefined, name: (r: T) => string): T[] {
  return [...rows].sort((a, b) => (value(b) ?? -1) - (value(a) ?? -1) || name(a).localeCompare(name(b)));
}

function groupValue(g: GroupSummary, view: ViewOptions): number | undefined {
  const m = view.unit === "cost" ? g.nanoAiu : g.tokens;
  return m.reported === 0 ? undefined : m.sum;
}

/** The project a workspace folder name stands for: the project key equals the folder name,
 * or is "owner/repo" with that repo part (case-insensitive). */
export function matchesFolder(project: string, folder: string): boolean {
  const f = folder.toLowerCase();
  const p = project.toLowerCase();
  if (f.length === 0) return false;
  return p === f || (p.includes("/") && p.slice(p.lastIndexOf("/") + 1) === f);
}

/** A project-filter link that toggles: it clears the filter when that project is active. */
function filterLink(name: string, active: boolean): SidebarLink {
  return { command: "copilotUsageMonitor.setFilter", args: ["project", active ? "" : name, "projects"] };
}

function firstReason(h: Health): string {
  if (h.unreadableFiles > 0) return `${plural(h.unreadableFiles, "log")} could not be read`;
  if (h.malformed > 0) return `${plural(h.malformed, "malformed line")} skipped`;
  if (h.overlong > 0) return `${plural(h.overlong, "over-long line")} skipped`;
  return `${plural(h.shutdownOversize, "session-end line")} skipped`;
}

function healthNote(h: Health): SidebarModel["health"] {
  let text: string;
  if (h.state === "format-changed") text = `Format changed · ${plural(h.unrecognized, "line")} unknown`;
  else if (h.partial) text = `Partial data · ${firstReason(h)}`;
  else return undefined;
  const title: string[] = [SIDEBAR_BANNER];
  if (h.state === "format-changed")
    title.push(`${plural(h.unrecognized, "line")} in a format this version doesn't recognize. Copilot may have changed its log format, so figures may be incomplete.`);
  if (h.partial) title.push(partialReasons(h));
  title.push("Opens Data health.");
  return { text, title: title.join("\n"), link: section("health") };
}

/**
 * @param folders basenames of the open workspace folders, in order; the first that matches
 *   a project with a record this month names the "This workspace" group.
 */
export function buildSidebarModel(s: Snapshot | undefined, view: ViewOptions = DEFAULT_VIEW, folders: readonly string[] = []): SidebarModel {
  const unitWord = view.unit === "cost" ? costLabel() : "tokens";
  const unitSwitch = { text: view.unit === "cost" ? "Show tokens" : `Show ${costLabel()}`, link: { command: "copilotUsageMonitor.toggleUnit" as const, args: [] } };
  const footNote = view.unit === "cost" ? `Local logs only · ${currencyCode()} figures are est.` : "Local logs only";
  const state: SidebarState = !s ? "loading" : s.health.state === "no-dir" ? "no-dir" : s.health.state === "permission" ? "permission" : "ready";
  if (!s || state !== "ready") return finish({ state, unitWord, notice: NOTICES[state as Exclude<SidebarState, "ready">], groups: [], unitSwitch, footNote });

  const h = s.health;
  const partial = h.partial;
  const cost = view.unit === "cost";
  const r = (o: Parameters<typeof row>[0]) => row(o, cost);
  const monthName = MONTHS[new Date(s.dayStartMs).getMonth()]!;
  const active = s.filter?.project;
  const groups: SidebarGroup[] = [];
  const todayProjects = s.todayProjects ?? [];
  const last7Projects = s.last7Projects ?? [];
  const { last7Short: short, prior7Short } = weekCoverage(s);

  // This workspace: the project matching an open folder, today and over the last 7 days.
  const known = [...last7Projects, ...todayProjects, ...(s.thisMonthProjects ?? [])];
  let ws: { folder: string; name: string; label?: string } | undefined;
  for (const folder of folders) {
    const g = known.find((p) => matchesFolder(p.name, folder));
    if (g) {
      ws = { folder, name: g.name, ...(g.label !== undefined && { label: g.label }) };
      break;
    }
  }
  if (ws) {
    const w = ws;
    const on = w.name === active;
    const t = todayProjects.find((g) => g.name === w.name);
    const wk = last7Projects.find((g) => g.name === w.name);
    const click = on ? "Click to clear the panel's project filter." : "Click to filter the panel to this project.";
    groups.push({
      id: "workspace",
      heading: `This workspace · ${w.folder}`,
      title: [SIDEBAR_BANNER, `Project ${w.name}, matched to the open folder ${w.folder}. Not filtered.`].join("\n"),
      rows: [
        r({ id: "workspace/today", label: "Today", value: figure(t?.tokens, t?.nanoAiu, view, partial), title: [`Project ${w.name}, since local midnight.`, ...groupLines(t, view, h), click], link: filterLink(w.name, on) }),
        r({
          id: "workspace/week",
          label: "Last 7 days",
          value: figure(wk?.tokens, wk?.nanoAiu, view, partial || short),
          title: [`Project ${w.name}, today and the 6 days before it.`, ...(short ? [WEEK_SHORT_NOTE] : []), ...groupLines(wk, view, h), click],
          link: filterLink(w.name, on),
        }),
      ],
    });
  }

  // All projects: Today (in tokens exactly the status bar's figure), Last 7 days, This month.
  const today = s.today;
  const last7 = s.last7;
  const change = weekChange(headlineValue(last7, view), headlineValue(s.prior7, view), !prior7Short);
  const month = thisMonthTotals(s);
  const status = statusParts(s, view);
  const marker = status.state === "none" ? undefined : { kind: status.state, text: status.state === "over" ? "over" : status.state === "in" ? "in range" : "under" };
  // In tokens view the target (a USD range) is named by its state only, like the status bar.
  const target =
    status.state === "none"
      ? []
      : view.unit === "cost"
        ? [`Target ${formatRange(view.range)}: ${RANGE_LABEL[status.state]}.`]
        : [`Estimated ${currencyCode()} this month is ${RANGE_LABEL[status.state]}.`];
  groups.push({
    id: "all",
    heading: "All projects",
    title: [SIDEBAR_BANNER, "Every project, never filtered."].join("\n"),
    rows: [
      r({ id: "today", label: "Today", value: countsFigure(today, view, partial), title: ["Since local midnight on this computer.", ...detailLines(today, view, h), "Opens Daily."], link: section("daily") }),
      r({
        id: "week",
        label: "Last 7 days",
        value: countsFigure(last7, view, partial || short),
        title: [
          "Today and the 6 days before it.",
          ...(change && !prior7Short ? [change.charAt(0).toUpperCase() + change.slice(1) + "."] : []),
          ...(short ? [WEEK_SHORT_NOTE] : prior7Short ? [PRIOR_SHORT_NOTE] : []),
          ...detailLines(last7, view, h),
          "Opens Overview.",
        ],
        link: section("overview"),
      }),
      r({
        id: "month",
        label: "This month",
        value: countsFigure(month, view, partial),
        ...(marker && { marker }),
        title: [`${monthName}, from the 1st. Never filtered.`, ...target, ...detailLines(month, view, h), "Opens Overview."],
        link: section("overview"),
      }),
    ],
  });
  // Top projects of the last 7 days, never filtered; the active filter's project stays listed.
  const all = byHeadline(last7Projects, (g) => groupValue(g, view), (g) => g.name);
  const top = all.slice(0, TOP_N);
  const kept = active === undefined ? undefined : all.slice(TOP_N).find((g) => g.name === active);
  if (kept) top.push(kept);
  const shortNames = shortProjectLabels(last7Projects.map((g) => g.name));
  groups.push({
    id: "projects",
    heading: "Top projects, last 7 days",
    title: [SIDEBAR_BANNER, "Repositories or folders with the most usage in the last 7 days, never filtered. Click one to filter the panel to it."].join("\n"),
    rows: top.map((g, i) => {
      const on = g.name === active;
      const full = g.label ?? g.name;
      return r({
        id: `projects/${i}`,
        label: g.label ?? shortNames.get(g.name) ?? g.name,
        said: full,
        value: figure(g.tokens, g.nanoAiu, view, partial || short),
        ...(on && { marker: { kind: "filtered" as const, text: "filtered" } }),
        title: [
          g.label !== undefined ? `Project: ${g.name} (shown by its session title).` : `Project: ${g.name}.`,
          ...groupLines(g, view, h),
          on ? "The panel is filtered to this project. Click to clear the filter." : "Click to filter the panel to this project.",
        ],
        link: filterLink(g.name, on),
      });
    }),
    empty: "Nothing logged in the last 7 days.",
  });

  // Top models of the last 7 days, never filtered.
  const models = byHeadline(Object.entries(last7?.byModel ?? {}), ([, c]) => headlineValue(c, view), ([k]) => k).slice(0, TOP_N);
  groups.push({
    id: "models",
    heading: "Top models, last 7 days",
    title: [SIDEBAR_BANNER, "Models with the most usage in the last 7 days, never filtered."].join("\n"),
    rows: models.map(([name, c], i) =>
      r({ id: `models/${i}`, label: name, value: countsFigure(c, view, partial || short), title: [`Model: ${name}.`, ...detailLines(c, view, h), "Opens Models."], link: section("models") }),
    ),
    empty: "Nothing logged in the last 7 days.",
  });

  // Insights of the month the panel shows.
  const n = s.month?.insights?.items.length ?? 0;
  const insights =
    n > 0
      ? {
          text: plural(n, "finding"),
          title: [SIDEBAR_BANNER, `${plural(n, "pattern")} in the sessions of the month the panel shows. Opens Insights.`].join("\n"),
          spoken: `${plural(n, "finding")}. Review in Insights`,
          link: section("insights"),
        }
      : undefined;
  const health = healthNote(h);
  const message = s.filter ? "The panel is filtered; these figures are not." : undefined;
  const coverage = { text: CHAT_NOT_COVERED_SHORT, title: [SIDEBAR_BANNER, CHAT_NOT_COVERED, "Opens Data health."].join("\n"), link: section("health") };
  return finish({ state, unitWord, notice: [], groups, ...(insights && { insights }), ...(health && { health }), coverage, ...(message && { message }), unitSwitch, footNote });
}

function finish(m: Omit<SidebarModel, "signature">): SidebarModel {
  return { ...m, signature: JSON.stringify(m) };
}
