// v0.10: estimated cost for Claude Code and Codex calls from list prices (src/core/pricing.ts).
import { describe, expect, it } from "vitest";
import { estimateNanoAiu, priceOf, PRICES_AS_OF } from "../../src/core/pricing";
import type { Source, Tokens } from "../../src/core/types";

/** USD → nano-AIU, the unit the store sums (1 USD = 1e11). */
const nano = (usd: number) => Math.round(usd * 1e11);
const est = (source: Source, model: string | undefined, tokens: Tokens) => estimateNanoAiu({ source, model, tokens });

describe("priceOf", () => {
  it("knows every model seen in the development machine's logs on 2026-11-08", () => {
    for (const m of ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-sonnet-5-5", "claude-opus-4-8", "claude-haiku-5-5", "claude-sonnet-4-6"])
      expect(priceOf("claude-code", m), m).toBeDefined();
    for (const m of ["gpt-6-astra", "gpt-5.6-terra", "gpt-6.1-sol"]) expect(priceOf("codex", m), m).toBeDefined();
  });
  it("drops a trailing release date, never matches by prefix, and never prices Copilot", () => {
    expect(priceOf("claude-code", "claude-haiku-4-5-20251001")).toEqual(priceOf("claude-code", "claude-haiku-4-5"));
    expect(priceOf("claude-code", "claude-opus-5-5-preview")).toBeUndefined();
    expect(priceOf("codex", "codex-auto-review")).toBeUndefined();
    expect(priceOf("codex", "claude-opus-5-5")).toBeUndefined();
    expect(priceOf("copilot", "claude-opus-5-5")).toBeUndefined();
    expect(priceOf("claude-code", undefined)).toBeUndefined();
    expect(priceOf("claude-code", "__proto__")).toBeUndefined();
    expect(priceOf("claude-code", "toString")).toBeUndefined();
  });
  it("the as-of date is a calendar date", () => {
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("estimateNanoAiu", () => {
  it("Claude Code: input holds reads and writes; writes at the 1-hour rate; reads at the model's own rate", () => {
    // Opus 5.5: $4 in, $8 1h write, $0.20 read, $20 out per MTok
    const t: Tokens = { input: 1_000_000 + 2_000_000 + 500_000, cacheRead: 2_000_000, cacheWrite: 500_000, output: 100_000, reasoning: 40_000 };
    expect(est("claude-code", "claude-opus-5-5", t)).toBe(nano(1 * 4 + 2 * 0.2 + 0.5 * 8 + 0.1 * 20));
    // Fable 5.1 reads at $0.25 (0.025× input)
    expect(est("claude-code", "claude-fable-5-1", { input: 1_000_000, cacheRead: 1_000_000, output: 0 })).toBe(nano(0.25));
  });
  it("Codex: input holds cache reads only; cache writes are added on top at the 30-minute rate", () => {
    // gpt-6-astra: $10 in, $1 read, $12.50 write, $50 out per MTok
    const t: Tokens = { input: 100_000, cacheRead: 40_000, cacheWrite: 10_000, output: 20_000, reasoning: 15_000 };
    expect(est("codex", "gpt-6-astra", t)).toBe(nano((60_000 * 10 + 40_000 * 1 + 10_000 * 12.5 + 20_000 * 50) / 1e6));
  });
  it("a prompt over the long-context threshold uses the long rate for the whole call", () => {
    expect(est("codex", "gpt-6.1-sol", { input: 272_000, output: 0 })).toBe(nano(0.272 * 2));
    expect(est("codex", "gpt-6.1-sol", { input: 272_001, output: 0 })).toBe(nano(0.272001 * 4));
    expect(est("claude-code", "claude-haiku-5-5", { input: 100_001, output: 1_000 })).toBe(nano(0.100001 * 0.5 + 0.001 * 2.5));
    expect(est("claude-code", "claude-haiku-5-5", { input: 100_000, output: 1_000 })).toBe(nano(0.1 * 0.1 + 0.001 * 0.5));
  });
  it("unknown model → undefined (shown as missing); no tokens → 0 whatever the model; Copilot → undefined", () => {
    expect(est("codex", "codex-auto-review", { input: 10, output: 5 })).toBeUndefined();
    expect(est("claude-code", undefined, { input: 10 })).toBeUndefined();
    expect(est("claude-code", "<synthetic>", { input: 0, output: 0 })).toBe(0);
    expect(est("claude-code", "<synthetic>", {})).toBe(0);
    expect(est("copilot", "claude-opus-5-5", { input: 10 })).toBeUndefined();
  });
  it("never goes negative when reads exceed the logged input", () => {
    expect(est("claude-code", "claude-sonnet-5-5", { input: 10, cacheRead: 50, output: 0 })).toBe(nano((50 * 0.1) / 1e6));
  });
});
