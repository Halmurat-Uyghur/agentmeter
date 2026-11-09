// A large week-on-week drop (ratio under 0.05) read "▼ 0.0×" (review UI-1).
import { describe, expect, it } from "vitest";
import { spoken, weekChange } from "../../src/core/format";

describe("weekChange: a ratio that rounds to 0.0", () => {
  it("reads '▼ <0.1×', not '▼ 0.0×'", () => {
    expect(weekChange(1, 25)).toBe("▼ <0.1× the 7 days before");
    expect(weekChange(1_000_000, 25_000_000)).toBe("▼ <0.1× the 7 days before");
  });
  it("a ratio that rounds to 0.1 is unchanged", () => {
    expect(weekChange(5, 100)).toBe("▼ 0.1× the 7 days before");
  });
  it("is spoken as 'less than 0.1 times'", () => {
    expect(spoken(weekChange(1, 25)!)).toBe("down less than 0.1 times the 7 days before");
  });
});
