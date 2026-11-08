// Project labels from a working-directory path (D44). Only the folder name is
// kept; the path itself never leaves this function.

/** A folder name that may be shown and used as a grouping key. */
export const FOLDER_NAME = /^[A-Za-z0-9 ._@+-]{1,80}$/;

const WORKTREE = /[\\/](?:\.claude[\\/]worktrees|\.worktrees)[\\/][^\\/]+[\\/]*$/;

/** Last segment of a POSIX or Windows path after a trailing /.claude/worktrees/<x> or /.worktrees/<x> is removed; undefined when it is empty, ".", ".." or fails FOLDER_NAME. Never returns the path. */
export function folderLabel(path: string): string | undefined {
  const base = path.replace(WORKTREE, "").replace(/[\\/]+$/, "");
  const cut = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  const name = base.slice(cut + 1);
  if (name === "" || name === "." || name === "..") return undefined;
  return FOLDER_NAME.test(name) ? name : undefined;
}
