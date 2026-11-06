// Insights (D32; O2 rules I2 and I3). Neutral copy: what was seen and what it
// cost, never a "saving". Session totals are excluded and the footer says so.
import { money } from "../format";
import type { Insight, Snapshot, ViewOptions } from "../types";
import { escapeHtml, plural, shortId, viewedName } from "./shared";

function list(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

function evidence(i: Insight, view: ViewOptions): string {
  const tok = i.tokens >= 1e6 ? `${(i.tokens / 1e6).toFixed(1)}M` : i.tokens >= 1e3 ? `${(i.tokens / 1e3).toFixed(1)}K` : String(i.tokens);
  const figure = view.unit === "cost" ? `about ${money(i.nanoAiu / 1e11)} (est.)` : `${tok} input + output tokens`;
  return `${plural(i.calls, "call")} · ${plural(i.sessions, "session")} · ${figure}`;
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
    action = "For a new task, a fresh session usually costs less. For one that must continue, /compact shrinks what each call resends.";
  } else {
    title = `Low cache reuse on ${i.model}`;
    body = `Over ${plural(i.calls, "call")} in ${plural(i.sessions, "session")}, about ${Math.floor(i.share * 10)} in 10 prompt tokens were read from cache. These calls cost about ${usd} (est.).`;
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
  const foot = `<div class="fine">${coverage ? `<p>${escapeHtml(coverage)}</p>` : ""}<p>Thresholds are rules of thumb, not GitHub guidance. Figures are estimates from logged AI credits.</p></div>`;
  if (items.length === 0) {
    return `<section class="box"><p>${escapeHtml(`Nothing to point out in ${month}${s.filter ? " for this filter" : ""}.`)}</p><p class="muted">Insights check session growth and cache reuse using only the numbers on this computer.</p>${foot}</section>`;
  }
  return `<section class="box">${items.map((i) => card(i, view)).join("")}${foot}</section>`;
}
