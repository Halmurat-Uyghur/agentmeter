// The JSON path scanner (D41). Claude Code and Codex lines mix usage numbers
// with prompts, replies and whole files, so a line is never decoded whole.
// scanJson walks the raw bytes once, tracking depth and the current key, and
// returns byte ranges for values at requested absolute paths only. String
// bodies are skipped byte by byte and never decoded; keys are compared as raw
// bytes. The only decode in the new readers is parseSlice, bounded to
// MAX_SLICE_BYTES, and callers pass it only ranges the scanner returned.

/** Largest slice parseSlice will decode. */
export const MAX_SLICE_BYTES = 4096;
/** Containers nested deeper than this are skipped without looking inside. */
export const MAX_SCAN_DEPTH = 8;

/** A path: object keys and "[]" for any array element. */
export type ScanPath = readonly string[];

export interface SliceRange {
  start: number;
  end: number;
  /** element index at the first "[]" of the path, when the path has one */
  idx?: number;
}

export interface ScanResult {
  ranges: Map<string, SliceRange[]>;
  complete: boolean;
}

interface TrieNode {
  keys: { name: Buffer; node: TrieNode }[];
  any: TrieNode | undefined;
  /** Set when a requested path ends here: the ranges key. */
  path: string | undefined;
}

interface Frame {
  kind: "obj" | "arr";
  node: TrieNode;
  /** idx context of this container's own value (from an enclosing "[]"). */
  ctx: number | undefined;
  /** Next element index (arrays only). */
  idx: number;
  start: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJ = 0x7b;
const CLOSE_OBJ = 0x7d;
const OPEN_ARR = 0x5b;
const CLOSE_ARR = 0x5d;

const isWs = (c: number | undefined): boolean => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;

/** Bytes a number or true/false/null can hold: [0-9a-zA-Z+.-]. */
const isScalarByte = (c: number | undefined): boolean =>
  c !== undefined && ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x2b || c === 0x2d || c === 0x2e);

/** "message", "content", "[]", "type" → "message.content[].type". */
function pathKey(p: ScanPath): string {
  let key = "";
  for (const s of p) key = s === "[]" ? `${key}[]` : key ? `${key}.${s}` : s;
  return key;
}

function newNode(): TrieNode {
  return { keys: [], any: undefined, path: undefined };
}

function buildTrie(paths: readonly ScanPath[]): TrieNode {
  const root = newNode();
  for (const p of paths) {
    if (p.length === 0) continue;
    let node = root;
    for (const seg of p) {
      if (seg === "[]") {
        node = node.any ??= newNode();
        continue;
      }
      const name = Buffer.from(seg, "latin1");
      let child = node.keys.find((k) => k.name.equals(name))?.node;
      if (!child) {
        child = newNode();
        node.keys.push({ name, node: child });
      }
      node = child;
    }
    node.path = pathKey(p);
  }
  return root;
}

/** The child for the raw key bytes buf[s, e), or undefined. A key holding an escape never matches. */
function matchKey(node: TrieNode, buf: Buffer, s: number, e: number): TrieNode | undefined {
  if (buf.subarray(s, e).includes(BACKSLASH)) return undefined;
  for (const k of node.keys) {
    if (k.name.length === e - s && buf.compare(k.name, 0, k.name.length, s, e) === 0) return k.node;
  }
  return undefined;
}

/** buf[i] is '"'; returns the index after the closing quote, or -1 if unterminated. Never decodes. */
function skipString(buf: Buffer, i: number, end: number): number {
  for (let j = i + 1; j < end; j++) {
    const c = buf[j];
    if (c === BACKSLASH) j++;
    else if (c === QUOTE) return j + 1;
  }
  return -1;
}

/** Index after the value starting at buf[i], or -1 when it is truncated or empty. */
function skipValue(buf: Buffer, i: number, end: number): number {
  const c = buf[i];
  if (c === QUOTE) return skipString(buf, i, end);
  if (c === OPEN_OBJ || c === OPEN_ARR) {
    let depth = 0;
    for (let j = i; j < end; j++) {
      const b = buf[j];
      if (b === QUOTE) {
        j = skipString(buf, j, end);
        if (j < 0) return -1;
        j--;
      } else if (b === OPEN_OBJ || b === OPEN_ARR) depth++;
      else if (b === CLOSE_OBJ || b === CLOSE_ARR) {
        if (--depth === 0) return j + 1;
      }
    }
    return -1;
  }
  // number, true, false, null: a run of scalar bytes (not validated here; parseSlice does).
  let j = i;
  while (j < end && isScalarByte(buf[j])) j++;
  return j > i ? j : -1;
}

/**
 * Walks buf[start, end) once, tracking depth and keys; string bodies are skipped by bytes
 * (on "\\" skip one byte; an unescaped '"' ends the string) and never decoded. Records the
 * byte range of every value at an absolute requested path (key joined by "."; "[]" is
 * appended without a dot, e.g. "message.content[].type"). Keys are compared as raw bytes to
 * the ASCII path segments; a key with an escape never matches. Never throws: malformed or
 * truncated input ends the scan with complete=false.
 *
 * Structure is validated only along requested paths: malformed bytes inside a skipped value
 * still give complete=true, and a bad scalar on a requested path (e.g. `tru`) gets a range
 * that parseSlice later rejects. Duplicate keys yield every occurrence in source order;
 * readers must treat more than one range at a path without "[]" as malformed.
 */
export function scanJson(buf: Buffer, start: number, end: number, paths: readonly ScanPath[]): ScanResult {
  const ranges = new Map<string, SliceRange[]>();
  const result: ScanResult = { ranges, complete: false };
  end = Math.min(end, buf.length);
  const root = buildTrie(paths);
  const stack: Frame[] = [];
  let i = start;
  // true right after a container opened (a close is allowed before any member).
  let first = false;

  const record = (path: string, s: number, e: number, ctx: number | undefined): void => {
    const r: SliceRange = ctx === undefined ? { start: s, end: e } : { start: s, end: e, idx: ctx };
    const list = ranges.get(path);
    if (list) list.push(r);
    else ranges.set(path, [r]);
  };
  const ws = (): void => {
    while (i < end && isWs(buf[i])) i++;
  };
  /** Reads one value at buf[i]; false on malformed or truncated input. */
  const value = (node: TrieNode | undefined, ctx: number | undefined): boolean => {
    ws();
    if (i >= end) return false;
    const c = buf[i];
    if (node && stack.length < MAX_SCAN_DEPTH) {
      if ((c === OPEN_OBJ && node.keys.length > 0) || (c === OPEN_ARR && node.any)) {
        stack.push({ kind: c === OPEN_OBJ ? "obj" : "arr", node, ctx, idx: 0, start: i });
        i++;
        first = true;
        return true;
      }
    }
    const e = skipValue(buf, i, end);
    if (e < 0) return false;
    // A scalar running into `end` inside an open container may be cut short
    // ("123" of "12345"): never record it.
    const scalar = c !== QUOTE && c !== OPEN_OBJ && c !== OPEN_ARR;
    if (scalar && e === end && stack.length > 0) return false;
    if (node?.path !== undefined) record(node.path, i, e, ctx);
    i = e;
    first = false;
    return true;
  };

  if (!value(root, undefined)) return result;
  for (let f = stack.at(-1); f !== undefined; f = stack.at(-1)) {
    ws();
    if (i >= end) return result;
    const c = buf[i];
    if (c === (f.kind === "obj" ? CLOSE_OBJ : CLOSE_ARR)) {
      stack.pop();
      i++;
      if (f.node.path !== undefined) record(f.node.path, f.start, i, f.ctx);
      first = false;
      continue;
    }
    if (!first) {
      if (c !== COMMA) return result;
      i++;
      ws();
      if (i >= end) return result;
    }
    if (f.kind === "arr") {
      const ctx = f.ctx ?? f.idx;
      f.idx++;
      if (!value(f.node.any, ctx)) return result;
      continue;
    }
    if (buf[i] !== QUOTE) return result;
    const ke = skipString(buf, i, end);
    if (ke < 0) return result;
    const child = matchKey(f.node, buf, i + 1, ke - 1);
    i = ke;
    ws();
    if (i >= end || buf[i] !== COLON) return result;
    i++;
    if (!value(child, f.ctx)) return result;
  }
  ws();
  result.complete = i === end;
  return result;
}

/** The one JSON.parse in the new readers: refuses end - start > maxBytes (returns undefined) and returns undefined for invalid JSON. */
export function parseSlice(buf: Buffer, r: SliceRange, maxBytes: number = MAX_SLICE_BYTES): unknown {
  if (!(r.start >= 0 && r.end >= r.start && r.end <= buf.length)) return undefined;
  // Written so a NaN or undefined-coerced maxBytes fails closed.
  if (!(r.end - r.start <= maxBytes)) return undefined;
  try {
    return JSON.parse(buf.toString("utf8", r.start, r.end));
  } catch {
    return undefined;
  }
}

/** The string at a path, when it is exactly one JSON string of at most maxBytes; else undefined. */
export function stringAt(buf: Buffer, res: ScanResult, path: string, maxBytes: number = MAX_SLICE_BYTES): string | undefined {
  const list = res.ranges.get(path);
  const r = list?.length === 1 ? list[0] : undefined;
  if (r === undefined || buf[r.start] !== QUOTE) return undefined;
  const v = parseSlice(buf, r, maxBytes);
  return typeof v === "string" ? v : undefined;
}
