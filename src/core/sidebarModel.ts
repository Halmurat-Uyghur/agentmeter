// The side bar summary (A1, replacing the D31 TreeView): a pure model of the
// no-script webview's groups and rows, built from a Snapshot, the view options and
// the open workspace folder names only (no vscode import, no file access). Same
// value rules as the panel and the status bar: "—" means not reported (never 0),
// "*" means incomplete, and figures that include session totals say so in their
// title tooltip. Every string is plain text; renderSidebarHtml escapes it.
import {
  type TargetStatus,
  targetStatus,
  CHAT_NOT_COVERED,
  CHAT_NOT_COVERED_SHORT,
  costLabel,
  costNotes,
  currencyCode,
  DEFAULT_VIEW,
  formatChangedSentence,
  formatCount,
  formatRange,
  enabledSourceNames,
  formatUsd,
  foundSources,
  homeSettings,
  PERMISSION_NOTE,
  mixedSources,
  multiSource,
  PRIOR_SHORT_NOTE,
  rangeLabel,
  rangeWord,
  readingLine,
  RANGE_LABEL,
  folderListNote,
  unreadableParts,
  SESSION_TOTAL_SHORT,
  spoken,
  statusParts,
  thisMonthTotals,
  usd,
  WEEK_SHORT_NOTE,
  weekChange,
  weekCoverage,
} from "./format";
import { CALLS_MISSING_NOTE, callsCell, callsPhrase, DASH, headlineValue, MONTHS, partialReasons, plural, tokens, withStar } from "./panel/shared";
import type { SectionId } from "./panel/sections";
import { type Counts, type GroupSummary, type Health, type Metric, type RangeState, type Snapshot, SOURCE_LABEL, type Totals, type ViewOptions } from "./types";

export type SidebarState = "loading" | "no-dir" | "permission" | "ready";

/** Rows per top-N group. */
export const TOP_N = 5;

/** Commands the side bar may link to; the webview allows exactly these (F4 V4). */
export const SIDEBAR_COMMANDS = [
  "copilotUsageMonitor.showDetails",
  "copilotUsageMonitor.showSection",
  "copilotUsageMonitor.setFilter",
  "copilotUsageMonitor.toggleUnit",
  "copilotUsageMonitor.selectCurrency",
] as const;
export type SidebarCommand = (typeof SIDEBAR_COMMANDS)[number];

export interface SidebarLink {
  command: SidebarCommand;
  /** a section id, or ("project", key or "", "projects") / ("source", id or "", "overview"); none for showDetails, toggleUnit and selectCurrency */
  args: string[];
}

/** First sentence of LOCAL_BANNER: every title tooltip opens with it. */
export const SIDEBAR_BANNER = "Locally observed from Copilot, Claude Code and Codex session logs on this computer.";

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
  id: "workspace" | "all" | "sources" | "projects" | "models";
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
  /** set only when there is something to say (an active panel filter, the first read in progress) */
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
  /** the currency picker link in the footer: "Currency: CAD" (the chosen code, even while its rate is pending) */
  currencySwitch: { text: string; title: string; link: SidebarLink };
  /** the footer link to the panel's Settings section (v0.9) */
  settingsLink: { text: string; title: string; link: SidebarLink };
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
  loading: ["Reading session logs on this computer…"],
  "no-dir": [
    "No Copilot session logs were found on this computer.",
    "Only Copilot clients that write session-state/*/events.jsonl are counted (the Copilot CLI and coding agent). If Copilot keeps its folder elsewhere, set copilotUsageMonitor.copilotHome in Settings, then use Refresh in this view's title bar.",
  ],
  // Replaced by permissionNotice(health) whenever a snapshot is at hand.
  permission: [PERMISSION_NOTE, "Check the folder's permissions, then use Refresh in this view's title bar."],
};

/** The permission notice (D49): names the enabled sources' folder settings (all three without per-source health). */
function permissionNotice(h: Health): string[] {
  return [PERMISSION_NOTE, `Check the folder's permissions, or set ${homeSettings(h, true)} in Settings, then use Refresh in this view's title bar.`];
}

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
  if (view.unit === "cost") out.push(...costNotes(view, mixedSources(c?.sources)));
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
  if (view.unit === "cost") out.push(...costNotes(view, mixedSources(g?.sources)));
  return out;
}

/** The no-dir notice when other sources are enabled: it names every enabled source's setting (D49). */
function noDirNotice(h: Health): string[] {
  return [
    "No usage logs were found on this computer.",
    `${enabledSourceNames(h)} logs are read when present. If a tool keeps its folder elsewhere, set ${homeSettings(h)} in Settings, then use Refresh in this view's title bar.`,
  ];
}

/** A target marker's short text; "*" when the spend is a lower bound (review finding #3). */
function markerText(st: TargetStatus): string {
  return rangeWord(st).toLowerCase();
}

function row(o: Omit<SidebarRow, "spoken" | "title"> & { title: string[]; said?: string }, cost: boolean): SidebarRow {
  const { said: name, ...rest } = o;
  const mark = o.marker && (o.marker.kind === "filtered" ? "filtered" : o.marker.text.endsWith("*") ? spoken(RANGE_LABEL[o.marker.kind] + "*") : RANGE_LABEL[o.marker.kind]);
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
  const u = unreadableParts(h);
  if (u.folders > 0) return folderListNote(u.folders);
  if (u.logs > 0) return `${plural(u.logs, "log")} could not be read`;
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
    title.push(`${plural(h.unrecognized, "line")} in a format this version doesn't recognize. ${formatChangedSentence(h)}, so figures may be incomplete.`);
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
  const chosen = view.currency?.code ?? view.currencyPending ?? "USD";
  const currencySwitch = {
    text: `Currency: ${chosen}`,
    title: view.currencyPending ? `No ${chosen} exchange rate yet; figures stay in USD until it arrives. Click to choose another currency.` : "Choose the display currency: USD, or another such as CAD at the daily exchange rate.",
    link: { command: "copilotUsageMonitor.selectCurrency" as const, args: [] },
  };
  const settingsLink = {
    text: "Settings",
    title: "Opens the panel's Settings section: unit, currency, colours, status bar and targets.",
    link: section("settings"),
  };
  const footNote = view.unit === "cost" ? `Local logs only · ${currencyCode()} figures are est.` : "Local logs only";
  const state: SidebarState = !s ? "loading" : s.health.state === "no-dir" ? "no-dir" : s.health.state === "permission" ? "permission" : "ready";
  if (!s || state !== "ready") {
    const notice =
      s && state === "no-dir" && multiSource(s.health) ? noDirNotice(s.health) : s && state === "permission" ? permissionNotice(s.health) : NOTICES[state as Exclude<SidebarState, "ready">];
    return finish({ state, unitWord, notice, groups: [], unitSwitch, currencySwitch, settingsLink, footNote });
  }

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
  const marker = status.state === "none" ? undefined : { kind: status.state, text: markerText(status) };
  // In tokens view the target (a USD range) is named by its state only, like the status bar.
  const target =
    status.state === "none"
      ? []
      : view.unit === "cost"
        ? [`Target ${formatRange(view.range)}${mixedSources(month?.sources) ? " (Copilot only)" : ""}: ${rangeLabel(status)}.`]
        : [`Estimated ${currencyCode()} this month${status.state === "unknown" ? ":" : " is"} ${rangeLabel(status)}.`];
  // The daily and weekly targets (v0.9) mark Today and Last 7 days the way the month target marks This month.
  const periodTarget = (c: Totals | undefined, range: ViewOptions["range"], what: string, period: string) => {
    const ts = targetStatus(c, range, s.health);
    const st = ts.state;
    if (st === "none") return { marker: undefined, lines: [] as string[] };
    const marker = { kind: st, text: markerText(ts) };
    const lines = view.unit === "cost" ? [`${what} ${formatRange(range)}${mixedSources(c?.sources) ? " (Copilot only)" : ""}: ${rangeLabel(ts)}.`] : [`Estimated ${currencyCode()} ${period}${st === "unknown" ? ":" : " is"} ${rangeLabel(ts)}.`];
    return { marker, lines };
  };
  const dayT = periodTarget(today, view.dayTarget, "Daily target", "today");
  const weekT = periodTarget(last7, view.weekTarget, "Weekly target", "over the last 7 days");
  groups.push({
    id: "all",
    heading: "All projects",
    title: [SIDEBAR_BANNER, "Every project, never filtered."].join("\n"),
    rows: [
      r({
        id: "today",
        label: "Today",
        value: countsFigure(today, view, partial),
        ...(dayT.marker && { marker: dayT.marker }),
        title: ["Since local midnight on this computer.", ...dayT.lines, ...detailLines(today, view, h), "Opens Daily."],
        link: section("daily"),
      }),
      r({
        id: "week",
        label: "Last 7 days",
        value: countsFigure(last7, view, partial || short),
        ...(weekT.marker && { marker: weekT.marker }),
        title: [
          "Today and the 6 days before it.",
          ...weekT.lines,
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
  // By source, last 7 days (D49): one row per enabled source whose folder exists, shown only
  // when a source other than Copilot is enabled and found. Each row filters the panel.
  const found = foundSources(h);
  if (found.some((x) => x !== "copilot")) {
    const activeSource = s.filter?.source;
    groups.push({
      id: "sources",
      heading: "By source, last 7 days",
      title: [SIDEBAR_BANNER, "Each tool whose logs were found, today and the 6 days before it, never filtered. Click one to filter the panel to it."].join("\n"),
      rows: found.map((x, i) => {
        const c = last7?.bySource?.[x];
        const on = x === activeSource;
        return r({
          id: `sources/${i}`,
          label: SOURCE_LABEL[x],
          value: countsFigure(c, view, partial || short),
          ...(on && { marker: { kind: "filtered" as const, text: "filtered" } }),
          title: [
            `Source: ${SOURCE_LABEL[x]}.`,
            ...(short ? [WEEK_SHORT_NOTE] : []),
            ...detailLines(c, view, h),
            on ? "The panel is filtered to this source. Click to clear the filter." : "Click to filter the panel to this source and open Overview.",
          ],
          link: { command: "copilotUsageMonitor.setFilter", args: ["source", on ? "" : x, "overview"] },
        });
      }),
    });
  }

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

  // Insights of the month the panel shows, under the panel's filter (the monitor computes
  // them for the panel's Insights section); unlike the rows above, so the copy says so.
  const n = s.month?.insights?.items.length ?? 0;
  const filtered = s.filter?.project !== undefined || s.filter?.tool !== undefined || s.filter?.source !== undefined ? " for the panel's filter" : "";
  const insights =
    n > 0
      ? {
          text: plural(n, "finding"),
          title: [SIDEBAR_BANNER, `${plural(n, "pattern")} in the sessions of the month the panel shows${filtered}. Opens Insights.`].join("\n"),
          spoken: `${plural(n, "finding")}${filtered}. Review in Insights`,
          link: section("insights"),
        }
      : undefined;
  const health = healthNote(h);
  const message = [readingLine(h), s.filter ? "The panel is filtered; these figures are not." : undefined].filter(Boolean).join(" ") || undefined;
  const coverage = { text: CHAT_NOT_COVERED_SHORT, title: [SIDEBAR_BANNER, CHAT_NOT_COVERED, "Opens Data health."].join("\n"), link: section("health") };
  return finish({ state, unitWord, notice: [], groups, ...(insights && { insights }), ...(health && { health }), coverage, ...(message && { message }), unitSwitch, currencySwitch, settingsLink, footNote });
}

function finish(m: Omit<SidebarModel, "signature">): SidebarModel {
  return { ...m, signature: JSON.stringify(m) };
}
