// VS Code wiring: resolve the Copilot folder, run the monitor on a 500 ms
// poll, and show snapshots in the status bar and the details panel. Reads
// local files only; nothing is written, persisted or sent.
import * as os from "node:os";
import * as vscode from "vscode";
import { resolveCopilotRoot } from "./core/config";
import { Logger } from "./core/log";
import { UsageMonitor } from "./core/monitor";
import { nextLocalMidnight } from "./core/store";
import type { Snapshot } from "./core/types";
import { createOutputSink } from "./vscode/outputSink";
import { DetailsPanel } from "./vscode/panel";
import { StatusBar } from "./vscode/statusBar";

const POLL_MS = 500;
const SETTING = "copilotUsageMonitor.copilotHome";

export function activate(context: vscode.ExtensionContext): void {
  const { sink, channel } = createOutputSink();
  const log = new Logger(sink);
  const status = new StatusBar("copilotUsageMonitor.showDetails");
  const panel = new DetailsPanel();
  context.subscriptions.push(channel, status, panel);

  let snapshot: Snapshot | undefined;
  let monitor: UsageMonitor | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let midnight: ReturnType<typeof setTimeout> | undefined;
  let rootKey: string | undefined;

  const resolve = () => {
    const setting = vscode.workspace.getConfiguration("copilotUsageMonitor").get<string>("copilotHome");
    return resolveCopilotRoot({ setting, env: process.env, homedir: os.homedir() });
  };

  const onSnapshot = (s: Snapshot) => {
    snapshot = s;
    status.update(s);
    panel.update(s);
  };

  const start = () => {
    stop();
    const { root, source } = resolve();
    rootKey = `${source}\u0000${root}`;
    const m = new UsageMonitor({ root, rootSource: source, log, onSnapshot });
    monitor = m;
    snapshot = undefined;
    status.update(undefined);
    panel.update(undefined);
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SETTING)) return;
      const { root, source } = resolve();
      if (`${source}\u0000${root}` !== rootKey) start();
    }),
  );

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand("copilotUsageMonitor._testState", () => ({
        statusText: status.text,
        tooltip: status.tooltip,
        panelOpen: panel.isOpen,
        panelTitle: panel.title,
        snapshot,
      })),
    );
  }

  start();
}

export function deactivate(): void {}
