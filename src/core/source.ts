// The contract between the monitor and one source's reader (D54). A reader
// discovers its session files and opens a FileReader per file; the monitor
// owns scheduling, the store and health.

import type { ReadErrorCode } from "./tailer";
import type { Source, UsageRecord } from "./types";

/** A file modified within this long is live. */
export const RECENT_MS = 300_000;

export interface SourceFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface SourceCandidate {
  source: Source;
  sessionId: string;
  folderId: string;
  files: SourceFile[];
  mtimeMs: number;
  live: boolean;
}

export interface SourceUnreadable {
  folderId: string;
  path: string;
  code: string;
}

export type SourceDiscoverResult =
  | { ok: true; candidates: SourceCandidate[]; unreadable: SourceUnreadable[]; dirMtimeMs: number; capped?: number; archived?: number }
  | { ok: false; error: "no-dir" | "permission" | "OTHER" };

export interface FileReadResult {
  reset: boolean;
  error?: ReadErrorCode;
  /** call records (same-file repeats are merged by the store) */
  records: UsageRecord[];
  /** the file's session totals, last line wins; undefined = none in this read */
  totals?: UsageRecord[];
  /** project key (D44), once known */
  label?: string;
  /** Copilot only: workspace.yaml title; null clears */
  title?: string | null;
  activity: number;
  suspect: number;
  unrecognized: number;
  malformed: number;
  overlong: number;
  overlongOther: number;
  shutdownOversize: number;
  hasTotals: boolean;
  usage: number;
}

export interface FileReader {
  read(): Promise<FileReadResult>;
}

export interface SourceReader {
  readonly source: Source;
  readonly root: string;
  readonly rootSource: "setting" | "env" | "default";
  rootDirMtime(): Promise<number | undefined>;
  discover(windowStartMs: number, dayStartMs: number, nowMs: number): Promise<SourceDiscoverResult>;
  pathAllowed(path: string): boolean;
  open(path: string, c: SourceCandidate): FileReader;
}

export function emptyReadResult(): FileReadResult {
  return {
    reset: false,
    records: [],
    activity: 0,
    suspect: 0,
    unrecognized: 0,
    malformed: 0,
    overlong: 0,
    overlongOther: 0,
    shutdownOversize: 0,
    hasTotals: false,
    usage: 0,
  };
}
