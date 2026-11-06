import * as vscode from "vscode";
import { renderPanelHtml } from "../core/panelHtml";
import type { Snapshot } from "../core/types";

/** The details webview: scripts off, no local resources, re-rendered per snapshot. */
export class DetailsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private last: Snapshot | undefined;

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "copilotUsageMonitor.details",
      "Copilot Usage (Local)",
      vscode.ViewColumn.Active,
      { enableScripts: false, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: false },
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

  update(s: Snapshot | undefined): void {
    this.last = s;
    this.render();
  }

  private render(): void {
    if (!this.panel) return;
    this.panel.webview.html = renderPanelHtml(this.last, this.panel.webview.cspSource);
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
