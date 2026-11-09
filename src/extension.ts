// VS Code wiring: resolve the Copilot, Claude Code and Codex folders, run the monitor on a 500 ms
// poll, and show snapshots in the status bar, the details panel and the side bar. Reads
// local files only; nothing is written or persisted. The one network call is
// the opt-in exchange rate (src/vscode/exchangeRate.ts), made only when a
// non-USD currency is chosen.
import * as os from "node:os";
import { posix } from "node:path";
import * as vscode from "vscode";
import { resolveRoot, type ResolvedRoot } from "./core/config";
import { Logger } from "./core/log";
import { CURRENCIES, cleanCurrencyCode, DEFAULT_CURRENCY, rangeToUsd } from "./core/currency";
import { isSessionId } from "./core/extract";
import { cleanRange, enabledSources, money, setDisplayCurrency } from "./core/format";
import { clampHistory, UsageMonitor, type MonitorOptions } from "./core/monitor";
import { cleanPaletteId, isPaletteId, palettePickItems, type PaletteId } from "./core/palettes";
import type { TargetBound, TargetPeriod } from "./core/panel/links";
import { enteredAmount, STATUS_BAR_OPTIONS, TARGET_DEFS } from "./core/panel/settings";
import { callsPhrase } from "./core/panel/shared";
import { isSectionId, monthKey, sectionPickItems } from "./core/panelHtml";
import { sidebarRows } from "./core/sidebarModel";
import { monthStarts, nextLocalMidnight } from "./core/store";
import { isSource, type Prefs, SOURCE_LABEL, SOURCES, STATUS_BAR_CONTENTS, type Currency, type Filter, type Snapshot, type StatusBarContent, type ViewOptions } from "./core/types";
import { fetchUsdRate } from "./vscode/exchangeRate";
import { createOutputSink } from "./vscode/outputSink";
import { DetailsPanel } from "./vscode/panel";
import { SummaryView } from "./vscode/sidebar";
import { TargetAlert } from "./vscode/targetAlert";
import { StatusBar } from "./vscode/statusBar";

const POLL_MS = 500;
const SETTING = "copilotUsageMonitor.copilotHome";
const SECTION = "copilotUsageMonitor";
/** settings that turn a source on or off or move its folder; a change re-resolves the roots (D48) */
const SOURCE_SETTINGS = ["claudeCode", "codex", "claudeHome", "codexHome"].map((k) => `${SECTION}.${k}`);
const RATE_REFRESH_MS = 6 * 60 * 60 * 1000;
const RATE_RETRY_MS = 15 * 60 * 1000;
/** A refused settings write is tried once more after this long (settings.json is often dirty for a moment) (v0.9, D1). */
const SAVE_RETRY_MS = 1500;
/** The settings the extension writes (D3); every write names one of these as a literal. */
type SettingKey = "display" | "currency" | "palette" | "panelNavCollapsed" | "statusBar" | "targetAlert" | "dailyTargetMax" | "weeklyTargetMax" | "monthlyTargetMin" | "monthlyTargetMax";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function readCurrency(): string {
  return cleanCurrencyCode(vscode.workspace.getConfiguration(SECTION).get<unknown>("currency"));
}

/** Targets are entered in the chosen currency and held in USD; with no rate yet they are left out.
 * Also sets the display currency every cost formatter uses. */
function readView(rate: Currency | undefined): ViewOptions {
  const c = vscode.workspace.getConfiguration(SECTION);
  const unit = c.get<string>("display") === "cost" ? "cost" : "tokens";
  const code = readCurrency();
  const cur = code !== DEFAULT_CURRENCY && rate?.code === code ? rate : undefined;
  const pending = code !== DEFAULT_CURRENCY && !cur ? code : undefined;
  setDisplayCurrency(cur);
  const raw = cleanRange(c.get<unknown>("monthlyTargetMin"), c.get<unknown>("monthlyTargetMax"));
  const range = pending ? undefined : rangeToUsd(raw, cur);
  // The daily and weekly targets (v0.9) are ceilings in the chosen currency, held in USD like the range.
  const dayTarget = pending ? undefined : rangeToUsd(cleanRange(undefined, c.get<unknown>("dailyTargetMax")), cur);
  const weekTarget = pending ? undefined : rangeToUsd(cleanRange(undefined, c.get<unknown>("weeklyTargetMax")), cur);
  const sb = c.get<unknown>("statusBar");
  // "today" (the default) and anything unknown keep the earlier status bar text (2.5).
  const statusBar = STATUS_BAR_CONTENTS.includes(sb as StatusBarContent) && sb !== "today" ? (sb as StatusBarContent) : undefined;
  return {
    unit,
    ...(range && { range }),
    ...(dayTarget && { dayTarget }),
    ...(weekTarget && { weekTarget }),
    ...(cur && { currency: cur }),
    ...(pending && { currencyPending: pending }),
    ...(statusBar && { statusBar }),
  };
}

/** A target amount typed or linked: a non-negative number with an optional fraction; anything else is undefined. */
function parseAmount(v: string): number | undefined {
  if (!/^\s*\d{1,12}(\.\d{1,6})?\s*$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A fixed code for a refused settings write, from VS Code's own error text; the text itself
 * (which can name the file) is never logged (D2). */
function saveErrorCode(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (/unsaved|dirty/i.test(m)) return "FILE_DIRTY";
  if (/newer|modified/i.test(m)) return "FILE_MODIFIED";
  if (/not a registered/i.test(m)) return "UNKNOWN_KEY";
  if (/errors\/warnings|correct errors/i.test(m)) return "INVALID_FILE";
  if (/policy/i.test(m)) return "POLICY";
  if (/does not support/i.test(m)) return "INVALID_TARGET";
  return "WRITE_FAILED";
}

/** Where a setting without a fixed scope is written: the scope that holds a value, else user settings (v0.7). */
function scopeOf(key: SettingKey): vscode.ConfigurationTarget {
  const at = vscode.workspace.getConfiguration(SECTION).inspect(key);
  const T = vscode.ConfigurationTarget;
  return at?.workspaceFolderValue !== undefined ? T.WorkspaceFolder : at?.workspaceValue !== undefined ? T.Workspace : T.Global;
}

/** The settings the panel's Settings section lists (v0.9), as entered; `unsaved` are the keys whose last save was refused. */
function readPrefs(unsaved: Iterable<string>): Prefs {
  const c = vscode.workspace.getConfiguration(SECTION);
  const sb = c.get<unknown>("statusBar");
  const amount = (k: string): number | undefined => {
    const v = c.get<unknown>(k);
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  };
  const targets: Prefs["targets"] = {};
  for (const d of TARGET_DEFS) {
    const v = amount(d.setting);
    if (v !== undefined) targets[d.key] = v;
  }
  return {
    currency: readCurrency(),
    statusBar: STATUS_BAR_CONTENTS.includes(sb as StatusBarContent) ? (sb as StatusBarContent) : "today",
    targets,
    targetAlert: c.get<unknown>("targetAlert") === true,
    historyMonths: readHistory(),
    projectNames: readProjects(),
    sessionTotals: readTotals(),
    sources: { claudeCode: c.get<unknown>("claudeCode") !== false, codex: c.get<unknown>("codex") !== false },
    unsaved: [...unsaved].sort(),
  };
}

function readProjects(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>("projectNames") !== false;
}

/** Session totals from session.shutdown lines (D29); on unless set to false. */
function readTotals(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>("sessionTotals") !== false;
}

/** Filter values come from the panel or a quick pick; cap and type-check them. */
function filterValue(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined;
}

/** Basenames of the open workspace folders' paths (not their display names), in order. */
function readFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => posix.basename(f.uri.path)).filter((n) => n.length > 0);
}

function readHistory(): number {
  return clampHistory(vscode.workspace.getConfiguration(SECTION).get<unknown>("historyMonths") ?? 12);
}

/** `copilotUsageMonitor.panelNavCollapsed`: the panel's section nav shows as an icon rail. */
function readNavCollapsed(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<unknown>("panelNavCollapsed") === true;
}

/** `copilotUsageMonitor.palette`: the panel's colour palette; anything unknown is "theme" (v0.8). */
function readPalette(): PaletteId {
  return cleanPaletteId(vscode.workspace.getConfiguration(SECTION).get<unknown>("palette"));
}

export function activate(context: vscode.ExtensionContext): void {
  const { sink, channel } = createOutputSink();
  const log = new Logger(sink);
  const status = new StatusBar("copilotUsageMonitor.showDetails");
  const panel = new DetailsPanel(undefined, context.extensionUri && vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg"));
  panel.setNavCollapsed(readNavCollapsed());
  panel.setPalette(readPalette());
  const sidebar = new SummaryView();
  /** opt-in, once a month per window, in memory only (v0.6) */
  const alert = new TargetAlert(() => panel.show(), log);
  /** basenames of the open workspace folders, for the side bar's "This workspace" group */
  let folders = readFolders();
  context.subscriptions.push(channel, status, panel, sidebar);

  let snapshot: Snapshot | undefined;
  let monitor: UsageMonitor | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let midnight: ReturnType<typeof setTimeout> | undefined;
  let rootKey: string | undefined;
  let history = readHistory();
  let rate: Currency | undefined;
  let rateTimer: ReturnType<typeof setTimeout> | undefined;
  /** bumped per refreshRate call; a fetch that settles after a newer call (or after dispose) is dropped (v0.7) */
  let rateGen = 0;
  let disposed = false;
  let view = readView(rate);
  /** setting keys whose last save VS Code refused, for the Settings section (D1) */
  const unsaved = new Set<string>();
  /** The prefs in effect: the saved ones, except a status-bar choice whose save was refused is
   * still drawn from `view` (D1), so the Settings section and picker mark what the bar shows. */
  const currentPrefs = (): Prefs => {
    const p = readPrefs(unsaved);
    return unsaved.has("statusBar") ? { ...p, statusBar: view.statusBar ?? "today" } : p;
  };
  const pushPrefs = () => panel.setPrefs(currentPrefs());
  pushPrefs();
  /** bumped per updateSetting call for a key; a pending retry for an older value is dropped */
  const saveGen = new Map<string, number>();

  /** The one place a setting is written (D3). A refused write is logged as a code (D2), tried
   * once more after SAVE_RETRY_MS, then remembered in `unsaved`; the caller never rolls back
   * what the user chose (D1). A retry superseded by a newer write of the same key is dropped,
   * so it cannot overwrite the newer choice. Returns whether the value was saved. */
  const updateSetting = async (key: SettingKey, value: unknown, target: vscode.ConfigurationTarget, where: string): Promise<boolean> => {
    const c = vscode.workspace.getConfiguration(SECTION);
    const gen = (saveGen.get(key) ?? 0) + 1;
    saveGen.set(key, gen);
    for (let attempt = 0; ; attempt++) {
      try {
        await c.update(key, value, target);
        if (unsaved.delete(key)) pushPrefs();
        return true;
      } catch (e) {
        log.error(where, saveErrorCode(e));
        if (attempt > 0 || disposed) break;
        await new Promise((r) => setTimeout(r, SAVE_RETRY_MS));
        if (disposed) break;
        if (saveGen.get(key) !== gen) return false; // a newer write of this key owns the outcome
      }
    }
    unsaved.add(key);
    pushPrefs();
    return false;
  };
  /** viewed month start, kept across monitor restarts; undefined = current */
  let selected: number | undefined;
  let projectsOn = readProjects();
  let totalsOn = readTotals();
  /** active filter, kept across monitor restarts (D26) */
  let filter: Filter = {};
  /** session whose calls the Sessions section lists, kept across monitor restarts; in memory only (v0.6) */
  let session: string | undefined;

  /** Copilot's folder, and Claude Code's and Codex's unless their setting is false (D48). */
  const resolve = () => {
    const c = vscode.workspace.getConfiguration(SECTION);
    const at = { env: process.env, homedir: os.homedir() };
    const copilot = resolveRoot("copilot", { setting: c.get<unknown>("copilotHome"), ...at });
    const claude = c.get<unknown>("claudeCode") !== false ? resolveRoot("claude", { setting: c.get<unknown>("claudeHome"), ...at }) : undefined;
    const codex = c.get<unknown>("codex") !== false ? resolveRoot("codex", { setting: c.get<unknown>("codexHome"), ...at }) : undefined;
    return { copilot, claude, codex };
  };
  /** One string per resolved state: each root, its origin and whether the source is on. */
  const keyOf = (r: ReturnType<typeof resolve>) => {
    const one = (x: ResolvedRoot | undefined) => (x ? `${x.source}\u0000${x.root}` : "off");
    return [one(r.copilot), one(r.claude), one(r.codex)].join("\u0001");
  };

  const onSnapshot = (s: Snapshot) => {
    snapshot = s;
    status.update(s, view);
    panel.update(s, view);
    sidebar.update(s, view, folders);
    alert.check(s, view);
  };

  const render = () => {
    status.update(snapshot, view);
    panel.update(snapshot, view);
    sidebar.update(snapshot, view, folders);
    alert.check(snapshot, view);
  };

  /** "current", "YYYY-MM" or "pick"; anything else is ignored. */
  const selectMonth = async (arg?: unknown) => {
    const m = monitor;
    if (!m) return;
    let key = typeof arg === "string" ? arg : "pick";
    if (key === "pick") {
      const months = [...(snapshot?.history ?? [])].reverse();
      type Item = vscode.QuickPickItem & { key: string };
      const items: Item[] = months.map((h, i) => {
        const d = new Date(h.monthStartMs);
        const est = h.totals && h.totals.nanoAiu.reported > 0 ? `${money(h.totals.nanoAiu.sum / 1e11)} est.` : "no per-call records";
        const calls = h.totals ? callsPhrase(h.totals.calls, h.totals.callsMissing) : "";
        return {
          label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
          description: [i === 0 ? "this month" : "", calls, est].filter(Boolean).join(" · "),
          key: i === 0 ? "current" : monthKey(h.monthStartMs),
        };
      });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Month to show in the panel" });
      if (!pick || monitor !== m) return;
      key = pick.key;
    }
    if (key === "current") selected = undefined;
    else {
      const match = /^(\d{4})-(\d{2})$/.exec(key);
      if (!match) return;
      const ms = new Date(Number(match[1]), Number(match[2]) - 1, 1).getTime();
      selected = (snapshot?.history ?? []).some((h) => h.monthStartMs === ms) ? ms : undefined;
    }
    m.selectMonth(selected);
    panel.show();
  };

  /** ("project" | "tool" | "source", value, section?); an empty value clears that filter; no args opens a
   * picker. A valid section id (the side bar's project rows) also switches the panel to it. */
  const setFilter = async (kind?: unknown, value?: unknown, section?: unknown) => {
    const m = monitor;
    if (!m) return;
    if (kind === undefined) {
      type Item = vscode.QuickPickItem & { filterKind?: "project" | "tool" | "source"; value?: string };
      const month = snapshot?.month;
      const items: Item[] = [{ label: "Clear all filters", filterKind: undefined }];
      for (const p of month?.projects ?? []) items.push({ label: p.label ?? p.name, description: `project · ${callsPhrase(p.calls, p.callsMissing)}`, filterKind: "project", value: p.name });
      for (const t of month?.tools ?? []) items.push({ label: t.name, description: `tool · ${t.builtIn ? "built-in" : "added"} · ${t.uses} uses`, filterKind: "tool", value: t.name });
      // Only the enabled sources (every source before per-source health is known).
      for (const s of (snapshot && enabledSources(snapshot.health)) ?? SOURCES) {
        const t = month?.totals?.bySource?.[s];
        items.push({ label: SOURCE_LABEL[s], description: t ? `source · ${callsPhrase(t.calls, t.callsMissing)}` : "source", filterKind: "source", value: s });
      }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Filter the month view by project, tool or source" });
      if (!pick || monitor !== m) return;
      if (pick.filterKind === undefined) filter = {};
      else filter = { ...filter, [pick.filterKind]: pick.value };
    } else if (kind === "clear") {
      filter = {};
    } else if (kind === "source") {
      // "" clears; anything that is not one of SOURCES is ignored (D49)
      if (value !== "" && !isSource(value)) return;
      // A source that is off would show an empty month: ignore it once per-source health is known.
      const on = snapshot && enabledSources(snapshot.health);
      if (value !== "" && on && !on.includes(value)) return;
      const next: Filter = { ...filter };
      if (value === "") delete next.source;
      else next.source = value;
      filter = next;
    } else if (kind === "project" || kind === "tool") {
      const v = filterValue(value);
      const next: Filter = { ...filter };
      if (v === undefined) delete next[kind];
      else next[kind] = v;
      filter = next;
    } else {
      return;
    }
    m.setFilter(filter);
    panel.show(isSectionId(section) ? section : undefined);
  };

  /** A session id lists that session's calls in the Sessions section; "" closes the list.
   * Anything else (no argument, a non-string, an id of another shape) is ignored (v0.6). */
  const showSession = (arg?: unknown) => {
    const m = monitor;
    if (!m) return;
    if (arg === "") session = undefined;
    else if (isSessionId(arg)) session = arg;
    else return;
    m.selectSession(session);
    panel.show("sessions");
  };

  /** A section id switches the panel to it; no argument opens a picker; anything else is ignored (D30). */
  const showSection = async (arg?: unknown) => {
    if (arg === undefined) {
      const pick = await vscode.window.showQuickPick(sectionPickItems(panel.section), { placeHolder: "Section of the Copilot usage panel" });
      if (pick) panel.show(pick.id);
      return;
    }
    if (isSectionId(arg)) panel.show(arg);
  };

  /** Collapses or expands the panel's section nav (takes no argument); drawn at once and
   * remembered in the user setting, like the tokens / cost switch. */
  const toggleNav = async () => {
    const collapsed = !panel.navCollapsed;
    panel.setNavCollapsed(collapsed);
    await updateSetting("panelNavCollapsed", collapsed, vscode.ConfigurationTarget.Global, "nav.write");
  };

  /** "cost" | "tokens" sets the unit, no argument toggles it, anything else is ignored. Drawn at
   * once, then written at the scope that holds the value (folder, workspace, else user), so no
   * workspace entry is created; a refused write keeps the unit shown (D1). */
  const setUnit = async (arg?: unknown) => {
    if (arg !== undefined && arg !== "cost" && arg !== "tokens") return;
    const unit = arg ?? (view.unit === "cost" ? "tokens" : "cost");
    view = { ...view, unit };
    render();
    await updateSetting("display", unit, scopeOf("display"), "unit.write");
  };

  /** "today" | "month" | "session" sets what the status bar shows; no argument opens a picker;
   * anything else is ignored (v0.9). Drawn at once, written like the unit. */
  const setStatusBar = async (arg?: unknown) => {
    let value: StatusBarContent;
    if (arg === undefined) {
      const now = currentPrefs().statusBar;
      const items = STATUS_BAR_OPTIONS.map((o) => ({ label: o.label, description: o.description + (o.value === now ? " · current" : ""), value: o.value }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "What the status bar shows" });
      if (!pick) return;
      value = pick.value;
    } else if (STATUS_BAR_CONTENTS.includes(arg as StatusBarContent)) value = arg as StatusBarContent;
    else return;
    const { statusBar: _drop, ...rest } = view;
    view = value === "today" ? rest : { ...rest, statusBar: value };
    render();
    await updateSetting("statusBar", value, scopeOf("statusBar"), "statusbar.write");
  };

  /** (period "day" | "week" | "month", bound "min" | "max", value?) sets one target bound, in the
   * chosen currency: "" clears it, a number saves it, no value asks with an input box; no arguments
   * offer the four targets in a picker. Anything outside those lists is ignored (v0.9). */
  const setTarget = async (period?: unknown, bound?: unknown, value?: unknown) => {
    const prefs = currentPrefs();
    let def = TARGET_DEFS.find((d) => d.period === period && d.bound === bound);
    if (period === undefined) {
      const items = TARGET_DEFS.map((d) => ({ label: d.label, description: prefs.targets[d.key] === undefined ? "not set" : enteredAmount(prefs.targets[d.key]!, prefs.currency), def: d }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Target to set, in ${prefs.currency} (estimated cost)` });
      if (!pick) return;
      def = pick.def;
    } else if (!def) return;
    const d = def;
    const key = d.setting as SettingKey;
    let next: number | undefined;
    if (value === undefined) {
      const current = prefs.targets[d.key];
      const typed = await vscode.window.showInputBox({
        prompt: `${d.label} in ${prefs.currency}, as estimated cost. Leave empty to clear it.`,
        value: current === undefined ? "" : String(current),
        validateInput: (t: string) => (t.trim() === "" || parseAmount(t) !== undefined ? undefined : "Enter a number of 0 or more, or leave it empty to clear."),
      });
      if (typed === undefined) return;
      if (typed.trim() === "") next = undefined;
      else {
        next = parseAmount(typed);
        if (next === undefined) return;
      }
    } else if (typeof value === "string") {
      if (value.trim() === "") next = undefined;
      else {
        next = parseAmount(value);
        if (next === undefined) return;
      }
    } else return;
    await updateSetting(key, next, scopeOf(key), "target.write");
  };

  /** "on" | "off" (or a boolean) sets the opt-in target alert; no argument toggles it; anything
   * else is ignored (v0.9). User settings only, like "Don't show again". */
  const setTargetAlert = async (arg?: unknown) => {
    let on: boolean;
    if (arg === undefined) on = !currentPrefs().targetAlert;
    else if (arg === "on" || arg === true) on = true;
    else if (arg === "off" || arg === false) on = false;
    else return;
    await updateSetting("targetAlert", on, vscode.ConfigurationTarget.Global, "alert.write");
  };

  /** Fetches the chosen currency's rate now and every 6 hours; USD clears it and makes no request. */
  const refreshRate = async () => {
    if (rateTimer) clearTimeout(rateTimer);
    rateTimer = undefined;
    const gen = ++rateGen;
    const code = readCurrency();
    if (code === DEFAULT_CURRENCY) {
      rate = undefined;
      return;
    }
    let next = RATE_REFRESH_MS;
    try {
      const r = await fetchUsdRate(code);
      // deactivated, or superseded by a newer call (a currency change), while in flight (v0.7)
      if (disposed || gen !== rateGen) return;
      rate = r;
      log.count("rate.fetched", 1);
    } catch (e) {
      if (disposed || gen !== rateGen) return;
      log.error("rate.fetch", e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : "NETWORK");
      next = RATE_RETRY_MS;
    }
    view = readView(rate);
    render();
    rateTimer = setTimeout(() => void refreshRate(), next);
  };

  const pickCurrency = async () => {
    const now = readCurrency();
    const items = CURRENCIES.map(([code, name]) => ({ label: code, description: name + (code === now ? " · current" : ""), code }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Currency for estimated cost (non-USD fetches the daily USD rate)" });
    if (!pick) return;
    await updateSetting("currency", pick.code, vscode.ConfigurationTarget.Global, "currency.write");
  };

  /** A palette id applies that palette; no argument opens a picker; anything else is ignored (v0.8).
   * Drawn at once and saved in the user settings (application scope, like the currency). A refused
   * write is logged with its reason code and the palette stays as chosen in this window (v0.9, D1):
   * before, the rollback redrew the saved palette at once, so a pick looked like it did nothing. */
  const selectPalette = async (arg?: unknown) => {
    let id: PaletteId;
    if (arg === undefined) {
      const pick = await vscode.window.showQuickPick(palettePickItems(panel.paletteId), { placeHolder: "Colour palette for the details panel" });
      if (!pick) return;
      id = pick.id;
    } else if (isPaletteId(arg)) id = arg;
    else return;
    panel.setPalette(id);
    await updateSetting("palette", id, vscode.ConfigurationTarget.Global, "palette.write");
  };

  /** Opens VS Code's Settings editor at this extension's settings (the machine-scoped ones are edited there). */
  const openVsCodeSettings = () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local.copilot-usage-monitor");

  const start = () => {
    stop();
    const r = resolve();
    rootKey = keyOf(r);
    // A source filter naming a source that is now off would show an empty month: drop it,
    // like a project filter when readProjects is off.
    if ((filter.source === "claude-code" && !r.claude) || (filter.source === "codex" && !r.codex)) delete filter.source;
    const sources: NonNullable<MonitorOptions["sources"]> = {
      ...(r.claude && { claude: { root: r.claude.root, rootSource: r.claude.source } }),
      ...(r.codex && { codex: { root: r.codex.root, rootSource: r.codex.source } }),
    };
    // A viewed month outside the (possibly shorter) window is dropped, so raising
    // historyMonths again later does not jump back to it (v0.7).
    if (selected !== undefined && selected < monthStarts(new Date(), history)[0]!) selected = undefined;
    const m = new UsageMonitor({ root: r.copilot.root, rootSource: r.copilot.source, sources, log, onSnapshot, historyMonths: history, readProjects: projectsOn, readTotals: totalsOn });
    if (selected !== undefined) m.selectMonth(selected);
    if (filter.project !== undefined || filter.tool !== undefined || filter.source !== undefined) m.setFilter(filter);
    if (session !== undefined) m.selectSession(session);
    monitor = m;
    snapshot = undefined;
    status.update(undefined, view);
    panel.update(undefined, view);
    sidebar.update(undefined, view, folders);
    void m.refresh({ full: true });
    poll = setInterval(() => void m.refresh(), POLL_MS);
    armMidnight();
  };

  const armMidnight = () => {
    if (midnight) clearTimeout(midnight);
    const delay = Math.max(1000, nextLocalMidnight(new Date()) - Date.now() + 1000);
    midnight = setTimeout(() => {
      void monitor?.refresh({ full: true });
      armMidnight();
    }, delay);
  };

  const stop = () => {
    if (poll) clearInterval(poll);
    if (midnight) clearTimeout(midnight);
    poll = midnight = undefined;
    monitor?.dispose();
    monitor = undefined;
  };

  context.subscriptions.push(
    { dispose: stop },
    {
      dispose: () => {
        disposed = true;
        if (rateTimer) clearTimeout(rateTimer);
        rateTimer = undefined;
      },
    },
    vscode.commands.registerCommand("copilotUsageMonitor.selectCurrency", pickCurrency),
    vscode.commands.registerCommand("copilotUsageMonitor.showDetails", () => panel.show()),
    vscode.commands.registerCommand("copilotUsageMonitor.refresh", () => monitor?.refresh({ full: true })),
    vscode.commands.registerCommand("copilotUsageMonitor.pinSession", async () => {
      const m = monitor;
      const sessions = snapshot?.sessions ?? [];
      // The source label only when more than one source is read; Copilot-only keeps 0.7's description.
      const several = Object.keys(snapshot?.health.sources ?? {}).length >= 2;
      type Item = vscode.QuickPickItem & { folderId?: string };
      const items: Item[] = [
        { label: "Automatic", description: "live session with the newest record" },
        ...sessions.map((x) => ({
          label: x.folderId.slice(0, 8),
          // mtime-based sources have no end marker: "idle", never "ended" (D43)
          description: [several && x.source ? SOURCE_LABEL[x.source] : "", x.live ? "live" : x.source && x.source !== "copilot" ? "idle" : "ended", x.lastMs ? new Date(x.lastMs).toLocaleString() : "no per-call records"].filter(Boolean).join(" · "),
          folderId: x.folderId,
        })),
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Session to show as current" });
      // Pin on the monitor the list came from; a re-root meanwhile drops the pick.
      if (pick && m && monitor === m) m.pin(pick.folderId);
    }),
    vscode.commands.registerCommand("copilotUsageMonitor.selectMonth", selectMonth),
    vscode.commands.registerCommand("copilotUsageMonitor.setUnit", setUnit),
    vscode.commands.registerCommand("copilotUsageMonitor.toggleUnit", () => setUnit()),
    vscode.commands.registerCommand("copilotUsageMonitor.setFilter", setFilter),
    vscode.commands.registerCommand("copilotUsageMonitor.filter", () => setFilter()),
    vscode.commands.registerCommand("copilotUsageMonitor.showSection", showSection),
    vscode.commands.registerCommand("copilotUsageMonitor.showSession", showSession),
    vscode.commands.registerCommand("copilotUsageMonitor.toggleNav", toggleNav),
    vscode.commands.registerCommand("copilotUsageMonitor.selectPalette", selectPalette),
    vscode.commands.registerCommand("copilotUsageMonitor.showSettings", () => panel.show("settings")),
    vscode.commands.registerCommand("copilotUsageMonitor.setStatusBar", setStatusBar),
    vscode.commands.registerCommand("copilotUsageMonitor.setTarget", setTarget),
    vscode.commands.registerCommand("copilotUsageMonitor.setTargetAlert", setTargetAlert),
    vscode.commands.registerCommand("copilotUsageMonitor.openVsCodeSettings", openVsCodeSettings),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      folders = readFolders();
      render();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (["display", "monthlyTargetMin", "monthlyTargetMax", "dailyTargetMax", "weeklyTargetMax", "currency", "statusBar", "targetAlert"].some((k) => e.affectsConfiguration(`${SECTION}.${k}`))) {
        view = readView(rate);
        render();
      }
      if (e.affectsConfiguration(`${SECTION}.currency`)) void refreshRate();
      if (e.affectsConfiguration(`${SECTION}.panelNavCollapsed`)) panel.setNavCollapsed(readNavCollapsed());
      if (e.affectsConfiguration(`${SECTION}.palette`)) panel.setPalette(readPalette());
      if (e.affectsConfiguration(SECTION)) pushPrefs();
      const h = readHistory();
      let rootChanged = false;
      if (e.affectsConfiguration(SETTING) || SOURCE_SETTINGS.some((k) => e.affectsConfiguration(k))) rootChanged = keyOf(resolve()) !== rootKey;
      const p = readProjects();
      const t = readTotals();
      if (rootChanged || h !== history || p !== projectsOn || t !== totalsOn) {
        history = h;
        projectsOn = p;
        totalsOn = t;
        if (!p) delete filter.project;
        start();
      }
    }),
  );

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand("copilotUsageMonitor._testState", () => ({
        statusText: status.text,
        tooltip: status.tooltip,
        panelOpen: panel.isOpen,
        panelTitle: panel.title,
        panelSection: panel.section,
        panelNavCollapsed: panel.navCollapsed,
        panelPalette: panel.paletteId,
        prefs: panel.currentPrefs,
        panelRenders: panel.renders,
        panelActive: panel.active,
        panelHeld: panel.held,
        statusA11y: status.accessibilityLabel,
        alertsShown: alert.shown,
        sidebar: {
          visible: sidebar.visible,
          renders: sidebar.renders,
          state: sidebar.state,
          unitWord: sidebar.unitWord,
          html: sidebar.lastHtml,
          options: sidebar.webviewOptions && {
            enableScripts: sidebar.webviewOptions.enableScripts,
            enableForms: sidebar.webviewOptions.enableForms,
            enableCommandUris: sidebar.webviewOptions.enableCommandUris,
            localResourceRoots: sidebar.webviewOptions.localResourceRoots?.map(String),
          },
          folders,
          rows: sidebarRows(sidebar.current).map((r) => ({ id: r.id, label: r.label, value: r.value, spoken: r.spoken, link: r.link })),
          groups: sidebar.current.groups.map((g) => g.id),
          insights: sidebar.current.insights?.link,
          health: sidebar.current.health?.link,
        },
        snapshot,
        view,
      })),
    );
  }

  start();
  void refreshRate();
}

export function deactivate(): void {}
