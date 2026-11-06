import { describe, expect, it } from "vitest";
import { Logger } from "../../src/core/log";
import { CANARY } from "../fixtures/build";

function make() {
  const lines: string[] = [];
  return { lines, log: new Logger((l) => lines.push(l)) };
}

describe("Logger", () => {
  it("writes fixed-format count, error and timing lines", () => {
    const { lines, log } = make();
    log.count("usage", 3);
    log.error("refresh", "EACCES");
    log.timing("refresh", 12.4);
    expect(lines).toEqual([
      "count usage=3",
      "error refresh EACCES",
      "timing refresh 12ms",
    ]);
  });

  it("writes EXCEPTION for any code outside [A-Z0-9_]{1,40}", () => {
    const { lines, log } = make();
    log.error("refresh", CANARY);
    log.error("refresh", "eacces");
    log.error("refresh", "");
    log.error("refresh", "A".repeat(41));
    log.error("refresh", "EACCES " + ["", "home", "user", "secret"].join("/"));
    log.error("refresh", "E_1");
    expect(lines).toEqual([
      "error refresh EXCEPTION",
      "error refresh EXCEPTION",
      "error refresh EXCEPTION",
      "error refresh EXCEPTION",
      "error refresh EXCEPTION",
      "error refresh E_1",
    ]);
  });

  it("never writes free text passed as an identifier", () => {
    const { lines, log } = make();
    log.count(`usage ${CANARY}`, 1);
    log.error(`/tmp/${CANARY}`, "EIO");
    log.timing("a\nb", 1);
    expect(lines.join("\n")).not.toContain(CANARY);
    expect(lines).toEqual([
      "count invalid=1",
      "error invalid EIO",
      "timing invalid 1ms",
    ]);
  });

  it("writes only integers for counts and timings", () => {
    const { lines, log } = make();
    log.count("usage", Number.NaN);
    log.count("usage", 2.6);
    log.timing("refresh", Number.POSITIVE_INFINITY);
    log.timing("refresh", -5);
    expect(lines).toEqual([
      "count usage=0",
      "count usage=3",
      "timing refresh 0ms",
      "timing refresh 0ms",
    ]);
  });
});
