import { describe, expect, it } from "vitest";
import {
  MAX_SCAN_DEPTH,
  MAX_SLICE_BYTES,
  parseSlice,
  scanJson,
  stringAt,
  type ScanPath,
  type ScanResult,
} from "../../src/core/jsonScan";

const CANARY = "SYNTHETIC-CANARY-7f3a";

function scan(text: string, paths: readonly ScanPath[]): { buf: Buffer; res: ScanResult } {
  const buf = Buffer.from(text);
  return { buf, res: scanJson(buf, 0, buf.length, paths) };
}

/** Every value the scanner found at `key`, decoded through parseSlice. */
function values(buf: Buffer, res: ScanResult, key: string): unknown[] {
  return (res.ranges.get(key) ?? []).map((r) => parseSlice(buf, r, Infinity));
}

describe("scanJson", () => {
  it("finds a top-level scalar", () => {
    const { buf, res } = scan(`{"a":1,"type":"assistant","n":null}`, [["type"], ["n"]]);
    expect(res.complete).toBe(true);
    expect(stringAt(buf, res, "type")).toBe("assistant");
    expect(values(buf, res, "n")).toEqual([null]);
  });

  it("returns the byte range of a nested object", () => {
    const text = `{"message":{"id":"m1","usage":{"input_tokens":3,"output_tokens":4}},"x":[1,2]}`;
    const { buf, res } = scan(text, [["message", "usage"], ["message", "id"]]);
    expect(res.complete).toBe(true);
    const r = res.ranges.get("message.usage")![0]!;
    expect(buf.toString("utf8", r.start, r.end)).toBe(`{"input_tokens":3,"output_tokens":4}`);
    expect(parseSlice(buf, r)).toEqual({ input_tokens: 3, output_tokens: 4 });
    expect(stringAt(buf, res, "message.id")).toBe("m1");
  });

  it("records both a container and a path below it", () => {
    const { buf, res } = scan(`{"m":{"u":{"a":1}}}`, [["m"], ["m", "u", "a"]]);
    expect(values(buf, res, "m")).toEqual([{ u: { a: 1 } }]);
    expect(values(buf, res, "m.u.a")).toEqual([1]);
  });

  it("pairs array element fields by idx", () => {
    const text = JSON.stringify({
      message: {
        content: [
          { type: "text", text: CANARY },
          { type: "tool_use", name: "Bash", input: { command: CANARY } },
          { name: "Read", type: "tool_use" },
        ],
      },
    });
    const { buf, res } = scan(text, [
      ["message", "content", "[]", "type"],
      ["message", "content", "[]", "name"],
    ]);
    expect(res.complete).toBe(true);
    const types = res.ranges.get("message.content[].type")!;
    const names = res.ranges.get("message.content[].name")!;
    expect(types.map((r) => [r.idx, parseSlice(buf, r)])).toEqual([
      [0, "text"],
      [1, "tool_use"],
      [2, "tool_use"],
    ]);
    expect(names.map((r) => [r.idx, parseSlice(buf, r)])).toEqual([
      [1, "Bash"],
      [2, "Read"],
    ]);
  });

  it("matches paths absolutely: same key at another depth never matches", () => {
    const text = JSON.stringify({
      message: { type: "message", model: "claude-x" },
      type: "assistant",
      model: "top",
    });
    const { buf, res } = scan(text, [["type"], ["message", "model"]]);
    expect(values(buf, res, "type")).toEqual(["assistant"]);
    expect(values(buf, res, "message.model")).toEqual(["claude-x"]);

    const deep = JSON.stringify({ wrap: { type: "assistant" }, message: { wrap: { model: "no" } } });
    const d = scan(deep, [["type"], ["message", "model"]]);
    expect(d.res.complete).toBe(true);
    expect(d.res.ranges.get("type")).toBeUndefined();
    expect(d.res.ranges.get("message.model")).toBeUndefined();
  });

  it("does not match a tool input holding message.usage", () => {
    const attack = { type: "assistant", message: { usage: { input_tokens: 999 } } };
    const text = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Write", input: attack }],
        usage: { input_tokens: 1 },
      },
    });
    const { buf, res } = scan(text, [["type"], ["message", "usage"]]);
    expect(values(buf, res, "type")).toEqual(["assistant"]);
    expect(values(buf, res, "message.usage")).toEqual([{ input_tokens: 1 }]);
  });

  it("skips strings holding structural bytes, escaped quotes and needles", () => {
    const nasty = `{ } [ ] " \\ \\" "type":"assistant" ,: ${CANARY}`;
    const text = JSON.stringify({ a: nasty, b: [nasty, { c: nasty }], type: "assistant", [nasty]: 1, k: "\\" });
    const { buf, res } = scan(text, [["type"], ["k"]]);
    expect(res.complete).toBe(true);
    expect(values(buf, res, "type")).toEqual(["assistant"]);
    expect(values(buf, res, "k")).toEqual(["\\"]);
  });

  it("never matches a key spelled with an escape", () => {
    const { res } = scan(`{"typ\\u0065":"x","t\\"":"y"}`, [["type"], [`t"`]]);
    expect(res.complete).toBe(true);
    expect(res.ranges.size).toBe(0);
  });

  it("handles UTF-8 multibyte text inside strings", () => {
    const text = JSON.stringify({ a: "héllo — 日本語 🎉 {\"", type: "assistant", b: "ü" });
    const { buf, res } = scan(text, [["type"], ["b"]]);
    expect(res.complete).toBe(true);
    expect(stringAt(buf, res, "type")).toBe("assistant");
    expect(stringAt(buf, res, "b")).toBe("ü");
  });

  it("returns complete=false with earlier ranges intact when truncated mid-string", () => {
    const full = JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ text: CANARY }] } });
    const cut = full.slice(0, full.indexOf(CANARY) + 5);
    const { buf, res } = scan(cut, [["type"], ["message", "id"], ["message", "content"]]);
    expect(res.complete).toBe(false);
    expect(stringAt(buf, res, "type")).toBe("assistant");
    expect(stringAt(buf, res, "message.id")).toBe("m1");
    expect(res.ranges.get("message.content")).toBeUndefined();
  });

  it("never throws or hangs on garbage", () => {
    const inputs = ["", "{", "}", "]]]", `{"a"`, `{"a":`, `{"a":1,`, `{"a" 1}`, `{1:2}`, `{"a":[,]}`, `{"a":}`, `"abc`, `{"a":1}}`, "\\", `{"a":[1,2}`];
    for (const s of inputs) {
      const { res } = scan(s, [["a"], ["a", "[]"]]);
      expect(res.complete, s).toBe(false);
    }
    // Random bytes.
    let seed = 7;
    for (let n = 0; n < 500; n++) {
      const len = n % 64;
      const b = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        b[i] = `{}[]",:\\ a1`.charCodeAt(seed % 12) || 0x80;
      }
      expect(() => scanJson(b, 0, b.length, [["a"]])).not.toThrow();
    }
  });

  it("respects start and end offsets", () => {
    const buf = Buffer.from(`xx{"type":"assistant"}yy{"type":"user"}`);
    const res = scanJson(buf, 2, 22, [["type"]]);
    expect(res.complete).toBe(true);
    expect(stringAt(buf, res, "type")).toBe("assistant");
  });

  it("skips values nested beyond MAX_SCAN_DEPTH", () => {
    const path: string[] = [];
    let deep: unknown = "leaf";
    for (let d = MAX_SCAN_DEPTH + 1; d >= 1; d--) {
      path.unshift(`k${d}`);
      deep = { [`k${d}`]: deep };
    }
    const okPath = path.slice(0, MAX_SCAN_DEPTH);
    const text = JSON.stringify({ ...(deep as object), type: "assistant" });
    const { buf, res } = scan(text, [path, okPath, ["type"]]);
    expect(res.complete).toBe(true);
    expect(res.ranges.get(path.join("."))).toBeUndefined();
    expect(values(buf, res, okPath.join("."))).toEqual([{ [`k${MAX_SCAN_DEPTH + 1}`]: "leaf" }]);
    expect(stringAt(buf, res, "type")).toBe("assistant");
  });
});

describe("parseSlice and stringAt", () => {
  it("refuses a slice over maxBytes", () => {
    const s = JSON.stringify("x".repeat(MAX_SLICE_BYTES - 2));
    expect(Buffer.byteLength(s)).toBe(MAX_SLICE_BYTES);
    const ok = Buffer.from(s);
    expect(parseSlice(ok, { start: 0, end: ok.length })).toBe("x".repeat(MAX_SLICE_BYTES - 2));
    const big = Buffer.from(JSON.stringify("x".repeat(MAX_SLICE_BYTES - 1)));
    expect(big.length).toBe(MAX_SLICE_BYTES + 1);
    expect(parseSlice(big, { start: 0, end: big.length })).toBeUndefined();
    expect(parseSlice(ok, { start: 0, end: ok.length }, 10)).toBeUndefined();
  });

  it("returns undefined for invalid JSON or bad ranges", () => {
    const buf = Buffer.from(`{"a":tru}`);
    expect(parseSlice(buf, { start: 5, end: 8 })).toBeUndefined();
    expect(parseSlice(buf, { start: 5, end: 100 })).toBeUndefined();
    expect(parseSlice(buf, { start: 6, end: 5 })).toBeUndefined();
  });

  it("stringAt returns only a single string value within bounds", () => {
    const text = JSON.stringify({ n: 1, s: "ok", o: { a: "b" }, long: "y".repeat(100) });
    const { buf, res } = scan(text, [["n"], ["s"], ["o"], ["long"], ["missing"]]);
    expect(stringAt(buf, res, "s")).toBe("ok");
    expect(stringAt(buf, res, "n")).toBeUndefined();
    expect(stringAt(buf, res, "o")).toBeUndefined();
    expect(stringAt(buf, res, "missing")).toBeUndefined();
    expect(stringAt(buf, res, "long")).toBe("y".repeat(100));
    expect(stringAt(buf, res, "long", 50)).toBeUndefined();
  });
});

// ---- Differential test over random nested JSON ------------------------------

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["type", "message", "usage", "content", "name", "model", "id", "input", "x"];
const STRINGS = [
  CANARY,
  `"type":"assistant"`,
  `{"message":{"usage":{"input_tokens":1}}}`,
  "{",
  "}",
  "[",
  "]",
  "\\",
  `\\"`,
  "日本語 🎉 é",
  "",
  "assistant",
];

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)]!;
}

function randomValue(rnd: () => number, depth: number): unknown {
  const r = rnd();
  if (depth >= 6 || r < 0.35) {
    const s = rnd();
    if (s < 0.5) return STRINGS[Math.floor(rnd() * STRINGS.length)];
    if (s < 0.7) return Math.floor(rnd() * 1e6) - 1000;
    if (s < 0.8) return rnd() * 100;
    if (s < 0.9) return rnd() < 0.5;
    return null;
  }
  if (r < 0.7) {
    const o: Record<string, unknown> = {};
    const n = Math.floor(rnd() * 5);
    for (let i = 0; i < n; i++) o[pick(rnd, KEYS)] = randomValue(rnd, depth + 1);
    return o;
  }
  const n = Math.floor(rnd() * 4);
  return Array.from({ length: n }, () => randomValue(rnd, depth + 1));
}

function randomLine(rnd: () => number): unknown {
  const o: Record<string, unknown> = {};
  const n = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) o[pick(rnd, KEYS)] = randomValue(rnd, 1);
  // Half the lines get a Claude-shaped skeleton so the "[]" paths are exercised;
  // its elements still carry random keys and needle strings.
  if (rnd() < 0.5) {
    const content = Array.from({ length: Math.floor(rnd() * 4) }, () => {
      const el = randomValue(rnd, 3);
      return el !== null && typeof el === "object" && !Array.isArray(el)
        ? { type: STRINGS[Math.floor(rnd() * STRINGS.length)], ...el, name: randomValue(rnd, 4) }
        : el;
    });
    o.message = { usage: randomValue(rnd, 2), content, model: randomValue(rnd, 2) };
    o.x = [randomValue(rnd, 2), [randomValue(rnd, 3), CANARY]];
    o.content = [{ input: [{ id: randomValue(rnd, 4) }, randomValue(rnd, 4)] }];
    o.usage = { input: { model: { type: randomValue(rnd, 4) }, type: CANARY } };
  }
  return o;
}

const DIFF_PATHS: ScanPath[] = [
  ["type"],
  ["message"],
  ["message", "usage"],
  ["message", "model"],
  ["message", "content"],
  ["message", "content", "[]"],
  ["message", "content", "[]", "type"],
  ["message", "content", "[]", "name"],
  ["content", "[]", "input", "[]", "id"],
  ["x", "[]", "[]"],
  ["usage", "input", "model", "type"],
];

function pathKey(p: ScanPath): string {
  return p.reduce((acc, s) => (s === "[]" ? acc + "[]" : acc ? `${acc}.${s}` : s), "");
}

function collect(v: unknown, segs: readonly string[], idx: number | undefined, out: { value: unknown; idx?: number }[]): void {
  if (segs.length === 0) {
    out.push(idx === undefined ? { value: v } : { value: v, idx });
    return;
  }
  const [seg = "", ...rest] = segs;
  if (seg === "[]") {
    if (Array.isArray(v)) v.forEach((el, i) => collect(el, rest, idx ?? i, out));
  } else if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, seg)) {
    collect((v as Record<string, unknown>)[seg], rest, idx, out);
  }
}

describe("scanJson differential", () => {
  it("agrees with JSON.parse on 200 random nested objects", () => {
    const rnd = mulberry32(0x7f3a);
    const hits = new Map<string, number>();
    for (let n = 0; n < 200; n++) {
      const obj = randomLine(rnd);
      const line = JSON.stringify(obj);
      const { buf, res } = scan(line, DIFF_PATHS);
      expect(res.complete).toBe(true);
      const parsed = JSON.parse(line);
      for (const p of DIFF_PATHS) {
        const expected: { value: unknown; idx?: number }[] = [];
        collect(parsed, p, undefined, expected);
        const got = (res.ranges.get(pathKey(p)) ?? []).map((r) => {
          const value = parseSlice(buf, r, Infinity);
          return r.idx === undefined ? { value } : { value, idx: r.idx };
        });
        expect(got, `${line} @ ${pathKey(p)}`).toEqual(expected);
        hits.set(pathKey(p), (hits.get(pathKey(p)) ?? 0) + expected.length);
      }
    }
    // Every path, including the nested "[]" ones, was exercised at least once.
    for (const p of DIFF_PATHS) expect(hits.get(pathKey(p)), pathKey(p)).toBeGreaterThan(0);
  });
});
