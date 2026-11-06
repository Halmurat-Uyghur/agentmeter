import { describe, expect, it } from "vitest";
import { resolveCopilotRoot } from "../../src/core/config";

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
});
