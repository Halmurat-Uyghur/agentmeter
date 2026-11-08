import * as vscode from "vscode";
import { DEFAULT_VIEW } from "../core/format";
import { DEFAULT_SECTION, PANEL_COMMANDS, renderPanelHtml, type SectionId } from "../core/panelHtml";
import { FOCUSED_REDRAW_MS, RedrawThrottle } from "../core/redrawThrottle";
import type { Snapshot, ViewOptions } from "../core/types";

/** The details webview: scripts off, no local resources, command links limited
 * to PANEL_COMMANDS (month, unit, filter, section, session calls and the nav toggle), re-rendered per snapshot.
 * The selected section is held here for the VS Code session only (D30): never
 * persisted and not part of ViewOptions. Whether the section nav is collapsed to an icon
 * rail is set by the extension (which remembers it across sessions) and drawn at once.
 *
 * Redraws (A11y C1): while the panel is the active editor, a new snapshot redraws it
 * at most once per FOCUSED_REDRAW_MS (trailing), so keyboard and screen-reader users
 * are not sent back to the top after every model call. A section, month, filter or
 * unit change redraws at once, and anything held back is drawn as soon as the panel
 * loses focus or becomes visible again. */
export class DetailsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private last: Snapshot | undefined;
  private view: ViewOptions = DEFAULT_VIEW;
  private html: string | undefined;
  private current: SectionId = DEFAULT_SECTION;
  private collapsed = false;
  private readonly throttle: RedrawThrottle;
  /** webview.html assignments, for the integration tests */
  renders = 0;

  constructor(intervalMs = FOCUSED_REDRAW_MS) {
    this.throttle = new RedrawThrottle(() => this.draw(), intervalMs);
  }

  get section(): SectionId {
    return this.current;
  }

  /** Reveals the panel (creating it if needed); with `section`, switches to it first. */
  show(section?: SectionId): void {
    if (section !== undefined) this.current = section;
    if (this.panel) {
      this.render(true);
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "copilotUsageMonitor.details",
      "Copilot Usage (Local)",
      vscode.ViewColumn.Active,
      { enableScripts: false, enableForms: false, enableCommandUris: PANEL_COMMANDS, localResourceRoots: [], retainContextWhenHidden: false },
    );
    this.html = undefined;
    this.throttle.reset();
    const panel = this.panel;
    let wasVisible = panel.visible;
    panel.onDidChangeViewState(() => {
      // Lost focus, or shown again after being hidden: draw what was held back.
      if (!panel.active || (panel.visible && !wasVisible)) this.throttle.release();
      wasVisible = panel.visible;
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.html = undefined;
      this.throttle.reset();
    });
    this.render(true);
  }

  get navCollapsed(): boolean {
    return this.collapsed;
  }

  /** Collapses (true) or expands (false) the section nav; a change is drawn at once. */
  setNavCollapsed(collapsed: boolean): void {
    if (collapsed === this.collapsed) return;
    this.collapsed = collapsed;
    this.render(true);
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  get title(): string | undefined {
    return this.panel?.title;
  }

  /** The panel is the active editor; for the integration tests. */
  get active(): boolean {
    return this.panel?.active === true;
  }

  /** A redraw is held back by the focus throttle; for the integration tests. */
  get held(): boolean {
    return this.throttle.pending;
  }

  update(s: Snapshot | undefined, view: ViewOptions = this.view): void {
    this.last = s;
    this.view = view;
    this.render();
  }

  /** What the user chose: a change here is drawn at once, never held back. */
  private key(): string {
    const s = this.last;
    return JSON.stringify([this.current, this.collapsed, this.view, s === undefined, s?.month?.monthStartMs, s?.month?.isCurrent, s?.filter ?? null, s?.health.state, s?.month?.detail?.sessionId ?? null]);
  }

  /** `now`: a user action (show, a section switch) that must not wait for the throttle. */
  private render(now = false): void {
    if (!this.panel) return;
    if (now) this.throttle.drawNow(this.key());
    else this.throttle.request(this.key(), this.panel.active);
  }

  /** Assigning webview.html reloads the page (scroll, focus and open folds are lost),
   * so an unchanged document is not assigned again. */
  private draw(): boolean {
    if (!this.panel) return false;
    const html = renderPanelHtml(this.last, this.panel.webview.cspSource, this.view, this.current, this.collapsed);
    if (html === this.html) return false;
    this.html = html;
    this.renders++;
    this.panel.webview.html = html;
    return true;
  }

  dispose(): void {
    this.throttle.dispose();
    this.panel?.dispose();
  }
}
