// Incremental readers for one append-only JSONL file. ByteTailer is the
// byte-level core: each read() picks up where the last one stopped and hands
// every complete line (and every over-long line) to a LineHandler, without
// decoding anything itself. Truncation, rotation and in-place rewrites reset
// the cursor to offset 0.
// LineTailer is the Copilot events.jsonl reader on top of it: it gates every
// line through classifyLine on raw bytes and decodes only the lines it calls
// "usage" (plus bounded "start" and "shutdown" lines when asked to).
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

/**
 * Receives each line ByteTailer reads. Neither method may throw: a throw mid-chunk
 * aborts read() before the cursor advances past that chunk, so the next read()
 * re-delivers the lines already handed over from it.
 */
export interface LineHandler {
  /** one complete line buf[start, end) without its \n (a trailing \r may be present) */
  line(buf: Buffer, start: number, end: number): void;
  /** a line longer than maxLineBytes: `whole` true when the entire line is in buf[start, end) (it arrived complete), false when only its first headBytes are */
  overlong(buf: Buffer, start: number, end: number, whole: boolean): void;
}

export interface ByteTailerOptions {
  /** longest line handed to `line()`; default 1_048_576 */
  maxLineBytes?: number;
  /** bytes per read call; default 262_144 */
  chunkBytes?: number;
  /** bytes of an over-long line's head kept for `overlong()`; default TYPE_HEAD_BYTES */
  headBytes?: number;
}

export interface ByteTailResult {
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
/** UTF-8 byte order mark; skipped at offset 0 only (review A5). */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/**
 * Read-only; never follow a symlink swapped in after discovery, and never block on
 * a FIFO (review A7). `?? 0` keeps Windows, which lacks both flags, working.
 */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * One scratch chunk buffer shared by every ByteTailer, allocated lazily at the largest
 * chunkBytes asked for. A read borrows it for its whole duration; a read that starts while
 * another holds it (reads are sequential in the monitor, but be safe) gets a fresh buffer.
 * Nothing may keep a view of it past the call it was handed in: the tailer copies its carry
 * and tail (Buffer.from / Buffer.concat), and the line handlers copy what they keep (Copilot
 * decodes lines to strings; the Claude Code and Codex readers decode slices into fresh values
 * and classify over-long heads in place).
 */
let scratch: Buffer | undefined;
let scratchBusy = false;

function borrowScratch(size: number): { buf: Buffer; shared: boolean } {
  if (scratchBusy) return { buf: Buffer.allocUnsafe(size), shared: false };
  if (scratch === undefined || scratch.length < size) scratch = Buffer.allocUnsafe(size);
  scratchBusy = true;
  return { buf: scratch, shared: true };
}

function errorCode(e: unknown): ReadErrorCode {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EIO"
    ? code
    : "OTHER";
}

export class ByteTailer {
  private readonly maxLineBytes: number;
  private readonly chunkBytes: number;
  private readonly headBytes: number;
  private cursor: Cursor | undefined;
  /** bytes of the incomplete last line */
  private carry: Buffer = EMPTY;
  /** inside an over-long line: discard bytes until the next \n */
  private skipping = false;

  constructor(
    private readonly path: string,
    private readonly handler: LineHandler,
    opts: ByteTailerOptions = {},
  ) {
    this.maxLineBytes = Math.max(1, opts.maxLineBytes ?? 1_048_576);
    this.chunkBytes = Math.max(1, opts.chunkBytes ?? 262_144);
    this.headBytes = Math.max(1, opts.headBytes ?? TYPE_HEAD_BYTES);
  }

  get carryLength(): number {
    return this.carry.length;
  }

  /** Never throws: errors come back as `error`, after any lines already handled. */
  async read(): Promise<ByteTailResult> {
    const result: ByteTailResult = { reset: false };
    let handle: fs.promises.FileHandle | undefined;
    let chunkBuf: { buf: Buffer; shared: boolean } | undefined;
    try {
      handle = await fs.promises.open(this.path, OPEN_FLAGS);
      const st = await handle.stat();
      // A FIFO, device or directory is unreadable, never waited on (review A7).
      if (!st.isFile()) {
        result.error = "OTHER";
        return result; // the finally closes the handle
      }
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
      if (cur.offset === 0 && !(await this.skipBom(handle, cur, size))) return result;

      if (cur.offset < size) chunkBuf = borrowScratch(this.chunkBytes);
      while (cur.offset < size && chunkBuf !== undefined) {
        const want = Math.min(this.chunkBytes, size - cur.offset);
        const chunk = chunkBuf.buf;
        const { bytesRead } = await handle.read(chunk, 0, want, cur.offset);
        if (bytesRead === 0) break; // shrank under us; the next read() resets
        const data = chunk.subarray(0, bytesRead);
        this.consume(data);
        cur.offset += bytesRead;
        cur.tail =
          bytesRead >= TAIL_BYTES
            ? Buffer.from(data.subarray(bytesRead - TAIL_BYTES))
            : Buffer.concat([cur.tail, data]).subarray(-TAIL_BYTES);
      }
    } catch (e) {
      result.error = errorCode(e);
    } finally {
      if (chunkBuf?.shared === true) scratchBusy = false;
      await handle?.close().catch(() => undefined);
    }
    return result;
  }

  /**
   * At offset 0: steps past a UTF-8 BOM so the first line classifies normally.
   * False while the file holds only part of a BOM (wait for the rest).
   */
  private async skipBom(handle: fs.promises.FileHandle, cur: Cursor, size: number): Promise<boolean> {
    const n = Math.min(BOM.length, size);
    if (n === 0) return true;
    const head = Buffer.alloc(n);
    const { bytesRead } = await handle.read(head, 0, n, 0);
    if (!head.subarray(0, bytesRead).equals(BOM.subarray(0, bytesRead))) return true;
    if (bytesRead < BOM.length) return false;
    cur.offset = BOM.length;
    cur.tail = Buffer.from(BOM);
    return true;
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

  /** Splits data at \n, hands on each complete line, and keeps the remainder as carry. */
  private consume(data: Buffer): void {
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
        this.complete(line, 0, line.length);
      } else {
        this.complete(data, pos, nl);
      }
      pos = nl + 1;
    }
    if (pos >= data.length) return;
    const rest = data.length - pos;
    if (this.carry.length + rest > this.maxLineBytes) {
      // The line's first bytes are the carry (if any) followed by data[pos..].
      // Only this head is held: the rest of the line is never in memory, so
      // the handler sees just its first headBytes (whole = false). The line is
      // then skipped up to its \n.
      const head =
        this.carry.length >= this.headBytes
          ? this.carry.subarray(0, this.headBytes)
          : this.carry.length > 0
            ? Buffer.concat([
                this.carry,
                data.subarray(pos, pos + this.headBytes - this.carry.length),
              ])
            : data.subarray(pos, pos + this.headBytes);
      this.handler.overlong(head, 0, head.length, false);
      this.carry = EMPTY;
      this.skipping = true;
      return;
    }
    // Copy so the carry does not pin the whole chunk in memory.
    const piece = Buffer.from(data.subarray(pos));
    this.carry =
      this.carry.length > 0 ? Buffer.concat([this.carry, piece]) : piece;
  }

  /** buf[start, end) is one complete line without its \n. */
  private complete(buf: Buffer, start: number, end: number): void {
    // Same limit whether the line arrived in one chunk or several.
    if (end - start > this.maxLineBytes) this.handler.overlong(buf, start, end, true);
    else this.handler.line(buf, start, end);
  }
}

function emptyTailResult(): TailResult {
  return {
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
}

/** Copilot's per-line logic: classifyLine gating and over-long counting into `out`. */
class CopilotLineHandler implements LineHandler {
  /** the result of the read() in progress */
  out: TailResult = emptyTailResult();

  constructor(
    private readonly decodeStart: boolean,
    private readonly decodeShutdown: boolean,
  ) {}

  overlong(buf: Buffer, start: number, end: number, whole: boolean): void {
    const out = this.out;
    // With the whole line in memory, also search it like classifyLine does: a
    // usage type nested deeper in the line makes it possibly-usage. From a head
    // alone a usage type nested deeper can't be seen; a line whose head names
    // another type is counted as overlongOther, an inherent limit of streaming.
    if (whole) {
      if (hasUsageNeedle(buf, start, end)) {
        out.overlong++;
        return;
      }
      if (this.decodeShutdown && hasShutdownNeedle(buf, start, end)) {
        out.shutdownOversize++;
        return;
      }
    }
    this.countOverlong(buf, start, end);
  }

  /** Counts a skipped over-long line by what its first bytes show it to be. */
  private countOverlong(buf: Buffer, start: number, end: number): void {
    const out = this.out;
    if (this.decodeShutdown && isShutdownHead(buf, start, end)) out.shutdownOversize++;
    else if (isKnownNonUsage(buf, start, end)) out.overlongOther++;
    else out.overlong++;
  }

  line(buf: Buffer, start: number, end: number): void {
    const out = this.out;
    const stop = end > start && buf[end - 1] === CR ? end - 1 : end;
    switch (classifyLine(buf, start, end)) {
      case "usage":
        out.usageLines.push(buf.toString("utf8", start, stop));
        break;
      case "start":
        if (this.decodeStart) out.startLines.push(buf.toString("utf8", start, stop));
        break;
      case "shutdown":
        if (!this.decodeShutdown) break;
        if (end - start > MAX_SHUTDOWN_BYTES) out.shutdownOversize++;
        else out.shutdownLines.push(buf.toString("utf8", start, stop));
        break;
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

/** The Copilot events.jsonl reader: a ByteTailer with the Copilot line handler. */
export class LineTailer {
  private readonly handler: CopilotLineHandler;
  private readonly bytes: ByteTailer;

  constructor(path: string, opts: TailerOptions = {}) {
    this.handler = new CopilotLineHandler(opts.decodeStart === true, opts.decodeShutdown === true);
    this.bytes = new ByteTailer(path, this.handler, {
      maxLineBytes: opts.maxCarryBytes,
      chunkBytes: opts.chunkBytes,
    });
  }

  get carryLength(): number {
    return this.bytes.carryLength;
  }

  async read(): Promise<TailResult> {
    const result = emptyTailResult();
    this.handler.out = result;
    const { reset, error } = await this.bytes.read();
    result.reset = reset;
    if (error !== undefined) result.error = error;
    return result;
  }
}
