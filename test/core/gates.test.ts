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
/** The getting-started walkthrough's media (v0.6, 2.4): the only files besides the four core ones in the .vsix. */
const WALKTHROUGH_MEDIA = ["media/walkthrough/folder.md", "media/walkthrough/unit.md", "media/walkthrough/target.md", "media/walkthrough/open.md"];
const RATE_FILE = join(ROOT, "src", "vscode", "exchangeRate.ts");

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
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
    // A codicon, so no icon file ships (the .vsix adds only the walkthrough markdown).
    expect(c.viewsContainers.activitybar).toEqual([{ id: "copilotUsageMonitor", title: "Copilot Usage (Local)", icon: "$(graph)" }]);
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
      expect(cmd.category).toBe("Copilot Usage");
    }
    // Palette text stays "Copilot Usage: …": every command has the category and no prefix in its title.
    for (const cmd of c.commands) {
      expect(cmd.category).toBe("Copilot Usage");
      expect(cmd.title).not.toMatch(/^Copilot Usage:/);
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

  it("settings writes: display and currency from extension.ts, targetAlert (to false) only from the alert", () => {
    const writes = new Map<string, string[]>();
    for (const f of files(join(ROOT, "src"), /\.ts$/)) {
      const src = readFileSync(f, "utf8");
      const keys = [...src.matchAll(/\.update\(\s*"([^"]+)"/g)].map((x) => x[1]!);
      // any other config update shape (a variable key) is refused outright
      expect(src.match(/getConfiguration\([^)]*\)\s*\.update\(\s*[^"\s]/g), f).toBeNull();
      if (keys.length) writes.set(f.slice(ROOT.length + 1), keys);
    }
    expect(Object.fromEntries(writes)).toEqual({
      [join("src", "extension.ts")]: ["display", "currency"],
      [join("src", "vscode", "targetAlert.ts")]: ["targetAlert"],
    });
    expect(readFileSync(join(ROOT, "src", "vscode", "targetAlert.ts"), "utf8")).toContain('.update("targetAlert", false, vscode.ConfigurationTarget.Global)');
  });

  it("the panel allows exactly five commands, wired as the webview's allowlist (D30; showSession v0.6)", () => {
    expect([...PANEL_COMMANDS]).toEqual([
      "copilotUsageMonitor.selectMonth",
      "copilotUsageMonitor.setUnit",
      "copilotUsageMonitor.setFilter",
      "copilotUsageMonitor.showSection",
      "copilotUsageMonitor.showSession",
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

  it(".vsix holds exactly package.json, README.md, LICENSE, the bundle and the walkthrough's four markdown files", () => {
    const bin = join(ROOT, "node_modules", ".bin", "vsce");
    expect(existsSync(bin)).toBe(true);
    const out = execFileSync(bin, ["ls", "--no-dependencies"], { cwd: ROOT, encoding: "utf8" });
    const paths = out.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+(\/[\w.-]+)*$/.test(l));
    expect(new Set(paths)).toEqual(new Set(["package.json", "README.md", "LICENSE", "dist/extension.js", ...WALKTHROUGH_MEDIA]));
    // .vscodeignore stays an exact allowlist: ignore everything, then name each file (no globs)
    const ignore = readFileSync(join(ROOT, ".vscodeignore"), "utf8").trim().split("\n");
    expect(ignore).toEqual(["**", "!dist/extension.js", "!package.json", "!README.md", "!LICENSE", ...WALKTHROUGH_MEDIA.map((f) => `!${f}`)]);
  }, 30_000);

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
});
