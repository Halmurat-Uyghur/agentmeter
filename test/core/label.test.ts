import { describe, expect, it } from "vitest";
import { FOLDER_NAME, folderLabel } from "../../src/core/label";

describe("folderLabel (D44)", () => {
  it("strips a trailing Claude Code worktree", () => {
    expect(folderLabel("/a/b/repo/.claude/worktrees/x")).toBe("repo");
  });

  it("strips a trailing .worktrees entry on a Windows path", () => {
    expect(folderLabel("C:\\w\\repo\\.worktrees\\y")).toBe("repo");
  });

  it("takes the last segment, ignoring a trailing separator", () => {
    expect(folderLabel("/a/b/repo")).toBe("repo");
    expect(folderLabel("/a/b/repo/")).toBe("repo");
    expect(folderLabel("C:\\w\\repo")).toBe("repo");
    expect(folderLabel("repo")).toBe("repo");
  });

  it("keeps spaces and allowed punctuation", () => {
    expect(folderLabel("/a/b/na me")).toBe("na me");
    expect(folderLabel("/a/my.repo_v2-x@y+z")).toBe("my.repo_v2-x@y+z");
  });

  it("is undefined for a root, '.', '..' or an empty path", () => {
    expect(folderLabel("/")).toBeUndefined();
    expect(folderLabel("/a/..")).toBeUndefined();
    expect(folderLabel("/a/.")).toBeUndefined();
    expect(folderLabel("")).toBeUndefined();
    expect(folderLabel("C:\\")).toBeUndefined();
  });

  it("is undefined when the last segment fails FOLDER_NAME", () => {
    expect(folderLabel("/a/bad:name")).toBeUndefined();
    expect(folderLabel("/a/" + "x".repeat(81))).toBeUndefined();
    expect(folderLabel("/a/ünï")).toBeUndefined();
    expect(folderLabel("/a/line\nbreak")).toBeUndefined();
  });

  it("never returns a path", () => {
    for (const p of ["/a/b/repo/.claude/worktrees/x", "C:\\w\\repo\\.worktrees\\y", "/x/y/z", "a/b", "/repo/.claude/worktrees/"]) {
      const l = folderLabel(p);
      if (l !== undefined) {
        expect(l).not.toMatch(/[\\/]/);
        expect(FOLDER_NAME.test(l)).toBe(true);
      }
    }
  });
});
