// The Copilot SourceReader (D54): discover.ts, extract.ts, LineTailer and the
// workspace.yaml title logic behind the reader contract. Behaviour is the
// v0.7 monitor's, except the project key is the folder name and `owner/repo`
// is a display label carried as the title (D44).
import * as fs from "node:fs";
import { dirname, join, sep } from "node:path";
import { discover, FOLDER_RE, isLive as realIsLive } from "./discover";
import { isIdLabel, MAX_WORKSPACE_BYTES, parseShutdownLine, parseStartLabel, parseUsageLine, parseWorkspaceName } from "./extract";
import { emptyReadResult, type FileReader, type FileReadResult, type SourceCandidate, type SourceDiscoverResult, type SourceReader } from "./source";
import { LineTailer } from "./tailer";
import type { UsageRecord } from "./types";

export interface CopilotSourceOptions {
  root: string;
  rootSource: "setting" | "env" | "default";
  /** decode session.start lines for the project key (D25) */
  readProjects: boolean;
  /** decode session.shutdown lines for session totals (D29) */
  readTotals: boolean;
  isLive?: typeof realIsLive;
  parse?: typeof parseUsageLine;
}

/**
 * Reads at most MAX_WORKSPACE_BYTES + 1 bytes of workspace.yaml (never following a
 * symlink where the OS allows) and returns its title; a longer file has no title.
 */
async function readBoundedTitle(path: string): Promise<string | undefined> {
  // O_NONBLOCK: a FIFO swapped in after the caller's lstat cannot block the open; it then
  // fails the isFile check below (v0.7).
  const fh = await fs.promises.open(
    path,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!(await fh.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(MAX_WORKSPACE_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return n > MAX_WORKSPACE_BYTES ? undefined : parseWorkspaceName(buf.toString("utf8", 0, n));
  } finally {
    await fh.close();
  }
}

/** One events.jsonl: today's monitor.readFile over a LineTailer, as a FileReadResult. */
class CopilotFileReader implements FileReader {
  private readonly tailer: LineTailer;
  /** project key from this log's first session.start line (D44) */
  private key?: string;
  /** `owner/repo` from that line, when it differs from the key */
  private repoLabel?: string;
  /** session title from workspace.yaml, read only when the key is an ID */
  private wsTitle?: string;
  /** mtime of the workspace.yaml last read for `wsTitle` */
  private wsMtimeMs?: number;
  /** the title last reported */
  private shown?: string;

  constructor(
    private readonly path: string,
    private readonly folderId: string,
    opts: { readProjects: boolean; readTotals: boolean },
    private readonly parse: typeof parseUsageLine,
  ) {
    this.tailer = new LineTailer(path, { decodeStart: opts.readProjects, decodeShutdown: opts.readTotals });
  }

  async read(): Promise<FileReadResult> {
    const r = await this.tailer.read();
    const out = emptyReadResult();
    out.reset = r.reset;
    if (r.error !== undefined) out.error = r.error;
    // A reset re-delivers the whole file: key and title are derived again.
    if (r.reset) {
      delete this.key;
      delete this.repoLabel;
      delete this.wsTitle;
      delete this.wsMtimeMs;
    }
    for (const line of r.startLines) {
      if (this.key !== undefined) break;
      const s = parseStartLabel(line);
      if (s === undefined) continue;
      this.key = s.key;
      if (s.label !== undefined) this.repoLabel = s.label;
      out.label = s.key;
    }
    // A folder named by an ID says nothing: show the session's title instead.
    // Checked only when the log moved, so idle polls touch no extra file.
    if (this.key !== undefined && isIdLabel(this.key) && (r.startLines.length > 0 || r.usageLines.length > 0 || r.activity > 0))
      await this.readTitle();
    // After a reset the title is always reported, so a consumer that cleared it is told again.
    const title = this.wsTitle ?? this.repoLabel;
    if (title !== this.shown || r.reset) {
      out.title = title ?? null;
      if (title === undefined) delete this.shown;
      else this.shown = title;
    }
    for (const line of r.usageLines) {
      const p = this.parse(line, this.folderId);
      if (p.kind === "usage") {
        out.usage++;
        out.records.push(p.record);
      } else if (p.kind === "malformed") out.malformed++;
      else if (p.kind === "unrecognized") out.unrecognized++;
    }
    // Each shutdown line carries the session's running totals: the last one wins.
    let totals: UsageRecord[] | undefined;
    for (const line of r.shutdownLines) {
      const p = parseShutdownLine(line, this.folderId);
      if (p.kind === "totals") {
        totals = p.records;
        out.hasTotals = true;
      } else if (p.kind === "malformed") out.malformed++;
      else if (p.kind === "unrecognized") out.unrecognized++;
    }
    if (totals !== undefined) out.totals = totals;
    out.activity = r.activity;
    out.suspect = r.suspect;
    out.overlong = r.overlong;
    out.overlongOther = r.overlongOther;
    out.shutdownOversize = r.shutdownOversize;
    return out;
  }

  /**
   * Reads the `name:` of the session's workspace.yaml when that file changed. A file
   * that is gone, unreadable, not a regular file (e.g. a symlink) or over
   * MAX_WORKSPACE_BYTES drops the title, so the folder name shows again.
   */
  private async readTitle(): Promise<void> {
    const ws = join(dirname(this.path), "workspace.yaml");
    let title: string | undefined;
    let mtimeMs: number | undefined;
    try {
      const st = await fs.promises.lstat(ws);
      if (st.isFile() && st.size <= MAX_WORKSPACE_BYTES) {
        if (st.mtimeMs === this.wsMtimeMs) return;
        title = await readBoundedTitle(ws);
        mtimeMs = st.mtimeMs;
      }
    } catch {
      // No workspace.yaml (older Copilot) or unreadable: the folder name shows.
    }
    if (mtimeMs === undefined) delete this.wsMtimeMs;
    else this.wsMtimeMs = mtimeMs;
    if (title === undefined) delete this.wsTitle;
    else this.wsTitle = title;
  }
}

export class CopilotSourceReader implements SourceReader {
  readonly source = "copilot" as const;
  readonly root: string;
  readonly rootSource: "setting" | "env" | "default";
  private readonly readProjects: boolean;
  private readonly readTotals: boolean;
  private readonly isLive: typeof realIsLive;
  private readonly parse: typeof parseUsageLine;

  constructor(o: CopilotSourceOptions) {
    this.root = o.root;
    this.rootSource = o.rootSource;
    this.readProjects = o.readProjects;
    this.readTotals = o.readTotals;
    this.isLive = o.isLive ?? realIsLive;
    this.parse = o.parse ?? parseUsageLine;
  }

  private get base(): string {
    return join(this.root, "session-state");
  }

  async rootDirMtime(): Promise<number | undefined> {
    try {
      return (await fs.promises.stat(this.base)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  async discover(windowStartMs: number, dayStartMs: number, _nowMs: number): Promise<SourceDiscoverResult> {
    const r = await discover(this.root, windowStartMs, this.isLive, dayStartMs);
    if (!r.ok) return r;
    return {
      ok: true,
      candidates: r.candidates.map((c) => ({
        source: "copilot",
        sessionId: c.folderId,
        folderId: c.folderId,
        files: [{ path: c.eventsPath, mtimeMs: c.mtimeMs, size: c.size }],
        mtimeMs: c.mtimeMs,
        live: c.live,
      })),
      unreadable: r.unreadable.map((u) => ({ folderId: u.folderId, path: u.eventsPath, code: u.code })),
      dirMtimeMs: r.dirMtimeMs,
    };
  }

  /** Exactly `<root>/session-state/<folder id>/events.jsonl`; a pure path check. */
  pathAllowed(path: string): boolean {
    const prefix = this.base + sep;
    if (!path.startsWith(prefix)) return false;
    const rest = path.slice(prefix.length);
    const cut = rest.indexOf(sep);
    if (cut === -1) return false;
    return FOLDER_RE.test(rest.slice(0, cut)) && rest.slice(cut + 1) === "events.jsonl";
  }

  open(path: string, c: SourceCandidate): FileReader {
    return new CopilotFileReader(path, c.folderId, { readProjects: this.readProjects, readTotals: this.readTotals }, this.parse);
  }
}
