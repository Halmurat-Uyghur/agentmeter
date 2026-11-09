// Review finding #8: Copilot's per-model "separate" input convention (input reported apart
// from the cache) is inferred from Copilot calls only, so it must never reinterpret a
// Claude Code or Codex record whose model id happens to match. Their input is normalized
// at ingestion to uncached + cache read + cache write (D47).
import { describe, expect, it } from "vitest";
import { sessionDetail, uncachedOf } from "../../src/core/explain";
import type { PromptConvention } from "../../src/core/insights";
import type { Source, UsageRecord } from "../../src/core/types";

const SEPARATE = new Map<string, PromptConvention>([["shared-model", "separate"]]);

function rec(source: Source, n: number): UsageRecord {
  return {
    key: `${source}${n}`,
    keySource: "usageId",
    kind: "call",
    source,
    sessionId: "s1",
    folderId: "s1",
    timestampMs: 1_000 + n,
    sequence: n,
    model: "shared-model",
    tokens: { input: 1_000, cacheRead: 200, cacheWrite: 100, output: 10 },
  };
}

describe("uncachedOf keys the Copilot convention on the source", () => {
  it("a Copilot call of a 'separate' model: input is already the uncached part", () => {
    expect(uncachedOf(rec("copilot", 1), SEPARATE)).toBe(1_000);
  });

  it.each<Source>(["claude-code", "codex"])("a %s call with the same model id: input includes the cache", (src) => {
    expect(uncachedOf(rec(src, 1), SEPARATE)).toBe(700);
  });

  it("the session ledger shows 700 uncached for the Claude call, 1,000 for the Copilot one", () => {
    const d = sessionDetail("s1", [rec("copilot", 1), rec("claude-code", 2)], SEPARATE);
    const by = Object.fromEntries(d.rows.map((r) => [r.timestampMs, r.uncached]));
    expect(by[1_001]).toBe(1_000);
    expect(by[1_002]).toBe(700);
  });
});
