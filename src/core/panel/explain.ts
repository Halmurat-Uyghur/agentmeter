// v0.6 Phase 1 cards: the session ledger (1.1), prompts and agent calls (1.2), cache
// cost by model (1.3) and the tool-definition share of input (1.5). Every figure is a
// number or a fixed enum from the snapshot; every string is escaped; money goes through
// the display-currency formatters and is labelled "est."; "—" means not reported.
import { costLabel, formatAiu, formatCount, formatUsd, multiSource } from "../format";
import { modelFamily } from "../store";
import type { CacheStats, CallRow, FinishReason, Initiator, Metric, PromptStats, SessionDetail, Snapshot, ToolOverhead, ViewOptions } from "../types";
import { sessionCallsHref } from "./links";
import { card, clock, DASH, escapeHtml, foldedTable, inHundred, plural, shortDate, shortId, sym, titleAttr, val, viewedName, withStar } from "./shared";

/** Ledger rows shown before the rest fold under "Show N more". */
export const LEDGER_SHOWN = 25;

const INITIATOR_LABEL: Record<Initiator, string> = { user: "You", agent: "Agent", other: "Other" };
const FINISH_LABEL: Record<FinishReason, string> = { stop: "Answer", tool_calls: "Tool calls", length: "Length cap", content_filter: "Content filter", other: "Other" };

/** A single value as a Metric ("—" when undefined). */
function one(v: number | undefined): Metric {
  return v === undefined ? { sum: 0, reported: 0, missing: 1 } : { sum: v, reported: 1, missing: 0 };
}

/** The mean of a Metric per reported item, keeping its "*" when some items were missing. */
function mean(m: Metric): Metric {
  return m.reported === 0 ? m : { sum: m.sum / m.reported, reported: m.reported, missing: m.missing };
}

function rounded(m: Metric): Metric {
  return { ...m, sum: Math.round(m.sum) };
}

/** "61 in 100" shown with its screen-reader form ("less than 1 in 100"). */
function share(part: number | undefined, whole: number | undefined, partial = false): string {
  const t = inHundred(part, whole);
  if (t === DASH) return val(DASH);
  return t.startsWith("<") ? sym(t) + (partial ? `<span class="star" aria-hidden="true">*</span><span class="sr"> (may be incomplete)</span>` : "") : val(withStar(t, partial));
}

function tile(label: string, inner: string, note?: string): string {
  return `<div class="tile"${titleAttr(note)}><span class="k">${escapeHtml(label)}</span><span class="v">${inner}</span></div>`;
}

function td(inner: string, cls = "num", note?: string): string {
  return `<td class="${cls}"${titleAttr(note)}>${inner}</td>`;
}

/** Cache read share of prompt tokens, as "N in 100" ("—" when not reported). Prompt tokens
 * and cache reads sum the same calls (those that reported both), as on the dashboard. */
function cacheShare(c: CacheStats): string {
  if (c.prompt.reported === 0 || c.cacheRead.reported === 0) return val(DASH);
  return share(c.cacheRead.sum, c.prompt.sum, c.prompt.missing > 0 || c.cacheRead.missing > 0);
}

/** "from N of M records that reported both" when some calls lacked either figure, else undefined. */
function cacheCover(c: CacheStats): string | undefined {
  if (c.prompt.reported === 0 || c.prompt.missing === 0) return undefined;
  return `from ${c.prompt.reported} of ${c.prompt.reported + c.prompt.missing} records that reported both`;
}

/** Tool-definition tokens as a share of the same calls' input. */
function toolShare(t: ToolOverhead): string {
  if (t.calls === 0) return val(DASH);
  return share(t.toolTokens, t.input, t.missing > 0);
}

// ---- 1.2 prompts -----------------------------------------------------------

function promptTiles(p: PromptStats, view: ViewOptions): string {
  const perPrompt = view.unit === "cost" ? formatUsd(mean(p.nanoAiu)) : formatCount(rounded(mean(p.tokens)));
  const perLabel = view.unit === "cost" ? `Per prompt, ${costLabel()}` : "Per prompt, tokens";
  const ratio = p.prompts > 0 ? (p.agentCalls / p.prompts).toFixed(1) : DASH;
  const note = p.nanoAiu.missing > 0 || p.tokens.missing > 0 ? "Some prompts include a call that did not log this figure; they are left out of the average." : undefined;
  return `<div class="tiles">${tile("Prompts", val(p.prompts > 0 || p.unknown === 0 ? String(p.prompts) : DASH))}${tile("Agent calls they triggered", val(p.prompts > 0 || p.unknown === 0 ? String(p.agentCalls) : DASH))}${tile("Agent calls per prompt", val(ratio))}${tile(perLabel, val(perPrompt), note)}</div>`;
}

function promptNotes(p: PromptStats, scope: string, multi = false): string[] {
  const out = [`A prompt is a call you started. The agent calls after it in the same session, up to your next prompt, belong to it; per prompt = the prompt's own call plus those agent calls, ${scope}.`];
  if (p.notLinked > 0) out.push(`${plural(p.notLinked, "call")} ${p.notLinked === 1 ? "is" : "are"} not linked to a prompt (made before the first prompt in view, or started by something other than you or the agent).`);
  // Claude Code and Codex log no initiator either (D43): name them once they are read.
  if (p.unknown > 0 && multi) out.push(`${plural(p.unknown, "call")} that logged no initiator (older Copilot, Claude Code and Codex) ${p.unknown === 1 ? "is" : "are"} not counted here.`);
  else if (p.unknown > 0) out.push(`${plural(p.unknown, "call")} did not log who started ${p.unknown === 1 ? "it" : "them"} (older Copilot), so ${p.unknown === 1 ? "it is" : "they are"} not counted here.`);
  return out;
}

/** The month's prompts card in the Sessions section, or "" when there are no call records. */
export function promptsCard(s: Snapshot, view: ViewOptions): string {
  const p = s.month?.prompts;
  if (!p) return "";
  const name = viewedName(s);
  const lead =
    p.prompts > 0
      ? `${plural(p.prompts, "prompt")} triggered ${plural(p.agentCalls, "agent call")} in ${name}.`
      : p.unknown > 0
        ? multiSource(s.health)
          ? `The calls in ${name} logged no initiator, so prompts cannot be counted.`
          : `Copilot did not log who started the calls in ${name}, so prompts cannot be counted.`
        : `No prompts logged in ${name}.`;
  const notes = promptNotes(p, `in ${name}`, multiSource(s.health));
  if (s.filter?.tool) notes.push("The tool filter does not apply here: it would split prompts from their agent calls.");
  return card("prompts-title", "sessions", "Prompts and agent calls", name, `<p>${escapeHtml(lead)}</p>${promptTiles(p, view)}<div class="fine">${notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</div>`);
}

// ---- 1.1 session ledger ----------------------------------------------------

function rowHtml(r: CallRow): string {
  const d = new Date(r.timestampMs);
  const when = `${shortDate(r.timestampMs)} ${clock(d.getTime())}`;
  const model = r.model ? `<span class="chipm f-${modelFamily(r.model)}" title="${escapeHtml(r.model)}">${escapeHtml(r.model)}</span>` : val(DASH);
  const count = (v: number | undefined) => td(val(formatCount(one(v))), v === undefined ? "num muted" : "num");
  const by = r.initiator ? escapeHtml(INITIATOR_LABEL[r.initiator]) : val(DASH);
  const end = r.finishReason ? escapeHtml(FINISH_LABEL[r.finishReason]) : val(DASH);
  const tools = r.toolTokens !== undefined && r.prompt !== undefined ? share(Math.min(r.toolTokens, r.prompt), r.prompt) : val(DASH);
  return `<tr><td class="num">${escapeHtml(when)}</td><td>${model}</td><td>${by}</td>${count(r.uncached)}${count(r.cacheRead)}${count(r.cacheWrite)}${count(r.output)}${count(r.reasoning)}${td(tools)}${td(val(formatAiu(one(r.nanoAiu))))}${td(val(formatUsd(one(r.nanoAiu))))}<td>${end}</td></tr>`;
}

function detailTiles(d: SessionDetail, view: ViewOptions): string {
  const c = d.cache;
  const total = view.unit === "cost" ? tile(costLabel(), val(formatUsd(d.nanoAiu))) : tile("Tokens", val(formatCount(d.tokens)));
  return `<div class="tiles">${tile("Calls", val(String(d.calls)))}${tile("Prompts", val(d.prompts.prompts > 0 || d.prompts.unknown === 0 ? String(d.prompts.prompts) : DASH))}${tile("Agent calls", val(d.prompts.prompts > 0 || d.prompts.unknown === 0 ? String(d.prompts.agentCalls) : DASH))}${total}${tile("Cache read, of input", cacheShare(c), cacheCover(c))}${tile(`Uncached input, ${costLabel()}`, val(formatUsd(c.uncachedNano)))}${tile(`Same at cache-read price, ${costLabel()}`, val(formatUsd(c.atReadRateNano)))}${tile("Tool definitions, of input", toolShare(d.tools))}</div>`;
}

/** The selected session's ledger, shown at the top of the Sessions section, or "". */
export function sessionDetailCard(s: Snapshot, view: ViewOptions): string {
  const d = s.month?.detail;
  if (!d) return "";
  const name = viewedName(s);
  const who = d.label !== undefined ? `${d.label} (${shortId(d.sessionId)})` : shortId(d.sessionId);
  const close = `<p><a class="btn" href="${escapeHtml(sessionCallsHref(""))}" aria-label="${escapeHtml(`Close the call list of session ${who}`)}">Close the call list</a></p>`;
  const title = `Calls in session ${who}`;
  if (d.calls === 0) {
    const why = d.sessionTotal
      ? "This session is counted from a session total: Copilot logged no per-call records for it."
      : `No calls of this session in ${name}${s.filter?.project ? " for this filter" : ""}.`;
    return card("calls-title", "session", title, name, `<p class="muted">${escapeHtml(why)}</p>${close}`);
  }
  const head = `<th>Time</th><th>Model</th><th>Started by</th><th>Uncached input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Reasoning</th><th>Tool definitions</th><th>AIU</th><th>${escapeHtml(costLabel())}</th><th>Ended with</th>`;
  const table = foldedTable(head, d.rows.map((r) => ({ html: rowHtml(r) })), LEDGER_SHOWN, `Calls in session ${who}, ${name}`);
  const notes = [
    `Uncached input + cache read + cache write = the call's input tokens. Reasoning is part of Output, not added to it. Tool definitions = the tool descriptions sent with the prompt, out of every 100 input tokens: part of input, not an extra cost.`,
    `Started by: You = a prompt you sent; Agent = a call the agent made on its own. Ended with: Answer = the model replied and stopped; Tool calls = it asked to run tools. AIU is as logged; ${costLabel()} is estimated from it, as everywhere in this panel.`,
    `Uncached input and its cache-read price come from the per-token-type AI credits Copilot logs with each call; "—" where a call did not log them. The cache-read price is not a saving you could have had: a session's first call, and any call after a change of model or tools or a long break, has to send its input uncached.`,
    ...promptNotes(d.prompts, "in this session", multiSource(s.health)),
  ];
  if (d.omitted > 0) notes.unshift(`Showing the newest ${plural(d.rows.length, "call")}; ${plural(d.omitted, "earlier call")} ${d.omitted === 1 ? "is" : "are"} counted in the figures above but not listed.`);
  notes.push(`Only calls in ${name}${s.filter?.tool ? "; the tool filter does not apply to this list" : ""}.`);
  return card("calls-title", "session", title, `${name} · ${plural(d.calls, "call")}`, `${close}${detailTiles(d, view)}${table}<div class="fine">${notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</div>`);
}

// ---- 1.3 cache cost by model -------------------------------------------------

/** Cache figures per model in the Models section, or "" when there are no call records. */
export function modelCacheCard(s: Snapshot): string {
  const list = s.month?.modelCache ?? [];
  const all = s.month?.cacheCost;
  if (list.length === 0 || !all) return "";
  const name = viewedName(s);
  const money = (m: Metric) => {
    const t = formatUsd(m);
    return td(val(t), t === DASH ? "num muted" : "num");
  };
  const rows = list.map((c) => ({
    html: `<tr><td><span class="chipm f-${modelFamily(c.model)}" title="${escapeHtml(c.model)}">${escapeHtml(c.model)}</span></td>${td(cacheShare(c), "num", cacheCover(c))}${money(c.uncachedNano)}${money(c.atReadRateNano)}${money(c.cacheReadNano)}${money(c.cacheWriteNano)}</tr>`,
  }));
  const cur = costLabel();
  const head = `<th>Model</th><th>Cache read, of input</th><th>Uncached input, ${escapeHtml(cur)}</th><th>Same at cache-read price, ${escapeHtml(cur)}</th><th>Cache reads, ${escapeHtml(cur)}</th><th>Cache writes, ${escapeHtml(cur)}</th>`;
  const u = all.uncachedNano;
  const paired = all.atReadRateNano.reported;
  const lead =
    u.reported === 0
      ? `Copilot did not log per-token-type AI credits for these calls, so the cache cost is not shown (—).`
      : paired === 0
        ? `In ${name}, uncached input cost ${formatUsd(u)} (est.). Copilot logged no cache-read price for these calls, so the cost at the cache-read price is not shown (—).`
        : paired === u.reported
          ? `In ${name}, uncached input cost ${formatUsd(u)} (est.); the same tokens at the cache-read price would have cost ${formatUsd(all.atReadRateNano)} (est.).`
          : `In ${name}, uncached input cost ${formatUsd(u)} (est.). For the ${plural(paired, "call")} with a logged cache-read price, ${paired === 1 ? "its" : "their"} uncached input cost ${formatUsd({ ...all.pairedUncachedNano, missing: 0 })} (est.); at the cache-read price it would have cost ${formatUsd({ ...all.atReadRateNano, missing: 0 })} (est.).`;
  const notes = [
    "Cache read, of input = cache-read tokens out of every 100 input tokens (input counts uncached, cache-read and cache-write tokens).",
    `The cost columns come from the per-token-type AI credits Copilot logs with each call; "—" where none were logged, never 0. "Same at cache-read price" prices only the uncached input tokens at that call's cache-read rate. It is not a saving you could have had: a session's first call, and any call after a change of model or tools or a long break, has to send its input uncached.`,
  ];
  return card("cache-title", "models", "Cache by model", `${name} · ${plural(list.length, "model")}${s.filter ? " · filtered" : ""}`, `<p>${escapeHtml(lead)}</p>${foldedTable(head, rows, undefined, `Cache by model, ${name}`)}<div class="fine">${notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</div>`);
}

// ---- 1.5 tool-definition share -----------------------------------------------

/** The tool-definition share of input in the Tools section, or "" when there are no call records. */
export function toolOverheadCard(s: Snapshot): string {
  const t = s.month?.toolOverhead;
  if (!t) return "";
  const name = viewedName(s);
  if (t.calls === 0) {
    return card("tooldefs-title", "tools", "Tool definitions in the prompt", name, `<p class="muted">${escapeHtml(`Copilot did not log tool-definition tokens for the calls in ${name}.`)}</p>`);
  }
  const avgTokens = Math.round(t.toolTokens / t.calls);
  const avail = t.availableTools.reported > 0 ? `, ${(t.availableTools.sum / t.availableTools.reported).toFixed(1)} tools offered on average` : "";
  const lead = `Tool definitions made up ${inHundred(t.toolTokens, t.input)} input tokens over ${plural(t.calls, "call")} in ${name} (about ${formatCount(one(avgTokens))} tokens per call${avail}).`;
  const rows = t.groups.map((g) => {
    const label = g.kind === "added" ? `${escapeHtml(g.name)} <span class="tag add">added</span>` : g.kind === "builtIn" ? `Built-in tools <span class="tag">built-in</span>` : `<span class="muted">No tool used</span>`;
    return { html: `<tr><td>${label}</td>${td(String(g.calls))}${td(val(formatCount(one(g.toolTokens))))}${td(share(g.toolTokens, g.input))}</tr>` };
  });
  const notes = [
    "These tokens are part of input and already in every total; they are not an extra cost.",
    "Copilot logs one tool-definition figure per call, covering every tool offered, so it cannot be split by server. Each row is the calls that used a tool of that group; a call that used tools of two groups counts in both.",
  ];
  if (t.missing > 0) notes.push(`${plural(t.missing, "call")} did not log tool-definition tokens and ${t.missing === 1 ? "is" : "are"} left out.`);
  return card("tooldefs-title", "tools", "Tool definitions in the prompt", `${name}${s.filter ? " · filtered" : ""}`, `<p>${escapeHtml(lead)}</p>${foldedTable("<th>Calls that used</th><th>Calls</th><th>Tool-definition tokens</th><th>Share of their input</th>", rows, undefined, `Tool definitions by tool group, ${name}`)}<div class="fine">${notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</div>`);
}
