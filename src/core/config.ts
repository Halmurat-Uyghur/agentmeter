import * as path from "node:path";

export type RootKind = "copilot" | "claude" | "codex";

export interface ResolvedRoot {
  root: string;
  source: "setting" | "env" | "default";
}

/** Kept for existing callers: the Copilot names of the same shapes. */
export type CopilotRootSource = ResolvedRoot["source"];
export type CopilotRoot = ResolvedRoot;

/** Per kind: the environment variable consulted after the setting, then the default folder under home. */
const ROOTS: Readonly<Record<RootKind, { env: string; dir: string }>> = {
  copilot: { env: "COPILOT_HOME", dir: ".copilot" },
  claude: { env: "CLAUDE_CONFIG_DIR", dir: ".claude" },
  codex: { env: "CODEX_HOME", dir: ".codex" },
};

/**
 * Resolves a source's folder: the setting (`copilotUsageMonitor.copilotHome` / `claudeHome` /
 * `codexHome`), then the environment variable (`COPILOT_HOME` / `CLAUDE_CONFIG_DIR` /
 * `CODEX_HOME`), then `<homedir>/.copilot` / `.claude` / `.codex`. Blank values fall through.
 * Relative values resolve against the home folder, never the process cwd. Pure: the caller
 * passes env and homedir. A non-string setting (settings.json `"copilotHome": 42`) counts as unset.
 */
export function resolveRoot(
  kind: RootKind,
  o: { setting?: unknown; env: Record<string, string | undefined>; homedir: string },
): ResolvedRoot {
  const spec = ROOTS[kind];
  const setting = typeof o.setting === "string" ? o.setting.trim() : undefined;
  if (setting) return { root: resolveAgainstHome(expandTilde(setting, o.homedir), o.homedir), source: "setting" };

  const env = o.env[spec.env]?.trim();
  if (env) return { root: resolveAgainstHome(env, o.homedir), source: "env" };

  return { root: path.join(o.homedir, spec.dir), source: "default" };
}

/** The Copilot folder: `resolveRoot("copilot", o)`. */
export function resolveCopilotRoot(o: {
  setting?: unknown;
  env: Record<string, string | undefined>;
  homedir: string;
}): CopilotRoot {
  return resolveRoot("copilot", o);
}

function expandTilde(value: string, homedir: string): string {
  if (value === "~") return homedir;
  // `~\` too, so a Windows-style setting expands on win32.
  if (/^~[\\/]/.test(value)) return path.join(homedir, value.slice(2));
  return value;
}

function resolveAgainstHome(value: string, homedir: string): string {
  return path.resolve(homedir, value);
}
