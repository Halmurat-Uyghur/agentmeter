// Insights (D32; O2 rules I1, I2 and I3). Neutral copy: what was seen and what it
// cost, never a "saving". Session totals are excluded and the footer says so.
import { formatCount, INSIGHTS_SOURCES_NOTE, mixedSources, money } from "../format";
import { GROWTH_CAUSE_TEXT } from "../insights";
import type { Insight, Snapshot, ViewOptions } from "../types";
import { escapeHtml, plural, shortId, viewedName } from "./shared";

function list(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** "100K", "272K", "1.2M" for a token count; 999,600 rounds to 1000K, so it reads "1.0M". */
function kTokens(n: number): string {
  const k = Math.round(n / 1e3);
  return k >= 1000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${k}K` : String(n);
}

function evidence(i: Insight, view: ViewOptions): string {
  const tok = formatCount({ sum: i.tokens, reported: 1, missing: 0 });
  const figure = view.unit === "cost" ? `about ${money(i.nanoAiu / 1e11)} (est.)` : `${tok} input + output tokens`;
  return `${plural(i.calls, "call")} · ${plural(i.sessions, "session")} · ${figure}`;
}

const COMPACT = "For a new task, a fresh session usually costs less. For one that must continue, /compact shrinks what each call resends.";
const LIST = "List a session's calls to see which.";

type FlatCauses = { model: number; output: number; cache: number; unclear: number };

/** Why the `flat` sessions (input logged, did not grow) cost more: only the causes their calls
 * show, with how many of them show each when there are several; unclear when none does. */
function flatCause(flat: number, c: FlatCauses): string {
  const shown = (["model", "output", "cache"] as const).filter((k) => c[k] > 0);
  if (shown.length === 0) return "the cause is unclear";
  const names = shown.map((k) => (flat === 1 ? GROWTH_CAUSE_TEXT[k] : `${GROWTH_CAUSE_TEXT[k]} (${c[k]} of ${flat})`));
  const unclear = flat > 1 && c.unclear > 0 ? `; in ${c.unclear} of ${flat} the cause is unclear` : "";
  return `the likelier ${shown.length === 1 ? "cause is" : "causes are"} ${list(names)}${unclear}`;
}

/** I2 advice, per session: put the growth down to the context only for the sessions whose
 * input grew too, to another model, longer replies or fewer cache reads only where their calls
 * show it (`causes`, over the sessions whose input was logged and did not grow), and say so
 * when input was not logged or nothing explains it. */
export function growthAction(n: number, grew: number, unmeasured: number, causes?: FlatCauses): string {
  const flat = n - grew - unmeasured;
  const why = flatCause(flat, causes ?? { model: 0, output: 0, cache: 0, unclear: flat });
  if (grew === n) return `${n === 1 ? "Its" : "Their"} input grew too, so the context grew. ${COMPACT}`;
  if (grew > 0) {
    const rest = flat === 0 ? "In the others input tokens were not logged, so the cause there is unclear." : `In the others${unmeasured > 0 ? " where input was logged" : ""} it did not grow as much, so ${why}.`;
    return `In ${grew} of ${n} sessions the input grew too, so the context grew there. ${COMPACT.replace("For a new task", "For a new task in those")} ${rest} ${LIST}`;
  }
  if (flat === 0) return `Input tokens were not logged for ${n === 1 ? "its" : "their"} calls, so the cause is unclear. ${LIST}`;
  const where = unmeasured > 0 ? `Where input was logged (${flat} of ${n} sessions), it did not grow as much` : `${n === 1 ? "Its" : "Their"} input did not grow as much`;
  return `${where}, so ${why}. ${LIST}`;
}

function card(i: Insight, view: ViewOptions): string {
  const usd = money(i.nanoAiu / 1e11);
  let title: string;
  let body: string;
  let action: string;
  if (i.id === "context-growth") {
    title = "Sessions that grew costly";
    const names = i.top.map((t) => (t.label !== undefined ? `${t.label} (${shortId(t.sessionId)})` : shortId(t.sessionId)));
    const n = i.sessions;
    body = `${plural(n, "session")} got more expensive as ${n === 1 ? "it" : "they"} went on: ${n === 1 ? "its" : "their"} later calls cost ${list(i.top.map((t) => `${t.growth.toFixed(1)}×`))} the first ones${n > i.top.length ? " (largest shown)" : ""}. The cost above each session's starting level came to about ${usd} (est.). ${i.top.length === 1 ? "Session" : "Sessions"}: ${list(names)}.`;
    action = growthAction(i.sessions, i.inputGrewSessions ?? (i.inputGrew ? i.sessions : 0), i.inputUnmeasuredSessions ?? 0, i.flatCauses);
  } else if (i.id === "long-context") {
    const k = kTokens(i.thresholdTokens);
    title = `Long prompts on ${i.model}`;
    body = `${plural(i.calls, "call")} in ${plural(i.sessions, "session")} sent more than ${k} prompt tokens (the largest: ${kTokens(i.maxPromptTokens)}). Above that size each token is priced higher. These calls cost about ${usd} (est.).`;
    action = `Running /compact, or starting a fresh session, before ${k} keeps calls in the lower price band.`;
  } else {
    title = `Low cache reuse on ${i.model}`;
    const tenths = Math.floor(i.share * 10);
    const read = i.share === 0 ? "no prompt tokens were" : tenths === 0 ? "fewer than 1 in 10 prompt tokens were" : `about ${tenths} in 10 prompt tokens were`;
    body = `Over ${plural(i.calls, "call")} in ${plural(i.sessions, "session")}, ${read} read from cache. These calls cost about ${usd} (est.).`;
    action = "The cache starts over when you switch model or reasoning effort mid-session, change the enabled tools or MCP servers, or come back to a session after a long break.";
  }
  return `<article class="ins" aria-labelledby="ins-${i.id}"><h3 id="ins-${i.id}">${escapeHtml(title)}</h3><p class="ev muted">${escapeHtml(evidence(i, view))}</p><p>${escapeHtml(body)}</p><p class="muted">${escapeHtml(action)}</p></article>`;
}

export function renderInsights(s: Snapshot, view: ViewOptions): string {
  const v = s.month?.insights;
  const month = viewedName(s);
  const items = v?.items ?? [];
  const cov = v?.coverage;
  const coverage = cov
    ? `Based on ${plural(cov.callSessions, "session")} with per-call records${cov.totalsOnlySessions > 0 ? `; ${plural(cov.totalsOnlySessions, "older session")} counted from session totals ${cov.totalsOnlySessions === 1 ? "is" : "are"} not included, because ${cov.totalsOnlySessions === 1 ? "it has" : "they have"} no per-call figures` : ""}.`
    : "";
  const foot = `<div class="fine">${coverage ? `<p>${escapeHtml(coverage)}</p>` : ""}<p>Thresholds are rules of thumb, not GitHub guidance. Figures are estimates from logged AI credits.</p>${mixedSources(s.month?.totals?.sources) ? `<p>${escapeHtml(INSIGHTS_SOURCES_NOTE)}</p>` : ""}</div>`;
  if (items.length === 0) {
    return `<section class="box"><p>${escapeHtml(`Nothing to point out in ${month}${s.filter ? " for this filter" : ""}.`)}</p><p class="muted">Insights check long prompts, session growth and cache reuse using only the numbers on this computer.</p>${foot}</section>`;
  }
  return `<section class="box">${items.map((i) => card(i, view)).join("")}${foot}</section>`;
}
