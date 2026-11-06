import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLine, parseUsageLine } from "../../src/core/extract";
import type { ParseResult, UsageRecord } from "../../src/core/types";
import {
  CANARY,
  otherEvent,
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
