import { describe, expect, it } from "vitest";
import {
  LOCAL_BANNER,
  NOT_COVERED,
  STREAMING_NOTE,
  escapeMarkdown,
  formatAiu,
  formatCount,
  partialNote,
  statusText,
  tooltipMarkdown,
} from "../../src/core/format";
import type {
  Counts,
  Health,
  Metric,
  Snapshot,
  Totals,
} from "../../src/core/types";

const m = (sum: number, reported: number, missing: number): Metric => ({
  sum,
  reported,
  missing,
});
const none = (): Metric => m(0, 0, 0);

function counts(input: Metric, output: Metric, records = 2): Counts {
  return {
    records,
    input,
    output,
    cacheRead: none(),
    cacheWrite: none(),
    reasoning: none(),
    durationMs: none(),
    nanoAiu: none(),
  };
}

function totals(
  input: Metric,
  output: Metric,
  byModel?: Record<string, Counts>,
): Totals {
  return {
    ...counts(input, output),
    byModel: byModel ?? { "gpt-5": counts(input, output) },
  };
}

function health(o: Partial<Health> = {}): Health {
  return {
    state: "ok",
    rootSource: "default",
    partial: false,
    unrecognized: 0,
    malformed: 0,
    overlong: 0,
    overlongOther: 0,
    unreadableFiles: 0,
    sessionsWithoutUsage: 0,
    ...o,
  };
}

const IN = m(1_200_000, 2, 0);
const OUT = m(300_000, 2, 0);

function snap(o: Partial<Snapshot> = {}): Snapshot {
  return {
    generatedAtMs: 0,
    dayStartMs: 0,
    today: totals(IN, OUT),
    sessions: [],
    health: health(),
    ...o,
  };
}

describe("formatCount", () => {
  it.each<[Metric, string]>([
    [m(0, 0, 3), "—"],
    [m(0, 2, 0), "0"],
    [m(999, 1, 0), "999"],
    [m(1000, 1, 0), "1.0K"],
    [m(1234, 1, 0), "1.2K"],
    [m(999_950, 1, 0), "1.0M"],
    [m(1_250_000, 3, 1), "1.3M*"],
  ])("%o → %s", (metric, out) => {
    expect(formatCount(metric)).toBe(out);
  });
});

describe("formatAiu", () => {
  it("divides nano-AIU by 1e9 with two decimals", () => {
    expect(formatAiu(m(2e9, 1, 0))).toBe("2.00");
  });
  it("is a dash when nothing reported", () => {
    expect(formatAiu(m(0, 0, 4))).toBe("—");
  });
  it("is starred when some records did not report", () => {
    expect(formatAiu(m(2e9, 1, 1))).toBe("2.00*");
  });
});

describe("partialNote", () => {
  it("names how many records reported", () => {
    expect(partialNote(m(5, 1, 1))).toBe("reported by 1 of 2 records");
  });
  it("is undefined when complete", () => {
    expect(partialNote(m(5, 2, 0))).toBeUndefined();
  });
});

describe("escapeMarkdown", () => {
  it.each<[string, string]>([
    ["\\", "\\\\"],
    ["`", "\\`"],
    ["*", "\\*"],
    ["_", "\\_"],
    [":", "\\:"],
    ["/", "\\/"],
    ["[", "\\["],
    ["<", "\\<"],
  ])("escapes %s", (input, out) => {
    expect(escapeMarkdown(input)).toBe(out);
  });
  it("escapes every ASCII punctuation character and nothing else", () => {
    const punct = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    expect(escapeMarkdown(punct)).toBe(
      [...punct].map((c) => "\\" + c).join(""),
    );
    expect(escapeMarkdown("gpt 5 abcXYZ09")).toBe("gpt 5 abcXYZ09");
  });
});

describe("statusText", () => {
  it("loading", () => {
    expect(statusText(undefined)).toBe("$(sync~spin) Copilot usage: loading");
  });
  it("ok", () => {
    expect(statusText(snap())).toBe("$(pulse) Local today: 1.5M tok");
  });
  it("star sits on the number when a field is missing", () => {
    expect(statusText(snap({ today: totals(IN, m(0, 0, 2)) }))).toBe(
      "$(pulse) Local today: 1.2M* tok",
    );
  });
  it("partial health stars a complete number", () => {
    expect(
      statusText(snap({ health: health({ partial: true, malformed: 1 }) })),
    ).toBe("$(pulse) Local today: 1.5M* tok");
  });
  it("partial health never adds a second star", () => {
    const s = snap({
      today: totals(IN, m(0, 0, 2)),
      health: health({ partial: true, malformed: 1 }),
    });
    expect(statusText(s)).toBe("$(pulse) Local today: 1.2M* tok");
  });
  it("format-changed", () => {
    expect(
      statusText(
        snap({ health: health({ state: "format-changed", unrecognized: 3 }) }),
      ),
    ).toBe("$(warning) Local today: 1.5M tok");
  });
  it("format-changed with no today keeps the warning", () => {
    expect(
      statusText(
        snap({
          today: undefined,
          health: health({ state: "format-changed", unrecognized: 5 }),
        }),
      ),
    ).toBe("$(warning) Local today: —");
  });
  it("no today", () => {
    expect(
      statusText(
        snap({ today: undefined, health: health({ state: "no-data" }) }),
      ),
    ).toBe("$(pulse) Local today: —");
  });
  it("no-dir", () => {
    expect(
      statusText(
        snap({ today: undefined, health: health({ state: "no-dir" }) }),
      ),
    ).toBe("$(circle-slash) Copilot logs not found");
  });
  it("permission", () => {
    expect(
      statusText(
        snap({ today: undefined, health: health({ state: "permission" }) }),
      ),
    ).toBe("$(lock) Copilot logs unreadable");
  });
});

const hostile = "[x](command:y)<b>";

const STATES: [string, Snapshot | undefined][] = [
  ["loading", undefined],
  ["ok", snap()],
  [
    "ok with current session",
    snap({
      current: {
        folderId: "abc",
        live: true,
        pinned: false,
        totals: totals(IN, OUT),
      },
    }),
  ],
  [
    "ended pinned session",
    snap({
      current: {
        folderId: "abc",
        live: false,
        pinned: true,
        totals: totals(IN, m(0, 0, 2)),
      },
    }),
  ],
  ["missing output", snap({ today: totals(IN, m(5, 1, 1)) })],
  [
    "partial",
    snap({
      health: health({
        partial: true,
        unreadableFiles: 2,
        malformed: 3,
        overlong: 4,
      }),
    }),
  ],
  [
    "format-changed",
    snap({ health: health({ state: "format-changed", unrecognized: 7 }) }),
  ],
  [
    "no-data",
    snap({
      today: undefined,
      health: health({ state: "no-data", sessionsWithoutUsage: 2 }),
    }),
  ],
  ["no-dir", snap({ today: undefined, health: health({ state: "no-dir" }) })],
  [
    "permission",
    snap({ today: undefined, health: health({ state: "permission" }) }),
  ],
  [
    "hostile model",
    snap({ today: totals(IN, OUT, { [hostile]: counts(IN, OUT) }) }),
  ],
];

describe("tooltipMarkdown", () => {
  it.each(STATES)(
    "always carries LOCAL_BANNER and STREAMING_NOTE (%s)",
    (_name, s) => {
      const md = tooltipMarkdown(s);
      expect(md).toContain(LOCAL_BANNER);
      expect(md).toContain(STREAMING_NOTE);
    },
  );

  it("format-changed names the unrecognized line count", () => {
    const md = tooltipMarkdown(
      snap({ health: health({ state: "format-changed", unrecognized: 7 }) }),
    );
    expect(md).toContain(
      "7 line(s) in a format this version doesn't recognize",
    );
  });

  it("partial names each reason with its count", () => {
    const md = tooltipMarkdown(
      snap({
        health: health({
          partial: true,
          unreadableFiles: 2,
          malformed: 3,
          overlong: 4,
        }),
      }),
    );
    expect(md).toContain("2 log file(s) could not be read");
    expect(md).toContain("3 malformed line(s)");
    expect(md).toContain("4 over-long line(s) that may contain usage were skipped.");
  });

  it("over-long non-usage lines are listed under data health without marking partial", () => {
    const md = tooltipMarkdown(snap({ health: health({ overlongOther: 5 }) }));
    expect(md).toContain("Data health: 5 over-long line(s) that are not usage were skipped; totals are unaffected.");
    expect(md).not.toContain("may be incomplete");
  });

  it("over-long non-usage lines are not mentioned when there are none", () => {
    const md = tooltipMarkdown(snap({ health: health({ partial: true, malformed: 1 }) }));
    expect(md).not.toContain("are not usage were skipped");
  });

  it("partial omits reasons with a zero count", () => {
    const md = tooltipMarkdown(
      snap({ health: health({ partial: true, malformed: 3 }) }),
    );
    expect(md).toContain("3 malformed line(s)");
    expect(md).not.toContain("could not be read");
    expect(md).not.toContain("over-long");
  });

  it("no-dir points at the copilotHome setting", () => {
    const md = tooltipMarkdown(
      snap({ today: undefined, health: health({ state: "no-dir" }) }),
    );
    expect(md).toContain("copilotUsageMonitor.copilotHome");
  });

  it("shows today's input, output and per-model lines", () => {
    const md = tooltipMarkdown(snap());
    expect(md).toContain("Input: 1\\.2M tok");
    expect(md).toContain("Output: 300\\.0K tok");
    expect(md).toContain("gpt\\-5");
  });

  it("explains a starred field", () => {
    const md = tooltipMarkdown(snap({ today: totals(IN, m(5, 1, 1)) }));
    expect(md).toContain("reported by 1 of 2 records");
  });

  it("shows the current session", () => {
    const md = tooltipMarkdown(
      snap({
        current: {
          folderId: "abc",
          live: false,
          pinned: false,
          totals: totals(IN, OUT),
        },
      }),
    );
    expect(md).toMatch(/Current session \(ended\)/);
    expect(md).toContain("1\\.5M tok");
  });

  it("escapes URL-shaped model ids so they cannot autolink", () => {
    const keys = ["http://x/y", "https://a.b/c", "ftp://a/b"];
    const byModel = Object.fromEntries(keys.map((k) => [k, counts(IN, OUT)]));
    const md = tooltipMarkdown(snap({ today: totals(IN, OUT, byModel) }));
    const modelKeys = md
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.endsWith(" tok"))
      .map((l) => l.slice(2, l.lastIndexOf(": ")));
    expect(modelKeys).toHaveLength(3);
    for (const k of modelKeys) {
      expect(k).not.toMatch(/(^|[^\\])[:/]/);
      expect(k).not.toContain("//");
    }
    expect(md).toContain("http\\:\\/\\/x\\/y");
  });

  it("escapes a hostile model id", () => {
    const md = tooltipMarkdown(
      snap({ today: totals(IN, OUT, { [hostile]: counts(IN, OUT) }) }),
    );
    expect(md).toContain("\\[x\\]\\(command\\:y\\)\\<b\\>");
    // every [ ] ( ) < > in the output is escaped
    expect(md).not.toMatch(/(^|[^\\])[[\]<>]/);
    expect(md).not.toContain("<b>");
    expect(md).not.toContain("](");
  });
});

describe("copy check", () => {
  const banned =
    /\b(bill|billing|remaining|quota|limit|allowance|credits?|cost|spend|premium)\b|\$\d|%/i;

  it.each(STATES)("no banned wording outside LOCAL_BANNER (%s)", (_name, s) => {
    expect(statusText(s).split(LOCAL_BANNER).join("")).not.toMatch(banned);
    expect(tooltipMarkdown(s).split(LOCAL_BANNER).join("")).not.toMatch(banned);
  });

  it("constants and notes pass too", () => {
    for (const text of [
      STREAMING_NOTE,
      ...NOT_COVERED,
      partialNote(m(1, 1, 1)) ?? "",
    ]) {
      expect(text).not.toMatch(banned);
    }
  });

  it("NOT_COVERED lists coverage, older clients and the local day", () => {
    expect(NOT_COVERED.length).toBeGreaterThanOrEqual(3);
    const all = NOT_COVERED.join(" ");
    expect(all).toMatch(/1\.0\.99/);
    expect(all).toMatch(/UTC/);
    expect(all).toMatch(/JetBrains/);
  });

  it("LOCAL_BANNER is the plan sentence verbatim", () => {
    expect(LOCAL_BANNER).toBe(
      "Locally observed from Copilot session logs on this computer. Not your GitHub bill, not your remaining allowance, and not usage from other devices or Copilot features that don't write these logs.",
    );
  });
});
