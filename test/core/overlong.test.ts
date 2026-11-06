import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineTailer } from "../../src/core/tailer";
import { classifyLine, isKnownNonUsage, TYPE_HEAD_BYTES } from "../../src/core/extract";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cum-overlong-"));
  file = join(dir, "events.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const b = (s: string) => Buffer.from(s);
const known = (s: string) => isKnownNonUsage(b(s), 0, Buffer.byteLength(s));
const pad = (n: number) => "z".repeat(n);

/** Feeds `line` + "\n" in two appends split at `at`, summing both reads. */
async function splitRead(t: LineTailer, line: string, at: number) {
  await appendFile(file, line.slice(0, at));
  const r1 = await t.read();
  await appendFile(file, line.slice(at) + "\n");
  const r2 = await t.read();
  return { overlong: r1.overlong + r2.overlong, other: r1.overlongOther + r2.overlongOther };
}

describe("isKnownNonUsage", () => {
  it("usage type is never known non-usage", () => {
    expect(known(`{"type":"session.usage_record","x":1}`)).toBe(false);
  });
  it("names that merely share a prefix with the usage type are non-usage (same as classifyLine)", () => {
    for (const name of ["session.usage_recor", "session.usage_record_v2", "session.usage_records"]) {
      const line = `{"type":"${name}","x":1}`;
      expect(known(line)).toBe(true);
      expect(classifyLine(b(line), 0, line.length)).toBe("skip");
    }
  });
  it("empty name, truncated head and escapes are not trusted", () => {
    expect(known(`{"type":"","x":1}`)).toBe(false);
    expect(known(`{"type":"tool.exec`)).toBe(false);
    expect(known(`{"type":"a\\u0062","x":1}`)).toBe(false);
  });
  it("type name of exactly 128 bytes is decided; 129 bytes is not", () => {
    expect(known(`{"type":"${"a".repeat(128)}","x":1}`)).toBe(true);
    expect(known(`{"type":"${"a".repeat(129)}","x":1}`)).toBe(false);
  });
  it("multi-byte UTF-8 type name is decided on bytes", () => {
    expect(known(`{"type":"tool.éx\u{1F600}","x":1}`)).toBe(true);
  });
  it("respects start/end offsets inside a larger buffer", () => {
    const s = `xx{"type":"session.usage_record"}` + `{"type":"tool.x"}`;
    const buf = b(s);
    expect(isKnownNonUsage(buf, 2, 33)).toBe(false);
    expect(isKnownNonUsage(buf, 33, buf.length)).toBe(true);
  });
});

describe("over-long lines: chunk boundaries and limits", () => {
  it("over-long usage record arriving whole in one chunk counts as possibly lost usage", async () => {
    const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 1 << 20 });
    await writeFile(file, `{"type":"session.usage_record","p":"${pad(5000)}"}\n`);
    const r = await t.read();
    expect(r.overlong).toBe(1);
    expect(r.overlongOther).toBe(0);
  });

  it("type name split at every byte inside the head across two reads (short carry + next chunk)", async () => {
    for (const [type, wantOverlong] of [
      ["session.usage_record", 1],
      ["tool.execution_complete", 0],
    ] as const) {
      const line = `{"type":"${type}","p":"${pad(3000)}"}`;
      for (let at = 1; at < TYPE_HEAD_BYTES + 2; at++) {
        await writeFile(file, "");
        const t = new LineTailer(file, { maxCarryBytes: 1024 });
        const r = await splitRead(t, line, at);
        expect({ type, at, ...r }).toEqual({
          type,
          at,
          overlong: wantOverlong,
          other: 1 - wantOverlong,
        });
      }
    }
  });

  it("line exactly at the limit is gated normally; one byte over is over-long", async () => {
    const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 256 });
    const head = `{"type":"session.usage_record","p":"`;
    const at = head + pad(1024 - head.length - 2) + `"}`;
    const over = head + pad(1024 - head.length - 1) + `"}`;
    expect(Buffer.byteLength(at)).toBe(1024);
    await writeFile(file, at + "\n" + over + "\n");
    const r = await t.read();
    expect(r.usageLines).toEqual([at]);
    expect(r.overlong).toBe(1);
    expect(r.overlongOther).toBe(0);
  });

  it("several long lines of mixed kinds in one file are each sorted, and short lines between them survive", async () => {
    const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 300 });
    const u = `{"type":"session.usage_record","x":1}`;
    const lines = [
      `{"type":"tool.execution_complete","p":"${pad(4000)}"}`,
      u,
      `{"type":"session.usage_record","p":"${pad(4000)}"}`,
      `{"type":"user.message","p":"${pad(4000)}"}`,
      u,
      `{"id":1,"type":"tool.x","p":"${pad(4000)}"}`,
    ];
    await writeFile(file, lines.join("\n") + "\n");
    const r = await t.read();
    expect(r.usageLines).toEqual([u, u]);
    expect(r.overlong).toBe(2);
    expect(r.overlongOther).toBe(2);
  });

  it("multi-byte UTF-8 payload straddling chunk boundaries does not change the result", async () => {
    const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 37 });
    await writeFile(file, `{"type":"tool.x","p":"${"\u{1F600}".repeat(2000)}"}\n`);
    const r = await t.read();
    expect(r.overlongOther).toBe(1);
    expect(r.overlong).toBe(0);
  });

  // Consistency with classifyLine: a short line carrying a nested/later usage type is
  // "suspect" (raises the format-changed warning). The same line over the limit should
  // not become silent.
  it("nested usage type inside a long non-usage line is not silently classed as non-usage", async () => {
    const nested = (n: number) =>
      `{"type":"wrapper","data":{"type":"session.usage_record","p":"${pad(n)}"}}`;
    const short = nested(10);
    expect(classifyLine(b(short), 0, short.length)).toBe("suspect");
    const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 1 << 20 });
    await writeFile(file, nested(5000) + "\n");
    const r = await t.read();
    expect(r.overlong + r.suspect).toBeGreaterThan(0);
    expect(r.overlong).toBe(1);
    expect(r.overlongOther).toBe(0);
  });
});
