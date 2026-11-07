// VS Code wiring: resolve the Copilot folder, run the monitor on a 500 ms
// poll, and show snapshots in the status bar, the details panel and the side bar. Reads
// local files only; nothing is written or persisted. The one network call is
// the opt-in exchange rate (src/vscode/exchangeRate.ts), made only when a
// non-USD currency is chosen.
import * as os from "node:os";
import { posix } from "node:path";
import * as vscode from "vscode";
import { resolveCopilotRoot } from "./core/config";
import { Logger } from "./core/log";
import { CURRENCIES, cleanCurrencyCode, DEFAULT_CURRENCY, rangeToUsd } from "./core/currency";
import { isSessionId } from "./core/extract";
import { cleanRange, money, setDisplayCurrency } from "./core/format";
import { clampHistory, UsageMonitor } from "./core/monitor";
import { callsPhrase } from "./core/panel/shared";
import { isSectionId, monthKey, sectionPickItems } from "./core/panelHtml";
import { sidebarRows } from "./core/sidebarModel";
import { nextLocalMidnight } from "./core/store";
import { STATUS_BAR_CONTENTS, type Currency, type Filter, type Snapshot, type StatusBarContent, type ViewOptions } from "./core/types";
import { fetchUsdRate } from "./vscode/exchangeRate";
import { createOutputSink } from "./vscode/outputSink";
import { DetailsPanel } from "./vscode/panel";
import { SummaryView } from "./vscode/sidebar";
import { StatusBar } from "./vscode/statusBar";

const POLL_MS = 500;
const SETTING = "copilotUsageMonitor.copilotHome";
const SECTION = "copilotUsageMonitor";
const RATE_REFRESH_MS = 6 * 60 * 60 * 1000;
const RATE_RETRY_MS = 15 * 60 * 1000;
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
  const sb = c.get<unknown>("statusBar");
  // "today" (the default) and anything unknown keep the earlier status bar text (2.5).
  const statusBar = STATUS_BAR_CONTENTS.includes(sb as StatusBarContent) && sb !== "today" ? (sb as StatusBarContent) : undefined;
  return { unit, ...(range && { range }), ...(cur && { currency: cur }), ...(pending && { currencyPending: pending }), ...(statusBar && { statusBar }) };
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

export function activate(context: vscode.ExtensionContext): void {
  const { sink, channel } = createOutputSink();
  const log = new Logger(sink);
  const status = new StatusBar("copilotUsageMonitor.showDetails");
  const panel = new DetailsPanel();
  const sidebar = new SummaryView();
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
  let view = readView(rate);
  /** viewed month start, kept across monitor restarts; undefined = current */
  let selected: number | undefined;
  let projectsOn = readProjects();
  let totalsOn = readTotals();
  /** active filter, kept across monitor restarts (D26) */
  let filter: Filter = {};
  /** session whose calls the Sessions section lists, kept across monitor restarts; in memory only (v0.6) */
  let session: string | undefined;

  const resolve = () => {
    const setting = vscode.workspace.getConfiguration("copilotUsageMonitor").get<string>("copilotHome");
    return resolveCopilotRoot({ setting, env: process.env, homedir: os.homedir() });
  };

  const onSnapshot = (s: Snapshot) => {
    snapshot = s;
    status.update(s, view);
    panel.update(s, view);
    sidebar.update(s, view, folders);
  };

  const render = () => {
    status.update(snapshot, view);
    panel.update(snapshot, view);
    sidebar.update(snapshot, view, folders);
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

  /** ("project" | "tool", value, section?); an empty value clears that filter; no args opens a
   * picker. A valid section id (the side bar's project rows) also switches the panel to it. */
  const setFilter = async (kind?: unknown, value?: unknown, section?: unknown) => {
    const m = monitor;
    if (!m) return;
    if (kind === undefined) {
      type Item = vscode.QuickPickItem & { filterKind?: "project" | "tool"; value?: string };
      const month = snapshot?.month;
      const items: Item[] = [{ label: "Clear all filters", filterKind: undefined }];
      for (const p of month?.projects ?? []) items.push({ label: p.label ?? p.name, description: `project · ${callsPhrase(p.calls, p.callsMissing)}`, filterKind: "project", value: p.name });
      for (const t of month?.tools ?? []) items.push({ label: t.name, description: `tool · ${t.builtIn ? "built-in" : "added"} · ${t.uses} uses`, filterKind: "tool", value: t.name });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Filter the month view by project or tool" });
      if (!pick || monitor !== m) return;
      if (pick.filterKind === undefined) filter = {};
      else filter = { ...filter, [pick.filterKind]: pick.value };
    } else if (kind === "clear") {
      filter = {};
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

  const setUnit = async (arg?: unknown) => {
    const unit = arg === "cost" || arg === "tokens" ? arg : view.unit === "cost" ? "tokens" : "cost";
    view = { ...view, unit };
    render();
    await vscode.workspace.getConfiguration(SECTION).update("display", unit, vscode.ConfigurationTarget.Global);
  };

  /** Fetches the chosen currency's rate now and every 6 hours; USD clears it and makes no request. */
  const refreshRate = async () => {
    if (rateTimer) clearTimeout(rateTimer);
    rateTimer = undefined;
    const code = readCurrency();
    if (code === DEFAULT_CURRENCY) {
      rate = undefined;
      return;
    }
    let next = RATE_REFRESH_MS;
    try {
      const r = await fetchUsdRate(code);
      if (readCurrency() !== code) return; // changed while in flight; that change re-fetches
      rate = r;
      log.count("rate.fetched", 1);
    } catch (e) {
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
    await vscode.workspace.getConfiguration(SECTION).update("currency", pick.code, vscode.ConfigurationTarget.Global);
  };

  const start = () => {
    stop();
    const { root, source } = resolve();
    rootKey = `${source}\u0000${root}`;
    const m = new UsageMonitor({ root, rootSource: source, log, onSnapshot, historyMonths: history, readProjects: projectsOn, readTotals: totalsOn });
    if (selected !== undefined) m.selectMonth(selected);
    if (filter.project !== undefined || filter.tool !== undefined) m.setFilter(filter);
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
    { dispose: () => rateTimer && clearTimeout(rateTimer) },
    vscode.commands.registerCommand("copilotUsageMonitor.selectCurrency", pickCurrency),
    vscode.commands.registerCommand("copilotUsageMonitor.showDetails", () => panel.show()),
    vscode.commands.registerCommand("copilotUsageMonitor.refresh", () => monitor?.refresh({ full: true })),
    vscode.commands.registerCommand("copilotUsageMonitor.pinSession", async () => {
      const m = monitor;
      const sessions = snapshot?.sessions ?? [];
      type Item = vscode.QuickPickItem & { folderId?: string };
      const items: Item[] = [
        { label: "Automatic", description: "live session with the newest record" },
        ...sessions.map((x) => ({
          label: x.folderId.slice(0, 8),
          description: [x.live ? "live" : "ended", x.lastMs ? new Date(x.lastMs).toLocaleString() : "no per-call records"].join(" · "),
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
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      folders = readFolders();
      render();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (["display", "monthlyTargetMin", "monthlyTargetMax", "currency", "statusBar"].some((k) => e.affectsConfiguration(`${SECTION}.${k}`))) {
        view = readView(rate);
        render();
      }
      if (e.affectsConfiguration(`${SECTION}.currency`)) void refreshRate();
      const h = readHistory();
      let rootChanged = false;
      if (e.affectsConfiguration(SETTING)) {
        const { root, source } = resolve();
        rootChanged = `${source}\u0000${root}` !== rootKey;
      }
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
        panelRenders: panel.renders,
        panelActive: panel.active,
        panelHeld: panel.held,
        statusA11y: status.accessibilityLabel,
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
