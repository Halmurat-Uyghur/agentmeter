// Project labels from a working-directory path (D44). Only the folder name is
// kept; the path itself never leaves this function.

/** A folder name that may be shown and used as a grouping key. */
export const FOLDER_NAME = /^[A-Za-z0-9 ._@+-]{1,80}$/;

/** Object-prototype keys: rejected so a label can never shadow a prototype member where it is used as a key. */
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

const WORKTREE = /[\\/](?:\.claude[\\/]worktrees|\.worktrees)[\\/][^\\/]+[\\/]*$/;

/** Last segment of a POSIX or Windows path after a trailing /.claude/worktrees/<x> or /.worktrees/<x> is removed; undefined when it is empty, ".", "..", a prototype key or fails FOLDER_NAME. Never returns the path. */
export function folderLabel(path: string): string | undefined {
  const base = path.replace(WORKTREE, "").replace(/[\\/]+$/, "");
  const cut = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  const name = base.slice(cut + 1);
  if (name === "" || name === "." || name === ".." || RESERVED.has(name)) return undefined;
  return FOLDER_NAME.test(name) ? name : undefined;
}
