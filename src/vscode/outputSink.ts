// The Output channel only ever receives Logger lines (identifiers, integers,
// error codes); see src/core/log.ts.
import * as vscode from "vscode";
import type { LogSink } from "../core/log";

export function createOutputSink(): { sink: LogSink; channel: vscode.OutputChannel } {
  const channel = vscode.window.createOutputChannel("Copilot Usage Monitor");
  return { sink: (line) => channel.appendLine(line), channel };
}
