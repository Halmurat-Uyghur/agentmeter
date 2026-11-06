// Privacy and packaging gates (plan §2, Task 9). These scan the source tree
// and the built bundle; they fail the build if a network, persistence or
// telemetry API appears anywhere.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LOCAL_BANNER } from "../../src/core/format";

const ROOT = join(__dirname, "..", "..");

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
];
const DYNAMIC_REQUIRE = /\brequire\(\s*(?!["'])/;

function offences(source: string): string[] {
  const found: string[] = [];
  if (NET_MODULES.test(source)) found.push(`network module: ${NET_MODULES.exec(source)![0]}`);
  for (const t of TOKENS) if (source.includes(t)) found.push(t);
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
      expect(offences(readFileSync(f, "utf8")), f).toEqual([]);
    }
  });

  it("forbidden APIs: none in the bundle", () => {
    const bundle = readFileSync(join(ROOT, "dist", "extension.js"), "utf8");
    expect(offences(bundle)).toEqual([]);
  });

  it("gate patterns actually match (self-test)", () => {
    expect(offences('import * as h from "node:https";')).toHaveLength(1);
    expect(offences("const x = require(name);")).toContain("dynamic require");
    expect(offences("fs.promises.writeFile(p, d)")).toContain("writeFile");
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

  it("manifest copy check: description, commands and settings", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const strings = [pkg.displayName, pkg.description, ...pkg.contributes.commands.map((c: { title: string }) => c.title),
      ...Object.values(pkg.contributes.configuration.properties).map((p) => (p as { description: string }).description)];
    for (const t of strings) expect(t).not.toMatch(COPY_RE);
  });

  it("manifest: no runtime dependencies, machine-scoped folder setting, MIT", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({});
    expect(pkg.license).toBe("MIT");
    expect(pkg.contributes.configuration.properties["copilotUsageMonitor.copilotHome"].scope).toBe("machine");
    expect(pkg.activationEvents).toEqual(["onStartupFinished"]);
  });

  it(".vsix holds exactly package.json, README.md, LICENSE and the bundle", () => {
    const bin = join(ROOT, "node_modules", ".bin", "vsce");
    expect(existsSync(bin)).toBe(true);
    const out = execFileSync(bin, ["ls", "--no-dependencies"], { cwd: ROOT, encoding: "utf8" });
    const paths = out.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+(\/[\w.-]+)*$/.test(l));
    expect(new Set(paths)).toEqual(new Set(["package.json", "README.md", "LICENSE", "dist/extension.js"]));
  }, 30_000);
});
