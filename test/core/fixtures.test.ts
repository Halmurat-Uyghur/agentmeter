import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANARY, jsonl, otherEvent, sessionTree, usageEvent } from "../fixtures/build";

describe("fixtures", () => {
  it("serialises a usage event with type first", () => {
    expect(JSON.stringify(usageEvent())).toMatch(/^\{"type":"session\.usage_record"/);
  });

  it("fills other events with the canary", () => {
    const line = JSON.stringify(otherEvent("user.message"));
    expect(line).toMatch(/^\{"type":"user\.message"/);
    expect(line).toContain(CANARY);
  });

  it("omits keys set to undefined", () => {
    const line = JSON.stringify(usageEvent({ inputTokens: undefined }));
    expect(line).not.toContain("inputTokens");
    expect(line).toContain("outputTokens");
  });

  it("joins events as newline-terminated JSON lines", () => {
    const text = jsonl([usageEvent(), otherEvent("assistant.message")]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    for (const l of lines.slice(0, 2)) expect(() => JSON.parse(l)).not.toThrow();
  });

  describe("sessionTree", () => {
    let root: string | undefined;
    afterEach(async () => {
      if (root) await rm(root, { recursive: true, force: true });
      root = undefined;
    });

    it("writes events, lock file and mtime", async () => {
      root = await mkdtemp(join(tmpdir(), "cum-fixture-"));
      const mtime = new Date("2026-01-02T03:04:05.000Z");
      const lines = jsonl([usageEvent()]);
      await sessionTree(root, [
        { id: "s1", lines, lockPid: 4242, mtime },
        { id: "s2", lines: "" },
      ]);
      const s1 = join(root, "session-state", "s1");
      expect(await readFile(join(s1, "events.jsonl"), "utf8")).toBe(lines);
      expect(await readFile(join(s1, "inuse.4242.lock"), "utf8")).toBe("");
      expect((await stat(join(s1, "events.jsonl"))).mtime.getTime()).toBe(mtime.getTime());
      expect(await readdir(join(root, "session-state", "s2"))).toEqual(["events.jsonl"]);
    });
  });
});
