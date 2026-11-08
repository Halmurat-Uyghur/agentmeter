// The opt-in target-crossed alert (v0.6, owner-approved; off by default). The only place
// the extension shows a notification, and the only place it writes targetAlert: "Don't
// show again" turns the setting off in user settings. Nothing else is stored; the
// once-a-month memory lives in TargetAlertState for this window only.
import * as vscode from "vscode";
import type { Logger } from "../core/log";
import { TargetAlertState } from "../core/targetAlert";
import type { Snapshot, ViewOptions } from "../core/types";

const OPEN = "Open dashboard";
const MUTE = "Don't show again";

export class TargetAlert {
  private readonly state = new TargetAlertState();
  /** notifications shown in this window (read by the integration tests) */
  shown = 0;

  /** `log` gets an error code if the "Don't show again" write is refused (v0.7). */
  constructor(
    private readonly openDashboard: () => void,
    private readonly log?: Logger,
  ) {}

  check(s: Snapshot | undefined, view: ViewOptions): void {
    const enabled = vscode.workspace.getConfiguration("copilotUsageMonitor").get<boolean>("targetAlert") === true;
    const message = this.state.next(s, view, enabled);
    if (message === undefined) return;
    this.shown++;
    void vscode.window.showInformationMessage(message, OPEN, MUTE).then(async (pick) => {
      if (pick === OPEN) this.openDashboard();
      else if (pick === MUTE) {
        // an unwritable settings.json: log a code, show nothing more (v0.7)
        try {
          await vscode.workspace.getConfiguration("copilotUsageMonitor").update("targetAlert", false, vscode.ConfigurationTarget.Global);
        } catch {
          this.log?.error("alert.mute", "WRITE_FAILED");
        }
      }
    });
  }
}
