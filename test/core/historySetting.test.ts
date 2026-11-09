// HOST-3: historyMonths as read by extension.ts (readHistory). VS Code's get() returns the raw
// settings.json value, so an ill-typed value ("6", true, null) falls back to the manifest
// default 12 like every other setting reader, not to clampHistory's 1. A number keeps
// clamping to 1..24. Ported from the review harness (host/history.test.ts).
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MonitorOptions } from "../../src/core/monitor";

/** historyMonths of every UsageMonitor the extension constructs (survives vi.resetModules). */
const built = vi.hoisted(() => [] as number[]);
vi.mock("../../src/core/monitor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/monitor")>();
  class Spy extends mod.UsageMonitor {
    constructor(o: MonitorOptions) {
      super(o);
      built.push(o.historyMonths ?? -1);
    }
  }
  return { ...mod, UsageMonitor: Spy };
});

const SECTION = "copilotUsageMonitor";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "history-setting-"));
  mkdirSync(join(home, "session-state"));
  built.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("fetch", () => new Promise(() => {}));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

/** The historyMonths the first monitor is built with, for a raw settings.json value (absent when undefined). */
async function historyFor(value: unknown): Promise<number | undefined> {
  vi.resetModules();
  const fake = await import("../fakes/vscode");
  Object.assign(fake.state.global, {
    [`${SECTION}.copilotHome`]: home,
    [`${SECTION}.claudeCode`]: false,
    [`${SECTION}.codex`]: false,
    ...(value !== undefined && { [`${SECTION}.historyMonths`]: value }),
  });
  const ext = await import("../../src/extension");
  const ctx = { subscriptions: [] as { dispose(): unknown }[], extensionMode: fake.ExtensionMode.Test };
  ext.activate(ctx as never);
  try {
    return built.at(-1);
  } finally {
    for (const d of ctx.subscriptions) d.dispose();
  }
}

it.each([["6"], [true], [null], [Number.NaN], [undefined], [{}]])("a non-number historyMonths (%o) falls back to the default 12", async (v) => {
  expect(await historyFor(v)).toBe(12);
});

it.each([
  [6, 6],
  [0, 1],
  [99, 24],
  [6.7, 6],
])("a numeric historyMonths %j still clamps to %j", async (v, want) => {
  expect(await historyFor(v)).toBe(want);
});
