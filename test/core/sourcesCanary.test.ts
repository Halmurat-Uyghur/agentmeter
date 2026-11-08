// Canary end-to-end (Task 12, D53): a monitor over all three fixture trees, every
// content field poisoned with its source's canary, renders every surface the user
// sees (panel sections, side bar, tooltip, status text) and the snapshot itself;
// no canary, no fixture path and no path in the log sink may appear in any of them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tooltipMarkdown, statusText } from "../../src/core/format";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import { renderPanelHtml, SECTIONS } from "../../src/core/panelHtml";
import { buildSidebarModel } from "../../src/core/sidebarModel";
import { renderSidebarHtml } from "../../src/core/sidebarHtml";
import { NO_PROJECT } from "../../src/core/store";
import type { Snapshot, ViewOptions } from "../../src/core/types";
import { CANARY, jsonl, otherEvent, sessionTree, shutdownEvent, usageEvent } from "../fixtures/build";
import { CLAUDE_CANARY, claudeAssistantLine, claudeOtherLine, claudeTree, claudeUserLine } from "../fixtures/claude";
import { CODEX_CANARY, codexMeta, codexOther, codexRecord, codexTokenCount, codexTree, codexTurn } from "../fixtures/codex";

const CANARIES = [CANARY, CLAUDE_CANARY, CODEX_CANARY];
const A = "0000aaaa-0000-4000-8000-000000000001";
const CS = "c1a0de00-0000-4000-8000-000000000001";
const XS = "c0de0000-0000-4000-8000-000000000001";
// A fixed local "today"; every timestamp and mtime is relative to it.
const T0 = new Date(2026, 10, 8, 12, 0, 0).getTime();
const HOT = T0 - 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let logLines: string[];
let snaps: Snapshot[];
let monitor: UsageMonitor | undefined;

/** Copilot, Claude Code and Codex trees, dated today, every content field a canary. */
async function trees(): Promise<void> {
  const copilotStart = { type: "session.start", id: "s", parentId: null, timestamp: iso(T0 - 7_200_000), data: { copilotVersion: "1.0.100-1", context: { branch: CANARY, cwd: `/${CANARY}/copilot-proj` }, prompt: CANARY } };
  await sessionTree(join(dir, "copilot"), [{
    id: A,
    mtime: new Date(HOT),
    lines: jsonl([
      copilotStart,
      otherEvent("user.message"),
      usageEvent({ usageId: "u-1", id: "e-1", sourceSessionId: A, timestamp: iso(T0 - 3_600_000) }),
      otherEvent("tool.execution_complete", { timestamp: iso(T0 - 3_500_000) }),
      usageEvent({ usageId: "u-2", id: "e-2", sourceSessionId: A, timestamp: iso(T0 - 3_400_000), model: "model-b" }),
      shutdownEvent(),
    ]),
  }]);
  const claude = (n: number, extra: Parameters<typeof claudeAssistantLine>[0] = {}) =>
    claudeAssistantLine({ id: `msg_c_${n}`, requestId: `req_c_${n}`, sessionId: CS, timestamp: iso(T0 - 3_000_000 + n * 1000), ...extra });
  await claudeTree(join(dir, "claude"), [{
    sessionId: CS,
    mtime: HOT,
    lines: [
      claudeUserLine({ sessionId: CS }),
      claude(1, { tools: ["Bash", "Read"], thinking: 40 }),
      claudeOtherLine("attachment"),
      claudeUserLine({ sessionId: CS }),
      claude(2, { tools: ["Edit"] }),
      claudeOtherLine("last-prompt"),
    ],
    subagents: [{ id: "a1b2c3", lines: [claude(3, { isSidechain: true, tools: ["Grep"] })] }],
  }]);
  await codexTree(join(dir, "codex"), [{
    date: "2026/11/08",
    sessionId: XS,
    mtime: HOT,
    lines: [
      codexMeta({ id: XS, timestamp: iso(T0 - 2_000_000) }),
      codexTurn({ timestamp: iso(T0 - 2_000_000) }),
      codexOther("response_item", "message"),
      codexRecord({ sessionId: XS, responseId: "resp_x_1", timestamp: iso(T0 - 1_900_000) }),
      codexTokenCount({ timestamp: iso(T0 - 1_900_000) }),
      codexOther("event_msg", "agent_message"),
      codexRecord({ sessionId: XS, responseId: "resp_x_2", timestamp: iso(T0 - 1_800_000), ordinal: 6 }),
    ],
  }]);
}

function make(readProjects: boolean): UsageMonitor {
  monitor = new UsageMonitor({
    root: join(dir, "copilot"),
    rootSource: "default",
    now: () => new Date(T0),
    isLive: () => false,
    log: new Logger((l) => logLines.push(l)),
    onSnapshot: (s) => snaps.push(s),
    readProjects,
    readTotals: true,
    historyMonths: 2,
    sources: { claude: { root: join(dir, "claude"), rootSource: "default" }, codex: { root: join(dir, "codex"), rootSource: "default" } },
  });
  return monitor;
}

const last = (): Snapshot => {
  const s = snaps.at(-1);
  if (!s) throw new Error("no snapshot");
  return s;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cum-canary-"));
  logLines = [];
  snaps = [];
  await trees();
});

afterEach(async () => {
  monitor?.dispose();
  monitor = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("canary end-to-end over all three sources (D53)", () => {
  it("no canary or fixture path reaches the snapshot, panel, side bar, tooltip, status text or log", async () => {
    make(true);
    await monitor!.refresh({ full: true });
    const s = last();
    // the fixtures were read: all three sources contributed records, and project labels are the last cwd segment only
    expect(s.today?.bySource?.copilot?.records ?? 0).toBeGreaterThan(0);
    expect(s.today?.bySource?.["claude-code"]?.records ?? 0).toBeGreaterThan(0);
    expect(s.today?.bySource?.codex?.records ?? 0).toBeGreaterThan(0);
    const names = (s.month?.projects ?? []).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["myrepo", "codex-proj"]));

    const outputs: [string, string][] = [["snapshot", JSON.stringify(s)]];
    for (const unit of ["tokens", "cost"] as const) {
      const view: ViewOptions = { unit };
      for (const section of SECTIONS) {
        for (const collapsed of [false, true]) outputs.push([`panel ${section} ${unit} ${collapsed}`, renderPanelHtml(s, "x", view, section, collapsed)]);
      }
      outputs.push([`sidebar ${unit}`, renderSidebarHtml(buildSidebarModel(s, view, ["repo"]), "x")]);
      outputs.push([`tooltip ${unit}`, tooltipMarkdown(s, view)]);
      for (const statusBar of ["today", "month", "session"] as const) outputs.push([`status ${unit} ${statusBar}`, statusText(s, { unit, statusBar })]);
    }
    expect(outputs).toHaveLength(1 + 2 * (SECTIONS.length * 2 + 1 + 1 + 3));
    const leaks = (t: string) => [...CANARIES, dir, basename(dir)].filter((c) => t.includes(c));
    for (const [what, text] of outputs) {
      expect(text.length, what).toBeGreaterThan(0);
      expect(leaks(text), what).toEqual([]);
    }

    // The log sink: identifiers, codes and integers only, never a path segment of the fixture root or a canary.
    expect(logLines.length).toBeGreaterThan(0);
    const segments = dir.split(sep).filter((x) => x !== "").map((x) => `${sep}${x}`);
    for (const line of logLines) {
      expect(line.includes("/") || line.includes("\\"), line).toBe(false);
      expect(segments.filter((x) => line.includes(x)), line).toEqual([]);
      expect(leaks(line), line).toEqual([]);
    }
  });

  it("with readProjects false, the new sources produce no project label (only \"(no project)\")", async () => {
    make(false);
    await monitor!.refresh({ full: true });
    const s = last();
    const rows = (s.month?.projects ?? []).filter((p) => (p.sources?.["claude-code"] ?? 0) + (p.sources?.codex ?? 0) > 0);
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) {
      expect(p.name).toBe(NO_PROJECT);
      expect(p.label).toBeUndefined();
    }
    const json = JSON.stringify(s);
    for (const label of ["myrepo", "codex-proj"]) expect(json).not.toContain(label);
    for (const c of CANARIES) expect(json).not.toContain(c);
  });
});
