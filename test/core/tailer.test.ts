import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFile,
  chmod,
  mkdtemp,
  open,
  rename,
  rm,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineTailer } from "../../src/core/tailer";
import { jsonl, otherEvent, usageEvent } from "../fixtures/build";

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
      activity: 0,
      suspect: 0,
      overlong: 0,
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
});
