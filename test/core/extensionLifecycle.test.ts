// src/extension.ts and src/vscode/* against the fake `vscode` module (test/fakes/vscode.ts,
// aliased in vitest.config.ts): the rate timer's lifecycle (F1), the unit command (F2),
// the alert's "Don't show again" write (F3), the viewed month across restarts (F4),
// the rate response size cap (F5) and the colour palette command (v0.8). Ported from review
// agent 7's harness (v0.7).
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorOptions } from "../../src/core/monitor";
import { type Prefs, SOURCE_LABEL, type Snapshot, type ViewOptions } from "../../src/core/types";
import { codexMeta, codexRecord, codexTree, codexTurn } from "../fixtures/codex";

/** Every UsageMonitor the extension constructs, with its options (survives vi.resetModules). */
const built = vi.hoisted(() => [] as { sources?: MonitorOptions["sources"] }[]);
/** When set, every monitor reads this instant as now (a test then never depends on the wall clock). */
const fixedNow = vi.hoisted(() => ({ ms: undefined as number | undefined }));
vi.mock("../../src/core/monitor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/monitor")>();
  class Spy extends mod.UsageMonitor {
    constructor(o: MonitorOptions) {
      super(fixedNow.ms === undefined ? o : { ...o, now: () => new Date(fixedNow.ms!) });
      built.push({ ...(o.sources && { sources: o.sources }) });
    }
  }
  return { ...mod, UsageMonitor: Spy };
});

type Fake = typeof import("../fakes/vscode");
const SECTION = "copilotUsageMonitor";
const HOUR = 60 * 60 * 1000;

let home: string;
let fetchCalls: string[];
let resolvers: ((v: Response) => void)[];

/** Fresh module graph: the fake and the extension share one instance per test. */
async function load(settings: Record<string, unknown> = {}) {
  vi.resetModules();
  const fake: Fake = await import("../fakes/vscode");
  // Claude Code and Codex roots under the temp home, so no test reads the real ~/.claude or ~/.codex.
  Object.assign(fake.state.global, { [`${SECTION}.copilotHome`]: home, [`${SECTION}.claudeHome`]: join(home, "claude"), [`${SECTION}.codexHome`]: join(home, "codex") }, ...Object.entries(settings).map(([k, v]) => ({ [`${SECTION}.${k}`]: v })));
  const ext = await import("../../src/extension");
  const ctx = { subscriptions: [] as { dispose(): unknown }[], extensionMode: fake.ExtensionMode.Test };
  ext.activate(ctx as never);
  const cmd = (id: string) => fake.state.commands.get(`${SECTION}.${id}`)!;
  return {
    fake,
    cmd,
    testState: () => cmd("_testState")() as { snapshot?: Snapshot; view: ViewOptions; panelPalette: string; panelSection: string; prefs: Prefs },
    deactivate: () => {
      for (const d of ctx.subscriptions) d.dispose();
    },
  };
}

const ok = (code: string) => new Response(JSON.stringify({ base: "USD", date: "2026-11-06", rates: { [code]: 1.4 } }), { status: 200 });
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cum-ext-"));
  mkdirSync(join(home, "session-state"));
  fetchCalls = [];
  resolvers = [];
  built.length = 0;
  fixedNow.ms = undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("fetch", (url: string) => {
    fetchCalls.push(url);
    return new Promise<Response>((r) => resolvers.push(r));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("extension lifecycle: exchange rate (F1)", () => {
  it("no rate timer or fetch after deactivate while a fetch is in flight", async () => {
    const { deactivate } = await load({ currency: "CAD" });
    expect(fetchCalls).toHaveLength(1);
    deactivate();
    resolvers[0]!(ok("CAD"));
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    expect(fetchCalls).toHaveLength(1);
  });

  it("overlapping currency changes leave one rate timer", async () => {
    const { fake, deactivate } = await load({ currency: "EUR" });
    fake.state.global[`${SECTION}.currency`] = "GBP";
    fake.fireConfigChange(`${SECTION}.currency`);
    expect(fetchCalls).toHaveLength(2);
    const base = vi.getTimerCount();
    resolvers[0]!(new Response("x", { status: 503 })); // the stale EUR fetch fails
    resolvers[1]!(ok("GBP"));
    await settle();
    expect(vi.getTimerCount()).toBe(base + 1);
    expect(fake.state.log.filter((l) => l.startsWith("error rate.fetch"))).toEqual([]);
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000); // past the 15 min retry a stale failure would arm
    expect(fetchCalls).toHaveLength(2);
    deactivate();
  });
});

describe("extension lifecycle: setUnit (F2)", () => {
  it("setUnit ignores non-unit args", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    await cmd("setUnit")({ evil: 1 });
    await cmd("setUnit")(["cost"]);
    await cmd("setUnit")(null);
    expect(fake.state.updates).toEqual([]);
    expect(testState().view.unit).toBe("tokens");
    await cmd("setUnit")(); // no argument still toggles
    expect(fake.state.updates).toEqual([["display", "cost", fake.ConfigurationTarget.Global]]);
    deactivate();
  });

  it("setUnit writes at the scope that holds the value", async () => {
    const { fake, cmd, deactivate } = await load();
    const T = fake.ConfigurationTarget;
    await cmd("setUnit")("cost"); // set nowhere: user settings
    fake.state.workspace[`${SECTION}.display`] = "cost";
    await cmd("setUnit")("tokens");
    fake.state.folder[`${SECTION}.display`] = "tokens";
    await cmd("setUnit")("cost");
    expect(fake.state.updates).toEqual([["display", "cost", T.Global], ["display", "tokens", T.Workspace], ["display", "cost", T.WorkspaceFolder]]);
    deactivate();
  });

  it("a refused display write keeps the unit shown, logs a code, retries once and marks the key unsaved (v0.9, D1)", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    fake.state.updateReject = true;
    const errors = () => fake.state.log.filter((l) => l.startsWith("error "));
    const p = cmd("setUnit")("cost");
    await settle();
    expect(testState().view.unit).toBe("cost");
    expect(errors()).toEqual(["error unit.write WRITE_FAILED"]);
    expect(testState().prefs.unsaved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(testState().view.unit).toBe("cost");
    expect(errors()).toEqual(["error unit.write WRITE_FAILED", "error unit.write WRITE_FAILED"]);
    expect(testState().prefs.unsaved).toEqual(["display"]);
    expect(fake.state.updates).toEqual([]);
    deactivate();
  });

  it("a write refused once and accepted on the retry saves the value and leaves nothing unsaved", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    fake.state.updateReject = "Unable to write into user settings because the file has unsaved changes. Please save the user settings file first and then try again.";
    const errors = () => fake.state.log.filter((l) => l.startsWith("error "));
    const p = cmd("setUnit")("cost");
    await settle();
    expect(errors()).toEqual(["error unit.write FILE_DIRTY"]);
    fake.state.updateReject = false;
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(fake.state.updates).toEqual([["display", "cost", fake.ConfigurationTarget.Global]]);
    expect(testState().prefs.unsaved).toEqual([]);
    expect(errors()).toHaveLength(1);
    deactivate();
  });
});

describe("extension lifecycle: colour palette (v0.8)", () => {
  it("starts from the setting, falls back to theme on junk, and follows setting changes", async () => {
    const { fake, testState, deactivate } = await load({ palette: "forest" });
    expect(testState().panelPalette).toBe("forest");
    fake.state.global[`${SECTION}.palette`] = "Forest";
    fake.fireConfigChange(`${SECTION}.palette`);
    expect(testState().panelPalette).toBe("theme");
    fake.state.global[`${SECTION}.palette`] = "rose";
    fake.fireConfigChange(`${SECTION}.palette`);
    expect(testState().panelPalette).toBe("rose");
    expect(fake.state.updates).toEqual([]);
    deactivate();
  });

  it("selectPalette with an id draws it at once and writes the user setting; other arguments are ignored", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    expect(testState().panelPalette).toBe("theme");
    await cmd("selectPalette")("ocean");
    expect(testState().panelPalette).toBe("ocean");
    expect(fake.state.updates).toEqual([["palette", "ocean", fake.ConfigurationTarget.Global]]);
    for (const bad of ["Ocean", "", 3, null, ["ember"], { id: "ember" }]) await cmd("selectPalette")(bad);
    expect(testState().panelPalette).toBe("ocean");
    expect(fake.state.updates).toHaveLength(1);
    deactivate();
  });

  it("selectPalette with no argument offers every palette, the current one marked, and writes the pick", async () => {
    const { fake, cmd, testState, deactivate } = await load({ palette: "violet" });
    let offered: { label: string; description: string; id: string }[] = [];
    fake.window.showQuickPick = (async (items: typeof offered) => {
      offered = items;
      return undefined;
    }) as never;
    await cmd("selectPalette")();
    expect(offered.map((i) => i.id)).toEqual(["theme", "ember", "ocean", "forest", "violet", "rose", "graphite"]);
    expect(offered.find((i) => i.id === "violet")!.description).toMatch(/ · current$/);
    expect(fake.state.updates).toEqual([]);
    expect(testState().panelPalette).toBe("violet");
    fake.window.showQuickPick = (async (items: typeof offered) => items.find((i) => i.id === "graphite")) as never;
    await cmd("selectPalette")();
    expect(testState().panelPalette).toBe("graphite");
    expect(fake.state.updates).toEqual([["palette", "graphite", fake.ConfigurationTarget.Global]]);
    deactivate();
  });

  it("a refused palette write keeps the chosen palette (no rollback), logs the reason code, retries once and marks it unsaved; a later save clears the mark (v0.9, D1–D2)", async () => {
    const { fake, cmd, testState, deactivate } = await load({ palette: "ember" });
    fake.state.updateReject = "Unable to write into user settings because the content of the file is newer.";
    const p = cmd("selectPalette")("ocean");
    await settle();
    // drawn at once, and still ocean after the first refusal (0.8 redrew ember here, so the pick looked dead)
    expect(testState().panelPalette).toBe("ocean");
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(testState().panelPalette).toBe("ocean");
    expect(fake.state.log.filter((l) => l.startsWith("error "))).toEqual(["error palette.write FILE_MODIFIED", "error palette.write FILE_MODIFIED"]);
    expect(testState().prefs.unsaved).toEqual(["palette"]);
    expect(fake.state.updates).toEqual([]);
    fake.state.updateReject = false;
    await cmd("selectPalette")("rose");
    expect(testState().panelPalette).toBe("rose");
    expect(testState().prefs.unsaved).toEqual([]);
    expect(fake.state.updates).toEqual([["palette", "rose", fake.ConfigurationTarget.Global]]);
    deactivate();
  });

  it("the log code names VS Code's reason without its text; unknown reasons stay WRITE_FAILED", async () => {
    const cases: [string, string][] = [
      ["Unable to write to User Settings because copilotUsageMonitor.palette is not a registered configuration.", "UNKNOWN_KEY"],
      ["Unable to write into user settings. Please open the user settings to correct errors/warnings in it and try again.", "INVALID_FILE"],
      ["Unable to write copilotUsageMonitor.palette because it is configured in system policy.", "POLICY"],
      ["Unable to write to User Settings because copilotUsageMonitor.palette does not support for global scope.", "INVALID_TARGET"],
      ["something else entirely", "WRITE_FAILED"],
    ];
    for (const [message, code] of cases) {
      const { fake, cmd, deactivate } = await load();
      fake.state.updateReject = message;
      const p = cmd("selectPalette")("ocean");
      await settle();
      deactivate(); // no second attempt after deactivate
      await vi.advanceTimersByTimeAsync(1500);
      await p;
      expect(fake.state.log.filter((l) => l.startsWith("error ")), message).toEqual([`error palette.write ${code}`]);
      expect(fake.state.log.join(" ")).not.toContain("Unable");
    }
  });
});

describe("extension lifecycle: Settings section commands (v0.9)", () => {
  it("setStatusBar: a value draws at once and writes at the scope that holds the value; no argument offers a picker; junk is ignored", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    const T = fake.ConfigurationTarget;
    await cmd("setStatusBar")("month");
    expect(testState().view.statusBar).toBe("month");
    expect(testState().prefs.statusBar).toBe("month");
    expect(fake.state.updates).toEqual([["statusBar", "month", T.Global]]);
    fake.state.workspace[`${SECTION}.statusBar`] = "month";
    await cmd("setStatusBar")("today");
    expect(fake.state.updates.at(-1)).toEqual(["statusBar", "today", T.Workspace]);
    expect(testState().view.statusBar).toBeUndefined();
    for (const bad of ["Month", "", 1, null, ["session"], { value: "session" }]) await cmd("setStatusBar")(bad);
    expect(fake.state.updates).toHaveLength(2);
    let offered: { label: string; description: string; value: string }[] = [];
    fake.window.showQuickPick = (async (items: typeof offered) => {
      offered = items;
      return items.find((i) => i.value === "session");
    }) as never;
    await cmd("setStatusBar")();
    expect(offered.map((i) => [i.label, i.value])).toEqual([["Today", "today"], ["This month", "month"], ["Current session", "session"]]);
    expect(offered.find((i) => i.value === "today")!.description).toMatch(/ · current$/);
    expect(testState().view.statusBar).toBe("session");
    expect(fake.state.updates.at(-1)).toEqual(["statusBar", "session", T.Workspace]);
    deactivate();
  });

  it("setTarget: a value writes the setting in the chosen currency, '' clears it, junk is ignored, and the view converts at the rate", async () => {
    const { fake, cmd, testState, deactivate } = await load({ currency: "CAD" });
    resolvers[0]!(ok("CAD"));
    await settle();
    await cmd("setTarget")("day", "max", "7");
    await cmd("setTarget")("week", "max", "35.5");
    await cmd("setTarget")("month", "min", "10");
    await cmd("setTarget")("month", "max", " 60 ");
    expect(fake.state.updates.map((u) => [u[0], u[1]])).toEqual([["dailyTargetMax", 7], ["weeklyTargetMax", 35.5], ["monthlyTargetMin", 10], ["monthlyTargetMax", 60]]);
    const v = testState().view;
    expect(v.dayTarget!.max).toBeCloseTo(7 / 1.4, 9);
    expect(v.dayTarget!.min).toBeUndefined();
    expect(v.weekTarget!.max).toBeCloseTo(35.5 / 1.4, 9);
    expect(v.range!.min).toBeCloseTo(10 / 1.4, 9);
    expect(v.range!.max).toBeCloseTo(60 / 1.4, 9);
    expect(testState().prefs.targets).toEqual({ dayMax: 7, weekMax: 35.5, monthMin: 10, monthMax: 60 });
    const bad: unknown[][] = [["day", "min", "5"], ["year", "max", "5"], ["day", "max", "-1"], ["day", "max", "abc"], ["day", "max", 5], ["week", "max", "1e3"], ["week", "max", "NaN"], ["week", "max", "Infinity"], [null, "max", "1"]];
    for (const args of bad) await cmd("setTarget")(...args);
    expect(fake.state.updates).toHaveLength(4);
    await cmd("setTarget")("day", "max", "");
    expect(fake.state.updates.at(-1)).toEqual(["dailyTargetMax", undefined, fake.ConfigurationTarget.Global]);
    expect(testState().view.dayTarget).toBeUndefined();
    expect(testState().prefs.targets.dayMax).toBeUndefined();
    deactivate();
  });

  it("setTarget without a value asks with an input box (current amount prefilled, validated); cancel writes nothing; empty clears", async () => {
    const { fake, cmd, deactivate } = await load({ monthlyTargetMax: 60 });
    let box: { prompt: string; value: string; validateInput: (t: string) => string | undefined } | undefined;
    fake.window.showInputBox = (async (o: typeof box) => {
      box = o;
      return undefined;
    }) as never;
    await cmd("setTarget")("month", "max");
    expect(box!.value).toBe("60");
    expect(box!.prompt).toBe("Monthly target (most) in USD, as estimated cost. Leave empty to clear it.");
    expect(box!.validateInput("12.5")).toBeUndefined();
    expect(box!.validateInput("")).toBeUndefined();
    expect(box!.validateInput("abc")).toMatch(/number/);
    expect(box!.validateInput("-3")).toMatch(/number/);
    expect(fake.state.updates).toEqual([]);
    fake.window.showInputBox = (async () => "  ") as never;
    await cmd("setTarget")("month", "max");
    expect(fake.state.updates).toEqual([["monthlyTargetMax", undefined, fake.ConfigurationTarget.Global]]);
    fake.window.showInputBox = (async (o: { value: string }) => (o.value === "" ? "42" : "x")) as never;
    await cmd("setTarget")("day", "max");
    expect(fake.state.updates.at(-1)).toEqual(["dailyTargetMax", 42, fake.ConfigurationTarget.Global]);
    deactivate();
  });

  it("setTarget with no arguments offers the four targets with their current amounts, then asks", async () => {
    const { fake, cmd, deactivate } = await load({ dailyTargetMax: 5, currency: "CAD" });
    let offered: { label: string; description: string }[] = [];
    fake.window.showQuickPick = (async (items: typeof offered) => {
      offered = items;
      return undefined;
    }) as never;
    await cmd("setTarget")();
    expect(offered.map((i) => i.label)).toEqual(["Daily target (most)", "Weekly target (most)", "Monthly target (least)", "Monthly target (most)"]);
    expect(offered.map((i) => i.description)).toEqual(["CA$5.00", "not set", "not set", "not set"]);
    expect(fake.state.updates).toEqual([]);
    fake.window.showQuickPick = (async (items: { label: string }[]) => items[1]) as never;
    fake.window.showInputBox = (async () => "20") as never;
    await cmd("setTarget")();
    expect(fake.state.updates).toEqual([["weeklyTargetMax", 20, fake.ConfigurationTarget.Global]]);
    deactivate();
  });

  it("setTargetAlert: on, off, a boolean, a toggle; junk is ignored; user settings only", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    const G = fake.ConfigurationTarget.Global;
    await cmd("setTargetAlert")("on");
    expect(testState().prefs.targetAlert).toBe(true);
    await cmd("setTargetAlert")();
    expect(testState().prefs.targetAlert).toBe(false);
    await cmd("setTargetAlert")(true);
    await cmd("setTargetAlert")("off");
    for (const bad of ["yes", "ON", 1, null, ["on"]]) await cmd("setTargetAlert")(bad);
    expect(fake.state.updates).toEqual([["targetAlert", true, G], ["targetAlert", false, G], ["targetAlert", true, G], ["targetAlert", false, G]]);
    deactivate();
  });

  it("openVsCodeSettings opens VS Code's Settings editor at the extension; showSettings opens the panel's section", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    await cmd("openVsCodeSettings")();
    expect(fake.state.executed).toEqual([["workbench.action.openSettings", "@ext:local.copilot-usage-monitor"]]);
    cmd("showSettings")();
    expect(testState().panelSection).toBe("settings");
    expect(fake.state.updates).toEqual([]);
    deactivate();
  });

  it("prefs: read from the settings, junk falls back, and follow every change in the section", async () => {
    const { fake, testState, deactivate } = await load({ statusBar: "session", dailyTargetMax: 3, weeklyTargetMax: -1, monthlyTargetMin: "x", monthlyTargetMax: 0, targetAlert: true, historyMonths: 6, projectNames: false, codex: false });
    expect(testState().prefs).toEqual({
      currency: "USD",
      statusBar: "session",
      targets: { dayMax: 3, monthMax: 0 },
      targetAlert: true,
      historyMonths: 6,
      projectNames: false,
      sessionTotals: true,
      sources: { claudeCode: true, codex: false },
      unsaved: [],
    });
    fake.state.global[`${SECTION}.currency`] = "CAD";
    fake.fireConfigChange(`${SECTION}.currency`);
    expect(testState().prefs.currency).toBe("CAD");
    fake.state.global[`${SECTION}.statusBar`] = "bogus";
    fake.fireConfigChange(`${SECTION}.statusBar`);
    expect(testState().prefs.statusBar).toBe("today");
    deactivate();
  });
});

describe("extension lifecycle: viewed month across restarts (F4)", () => {
  it("a viewed month outside a shorter history is cleared on restart", async () => {
    const { fake, cmd, testState, deactivate } = await load({ historyMonths: 12 });
    const now = new Date();
    const current = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const old = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    const key = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, "0")}`;
    await vi.waitFor(() => expect(testState().snapshot?.history).toHaveLength(12));
    await cmd("selectMonth")(key);
    await vi.waitFor(() => expect(testState().snapshot?.month?.monthStartMs).toBe(old.getTime()));
    for (const months of [3, 12]) {
      fake.state.global[`${SECTION}.historyMonths`] = months;
      fake.fireConfigChange(`${SECTION}.historyMonths`);
    }
    await vi.waitFor(() => expect(testState().snapshot?.history).toHaveLength(12));
    expect(testState().snapshot?.month?.monthStartMs).toBe(current);
    deactivate();
  });
});

describe("extension lifecycle: Claude Code and Codex sources (D48, D49)", () => {
  it("both sources are passed by default, each with its resolved root", async () => {
    const { deactivate } = await load();
    expect(built).toHaveLength(1);
    expect(built[0]!.sources).toEqual({
      claude: { root: join(home, "claude"), rootSource: "setting" },
      codex: { root: join(home, "codex"), rootSource: "setting" },
    });
    deactivate();
  });

  it("claudeCode: false constructs the monitor without sources.claude", async () => {
    const { deactivate } = await load({ claudeCode: false });
    expect(built).toHaveLength(1);
    expect(built[0]!.sources?.claude).toBeUndefined();
    expect(built[0]!.sources?.codex).toBeDefined();
    deactivate();
  });

  it("a claudeCode change restarts the monitor exactly once", async () => {
    const { fake, deactivate } = await load();
    expect(built).toHaveLength(1);
    fake.state.global[`${SECTION}.claudeCode`] = false;
    fake.fireConfigChange(`${SECTION}.claudeCode`);
    expect(built).toHaveLength(2);
    expect(built[1]!.sources?.claude).toBeUndefined();
    fake.fireConfigChange(`${SECTION}.claudeCode`); // no value change: no restart
    expect(built).toHaveLength(2);
    fake.state.global[`${SECTION}.claudeCode`] = true;
    fake.fireConfigChange(`${SECTION}.claudeCode`);
    expect(built).toHaveLength(3);
    expect(built[2]!.sources?.claude).toBeDefined();
    deactivate();
  });

  it("codex, claudeHome and codexHome changes restart once each; an unchanged value does not", async () => {
    const { fake, deactivate } = await load();
    fake.state.global[`${SECTION}.codex`] = false;
    fake.fireConfigChange(`${SECTION}.codex`);
    expect(built).toHaveLength(2);
    expect(built[1]!.sources?.codex).toBeUndefined();
    fake.state.global[`${SECTION}.claudeHome`] = join(home, "claude2");
    fake.fireConfigChange(`${SECTION}.claudeHome`);
    expect(built).toHaveLength(3);
    expect(built[2]!.sources?.claude?.root).toBe(join(home, "claude2"));
    fake.fireConfigChange(`${SECTION}.claudeHome`);
    fake.fireConfigChange(`${SECTION}.codexHome`); // codex is off: its folder does not matter
    expect(built).toHaveLength(3);
    deactivate();
  });

  it("setFilter accepts a source, clears it with an empty value, and ignores an unknown one", async () => {
    const { cmd, testState, deactivate } = await load();
    await vi.waitFor(() => expect(testState().snapshot).toBeDefined());
    await cmd("setFilter")("source", "codex");
    await vi.waitFor(() => expect(testState().snapshot?.filter?.source).toBe("codex"));
    await cmd("setFilter")("source", "nope");
    await cmd("setFilter")("source", { evil: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(testState().snapshot?.filter?.source).toBe("codex");
    await cmd("setFilter")("source", "");
    await vi.waitFor(() => expect(testState().snapshot?.filter?.source).toBeUndefined());
    deactivate();
  });

  it("a source filter survives a monitor restart", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    await cmd("setFilter")("source", "claude-code");
    fake.state.global[`${SECTION}.codex`] = false;
    fake.fireConfigChange(`${SECTION}.codex`);
    await vi.waitFor(() => expect(testState().snapshot?.filter?.source).toBe("claude-code"));
    deactivate();
  });
});

describe("extension lifecycle: source filter, batched config events, pinSession items", () => {
  it("turning codex off drops a codex source filter on the one restart", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    await cmd("setFilter")("source", "codex");
    await vi.waitFor(() => expect(testState().snapshot?.filter?.source).toBe("codex"));
    expect(built).toHaveLength(1);
    fake.state.global[`${SECTION}.codex`] = false;
    fake.fireConfigChange(`${SECTION}.codex`);
    expect(built).toHaveLength(2);
    expect(built[1]!.sources?.codex).toBeUndefined();
    await vi.waitFor(() => expect(testState().snapshot).toBeDefined());
    expect(testState().snapshot?.filter?.source).toBeUndefined();
    deactivate();
  });

  it("one config event changing two watched keys constructs exactly one new monitor", async () => {
    const { fake, deactivate } = await load();
    expect(built).toHaveLength(1);
    // The fake's section form: one event for the whole section. Its affectsConfiguration
    // reports only the section itself, so the value-compared settings drive this restart.
    fake.state.global[`${SECTION}.historyMonths`] = 3;
    fake.state.global[`${SECTION}.projectNames`] = false;
    fake.fireConfigChange(SECTION);
    expect(built).toHaveLength(2);
    // An event naming two source keys at once (as VS Code sends for a multi-key settings.json edit).
    fake.state.global[`${SECTION}.claudeCode`] = false;
    fake.state.global[`${SECTION}.codex`] = false;
    const keys = [`${SECTION}.claudeCode`, `${SECTION}.codex`];
    const e = { affectsConfiguration: (x: string) => x === SECTION || keys.includes(x) };
    for (const l of [...fake.state.configListeners]) l(e);
    expect(built).toHaveLength(3);
    expect(built[2]!.sources).toEqual({});
    deactivate();
  });

  it("pinSession items carry the source label and say idle, not ended, for a non-Copilot session", async () => {
    // A fixed mid-month instant fed to the monitor as now: no month or day boundary is near.
    fixedNow.ms = new Date(2026, 9, 15, 12, 0, 0).getTime();
    const ms = fixedNow.ms - 10 * 60 * 1000; // past the live window, so the session is idle
    const d = new Date(ms);
    const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    const id = "c0de0000-0000-4000-8000-000000000001";
    const ts = new Date(ms).toISOString();
    await codexTree(join(home, "codex"), [{ date, sessionId: id, lines: [codexMeta({ id, timestamp: ts }), codexTurn({ timestamp: ts }), codexRecord({ sessionId: id, timestamp: ts })], mtime: new Date(ms) }]);
    const { fake, cmd, testState, deactivate } = await load();
    await vi.waitFor(() => expect(testState().snapshot?.sessions.some((x) => x.source === "codex")).toBe(true));
    expect(testState().snapshot?.generatedAtMs).toBe(fixedNow.ms);
    let captured: { label: string; description?: string }[] = [];
    fake.window.showQuickPick = (async (items: { label: string; description?: string }[]) => {
      captured = items;
      return undefined;
    }) as typeof fake.window.showQuickPick;
    await cmd("pinSession")();
    const row = captured.find((x) => x.label === id.slice(0, 8));
    expect(row).toBeDefined();
    const parts = row!.description!.split(" · ");
    expect(parts[0]).toBe(SOURCE_LABEL.codex);
    expect(parts).toContain("idle");
    expect(parts).not.toContain("ended");
    expect(parts).not.toContain("live");
    deactivate();
  });
});

describe("extension lifecycle: enabled sources only (F3a)", () => {
  it("the filter quick pick lists only enabled sources, and setFilter ignores a source that is off", async () => {
    const { fake, cmd, testState, deactivate } = await load({ codex: false });
    await vi.waitFor(() => expect(testState().snapshot?.health.sources).toBeDefined());
    expect(Object.keys(testState().snapshot!.health.sources!)).toEqual(["copilot", "claude-code"]);
    let captured: { label: string; filterKind?: string }[] = [];
    fake.window.showQuickPick = (async (items: { label: string; filterKind?: string }[]) => {
      captured = items;
      return undefined;
    }) as typeof fake.window.showQuickPick;
    await cmd("setFilter")();
    expect(captured.filter((x) => x.filterKind === "source").map((x) => x.label)).toEqual([SOURCE_LABEL.copilot, SOURCE_LABEL["claude-code"]]);
    await cmd("setFilter")("source", "codex");
    await vi.advanceTimersByTimeAsync(1000);
    expect(testState().snapshot?.filter?.source).toBeUndefined();
    await cmd("setFilter")("source", "claude-code");
    await vi.waitFor(() => expect(testState().snapshot?.filter?.source).toBe("claude-code"));
    deactivate();
  });

  it("pinSession items have no source label when Copilot is the only source", async () => {
    const { fake, cmd, testState, deactivate } = await load({ claudeCode: false, codex: false });
    await vi.waitFor(() => expect(testState().snapshot?.health.sources).toBeDefined());
    // A session list as the monitor would report it; only its description is under test.
    testState().snapshot!.sessions = [{ folderId: "aaaa0000-0000-4000-8000-000000000001", live: false, source: "copilot" }];
    let captured: { label: string; description?: string }[] = [];
    fake.window.showQuickPick = (async (items: { label: string; description?: string }[]) => {
      captured = items;
      return undefined;
    }) as typeof fake.window.showQuickPick;
    await cmd("pinSession")();
    expect(captured.find((x) => x.label === "aaaa0000")?.description).toBe("ended · no per-call records");
    deactivate();
  });
});

describe("target alert: Don't show again (F3)", () => {
  it("a rejected targetAlert write is logged, with no unhandled rejection", async () => {
    vi.resetModules();
    const fake: Fake = await import("../fakes/vscode");
    const { TargetAlert } = await import("../../src/vscode/targetAlert");
    const { Logger } = await import("../../src/core/log");
    fake.state.global[`${SECTION}.targetAlert`] = true;
    fake.state.infoPick = "Don't show again";
    fake.state.updateReject = true;
    const lines: string[] = [];
    const alert = new TargetAlert(() => undefined, new Logger((l) => lines.push(l)));
    const day = new Date(2026, 10, 6).getTime();
    const m = (sum: number) => ({ sum, reported: 1, missing: 0 });
    const thisMonth = { records: 1, calls: 1, callsMissing: 0, sessionTotals: 0, input: m(10), output: m(1), cacheRead: m(0), cacheWrite: m(0), reasoning: m(0), durationMs: m(0), nanoAiu: m(80e11), callNanoAiu: m(80e11), byModel: {} };
    const health = { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0 };
    alert.check({ generatedAtMs: day, dayStartMs: day, sessions: [], health, thisMonth } as unknown as Snapshot, { unit: "cost", range: { max: 60 } });
    expect(alert.shown).toBe(1);
    await settle();
    expect(lines).toEqual(["error alert.mute WRITE_FAILED"]);
  });
});

describe("exchange rate: response size cap (F5)", () => {
  it("a 64 KiB rate body is rejected", async () => {
    const { fetchUsdRate } = await import("../../src/vscode/exchangeRate");
    const big = JSON.stringify({ base: "USD", date: "2026-11-06", rates: { CAD: 1.4 }, pad: " ".repeat(64 * 1024) });
    vi.stubGlobal("fetch", async () => new Response(big, { status: 200 }));
    await expect(fetchUsdRate("CAD")).rejects.toThrow("BAD_RESPONSE");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024) } }));
    await expect(fetchUsdRate("CAD")).rejects.toThrow("BAD_RESPONSE");
  });

  it("a normal rate body still parses", async () => {
    const { fetchUsdRate } = await import("../../src/vscode/exchangeRate");
    vi.stubGlobal("fetch", async () => ok("CAD"));
    await expect(fetchUsdRate("CAD")).resolves.toEqual({ code: "CAD", rate: 1.4, date: "2026-11-06" });
  });
});
