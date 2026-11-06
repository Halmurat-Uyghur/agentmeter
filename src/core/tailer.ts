// Incremental reader for one append-only events.jsonl file. Each read() picks
// up where the last one stopped, gates every complete line through
// classifyLine on raw bytes, and decodes only the lines it calls "usage"
// (plus bounded "start" and "shutdown" lines when asked to).
// Truncation, rotation and in-place rewrites reset the cursor to offset 0.
import * as fs from "node:fs";
import {
  classifyLine,
  hasShutdownNeedle,
  hasUsageNeedle,
  isKnownNonUsage,
  isShutdownHead,
  MAX_SHUTDOWN_BYTES,
  TYPE_HEAD_BYTES,
} from "./extract";

export type ReadErrorCode = "ENOENT" | "EACCES" | "EPERM" | "EIO" | "OTHER";

export interface TailResult {
  /** decoded, complete lines classified "usage" (trailing \r stripped) */
  usageLines: string[];
  /** decoded session.start lines (only when `decodeStart`) */
  startLines: string[];
  /** decoded session.shutdown lines of at most MAX_SHUTDOWN_BYTES (only when `decodeShutdown`) */
  shutdownLines: string[];
  /** session.shutdown lines too long to decode (only when `decodeShutdown`); totals may be short */
  shutdownOversize: number;
  activity: number;
  suspect: number;
  /** lines over the size limit that may have been usage records (totals may be short) */
  overlong: number;
  /** lines over the size limit whose type shows they are not usage records */
  overlongOther: number;
  reset: boolean;
  error?: ReadErrorCode;
}

export interface TailerOptions {
  maxCarryBytes?: number;
  chunkBytes?: number;
  /** decode session.start lines for the project label (D25); default false */
  decodeStart?: boolean;
  /** decode session.shutdown lines for session totals (D29); default false = never decoded */
  decodeShutdown?: boolean;
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
  private readonly decodeStart: boolean;
  private readonly decodeShutdown: boolean;

  constructor(
    private readonly path: string,
    opts: TailerOptions = {},
  ) {
    this.maxCarryBytes = Math.max(1, opts.maxCarryBytes ?? 1_048_576);
    this.chunkBytes = Math.max(1, opts.chunkBytes ?? 262_144);
    this.decodeStart = opts.decodeStart === true;
    this.decodeShutdown = opts.decodeShutdown === true;
  }

  get carryLength(): number {
    return this.carry.length;
  }

  async read(): Promise<TailResult> {
    const result: TailResult = {
      usageLines: [],
      startLines: [],
      shutdownLines: [],
      shutdownOversize: 0,
      activity: 0,
      suspect: 0,
      overlong: 0,
      overlongOther: 0,
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
      // The line's first bytes are the carry (if any) followed by data[pos..].
      // Only this head is held: the rest of the line is never in memory, so a
      // usage type nested deeper in it can't be seen here (unlike in gate(),
      // which holds the whole line). A line whose head names another type is
      // counted as overlongOther; that is an inherent limit of streaming.
      const head =
        this.carry.length >= TYPE_HEAD_BYTES
          ? this.carry.subarray(0, TYPE_HEAD_BYTES)
          : this.carry.length > 0
            ? Buffer.concat([
                this.carry,
                data.subarray(pos, pos + TYPE_HEAD_BYTES - this.carry.length),
              ])
            : data.subarray(pos, pos + TYPE_HEAD_BYTES);
      this.countOverlong(head, 0, head.length, out);
      this.carry = EMPTY;
      this.skipping = true;
      return;
    }
    // Copy so the carry does not pin the whole chunk in memory.
    const piece = Buffer.from(data.subarray(pos));
    this.carry =
      this.carry.length > 0 ? Buffer.concat([this.carry, piece]) : piece;
  }

  /** Counts a skipped over-long line by what its first bytes show it to be. */
  private countOverlong(buf: Buffer, start: number, end: number, out: TailResult): void {
    if (this.decodeShutdown && isShutdownHead(buf, start, end)) out.shutdownOversize++;
    else if (isKnownNonUsage(buf, start, end)) out.overlongOther++;
    else out.overlong++;
  }

  /** buf[start, end) is one complete line without its \n. */
  private gate(buf: Buffer, start: number, end: number, out: TailResult): void {
    // Same limit whether the line arrived in one chunk or several.
    if (end - start > this.maxCarryBytes) {
      // The whole line is in memory here, so also search it like classifyLine
      // does: a usage type nested deeper in the line makes it possibly-usage.
      if (hasUsageNeedle(buf, start, end)) out.overlong++;
      else if (this.decodeShutdown && hasShutdownNeedle(buf, start, end)) out.shutdownOversize++;
      else this.countOverlong(buf, start, end, out);
      return;
    }
    switch (classifyLine(buf, start, end)) {
      case "usage": {
        const stop = end > start && buf[end - 1] === CR ? end - 1 : end;
        out.usageLines.push(buf.toString("utf8", start, stop));
        break;
      }
      case "start": {
        if (!this.decodeStart) break;
        const stop = end > start && buf[end - 1] === CR ? end - 1 : end;
        out.startLines.push(buf.toString("utf8", start, stop));
        break;
      }
      case "shutdown": {
        if (!this.decodeShutdown) break;
        if (end - start > MAX_SHUTDOWN_BYTES) {
          out.shutdownOversize++;
          break;
        }
        const stop = end > start && buf[end - 1] === CR ? end - 1 : end;
        out.shutdownLines.push(buf.toString("utf8", start, stop));
        break;
      }
      case "activity":
        out.activity++;
        break;
      case "suspect":
        // With session totals off, a line that only looks like a moved shutdown
        // type is skipped, as it was before v0.4.
        if (this.decodeShutdown || hasUsageNeedle(buf, start, end)) out.suspect++;
        break;
      case "skip":
        break;
    }
  }
}
