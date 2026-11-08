import { describe, expect, it, vi } from "vitest";
import { resolveCopilotRoot, resolveRoot } from "../../src/core/config";

describe("resolveCopilotRoot", () => {
  it("defaults to <homedir>/.copilot", () => {
    expect(resolveCopilotRoot({ env: {}, homedir: "/h" })).toEqual({ root: "/h/.copilot", source: "default" });
  });

  it("uses COPILOT_HOME when set", () => {
    expect(resolveCopilotRoot({ env: { COPILOT_HOME: "/x/cp" }, homedir: "/h" })).toEqual({
      root: "/x/cp",
      source: "env",
    });
  });

  it("setting overrides env", () => {
    expect(resolveCopilotRoot({ setting: "~/alt", env: { COPILOT_HOME: "/x" }, homedir: "/h" })).toEqual({
      root: "/h/alt",
      source: "setting",
    });
  });

  it("expands a bare ~ setting to the home folder", () => {
    expect(resolveCopilotRoot({ setting: "~", env: {}, homedir: "/h" })).toEqual({ root: "/h", source: "setting" });
  });

  it("uses an absolute setting as is", () => {
    expect(resolveCopilotRoot({ setting: "/abs/cp", env: {}, homedir: "/h" })).toEqual({
      root: "/abs/cp",
      source: "setting",
    });
  });

  it.each(["", "  "])("blank setting %j falls through to env", (setting) => {
    expect(resolveCopilotRoot({ setting, env: { COPILOT_HOME: "/x/cp" }, homedir: "/h" })).toEqual({
      root: "/x/cp",
      source: "env",
    });
  });

  it.each(["", "  "])("blank setting %j and blank COPILOT_HOME fall through to default", (blank) => {
    expect(resolveCopilotRoot({ setting: blank, env: { COPILOT_HOME: blank }, homedir: "/h" })).toEqual({
      root: "/h/.copilot",
      source: "default",
    });
  });

  it("resolves a relative COPILOT_HOME against the home folder", () => {
    expect(resolveCopilotRoot({ env: { COPILOT_HOME: "cp" }, homedir: "/h" })).toEqual({ root: "/h/cp", source: "env" });
  });

  it("resolves a relative setting against the home folder", () => {
    expect(resolveCopilotRoot({ setting: "cp", env: {}, homedir: "/h" })).toEqual({ root: "/h/cp", source: "setting" });
  });

  it("trims surrounding whitespace from the value", () => {
    expect(resolveCopilotRoot({ setting: "  ~/alt  ", env: {}, homedir: "/h" })).toEqual({
      root: "/h/alt",
      source: "setting",
    });
  });

  it.each([42, true, {}, ["/x"], null])("a non-string setting %j falls through to env/default", (setting) => {
    const o = { setting: setting as unknown, homedir: "/h" };
    expect(resolveCopilotRoot({ ...o, env: { COPILOT_HOME: "/x/cp" } })).toEqual({ root: "/x/cp", source: "env" });
    expect(resolveCopilotRoot({ ...o, env: {} })).toEqual({ root: "/h/.copilot", source: "default" });
  });

  it("expands ~\\ on win32", async () => {
    vi.resetModules();
    vi.doMock("node:path", async () => {
      const p = await vi.importActual<typeof import("node:path")>("node:path");
      return { ...p.win32, default: p.win32 };
    });
    try {
      const { resolveCopilotRoot: resolveWin } = await import("../../src/core/config");
      const homedir = "C:\\Users\\me";
      expect(resolveWin({ setting: "~\\.copilot-work", env: {}, homedir }).root).toBe("C:\\Users\\me\\.copilot-work");
      expect(resolveWin({ setting: "~/x/", env: {}, homedir }).root).toBe("C:\\Users\\me\\x");
    } finally {
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });
});

describe("resolveRoot", () => {
  it("copilot kind matches resolveCopilotRoot", () => {
    const o = { setting: "~/alt", env: { COPILOT_HOME: "/x" }, homedir: "/h" };
    expect(resolveRoot("copilot", o)).toEqual(resolveCopilotRoot(o));
    expect(resolveRoot("copilot", { env: {}, homedir: "/h" })).toEqual({ root: "/h/.copilot", source: "default" });
  });

  it.each([
    ["claude", "CLAUDE_CONFIG_DIR", ".claude"],
    ["codex", "CODEX_HOME", ".codex"],
  ] as const)("%s: setting, then %s, then ~/%s", (kind, envVar, dir) => {
    expect(resolveRoot(kind, { env: {}, homedir: "/h" })).toEqual({ root: `/h/${dir}`, source: "default" });
    expect(resolveRoot(kind, { env: { [envVar]: "/x/e" }, homedir: "/h" })).toEqual({ root: "/x/e", source: "env" });
    expect(resolveRoot(kind, { setting: "~/alt", env: { [envVar]: "/x/e" }, homedir: "/h" })).toEqual({
      root: "/h/alt",
      source: "setting",
    });
    expect(resolveRoot(kind, { setting: "~", env: {}, homedir: "/h" })).toEqual({ root: "/h", source: "setting" });
    expect(resolveRoot(kind, { setting: "  ", env: { [envVar]: " " }, homedir: "/h" })).toEqual({
      root: `/h/${dir}`,
      source: "default",
    });
    expect(resolveRoot(kind, { env: { [envVar]: "rel" }, homedir: "/h" })).toEqual({ root: "/h/rel", source: "env" });
    expect(resolveRoot(kind, { setting: "rel", env: {}, homedir: "/h" })).toEqual({ root: "/h/rel", source: "setting" });
    expect(resolveRoot(kind, { setting: 42, env: { [envVar]: "/x/e" }, homedir: "/h" })).toEqual({ root: "/x/e", source: "env" });
  });

  it("each kind reads only its own environment variable", () => {
    const env = { COPILOT_HOME: "/cp", CLAUDE_CONFIG_DIR: "/cl", CODEX_HOME: "/cx" };
    expect(resolveRoot("copilot", { env, homedir: "/h" }).root).toBe("/cp");
    expect(resolveRoot("claude", { env, homedir: "/h" }).root).toBe("/cl");
    expect(resolveRoot("codex", { env, homedir: "/h" }).root).toBe("/cx");
    expect(resolveRoot("claude", { env: { COPILOT_HOME: "/cp", CODEX_HOME: "/cx" }, homedir: "/h" }).root).toBe("/h/.claude");
  });
});
