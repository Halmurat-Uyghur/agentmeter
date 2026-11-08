// A minimal fake of the `vscode` module, so test/core can load src/extension.ts and
// src/vscode/* under Vitest (vitest.config.ts aliases "vscode" here; esbuild keeps
// vscode external and never reads that config, so production builds are untouched).
// Only what the extension calls is faked. Settings live in three scopes, like VS Code:
// get() reads folder, then workspace, then user; update() writes the target scope.
// Ported from review agent 7's harness (v0.7).
/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener = (e: { affectsConfiguration(section: string): boolean }) => void;
type Scope = Record<string, unknown>;

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export const state = {
  /** user (Global), workspace and folder settings, keyed "section.key" */
  global: {} as Scope,
  workspace: {} as Scope,
  folder: {} as Scope,
  /** every settings write: [key, value, target] */
  updates: [] as [string, unknown, number][],
  /** when true, update() rejects like an unwritable settings.json */
  updateReject: false,
  commands: new Map<string, (...a: any[]) => any>(),
  configListeners: [] as Listener[],
  /** Output channel lines */
  log: [] as string[],
  /** showInformationMessage calls, and the button the fake "clicks" */
  infos: [] as string[],
  infoPick: undefined as string | undefined,
  panels: 0,
};

const disp = () => ({ dispose() {} });
const scopeOf = (target: unknown): Scope => (target === ConfigurationTarget.Workspace ? state.workspace : target === ConfigurationTarget.WorkspaceFolder ? state.folder : state.global);

/** Fires onDidChangeConfiguration for `key` ("section.key"), as VS Code does after a write. */
export function fireConfigChange(key: string): void {
  const e = { affectsConfiguration: (x: string) => x === key || key.startsWith(x + ".") };
  for (const l of [...state.configListeners]) l(e);
}

export class ThemeColor {
  constructor(public id: string) {}
}
export class MarkdownString {
  isTrusted?: boolean;
  supportHtml?: boolean;
  supportThemeIcons?: boolean;
  constructor(public value = "") {}
}
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ViewColumn = { Active: -1 };
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };

export const window = {
  createOutputChannel: () => ({ appendLine: (l: string) => void state.log.push(l), dispose() {} }),
  createStatusBarItem: () => ({ show() {}, dispose() {} }),
  registerWebviewViewProvider: () => disp(),
  createWebviewPanel: () => {
    state.panels++;
    return { webview: { cspSource: "csp", html: "" }, visible: true, active: false, title: "t", onDidChangeViewState: disp, onDidDispose: disp, reveal() {}, dispose() {} };
  },
  showQuickPick: async () => undefined,
  showInformationMessage: async (message: string) => {
    state.infos.push(message);
    return state.infoPick;
  },
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: (section: string) => ({
    get: (k: string) => {
      const key = `${section}.${k}`;
      for (const s of [state.folder, state.workspace, state.global]) if (s[key] !== undefined) return s[key];
      return undefined;
    },
    inspect: (k: string) => {
      const key = `${section}.${k}`;
      return { key, globalValue: state.global[key], workspaceValue: state.workspace[key], workspaceFolderValue: state.folder[key] };
    },
    update: async (k: string, v: unknown, target?: unknown) => {
      if (state.updateReject) throw new Error("settings.json not writable");
      const key = `${section}.${k}`;
      state.updates.push([k, v, Number(target ?? ConfigurationTarget.Workspace)]);
      scopeOf(target ?? ConfigurationTarget.Workspace)[key] = v;
      fireConfigChange(key);
    },
  }),
  onDidChangeWorkspaceFolders: () => disp(),
  onDidChangeConfiguration: (l: Listener) => {
    state.configListeners.push(l);
    return disp();
  },
};

export const commands = {
  registerCommand: (id: string, fn: (...a: any[]) => any) => {
    state.commands.set(id, fn);
    return disp();
  },
};
