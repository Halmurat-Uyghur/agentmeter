// Privacy and packaging gates (plan §2, Task 9). These scan the source tree
// and the built bundle; they fail the build if a network, persistence or
// telemetry API appears anywhere.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LOCAL_BANNER } from "../../src/core/format";
import { PANEL_COMMANDS } from "../../src/core/panelHtml";
import { SIDEBAR_COMMANDS } from "../../src/core/sidebarModel";

const ROOT = join(__dirname, "..", "..");
/** The logo: the extension icon, the panel tab icon and the activity-bar icon (drawn by tools/logo). */
const ICON_MEDIA = ["media/icon.png", "media/icon.svg", "media/activity.svg"];
/** The getting-started walkthrough's media (v0.6, 2.4): the only other files besides the four core ones and the icons in the .vsix. */
const WALKTHROUGH_MEDIA = ["media/walkthrough/folder.md", "media/walkthrough/unit.md", "media/walkthrough/target.md", "media/walkthrough/open.md"];
const RATE_FILE = join(ROOT, "src", "vscode", "exchangeRate.ts");

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue; // tools/logo is its own package (Remotion, dev only)
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

const NET_MODULES = /(?:from\s*|require\(\s*|import\(\s*)["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster)["']/;
const TOKENS = [
  "process.binding", "fetch(", "XMLHttpRequest", "WebSocket", "createTelemetryLogger",
  "openExternal", "asExternalUri", "globalState", "workspaceState", "secrets",
  "writeFile", "appendFile", "createWriteStream", "console.",
  "mkdir", "rename(", "copyFile", "rmSync", "unlink", "storageUri", "globalStorageUri", "logUri",
  "enableScripts: true", "eval(", "new Function", "clipboard",
  // D31 side bar and D33 status bar (F4 V1–V3): no trusted Markdown, no paths from log data.
  "isTrusted = true", "isTrusted: true", "enabledCommands", "supportHtml = true", "supportHtml: true",
  "resourceUri", "registerWebviewViewProvider",
];
const DYNAMIC_REQUIRE = /\brequire\(\s*(?!["'])/;

/** A1: the side bar is the one webview view; `registerWebviewViewProvider` may appear
 * once, in src/vscode/sidebar.ts (and so once in the bundle), nowhere else. */
const WEBVIEW_VIEW = "registerWebviewViewProvider";
const SIDEBAR_SRC = join("src", "vscode", "sidebar.ts");

function offences(source: string, allowWebviewView = false): string[] {
  const found: string[] = [];
  if (NET_MODULES.test(source)) found.push(`network module: ${NET_MODULES.exec(source)![0]}`);
  for (const t of TOKENS) if (source.includes(t)) found.push(t);
  if (allowWebviewView && source.split(WEBVIEW_VIEW).length === 2) found.splice(found.indexOf(WEBVIEW_VIEW), 1);
  if (DYNAMIC_REQUIRE.test(source)) found.push("dynamic require");
  return found;
}

/**
 * Source text with every line and block comment removed; string, template and regex
 * literals are kept as they are. A small lexer, good enough for this repo's own
 * TypeScript: a `/` starts a regex literal when the previous significant character
 * cannot end an expression.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let prev = ""; // last significant character emitted, for the regex-or-divide decision
  const stack: number[] = []; // brace depth at each open `${` of a template literal
  let braces = 0;
  /** Copy a template literal body from i (just after "`" or "}"), up to its end or the next "${". */
  const template = () => {
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        out += c;
        i++;
        prev = "`";
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        stack.push(braces);
        braces++;
        prev = "{";
        return;
      } else {
        out += c;
        i++;
      }
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++;
      out += src.slice(start, i);
      prev = c;
      continue;
    }
    if (c === "`") {
      out += c;
      i++;
      template();
      continue;
    }
    if (c === "}" && stack.length > 0 && stack[stack.length - 1] === braces - 1) {
      stack.pop();
      braces--;
      out += c;
      i++;
      template();
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|in|of)$/.test(out.trimEnd()))) {
      const start = i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/.test(src[i]!)) i++;
      out += src.slice(start, i);
      prev = "/";
      continue;
    }
    if (c === "{") braces++;
    else if (c === "}") braces--;
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const coreSrc = (f: string) => readFileSync(join(ROOT, "src", "core", f), "utf8");

/** The value of `const NAME = <int expression>;` (digits, `_`, `*`, `+`) in the given sources, or undefined. */
function declaredInt(name: string, sources: string[]): number | undefined {
  for (const s of sources) {
    const m = new RegExp(`\\bconst ${name}\\s*(?::\\s*number\\s*)?=\\s*([0-9_ *+]+);`).exec(s);
    if (!m) continue;
    const expr = m[1]!.replace(/_/g, "").trim();
    return expr.split("+").reduce((sum, term) => sum + term.split("*").reduce((p, f) => p * Number(f.trim()), 1), 0);
  }
  return undefined;
}

/** Each call `name(` in source with its top-level arguments as trimmed text. */
function callArgs(source: string, name: string): string[][] {
  const calls: string[][] = [];
  const re = new RegExp(`(?<![\\w.$])${name}\\(`, "g");
  for (const m of source.matchAll(re)) {
    let i = m.index! + m[0].length;
    let depth = 0;
    let cur = "";
    const args: string[] = [];
    for (; i < source.length; i++) {
      const c = source[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) {
        args.push(cur.trim());
        cur = "";
        continue;
      }
      cur += c;
    }
    if (cur.trim() !== "") args.push(cur.trim());
    calls.push(args);
  }
  return calls;
}

// D22: estimated USD is allowed (labelled "est."); account-statement words stay banned.
const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;

describe("gates", () => {
  beforeAll(() => {
    execFileSync("node", ["esbuild.mjs"], { cwd: ROOT, stdio: "ignore" });
  });

  it("forbidden APIs: none in src/", () => {
    for (const f of files(join(ROOT, "src"), /\.ts$/)) {
      expect(offences(readFileSync(f, "utf8"), f.endsWith(SIDEBAR_SRC)), f).toEqual(f === RATE_FILE ? ["fetch("] : []);
    }
    expect(readFileSync(join(ROOT, SIDEBAR_SRC), "utf8").split(WEBVIEW_VIEW)).toHaveLength(2);
  });

  it("the exchange-rate file calls fetch once, only on the pinned rate URL", () => {
    const src = readFileSync(RATE_FILE, "utf8");
    expect(src.split("fetch(").length - 1).toBe(1);
    expect(src).toContain("fetch(`${RATE_URL}?base=USD&symbols=${code}`");
    expect(src.match(/https?:\/\/[^\s"'`]+/g)).toEqual(["https://api.frankfurter.dev/v1/latest"]);
  });

  it("forbidden APIs: none in the bundle beyond the one rate fetch", () => {
    const bundle = readFileSync(join(ROOT, "dist", "extension.js"), "utf8");
    expect(offences(bundle, true)).toEqual(["fetch("]);
    expect(bundle.split("fetch(").length - 1).toBe(1);
    expect(bundle.match(/https?:\/\/[a-z0-9.-]+/gi)?.filter((u) => !u.includes("github.com"))).toEqual(["https://api.frankfurter.dev"]);
    expect(bundle.split(WEBVIEW_VIEW)).toHaveLength(2);
  });

  it("gate patterns actually match (self-test)", () => {
    expect(offences('import * as h from "node:https";')).toHaveLength(1);
    expect(offences("const x = require(name);")).toContain("dynamic require");
    expect(offences("fs.promises.writeFile(p, d)")).toContain("writeFile");
    expect(offences("md.isTrusted = true;")).toContain("isTrusted = true");
    expect(offences("item.resourceUri = u;")).toContain("resourceUri");
    expect(offences("vscode.window.registerWebviewViewProvider(id, p);")).toContain(WEBVIEW_VIEW);
    expect(offences("registerWebviewViewProvider(a); registerWebviewViewProvider(b);", true)).toContain(WEBVIEW_VIEW);
    expect(offences("vscode.window.registerWebviewViewProvider(id, p);", true)).toEqual([]);
  });

  it("no hardcoded home folder", () => {
    for (const dir of ["src", "test", "tools"]) {
      for (const f of files(join(ROOT, dir), /\.(ts|mjs|js)$/)) {
        const s = readFileSync(f, "utf8");
        const homes = ["Users", "home"].map((h) => `/${h}/`);
        expect(homes.some((h) => s.includes(h)), f).toBe(false);
      }
    }
  });

  it("README copy check", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const section = /## What this is not\n([\s\S]*?)(\n## |$)/.exec(readme);
    expect(section, "What this is not section").not.toBeNull();
    expect(section![1]).toContain(LOCAL_BANNER);
    const rest = readme.replace(section![0], "\n## ").replace(LOCAL_BANNER, "");
    const lines = rest.split("\n").filter((l) => COPY_RE.test(l));
    expect(lines).toEqual([]);
  });

  it("manifest copy check: description, commands, settings and side bar text", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const c = pkg.contributes;
    type Cmd = { title: string; shortTitle?: string; category?: string };
    const strings: string[] = [pkg.displayName, pkg.description,
      ...c.commands.flatMap((x: Cmd) => [x.title, x.shortTitle ?? "", x.category ?? ""]),
      ...Object.values(c.configuration.properties).map((p) => (p as { description: string }).description),
      ...c.viewsContainers.activitybar.map((x: { title: string }) => x.title),
      ...Object.values(c.views).flat().flatMap((v) => [(v as { name: string }).name, (v as { contextualTitle?: string }).contextualTitle ?? ""])];
    expect(strings.length).toBeGreaterThan(20);
    for (const t of strings) expect(t).not.toMatch(COPY_RE);
  });

  it("manifest: side bar container, webview view and title actions (D31, A1)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const c = pkg.contributes;
    // The logo's one-colour SVG (media/activity.svg); the .vsix adds it with the other icons and the walkthrough markdown.
    expect(c.viewsContainers.activitybar).toEqual([{ id: "copilotUsageMonitor", title: "AgentMeter (Local)", icon: "media/activity.svg" }]);
    expect(pkg.icon).toBe("media/icon.png");
    expect(c.views.copilotUsageMonitor.map((v: { id: string; name: string; type?: string }) => [v.id, v.name, v.type])).toEqual([["copilotUsageMonitor.summary", "Summary", "webview"]]);
    // Welcome content and item menus work for trees only; the webview shows its states in-page (A1).
    expect(c.viewsWelcome).toBeUndefined();
    expect(c.menus["view/item/context"]).toBeUndefined();
    // Title bar: Open panel, Switch unit, Refresh as icon buttons.
    const nav = c.menus["view/title"].filter((x: { group: string }) => x.group.startsWith("navigation")).map((x: { command: string }) => x.command);
    expect(nav).toEqual(["copilotUsageMonitor.showDetails", "copilotUsageMonitor.toggleUnit", "copilotUsageMonitor.refresh"]);
    for (const m of c.menus["view/title"]) expect(m.when).toBe("view == copilotUsageMonitor.summary");
    for (const id of nav) {
      const cmd = c.commands.find((x: { command: string }) => x.command === id);
      expect(cmd.icon, id).toMatch(/^\$\([a-z-]+\)$/);
      expect(cmd.category).toBe("AgentMeter");
    }
    // Palette text stays "AgentMeter: …": every command has the category and no prefix in its title.
    for (const cmd of c.commands) {
      expect(cmd.category).toBe("AgentMeter");
      expect(cmd.title).not.toMatch(/^AgentMeter:/);
    }
  });

  it("every contributed command is registered, and every registered command is contributed", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const contributed = new Set<string>(pkg.contributes.commands.map((x: { command: string }) => x.command));
    const ext = readFileSync(join(ROOT, "src", "extension.ts"), "utf8");
    const registered = new Set([...ext.matchAll(/registerCommand\("([^"]+)"/g)].map((x) => x[1]!).filter((x) => x !== "copilotUsageMonitor._testState"));
    expect(registered).toEqual(contributed);
    for (const menu of Object.values(pkg.contributes.menus) as { command: string }[][])
      for (const item of menu) expect(contributed.has(item.command), item.command).toBe(true);
  });

  it("every MarkdownString is untrusted, with HTML off", () => {
    let made = 0;
    let untrusted = 0;
    for (const f of files(join(ROOT, "src"), /\.ts$/)) {
      const src = readFileSync(f, "utf8");
      made += src.split("new vscode.MarkdownString(").length - 1;
      untrusted += src.split(".isTrusted = false;").length - 1;
      expect(src.split(".supportHtml = false;").length - 1).toBe(src.split("new vscode.MarkdownString(").length - 1);
    }
    expect(made).toBeGreaterThan(0);
    expect(untrusted).toBe(made);
  });

  it("manifest: no runtime dependencies, machine-scoped folder setting, MIT", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({});
    expect(pkg.license).toBe("MIT");
    expect(pkg.contributes.configuration.properties["copilotUsageMonitor.copilotHome"].scope).toBe("machine");
    expect(pkg.activationEvents).toEqual(["onStartupFinished"]);
  });

  it("manifest: the session totals setting is a machine-scoped boolean, on by default (D29)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const p = pkg.contributes.configuration.properties["copilotUsageMonitor.sessionTotals"];
    expect(p).toMatchObject({ type: "boolean", default: true, scope: "machine" });
    const ext = readFileSync(join(ROOT, "src", "extension.ts"), "utf8");
    expect(ext).toContain('"sessionTotals"');
    expect(ext).toContain("readTotals");
  });

  it("manifest: the status bar content setting is today | month | session, default today (v0.6, 2.5)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const p = pkg.contributes.configuration.properties["copilotUsageMonitor.statusBar"];
    expect(p).toMatchObject({ type: "string", enum: ["today", "month", "session"], default: "today" });
    expect(p.enumDescriptions).toHaveLength(3);
    for (const t of p.enumDescriptions) expect(t).not.toMatch(COPY_RE);
  });

  it("notifications: only the opt-in target alert, one call in src/vscode/targetAlert.ts (v0.6)", () => {
    const ALERT = join("src", "vscode", "targetAlert.ts");
    const NOTIFY = /\b(showInformationMessage|showWarningMessage|showErrorMessage)\b/g;
    for (const f of files(join(ROOT, "src"), /\.ts$/)) {
      const hits = readFileSync(f, "utf8").match(NOTIFY) ?? [];
      expect(hits, f).toEqual(f.endsWith(ALERT) ? ["showInformationMessage"] : []);
    }
    const bundle = readFileSync(join(ROOT, "dist", "extension.js"), "utf8");
    expect(bundle.match(NOTIFY)).toEqual(["showInformationMessage"]);
    const src = readFileSync(join(ROOT, ALERT), "utf8");
    // off unless the user set it to true; the actions are exactly these two
    expect(src).toContain('get<boolean>("targetAlert") === true');
    expect(src).toContain("showInformationMessage(message, OPEN, MUTE)");
    expect(src).toContain('const OPEN = "Open dashboard";');
    expect(src).toContain('const MUTE = "Don\'t show again";');
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    // review fix 4: user settings only, so a workspace cannot turn it back on over "Don't show again" (written Global)
    expect(pkg.contributes.configuration.properties["copilotUsageMonitor.targetAlert"]).toMatchObject({ type: "boolean", default: false, scope: "application" });
  });

  it("settings writes: one helper in extension.ts over the closed SettingKey list, retried once and never rolled back (v0.9, D1–D3); targetAlert (to false) also from the alert", () => {
    const EXT = join("src", "extension.ts");
    const ALERT = join("src", "vscode", "targetAlert.ts");
    for (const f of files(join(ROOT, "src"), /\.ts$/)) {
      const src = readFileSync(f, "utf8");
      const rel = f.slice(ROOT.length + 1);
      // a config update with a variable key right on getConfiguration() is refused outright
      expect(src.match(/getConfiguration\([^)]*\)\s*\.update\(\s*[^"\s]/g), rel).toBeNull();
      // every `.update(` that is not a view's (panel, status bar, side bar) is a settings write
      const updates = [...src.matchAll(/(\w+|\))\.update\(\s*([^,)]+)/g)].filter((x) => !/^(panel|status|sidebar|this)$/.test(x[1]!)).map((x) => x[2]!.trim());
      // the helper's one call (its key is typed SettingKey), and the alert's literal "Don't show again" write
      if (rel === EXT) expect(updates).toEqual(["key"]);
      else if (rel === ALERT) expect(updates).toEqual(['"targetAlert"']);
      else expect(updates, rel).toEqual([]);
    }
    const ext = readFileSync(join(ROOT, EXT), "utf8");
    const keys = /type SettingKey = ([^;]+);/.exec(ext)![1]!.split("|").map((k) => k.trim().replace(/^"|"$/g, ""));
    expect(keys).toEqual(["display", "currency", "palette", "panelNavCollapsed", "statusBar", "targetAlert", "dailyTargetMax", "weeklyTargetMax", "monthlyTargetMin", "monthlyTargetMax"]);
    expect(ext).toContain("const updateSetting = async (key: SettingKey, value: unknown, target: vscode.ConfigurationTarget, where: string): Promise<boolean> =>");
    expect(ext).toContain("await c.update(key, value, target);");
    expect(ext).toContain("const SAVE_RETRY_MS = 1500;");
    // every write goes through the helper with a literal key or the validated `key` of setTarget
    const calls = [...ext.matchAll(/\bupdateSetting\(\s*([^,]+),/g)].map((x) => x[1]!.trim());
    expect(calls.sort()).toEqual(['"currency"', '"display"', '"palette"', '"panelNavCollapsed"', '"statusBar"', '"targetAlert"', "key"].sort());
    expect(ext).toContain("const key = d.setting as SettingKey;");
    // the Settings section's keys are the manifest's
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    for (const k of keys) expect(pkg.contributes.configuration.properties[`copilotUsageMonitor.${k}`], k).toBeDefined();
    expect(readFileSync(join(ROOT, ALERT), "utf8")).toContain('.update("targetAlert", false, vscode.ConfigurationTarget.Global)');
  });

  it("the panel allows exactly twelve commands, wired as the webview's allowlist (D30; showSession v0.6; toggleNav; selectPalette v0.8; Settings v0.9)", () => {
    expect([...PANEL_COMMANDS]).toEqual([
      "copilotUsageMonitor.selectMonth",
      "copilotUsageMonitor.setUnit",
      "copilotUsageMonitor.setFilter",
      "copilotUsageMonitor.showSection",
      "copilotUsageMonitor.showSession",
      "copilotUsageMonitor.toggleNav",
      "copilotUsageMonitor.selectPalette",
      "copilotUsageMonitor.selectCurrency",
      "copilotUsageMonitor.setStatusBar",
      "copilotUsageMonitor.setTarget",
      "copilotUsageMonitor.setTargetAlert",
      "copilotUsageMonitor.openVsCodeSettings",
    ]);
    const panel = readFileSync(join(ROOT, "src", "vscode", "panel.ts"), "utf8");
    expect(panel).toContain("enableScripts: false, enableForms: false, enableCommandUris: PANEL_COMMANDS, localResourceRoots: []");
    expect(panel).not.toMatch(/enableCommandUris:\s*true/);
  });

  it("showSession (v0.6): validated by shape, hidden from the palette, not a side bar command, held in memory only", () => {
    const ext = readFileSync(join(ROOT, "src", "extension.ts"), "utf8");
    const handler = /const showSession = \(arg\?: unknown\) => \{([\s\S]*?)\n  \};/.exec(ext);
    expect(handler, "showSession handler").not.toBeNull();
    // Only "" (close) or an id that passes isSessionId reaches the monitor; nothing is written.
    expect(handler![1]).toContain('if (arg === "") session = undefined;');
    expect(handler![1]).toContain("else if (isSessionId(arg)) session = arg;");
    expect(handler![1]).toContain("else return;");
    expect(handler![1]).not.toMatch(/update\(|globalState|workspaceState|getConfiguration/);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: "copilotUsageMonitor.showSession", when: "false" });
    expect([...SIDEBAR_COMMANDS]).not.toContain("copilotUsageMonitor.showSession");
  });

  it("the side bar is a no-script webview view: exactly SIDEBAR_COMMANDS, no local resources (A1)", () => {
    expect([...SIDEBAR_COMMANDS]).toEqual([
      "copilotUsageMonitor.showDetails",
      "copilotUsageMonitor.showSection",
      "copilotUsageMonitor.setFilter",
      "copilotUsageMonitor.toggleUnit",
      "copilotUsageMonitor.selectCurrency",
    ]);
    const src = readFileSync(join(ROOT, SIDEBAR_SRC), "utf8");
    expect(src).toContain("{ enableScripts: false, enableForms: false, enableCommandUris: SIDEBAR_COMMANDS, localResourceRoots: [] }");
    expect(src).toContain("view.webview.options = SIDEBAR_WEBVIEW_OPTIONS;");
    expect(src.split("webview.options =")).toHaveLength(2);
    expect(src).not.toMatch(/enableCommandUris:\s*true|enableScripts:\s*true|retainContextWhenHidden|asWebviewUri|postMessage|onDidReceiveMessage/);
    // only the panel and the side bar make webviews
    for (const f of files(join(ROOT, "src"), /\.ts$/)) {
      const t = readFileSync(f, "utf8");
      if (t.includes("createWebviewPanel")) expect(f.endsWith(join("vscode", "panel.ts")), f).toBe(true);
      if (t.includes("webview.options")) expect(f.endsWith(SIDEBAR_SRC), f).toBe(true);
    }
  });

  it(".vsix holds exactly package.json, README.md, LICENSE, the bundle, the three icon files and the walkthrough's four markdown files", () => {
    const bin = join(ROOT, "node_modules", ".bin", "vsce");
    expect(existsSync(bin)).toBe(true);
    const out = execFileSync(bin, ["ls", "--no-dependencies"], { cwd: ROOT, encoding: "utf8" });
    const paths = out.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+(\/[\w.-]+)*$/.test(l));
    expect(new Set(paths)).toEqual(new Set(["package.json", "README.md", "LICENSE", "dist/extension.js", ...ICON_MEDIA, ...WALKTHROUGH_MEDIA]));
    // .vscodeignore stays an exact allowlist: ignore everything, then name each file (no globs)
    const ignore = readFileSync(join(ROOT, ".vscodeignore"), "utf8").trim().split("\n");
    expect(ignore).toEqual(["**", "!dist/extension.js", "!package.json", "!README.md", "!LICENSE", ...ICON_MEDIA.map((f) => `!${f}`), ...WALKTHROUGH_MEDIA.map((f) => `!${f}`)]);
  }, 30_000);

  it("manifest scopes (v0.7): folder, project names and session totals per machine; currency and alert per user", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const scope = (k: string) => pkg.contributes.configuration.properties[`copilotUsageMonitor.${k}`].scope;
    for (const k of ["copilotHome", "projectNames", "sessionTotals", "claudeCode", "codex", "claudeHome", "codexHome"]) expect(scope(k), k).toBe("machine");
    // application: a workspace's settings can neither turn on the rate request nor the alert; the
    // palette and the nav state are the user's look, written Global by their commands (v0.8)
    for (const k of ["currency", "targetAlert", "palette", "panelNavCollapsed"]) expect(scope(k), k).toBe("application");
  });

  it("manifest (v0.8): the palette setting, its command and the side bar menu entry", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const p = pkg.contributes.configuration.properties["copilotUsageMonitor.palette"];
    expect(p).toMatchObject({ type: "string", default: "theme", scope: "application" });
    expect(p.enum[0]).toBe("theme");
    expect(p.enumDescriptions).toHaveLength(p.enum.length);
    for (const t of [p.description, ...p.enumDescriptions]) expect(t).not.toMatch(COPY_RE);
    expect(pkg.contributes.commands).toContainEqual({ command: "copilotUsageMonitor.selectPalette", title: "Choose Colours…", category: "AgentMeter", icon: "$(symbol-color)" });
    expect(pkg.contributes.menus["view/title"]).toContainEqual({ command: "copilotUsageMonitor.selectPalette", when: "view == copilotUsageMonitor.summary", group: "1_view@5" });
    // the handler writes the user settings only, after validating the id against the closed list
    const ext = readFileSync(join(ROOT, "src", "extension.ts"), "utf8");
    const handler = /const selectPalette = async \(arg\?: unknown\) => \{([\s\S]*?)\n  \};/.exec(ext);
    expect(handler, "selectPalette handler").not.toBeNull();
    expect(handler![1]).toContain("else if (isPaletteId(arg)) id = arg;");
    expect(handler![1]).toContain("else return;");
    // drawn first, then saved through the helper; no rollback on a refused save (v0.9, D1)
    expect(handler![1]).toContain("panel.setPalette(id);");
    expect(handler![1]).toContain('await updateSetting("palette", id, vscode.ConfigurationTarget.Global, "palette.write");');
    expect(handler![1]).not.toContain("readPalette()");
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("`copilotUsageMonitor.palette`");
    expect(readme).toContain("the panel allows exactly twelve commands");
  });

  it("manifest (v0.8, D48): Claude Code and Codex settings are machine-scoped, sources on, folders empty", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const props = pkg.contributes.configuration.properties;
    for (const k of ["claudeCode", "codex"]) expect(props[`copilotUsageMonitor.${k}`], k).toMatchObject({ type: "boolean", default: true, scope: "machine" });
    for (const k of ["claudeHome", "codexHome"]) expect(props[`copilotUsageMonitor.${k}`], k).toMatchObject({ type: "string", default: "", scope: "machine" });
    expect(props["copilotUsageMonitor.claudeHome"].description).toContain("CLAUDE_CONFIG_DIR");
    expect(props["copilotUsageMonitor.codexHome"].description).toContain("CODEX_HOME");
    for (const k of ["claudeCode", "codex"]) expect(props[`copilotUsageMonitor.${k}`].description, k).toContain("never decoded");
    expect(pkg.keywords).toEqual(expect.arrayContaining(["claude", "codex"]));
    expect(pkg.description).toContain("Not affiliated with, endorsed by or supported by GitHub, Microsoft, Anthropic or OpenAI.");
    const folder = readFileSync(join(ROOT, "media", "walkthrough", "folder.md"), "utf8");
    expect(folder).toContain("`copilotUsageMonitor.claudeHome`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`");
    expect(folder).toContain("`copilotUsageMonitor.codexHome`, else `CODEX_HOME`, else `~/.codex`");
  });

  it("the rate reply is size-capped before parsing (v0.7)", () => {
    const src = readFileSync(RATE_FILE, "utf8");
    expect(src).toMatch(/export const MAX_RATE_BYTES = \d+;/);
    expect(src).toContain('res.headers.get("content-length")');
    expect(src).toContain("text.length > MAX_RATE_BYTES");
    expect(src).not.toContain("res.json()");
  });

  it("the tailer opens logs without following links or blocking on FIFOs (v0.7)", () => {
    const src = readFileSync(join(ROOT, "src", "core", "tailer.ts"), "utf8");
    expect(src).toContain("O_NOFOLLOW");
    expect(src).toContain("O_NONBLOCK");
  });

  it("packaging always rebuilds the bundle first (v0.7)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["vscode:prepublish"]).toBe("npm run build");
    expect(pkg.scripts.build).toBe("node esbuild.mjs");
  });

  it("README and walkthrough facts track the code (v0.7)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain(`agentmeter-${pkg.version}.vsix`);
    expect(SIDEBAR_COMMANDS).toHaveLength(5);
    expect(readme).toContain("only five command links (open the panel, show a section, set the project filter, switch the unit, choose the currency)");
    expect(readFileSync(join(ROOT, "media", "walkthrough", "folder.md"), "utf8")).toContain("the folder in `copilotUsageMonitor.copilotHome`, else `COPILOT_HOME`, else `~/.copilot`");
    expect(readFileSync(join(ROOT, ".github", "ISSUE_TEMPLATE", "bug_report.md"), "utf8")).toContain(`e.g. ${pkg.version}`);
  });

  it("walkthrough (v0.6, 2.4): four steps, markdown media only, allowlisted command links, no URLs, copy rules", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const w = pkg.contributes.walkthroughs;
    expect(w).toHaveLength(1);
    type Step = { id: string; title: string; description: string; media: Record<string, string> };
    const steps: Step[] = w[0].steps;
    expect(steps.map((x) => x.id)).toEqual(["folder", "unit", "target", "open"]);
    expect(steps.map((x) => x.media)).toEqual(WALKTHROUGH_MEDIA.map((markdown) => ({ markdown })));
    const links = steps.flatMap((x) => [...x.description.matchAll(/\]\(([^)]*)\)/g)].map((y) => y[1]));
    expect(links).toEqual([
      "command:workbench.action.openSettings?%5B%22copilotUsageMonitor.copilotHome%22%5D",
      "command:copilotUsageMonitor.toggleUnit",
      "command:copilotUsageMonitor.selectCurrency",
      "command:workbench.action.openSettings?%5B%22copilotUsageMonitor.monthlyTarget%22%5D",
      "command:workbench.view.extension.copilotUsageMonitor",
      "command:copilotUsageMonitor.showDetails",
    ]);
    const texts = [w[0].title, w[0].description, ...steps.flatMap((x) => [x.title, x.description.replace(/\]\([^)]*\)/g, "]")])];
    for (const f of WALKTHROUGH_MEDIA) {
      const md = readFileSync(join(ROOT, f), "utf8");
      expect(md.length, f).toBeLessThan(2048);
      // static text: no links, images, HTML or URLs
      expect(md, f).not.toMatch(/\]\(|<[a-z!/]|https?:|command:/i);
      texts.push(md);
    }
    for (const t of texts) expect(t).not.toMatch(COPY_RE);
  });

  // Task 12 (D41, D50, D53): the new sources' privacy gates.
  it("JSON.parse( appears once in src/core/jsonScan.ts (in parseSlice, bound checked first) and never in the Claude Code or Codex reader (D41)", () => {
    const count = (f: string) => readFileSync(join(ROOT, "src", "core", f), "utf8").split("JSON.parse(").length - 1;
    expect(count("jsonScan.ts")).toBe(1);
    expect(count("claude.ts")).toBe(0);
    expect(count("codex.ts")).toBe(0);
    const scan = readFileSync(join(ROOT, "src", "core", "jsonScan.ts"), "utf8");
    const fn = /export function parseSlice\(buf: Buffer, r: SliceRange, maxBytes: number = MAX_SLICE_BYTES\): unknown \{([\s\S]*?)\n\}/.exec(scan);
    expect(fn, "parseSlice").not.toBeNull();
    const body = fn![1]!;
    // fail-closed (a NaN maxBytes refuses), and before the one parse
    const bound = body.indexOf("if (!(r.end - r.start <= maxBytes)) return undefined;");
    expect(bound).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("JSON.parse(")).toBeGreaterThan(bound);
  });

  it("the comment stripper keeps code and literals and drops only comments (self-test)", () => {
    const src = [
      'const a = "// not a comment"; // gone-1',
      "const b = 'it''s'; /* gone-2 */ const c = `x ${\"y\" /* gone-3 */} // kept-t`;",
      "const r = /\\/\\/ kept-r/g; const d = 4 / 2; // gone-4",
      "/** gone-5",
      " * auth.json */",
      "const e = { f: `${`${1}`}` }; // gone-6",
    ].join("\n");
    const out = stripComments(src);
    for (const k of ["gone-1", "gone-2", "gone-3", "gone-4", "gone-5", "gone-6", "auth.json"]) expect(out, k).not.toContain(k);
    for (const k of ['"// not a comment"', "// kept-t", "/\\/\\/ kept-r/g", "4 / 2", "const e = { f: `${`${1}`}` };"]) expect(out, k).toContain(k);
  });

  it("the Claude Code and Codex readers never decode a line whole: no JSON., toString(, TextDecoder or text-decode argument (D41, D53)", () => {
    for (const f of ["claude.ts", "codex.ts"]) {
      const src = stripComments(coreSrc(f));
      expect(src.length, f).toBeGreaterThan(1000);
      expect(src.match(/\bJSON\s*[.[]/g), f).toBeNull();
      expect(src.includes("toString("), f).toBe(false);
      expect(src.includes("TextDecoder"), f).toBe(false);
      expect(src.match(/["'`](latin1|utf8|utf-8)["'`]/gi), f).toBeNull();
    }
    // self-test: the patterns do match
    expect(stripComments("const x = JSON.parse(s); y = JSON [\"parse\"]").match(/\bJSON\s*[.[]/g)).toHaveLength(2);
    expect('buf.toString("utf8")'.match(/["'`](latin1|utf8|utf-8)["'`]/gi)).toHaveLength(1);
  });

  it("every parseSlice( and stringAt( bound in the two readers is absent or a named MAX_* of at most MAX_SLICE_BYTES (D41, D53)", () => {
    const sources = ["claude.ts", "codex.ts", "jsonScan.ts"].map((f) => stripComments(coreSrc(f)));
    const slice = declaredInt("MAX_SLICE_BYTES", sources);
    expect(slice).toBe(4096);
    // parseSlice(buf, range, maxBytes) and stringAt(buf, res, path, maxBytes): the bound's position
    const BOUND: Record<string, number> = { parseSlice: 2, stringAt: 3 };
    for (const f of ["claude.ts", "codex.ts"]) {
      const src = stripComments(coreSrc(f));
      let calls = 0;
      for (const [name, at] of Object.entries(BOUND)) {
        for (const args of callArgs(src, name)) {
          calls++;
          expect(args.length, `${f} ${name}(${args.join(", ")})`).toBeLessThanOrEqual(at + 1);
          const bound = args[at];
          if (bound === undefined) continue;
          expect(bound, `${f} ${name}(${args.join(", ")})`).toMatch(/^MAX_[A-Z_]+$/);
          const v = declaredInt(bound, sources);
          expect(v, `${f}: ${bound} is declared as an integer constant`).toBeTypeOf("number");
          expect(v!, `${f}: ${bound}`).toBeLessThanOrEqual(slice!);
          expect(v!, `${f}: ${bound}`).toBeGreaterThan(0);
        }
      }
      expect(calls, f).toBeGreaterThan(0);
    }
    // self-test
    expect(callArgs("x = parseSlice(buf, f(a, b), MAX_X); stringAt(b, r, \"p\")", "parseSlice")).toEqual([["buf", "f(a, b)", "MAX_X"]]);
    expect(declaredInt("MAX_X", ["const MAX_X = 4 * 1_024;"])).toBe(4096);
  });

  it("never-read file names appear in src/ only in comments or a NEVER_READ deny-list (D53)", () => {
    const NAMES = ["auth.json", ".credentials.json", "config.toml", "history.jsonl", "rate_limits", "settings.json"];
    // a deny-list constant whose name says so: `const NEVER_READ = [...]` or `new Set([...])`, any prefix or suffix
    const DENY = /\b(?:export\s+)?const\s+[A-Z_]*NEVER_READ[A-Z_]*\b[^=]*=\s*(?:new\s+Set(?:<[^>]*>)?\(\s*)?\[[^\]]*\]/g;
    const hits: string[] = [];
    for (const f of files(join(ROOT, "src"), /\.ts$/)) {
      const code = stripComments(readFileSync(f, "utf8")).replace(DENY, "");
      for (const [i, line] of code.split("\n").entries()) {
        for (const n of NAMES) if (line.includes(n)) hits.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
    // self-test: a deny-list is exempt, the same name elsewhere is not
    const t = stripComments('// auth.json\nexport const CODEX_NEVER_READ = new Set(["auth.json", "config.toml"]);\nopen("auth.json");').replace(DENY, "");
    expect(t.split("auth.json")).toHaveLength(2);
    expect(t).not.toContain("config.toml");
  });

  it("the monitor asks the reader's pathAllowed( before it opens a file (D53)", () => {
    const src = stripComments(coreSrc("monitor.ts"));
    // the only open in the monitor is a reader's, and it is the one guarded by pathAllowed
    expect(src.split(".open(").length - 1).toBe(1);
    expect(src.split("reader.open(").length - 1).toBe(1);
    const guard = src.indexOf("if (!reader.pathAllowed(path)) {");
    expect(guard).toBeGreaterThanOrEqual(0);
    const open = src.indexOf("reader.open(path, c)");
    expect(open).toBeGreaterThan(guard);
    // the refusal skips the file: nothing between the guard and its `continue;` opens it
    const refusal = src.slice(guard, src.indexOf("continue;", guard));
    expect(refusal).not.toContain(".open(");
    expect(src.indexOf("continue;", guard)).toBeLessThan(open);
  });

  it("source caps, the hot window and the cold rediscovery cadence are the specified constants (D42, D45, D50, D52)", () => {
    const expected: [string, RegExp][] = [
      ["claude.ts", /^export const CLAUDE_MAX_LINE_BYTES = 4 \* 1024 \* 1024;/m],
      ["claude.ts", /^export const CLAUDE_HEAD_BYTES = 4096;/m],
      ["claude.ts", /^export const CLAUDE_MAX_FILES = 10_000;/m],
      ["claude.ts", /^export const CLAUDE_MAX_DEPTH = 6;/m],
      ["claude.ts", /^(?:export )?const MAX_TOOLS = 64;/m],
      ["codex.ts", /^export const CODEX_MAX_LINE_BYTES = 4 \* 1024 \* 1024;/m],
      ["codex.ts", /^export const CODEX_MAX_TURNS = 1024;/m],
      ["jsonScan.ts", /^export const MAX_SCAN_DEPTH = 8;/m],
      ["jsonScan.ts", /^export const MAX_SLICE_BYTES = 4096;/m],
      ["source.ts", /^export const RECENT_MS = 300_000;/m],
      ["monitor.ts", /^(?:export )?const COLD_REDISCOVER_MS = 60_000;/m],
    ];
    const missing = expected.filter(([f, re]) => !re.test(stripComments(coreSrc(f)))).map(([f, re]) => `${f}: ${re.source}`);
    expect(missing).toEqual([]);
  });

  it("settings text (D48): the source switches name their folder, variable and what is kept; historyMonths is source-neutral", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const props = pkg.contributes.configuration.properties;
    const claude: string = props["copilotUsageMonitor.claudeCode"].description;
    const codex: string = props["copilotUsageMonitor.codex"].description;
    for (const t of ["~/.claude", "CLAUDE_CONFIG_DIR", "tool names", "never decoded"]) expect(claude, t).toContain(t);
    for (const t of ["~/.codex", "CODEX_HOME", "never decoded"]) expect(codex, t).toContain(t);
    expect(codex).not.toContain("tool names");
    expect(props["copilotUsageMonitor.historyMonths"].description).not.toContain("Copilot");
  });
});
