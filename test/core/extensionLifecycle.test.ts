// src/extension.ts and src/vscode/* against the fake `vscode` module (test/fakes/vscode.ts,
// aliased in vitest.config.ts): the rate timer's lifecycle (F1), the unit command (F2),
// the alert's "Don't show again" write (F3), the viewed month across restarts (F4) and
// the rate response size cap (F5). Ported from review agent 7's harness (v0.7).
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorOptions } from "../../src/core/monitor";
import type { Snapshot, ViewOptions } from "../../src/core/types";

/** Every UsageMonitor the extension constructs, with its options (survives vi.resetModules). */
const built = vi.hoisted(() => [] as { sources?: MonitorOptions["sources"] }[]);
vi.mock("../../src/core/monitor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/monitor")>();
  class Spy extends mod.UsageMonitor {
    constructor(o: MonitorOptions) {
      super(o);
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
    testState: () => cmd("_testState")() as { snapshot?: Snapshot; view: ViewOptions },
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

  it("a rejected display write rolls the unit back", async () => {
    const { fake, cmd, testState, deactivate } = await load();
    fake.state.updateReject = true;
    await expect(cmd("setUnit")("cost")).resolves.toBeUndefined();
    expect(testState().view.unit).toBe("tokens");
    expect(fake.state.log).toContain("error unit.write WRITE_FAILED");
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
