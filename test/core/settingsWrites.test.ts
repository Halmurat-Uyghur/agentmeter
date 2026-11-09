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

const scoped = (settings: Record<string, unknown>) => Object.fromEntries(Object.entries(settings).map(([k, v]) => [`${SECTION}.${k}`, v]));

async function load(settings: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}) {
  vi.resetModules();
  const fake: Fake = await import("../fakes/vscode");
  Object.assign(fake.state.global, { [`${SECTION}.copilotHome`]: home, [`${SECTION}.claudeCode`]: false, [`${SECTION}.codex`]: false }, scoped(settings));
  Object.assign(fake.state.workspace, scoped(workspace));
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

describe("settings writes: an outside edit during the retry wait wins (review fix A)", () => {
  it("the user's hand edit is kept; the refused choice is not retried over it", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load();
    const timers = vi.getTimerCount();
    fake.state.updateReject = true;
    const p = cmd("setUnit")("cost");
    await settle();
    expect(testState().view.unit).toBe("cost");
    // settings.json becomes writable and the user sets the unit by hand while the retry waits
    fake.state.updateReject = false;
    fake.state.global[`${SECTION}.display`] = "tokens";
    fake.fireConfigChange(`${SECTION}.display`);
    expect(testState().view.unit).toBe("tokens");
    expect(vi.getTimerCount()).toBe(timers); // the retry's timer is cleared
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(fake.state.updates).toEqual([]);
    expect(saved("display")).toBe("tokens");
    expect(testState().view.unit).toBe("tokens");
    expect(testState().prefs.unsaved).toEqual([]);
    deactivate();
  });

  it("the change event of our own save is not taken for an outside edit", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load();
    fake.state.updateReject = true;
    const p = cmd("setStatusBar")("month");
    await settle();
    fake.state.updateReject = false;
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(fake.state.updates).toEqual([["statusBar", "month", fake.ConfigurationTarget.Global]]);
    expect(saved("statusBar")).toBe("month");
    expect(testState().view.statusBar).toBe("month");
    expect(testState().prefs.unsaved).toEqual([]);
    deactivate();
  });
});

describe("settings writes: overlapping saves of one setting", () => {
  it("an older pick's save landing while the newer one is in flight is not an outside edit", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load({ palette: "ember" });
    fake.state.holdUpdates = true;
    const a = cmd("selectPalette")("ocean");
    await settle();
    const b = cmd("selectPalette")("rose");
    await settle();
    fake.state.holdUpdates = false;
    expect(fake.state.held).toHaveLength(2);
    // Ocean's write lands and fires its change event while Rose's is still in flight
    fake.state.held[0]!();
    await settle();
    expect(saved("palette")).toBe("ocean");
    expect(testState().panelPalette).toBe("rose");
    // then settings.json gets unsaved changes and Rose's write (and its retry) is refused
    fake.state.updateReject = "Unable to write into user settings because the file has unsaved changes.";
    fake.state.held[1]!();
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([a, b]);
    expect(testState().panelPalette).toBe("rose");
    expect(testState().prefs.unsaved).toEqual(["palette"]);
    expect(saved("palette")).toBe("ocean");
    deactivate();
  });

  it("an older pick's change event during the newer write, then the newer write saves: the newer pick wins", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load({ palette: "ember" });
    fake.state.holdUpdates = true;
    const a = cmd("selectPalette")("ocean");
    await settle();
    const b = cmd("selectPalette")("rose");
    await settle();
    fake.state.holdUpdates = false;
    fake.state.held[0]!();
    await settle();
    expect(testState().panelPalette).toBe("rose");
    fake.state.held[1]!();
    await Promise.all([a, b]);
    expect(fake.state.updates).toEqual([
      ["palette", "ocean", fake.ConfigurationTarget.Global],
      ["palette", "rose", fake.ConfigurationTarget.Global],
    ]);
    expect(saved("palette")).toBe("rose");
    expect(testState().panelPalette).toBe("rose");
    expect(testState().prefs.unsaved).toEqual([]);
    // the record of our own writes is cleared once the latest settles: a later hand edit to Ocean wins
    fake.state.global[`${SECTION}.palette`] = "ocean";
    fake.fireConfigChange(`${SECTION}.palette`);
    expect(testState().panelPalette).toBe("ocean");
    deactivate();
  });

  it("an outside edit while the newer write waits to retry still wins over an older landed pick", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load({ palette: "ember" });
    fake.state.holdUpdates = true;
    const a = cmd("selectPalette")("ocean");
    await settle();
    const b = cmd("selectPalette")("rose");
    await settle();
    fake.state.holdUpdates = false;
    fake.state.held[0]!();
    await settle();
    fake.state.updateReject = true;
    fake.state.held[1]!();
    await settle();
    // the user picks Forest by hand during Rose's retry wait
    fake.state.updateReject = false;
    fake.state.global[`${SECTION}.palette`] = "forest";
    fake.fireConfigChange(`${SECTION}.palette`);
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([a, b]);
    expect(saved("palette")).toBe("forest");
    expect(testState().panelPalette).toBe("forest");
    expect(testState().prefs.unsaved).toEqual([]);
    deactivate();
  });
});

describe("settings writes: each of our saves accounts for one change event", () => {
  it("a hand edit back to an older landed pick during the retry wait wins over the retry", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load({ palette: "ember" });
    fake.state.holdUpdates = true;
    const a = cmd("selectPalette")("ocean");
    await settle();
    const b = cmd("selectPalette")("forest");
    await settle();
    const c = cmd("selectPalette")("rose");
    await settle();
    fake.state.holdUpdates = false;
    expect(fake.state.held).toHaveLength(3);
    // Ocean's and Forest's saves land (their events are ours); Rose's is refused and waits to retry
    fake.state.held[0]!();
    await settle();
    fake.state.held[1]!();
    await settle();
    fake.state.updateReject = true;
    fake.state.held[2]!();
    await settle();
    expect(testState().panelPalette).toBe("rose");
    // the user sets Ocean by hand in settings.json during the wait
    fake.state.updateReject = false;
    fake.state.global[`${SECTION}.palette`] = "ocean";
    fake.fireConfigChange(`${SECTION}.palette`);
    expect(testState().panelPalette).toBe("ocean");
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([a, b, c]);
    expect(fake.state.updates.map((u) => u[1])).toEqual(["ocean", "forest"]);
    expect(saved("palette")).toBe("ocean");
    expect(testState().panelPalette).toBe("ocean");
    expect(testState().prefs.unsaved).toEqual([]);
    deactivate();
  });

  it("an event showing the in-flight value counts as ours only once", async () => {
    const { fake, cmd, testState, saved, errors, deactivate } = await load({ palette: "ember" });
    fake.state.holdUpdates = true;
    const p = cmd("selectPalette")("rose");
    await settle();
    fake.state.holdUpdates = false;
    // the user writes Rose by hand twice while our save of Rose is still in flight
    fake.state.global[`${SECTION}.palette`] = "rose";
    fake.fireConfigChange(`${SECTION}.palette`); // taken for our save's event
    fake.fireConfigChange(`${SECTION}.palette`); // not ours: an outside edit, the write stands down
    // our save is then refused: no retry, and the hand-saved Rose is not marked unsaved
    fake.state.updateReject = true;
    fake.state.held[0]!();
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(errors()).toHaveLength(1);
    expect(saved("palette")).toBe("rose");
    expect(testState().panelPalette).toBe("rose");
    expect(testState().prefs.unsaved).toEqual([]);
    deactivate();
  });
});

describe("settings writes: the target alert uses the effective setting (review fix B)", () => {
  it("a refused \"on\" is what the alert is checked with", async () => {
    const { fake, cmd, deactivate } = await load();
    const { TargetAlert } = await import("../../src/vscode/targetAlert");
    const check = vi.spyOn(TargetAlert.prototype, "check");
    fake.state.updateReject = true;
    const p = cmd("setTargetAlert")("on");
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(fake.state.global[`${SECTION}.targetAlert`]).toBeUndefined();
    expect(check).toHaveBeenCalled();
    expect(check.mock.calls.at(-1)![2]).toBe(true);
    check.mockRestore();
    deactivate();
  });
});

describe("settings writes: a saved value is redrawn from the settings (review fix H)", () => {
  it("saving the value already stored (no change event) replaces a refused one in the view", async () => {
    const { fake, cmd, testState, saved, deactivate } = await load({ weeklyTargetMax: 30 });
    fake.state.quietWhenUnchanged = true;
    fake.state.updateReject = true;
    const p = cmd("setTarget")("week", "max", "40");
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(testState().view.weekTarget).toEqual({ max: 40 });
    fake.state.updateReject = false;
    await cmd("setTarget")("week", "max", "30");
    expect(saved("weeklyTargetMax")).toBe(30);
    expect(testState().view.weekTarget).toEqual({ max: 30 });
    expect(testState().prefs.targets.weekMax).toBe(30);
    expect(testState().prefs.unsaved).toEqual([]);
    deactivate();
  });

  it("clearing the workspace target shows the user target underneath", async () => {
    const { fake, cmd, testState, deactivate } = await load({ monthlyTargetMax: 100 }, { monthlyTargetMax: 50 });
    expect(testState().view.range).toEqual({ max: 50 });
    await cmd("setTarget")("month", "max", "");
    expect(fake.state.workspace[`${SECTION}.monthlyTargetMax`]).toBeUndefined();
    expect(testState().view.range).toEqual({ max: 100 });
    expect(testState().prefs.targets.monthMax).toBe(100);
    deactivate();
  });

  it("a refused clear does not hide the user target underneath", async () => {
    const { fake, cmd, testState, deactivate } = await load({ monthlyTargetMax: 100 }, { monthlyTargetMax: 50 });
    fake.state.updateReject = true;
    const p = cmd("setTarget")("month", "max", "");
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(fake.state.workspace[`${SECTION}.monthlyTargetMax`]).toBe(50);
    expect(testState().view.range).toEqual({ max: 100 });
    expect(testState().prefs.unsaved).toEqual(["monthlyTargetMax"]);
    deactivate();
  });
});
