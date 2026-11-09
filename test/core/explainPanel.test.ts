// v0.6 Phase 1 rendering: the session ledger, prompts, cache by model, tool definitions,
// the I1 card and the tooltip's last prompt. Checks escaping, the command allowlist,
// "—" for unreported values, the display currency, the copy gate and headings.
import { afterEach, describe, expect, it } from "vitest";
import { cacheStats, modelCacheStats, promptStats, sessionDetail, toolOverhead } from "../../src/core/explain";
import { isSessionId } from "../../src/core/extract";
import { lastPromptLine, LOCAL_BANNER, setDisplayCurrency, tooltipMarkdown } from "../../src/core/format";
import { LEDGER_SHOWN } from "../../src/core/panel/explain";
import { sym } from "../../src/core/panel/shared";
import { PANEL_COMMANDS, renderPanelHtml, type SectionId } from "../../src/core/panelHtml";
import type { Health, Insight, Metric, Snapshot, Totals, UsageRecord, ViewOptions } from "../../src/core/types";

const COPY_RE = /\b(bill|billing|remaining|quota|limit|allowance|premium)\b|%/i;
const USD = 1e11;
const S1 = "3f2a91c0-0000-4000-8000-000000000001";
const S2 = "3f2a91c0-0000-4000-8000-000000000002";
const NOW = new Date(2026, 10, 5, 10, 0, 0);
const m = (sum: number, reported: number, missing = 0): Metric => ({ sum, reported, missing });

let n = 0;
function call(o: Partial<UsageRecord> = {}): UsageRecord {
  n++;
  return {
    key: `k${n}`,
    keySource: "usageId",
    kind: "call",
    source: "copilot",
    sessionId: S1,
    folderId: S1,
    timestampMs: NOW.getTime() - 3_600_000 + n * 1000,
    sequence: n,
    model: "model-a",
    tokens: { input: 10_000, cacheRead: 6_000, cacheWrite: 1_000, output: 400, reasoning: 100 },
    nanoAiu: 0.02 * USD,
    initiator: n % 3 === 1 ? "user" : "agent",
    finishReason: n % 3 === 0 ? "stop" : "tool_calls",
    toolTokens: 2_500,
    availableTools: 14,
    tools: { bash: 1, "github-mcp-server/search": 1 },
    typeCost: { input: 0.012 * USD, cacheRead: 0.002 * USD, cacheWrite: 0.004 * USD, output: 0.002 * USD, inputAtReadRate: 0.0012 * USD },
    ...o,
  };
}

function health(): Health {
  return { state: "ok", rootSource: "default", partial: false, unrecognized: 0, malformed: 0, overlong: 0, overlongOther: 0, unreadableFiles: 0, sessionsWithoutUsage: 0, sessionsFromTotals: 0, shutdownOversize: 0 };
}

function totals(): Totals {
  const c = { records: 4, calls: 4, callsMissing: 0, sessionTotals: 0, input: m(40_000, 4), output: m(1_600, 4), cacheRead: m(24_000, 4), cacheWrite: m(4_000, 4), reasoning: m(400, 4), durationMs: m(4_000, 4), nanoAiu: m(0.08 * USD, 4), callNanoAiu: m(0.08 * USD, 4) };
  return { ...c, byModel: { "model-a": { ...c } } };
}

const LONG: Insight = { id: "long-context", nanoAiu: 2.4 * USD, tokens: 900_000, calls: 7, sessions: 3, model: "claude-haiku-5.5", thresholdTokens: 100_000, maxPromptTokens: 141_000 };

function snap(o: { detail?: boolean; recs?: UsageRecord[]; label?: string } = {}): Snapshot {
  const recs = o.recs ?? [call(), call(), call(), call({ typeCost: undefined, toolTokens: undefined })];
  const conv = new Map();
  const t = totals();
  const detail = o.detail === false ? undefined : { ...sessionDetail(S1, recs, conv), ...(o.label !== undefined && { label: o.label }) };
  return {
    generatedAtMs: NOW.getTime(),
    dayStartMs: new Date(2026, 10, 5).getTime(),
    today: t,
    current: { folderId: S1, live: true, pinned: false, totals: t, lastPrompt: { atMs: NOW.getTime(), agentCalls: 3, nanoAiu: 0.042 * USD, tokens: 12_300 } },
    sessions: [{ folderId: S1, live: true, lastMs: NOW.getTime() }],
    health: health(),
    month: {
      monthStartMs: new Date(2026, 10, 1).getTime(),
      isCurrent: true,
      days: [],
      sessions: [
        { sessionId: S1, folderId: S1, firstMs: NOW.getTime() - 3_600_000, lastMs: NOW.getTime(), calls: 4, tokens: m(41_600, 4), nanoAiu: m(0.08 * USD, 4), ...(o.label !== undefined && { label: o.label }) },
        { sessionId: S2, folderId: S2, firstMs: NOW.getTime() - 7_200_000, lastMs: NOW.getTime(), calls: 3, tokens: m(1_000, 1), nanoAiu: m(0, 0, 1), sessionTotal: true },
      ],
      sessionCount: 2,
      projects: [],
      tools: [],
      totals: t,
      insights: { items: [LONG], coverage: { callSessions: 1, totalsOnlySessions: 0 } },
      prompts: promptStats(recs),
      cacheCost: cacheStats(recs, conv),
      modelCache: modelCacheStats(recs, conv),
      toolOverhead: toolOverhead(recs, conv),
      ...(detail && { detail }),
    },
  };
}

const COST: ViewOptions = { unit: "cost" };
const render = (s: Snapshot, section: SectionId, view: ViewOptions = COST) => renderPanelHtml(s, "x", view, section);

/** Visible text plus title tooltips, without styles, tags or screen-reader-only text. */
function text(html: string): string {
  const titles = [...html.matchAll(/ (?:title|aria-label)="([^"]*)"/g)].map((x) => x[1]).join(" ");
  return (html + " " + titles)
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<span class="sr">[^<]*<\/span>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]!.replace(/&amp;/g, "&"));

afterEach(() => setDisplayCurrency(undefined));

describe("session ledger (1.1)", () => {
  it("each call-record session row links to showSession with its id; a session total does not", () => {
    const html = render(snap({ detail: false }), "sessions");
    const links = hrefs(html).filter((h) => h.startsWith("command:copilotUsageMonitor.showSession"));
    expect(links).toEqual([`command:copilotUsageMonitor.showSession?${encodeURIComponent(JSON.stringify([S1]))}`]);
    expect(html).not.toContain("Calls in session");
  });

  it("the selected session's ledger renders first, with the row marked and a close link", () => {
    const html = render(snap(), "sessions");
    const main = html.slice(html.indexOf("<main"));
    expect(main.indexOf("Calls in session")).toBeLessThan(main.indexOf("Current session"));
    expect(html).toContain('<tr class="on">');
    expect(hrefs(html)).toContain(`command:copilotUsageMonitor.showSession?${encodeURIComponent(JSON.stringify([""]))}`);
    const t = text(html);
    for (const h of ["Time", "Model", "Started by", "Uncached input", "Cache read", "Cache write", "Output", "Reasoning", "Tool definitions", "AIU", "USD (est.)", "Ended with"]) expect(t).toContain(h);
    expect(t).toContain("3.0K"); // uncached input = 10K − 6K − 1K
    expect(t).toContain("You");
    expect(t).toContain("Agent");
    expect(t).toContain("Tool calls");
    expect(t).toContain("Answer");
    expect(t).toContain("25 in 100"); // 2,500 tool-definition tokens of 10,000 input
    expect(t).toContain("$0.020");
  });

  it("a call without tokenDetails or tool tokens shows — (with screen-reader text), never 0", () => {
    const html = render(snap({ recs: [call({ typeCost: undefined, toolTokens: undefined, nanoAiu: undefined })] }), "sessions");
    const main = html.slice(html.indexOf("<main"));
    const ledger = main.slice(main.indexOf("Calls in session"), main.indexOf("Current session"));
    expect(ledger.length).toBeGreaterThan(100);
    expect(ledger).toContain('<span aria-hidden="true">—</span><span class="sr">not reported</span>');
    expect(text(ledger)).not.toMatch(/\$0\.00\b/);
  });

  it("a Claude Code or Codex call shows — for AIU, never its estimated cost as logged AIU (review #8)", () => {
    const saved = n; // later tests depend on the call counter
    const ledgerRow = (r: UsageRecord) => {
      const html = render(snap({ recs: [r] }), "sessions");
      const ledger = html.slice(html.indexOf("Calls in session"));
      return text(ledger.slice(ledger.indexOf("<tbody"), ledger.indexOf("</tbody>")));
    };
    const claude = ledgerRow(call({ source: "claude-code", nanoAiu: 1.23 * USD, typeCost: undefined }));
    expect(claude).toContain("$1.23");
    expect(claude).not.toContain("123");
    expect(ledgerRow(call({ nanoAiu: 1.23 * USD }))).toContain("123");
    n = saved;
  });

  it(`folds rows after ${LEDGER_SHOWN} and says when older calls are not listed`, () => {
    const recs = Array.from({ length: 30 }, () => call());
    const s = snap({ recs });
    s.month!.detail = sessionDetail(S1, recs, new Map(), 28);
    const html = render(s, "sessions");
    expect(html).toContain("Show 3 more");
    expect(text(html)).toContain("Showing the newest 28 calls; 2 earlier calls are counted");
  });

  it("escapes a hostile label; links carry only allowlisted commands and session-shaped ids", () => {
    const html = render(snap({ label: '<script>alert("x")</script>' }), "sessions");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    for (const h of hrefs(html)) {
      if (h === "#main") continue;
      const cmd = /^command:([\w.]+)\?(.*)$/.exec(h);
      expect(cmd, h).not.toBeNull();
      expect(PANEL_COMMANDS as readonly string[]).toContain(cmd![1]);
      if (cmd![1] === "copilotUsageMonitor.showSession") {
        const [id] = JSON.parse(decodeURIComponent(cmd![2]!)) as string[];
        expect(id === "" || isSessionId(id)).toBe(true);
      }
    }
  });

  it("a session counted from a session total says it has no per-call records", () => {
    const s = snap();
    s.month!.detail = sessionDetail(S2, [{ ...call({ sessionId: S2, folderId: S2 }), kind: "sessionTotal" }], new Map());
    expect(text(render(s, "sessions"))).toContain("Copilot logged no per-call records for it");
  });

  it("isSessionId accepts the folder-id shape only", () => {
    expect(isSessionId(S1)).toBe(true);
    for (const bad of ["", "short", "../../etc/passwd", "__proto__", "constructor", "x".repeat(10), "a".repeat(65), 5, null, undefined, [S1]]) expect(isSessionId(bad)).toBe(false);
  });
});

describe("prompts (1.2)", () => {
  it("states N prompts triggered M agent calls and the average per prompt in the display currency", () => {
    setDisplayCurrency({ code: "CAD", rate: 1.4, date: "2026-11-05" });
    const t = text(render(snap(), "sessions"));
    expect(t).toContain("2 prompts triggered 2 agent calls in November.");
    expect(t).toContain("Per prompt, CAD (est.)");
    expect(t).toMatch(/CA\$0\.0\d\d/);
    expect(t).not.toContain("USD (est.)");
  });

  it("tokens view averages tokens per prompt", () => {
    const t = text(render(snap(), "sessions", { unit: "tokens" }));
    expect(t).toContain("Per prompt, tokens");
  });

  it("calls without an initiator are named, not counted as 0 prompts", () => {
    const recs = [call({ initiator: undefined }), call({ initiator: undefined })];
    const t = text(render(snap({ recs }), "sessions"));
    expect(t).toContain("2 calls did not log who started them");
    // review fix 3: the lead gives the reason, not "No prompts logged"
    expect(t).toContain("Copilot did not log who started the calls in November, so prompts cannot be counted.");
    expect(t).not.toContain("No prompts logged");
  });

  it("the tooltip gives the last prompt's cost (cost view) or tokens", () => {
    const s = snap();
    expect(tooltipMarkdown(s, COST)).toContain("Last prompt: \\$0\\.042 est\\., 1 call + 3 agent calls");
    expect(tooltipMarkdown(s, { unit: "tokens" })).toContain("Last prompt: 12\\.3K tok, 1 call + 3 agent calls");
    expect(lastPromptLine({ atMs: 0, agentCalls: 1 }, COST)).toBe("Last prompt: —, 1 call + 1 agent call");
    expect(lastPromptLine(undefined)).toBeUndefined();
  });
});

describe("cache by model (1.3) and tool definitions (1.5)", () => {
  it("Models shows the cache card with uncached cost vs the cache-read price, est.", () => {
    const t = text(render(snap(), "models"));
    expect(t).toContain("Cache by model");
    expect(t).toContain("60 in 100"); // 6K of 10K input read from cache
    expect(t).toContain("Same at cache-read price, USD (est.)");
    expect(t).toMatch(/uncached input cost \$0\.036\* \(est\.\); the same tokens at the cache-read price would have cost \$0\.004\* \(est\.\)/);
    expect(t).toContain("not a saving you could have had");
  });

  it("review fix 1: calls with a per-type split but no cache-read entry show their uncached cost and name the missing cache-read price", () => {
    const noRead = { input: 0.012 * USD, cacheRead: 0, cacheWrite: 0.004 * USD, output: 0.004 * USD };
    let t = text(render(snap({ recs: [call({ typeCost: noRead }), call({ typeCost: noRead })] }), "models"));
    expect(t).toContain("uncached input cost $0.024 (est.). Copilot logged no cache-read price for these calls, so the cost at the cache-read price is not shown (—).");
    expect(t).not.toContain("did not log per-token-type AI credits");
    // mixed: the comparison covers only the calls with a cache-read price, and says so
    t = text(render(snap({ recs: [call(), call({ typeCost: noRead })] }), "models"));
    expect(t).toContain("uncached input cost $0.024 (est.). For the 1 call with a logged cache-read price, its uncached input cost $0.012 (est.); at the cache-read price it would have cost $0.001 (est.).");
  });

  it("without tokenDetails the cost columns are —, never 0", () => {
    const html = render(snap({ recs: [call({ typeCost: undefined })] }), "models");
    const box = html.slice(html.indexOf("Cache by model"));
    expect(text(box)).toContain("Copilot did not log per-token-type AI credits");
    expect(text(box)).not.toMatch(/\$0\.00\b/);
    expect(box).toContain('<span class="sr">not reported</span>');
  });

  it("Tools shows the tool-definition share of input per group, as a share, never as cost", () => {
    const t = text(render(snap(), "tools"));
    expect(t).toContain("Tool definitions made up 25 in 100 input tokens over 3 calls in November");
    expect(t).toContain("github-mcp-server");
    expect(t).toContain("Built-in tools");
    expect(t).toContain("not an extra cost");
    const box = t.slice(t.indexOf("Tool definitions in the prompt"));
    expect(box).not.toMatch(/\$\d/);
  });
});

describe("I1 card (1.4)", () => {
  it("renders the long-context card with the threshold, the largest prompt and est. cost", () => {
    const t = text(render(snap(), "insights"));
    expect(t).toContain("Long prompts on claude-haiku-5.5");
    expect(t).toContain("7 calls in 3 sessions sent more than 100K prompt tokens (the largest: 141K)");
    expect(t).toContain("These calls cost about $2.40 (est.)");
    expect(t).toContain("before 100K keeps calls in the lower price band");
  });
});

describe("I1 card: token sizes and tiny figures (review)", () => {
  it("a largest prompt of 999,600 tokens reads 1.0M, not 1000K", () => {
    const s = snap();
    s.month!.insights = { items: [{ ...LONG, maxPromptTokens: 999_600 }], coverage: { callSessions: 1, totalsOnlySessions: 0 } };
    const t = text(render(s, "insights"));
    expect(t).toContain("(the largest: 1.0M)");
    expect(t).not.toContain("1000K");
  });
  it("sym(): a '<' before a currency symbol gets its spoken span, the '<' escaped", () => {
    expect(sym("<$0.001")).toBe('<span aria-hidden="true">&lt;$0.001</span><span class="sr">less than 0.001 US dollars</span>');
    for (const t of ["<CA$0.001", "<€0.001", "<CHF 0.001", "<2"]) {
      expect(sym(t)).toMatch(/^<span aria-hidden="true">&lt;.*<\/span><span class="sr">[^<]*<\/span>$/);
    }
    expect(sym("CA$0.50")).toBe("CA$0.50");
  });
});

describe("gates on the new copy", () => {
  it("no banned words or percent signs; headings h1 → h2 → h3 without gaps; cards labelled", () => {
    for (const section of ["sessions", "models", "tools", "insights"] as SectionId[]) {
      for (const view of [COST, { unit: "tokens" } as ViewOptions]) {
        const html = render(snap(), section, view);
        expect(text(html).split(LOCAL_BANNER).join(""), section).not.toMatch(COPY_RE);
        const levels = [...html.matchAll(/<h([1-6])\b/g)].map((x) => Number(x[1]));
        for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!, section).toBeLessThanOrEqual(1);
        for (const id of [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((x) => x[1])) expect(html, id).toContain(`id="${id}"`);
        const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
        expect(new Set(ids).size, section).toBe(ids.length);
      }
    }
  });
});
