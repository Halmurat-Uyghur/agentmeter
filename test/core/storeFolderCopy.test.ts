import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/log";
import { UsageMonitor } from "../../src/core/monitor";
import type { Snapshot } from "../../src/core/types";
import { jsonl, sessionTree, shutdownEvent, usageEvent } from "../fixtures/build";

// D29 end to end: a session folder copied (or forked) under another UUID-shaped name holds
// the same usageIds and the same shutdown line. Each folder holds per-call records, so
// neither folder's session total may count, and the shared calls count once.

const A = "0000aaaa-0000-4000-8000-000000000001";
const B = "0000bbbb-0000-4000-8000-000000000002";
const T0 = new Date(2026, 0, 15, 10, 0, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 0, 15, h, m, 0).toISOString();

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("copied session folder (D29)", () => {
  it("a session folder copied under another id counts its calls once and its total not at all", async () => {
    root = await mkdtemp(join(tmpdir(), "cum-copy-"));
    const lines = jsonl([
      usageEvent({ usageId: "u1", id: "e1", sourceSessionId: A, timestamp: at(9, 1) }),
      usageEvent({ usageId: "u2", id: "e2", sourceSessionId: A, timestamp: at(9, 2) }),
      shutdownEvent({ timestamp: at(9, 30), models: { "model-a": { requests: 2, inputTokens: 2000, outputTokens: 400 } } }),
    ]);
    await sessionTree(root, [{ id: A, lines }, { id: B, lines }]);
    const snaps: Snapshot[] = [];
    const m = new UsageMonitor({ root, rootSource: "default", now: () => new Date(T0), isLive: () => false, readTotals: true, log: new Logger(() => {}), onSnapshot: (s) => snaps.push(s) });
    try {
      await m.refresh({ full: true });
    } finally {
      m.dispose();
    }
    const t = snaps.at(-1)!.today!;
    expect({ records: t.records, calls: t.calls, sessionTotals: t.sessionTotals }).toEqual({ records: 2, calls: 2, sessionTotals: 0 });
  });
});
