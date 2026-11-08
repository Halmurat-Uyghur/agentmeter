import * as path from "node:path";

export type CopilotRootSource = "setting" | "env" | "default";

export interface CopilotRoot {
  root: string;
  source: CopilotRootSource;
}

/**
 * Resolves the Copilot folder: the `copilotUsageMonitor.copilotHome` setting, then the
 * `COPILOT_HOME` environment variable, then `<homedir>/.copilot`. Blank values fall through.
 * Relative values resolve against the home folder, never the process cwd. Pure: the caller
 * passes env and homedir. A non-string setting (settings.json `"copilotHome": 42`) counts as unset.
 */
export function resolveCopilotRoot(o: {
  setting?: unknown;
  env: Record<string, string | undefined>;
  homedir: string;
}): CopilotRoot {
  const setting = typeof o.setting === "string" ? o.setting.trim() : undefined;
  if (setting) return { root: resolveAgainstHome(expandTilde(setting, o.homedir), o.homedir), source: "setting" };

  const env = o.env.COPILOT_HOME?.trim();
  if (env) return { root: resolveAgainstHome(env, o.homedir), source: "env" };

  return { root: path.join(o.homedir, ".copilot"), source: "default" };
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
