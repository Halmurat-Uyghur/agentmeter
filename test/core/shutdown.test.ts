// Session totals from `session.shutdown` (D29): the byte gate and the
// allowlist extractor. Monitor-level scenarios live in monitor.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLine, MAX_SHUTDOWN_BYTES, parseShutdownLine } from "../../src/core/extract";
import type { ShutdownParseResult, UsageRecord } from "../../src/core/types";
import { CANARY, otherEvent, shutdownEvent, type ShutdownFixture } from "../fixtures/build";

const TS = "2026-11-05T14:30:00.000Z";
const START = Date.parse(TS) - 3_600_000;

type Plain = Record<string, any>;

function line(o: Partial<ShutdownFixture> = {}): string {
  return JSON.stringify(shutdownEvent({ timestamp: TS, ...o }));
}

/** A shutdown event with arbitrary (possibly ill-typed) values patched in. */
function lineWith(patch: (e: Plain) => void, o: Partial<ShutdownFixture> = {}): string {
  const e = shutdownEvent({ timestamp: TS, ...o }) as Plain;
  patch(e);
  return JSON.stringify(e);
}

function records(r: ShutdownParseResult): UsageRecord[] {
  if (r.kind !== "totals") throw new Error(`expected totals, got ${JSON.stringify(r)}`);
  return r.records;
}

function cls(s: string) {
  const buf = Buffer.from(s + "\n");
  return classifyLine(buf, 0, buf.length - 1);
}

describe("classifyLine: session.shutdown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("the prefix is a shutdown line", () => {
    expect(cls(line())).toBe("shutdown");
  });

  it("a message quoting the shutdown type is skip (quotes are escaped)", () => {
    const l = JSON.stringify(
      otherEvent("user.message", { data: { content: 'session.shutdown "type":"session.shutdown" "type": "session.shutdown"' } }),
    );
    expect(cls(l)).toBe("skip");
  });

  it("reordered or re-spaced shutdown lines are suspect", () => {
    expect(cls('{"id":"x","type":"session.shutdown","data":{}}')).toBe("suspect");
    expect(cls('{"type": "session.shutdown","data":{}}')).toBe("suspect");
  });

  it("respects start/end bounds", () => {
    const a = JSON.stringify(otherEvent("assistant.message"));
    const buf = Buffer.from(a + "\n" + '{"id":"x","type":"session.shutdown"}' + "\n");
    expect(classifyLine(buf, 0, a.length)).toBe("skip");
  });

  it("is classified by bytes only, never decoded", () => {
    const big = line({ models: { "model-a": {} } }).replace('"routine"', `"${CANARY.repeat(12_000)}"`);
    expect(big.length).toBeGreaterThan(200_000);
    const buf = Buffer.from(big + "\n");
    const toStr = vi.spyOn(Buffer.prototype, "toString");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    expect(classifyLine(buf, 0, buf.length - 1)).toBe("shutdown");
    expect(toStr).toHaveBeenCalledTimes(0);
    expect(decode).toHaveBeenCalledTimes(0);
  });

  it("the size cap is 64 KiB", () => {
    expect(MAX_SHUTDOWN_BYTES).toBe(64 * 1024);
  });
});

describe("parseShutdownLine", () => {
  it("extracts per-model totals, one record per model", () => {
    const r = records(parseShutdownLine(line({ models: { "model-a": {}, "model-b": { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 1, totalNanoAiu: 5 } } }), "f"));
    expect(r).toStrictEqual([
      {
        key: "shutdown:f:model-a",
        keySource: "shutdown",
        kind: "sessionTotal",
        sessionId: "f",
        folderId: "f",
        timestampMs: Date.parse(TS),
        startedMs: START,
        model: "model-a",
        tokens: { input: 6000, output: 1200, cacheRead: 3000, cacheWrite: 300, reasoning: 180 },
        calls: 6,
        nanoAiu: 12_000_000_000,
      },
      {
        key: "shutdown:f:model-b",
        keySource: "shutdown",
        kind: "sessionTotal",
        sessionId: "f",
        folderId: "f",
        timestampMs: Date.parse(TS),
        startedMs: START,
        model: "model-b",
        tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        calls: 1,
        nanoAiu: 5,
      },
    ]);
  });

  it("never reads the session duration, requests.cost or totalPremiumRequests", () => {
    const [r] = records(parseShutdownLine(line(), "f"));
    expect(r).not.toHaveProperty("durationMs");
    expect(JSON.stringify(r)).not.toContain("0.25");
  });

  it("totalNanoAiu 0 with tokens is not reported; with zero tokens it is a real 0", () => {
    const [legacy] = records(parseShutdownLine(line({ models: { m: { totalNanoAiu: 0 } } }), "f"));
    expect(legacy!.nanoAiu).toBeUndefined();
    expect("nanoAiu" in legacy!).toBe(false);
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalNanoAiu: 0 };
    const [none] = records(parseShutdownLine(line({ models: { m: zero } }), "f"));
    expect(none!.nanoAiu).toBe(0);
  });

  it("real zeros are kept for every token field", () => {
    const [r] = records(parseShutdownLine(line({ models: { m: { cacheWriteTokens: 0, reasoningTokens: 0 } } }), "f"));
    expect(r!.tokens.cacheWrite).toBe(0);
    expect(r!.tokens.reasoning).toBe(0);
  });

  it.each(["1000", -5, 1.5, null, 2 ** 60])("wrong type %s is absent, not zero", (bad) => {
    const l = lineWith((e) => {
      const m = e.data.modelMetrics["model-a"];
      m.usage.inputTokens = bad;
      m.requests.count = bad;
      m.totalNanoAiu = bad;
      e.data.sessionStartTime = bad;
    });
    const [r] = records(parseShutdownLine(l, "f"));
    expect(r!.tokens.input).toBeUndefined();
    expect(r!.tokens.output).toBe(1200);
    for (const k of ["calls", "nanoAiu", "startedMs"]) expect(k in r!).toBe(false);
  });

  it("a session start after the shutdown is dropped", () => {
    const [r] = records(parseShutdownLine(line({ sessionStartTime: Date.parse(TS) + 1 }), "f"));
    expect("startedMs" in r!).toBe(false);
  });

  it("canary never extracted", () => {
    const res = parseShutdownLine(line({ models: { "model-a": {}, "model-b": {} } }), "f");
    expect(JSON.stringify(res)).not.toContain(CANARY);
    for (const r of records(res)) {
      for (const k of ["tools", "sequence", "linesAdded", "durationMs"]) expect(k in r).toBe(false);
      expect(Object.keys(r).sort()).toStrictEqual(
        ["calls", "folderId", "key", "keySource", "kind", "model", "nanoAiu", "sessionId", "startedMs", "timestampMs", "tokens"],
      );
    }
  });

  it("the parsed tree never holds dropped keys (reviver)", () => {
    const seen: string[] = [];
    const orig = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: (this: unknown, k: string, v: unknown) => unknown) => {
      const out = orig(text, reviver);
      seen.push(JSON.stringify(out));
      return out;
    });
    parseShutdownLine(line(), "f");
    spy.mockRestore();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(CANARY);
    for (const k of ["filesModified", "accountingSnapshot", "agentMetrics", "usageAccountingWatermarks", "currentModel"])
      expect(seen[0]).not.toContain(`"${k}"`);
  });

  it("empty modelMetrics is empty, not unrecognized", () => {
    expect(parseShutdownLine(line({ models: {} }), "f")).toStrictEqual({ kind: "empty" });
  });

  it("missing modelMetrics is unrecognized", () => {
    expect(parseShutdownLine(line({ models: null }), "f")).toStrictEqual({ kind: "unrecognized", reason: "no-model-metrics" });
    expect(parseShutdownLine(lineWith((e) => (e.data.modelMetrics = [1])), "f")).toStrictEqual({ kind: "unrecognized", reason: "no-model-metrics" });
  });

  it("an entry without a usage object is skipped; none left is no-known-token-field", () => {
    const one = lineWith((e) => {
      e.data.modelMetrics["model-b"] = { requests: { count: 1 } };
    });
    expect(records(parseShutdownLine(one, "f")).map((r) => r.model)).toStrictEqual(["model-a"]);
    const none = lineWith((e) => {
      e.data.modelMetrics = { a: { requests: { count: 1 } }, b: { usage: { inputTokens: "x" } } };
    });
    expect(parseShutdownLine(none, "f")).toStrictEqual({ kind: "unrecognized", reason: "no-known-token-field" });
  });

  it("bad timestamp", () => {
    expect(parseShutdownLine(line({ timestamp: "yesterday" }), "f")).toStrictEqual({ kind: "unrecognized", reason: "bad-timestamp" });
  });

  it("missing metrics and a bad timestamp: no-model-metrics first", () => {
    expect(parseShutdownLine(line({ models: null, timestamp: "nope" }), "f")).toStrictEqual({ kind: "unrecognized", reason: "no-model-metrics" });
  });

  it("malformed and other types", () => {
    expect(parseShutdownLine('{"type":"session.shutdown","data":{"modelMetrics":{', "f")).toStrictEqual({ kind: "malformed" });
    expect(parseShutdownLine("[1]", "f")).toStrictEqual({ kind: "malformed" });
    expect(parseShutdownLine('{"type":"session.other"}', "f")).toStrictEqual({ kind: "ignored" });
  });

  it("hostile model ids are not kept and keys stay distinct", () => {
    const l = lineWith((e) => {
      const m = e.data.modelMetrics["model-a"];
      e.data.modelMetrics = { "[x](command:y)": m, ["a".repeat(101)]: m };
    });
    const r = records(parseShutdownLine(l, "f"));
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.model === undefined && !("model" in x))).toBe(true);
    expect(new Set(r.map((x) => x.key)).size).toBe(2);
    expect(r.map((x) => x.key).join()).not.toContain("command");
  });

  it("prototype keys in modelMetrics go to (unknown model) and leave Object.prototype untouched", () => {
    const m = '{"requests":{"count":2},"usage":{"inputTokens":5,"outputTokens":1},"totalNanoAiu":7}';
    const l = `{"type":"session.shutdown","timestamp":"${TS}","data":{"modelMetrics":{"__proto__":${m},"constructor":${m},"prototype":${m}}}}`;
    const r = records(parseShutdownLine(l, "f"));
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.model === undefined)).toBe(true);
    expect(new Set(r.map((x) => x.key)).size).toBe(3);
    expect(({} as Plain).count).toBeUndefined();
    expect(({} as Plain).usage).toBeUndefined();
  });

  it("caps the number of models per line", () => {
    const l = lineWith((e) => {
      const m = e.data.modelMetrics["model-a"];
      e.data.modelMetrics = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`m${i}`, m]));
    });
    expect(records(parseShutdownLine(l, "f"))).toHaveLength(64);
  });
});

describe("all-zero model entries (N2)", () => {
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalNanoAiu: 0 };

  it("a model with all-zero tokens and no requests is dropped; the others stay", () => {
    const r = records(parseShutdownLine(line({ models: { "model-a": {}, idle: { ...zero, requests: 0 } } }), "f"));
    expect(r.map((x) => x.model)).toStrictEqual(["model-a"]);
    const absent = lineWith((e) => delete e.data.modelMetrics.idle.requests, { models: { "model-a": {}, idle: zero } });
    expect(records(parseShutdownLine(absent, "f")).map((x) => x.model)).toStrictEqual(["model-a"]);
  });

  it("a line whose only models are all zero is empty, not unrecognized", () => {
    expect(parseShutdownLine(line({ models: { idle: { ...zero, requests: 0 } } }), "f")).toStrictEqual({ kind: "empty" });
  });

  it("all-zero tokens with logged requests are kept", () => {
    expect(records(parseShutdownLine(line({ models: { m: { ...zero, requests: 2 } } }), "f"))).toHaveLength(1);
  });
});
