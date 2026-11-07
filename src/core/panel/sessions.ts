// Sessions (D32): the current session's tiles, then the viewed month's
// costliest sessions (the snapshot keeps up to 50; 10 show, the rest fold).
import { costLabel, formatCount, formatUsd, SESSION_TOTAL_NOTE, usd } from "../format";
import { GROWTH_FLAG } from "../insights";
import { modelFamily } from "../store";
import type { SessionSummary, Snapshot, ViewOptions } from "../types";
import { promptsCard, sessionDetailCard } from "./explain";
import { sessionCallsHref } from "./links";
import { CALLS_MISSING_NOTE, callsCell, card, DASH, escapeHtml, titleAttr, foldedTable, inHundred, pad2, plural, shortDate, shortId, sym, tilesBox, val, viewedName, withStar } from "./shared";

function started(ms: number): string {
  const d = new Date(ms);
  return `${shortDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Cache reads as a share of prompt tokens (per-model convention, as in Insights; N4); "—" when not reported. */
function cacheCell(x: SessionSummary): string {
  const input = x.input;
  const cr = x.cacheRead;
  if (!input || !cr || input.reported === 0 || cr.reported === 0 || input.sum <= 0) return `<td class="num muted">${val(DASH)}</td>`;
  const text = inHundred(cr.sum, input.sum);
  const partial = input.missing > 0 || cr.missing > 0;
  const shown = withStar(text, partial);
  return `<td class="num" title="${escapeHtml(`${text} input tokens were cache reads`)}">${shown.startsWith("<") ? sym(shown) : val(shown)}</td>`;
}

function sessionsTable(s: Snapshot, view: ViewOptions): string {
  const list: SessionSummary[] = s.month?.sessions ?? [];
  const name = viewedName(s);
  const partial = s.health.partial;
  const selected = s.month?.detail?.sessionId;
  if (list.length === 0) {
    return card("sessions-title", "sessions", "Costliest sessions", name, `<p class="muted">${escapeHtml(`No sessions with usage in ${name}${s.filter ? " for this filter" : ""}.`)}</p>`);
  }
  const monthUsd = s.month?.totals ? usd(s.month.totals.nanoAiu) : undefined;
  const rows = list.map((x) => {
    const cost = usd(x.nanoAiu);
    const share = cost !== undefined && monthUsd ? Math.round((100 * cost) / monthUsd) : 0;
    const flagged = x.growth !== undefined && x.growth >= GROWTH_FLAG;
    const growth = x.growth === undefined ? DASH : `${x.growth.toFixed(1)}×`;
    const growthTitle = x.sessionTotal
      ? "Not available for a session total: it has no per-call records"
      : x.growth === undefined
        ? "Needs at least 10 calls with logged AI credits"
        : `Last 5 calls cost ${x.growth.toFixed(1)}× the first 5${flagged ? ": the context grew; a fresh session may be cheaper" : ""}`;
    const model = x.topModel
      ? `<span class="chipm f-${modelFamily(x.topModel)}" title="${escapeHtml(x.topModel)}">${escapeHtml(x.topModel)}</span>`
      : `<span class="muted">${val(DASH)}</span>`;
    const label = x.label !== undefined ? `<span class="slabel">${escapeHtml(x.label)}</span> ` : "";
    const on = x.sessionId === selected;
    const idHtml = `<span class="num${x.label !== undefined ? " muted" : ""}" title="${escapeHtml(x.sessionId)}">${escapeHtml(shortId(x.sessionId))}</span>`;
    // A session total has no per-call records, so it has no call list to open (v0.6).
    const who = x.label !== undefined ? `${x.label} (${shortId(x.sessionId)})` : shortId(x.sessionId);
    const ident = x.sessionTotal
      ? `${label}${idHtml}`
      : `<a class="rowlink" href="${escapeHtml(sessionCallsHref(on ? "" : x.sessionId))}" aria-label="${escapeHtml(on ? `${who}, calls listed above. Close the call list` : `${who}. List this session's calls`)}" title="${on ? "Close the call list" : "List this session's calls"}">${label}${idHtml}</a>${on ? ` <span class="tag on" aria-hidden="true">listed</span>` : ""}`;
    const tag = x.sessionTotal ? ` <span class="tag total" title="${escapeHtml(SESSION_TOTAL_NOTE)}">session total</span>` : "";
    const bar = share > 0 ? `<span class="bar f-other" style="width:${share}%" aria-hidden="true"></span>` : "";
    const calls = callsCell(x.calls, x.callsMissing);
    const callsTd = `<td class="num${calls === DASH ? " muted" : ""}"${titleAttr(x.callsMissing ? CALLS_MISSING_NOTE : undefined)}>${val(calls)}</td>`;
    const html = `<tr${on ? ' class="on"' : ""}><td>${ident}${tag}${bar}</td><td>${escapeHtml(started(x.firstMs))}</td>${callsTd}<td>${model}</td><td class="num${view.unit === "tokens" ? " sum" : ""}">${val(withStar(formatCount(x.tokens), partial))}</td><td class="num${view.unit === "cost" ? " sum" : ""}">${val(withStar(formatUsd(x.nanoAiu), partial))}</td>${cacheCell(x)}<td class="num${flagged ? " flag" : ""}" title="${escapeHtml(growthTitle)}">${growth === DASH ? val(DASH) : sym(`${growth}${flagged ? " ▲" : ""}`)}</td></tr>`;
    return { html, keep: on };
  });
  const count = s.month?.sessionCount ?? list.length;
  const anyFlag = list.some((x) => x.growth !== undefined && x.growth >= GROWTH_FLAG);
  const notes: string[] = [];
  if (anyFlag)
    notes.push(`<p><b aria-hidden="true">▲</b><span class="sr">Up:</span> Later calls in this session cost ${GROWTH_FLAG}× or more than its first ones: the context kept growing. Starting a fresh session for a new task is usually cheaper. Insights lists the costly ones.</p>`);
  if (list.some((x) => x.sessionTotal)) notes.push(`<p>${escapeHtml(SESSION_TOTAL_NOTE)} Its calls are the request count Copilot logged with the total.</p>`);
  if (count > list.length) notes.push(`<p>${escapeHtml(`${plural(count - list.length, "more session")} in ${name} ${count - list.length === 1 ? "is" : "are"} not listed.`)}</p>`);
  notes.push(`<p>Click a session to list its calls above.</p>`);
  notes.push(`<p>Bar = share of the month's estimated cost. Started = first record in ${escapeHtml(name)}, or the session start Copilot logged with a session total. Cache read = cache reads out of every 100 input tokens. Growth = cost of the last 5 calls ÷ the first 5.</p>`);
  const head = `<th>Session</th><th>Started</th><th>Calls</th><th>Top model</th><th>Tokens</th><th>${costLabel()}</th><th>Cache read</th><th>Growth</th>`;
  return card("sessions-title", "sessions", "Costliest sessions", `${name} · ${plural(count, "session")} · largest first`, `${foldedTable(head, rows, undefined, `Costliest sessions, ${name}`)}<div class="fine">${notes.join("")}</div>`);
}

export function renderSessions(s: Snapshot, view: ViewOptions): string {
  const badge = s.current
    ? `${shortId(s.current.folderId)} · ${s.current.live ? "live" : "ended"}${s.current.pinned ? " · pinned" : ""}`
    : "none";
  const none = s.current ? "" : `<p class="muted">No current session. A session becomes current when Copilot logs a model call in it.</p>`;
  // The call list comes first: picking a session redraws the page, which starts at the top.
  const detail = sessionDetailCard(s, view);
  const prompts = promptsCard(s, view);
  return `${detail ? `${detail}\n` : ""}${tilesBox("Current session", badge, s.current?.totals, s.health, false, none)}\n${prompts ? `${prompts}\n` : ""}${sessionsTable(s, view)}`;
}
