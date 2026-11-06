// The side bar summary view (A1): a no-script webview view over buildSidebarModel and
// renderSidebarHtml. Scripts are off, no local resources load, and command links are
// limited to SIDEBAR_COMMANDS. The model follows every snapshot; the page is redrawn
// only while the view is visible (250 ms trailing debounce), once when it becomes
// visible again after a change, and never with an unchanged HTML string.
// Focus (A11y C1): a redraw reloads the page and moves focus to its top. The side bar
// redraws only when a figure it shows changed (an equal model signature returns before
// any timer, and an equal HTML string is never assigned), so idle polling and model
// calls that leave its rounded figures unchanged never move focus. VS Code does not
// report focus inside a webview view, so it is not throttled further, unlike the panel.
import * as vscode from "vscode";
import { DEFAULT_VIEW } from "../core/format";
import { renderSidebarHtml } from "../core/sidebarHtml";
import { buildSidebarModel, SIDEBAR_COMMANDS, type SidebarModel, type SidebarState } from "../core/sidebarModel";
import type { Snapshot, ViewOptions } from "../core/types";

export const SUMMARY_VIEW_ID = "copilotUsageMonitor.summary";

/** The webview's options; the gates test reads this line. */
export const SIDEBAR_WEBVIEW_OPTIONS: vscode.WebviewOptions = { enableScripts: false, enableForms: false, enableCommandUris: SIDEBAR_COMMANDS, localResourceRoots: [] };

export class SummaryView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private viewSubs: vscode.Disposable[] = [];
  private model: SidebarModel = buildSidebarModel(undefined);
  /** the HTML last assigned to the webview */
  private html: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** the model changed since the last draw */
  private stale = true;
  /** webview.html assignments, for the integration tests */
  renders = 0;

  constructor(private readonly debounceMs = 250) {
    this.subs.push(vscode.window.registerWebviewViewProvider(SUMMARY_VIEW_ID, this));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const d of this.viewSubs) d.dispose();
    this.view = view;
    this.html = undefined;
    view.webview.options = SIDEBAR_WEBVIEW_OPTIONS;
    view.description = this.model.unitWord;
    this.viewSubs = [
      view.onDidChangeVisibility(() => {
        if (view.visible && this.stale) this.draw();
      }),
      view.onDidDispose(() => {
        if (this.view !== view) return;
        this.view = undefined;
        this.html = undefined;
        this.stale = true;
      }),
    ];
    this.draw();
  }

  get visible(): boolean {
    return this.view?.visible === true;
  }

  get state(): SidebarState {
    return this.model.state;
  }

  get unitWord(): string {
    return this.model.unitWord;
  }

  /** The current model (it keeps up while hidden); for the integration tests. */
  get current(): SidebarModel {
    return this.model;
  }

  /** The live webview's options; for the integration tests. */
  get webviewOptions(): vscode.WebviewOptions | undefined {
    return this.view?.webview.options;
  }

  /** The HTML last assigned to the webview; for the integration tests. */
  get lastHtml(): string | undefined {
    return this.html;
  }

  update(s: Snapshot | undefined, view: ViewOptions = DEFAULT_VIEW, folders: readonly string[] = []): void {
    const next = buildSidebarModel(s, view, folders);
    if (next.signature === this.model.signature) return;
    this.model = next;
    this.stale = true;
    if (this.view && this.view.description !== next.unitWord) this.view.description = next.unitWord;
    if (!this.visible) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.visible) this.draw();
    }, this.debounceMs);
  }

  /** Assigning webview.html reloads the page, so an unchanged document is not assigned again. */
  private draw(): void {
    const v = this.view;
    if (!v) return;
    this.stale = false;
    const html = renderSidebarHtml(this.model, v.webview.cspSource);
    if (html === this.html) return;
    this.html = html;
    this.renders++;
    v.webview.html = html;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const d of this.viewSubs) d.dispose();
    for (const d of this.subs) d.dispose();
  }
}
