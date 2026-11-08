import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFile,
  chmod,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ByteTailer, LineTailer, type LineHandler } from "../../src/core/tailer";
import { CANARY, jsonl, otherEvent, shutdownEvent, usageEvent } from "../fixtures/build";

const TS = "2026-11-05T14:30:00.000Z";

function usage(
  n: number,
  extra: Parameters<typeof usageEvent>[0] = {},
): string {
  return JSON.stringify(
    usageEvent({
      timestamp: TS,
      usageId: `u-${n}`,
      id: `e-${n}`,
      sequence: n,
      ...extra,
    }),
  );
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cum-tailer-"));
  file = join(dir, "events.jsonl");
});

afterEach(async () => {
  await chmod(file, 0o644).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("LineTailer", () => {
  it("complete lines only", async () => {
    const t = new LineTailer(file);
    await writeFile(file, usage(1));
    let r = await t.read();
    expect(r.usageLines).toEqual([]);
    expect(r.error).toBeUndefined();
    expect(r.reset).toBe(false);

    await appendFile(file, "\n");
    r = await t.read();
    expect(r.usageLines).toEqual([usage(1)]);
    expect(r.reset).toBe(false);

    r = await t.read();
    expect(r).toEqual({
      usageLines: [],
      startLines: [],
      shutdownLines: [],
      shutdownOversize: 0,
      activity: 0,
      suspect: 0,
      overlong: 0,
      overlongOther: 0,
      reset: false,
    });
  });

  it("small file grows without false reset", async () => {
    const t = new LineTailer(file);
    const line = usage(1);
    await writeFile(file, line.slice(0, 3));
    let r = await t.read();
    expect(r.usageLines).toEqual([]);
    expect(t.carryLength).toBe(3);

    await appendFile(file, line.slice(3) + "\n");
    r = await t.read();
    expect(r.reset).toBe(false);
    expect(r.usageLines).toEqual([line]);
    expect(t.carryLength).toBe(0);
  });

  it("truncation resets", async () => {
    const t = new LineTailer(file);
    await writeFile(
      file,
      [usage(1), usage(2), usage(3)].map((l) => l + "\n").join(""),
    );
    expect((await t.read()).usageLines).toHaveLength(3);

    await truncate(file, 0);
    await appendFile(file, usage(4) + "\n");
    const r = await t.read();
    expect(r.reset).toBe(true);
    expect(r.usageLines).toEqual([usage(4)]);
  });

  it("in-place rewrite is detected", async () => {
    const t = new LineTailer(file);
    await writeFile(file, usage(1) + "\n");
    expect((await t.read()).usageLines).toEqual([usage(1)]);

    const other = "0000bbbb-0000-4000-8000-000000000002";
    const next =
      usage(7, { sourceSessionId: other }) +
      "\n" +
      usage(8, { sourceSessionId: other }) +
      "\n";
    const h = await open(file, "r+");
    try {
      await h.write(next, 0);
    } finally {
      await h.close();
    }
    const r = await t.read();
    expect(r.reset).toBe(true);
    expect(r.usageLines).toEqual([
      usage(7, { sourceSessionId: other }),
      usage(8, { sourceSessionId: other }),
    ]);
  });

  it("rotation by rename", async () => {
    const t = new LineTailer(file);
    await writeFile(file, usage(1) + "\n" + usage(2) + "\n");
    expect((await t.read()).usageLines).toHaveLength(2);

    await rename(file, join(dir, "events.old.jsonl"));
    // Longer than the old file, so only the inode change can trigger the reset.
    await writeFile(file, usage(3) + "\n" + usage(4) + "\n" + usage(5) + "\n");
    const r = await t.read();
    expect(r.reset).toBe(true);
    expect(r.usageLines).toEqual([usage(3), usage(4), usage(5)]);
  });

  it("deleted file", async () => {
    const t = new LineTailer(file);
    await writeFile(file, usage(1) + "\n" + usage(2) + "\n");
    expect((await t.read()).usageLines).toHaveLength(2);

    await unlink(file);
    const r1 = await t.read();
    expect(r1.error).toBe("ENOENT");
    expect(r1.usageLines).toEqual([]);

    await writeFile(file, usage(3) + "\n");
    const r2 = await t.read();
    expect(r2.error).toBeUndefined();
    expect(r2.reset).toBe(true);
    expect(r2.usageLines).toEqual([usage(3)]);
  });

  it("missing from the start is ENOENT, not a throw", async () => {
    const t = new LineTailer(join(dir, "nope.jsonl"));
    const r = await t.read();
    expect(r.error).toBe("ENOENT");
  });

  it.skipIf(process.getuid?.() === 0)("permission error", async () => {
    const t = new LineTailer(file);
    await writeFile(file, usage(1) + "\n");
    expect((await t.read()).usageLines).toEqual([usage(1)]);

    await appendFile(file, usage(2) + "\n");
    await chmod(file, 0o000);
    const r1 = await t.read();
    expect(r1.error).toBe("EACCES");
    expect(r1.usageLines).toEqual([]);

    await chmod(file, 0o644);
    const r2 = await t.read();
    expect(r2.error).toBeUndefined();
    expect(r2.reset).toBe(false);
    expect(r2.usageLines).toEqual([usage(2)]);
  });

  it("skips over-long line and resyncs", async () => {
    const t = new LineTailer(file, { maxCarryBytes: 1024 });
    await writeFile(file, "");
    let r = await t.read();
    expect(t.carryLength).toBeLessThanOrEqual(1024);

    // Arrives in pieces, so the carry grows across reads before it overflows.
    let overlong = 0;
    for (let i = 0; i < 5; i++) {
      await appendFile(file, "x".repeat(1000));
      r = await t.read();
      overlong += r.overlong;
      expect(r.usageLines).toEqual([]);
      expect(t.carryLength).toBeLessThanOrEqual(1024);
    }
    expect(overlong).toBe(1);

    await appendFile(file, "\n" + usage(1) + "\n");
    r = await t.read();
    overlong += r.overlong;
    expect(overlong).toBe(1);
    expect(r.usageLines).toEqual([usage(1)]);
    expect(t.carryLength).toBeLessThanOrEqual(1024);
  });

  it("over-long line in a single write counts once and resyncs", async () => {
    const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 256 });
    await writeFile(file, "y".repeat(5000));
    const r1 = await t.read();
    expect(r1.overlong).toBe(1);
    expect(t.carryLength).toBeLessThanOrEqual(1024);

    await appendFile(file, "tail-of-long-line\n" + usage(1) + "\n");
    const r2 = await t.read();
    expect(r2.overlong).toBe(0);
    expect(r2.suspect).toBe(0);
    expect(r2.usageLines).toEqual([usage(1)]);
  });

  describe("over-long lines are sorted by their type", () => {
    // A large non-usage event (tool output, a pasted file) padded past the limit.
    const big = (type: string, n = 5000) =>
      `{"type":"${type}","data":{"text":"${"z".repeat(n)}"}}`;

    it("a known non-usage type is skipped without risking totals", async () => {
      const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 256 });
      await writeFile(file, big("tool.execution_complete") + "\n" + usage(1) + "\n");
      const r = await t.read();
      expect(r.overlong).toBe(0);
      expect(r.overlongOther).toBe(1);
      expect(r.usageLines).toEqual([usage(1)]);
    });

    it("same result when the long line arrives whole in one chunk", async () => {
      const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 1 << 20 });
      await writeFile(file, big("user.message") + "\n" + usage(1) + "\n");
      const r = await t.read();
      expect(r.overlong).toBe(0);
      expect(r.overlongOther).toBe(1);
      expect(r.usageLines).toEqual([usage(1)]);
    });

    it("same result when the long line grows across reads", async () => {
      const t = new LineTailer(file, { maxCarryBytes: 1024 });
      const line = big("tool.execution_complete");
      let overlong = 0;
      let other = 0;
      for (let i = 0; i < line.length; i += 700) {
        await appendFile(file, line.slice(i, i + 700));
        const r = await t.read();
        overlong += r.overlong;
        other += r.overlongOther;
      }
      await appendFile(file, "\n");
      const r = await t.read();
      overlong += r.overlong;
      other += r.overlongOther;
      expect(overlong).toBe(0);
      expect(other).toBe(1);
    });

    it("an over-long usage record still counts as possibly lost usage", async () => {
      const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 256 });
      await writeFile(file, big("session.usage_record") + "\n");
      const r = await t.read();
      expect(r.overlong).toBe(1);
      expect(r.overlongOther).toBe(0);
    });

    it("a line whose type is not first, or is re-spaced, counts as possibly lost usage", async () => {
      const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 256 });
      await writeFile(
        file,
        `{"id":"x","type":"tool.execution_complete","p":"${"z".repeat(5000)}"}\n` +
          `{ "type": "tool.execution_complete","p":"${"z".repeat(5000)}"}\n`,
      );
      const r = await t.read();
      expect(r.overlong).toBe(2);
      expect(r.overlongOther).toBe(0);
    });

    it("an escaped quote in the type name is not trusted", async () => {
      const t = new LineTailer(file, { maxCarryBytes: 1024, chunkBytes: 256 });
      await writeFile(file, `{"type":"a\\"b","p":"${"z".repeat(5000)}"}\n`);
      const r = await t.read();
      expect(r.overlong).toBe(1);
      expect(r.overlongOther).toBe(0);
    });
  });

  it("activity counted, not decoded", async () => {
    const t = new LineTailer(file);
    const turnEnd = otherEvent("assistant.turn_end");
    await writeFile(
      file,
      jsonl([turnEnd, turnEnd, turnEnd, otherEvent("user.message")]),
    );
    const r = await t.read();
    expect(r.activity).toBe(3);
    expect(r.usageLines).toEqual([]);
    expect(r.suspect).toBe(0);
  });

  it("suspect lines are counted", async () => {
    const t = new LineTailer(file);
    await writeFile(file, `{"id":"x","type":"session.usage_record"}\n`);
    const r = await t.read();
    expect(r.suspect).toBe(1);
    expect(r.usageLines).toEqual([]);
  });

  it("CRLF line endings are stripped", async () => {
    const t = new LineTailer(file);
    await writeFile(file, usage(1) + "\r\n" + usage(2) + "\r\n");
    const r = await t.read();
    expect(r.usageLines).toEqual([usage(1), usage(2)]);
  });

  it("UTF-8 split across reads decodes intact", async () => {
    const t = new LineTailer(file);
    const line = usage(1, { model: "modèle-é" });
    const bytes = Buffer.from(line + "\n", "utf8");
    const cut = bytes.indexOf(Buffer.from("è", "utf8")) + 1; // mid-character
    await writeFile(file, bytes.subarray(0, cut));
    expect((await t.read()).usageLines).toEqual([]);
    await appendFile(file, bytes.subarray(cut));
    const r = await t.read();
    expect(r.usageLines).toEqual([line]);
  });

  it("UTF-8 split across chunks decodes intact", async () => {
    const t = new LineTailer(file, { chunkBytes: 7 });
    const lines = [usage(1, { model: "modèle-é" }), usage(2, { model: "ééé" })];
    await writeFile(file, lines.map((l) => l + "\n").join(""));
    const r = await t.read();
    expect(r.usageLines).toEqual(lines);
  });

  it("shutdown lines are delivered only with decodeShutdown (CRLF stripped)", async () => {
    const sd = JSON.stringify(shutdownEvent({ timestamp: TS }));
    await writeFile(file, usage(1) + "\n" + sd + "\r\n");
    const toStr = vi.spyOn(Buffer.prototype, "toString");
    const off = await new LineTailer(file).read();
    const offDecodes = toStr.mock.calls.length;
    toStr.mockRestore();
    expect(off.shutdownLines).toEqual([]);
    expect(off.shutdownOversize).toBe(0);
    expect(off.suspect).toBe(0);
    expect(offDecodes).toBe(1); // the usage line only
    const on = await new LineTailer(file, { decodeShutdown: true }).read();
    expect(on.shutdownLines).toEqual([sd]);
    expect(on.usageLines).toEqual([usage(1)]);
  });

  it("a reordered shutdown line is suspect only when shutdown lines are read", async () => {
    await writeFile(file, '{"id":"x","type":"session.shutdown","data":{}}\n');
    expect((await new LineTailer(file).read()).suspect).toBe(0);
    expect((await new LineTailer(file, { decodeShutdown: true }).read()).suspect).toBe(1);
  });

  it("a shutdown line over MAX_SHUTDOWN_BYTES is counted, not decoded", async () => {
    const big = JSON.stringify(shutdownEvent({ timestamp: TS })).replace('"routine"', `"${CANARY.repeat(4000)}"`);
    expect(big.length).toBeGreaterThan(64 * 1024);
    await writeFile(file, big + "\n" + usage(1) + "\n");
    const toStr = vi.spyOn(Buffer.prototype, "toString");
    const r = await new LineTailer(file, { decodeShutdown: true }).read();
    const decodes = toStr.mock.calls.length;
    toStr.mockRestore();
    expect(r.shutdownOversize).toBe(1);
    expect(r.shutdownLines).toEqual([]);
    expect(r.overlong + r.overlongOther).toBe(0);
    expect(decodes).toBe(1);
  });
});

describe("UTF-8 BOM at the file start (review A5)", () => {
  const BOM = "\uFEFF";
  const start = JSON.stringify(otherEvent("session.start", { timestamp: TS, data: { context: { cwd: "/x/proj" } } }));

  it.each([1, 2, 3, 4, 262_144])("BOM + session.start: the start line is found (chunk %i)", async (chunkBytes) => {
    await writeFile(file, BOM + start + "\n" + usage(1) + "\n");
    const r = await new LineTailer(file, { decodeStart: true, chunkBytes }).read();
    expect(r.startLines).toEqual([start]);
    expect(r.usageLines).toEqual([usage(1)]);
  });

  it("BOM + usage line: one usage, zero suspect", async () => {
    await writeFile(file, BOM + usage(1) + "\n");
    const r = await new LineTailer(file).read();
    expect({ usage: r.usageLines, suspect: r.suspect }).toEqual({ usage: [usage(1)], suspect: 0 });
  });

  it("a BOM written in pieces is still skipped, and the cursor survives later appends", async () => {
    const t = new LineTailer(file);
    await writeFile(file, Buffer.from([0xef, 0xbb]));
    expect((await t.read()).usageLines).toEqual([]);
    await appendFile(file, Buffer.concat([Buffer.from([0xbf]), Buffer.from(usage(1) + "\n")]));
    let r = await t.read();
    expect({ usage: r.usageLines, suspect: r.suspect, reset: r.reset }).toEqual({ usage: [usage(1)], suspect: 0, reset: false });
    await appendFile(file, usage(2) + "\n");
    r = await t.read();
    expect({ usage: r.usageLines, reset: r.reset }).toEqual({ usage: [usage(2)], reset: false });
  });

  it("a BOM later in the file is not skipped", async () => {
    await writeFile(file, usage(1) + "\n" + BOM + usage(2) + "\n");
    const r = await new LineTailer(file).read();
    expect(r.usageLines).toEqual([usage(1)]);
    expect(r.suspect).toBe(1);
  });
});

describe("only a regular file is read (review A7)", () => {
  it.skipIf(process.platform === "win32")(
    "events.jsonl swapped for a FIFO after a read: the next read returns an error, not a hang",
    async () => {
      const t = new LineTailer(file);
      await writeFile(file, usage(1) + "\n");
      expect((await t.read()).usageLines).toEqual([usage(1)]);
      const fifo = join(dir, "x.fifo");
      execFileSync("mkfifo", [fifo]);
      await rename(fifo, file);
      const r = await t.read();
      expect(r.error).toBe("OTHER");
      expect(r.usageLines).toEqual([]);
    },
    5000,
  );

  it.skipIf(process.platform === "win32")(
    "events.jsonl swapped for a symlink to a file outside the folder: its lines are not read",
    async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), "cum-outside-"));
      try {
        const outside = join(outsideDir, "outside.jsonl");
        await writeFile(outside, usage(1) + "\n" + usage(2, { usageId: CANARY }) + "\n");
        const t = new LineTailer(file);
        await writeFile(file, usage(1) + "\n");
        expect((await t.read()).usageLines).toEqual([usage(1)]);
        await symlink(outside, file + ".tmp");
        await rename(file + ".tmp", file);
        const r = await t.read();
        expect(r.error).toBe("OTHER");
        expect(r.usageLines).toEqual([]);
        expect(JSON.stringify(r)).not.toContain(CANARY);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it("a directory in place of events.jsonl is an error", async () => {
    await mkdtemp(join(dir, "d-")).then((d) => rename(d, file));
    const r = await new LineTailer(file).read();
    expect(r.error).toBeDefined();
  });
});

describe("ByteTailer", () => {
  interface Seen {
    lines: string[];
    overlong: { text: string; whole: boolean }[];
  }
  function recorder(): { seen: Seen; handler: LineHandler } {
    const seen: Seen = { lines: [], overlong: [] };
    return {
      seen,
      handler: {
        line: (buf, start, end) => seen.lines.push(buf.toString("utf8", start, end)),
        overlong: (buf, start, end, whole) => seen.overlong.push({ text: buf.toString("utf8", start, end), whole }),
      },
    };
  }

  it("two tailers interleaved over the shared chunk buffer still deliver correct lines", async () => {
    const fileB = join(dir, "b.jsonl");
    const a = recorder();
    const b = recorder();
    const ta = new ByteTailer(file, a.handler, { chunkBytes: 8 });
    const tb = new ByteTailer(fileB, b.handler, { chunkBytes: 8 });
    // A reads, keeping a carry from the shared chunk; B then overwrites that chunk.
    await writeFile(file, "alpha-one\nalpha-tw");
    await writeFile(fileB, "bravo-one-long-line\nbravo-two\nbr");
    await ta.read();
    await tb.read();
    await appendFile(file, "o\nalpha-three\n");
    await appendFile(fileB, "avo-three\n");
    await ta.read();
    await tb.read();
    expect(a.seen.lines).toEqual(["alpha-one", "alpha-two", "alpha-three"]);
    expect(b.seen.lines).toEqual(["bravo-one-long-line", "bravo-two", "bravo-three"]);
    // Concurrent reads: the second gets its own buffer while the first holds the shared one.
    const c = recorder();
    const d = recorder();
    const fileC = join(dir, "c.jsonl");
    const fileD = join(dir, "d.jsonl");
    const many = (p: string): string => Array.from({ length: 200 }, (_, i) => `${p}-${i}`).join("\n") + "\n";
    await writeFile(fileC, many("c"));
    await writeFile(fileD, many("d"));
    await Promise.all([new ByteTailer(fileC, c.handler, { chunkBytes: 5 }).read(), new ByteTailer(fileD, d.handler, { chunkBytes: 5 }).read()]);
    expect(c.seen.lines).toEqual(many("c").trimEnd().split("\n"));
    expect(d.seen.lines).toEqual(many("d").trimEnd().split("\n"));
  });

  it("a line split mid-way across two reads is delivered once, whole", async () => {
    const { seen, handler } = recorder();
    const t = new ByteTailer(file, handler);
    await writeFile(file, "alpha\nbra");
    expect(await t.read()).toEqual({ reset: false });
    expect(seen.lines).toEqual(["alpha"]);
    expect(t.carryLength).toBe(3);
    await appendFile(file, "vo\r\ncharlie\n");
    expect(await t.read()).toEqual({ reset: false });
    expect(seen.lines).toEqual(["alpha", "bravo\r", "charlie"]);
    expect(t.carryLength).toBe(0);
    expect(seen.overlong).toEqual([]);
  });

  it("an over-long line that arrives in one read is passed whole", async () => {
    const { seen, handler } = recorder();
    const t = new ByteTailer(file, handler, { maxLineBytes: 100, chunkBytes: 1 << 20 });
    const long = "L".repeat(500);
    await writeFile(file, long + "\nok\n");
    await t.read();
    expect(seen.overlong).toEqual([{ text: long, whole: true }]);
    expect(seen.lines).toEqual(["ok"]);
  });

  it("an over-long line streamed across chunks passes exactly headBytes of its head", async () => {
    const { seen, handler } = recorder();
    const t = new ByteTailer(file, handler, { maxLineBytes: 100, chunkBytes: 16, headBytes: 40 });
    const long = Array.from({ length: 50 }, (_, i) => String(i).padStart(4, "0")).join("");
    await writeFile(file, long + "\nok\n");
    await t.read();
    expect(seen.overlong).toEqual([{ text: long.slice(0, 40), whole: false }]);
    expect(seen.lines).toEqual(["ok"]);
  });

  it("headBytes: 4096 is honoured", async () => {
    const { seen, handler } = recorder();
    const t = new ByteTailer(file, handler, { maxLineBytes: 8192, chunkBytes: 1000, headBytes: 4096 });
    const long = Array.from({ length: 5000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("").repeat(3);
    await writeFile(file, long + "\nok\n");
    await t.read();
    expect(seen.overlong).toHaveLength(1);
    expect(seen.overlong[0]).toEqual({ text: long.slice(0, 4096), whole: false });
    expect(seen.lines).toEqual(["ok"]);
  });

  it("truncation resets and re-delivers from offset 0", async () => {
    const { seen, handler } = recorder();
    const t = new ByteTailer(file, handler);
    await writeFile(file, "one\ntwo\npart");
    await t.read();
    expect(seen.lines).toEqual(["one", "two"]);
    await truncate(file, 0);
    await appendFile(file, "three\n");
    expect(await t.read()).toEqual({ reset: true });
    expect(seen.lines).toEqual(["one", "two", "three"]);
    expect(t.carryLength).toBe(0);
  });

  it("an over-long line whose head spans a carry shorter than headBytes passes exactly headBytes", async () => {
    const { seen, handler } = recorder();
    const t = new ByteTailer(file, handler, { maxLineBytes: 100, headBytes: 40 });
    await writeFile(file, "ok1\nab");
    await t.read();
    expect(seen.lines).toEqual(["ok1"]);
    expect(t.carryLength).toBe(2); // the carry is non-empty and shorter than headBytes
    const body = Array.from({ length: 50 }, (_, i) => String(i).padStart(4, "0")).join("");
    await appendFile(file, body); // no \n yet: carry + rest overflows, the concat branch builds the head
    await t.read();
    expect(seen.overlong).toEqual([{ text: ("ab" + body).slice(0, 40), whole: false }]);
    expect(Buffer.byteLength(seen.overlong[0]!.text)).toBe(40);
    expect(t.carryLength).toBe(0);
    await appendFile(file, "tail\nok2\n");
    await t.read();
    expect(seen.lines).toEqual(["ok1", "ok2"]);
    expect(seen.overlong).toHaveLength(1);
  });

  it("after a reset an over-long line still reports whole=false with its own head", async () => {
    const { seen, handler } = recorder();
    const t = new ByteTailer(file, handler, { maxLineBytes: 100, chunkBytes: 16, headBytes: 40 });
    const a = "A".repeat(30) + Array.from({ length: 50 }, (_, i) => String(i).padStart(4, "0")).join("");
    await writeFile(file, a); // over-long and unfinished: the tailer is left skipping
    await t.read();
    expect(seen.overlong).toEqual([{ text: a.slice(0, 40), whole: false }]);
    await truncate(file, 0);
    const b = Array.from({ length: 60 }, (_, i) => `b${String(i).padStart(3, "0")}`).join("");
    await writeFile(file, b + "\nok\n");
    expect(await t.read()).toEqual({ reset: true });
    expect(seen.overlong).toEqual([
      { text: a.slice(0, 40), whole: false },
      { text: b.slice(0, 40), whole: false },
    ]);
    expect(seen.lines).toEqual(["ok"]);
  });

  it.skipIf(process.platform === "win32")(
    "a FIFO path yields error OTHER without blocking",
    async () => {
      const fifo = join(dir, "y.fifo");
      execFileSync("mkfifo", [fifo]);
      const { seen, handler } = recorder();
      const r = await new ByteTailer(fifo, handler).read();
      expect(r).toEqual({ reset: false, error: "OTHER" });
      expect(seen.lines).toEqual([]);
    },
    5000,
  );

  it("a missing file is ENOENT, not a throw", async () => {
    const { handler } = recorder();
    expect(await new ByteTailer(join(dir, "nope"), handler).read()).toEqual({ reset: false, error: "ENOENT" });
  });
});
