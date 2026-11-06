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
 * passes env and homedir.
 */
export function resolveCopilotRoot(o: {
  setting?: string;
  env: Record<string, string | undefined>;
  homedir: string;
}): CopilotRoot {
  const setting = o.setting?.trim();
  if (setting) return { root: resolveAgainstHome(expandTilde(setting, o.homedir), o.homedir), source: "setting" };

  const env = o.env.COPILOT_HOME?.trim();
  if (env) return { root: resolveAgainstHome(env, o.homedir), source: "env" };

  return { root: path.join(o.homedir, ".copilot"), source: "default" };
}

function expandTilde(value: string, homedir: string): string {
  if (value === "~") return homedir;
  if (value.startsWith("~/")) return path.join(homedir, value.slice(2));
  return value;
}

function resolveAgainstHome(value: string, homedir: string): string {
  return path.resolve(homedir, value);
}
