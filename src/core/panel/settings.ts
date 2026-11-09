// The Settings section (v0.9): every setting the extension reads, with its current value and
// a command link that changes it through a quick pick or an input box in the extension host
// (the webview runs no scripts and no forms). Display and target settings are changed here;
// the machine-scoped source settings are listed and sent to VS Code's Settings editor. Nothing
// here reads settings or the disk: the extension passes `Prefs`, and no path is ever shown.
import { costLabel, formatRange } from "../format";
import { palette, type PaletteId } from "../palettes";
import { type Prefs, type Snapshot, type Source, SOURCE_LABEL, type SourceState, type StatusBarContent, type ViewOptions } from "../types";
import { commandHref, currencyHref, navToggleHref, paletteHref, statusBarHref, targetAlertHref, targetHref, type TargetBound, type TargetPeriod, vsCodeSettingsHref } from "./links";
import { card, escapeHtml, plural } from "./shared";

export interface SettingsContext {
  navCollapsed: boolean;
  palette: PaletteId;
  prefs: Prefs;
}

/** What the status bar can show; the quick pick and the Settings row read one list. */
export const STATUS_BAR_OPTIONS: readonly { value: StatusBarContent; label: string; description: string }[] = [
  { value: "today", label: "Today", description: "Today's tokens; in the cost view, this month against your target." },
  { value: "month", label: "This month", description: "This month so far, in tokens or estimated cost." },
  { value: "session", label: "Current session", description: "The current session, in tokens or estimated cost." },
];

export type TargetKey = "dayMax" | "weekMax" | "monthMin" | "monthMax";

/** The four target bounds: the Settings rows and the Set Target… quick pick read one list. */
export const TARGET_DEFS: readonly { period: TargetPeriod; bound: TargetBound; key: TargetKey; setting: string; label: string; description: string }[] = [
  { period: "day", bound: "max", key: "dayMax", setting: "dailyTargetMax", label: "Daily target (most)", description: "The most estimated cost you mean to use in a day. Today is marked in range or over." },
  { period: "week", bound: "max", key: "weekMax", setting: "weeklyTargetMax", label: "Weekly target (most)", description: "The most over the last 7 days: today and the 6 days before it." },
  { period: "month", bound: "min", key: "monthMin", setting: "monthlyTargetMin", label: "Monthly target (least)", description: "The least you mean to use this month. Below it the status bar shows a down arrow." },
  { period: "month", bound: "max", key: "monthMax", setting: "monthlyTargetMax", label: "Monthly target (most)", description: "The most this month. Above it the status bar turns amber." },
];

/** Names for the keys a refused save can leave unsaved (the extension passes the keys). */
const SETTING_NAMES: Record<string, string> = {
  display: "Unit",
  currency: "Currency",
  palette: "Colours",
  statusBar: "Status bar",
  panelNavCollapsed: "Section navigation",
  targetAlert: "Target alert",
  dailyTargetMax: "Daily target",
  weeklyTargetMax: "Weekly target",
  monthlyTargetMin: "Monthly target (least)",
  monthlyTargetMax: "Monthly target (most)",
};

const STATE_WORD: Record<SourceState, string> = {
  ok: "found",
  "no-data": "found, no usage yet",
  "no-dir": "folder not found",
  permission: "folder unreadable",
  off: "off",
  "format-changed": "format may have changed",
};

/** An amount as entered, in the chosen currency, no conversion: "$5.00", "CA$20.00". */
export function enteredAmount(n: number, code: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${code}`;
  }
}

const btn = (label: string, href: string, title: string) => `<a class="btn" href="${escapeHtml(href)}" title="${escapeHtml(title)}">${escapeHtml(label)}</a>`;

/** One setting: its name (with a line of help), its value (HTML, escaped by the caller) and its actions. */
function row(name: string, value: string, actions: string, note?: string, valueNote?: string): string {
  return `<div class="srow"><div class="sk">${escapeHtml(name)}${note ? `<small>${escapeHtml(note)}</small>` : ""}</div><div class="sv">${value}${valueNote ? `<small>${escapeHtml(valueNote)}</small>` : ""}</div><div class="sa">${actions}</div></div>`;
}

function unsavedNote(p: Prefs): string {
  if (p.unsaved.length === 0) return "";
  const names = p.unsaved.map((k) => SETTING_NAMES[k] ?? k).join(", ");
  return `<section class="note alert" aria-label="Settings not saved"><p><b>Not saved: ${escapeHtml(names)}.</b> VS Code refused to write your user settings file, most often because it is open with unsaved changes or changed on disk. Save or close it, then choose again.</p></section>`;
}

function displayCard(view: ViewOptions, ctx: SettingsContext): string {
  const p = ctx.prefs;
  const other = view.unit === "cost" ? "tokens" : "cost";
  const unit = row(
    "Unit",
    escapeHtml(view.unit === "cost" ? costLabel() : "Tokens"),
    btn(other === "cost" ? `Show ${costLabel()}` : "Show tokens", commandHref("copilotUsageMonitor.setUnit", other), "Switches the status bar, side bar and panel unit"),
    "Figures in the status bar, the side bar and this panel. Saved where the setting is set: user, workspace or folder.",
  );
  let curNote: string;
  if (p.currency === "USD") curNote = "No conversion and no network request.";
  else if (view.currency && view.currency.code === p.currency) curNote = `1 USD = ${view.currency.rate} ${p.currency}, the European Central Bank rate of ${view.currency.date}.`;
  else curNote = `No ${p.currency} exchange rate yet; figures stay in USD until it arrives.`;
  const currency = row("Currency", escapeHtml(p.currency), btn("Choose…", currencyHref(), "Choose the currency for estimated cost"), "For estimated cost; targets are entered in it. User settings.", curNote);
  const pal = palette(ctx.palette);
  const colours = row("Colours", escapeHtml(pal.name), btn("Choose…", paletteHref(), "Choose a colour palette for the panel"), "The panel's accent and model colours. User settings.", pal.description);
  const sb = STATUS_BAR_OPTIONS.find((o) => o.value === p.statusBar) ?? STATUS_BAR_OPTIONS[0]!;
  const segs = STATUS_BAR_OPTIONS.map((o) =>
    o.value === sb.value
      ? `<span class="seg on" title="${escapeHtml(o.description)}">${escapeHtml(o.label)}<span class="sr"> (selected)</span></span>`
      : `<a class="seg" href="${escapeHtml(statusBarHref(o.value))}" title="${escapeHtml(o.description)}">${escapeHtml(o.label)}</a>`,
  );
  const status = row("Status bar shows", escapeHtml(sb.label), `<div class="unit">${segs.join("")}</div>`, "The tooltip keeps every figure; the icon always shows this month's target state.", sb.description);
  const nav = row(
    "Section navigation",
    ctx.navCollapsed ? "Icon rail" : "Labels and icons",
    btn(ctx.navCollapsed ? "Expand" : "Collapse", navToggleHref(), ctx.navCollapsed ? "Show the section names again" : "Collapse the section menu to an icon rail"),
    "The section menu on the left of this panel. User settings.",
  );
  return card("set-display", "settings", "Display", "how figures are shown", unit + currency + colours + status + nav, "settings");
}

function targetsCard(view: ViewOptions, p: Prefs): string {
  const code = p.currency;
  const rows = TARGET_DEFS.map((d) => {
    const v = p.targets[d.key];
    const value = v === undefined ? `<span class="muted">not set</span>` : escapeHtml(enteredAmount(v, code));
    const actions = btn("Set…", targetHref(d.period, d.bound), `Enter the ${d.label.toLowerCase()} in ${code}`) + (v !== undefined ? btn("Clear", targetHref(d.period, d.bound, ""), `Remove the ${d.label.toLowerCase()}`) : "");
    return row(d.label, value, actions, d.description);
  });
  const t = p.targets;
  const conflict = t.monthMin !== undefined && t.monthMax !== undefined && t.monthMax < t.monthMin ? `<p class="fine">The monthly most is below the least, so the most is ignored until you raise it.</p>` : "";
  const alert = row(
    "Target alert",
    p.targetAlert ? "On" : "Off",
    btn(p.targetAlert ? "Turn off" : "Turn on", targetAlertHref(!p.targetAlert), p.targetAlert ? "Stop the notification" : "Show one notification when this month first goes over the monthly most"),
    "One notification when this month first goes over the monthly most, at most once a month per window. Off by default; nothing is stored. User settings.",
  );
  const pending = view.currencyPending ? `<p class="fine">No ${escapeHtml(view.currencyPending)} exchange rate yet: targets are compared once it arrives.</p>` : "";
  const shown = view.range ? `This month is compared against ${formatRange(view.range)}.` : "";
  const intro = `<p class="intro">${escapeHtml(`Amounts are estimated cost in ${code} (Copilot only: Claude Code and Codex log no cost). A target never stops anything; it marks today, the last 7 days and this month as under, in range or over. ${shown}`.trim())}</p>`;
  return card("set-targets", "trend", "Targets", `in ${code}`, intro + rows.join("") + conflict + alert + pending, "settings");
}

function sourcesCard(s: Snapshot, p: Prefs): string {
  const h = s.health;
  const origin = (src: Source): string | undefined => {
    const r = h.sources?.[src]?.rootSource ?? (src === "copilot" ? h.rootSource : undefined);
    return r === "setting" ? "folder from the setting" : r === "env" ? "folder from the environment variable" : r === "default" ? "default folder" : undefined;
  };
  const line = (src: Source, on: boolean): string => {
    if (!on) return "Off";
    const st = h.sources?.[src]?.state;
    if (st === "off") return "Off";
    const o = origin(src);
    return [st ? STATE_WORD[st] : "on", o].filter(Boolean).join(" · ");
  };
  const rows = [
    row(SOURCE_LABEL.copilot, escapeHtml(line("copilot", true)), "", "Copilot CLI session logs: copilotUsageMonitor.copilotHome, else COPILOT_HOME, else the default folder."),
    row(SOURCE_LABEL["claude-code"], escapeHtml(line("claude-code", p.sources.claudeCode)), "", "copilotUsageMonitor.claudeCode turns it on or off; claudeHome names the folder."),
    row(SOURCE_LABEL.codex, escapeHtml(line("codex", p.sources.codex)), "", "copilotUsageMonitor.codex turns it on or off; codexHome names the folder."),
    row("History", escapeHtml(plural(p.historyMonths, "month")), "", "Months of logs read for the month picker and the trend, this month included (historyMonths)."),
    row("Project names", p.projectNames ? "On" : "Off", "", "Group sessions by project folder name (projectNames)."),
    row("Session totals", p.sessionTotals ? "On" : "Off", "", "Count older Copilot sessions from the total written when they end (sessionTotals)."),
  ];
  const foot = `<p class="foot">${escapeHtml("These settings apply to this machine, so a workspace cannot change them; no path is shown here. ")}${btn("Open in VS Code Settings", vsCodeSettingsHref(), "Opens VS Code's Settings editor at this extension's settings")}</p>`;
  return card("set-sources", "projects", "Sources and history", "per machine", rows.join("") + foot, "settings");
}

/** The Settings section body: a note when a save was refused, then Display, Targets and Sources. */
export function renderSettings(s: Snapshot, view: ViewOptions, ctx: SettingsContext): string {
  return `${unsavedNote(ctx.prefs)}${displayCard(view, ctx)}${targetsCard(view, ctx.prefs)}${sourcesCard(s, ctx.prefs)}`;
}
