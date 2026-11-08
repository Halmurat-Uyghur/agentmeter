// Finds today's Copilot session logs under <root>/session-state/<folder-id>/
// events.jsonl and marks the ones a running process still holds. Uses directory
// listings and lstat only: no file is ever opened. A session is live when one
// of its inuse.<pid>.lock names belongs to a running process, because stale
// locks from dead processes stay behind for months.
import * as fs from "node:fs";
import { join } from "node:path";

export interface Candidate {
  folderId: string;
  eventsPath: string;
  mtimeMs: number;
  /** events.jsonl size at discovery (lstat) */
  size: number;
  live: boolean;
}

/** A session folder whose events.jsonl could not be lstat'ed (EACCES, EMFILE, EIO...). */
export interface Unreadable {
  folderId: string;
  eventsPath: string;
  code: string;
}

export type DiscoverResult =
  | {
      ok: true;
      candidates: Candidate[];
      /** kept by the caller rather than forgotten: the error may be transient (v0.7) */
      unreadable: Unreadable[];
      dirMtimeMs: number;
    }
  | { ok: false; error: "no-dir" | "permission" | "OTHER" };

/** A session folder name under session-state. */
export const FOLDER_RE = /^[0-9a-f-]{8,64}$/i;
const LOCK_RE = /^inuse\.(\d+)\.lock$/;

function codeOf(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** True if `pid` names a running process: kill(pid, 0) succeeds or throws EPERM. */
export function isLive(
  pid: number,
  kill: (pid: number, sig: 0) => void = process.kill,
): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return codeOf(err) === "EPERM";
  }
}

type FolderOutcome =
  | { kind: "candidate"; candidate: Candidate }
  | { kind: "no-events" }
  | { kind: "unreadable"; unreadable: Unreadable }
  | { kind: "skip" };

async function inspectFolder(
  base: string,
  folderId: string,
  dayStartMs: number,
  isLiveFn: typeof isLive,
  liveSinceMs: number,
): Promise<FolderOutcome> {
  const folder = join(base, folderId);
  const eventsPath = join(folder, "events.jsonl");
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(eventsPath);
  } catch (err) {
    const code = codeOf(err);
    return code === "ENOENT" || code === "ENOTDIR"
      ? { kind: "no-events" }
      : { kind: "unreadable", unreadable: { folderId, eventsPath, code: code ?? "OTHER" } };
  }
  if (!st.isFile()) return { kind: "no-events" };
  const mtimeMs = st.mtimeMs;
  const size = st.size;
  if (mtimeMs < dayStartMs) return { kind: "skip" };

  let names: string[];
  if (mtimeMs < liveSinceMs) {
    // In the window but not written today: never live, so no listing needed.
    return { kind: "candidate", candidate: { folderId, eventsPath, mtimeMs, size, live: false } };
  }
  try {
    names = await fs.promises.readdir(folder);
  } catch {
    // Traversable but not listable: the log is still today's, liveness unknown.
    names = [];
  }
  let live = false;
  for (const name of names) {
    const m = LOCK_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isSafeInteger(pid) && pid >= 1 && isLiveFn(pid)) {
      live = true;
      break;
    }
  }
  return {
    kind: "candidate",
    candidate: { folderId, eventsPath, mtimeMs, size, live },
  };
}

/** Lists sessions whose events.jsonl was modified at or after `dayStartMs`
 * (the window start: today, or the 1st of the month per D10). A session can be
 * live only if its log was also written at or after `liveSinceMs` (today). */
export async function discover(
  root: string,
  dayStartMs: number,
  isLiveFn: typeof isLive = isLive,
  liveSinceMs: number = dayStartMs,
): Promise<DiscoverResult> {
  const base = join(root, "session-state");
  let entries: fs.Dirent[];
  let dirMtimeMs: number;
  try {
    // stat (follows a symlinked session-state) before listing, so a folder
    // created in between bumps the mtime past this value and is found next time.
    dirMtimeMs = (await fs.promises.stat(base)).mtimeMs;
    entries = await fs.promises.readdir(base, { withFileTypes: true });
  } catch (err) {
    const code = codeOf(err);
    if (code === "ENOENT" || code === "ENOTDIR")
      return { ok: false, error: "no-dir" };
    if (code === "EACCES" || code === "EPERM")
      return { ok: false, error: "permission" };
    return { ok: false, error: "OTHER" };
  }

  // Symlinked session folders are not directories here: skipped and not counted.
  const folderIds = entries
    .filter((e) => e.isDirectory() && FOLDER_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  const outcomes = await Promise.all(
    folderIds.map((id) => inspectFolder(base, id, dayStartMs, isLiveFn, liveSinceMs)),
  );

  const candidates: Candidate[] = [];
  const unreadable: Unreadable[] = [];
  for (const o of outcomes) {
    if (o.kind === "candidate") candidates.push(o.candidate);
    else if (o.kind === "unreadable") unreadable.push(o.unreadable);
  }
  return { ok: true, candidates, unreadable, dirMtimeMs };
}
