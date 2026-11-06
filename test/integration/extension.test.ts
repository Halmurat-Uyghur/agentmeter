// Extension-host smoke tests (Mocha, run by `npm run test:integration`).
// COPILOT_HOME points at a synthetic fixture root (see .vscode-test.mjs).
import * as assert from "node:assert";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { jsonl, sessionTree, usageEvent } from "../fixtures/build";

const ROOT = join(tmpdir(), "copilot-usage-monitor-fixture");
const LIVE = "0000aaaa-0000-4000-8000-000000000001";

interface TestState {
  statusText: string;
  tooltip: string;
  panelOpen: boolean;
  panelTitle?: string;
}

const state = () => vscode.commands.executeCommand<TestState>("copilotUsageMonitor._testState");

async function waitFor(pred: (s: TestState) => boolean, ms = 5000): Promise<TestState> {
  const start = Date.now();
  for (;;) {
    const s = await state();
    if (pred(s)) return s;
    if (Date.now() - start > ms) throw new Error(`timed out; last status: ${s.statusText}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const config = () => vscode.workspace.getConfiguration("copilotUsageMonitor");

suite("Copilot Usage Monitor", () => {
  suiteSetup(async () => {
    await rm(ROOT, { recursive: true, force: true });
    const now = Date.now();
    const sessions: Parameters<typeof sessionTree>[1] = [];
    for (let i = 0; i < 200; i++) {
      const id = `0000${String(i).padStart(4, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;
      sessions.push({
        id,
        lines: jsonl([usageEvent({ usageId: `seed-${i}`, id: `e-${i}`, sourceSessionId: id, timestamp: new Date(now - 60_000).toISOString() })]),
      });
    }
    sessions.push({ id: LIVE, lines: jsonl([usageEvent({ usageId: "live-0", sourceSessionId: LIVE })]), lockPid: process.pid });
    await sessionTree(ROOT, sessions);
    const ext = vscode.extensions.getExtension("local.copilot-usage-monitor");
    assert.ok(ext, "extension present");
    await ext.activate();
    await vscode.commands.executeCommand("copilotUsageMonitor.refresh");
  });

  test("activates and shows status text", async () => {
    const s = await waitFor((x) => x.statusText.startsWith("$(pulse) Local today:") && x.statusText.endsWith("tok"), 3000);
    assert.match(s.tooltip, /Locally observed from Copilot session logs/);
  });

  test("updates within 2 s of a complete usage line", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const before = (await state()).statusText;
      const t0 = Date.now();
      await appendFile(
        join(ROOT, "session-state", LIVE, "events.jsonl"),
        jsonl([usageEvent({ usageId: `live-${i + 1}`, id: `le-${i}`, sourceSessionId: LIVE, inputTokens: 100_000 })]),
      );
      await waitFor((x) => x.statusText !== before, 5000);
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1]!;
    console.log(`latency median ${samples[10]}ms p95 ${p95}ms max ${samples.at(-1)}ms`);
    assert.ok(p95 < 2000, `p95 ${p95}`);
    assert.ok(samples.at(-1)! < 5000);
  });

  test("showDetails opens the panel", async () => {
    await vscode.commands.executeCommand("copilotUsageMonitor.showDetails");
    const s = await waitFor((x) => x.panelOpen);
    assert.strictEqual(s.panelTitle, "Copilot Usage (Local)");
  });

  test("no-dir tooltip names the setting, and a setting change re-roots", async () => {
    await config().update("copilotHome", join(ROOT, "missing"), vscode.ConfigurationTarget.Global);
    try {
      const s = await waitFor((x) => x.statusText === "$(circle-slash) Copilot logs not found");
      assert.match(s.tooltip, /copilotUsageMonitor\.copilotHome/);
    } finally {
      await config().update("copilotHome", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor((x) => x.statusText.startsWith("$(pulse) Local today:"));
  });

  test("the folder setting is machine-scoped", () => {
    const ext = vscode.extensions.getExtension("local.copilot-usage-monitor")!;
    const prop = ext.packageJSON.contributes.configuration.properties["copilotUsageMonitor.copilotHome"];
    assert.strictEqual(prop.scope, "machine");
  });

  suiteTeardown(async () => {
    await mkdir(ROOT, { recursive: true });
  });
});
