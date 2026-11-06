import * as vscode from "vscode";
import { DEFAULT_VIEW } from "../core/format";
import { PANEL_COMMANDS, renderPanelHtml } from "../core/panelHtml";
import type { Snapshot, ViewOptions } from "../core/types";

/** The details webview: scripts off, no local resources, command links limited
 * to PANEL_COMMANDS (month and unit only), re-rendered per snapshot. */
export class DetailsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private last: Snapshot | undefined;
  private view: ViewOptions = DEFAULT_VIEW;

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "copilotUsageMonitor.details",
      "Copilot Usage (Local)",
      vscode.ViewColumn.Active,
      { enableScripts: false, enableCommandUris: PANEL_COMMANDS, localResourceRoots: [], retainContextWhenHidden: false },
    );
    this.panel.onDidDispose(() => (this.panel = undefined));
    this.render();
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  get title(): string | undefined {
    return this.panel?.title;
  }

  update(s: Snapshot | undefined, view: ViewOptions = this.view): void {
    this.last = s;
    this.view = view;
    this.render();
  }

  private render(): void {
    if (!this.panel) return;
    this.panel.webview.html = renderPanelHtml(this.last, this.panel.webview.cspSource, this.view);
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
