import { describe, expect, it } from "vitest";
import {
  LOCAL_BANNER,
  NOT_COVERED,
  currentRangeState,
  rangeIconId,
  spoken,
  statusAccessibilityLabel,
  SESSION_TOTAL_NOTE,
  SESSION_TOTAL_SHORT,
  STREAMING_NOTE,
  escapeMarkdown,
  formatAiu,
  formatCount,
  partialNote,
  statusText,
  tooltipMarkdown,
  weekChange,
  weekCoverage,
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
    calls: records,
    sessionTotals: 0,
    input,
    output,
    cacheRead: none(),
    cacheWrite: none(),
    reasoning: none(),
    durationMs: none(),
    nanoAiu: none(),
    callsMissing: 0,
    callNanoAiu: none(),
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
    sessionsFromTotals: 0,
    shutdownOversize: 0,
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
  [
    "session totals",
    snap({
      today: { ...totals(IN, OUT), sessionTotals: 2, calls: 14 },
      health: health({ partial: true, shutdownOversize: 2, sessionsFromTotals: 3, sessionsWithoutUsage: 1 }),
    }),
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

  it("session totals: today names them, health counts them, oversize lines are a partial reason", () => {
    const md = tooltipMarkdown(
      snap({
        today: { ...totals(IN, OUT), sessionTotals: 2 },
        health: health({ partial: true, shutdownOversize: 1, sessionsFromTotals: 3, sessionsWithoutUsage: 1 }),
      }),
    );
    expect(md).toContain("(incl. 2 session totals)");
    expect(md).toContain("- 1 session-end line(s) too long to read were skipped.");
    expect(md).toContain(`3 session(s) counted from session totals. ${SESSION_TOTAL_SHORT}`);
    expect(md).toContain("1 session(s) without usage data are not in the totals.");
  });

  it("no session-total wording without session totals", () => {
    const md = tooltipMarkdown(snap());
    expect(md).not.toMatch(/session total/i);
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
      SESSION_TOTAL_NOTE,
      SESSION_TOTAL_SHORT,
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

  it("weekChange: ▲/▼ with a multiplier, never a percent sign", () => {
    expect(weekChange(undefined, undefined)).toBeUndefined();
    expect(weekChange(0, 0)).toBeUndefined();
    expect(weekChange(140, 100)).toBe("▲ 1.4× the 7 days before");
    expect(weekChange(60, 100)).toBe("▼ 0.6× the 7 days before");
    expect(weekChange(1230, 100)).toBe("▲ 12× the 7 days before");
    expect(weekChange(102, 100)).toBe("about the same as the 7 days before");
    expect(weekChange(5, undefined)).toBe("nothing logged in the 7 days before");
    expect(weekChange(undefined, 5)).toBe("nothing logged yet");
    for (const t of [weekChange(140, 100), weekChange(60, 100), weekChange(5, 0), weekChange(0, 5), weekChange(5, 5, false)]) expect(t).not.toMatch(banned);
  });

  it("weekChange: no arrow when either week has nothing logged (review 5)", () => {
    for (const [c, p] of [[5, undefined], [5, 0], [undefined, 5], [0, 5]] as const) {
      const t = weekChange(c, p)!;
      expect(t).toBeDefined();
      expect(t).not.toMatch(/[▲▼]/);
      expect(t).not.toMatch(/none yet/);
    }
  });

  it("weekChange: no comparison when the 7 days before were not fully read (review 4)", () => {
    expect(weekChange(140, 100, false)).toBe("no comparison");
    expect(weekChange(140, undefined, false)).toBe("no comparison");
    expect(weekChange(undefined, 100, false)).toBeUndefined();
    expect(weekChange(140, 100, false)).not.toMatch(/[▲▼]/);
  });

  it("weekCoverage: flags a last-7 or prior-7 window that starts before the history window (review 4)", () => {
    const day = (d: number) => new Date(2026, 10, d).getTime();
    const s = (today: number, windowStart: number | undefined) => ({ dayStartMs: day(today), ...(windowStart !== undefined && { history: [{ monthStartMs: windowStart }] }) });
    // historyMonths = 1 on Nov 3: both weeks reach into October
    expect(weekCoverage(s(3, day(1)))).toStrictEqual({ last7Short: true, prior7Short: true });
    // Nov 10: the last 7 days (Nov 4–10) are read, the 7 before (Oct 28–Nov 3) are not
    expect(weekCoverage(s(10, day(1)))).toStrictEqual({ last7Short: false, prior7Short: true });
    // Nov 14: the 7 before start on Nov 1, exactly the window start
    expect(weekCoverage(s(14, day(1)))).toStrictEqual({ last7Short: false, prior7Short: false });
    expect(weekCoverage(s(3, new Date(2026, 9, 1).getTime()))).toStrictEqual({ last7Short: false, prior7Short: false });
    expect(weekCoverage(s(3, undefined))).toStrictEqual({ last7Short: false, prior7Short: false });
  });

  it("session total hover text is the spec's wording verbatim (calls are shown, from the request count)", () => {
    expect(SESSION_TOTAL_NOTE).toBe(
      "Session total: Copilot before 1.0.99 writes one total when a session ends instead of a record per model call. The whole session is counted on the day it ended. Per-call figures, growth and tool use are not available for it.",
    );
    expect(SESSION_TOTAL_SHORT).toBe("Session total: counted once, on the day the session ended (older Copilot).");
  });

  it("LOCAL_BANNER is the plan sentence verbatim", () => {
    expect(LOCAL_BANNER).toBe(
      "Locally observed from Copilot session logs on this computer. Not your GitHub bill, not your remaining allowance, and not usage from other devices or Copilot features that don't write these logs.",
    );
  });
});

describe("v0.4: the status bar reads the unfiltered current month (D31, D33)", () => {
  const MS = new Date(2026, 10, 1).getTime();
  const DAY = new Date(2026, 10, 5).getTime();
  const priced = (nano: number): Totals => ({ ...counts(IN, OUT), nanoAiu: m(nano, 2, 0), byModel: {} });

  it("regression: a project/tool filter no longer changes the USD figure, target state or tooltip", () => {
    // history.at(-1) is filtered by the monitor; thisMonth is not.
    const s = snap({
      dayStartMs: DAY,
      history: [{ monthStartMs: MS, totals: priced(1e9) }],
      month: { monthStartMs: MS, isCurrent: true, days: [], sessions: [], projects: [], tools: [], totals: priced(1e9) },
      filter: { project: "acme/web" },
      thisMonth: priced(5e11),
    });
    const view = { unit: "cost" as const, range: { max: 1 } };
    expect(statusText(s, view)).toBe("$(flame) Local Nov: $5.00 / up to $1.00");
    expect(currentRangeState(s, view)).toBe("over");
    expect(tooltipMarkdown(s, view)).toContain("\\$5\\.00");
    // thisMonth undefined (no record this month) wins over a stale history value
    const empty = snap({ dayStartMs: DAY, history: [{ monthStartMs: MS, totals: priced(1e9) }], thisMonth: undefined });
    expect(statusText(empty, { unit: "cost" })).toBe("$(pulse) Local Nov: —");
  });

  it("rangeIconId matches the status bar icon", () => {
    expect(rangeIconId("none")).toBe("pulse");
    expect(rangeIconId("under")).toBe("arrow-down");
    expect(rangeIconId("in")).toBe("pass");
    expect(rangeIconId("over")).toBe("flame");
  });

  it("spoken: words for marks, magnitudes and money; no icon syntax", () => {
    expect(spoken("1.5M* tok · 12 calls")).toBe("1.5 million (may be incomplete) tokens, 12 calls");
    expect(spoken("— · no calls yet")).toBe("not reported, no calls yet");
    expect(spoken("$12.40 est. · in target range $20.00–$60.00")).toBe("12.40 US dollars estimated, in target range 20.00 US dollars to 60.00 US dollars");
    expect(spoken("$(pulse) Local today: 820K tok")).toBe("Local today: 820 thousand tokens");
    expect(spoken("▲ 1.4× the 7 days before")).toBe("up 1.4 times the 7 days before");
    expect(spoken("▼ <1 in 10")).toBe("down less than 1 in 10");
    expect(spoken("2.1× ▲")).toBe("2.1 times up");
  });

  it("statusAccessibilityLabel: the status figure in words, in every state", () => {
    expect(statusAccessibilityLabel(undefined)).toBe("Copilot usage: loading");
    expect(statusAccessibilityLabel(snap({ health: health({ state: "no-dir" }) }))).toMatch(/not found/);
    expect(statusAccessibilityLabel(snap({ health: health({ partial: true }) }))).toBe(
      "Copilot usage, local today: 1.5 million (may be incomplete) tokens. Opens details.",
    );
    const s = snap({ dayStartMs: DAY, thisMonth: priced(5e11), health: health({ state: "format-changed", unrecognized: 1 }) });
    expect(statusAccessibilityLabel(s, { unit: "cost", range: { max: 1 } })).toBe(
      "Copilot usage, local this month, estimated: 5.00 US dollars, over target up to 1.00 US dollars, the log format may have changed. Opens details.",
    );
    for (const st of STATES) expect(statusAccessibilityLabel(st[1])).not.toMatch(/\$\(|%/);
  });
});

describe("v0.6: status bar content setting (2.5)", () => {
  const MS = new Date(2026, 10, 1).getTime();
  const DAY = new Date(2026, 10, 5).getTime();
  const priced = (nano: number): Totals => ({ ...counts(IN, OUT), nanoAiu: m(nano, 2, 0), byModel: {} });
  const s = snap({
    dayStartMs: DAY,
    thisMonth: { ...priced(5e11), input: m(4_000_000, 2, 0), output: m(1_000_000, 2, 0) },
    current: { folderId: "abc", live: true, pinned: false, totals: { ...priced(2e10), input: m(30_000, 2, 0), output: m(2_000, 2, 0) } },
  });

  it("today (the default) keeps the earlier text in both units", () => {
    expect(statusText(s)).toBe("$(pulse) Local today: 1.5M tok");
    expect(statusText(s, { unit: "tokens", statusBar: "today" })).toBe("$(pulse) Local today: 1.5M tok");
    expect(statusText(s, { unit: "cost", statusBar: "today", range: { max: 1 } })).toBe("$(flame) Local Nov: $5.00 / up to $1.00");
  });

  it("month shows the current month in either unit; the target suffix only in cost", () => {
    expect(statusText(s, { unit: "tokens", statusBar: "month" })).toBe("$(pulse) Local Nov: 5.0M tok");
    expect(statusText(s, { unit: "cost", statusBar: "month", range: { max: 1 } })).toBe("$(flame) Local Nov: $5.00 / up to $1.00");
    expect(statusText(snap({ dayStartMs: DAY, thisMonth: undefined }), { unit: "tokens", statusBar: "month" })).toBe("$(pulse) Local Nov: —");
  });

  it("session shows the current session; the icon still follows the month's target", () => {
    expect(statusText(s, { unit: "tokens", statusBar: "session" })).toBe("$(pulse) Local session: 32.0K tok");
    expect(statusText(s, { unit: "cost", statusBar: "session", range: { max: 1 } })).toBe("$(flame) Local session: $0.200");
    expect(statusText(snap({ current: undefined }), { unit: "tokens", statusBar: "session" })).toBe("$(pulse) Local session: —");
  });

  it("spoken labels name the period", () => {
    expect(statusAccessibilityLabel(s, { unit: "tokens", statusBar: "month" })).toBe("Copilot usage, local this month: 5.0 million tokens. Opens details.");
    expect(statusAccessibilityLabel(s, { unit: "tokens", statusBar: "session" })).toBe("Copilot usage, local current session: 32.0 thousand tokens. Opens details.");
    expect(statusAccessibilityLabel(s, { unit: "cost", statusBar: "session" })).toBe("Copilot usage, local current session, estimated: 0.200 US dollars. Opens details.");
  });

  it("the tooltip keeps every figure; month in tokens adds the month line", () => {
    const base = tooltipMarkdown(s, { unit: "tokens" });
    const month = tooltipMarkdown(s, { unit: "tokens", statusBar: "month" });
    const session = tooltipMarkdown(s, { unit: "tokens", statusBar: "session" });
    expect(session).toBe(base);
    expect(month).toContain("**This month**: 5\\.0M tok");
    for (const part of base.split("\n\n")) expect(month).toContain(part);
    const banned = /\b(bill|billing|remaining|quota|limit|allowance|credits?|cost|spend|premium)\b|\$\d|%/i;
    expect(month.split(LOCAL_BANNER).join("")).not.toMatch(banned);
  });
});

describe("v0.6 (2.1): changeAmount, the change against last month as an amount", () => {
  it("▲/▼ with the amount in the unit, never a percent or multiplier", async () => {
    const { changeAmount } = await import("../../src/core/format");
    expect(changeAmount(m(3_000_000, 1, 0), m(1_000_000, 1, 0), "tokens")).toEqual({ text: "▲ 2.0M", dir: "up", said: "up 2.0 million tokens" });
    expect(changeAmount(m(400, 1, 0), m(1_000, 1, 0), "tokens")).toEqual({ text: "▼ 600", dir: "down", said: "down 600 tokens" });
    expect(changeAmount(m(5e11, 1, 0), m(3.8e11, 1, 0), "cost")).toEqual({ text: "▲ $1.20", dir: "up", said: "up $1.20, estimated" });
    expect(changeAmount(m(1e9, 1, 0), m(5e9, 1, 0), "cost")).toEqual({ text: "▼ $0.040", dir: "down", said: "down $0.040, estimated" });
    for (const t of [changeAmount(m(5e11, 1, 0), m(1, 1, 0), "cost").text]) expect(t).not.toMatch(/%|×/);
  });
  it("the same at display precision reads 'same', without an arrow", async () => {
    const { changeAmount } = await import("../../src/core/format");
    expect(changeAmount(m(1000, 1, 0), m(1000, 1, 0), "tokens")).toEqual({ text: "same", dir: "same", said: "about the same" });
    expect(changeAmount(m(1e9, 1, 0), m(1e9 + 10, 1, 0), "cost")).toEqual({ text: "same", dir: "same", said: "about the same" });
  });
  it("no arrow when either side has nothing logged; '—' when a side did not report the unit", async () => {
    const { changeAmount } = await import("../../src/core/format");
    expect(changeAmount(m(10, 1, 0), undefined, "tokens")).toEqual({ text: "new", dir: "new", said: "nothing logged then" });
    expect(changeAmount(undefined, m(10, 1, 0), "tokens")).toEqual({ text: "—", dir: "none", said: "nothing logged" });
    expect(changeAmount(m(10, 1, 0), m(0, 0, 2), "cost")).toEqual({ text: "—", dir: "none", said: "not reported" });
    expect(changeAmount(m(0, 0, 1), m(10, 1, 0), "cost")).toEqual({ text: "—", dir: "none", said: "not reported" });
  });
  it("review fix 2: a logged 0 is a real 0, not 'nothing logged'", async () => {
    const { changeAmount } = await import("../../src/core/format");
    expect(changeAmount(m(0, 1, 0), m(5e11, 1, 0), "cost")).toEqual({ text: "▼ $5.00", dir: "down", said: "down $5.00, estimated" });
    expect(changeAmount(m(5e11, 1, 0), m(0, 1, 0), "cost")).toEqual({ text: "▲ $5.00", dir: "up", said: "up $5.00, estimated" });
    expect(changeAmount(m(10, 1, 0), m(0, 1, 0), "tokens").text).toBe("▲ 10");
    expect(changeAmount(m(0, 1, 0), m(0, 1, 0), "tokens")).toEqual({ text: "same", dir: "same", said: "about the same" });
  });
  it("a star when either side may be incomplete, or the data is partial", async () => {
    const { changeAmount } = await import("../../src/core/format");
    expect(changeAmount(m(3000, 1, 1), m(1000, 1, 0), "tokens")).toEqual({ text: "▲ 2.0K*", dir: "up", said: "up 2.0 thousand tokens (may be incomplete)" });
    expect(changeAmount(m(3000, 1, 0), m(1000, 1, 0), "tokens", true).text).toBe("▲ 2.0K*");
  });
  it("cost amounts follow the display currency", async () => {
    const { changeAmount, setDisplayCurrency } = await import("../../src/core/format");
    setDisplayCurrency({ code: "CAD", rate: 1.4, date: "2026-11-06" });
    try {
      expect(changeAmount(m(5e11, 1, 0), m(4e11, 1, 0), "cost").text).toBe("▲ CA$1.40");
    } finally {
      setDisplayCurrency(undefined);
    }
  });
});
