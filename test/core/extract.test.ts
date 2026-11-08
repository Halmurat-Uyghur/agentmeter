import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLine, parseUsageLine } from "../../src/core/extract";
import type { ParseResult, UsageRecord } from "../../src/core/types";
import {
  CANARY,
  otherEvent,
  tokenDetails,
  usageEvent,
  type UsageFixture,
} from "../fixtures/build";

const TS = "2026-11-05T14:30:00.000Z";
const SRC = "0000aaaa-0000-4000-8000-000000000001";

type Plain = Record<string, any>;

function line(o: Partial<UsageFixture> = {}): string {
  return JSON.stringify(usageEvent({ timestamp: TS, ...o }));
}

/** A usage event with arbitrary (possibly ill-typed) values patched into data.usage. */
function lineWith(patch: (e: Plain) => void): string {
  const e = usageEvent({ timestamp: TS }) as Plain;
  patch(e);
  return JSON.stringify(e);
}

function record(r: ParseResult): UsageRecord {
  if (r.kind !== "usage")
    throw new Error(`expected usage, got ${JSON.stringify(r)}`);
  return r.record;
}

function cls(s: string) {
  const buf = Buffer.from(s + "\n");
  return classifyLine(buf, 0, buf.length - 1);
}

describe("parseUsageLine", () => {
  it("extracts allowlisted fields", () => {
    expect(record(parseUsageLine(line(), "f"))).toStrictEqual({
      key: "u-1",
      keySource: "usageId",
      kind: "call",
      source: "copilot",
      sessionId: SRC,
      folderId: "f",
      timestampMs: Date.parse(TS),
      sequence: 1,
      model: "model-a",
      tokens: {
        input: 1000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 50,
        reasoning: 30,
      },
      durationMs: 1500,
      nanoAiu: 2_000_000_000,
    });
  });

  it("real zero kept", () => {
    expect(
      record(parseUsageLine(line({ cacheReadTokens: 0 }), "f")).tokens
        .cacheRead,
    ).toBe(0);
  });

  it("canary never extracted", () => {
    const l = lineWith((e) => {
      e.data.usage.prompt = CANARY;
      e.data.usage.modelDisplayName = CANARY;
      e.data.extra = CANARY;
      e.parentId = CANARY;
    });
    const result = parseUsageLine(l, "f");
    expect(result.kind).toBe("usage");
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("missing field stays absent", () => {
    const tokens = record(
      parseUsageLine(line({ cacheWriteTokens: undefined }), "f"),
    ).tokens;
    expect("cacheWrite" in tokens).toBe(false);
  });

  it.each(["1000", -5, 1.5, null, 2 ** 60])(
    "wrong type is absent, not zero: %s",
    (bad) => {
      const r = record(
        parseUsageLine(
          lineWith((e) => {
            e.data.usage.inputTokens = bad;
            e.data.usage.duration = bad;
            e.data.usage.copilotUsage.totalNanoAiu = bad;
            e.data.usage.accounting.sequence = bad;
          }),
          "f",
        ),
      );
      expect("input" in r.tokens).toBe(false);
      expect("durationMs" in r).toBe(false);
      expect("nanoAiu" in r).toBe(false);
      expect("sequence" in r).toBe(false);
      expect(r.tokens.output).toBe(200);
    },
  );

  describe("unrecognized when usage object lacks every known token field", () => {
    it("no known token field", () => {
      const l = lineWith((e) => {
        e.data.usage = { tokens: { in: 5 }, accounting: { usageId: "u-1" } };
      });
      expect(parseUsageLine(l, "f")).toStrictEqual({
        kind: "unrecognized",
        reason: "no-known-token-field",
      });
    });

    it("no data.usage", () => {
      const l = lineWith((e) => {
        delete e.data.usage;
      });
      expect(parseUsageLine(l, "f")).toStrictEqual({
        kind: "unrecognized",
        reason: "no-usage-object",
      });
    });

    it("bad timestamp", () => {
      expect(
        parseUsageLine(line({ timestamp: "yesterday" }), "f"),
      ).toStrictEqual({
        kind: "unrecognized",
        reason: "bad-timestamp",
      });
    });

    it("both ids missing", () => {
      expect(
        parseUsageLine(line({ usageId: undefined, id: undefined }), "f"),
      ).toStrictEqual({
        kind: "unrecognized",
        reason: "no-key",
      });
    });

    it("order: missing usage and bad timestamp → no-usage-object", () => {
      const l = lineWith((e) => {
        delete e.data.usage;
        e.timestamp = "yesterday";
      });
      expect(parseUsageLine(l, "f")).toStrictEqual({
        kind: "unrecognized",
        reason: "no-usage-object",
      });
    });
  });

  it("falls back to event id", () => {
    const r = record(parseUsageLine(line({ usageId: undefined }), "f"));
    expect(r.key).toBe("e-1");
    expect(r.keySource).toBe("eventId");
  });

  it("sessionId falls back to folder", () => {
    expect(
      record(parseUsageLine(line({ sourceSessionId: undefined }), "folder-1"))
        .sessionId,
    ).toBe("folder-1");
  });

  it("malformed", () => {
    expect(parseUsageLine("{not json", "f")).toStrictEqual({
      kind: "malformed",
    });
    expect(parseUsageLine("[]", "f")).toStrictEqual({ kind: "malformed" });
    expect(parseUsageLine("null", "f")).toStrictEqual({ kind: "malformed" });
  });

  it("different type with gate prefix-free JSON", () => {
    expect(parseUsageLine('{"type":"session.other"}', "f")).toStrictEqual({
      kind: "ignored",
    });
  });

  it.each([
    ["gpt-6-luna", true],
    ["[x](command:y)", false],
    ["a b", false],
    ["<img>", false],
    ["a".repeat(101), false],
    ["__proto__", false],
    ["constructor", false],
    ["prototype", false],
  ])("model id allowlist: %s", (model, kept) => {
    const r = record(parseUsageLine(line({ model }), "f"));
    if (kept) expect(r.model).toBe(model);
    else {
      expect(r.model).toBeUndefined();
      expect("model" in r).toBe(false);
    }
  });
});

describe("prototype keys (D28)", () => {
  it("tool names __proto__ / constructor / prototype are dropped; tools has no prototype", () => {
    const l = lineWith((e) => {
      e.data.usage.toolCounts = JSON.parse('{"__proto__":3,"constructor":2,"prototype":4,"bash":1}');
    });
    const r = record(parseUsageLine(l, "f"));
    expect(Object.keys(r.tools!)).toStrictEqual(["bash"]);
    expect(Object.getPrototypeOf(r.tools!)).toBeNull();
    expect(({} as Plain).records).toBeUndefined();
  });

  it("a __proto__ model line parses without touching Object.prototype", () => {
    const l = '{"type":"session.usage_record","id":"e","timestamp":"' + TS + '","data":{"usage":{"model":"__proto__","inputTokens":1,"outputTokens":1}}}';
    const r = record(parseUsageLine(l, "f"));
    expect(r.model).toBeUndefined();
    expect(({} as Plain).records).toBeUndefined();
  });
});

describe("classifyLine", () => {
  afterEach(() => vi.restoreAllMocks());

  it("usage / activity / skip by prefix", () => {
    expect(cls(line())).toBe("usage");
    expect(cls(JSON.stringify(otherEvent("assistant.turn_end")))).toBe(
      "activity",
    );
    expect(cls(JSON.stringify(otherEvent("assistant.message")))).toBe("skip");
  });

  it("user.message quoting the usage type key is skip (quotes are escaped)", () => {
    const l = JSON.stringify(
      otherEvent("user.message", {
        data: {
          content:
            'session.usage_record and "type":"session.usage_record" and "type": "session.usage_record"',
        },
      }),
    );
    expect(cls(l)).toBe("skip");
  });

  it("re-spaced key-order change is suspect", () => {
    expect(cls('{"id":"x","type": "session.usage_record"}')).toBe("suspect");
  });

  it("key-order change is suspect", () => {
    expect(cls('{"id":"x","type":"session.usage_record","data":{}}')).toBe(
      "suspect",
    );
  });

  it("respects start/end bounds", () => {
    const a = JSON.stringify(otherEvent("assistant.message"));
    const b = line();
    const buf = Buffer.from(a + "\n" + b + "\n");
    expect(classifyLine(buf, 0, a.length)).toBe("skip");
    expect(classifyLine(buf, a.length + 1, buf.length - 1)).toBe("usage");
    // A usage record past `end` must not make an earlier line suspect.
    const c = JSON.stringify(otherEvent("assistant.message"));
    const buf2 = Buffer.from(c + "\n" + '{"id":"x","type":"session.usage_record"}' + "\n");
    expect(classifyLine(buf2, 0, c.length)).toBe("skip");
    // A line shorter than the prefix is not a match.
    const short = Buffer.from('{"type":"session.usage_rec');
    expect(classifyLine(short, 0, short.length)).toBe("skip");
  });

  it("skip lines are never decoded", () => {
    const big = JSON.stringify(
      otherEvent("assistant.message", {
        data: { content: CANARY.repeat(12_000) },
      }),
    );
    expect(big.length).toBeGreaterThan(200_000);
    const buf = Buffer.from(big + "\n");
    const toStr = vi.spyOn(Buffer.prototype, "toString");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    expect(classifyLine(buf, 0, buf.length - 1)).toBe("skip");
    expect(toStr).toHaveBeenCalledTimes(0);
    expect(decode).toHaveBeenCalledTimes(0);
  });
});

describe("sourceSessionId validation (review 1)", () => {
  it.each(["not a session id", "../../etc", "__proto__", "a".repeat(65), "short", "0000aaaa-0000-4000-8000-00000000000g"])(
    "an id that is not shaped like a session folder (%s) falls back to the folder",
    (bad) => {
      expect(record(parseUsageLine(line({ sourceSessionId: bad }), "folder-1")).sessionId).toBe("folder-1");
    },
  );

  it("a well-formed id is kept", () => {
    expect(record(parseUsageLine(line({ sourceSessionId: SRC }), "folder-1")).sessionId).toBe(SRC);
  });
});

/** The default fixture's tokens (1000 input = 450 uncached + 500 read + 50 write, 200 output),
 * priced so the parts add up to its 2e9 nanoAIU. */
const DETAILS = tokenDetails([
  { tokenType: "input", tokenCount: 450, batchSize: 1000, costPerBatch: 2_000_000_000 },
  { tokenType: "cache_read", tokenCount: 500, costPerBatch: 200_000 },
  { tokenType: "cache_write", tokenCount: 50, costPerBatch: 2_000_000 },
  { tokenType: "output", tokenCount: 200, costPerBatch: 4_500_000 },
]);

describe("v0.6 fields: initiator, finishReason, tool definitions, per-type cost", () => {
  it("reads the two enums, the two counts and the exact per-type split", () => {
    const r = record(parseUsageLine(line({ initiator: "user", finishReason: "tool_calls", toolTokenCount: 300, availableToolCount: 12, tokenDetails: DETAILS }), "f"));
    expect(r.initiator).toBe("user");
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolTokens).toBe(300);
    expect(r.availableTools).toBe(12);
    expect(r.typeCost).toStrictEqual({ input: 9e8, cacheRead: 1e8, cacheWrite: 1e8, output: 9e8, inputAtReadRate: 9e7 });
  });

  it("review fix 6: a JSON null initiator or finishReason is missing, not \"other\"", () => {
    const r = record(parseUsageLine(line({ initiator: null, finishReason: null }), "f"));
    expect("initiator" in r).toBe(false);
    expect("finishReason" in r).toBe(false);
    const o = record(parseUsageLine(line({ initiator: "robot", finishReason: 7 }), "f"));
    expect(o.initiator).toBe("other");
    expect(o.finishReason).toBe("other");
  });

  it("absent fields stay absent (older records)", () => {
    const r = record(parseUsageLine(line(), "f"));
    for (const k of ["initiator", "finishReason", "toolTokens", "availableTools", "typeCost"]) expect(k in r, k).toBe(false);
  });

  it.each([
    ["agent", "agent"],
    ["user", "user"],
    ["User", "other"],
    [CANARY, "other"],
    ["__proto__", "other"],
    ["", "other"],
    [5, "other"],
    [null, undefined], // review fix 6: null is not logged
  ])("initiator %s → %s; the log's string is never kept", (v, want) => {
    const r = record(parseUsageLine(line({ initiator: v }), "f"));
    expect(r.initiator).toBe(want);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it.each([
    ["stop", "stop"],
    ["tool_calls", "tool_calls"],
    ["length", "length"],
    ["content_filter", "content_filter"],
    ["constructor", "other"],
    [CANARY, "other"],
    [{ x: 1 }, "other"],
  ])("finishReason %s → %s", (v, want) => {
    const r = record(parseUsageLine(line({ finishReason: v }), "f"));
    expect(r.finishReason).toBe(want);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it.each(["300", -1, 1.5, null, 2 ** 60])("tool counts of the wrong type are absent, not zero: %s", (bad) => {
    const r = record(parseUsageLine(line({ toolTokenCount: bad, availableToolCount: bad }), "f"));
    expect("toolTokens" in r).toBe(false);
    expect("availableTools" in r).toBe(false);
  });

  it("never keeps tokenDetails strings (model, tokenType)", () => {
    const details = [...DETAILS.slice(0, 3), { ...(DETAILS[3] as object), tokenType: "output" }];
    const r = record(parseUsageLine(line({ tokenDetails: details }), "f"));
    expect(r.typeCost).toBeDefined();
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(Object.keys(r.typeCost!).sort()).toEqual(["cacheRead", "cacheWrite", "input", "inputAtReadRate", "output"]);
  });

  it("an unknown token type goes to the `other` bucket, never under its own name", () => {
    const details = tokenDetails([
      { tokenType: "input", tokenCount: 450, batchSize: 1000, costPerBatch: 2_000_000_000 },
      { tokenType: "cache_read", tokenCount: 500, costPerBatch: 200_000 },
      { tokenType: "cache_write", tokenCount: 50, costPerBatch: 2_000_000 },
      { tokenType: CANARY, tokenCount: 200, costPerBatch: 4_500_000 },
    ]);
    const r = record(parseUsageLine(line({ tokenDetails: details }), "f"));
    expect(r.typeCost).toStrictEqual({ input: 9e8, cacheRead: 1e8, cacheWrite: 1e8, output: 0, other: 9e8, inputAtReadRate: 9e7 });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it.each([
    ["parts that do not add up to totalNanoAiu", (d: Plain[]) => (d[3]!.costPerBatch = 4_400_000)],
    ["a zero batchSize", (d: Plain[]) => (d[0]!.batchSize = 0)],
    ["a negative tokenCount", (d: Plain[]) => (d[1]!.tokenCount = -1)],
    ["a string costPerBatch", (d: Plain[]) => (d[2]!.costPerBatch = "2000000")],
    ["a non-object entry", (d: Plain[]) => (d[2] = 5 as unknown as Plain)],
    ["too many entries", (d: Plain[]) => d.push(...Array.from({ length: 13 }, () => ({ tokenType: "output", tokenCount: 0, batchSize: 1, costPerBatch: 1 })))],
  ])("no split (—, not 0) with %s", (_name, patch) => {
    const d = JSON.parse(JSON.stringify(DETAILS)) as Plain[];
    patch(d);
    const r = record(parseUsageLine(line({ tokenDetails: d }), "f"));
    expect("typeCost" in r).toBe(false);
    expect(r.nanoAiu).toBe(2_000_000_000);
  });

  it("no split without totalNanoAiu, and none from a non-array", () => {
    expect("typeCost" in record(parseUsageLine(line({ tokenDetails: DETAILS, totalNanoAiu: undefined }), "f"))).toBe(false);
    expect("typeCost" in record(parseUsageLine(line({ tokenDetails: { input: 1 } }), "f"))).toBe(false);
    expect("typeCost" in record(parseUsageLine(line({ tokenDetails: [] }), "f"))).toBe(false);
  });

  it("two different cache-read rates: the split stays, the cache-read comparison is not derivable", () => {
    const details = tokenDetails([
      { tokenType: "input", tokenCount: 450, batchSize: 1000, costPerBatch: 2_000_000_000 },
      { tokenType: "cache_read", tokenCount: 250, costPerBatch: 100_000 },
      { tokenType: "cache_read", tokenCount: 250, costPerBatch: 300_000 },
      { tokenType: "cache_write", tokenCount: 50, costPerBatch: 2_000_000 },
      { tokenType: "output", tokenCount: 200, costPerBatch: 4_500_000 },
    ]);
    const r = record(parseUsageLine(line({ tokenDetails: details }), "f"));
    expect(r.typeCost).toStrictEqual({ input: 9e8, cacheRead: 1e8, cacheWrite: 1e8, output: 9e8 });
  });

  it("only allowlisted keys reach the record", () => {
    const r = record(parseUsageLine(line({ initiator: "agent", finishReason: "stop", toolTokenCount: 1, availableToolCount: 2, tokenDetails: DETAILS }), "f"));
    expect(Object.keys(r).sort()).toEqual(
      ["availableTools", "durationMs", "finishReason", "folderId", "initiator", "key", "keySource", "kind", "model", "nanoAiu", "sequence", "sessionId", "source", "timestampMs", "tokens", "toolTokens", "typeCost"].sort(),
    );
  });
});

describe("record key policy (review A1)", () => {
  // Real usageIds are base64, 496–516 chars; real event ids are 36-char UUIDs.
  const B64 = "QUJD+/09".repeat(63) + "ab+/=="; // 510 chars of the base64 alphabet
  const EID = "0000bbbb-0000-4000-8000-000000000002";

  it("a real-shaped base64 usageId is the key", () => {
    const id = B64.padEnd(512, "A");
    const r = record(parseUsageLine(line({ usageId: id, id: EID }), "f"));
    expect(r.key).toBe(id);
    expect(r.keySource).toBe("usageId");
  });

  it.each([
    ["a space", "abc def"],
    ["1025 chars", "A".repeat(1025)],
    ["a <", "abc<def"],
    ["a newline", "abc\ndef"],
  ])("a usageId with %s falls back to the event id", (_name, bad) => {
    const r = record(parseUsageLine(line({ usageId: bad, id: EID }), "f"));
    expect(r.key).toBe(EID);
    expect(r.keySource).toBe("eventId");
  });

  it("a 1024-char usageId is still accepted", () => {
    const id = "A".repeat(1024);
    expect(record(parseUsageLine(line({ usageId: id, id: EID }), "f")).key).toBe(id);
  });

  it.each([
    ["a space", "CANARY prompt text"],
    ["129 chars", "e".repeat(129)],
    ["a +", "a+b"],
  ])("no-key when the usageId is bad and the event id has %s", (_name, badId) => {
    expect(parseUsageLine(line({ usageId: "bad id", id: badId }), "f")).toStrictEqual({ kind: "unrecognized", reason: "no-key" });
  });
});

describe("re-spaced type key is suspect (review A2)", () => {
  it.each([
    `{"type" : "session.usage_record","data":{}}`,
    `{"type":\t"session.usage_record","data":{}}`,
    `{ "type":"session.usage_record","data":{}}`,
    `{\n"type"  :  "session.usage_record"}`.replace("\n", " "),
  ])("%s → suspect", (s) => {
    expect(cls(s)).toBe("suspect");
  });

  it("only an anchored type key counts: the bare type string elsewhere is skipped", () => {
    expect(cls(`{"type":"tool.result","data":{"text":"session.usage_record"}}`)).toBe("skip");
    expect(cls(`{"id":"x","note" : "session.usage_record"}`)).toBe("skip");
  });
});

describe("strict timestamps (review A3)", () => {
  it.each(["1", "2026-11-07T02:00:00.000", "2026-11-07", "2026-11-07 02:00:00Z", "Sat, 07 Nov 2026 02:00:00 GMT", "2026-11-07T02:00:00.000z"])(
    "%s is bad-timestamp",
    (ts) => {
      expect(parseUsageLine(line({ timestamp: ts }), "f")).toStrictEqual({ kind: "unrecognized", reason: "bad-timestamp" });
    },
  );

  it.each([
    ["2026-11-07T02:00:00Z", Date.UTC(2026, 10, 7, 2)],
    ["2026-11-07T02:00:00.000Z", Date.UTC(2026, 10, 7, 2)],
    ["2026-11-07T02:00:00.000+00:00", Date.UTC(2026, 10, 7, 2)],
    ["2026-11-07T04:00:00-02:00", Date.UTC(2026, 10, 7, 6)],
  ])("%s is accepted", (ts, ms) => {
    expect(record(parseUsageLine(line({ timestamp: ts }), "f")).timestampMs).toBe(ms);
  });
});

describe("tokenDetails tokenType must be a string (review A6)", () => {
  it.each([
    ["missing", (d: Plain) => delete d.tokenType],
    ["a number", (d: Plain) => (d.tokenType = 3)],
    ["null", (d: Plain) => (d.tokenType = null)],
  ])("a tokenType that is %s drops the whole split", (_name, patch) => {
    const d = JSON.parse(JSON.stringify(DETAILS)) as Plain[];
    patch(d[3]!);
    const r = record(parseUsageLine(line({ tokenDetails: d }), "f"));
    expect("typeCost" in r).toBe(false);
    expect(r.nanoAiu).toBe(2_000_000_000);
  });
});
