import * as vscode from "vscode";
import { currentRangeState, DEFAULT_VIEW, statusText, tooltipMarkdown } from "../core/format";
import type { Snapshot, ViewOptions } from "../core/types";

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  text = "";
  tooltip = "";

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = "Copilot Usage (Local)";
    this.item.command = command;
    this.update(undefined);
    this.item.show();
  }

  update(s: Snapshot | undefined, view: ViewOptions = DEFAULT_VIEW): void {
    this.text = statusText(s, view);
    this.tooltip = tooltipMarkdown(s, view);
    const over = s !== undefined && currentRangeState(s, view) === "over";
    this.item.backgroundColor = over ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const md = new vscode.MarkdownString(this.tooltip);
    md.isTrusted = false;
    md.supportHtml = false;
    md.supportThemeIcons = false;
    this.item.text = this.text;
    this.item.tooltip = md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
