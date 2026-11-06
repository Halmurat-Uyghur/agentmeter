// Incremental reader for one append-only events.jsonl file. Each read() picks
// up where the last one stopped, gates every complete line through
// classifyLine on raw bytes, and decodes only the lines it calls "usage".
// Truncation, rotation and in-place rewrites reset the cursor to offset 0.
import * as fs from "node:fs";
import { classifyLine } from "./extract";

export type ReadErrorCode = "ENOENT" | "EACCES" | "EPERM" | "EIO" | "OTHER";

export interface TailResult {
  /** decoded, complete lines classified "usage" (trailing \r stripped) */
  usageLines: string[];
  activity: number;
  suspect: number;
  overlong: number;
  reset: boolean;
  error?: ReadErrorCode;
}

export interface TailerOptions {
  maxCarryBytes?: number;
  chunkBytes?: number;
}

interface Cursor {
  dev: number;
  ino: number;
  offset: number;
  /** up to TAIL_BYTES file bytes ending at offset */
  tail: Buffer;
}

const TAIL_BYTES = 64;
const NL = 0x0a;
const CR = 0x0d;
const EMPTY = Buffer.alloc(0);

function errorCode(e: unknown): ReadErrorCode {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EIO"
    ? code
    : "OTHER";
}

export class LineTailer {
  private readonly maxCarryBytes: number;
  private readonly chunkBytes: number;
  private cursor: Cursor | undefined;
  /** bytes of the incomplete last line */
  private carry: Buffer = EMPTY;
  /** inside an over-long line: discard bytes until the next \n */
  private skipping = false;

  constructor(
    private readonly path: string,
    opts: TailerOptions = {},
  ) {
    this.maxCarryBytes = Math.max(1, opts.maxCarryBytes ?? 1_048_576);
    this.chunkBytes = Math.max(1, opts.chunkBytes ?? 262_144);
  }

  get carryLength(): number {
    return this.carry.length;
  }

  async read(): Promise<TailResult> {
    const result: TailResult = {
      usageLines: [],
      activity: 0,
      suspect: 0,
      overlong: 0,
      reset: false,
    };
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(this.path, "r");
      const st = await handle.stat();
      const size = st.size;
      let cur = this.cursor;
      if (
        cur !== undefined &&
        (await this.mustReset(handle, cur, st.dev, st.ino, size))
      ) {
        result.reset = true;
        cur = undefined;
      }
      if (cur === undefined) {
        cur = { dev: st.dev, ino: st.ino, offset: 0, tail: EMPTY };
        this.carry = EMPTY;
        this.skipping = false;
      }
      this.cursor = cur;

      while (cur.offset < size) {
        const want = Math.min(this.chunkBytes, size - cur.offset);
        const chunk = Buffer.allocUnsafe(want);
        const { bytesRead } = await handle.read(chunk, 0, want, cur.offset);
        if (bytesRead === 0) break; // shrank under us; the next read() resets
        const data = chunk.subarray(0, bytesRead);
        this.consume(data, result);
        cur.offset += bytesRead;
        cur.tail =
          bytesRead >= TAIL_BYTES
            ? Buffer.from(data.subarray(bytesRead - TAIL_BYTES))
            : Buffer.concat([cur.tail, data]).subarray(-TAIL_BYTES);
      }
    } catch (e) {
      result.error = errorCode(e);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return result;
  }

  private async mustReset(
    handle: fs.promises.FileHandle,
    cur: Cursor,
    dev: number,
    ino: number,
    size: number,
  ): Promise<boolean> {
    if (dev !== cur.dev || ino !== cur.ino || size < cur.offset) return true;
    const n = cur.tail.length;
    if (n === 0) return false;
    const now = Buffer.alloc(n);
    const { bytesRead } = await handle.read(now, 0, n, cur.offset - n);
    return bytesRead !== n || !now.equals(cur.tail);
  }

  /** Splits data at \n, gates each complete line, and keeps the remainder as carry. */
  private consume(data: Buffer, out: TailResult): void {
    let pos = 0;
    if (this.skipping) {
      const nl = data.indexOf(NL);
      if (nl === -1) return;
      this.skipping = false;
      pos = nl + 1;
    }
    for (
      let nl = data.indexOf(NL, pos);
      nl !== -1;
      nl = data.indexOf(NL, pos)
    ) {
      if (this.carry.length > 0) {
        const line = Buffer.concat([this.carry, data.subarray(pos, nl)]);
        this.carry = EMPTY;
        this.gate(line, 0, line.length, out);
      } else {
        this.gate(data, pos, nl, out);
      }
      pos = nl + 1;
    }
    if (pos >= data.length) return;
    const rest = data.length - pos;
    if (this.carry.length + rest > this.maxCarryBytes) {
      this.carry = EMPTY;
      this.skipping = true;
      out.overlong++;
      return;
    }
    // Copy so the carry does not pin the whole chunk in memory.
    const piece = Buffer.from(data.subarray(pos));
    this.carry =
      this.carry.length > 0 ? Buffer.concat([this.carry, piece]) : piece;
  }

  /** buf[start, end) is one complete line without its \n. */
  private gate(buf: Buffer, start: number, end: number, out: TailResult): void {
    // Same limit whether the line arrived in one chunk or several.
    if (end - start > this.maxCarryBytes) {
      out.overlong++;
      return;
    }
    switch (classifyLine(buf, start, end)) {
      case "usage": {
        const stop = end > start && buf[end - 1] === CR ? end - 1 : end;
        out.usageLines.push(buf.toString("utf8", start, stop));
        break;
      }
      case "activity":
        out.activity++;
        break;
      case "suspect":
        out.suspect++;
        break;
      case "skip":
        break;
    }
  }
}
