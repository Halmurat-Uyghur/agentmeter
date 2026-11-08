import { describe, expect, it } from "vitest";
import { emptyReadResult, RECENT_MS } from "../../src/core/source";
import { isSource, SOURCE_LABEL, SOURCES } from "../../src/core/types";

describe("source contract (D40, D54)", () => {
  it("SOURCES are in UI order with fixed labels", () => {
    expect(SOURCES).toEqual(["copilot", "claude-code", "codex"]);
    expect(SOURCES.map((s) => SOURCE_LABEL[s])).toEqual(["Copilot", "Claude Code", "Codex"]);
  });

  it("isSource accepts only members of SOURCES", () => {
    for (const s of SOURCES) expect(isSource(s)).toBe(true);
    for (const x of ["", "Copilot", "claude", "__proto__", "constructor", 1, null, undefined, {}]) expect(isSource(x)).toBe(false);
  });

  it("emptyReadResult is a fresh zeroed result each call", () => {
    const a = emptyReadResult();
    expect(a).toEqual({
      reset: false,
      records: [],
      activity: 0,
      suspect: 0,
      unrecognized: 0,
      malformed: 0,
      overlong: 0,
      overlongOther: 0,
      shutdownOversize: 0,
      hasTotals: false,
      usage: 0,
    });
    a.records.push({} as never);
    expect(emptyReadResult().records).toEqual([]);
  });

  it("RECENT_MS is five minutes", () => {
    expect(RECENT_MS).toBe(300_000);
  });
});
