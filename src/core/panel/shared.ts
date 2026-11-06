// Helpers shared by the panel's section renderers. Every log-derived string
// goes through escapeHtml; "—" means not reported (never 0), "*" incomplete.
import { costLabel, estWord, formatAiu, formatCount, formatDuration, formatUsd, partialNote, spoken, usd } from "../format";
import { addMetrics } from "../store";
import type { Counts, Health, Metric, Snapshot, ViewOptions } from "../types";
import { icon, type IconName } from "./icons";

export const DASH = "—";
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Rows shown before a table folds the rest into "Show N more" (D27). */
export const TABLE_LIMIT = 10;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM" for a local month start. */
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]!.slice(0, 3)} ${d.getDate()}`;
}

export function monthTitle(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Start of the viewed month (the current one when the snapshot has no month view). */
export function viewedStart(s: Snapshot): number {
  return s.month?.monthStartMs ?? s.dayStartMs;
}

/** "November" for the current month, "October 2026" for a past one (O3 {Month}). */
export function viewedName(s: Snapshot): string {
  const d = new Date(viewedStart(s));
  return MONTHS[d.getMonth()]! + (s.month?.isCurrent === false ? ` ${d.getFullYear()}` : "");
}

/**
 * A table whose first TABLE_LIMIT rows show; the rest fold into a native
 * <details> (no script). Rows marked `keep` (an active filter) always show,
 * in their sorted place. Rows must already be sorted.
 */
export function foldedTable(head: string, rows: { html: string; keep?: boolean }[], limit = TABLE_LIMIT, caption?: string): string {
  const shown: string[] = [];
  const rest: string[] = [];
  rows.forEach((r, i) => (i < limit || r.keep ? shown : rest).push(rowHeader(r.html)));
  const table = (body: string[], cap: string) =>
    `<div class="tablewrap" tabindex="0" role="region" aria-label="${escapeHtml(`${cap}, scrolls sideways`)}"><table>${caption ? `<caption class="sr">${escapeHtml(cap)}</caption>` : ""}<thead><tr>${scopeCols(head)}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;
  const name = caption ?? "Table";
  if (rest.length === 0) return table(shown, name);
  return `${table(shown, name)}<details class="more"><summary>Show ${rest.length} more</summary>${table(rest, `${name}, more rows`)}</details>`;
}

/** The first cell of a row becomes its header (m9): <th scope="row">. */
function rowHeader(tr: string): string {
  const m = /^(<tr[^>]*>)<td([^>]*)>/.exec(tr);
  if (!m) return tr;
  const end = tr.indexOf("</td>", m[0].length);
  if (end < 0) return tr;
  return `${m[1]}<th scope="row"${m[2]}>${tr.slice(m[0].length, end)}</th>${tr.slice(end + 5)}`;
}

/** Header cells get scope="col" (m9). */
function scopeCols(head: string): string {
  return head.replace(/<th>/g, '<th scope="col">');
}

/**
 * A formatted value for the page: "—" reads "not reported" and "*" reads "(may be
 * incomplete)" to a screen reader (O3 section 7); the glyphs themselves are hidden
 * from it. `text` is already formatted.
 */
export function val(text: string): string {
  if (text === DASH) return `<span aria-hidden="true">${DASH}</span><span class="sr">not reported</span>`;
  if (text.endsWith("*")) return `${escapeHtml(text.slice(0, -1))}<span class="star" aria-hidden="true">*</span><span class="sr"> (may be incomplete)</span>`;
  return escapeHtml(text);
}

/** Text with ▲ ▼ × or "<" in it: shown as is, read as words ("up 2.7 times"). */
export function sym(text: string): string {
  if (!/[▲▼×]|<\d/.test(text)) return escapeHtml(text);
  return `<span aria-hidden="true">${escapeHtml(text)}</span><span class="sr">${escapeHtml(spoken(text))}</span>`;
}

/** A section card with the dashboard's header (design #8): an icon, the title and a muted
 * right-hand note, labelled by its heading. */
export function card(id: string, ic: IconName, title: string, small: string, body: string, cls = ""): string {
  return `<section class="card${cls ? ` ${cls}` : ""}" aria-labelledby="${id}"><h3 id="${id}" class="ch">${icon(ic)}<span>${escapeHtml(title)}</span>${small ? `<small>${escapeHtml(small)}</small>` : ""}</h3>${body}</section>`;
}

export function withStar(text: string, partial: boolean): string {
  return partial && text !== DASH && !text.endsWith("*") ? text + "*" : text;
}

export function tokens(c: Counts): Metric {
  return addMetrics(c.input, c.output);
}

/** The headline figure of `c` in the chosen unit. */
export function headline(c: Counts, view: ViewOptions): string {
  return view.unit === "cost" ? formatUsd(c.nanoAiu) : formatCount(tokens(c));
}

export function headlineMetric(c: Counts, view: ViewOptions): Metric {
  return view.unit === "cost" ? c.nanoAiu : tokens(c);
}

export function headlineValue(c: Counts | undefined, view: ViewOptions): number | undefined {
  if (!c) return undefined;
  const m = headlineMetric(c, view);
  if (m.reported === 0) return undefined;
  return view.unit === "cost" ? usd(m) : m.sum;
}

export function unitWord(view: ViewOptions): string {
  return view.unit === "cost" ? estWord() : "input + output tokens";
}

export function titleAttr(note: string | undefined): string {
  return note ? ` title="${escapeHtml(note)}"` : "";
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A call count: "—" when the only contributing session totals did not log their request
 * count, "N*" when some did not (a lower bound), never a bare 0 for unlogged calls (N1). */
export function callsCell(calls: number, missing = 0): string {
  if (missing <= 0) return String(calls);
  return calls === 0 ? DASH : `${calls}*`;
}

/** Like callsCell, as words: "3 calls", "3 calls*" or "calls not logged". */
export function callsPhrase(calls: number, missing = 0): string {
  if (missing <= 0) return plural(calls, "call");
  return calls === 0 ? "calls not logged" : `${plural(calls, "call")}*`;
}

export const CALLS_MISSING_NOTE = "A session total did not log its request count; its calls are not included.";

/** A part of a whole as "61 in 100" (the copy gate bans the percent sign); "—" when unknown. */
export function inHundred(part: number | undefined, whole: number | undefined): string {
  if (part === undefined || !whole || whole <= 0) return DASH;
  const n = Math.round((100 * Math.min(part, whole)) / whole);
  return n === 0 && part > 0 ? "<1 in 100" : `${n} in 100`;
}

/** What to show for a project filter key: its row's display label (session title), else the key. */
export function projectLabel(s: Snapshot, key: string): string {
  return s.month?.projects.find((g) => g.name === key)?.label ?? key;
}

/** Visible fine print naming the session totals inside a figure, or "". */
export function totalsFine(n: number, what: string): string {
  if (n <= 0) return "";
  return `<p>${escapeHtml(`${what} includes ${plural(n, "session total")} from older Copilot, each counted on the day its session ended.`)}</p>`;
}

export function partialReasons(h: Health): string {
  const parts: string[] = [];
  if (h.unreadableFiles > 0) parts.push(`${plural(h.unreadableFiles, "log")} could not be read`);
  if (h.malformed > 0) parts.push(`${plural(h.malformed, "malformed line")} skipped`);
  if (h.overlong > 0)
    parts.push(`${plural(h.overlong, "over-long line")} that may contain usage ${h.overlong === 1 ? "was" : "were"} skipped`);
  if (h.shutdownOversize > 0)
    parts.push(`${plural(h.shutdownOversize, "session-end line")} too long to read ${h.shutdownOversize === 1 ? "was" : "were"} skipped`);
  return `Totals may be incomplete: ${parts.join("; ")}.`;
}

const TILE_FIELDS: [string, keyof Counts, (m: Metric) => string][] = [
  ["Input", "input", formatCount],
  ["Output", "output", formatCount],
  ["Cache read", "cacheRead", formatCount],
  ["Cache write", "cacheWrite", formatCount],
  ["Reasoning", "reasoning", formatCount],
  ["Model time", "durationMs", formatDuration],
  ["AIU (as logged)", "nanoAiu", formatAiu],
  ["USD (est.)", "nanoAiu", formatUsd],
];

/** A card of nine metric tiles for `c` (undefined: every tile "—"). */
export function tilesBox(title: string, badge: string, c: Counts | undefined, health: Health, footReasons: boolean, extra = "", ic: IconName = "session"): string {
  const tiles: string[] = [];
  const notes: string[] = [];
  for (let [label, key, fmt] of TILE_FIELDS) {
    if (label === "USD (est.)") label = costLabel();
    const m = c ? (c[key] as Metric) : undefined;
    const text = m ? withStar(fmt(m), health.partial) : DASH;
    const note = m ? partialNote(m) : undefined;
    if (note) notes.push(`${label}: ${note}.`);
    tiles.push(`<div class="tile"${titleAttr(note)}><span class="k">${escapeHtml(label)}</span><span class="v">${val(text)}</span></div>`);
  }
  const calls = c ? callsCell(c.calls, c.callsMissing) : DASH;
  if (c && c.callsMissing > 0) notes.push(`Calls: ${CALLS_MISSING_NOTE}`);
  tiles.push(`<div class="tile"${titleAttr(c && c.callsMissing > 0 ? CALLS_MISSING_NOTE : undefined)}><span class="k">Calls</span><span class="v">${val(calls)}</span></div>`);
  if (health.partial && footReasons) notes.push(partialReasons(health));
  const fine = notes.length
    ? `<div class="fine">${notes.map((n) => `<p><span class="star" aria-hidden="true">*</span> ${escapeHtml(n)}</p>`).join("")}</div>`
    : "";
  const id = `tiles-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return card(id, ic, title, badge, `${extra}<div class="tiles">${tiles.join("")}</div>${fine}`);
}
