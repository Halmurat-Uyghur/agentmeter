// Settings writes under contention (review finding 2): a refused write's retry must not undo a
// newer choice for the same setting, and a choice whose save was refused stays the effective
// value when an unrelated setting changes (one layer of unsaved choices over the saved settings).
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prefs, ViewOptions } from "../../src/core/types";

type Fake = typeof import("../fakes/vscode");
const SECTION = "copilotUsageMonitor";
let home: string;

async function load(settings: Record<string, unknown> = {}) {
  vi.resetModules();
  const fake: Fake = await import("../fakes/vscode");
  Object.assign(fake.state.global, { [`${SECTION}.copilotHome`]: home, [`${SECTION}.claudeCode`]: false, [`${SECTION}.codex`]: false }, ...Object.entries(settings).map(([k, v]) => ({ [`${SECTION}.${k}`]: v })));
  const ext = await import("../../src/extension");
  const ctx = { subscriptions: [] as { dispose(): unknown }[], extensionMode: fake.ExtensionMode.Test };
  ext.activate(ctx as never);
  const cmd = (id: string) => fake.state.commands.get(`${SECTION}.${id}`)!;
  return {
    fake,
    cmd,
    testState: () => cmd("_testState")() as { view: ViewOptions; panelPalette: string; prefs: Prefs },
    saved: (k: string) => fake.state.global[`${SECTION}.${k}`],
    errors: () => fake.state.log.filter((l) => l.startsWith("error ")),
    deactivate: () => {
      for (const d of ctx.subscriptions) d.dispose();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cum-writes-"));
  mkdirSync(join(home, "session-state"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("settings writes: an obsolete retry never undoes a newer choice", () => {
  it("cost refused, tokens saved: the pending cost retry is dropped", async () => {
    const { fake, cmd, testState, saved, errors, deactivate } = await load();
    const timers = vi.getTimerCount();
    fake.state.updateReject = true;
    const first = cmd("setUnit")("cost");
    await settle();
    expect(errors()).toEqual(["error unit.write WRITE_FAILED"]);
    fake.state.updateReject = false;
    await cmd("setUnit")("tokens");
    expect(saved("display")).toBe("tokens");
    expect(vi.getTimerCount()).toBe(timers); // the obsolete retry's timer is cleared, not just ignored
    await vi.advanceTimersByTimeAsync(1500);
    await first;
    expect(saved("display")).toBe("tokens");
    expect(fake.state.updates).toEqual([["display", "tokens", fake.ConfigurationTarget.Global]]);
    expect(testState().view.unit).toBe("tokens");
    expect(testState().prefs.unsaved).toEqual([]);
    expect(errors()).toHaveLength(1);
    deactivate();
  });

  it("a newer refused choice is the one retried and marked unsaved; the older one never reaches the file", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load({ palette: "ember" });
    fake.state.updateReject = true;
    const a = cmd("selectPalette")("ocean");
    await settle();
    const b = cmd("selectPalette")("rose");
    await settle();
    fake.state.updateReject = false;
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([a, b]);
    expect(fake.state.updates).toEqual([["palette", "rose", fake.ConfigurationTarget.Global]]);
    expect(saved("palette")).toBe("rose");
    expect(testState().panelPalette).toBe("rose");
    expect(testState().prefs.unsaved).toEqual([]);
    deactivate();
  });

  it("an obsolete write resolves false; the latest still resolves true", async () => {
    const { fake, cmd, deactivate } = await load();
    fake.state.updateReject = true;
    const a = cmd("setStatusBar")("month");
    await settle();
    fake.state.updateReject = false;
    const b = cmd("setStatusBar")("session");
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([a, b]);
    expect(fake.state.updates).toEqual([["statusBar", "session", fake.ConfigurationTarget.Global]]);
    deactivate();
  });

  it("writes to different settings do not cancel each other's retries", async () => {
    const { fake, cmd, saved, deactivate } = await load();
    fake.state.updateReject = "Unable to write into user settings because the file has unsaved changes.";
    const a = cmd("setUnit")("cost");
    const b = cmd("setStatusBar")("month");
    await settle();
    fake.state.updateReject = false;
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([a, b]);
    expect(saved("display")).toBe("cost");
    expect(saved("statusBar")).toBe("month");
    deactivate();
  });
});

describe("settings writes: unsaved choices stay effective", () => {
  it("a refused unit stays shown when an unrelated target is saved", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load();
    fake.state.updateReject = true;
    const p = cmd("setUnit")("cost");
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(testState().prefs.unsaved).toEqual(["display"]);
    fake.state.updateReject = false;
    await cmd("setTarget")("day", "max", "5");
    expect(saved("dailyTargetMax")).toBe(5);
    expect(testState().view.unit).toBe("cost");
    expect(testState().prefs.unsaved).toEqual(["display"]);
    expect(saved("display")).toBeUndefined();
    deactivate();
  });

  it("a refused status bar choice survives a re-read of the settings, in the view and the Settings section", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    fake.state.updateReject = true;
    const p = cmd("setStatusBar")("session");
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    fake.state.updateReject = false;
    await cmd("setTargetAlert")("on");
    expect(testState().view.statusBar).toBe("session");
    expect(testState().prefs.statusBar).toBe("session");
    expect(testState().prefs.targetAlert).toBe(true);
    deactivate();
  });

  it("a refused target shows in the Settings section and survives another target's save", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    fake.state.updateReject = true;
    const p = cmd("setTarget")("week", "max", "40");
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(testState().prefs.targets.weekMax).toBe(40);
    fake.state.updateReject = false;
    await cmd("setTarget")("day", "max", "5");
    expect(testState().prefs.targets).toMatchObject({ dayMax: 5, weekMax: 40 });
    expect(testState().prefs.unsaved).toEqual(["weeklyTargetMax"]);
    deactivate();
  });

  it("a refused palette stays when the settings change for another reason", async () => {
    const { fake, cmd, testState, deactivate } = await load({ palette: "ember" });
    fake.state.updateReject = true;
    const p = cmd("selectPalette")("ocean");
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    fake.fireConfigChange(`${SECTION}.historyMonths`);
    expect(testState().panelPalette).toBe("ocean");
    deactivate();
  });

  it("a later save of that setting clears the unsaved choice", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load();
    fake.state.updateReject = true;
    const p = cmd("setUnit")("cost");
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    fake.state.updateReject = false;
    await cmd("setUnit")("tokens");
    expect(saved("display")).toBe("tokens");
    expect(testState().view.unit).toBe("tokens");
    expect(testState().prefs.unsaved).toEqual([]);
    deactivate();
  });

  it("an outside edit of that setting replaces the unsaved choice", async () => {
    const { fake, cmd, testState, deactivate } = await load({ palette: "ember" });
    fake.state.updateReject = true;
    const p = cmd("setUnit")("cost");
    const q = cmd("selectPalette")("ocean");
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([p, q]);
    expect(testState().prefs.unsaved).toEqual(["display", "palette"]);
    // the user edits settings.json by hand
    fake.state.global[`${SECTION}.display`] = "tokens";
    fake.fireConfigChange(`${SECTION}.display`);
    expect(testState().view.unit).toBe("tokens");
    expect(testState().prefs.unsaved).toEqual(["palette"]);
    fake.state.global[`${SECTION}.palette`] = "forest";
    fake.fireConfigChange(`${SECTION}.palette`);
    expect(testState().panelPalette).toBe("forest");
    expect(testState().prefs.unsaved).toEqual([]);
    deactivate();
  });

  it("deactivate during the retry wait settles the write without a second attempt", async () => {
    const { fake, cmd, errors, deactivate } = await load();
    fake.state.updateReject = true;
    const p = cmd("setUnit")("cost");
    await settle();
    deactivate();
    await expect(p).resolves.toBeUndefined();
    expect(errors()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
