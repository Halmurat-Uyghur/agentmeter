import * as vscode from "vscode";
import { statusText, tooltipMarkdown } from "../core/format";
import type { Snapshot } from "../core/types";

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

  update(s: Snapshot | undefined): void {
    this.text = statusText(s);
    this.tooltip = tooltipMarkdown(s);
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
