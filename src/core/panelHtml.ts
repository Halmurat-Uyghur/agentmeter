// Renders the details panel as one static HTML string: no scripts, no remote
// resources, every dynamic string HTML-escaped. Missing values render "—",
// incomplete ones carry "*" plus a reason; a 0 appears only when logged.
// Navigation (month, tokens/cost) uses command: links limited to an allowlist
// by the webview (D20); the panel itself never runs code.
import {
  costLabel,
  costNotes,
  currencyCode,
  DEFAULT_VIEW,
  formatAiu,
  formatCount,
  formatDuration,
  formatRange,
  formatUsd,
  LOCAL_BANNER,
  money,
  NOT_COVERED,
  partialNote,
  RANGE_LABEL,
  rangeState,
  STREAMING_NOTE,
  usd,
} from "./format";
import { PANEL_CSS } from "./panelCss";
import { addMetrics, heatLevel, modelFamily, NO_PROJECT } from "./store";
import type { Counts, GroupSummary, Health, Metric, MonthSummary, SessionSummary, Snapshot, ToolSummary, Totals, ViewOptions } from "./types";

const DASH = "—";
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Commands the panel may link to; the webview allows exactly these (D20). */
export const PANEL_COMMANDS = ["copilotUsageMonitor.selectMonth", "copilotUsageMonitor.setUnit", "copilotUsageMonitor.setFilter"] as const;

/** Rows shown before a table folds the rest into "Show N more" (D27). */
export const TABLE_LIMIT = 10;

/**
 * A table whose first TABLE_LIMIT rows show; the rest fold into a native
 * <details> (no script). Rows marked `keep` (an active filter) always show,
 * in their sorted place. Rows must already be sorted.
 */
function foldedTable(head: string, rows: { html: string; keep?: boolean }[], limit = TABLE_LIMIT): string {
  const shown: string[] = [];
  const rest: string[] = [];
  rows.forEach((r, i) => (i < limit || r.keep ? shown : rest).push(r.html));
  const table = (body: string[]) => `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;
  if (rest.length === 0) return table(shown);
  return `${table(shown)}<details class="more"><summary>Show ${rest.length} more</summary>${table(rest)}</details>`;
}

/** Server or plugin an added tool belongs to, from its name (D27): "server/tool",
 * "mcp__server__tool", else the part before the first "-" or "_". */
export function toolGroup(name: string): string {
  const slash = name.indexOf("/");
  if (slash > 0) return name.slice(0, slash);
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (mcp) return mcp[1]!;
  const m = /^([A-Za-z0-9.]+)[-_]/.exec(name);
  return m ? m[1]! : name;
}

/** Sessions whose late calls cost this many times their early ones are flagged (D24). */
export const GROWTH_FLAG = 3;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "YYYY-MM" for a local month start. */
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function commandHref(command: (typeof PANEL_COMMANDS)[number], ...args: string[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

/** What to show for a project filter key: its row's display label (session title), else the key. */
function projectLabel(s: Snapshot, key: string): string {
  return s.month?.projects.find((g) => g.name === key)?.label ?? key;
}

/** A link that sets (or, with "", clears) one filter. */
function filterHref(kind: "project" | "tool", value: string): string {
  return commandHref("copilotUsageMonitor.setFilter", kind, value);
}

/** A formatted value with its "*" styled; `text` is already formatted. */
function val(text: string): string {
  if (text.endsWith("*")) return `${escapeHtml(text.slice(0, -1))}<span class="star">*</span>`;
  return escapeHtml(text);
}

function withStar(text: string, partial: boolean): string {
  return partial && text !== DASH && !text.endsWith("*") ? text + "*" : text;
}

function tokens(c: Counts): Metric {
  return addMetrics(c.input, c.output);
}

/** The headline figure of `c` in the chosen unit. */
function headline(c: Counts, view: ViewOptions): string {
  return view.unit === "cost" ? formatUsd(c.nanoAiu, view.currency) : formatCount(tokens(c));
}

function headlineMetric(c: Counts, view: ViewOptions): Metric {
  return view.unit === "cost" ? c.nanoAiu : tokens(c);
}

function headlineValue(c: Counts | undefined, view: ViewOptions): number | undefined {
  if (!c) return undefined;
  const m = headlineMetric(c, view);
  if (m.reported === 0) return undefined;
  return view.unit === "cost" ? usd(m) : m.sum;
}

function unitWord(view: ViewOptions): string {
  return view.unit === "cost" ? `estimated ${currencyCode(view)}` : "input + output tokens";
}

function titleAttr(note: string | undefined): string {
  return note ? ` title="${escapeHtml(note)}"` : "";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]!.slice(0, 3)} ${d.getDate()}`;
}

function monthTitle(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function rootLabel(h: Health): string {
  return h.rootSource === "setting"
    ? "Folder: setting"
    : h.rootSource === "env"
      ? "Folder: COPILOT_HOME"
      : "Folder: default";
}

function page(body: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)} 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Copilot Usage (Local)</title>
<style>${PANEL_CSS}</style>
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>`;
}

function topBar(s: Snapshot | undefined, view: ViewOptions): string {
  const chips: string[] = [];
  if (s) {
    if (s.current) {
      const c = s.current;
      const state = c.live ? "live" : "ended";
      chips.push(
        `<span class="chip${c.live ? " live" : ""}"><i></i>Current session ${state}${c.pinned ? " (pinned)" : ""}</span>`,
      );
    }
    if (s.health.partial)
      chips.push(
        `<span class="chip warn" title="Some logs or lines could not be read; figures marked * may be incomplete."><i></i>Partial data</span>`,
      );
    if (s.health.state === "format-changed")
      chips.push(`<span class="chip warn"><i></i>Format changed</span>`);
    chips.push(`<span class="chip">${escapeHtml(rootLabel(s.health))}</span>`);
  }
  const when = s
    ? `Last change ${clock(s.generatedAtMs)} · day starts at local midnight`
    : "Reading Copilot session logs…";
  const costNote = view.unit === "cost" ? costNotes(view).map((n) => `<p>${escapeHtml(n)}</p>`).join("") : "";
  return `<header class="top">
  <div><h1>Copilot Usage <span class="pill">Local</span></h1><div class="when">${escapeHtml(when)}</div></div>
  <div class="chips">${chips.join("")}</div>
</header>
<section class="note"><p>${escapeHtml(LOCAL_BANNER)}</p><p>${escapeHtml(STREAMING_NOTE)}</p>${costNote}</section>`;
}

/** Month navigation and the tokens / cost switch. */
function navBar(s: Snapshot, view: ViewOptions): string {
  const viewed = s.month?.monthStartMs ?? s.dayStartMs;
  const starts = (s.history ?? []).map((h) => h.monthStartMs);
  const i = starts.indexOf(viewed);
  const link = (cls: string, label: string, href: string | undefined, title: string) =>
    href
      ? `<a class="${cls}" href="${escapeHtml(href)}" title="${escapeHtml(title)}">${label}</a>`
      : `<span class="${cls} off">${label}</span>`;
  const prev = i > 0 ? commandHref("copilotUsageMonitor.selectMonth", monthKey(starts[i - 1]!)) : undefined;
  const next = i >= 0 && i < starts.length - 1 ? commandHref("copilotUsageMonitor.selectMonth", monthKey(starts[i + 1]!)) : undefined;
  const isCurrent = s.month?.isCurrent !== false;
  const back = isCurrent ? "" : link("btn", "This month", commandHref("copilotUsageMonitor.selectMonth", "current"), "Back to the current month");
  const pick = link("btn", "Pick month…", commandHref("copilotUsageMonitor.selectMonth", "pick"), "Choose a month from the history window");
  const unit = (u: ViewOptions["unit"], label: string) =>
    view.unit === u
      ? `<span class="seg on">${label}</span>`
      : link("seg", label, commandHref("copilotUsageMonitor.setUnit", u), `Show ${u === "cost" ? `estimated ${currencyCode(view)}` : "tokens"}`);
  const f = s.filter;
  const chip = (kind: "project" | "tool", label: string, value: string) =>
    `<a class="fchip" href="${escapeHtml(filterHref(kind, ""))}" title="Clear this filter">${escapeHtml(label)}: <b>${escapeHtml(value)}</b> ✕</a>`;
  const filters = f
    ? `<div class="filters"><span class="muted">Filtered month view, trend and tables:</span>${f.project !== undefined ? chip("project", "Project", projectLabel(s, f.project)) : ""}${f.tool !== undefined ? chip("tool", "Tool", f.tool) : ""}<span class="muted">Today and the status bar are not filtered.</span></div>`
    : "";
  return `${filters}<nav class="nav">
  <div class="months">${link("btn", "‹", prev, "Previous month")}<b>${escapeHtml(monthTitle(viewed))}</b>${link("btn", "›", next, "Next month")}${back}${pick}</div>
  <div class="unit">${unit("tokens", "Tokens")}${unit("cost", escapeHtml(costLabel(view)))}</div>
</nav>`;
}

function kpi(cls: string, name: string, sub: string, value: string, note?: string): string {
  return `<div class="kpi ${cls}"${titleAttr(note)}><div><div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(sub)}</div></div><div class="big">${val(value)}</div></div>`;
}

function targetKpi(s: Snapshot, view: ViewOptions): string {
  const cur = s.history?.at(-1) ?? (s.month?.isCurrent ? s.month : undefined);
  const spentMetric = cur?.totals?.nanoAiu;
  const spent = spentMetric ? usd(spentMetric) : undefined;
  const state = rangeState(spent, view.range);
  const name = `Target ${formatRange(view.range, view.currency)}`;
  const sub = `${MONTHS[new Date(cur?.monthStartMs ?? s.dayStartMs).getMonth()]} so far ${spentMetric ? withStar(formatUsd(spentMetric, view.currency), s.health.partial) : money(0, view.currency)} (est.)`;
  const big = state === "under" ? "Under" : state === "over" ? "Over" : "In range";
  return `<div class="kpi k4 st-${state}" title="${escapeHtml(RANGE_LABEL[state])}"><div><div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(sub)}</div></div><div class="big">${escapeHtml(big)}</div></div>`;
}

function kpis(s: Snapshot, view: ViewOptions): string {
  const partial = s.health.partial;
  const today = s.today;
  const todayVal = today ? withStar(headline(today, view), partial) : DASH;
  const todaySub = today ? `${unitWord(view)} · ${plural(today.records, "call")}` : `${unitWord(view)} · no calls yet`;

  const cur = s.current;
  const curVal = cur?.totals ? withStar(headline(cur.totals, view), partial) : DASH;
  const curSub = cur
    ? `${shortId(cur.folderId)} · ${cur.live ? "live" : "ended"}${cur.totals ? ` · ${plural(cur.totals.records, "call")}` : ""}`
    : "no session yet";

  const viewed = new Date(s.month?.monthStartMs ?? s.dayStartMs);
  const monthName = MONTHS[viewed.getMonth()]! + (s.month?.isCurrent === false ? ` ${viewed.getFullYear()}` : "");
  const mt = s.month?.totals;
  const active = s.month?.days.filter((d) => d.totals !== undefined).length ?? 0;
  const monthVal = mt ? withStar(headline(mt, view), partial) : DASH;
  let monthSub = `${plural(active, "active day")}`;
  if (mt && active > 0) {
    const t = headlineMetric(mt, view);
    if (t.reported > 0) {
      const avg = { sum: t.sum / active, reported: t.reported, missing: t.missing };
      const avgText = view.unit === "cost" ? formatUsd(avg, view.currency) : formatCount({ ...avg, sum: Math.round(avg.sum) });
      monthSub += ` · ${avgText} per active day`;
    }
  }

  let fourth: string;
  if (view.range) {
    fourth = targetKpi(s, view);
  } else {
    const aiuToday = today ? withStar(formatAiu(today.nanoAiu), partial) : DASH;
    const aiuMonth = mt ? withStar(formatAiu(mt.nanoAiu), partial) : DASH;
    fourth = kpi("k4", "AIU (as logged)", `today · ${monthName} ${aiuMonth}`, aiuToday, today ? partialNote(today.nanoAiu) : undefined);
  }

  return `<section class="kpis">
${kpi("k1", "Today", todaySub, todayVal, today ? partialNote(headlineMetric(today, view)) : undefined)}
${kpi("k2", "Current session", curSub, curVal, cur?.totals ? partialNote(headlineMetric(cur.totals, view)) : undefined)}
${kpi("k3", monthName, monthSub, monthVal, mt ? partialNote(headlineMetric(mt, view)) : undefined)}
${fourth}
</section>`;
}

const TILE_FIELDS: [string, keyof Counts, (m: Metric, view: ViewOptions) => string][] = [
  ["Input", "input", formatCount],
  ["Output", "output", formatCount],
  ["Cache read", "cacheRead", formatCount],
  ["Cache write", "cacheWrite", formatCount],
  ["Reasoning", "reasoning", formatCount],
  ["Model time", "durationMs", formatDuration],
  ["AIU (as logged)", "nanoAiu", formatAiu],
  ["$cost", "nanoAiu", (m, view) => formatUsd(m, view.currency)],
];

function tilesBox(title: string, badge: string, c: Counts | undefined, health: Health, footReasons: boolean, view: ViewOptions): string {
  const tiles: string[] = [];
  const notes: string[] = [];
  for (const [field, key, fmt] of TILE_FIELDS) {
    const label = field === "$cost" ? costLabel(view) : field;
    const m = c ? (c[key] as Metric) : undefined;
    const text = m ? withStar(fmt(m, view), health.partial) : DASH;
    const note = m ? partialNote(m) : undefined;
    if (note) notes.push(`${label}: ${note}.`);
    tiles.push(`<div class="tile"${titleAttr(note)}><span class="k">${escapeHtml(label)}</span><span class="v">${val(text)}</span></div>`);
  }
  tiles.push(`<div class="tile"><span class="k">Calls</span><span class="v">${c ? c.records : DASH}</span></div>`);
  if (health.partial && footReasons) notes.push(partialReasons(health));
  const fine = notes.length
    ? `<div class="fine">${notes.map((n) => `<p><span class="star">*</span> ${escapeHtml(n)}</p>`).join("")}</div>`
    : "";
  return `<section class="box"><h2>${escapeHtml(title)}<small>${escapeHtml(badge)}</small></h2><div class="tiles">${tiles.join("")}</div>${fine}</section>`;
}

function partialReasons(h: Health): string {
  const parts: string[] = [];
  if (h.unreadableFiles > 0) parts.push(`${plural(h.unreadableFiles, "log")} could not be read`);
  if (h.malformed > 0) parts.push(`${plural(h.malformed, "malformed line")} skipped`);
  if (h.overlong > 0)
    parts.push(`${plural(h.overlong, "over-long line")} that may contain usage ${h.overlong === 1 ? "was" : "were"} skipped`);
  return `Totals may be incomplete: ${parts.join("; ")}.`;
}

function modelTable(s: Snapshot, view: ViewOptions): string {
  const partial = s.health.partial;
  const pastMonth = s.month?.isCurrent === false;
  const t: Totals | undefined = pastMonth ? s.month?.totals : s.today;
  const scope = pastMonth ? monthTitle(s.month!.monthStartMs) : "Today";
  const models = t ? Object.keys(t.byModel) : [];
  const total = t ? (headlineValue(t, view) ?? 0) : 0;
  const rows = models
    .map((m) => ({ m, c: t!.byModel[m]! }))
    .sort((a, b) => (headlineValue(b.c, view) ?? 0) - (headlineValue(a.c, view) ?? 0) || a.m.localeCompare(b.m))
    .map(({ m, c }) => {
      const tok = tokens(c);
      const v = headlineValue(c, view);
      const share = total > 0 && v !== undefined ? Math.round((100 * v) / total) : 0;
      const fam = modelFamily(m);
      const cell = (x: string, note?: string) =>
        `<td class="num${x === DASH ? " muted" : ""}"${titleAttr(note)}>${val(withStar(x, partial))}</td>`;
      const perCall = usd(c.nanoAiu);
      const perCallText = perCall === undefined || c.records === 0 ? DASH : money(perCall / c.records, view.currency);
      return `<tr><td><span class="chipm f-${fam}" title="${escapeHtml(m)}">${escapeHtml(m)}</span>${share > 0 ? `<span class="bar f-${fam}" style="width:${share}%"></span>` : ""}</td>${cell(formatCount(c.input), partialNote(c.input))}${cell(formatCount(c.output), partialNote(c.output))}${cell(formatCount(c.cacheRead), partialNote(c.cacheRead))}<td class="num${view.unit === "tokens" ? " sum" : ""}"${titleAttr(partialNote(tok))}>${val(withStar(formatCount(tok), partial))}</td><td class="num${view.unit === "cost" ? " sum" : ""}"${titleAttr(partialNote(c.nanoAiu))}>${val(withStar(formatUsd(c.nanoAiu, view.currency), partial))}</td>${cell(perCallText)}<td class="num">${c.records}</td></tr>`;
    });
  const empty = pastMonth ? `No per-call records in ${monthTitle(s.month!.monthStartMs)}.` : "No per-call records dated today.";
  const body = rows.length
    ? foldedTable("<th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Tokens</th><th>${escapeHtml(costLabel(view))}</th><th>Per call</th><th>Calls</th>", rows.map((html) => ({ html })))
    : `<p class="muted">${escapeHtml(empty)}</p>`;
  return `<section class="box"><h2>${escapeHtml(scope)} by model<small>${plural(models.length, "model")}</small></h2>${body}<div class="fine">Bar = share of ${pastMonth ? "the month's" : "today's"} ${unitWord(view)}. Per call = estimated ${escapeHtml(currencyCode(view))} per model call. "—" means the log did not report the value; it is never shown as 0.</div></section>`;
}

function calendar(s: Snapshot, view: ViewOptions): string {
  const anchor = new Date(s.month?.monthStartMs ?? s.dayStartMs);
  const y = anchor.getFullYear();
  const mo = anchor.getMonth();
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const lead = (new Date(y, mo, 1).getDay() + 6) % 7;
  const days = s.month?.days ?? [];
  const metrics = days.map((d) => (d.totals ? headlineMetric(d.totals, view) : undefined));
  const values = days.map((d) => headlineValue(d.totals, view));
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const todayNum = new Date(s.dayStartMs).getDate();
  const sameMonth = new Date(s.dayStartMs).getMonth() === mo && new Date(s.dayStartMs).getFullYear() === y;
  const fmt = (m: Metric) => (view.unit === "cost" ? formatUsd(m, view.currency) : formatCount(m));
  const word = view.unit === "cost" ? `estimated ${currencyCode(view)}` : "tokens";

  const cells: string[] = DOW.map((d) => `<div class="dow">${d}</div>`);
  for (let i = 0; i < lead; i++) cells.push(`<div class="d pad"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const m = metrics[day - 1];
    const known = day <= days.length;
    if (!known) {
      cells.push(`<div class="d later">${day}</div>`);
      continue;
    }
    const text = m ? withStar(fmt(m), s.health.partial) : DASH;
    const v = values[day - 1];
    const level = v !== undefined ? heatLevel(v, max) : 0;
    const now = sameMonth && day === todayNum ? " now" : "";
    const title = m ? `${text} ${word}${text.endsWith("*") ? " (may be incomplete)" : ""}` : "No usage records";
    cells.push(`<div class="d${level ? ` h${level}` : ""}${now}" title="${escapeHtml(title)}">${day}<small>${val(text)}</small></div>`);
  }
  const mt = s.month?.totals;
  const swatches = [0, 1, 2, 3, 4]
    .map((l) => `<b class="${l ? `h${l}` : ""}"></b>`)
    .join("");
  const heading = view.unit === "cost" ? `Daily ${costLabel(view)}` : "Daily tokens";
  const sub = view.unit === "cost" ? "logged AI credits × $0.01" : "input + output";
  const so = s.month?.isCurrent === false ? "Month total" : "Month so far";
  return `<section class="box"><h2>${heading} — ${MONTHS[mo]} ${y}<small>${escapeHtml(sub)}</small></h2><div class="month">${cells.join("")}</div><div class="scale"><span>Less<span class="sw month-sw">${swatches}</span>More</span><span>${so}: <b class="num">${val(mt ? withStar(formatCount(tokens(mt)), s.health.partial) : DASH)}</b> tokens · <b class="num">${val(mt ? withStar(formatUsd(mt.nanoAiu, view.currency), s.health.partial) : DASH)}</b> ${escapeHtml(costLabel(view))}</span></div></section>`;
}

/** Monthly bars over the history window; each bar opens that month (D21). */
function trend(s: Snapshot, view: ViewOptions): string {
  const hist: MonthSummary[] = s.history ?? [];
  if (hist.length === 0) return "";
  const viewed = s.month?.monthStartMs;
  const values = hist.map((h) => headlineValue(h.totals, view));
  const range = view.unit === "cost" ? view.range : undefined;
  const top = Math.max(0, ...values.map((v) => v ?? 0), range?.max ?? 0, range?.min ?? 0);
  const scale = top > 0 ? top * 1.08 : 1;
  const pct = (v: number) => Math.max(0, Math.min(100, (100 * v) / scale)).toFixed(1);
  const fmt = (m: Metric) => (view.unit === "cost" ? formatUsd(m, view.currency) : formatCount(m));

  const cols = hist.map((h, i) => {
    const v = values[i];
    const m = h.totals ? headlineMetric(h.totals, view) : undefined;
    const text = m ? withStar(fmt(m), s.health.partial) : DASH;
    const state = range ? rangeState(h.totals ? usd(h.totals.nanoAiu) : undefined, range) : "none";
    const d = new Date(h.monthStartMs);
    const label = MONTHS[d.getMonth()]!.slice(0, 3) + (d.getMonth() === 0 || i === 0 ? ` ${String(d.getFullYear()).slice(2)}` : "");
    const sel = h.monthStartMs === viewed ? " sel" : "";
    const bar = v !== undefined && v > 0 ? `<span class="fill st-${state}" style="height:${pct(v)}%"></span>` : "";
    const title = `${monthTitle(h.monthStartMs)}: ${text}${view.unit === "cost" ? ` ${costLabel(view)}` : " tokens"}${range ? ` · ${RANGE_LABEL[state]}` : ""}`;
    return `<a class="col${sel}" href="${escapeHtml(commandHref("copilotUsageMonitor.selectMonth", monthKey(h.monthStartMs)))}" title="${escapeHtml(title)}"><span class="v">${val(text)}</span><span class="track">${bar}</span><span class="m">${escapeHtml(label)}</span></a>`;
  });

  let band = "";
  if (range) {
    const lo = range.min ?? 0;
    const hi = range.max ?? scale;
    band = `<span class="band" style="bottom:${pct(lo)}%;height:${(Number(pct(hi)) - Number(pct(lo))).toFixed(1)}%" title="${escapeHtml(`Target ${formatRange(range, view.currency)}`)}"></span>`;
  }
  const legend = range
    ? `<span class="lg"><b class="st-under"></b>Under <b class="st-in"></b>In range <b class="st-over"></b>Over <b class="bandsw"></b>Target ${escapeHtml(formatRange(range, view.currency))}</span>`
    : `<span class="lg">${view.unit === "cost" ? "Set copilotUsageMonitor.monthlyTargetMin / Max to see a target band." : `Switch to ${costLabel(view)} to compare against a target.`}</span>`;
  const filtered = s.filter ? " · filtered" : "";
  return `<section class="box"><h2>Monthly trend<small>${plural(hist.length, "month")} · ${escapeHtml(unitWord(view))}${filtered} · click a month to open it</small></h2><div class="trend"><div class="plot">${band}${cols.join("")}</div></div><div class="scale">${legend}</div></section>`;
}

/**
 * Daily bars for the viewed month (honours the filter, like the calendar),
 * with a dashed line at the average over days that have records. Days after
 * today render as empty slots. Bars carry no link: there is no day view.
 */
function dailyTrend(s: Snapshot, view: ViewOptions): string {
  const mv = s.month;
  if (!mv) return "";
  const anchor = new Date(mv.monthStartMs);
  const y = anchor.getFullYear();
  const mo = anchor.getMonth();
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const values = mv.days.map((d) => headlineValue(d.totals, view));
  const active = values.filter((v): v is number => v !== undefined);
  const top = Math.max(0, ...active);
  const scale = top > 0 ? top * 1.08 : 1;
  const pct = (v: number) => Math.max(0, Math.min(100, (100 * v) / scale)).toFixed(1);
  const fmt = (m: Metric) => (view.unit === "cost" ? formatUsd(m, view.currency) : formatCount(m));
  const fmtNum = (n: number) => (view.unit === "cost" ? money(n, view.currency) : formatCount({ sum: Math.round(n), reported: 1, missing: 0 }));
  const word = view.unit === "cost" ? ` ${costLabel(view)}` : " tokens";
  const todayStart = s.dayStartMs;

  let peakIdx = -1;
  values.forEach((v, i) => {
    if (v !== undefined && (peakIdx < 0 || v > values[peakIdx]!)) peakIdx = i;
  });

  const cols: string[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const d = mv.days[day - 1];
    const label = day === 1 || day % 5 === 0 ? String(day) : "";
    if (!d) {
      cols.push(`<span class="col later" title="${escapeHtml(`${MONTHS[mo]!.slice(0, 3)} ${day}: not yet`)}"><span class="track"></span><span class="m">${label}</span></span>`);
      continue;
    }
    const v = values[day - 1];
    const m = d.totals ? headlineMetric(d.totals, view) : undefined;
    const text = m ? withStar(fmt(m), s.health.partial) : DASH;
    const bar = v !== undefined && v > 0 ? `<span class="fill${day - 1 === peakIdx ? " peak" : ""}" style="height:${pct(v)}%"></span>` : "";
    const now = d.dayStartMs === todayStart ? " sel" : "";
    const title = m ? `${shortDate(d.dayStartMs)}: ${text}${word}` : `${shortDate(d.dayStartMs)}: no usage records`;
    cols.push(`<span class="col${now}" title="${escapeHtml(title)}"><span class="track">${bar}</span><span class="m">${label}</span></span>`);
  }

  if (active.length === 0) {
    return `<section class="box"><h2>Daily trend — ${MONTHS[mo]} ${y}<small>${escapeHtml(unitWord(view))}</small></h2><p class="muted">No usage records this month${s.filter ? " for this filter" : ""}.</p></section>`;
  }
  const avg = active.reduce((a, b) => a + b, 0) / active.length;
  const avgLine = `<span class="avgwrap"><span class="avg" style="bottom:${pct(avg)}%" title="${escapeHtml(`Average per active day: ${fmtNum(avg)}${word}`)}"></span></span>`;
  const peakDay = mv.days[peakIdx]!;
  const peakMetric = headlineMetric(peakDay.totals!, view);
  const partial = s.health.partial;
  const filtered = s.filter ? " · filtered" : "";
  const stats = `<span class="lg"><b class="avgsw"></b>Avg / active day <b class="num">${val(withStar(fmtNum(avg), partial))}</b></span><span>Peak <b class="num">${val(withStar(fmt(peakMetric), partial))}</b> on ${escapeHtml(shortDate(peakDay.dayStartMs))} · ${active.length} of ${plural(mv.days.length, "day")} active</span>`;
  return `<section class="box"><h2>Daily trend — ${MONTHS[mo]} ${y}<small>${escapeHtml(unitWord(view))}${filtered} · one bar per day</small></h2><div class="trend daily"><div class="plot">${avgLine}${cols.join("")}</div></div><div class="scale">${stats}</div></section>`;
}

function share(part: Metric, whole: number | undefined): number {
  return whole && part.reported > 0 ? Math.round((100 * part.sum) / whole) : 0;
}

/** Per-project table for the viewed month; each row filters to that project (D26). */
function projectsBox(s: Snapshot, view: ViewOptions): string {
  const list: GroupSummary[] = s.month?.projects ?? [];
  const scope = monthTitle(s.month?.monthStartMs ?? s.dayStartMs);
  const partial = s.health.partial;
  const active = s.filter?.project;
  if (list.length === 0) {
    return `<section class="box"><h2>By project<small>${escapeHtml(scope)}</small></h2><p class="muted">No per-call records in this month.</p></section>`;
  }
  const whole = list.reduce((a, g) => a + (view.unit === "cost" ? g.nanoAiu.sum : g.tokens.sum), 0);
  const rows = list.map((g) => {
    const keep = g.name === active;
    const pct = share(view.unit === "cost" ? g.nanoAiu : g.tokens, whole);
    const on = g.name === active;
    const href = filterHref("project", on ? "" : g.name);
    const name = g.name === NO_PROJECT ? `<span class="muted">${escapeHtml(g.name)}</span>` : escapeHtml(g.label ?? g.name);
    return { keep, html: `<tr${on ? ' class="on"' : ""}><td><a class="rowlink" href="${escapeHtml(href)}" title="${on ? "Clear the project filter" : "Show only this project"}">${name}</a>${pct > 0 ? `<span class="bar f-gemini" style="width:${pct}%"></span>` : ""}</td><td class="num">${g.sessions}</td><td class="num">${g.calls}</td><td class="num${view.unit === "tokens" ? " sum" : ""}">${val(withStar(formatCount(g.tokens), partial))}</td><td class="num${view.unit === "cost" ? " sum" : ""}">${val(withStar(formatUsd(g.nanoAiu, view.currency), partial))}</td></tr>` };
  });
  const note = s.filter?.tool ? ` Only calls that used ${s.filter.tool}.` : "";
  return `<section class="box"><h2>By project<small>${escapeHtml(scope)} · ${plural(list.length, "project")} · click to filter</small></h2>${foldedTable("<th>Project</th><th>Sessions</th><th>Calls</th><th>Tokens</th><th>${escapeHtml(costLabel(view))}</th>", rows)}<div class="fine">Project = the session's GitHub repository, else its folder name (or its title when the folder is named by an ID); full paths are never read.${escapeHtml(note)}</div></section>`;
}

/** Per-tool table for the viewed month; each row filters to calls that used that tool (D26). */
function toolsBox(s: Snapshot, view: ViewOptions): string {
  const list: ToolSummary[] = s.month?.tools ?? [];
  const scope = monthTitle(s.month?.monthStartMs ?? s.dayStartMs);
  const partial = s.health.partial;
  const active = s.filter?.tool;
  if (list.length === 0) {
    return `<section class="box"><h2>By tool<small>${escapeHtml(scope)}</small></h2><p class="muted">No tool use logged in this month.</p></section>`;
  }
  const added = list.filter((t) => !t.builtIn);
  const rows = list.map((t) => {
    const on = t.name === active;
    const href = filterHref("tool", on ? "" : t.name);
    const kind = t.builtIn ? `<span class="tag">built-in</span>` : `<span class="tag add">added</span>`;
    return { keep: on, html: `<tr${on ? ' class="on"' : ""}><td><a class="rowlink num" href="${escapeHtml(href)}" title="${on ? "Clear the tool filter" : "Show only calls that used this tool"}">${escapeHtml(t.name)}</a></td><td>${kind}</td><td class="num">${t.uses}</td><td class="num">${t.calls}</td><td class="num${view.unit === "tokens" ? " sum" : ""}">${val(withStar(formatCount(t.tokens), partial))}</td><td class="num${view.unit === "cost" ? " sum" : ""}">${val(withStar(formatUsd(t.nanoAiu, view.currency), partial))}</td></tr>` };
  });
  let addedNote = "Only built-in tools were used.";
  if (added.length) {
    const groups = new Map<string, { tools: number; uses: number; nano: number }>();
    for (const t of added) {
      const g = groups.get(toolGroup(t.name)) ?? { tools: 0, uses: 0, nano: 0 };
      g.tools++;
      g.uses += t.uses;
      g.nano += t.nanoAiu.sum;
      groups.set(toolGroup(t.name), g);
    }
    const sorted = [...groups].sort((a, b) => b[1].nano - a[1].nano || b[1].uses - a[1].uses || a[0].localeCompare(b[0]));
    const shown = sorted.slice(0, TABLE_LIMIT).map(([name, g]) => `${name} (${plural(g.tools, "tool")}, ${plural(g.uses, "use")})`);
    const more = sorted.length > TABLE_LIMIT ? ` and ${sorted.length - TABLE_LIMIT} more` : "";
    addedNote = `${plural(added.length, "added tool")} from ${plural(sorted.length, "server or plugin", "servers or plugins")}: ${shown.join(", ")}${more}.`;
  }
  const note = s.filter?.project ? ` Only project ${projectLabel(s, s.filter.project)}.` : "";
  return `<section class="box"><h2>By tool<small>${escapeHtml(scope)} · ${plural(list.length, "tool")} · click to filter</small></h2>${foldedTable("<th>Tool</th><th>Kind</th><th>Uses</th><th>Calls</th><th>Tokens</th><th>${escapeHtml(costLabel(view))}</th>", rows)}<div class="fine"><p>${escapeHtml(addedNote)}</p><p>Uses = times the model invoked the tool. Calls / Tokens / ${escapeHtml(currencyCode(view))} = the model calls that invoked it; a call that used two tools counts for both, so rows do not add up to the month.${escapeHtml(note)}</p></div></section>`;
}

function sessionsBox(s: Snapshot, view: ViewOptions): string {
  const list: SessionSummary[] = s.month?.sessions ?? [];
  const scope = monthTitle(s.month?.monthStartMs ?? s.dayStartMs);
  const partial = s.health.partial;
  if (list.length === 0) {
    return `<section class="box"><h2>Costliest sessions<small>${escapeHtml(scope)}</small></h2><p class="muted">No per-call records in this month.</p></section>`;
  }
  const monthUsd = s.month?.totals ? usd(s.month.totals.nanoAiu) : undefined;
  const rows = list.map((x) => {
    const cost = usd(x.nanoAiu);
    const perCall = cost === undefined ? DASH : money(cost / x.calls, view.currency);
    const share = cost !== undefined && monthUsd ? Math.round((100 * cost) / monthUsd) : 0;
    const flagged = x.growth !== undefined && x.growth >= GROWTH_FLAG;
    const growth = x.growth === undefined ? DASH : `${x.growth.toFixed(1)}×`;
    const growthTitle = x.growth === undefined
      ? "Needs at least 10 calls with logged AI credits"
      : `Last 5 calls cost ${x.growth.toFixed(1)}× the first 5${flagged ? ": the context grew; a fresh session may be cheaper" : ""}`;
    const dates = shortDate(x.firstMs) === shortDate(x.lastMs) ? shortDate(x.firstMs) : `${shortDate(x.firstMs)} – ${shortDate(x.lastMs)}`;
    const model = x.topModel
      ? `<span class="chipm f-${modelFamily(x.topModel)}" title="${escapeHtml(x.topModel)}">${escapeHtml(x.topModel)}</span>`
      : `<span class="muted">${DASH}</span>`;
    return `<tr><td><span class="num" title="${escapeHtml(x.sessionId)}">${escapeHtml(shortId(x.sessionId))}</span>${share > 0 ? `<span class="bar f-other" style="width:${share}%"></span>` : ""}</td><td>${escapeHtml(dates)}</td><td>${model}</td><td class="num">${x.calls}</td><td class="num${view.unit === "tokens" ? " sum" : ""}">${val(withStar(formatCount(x.tokens), partial))}</td><td class="num${view.unit === "cost" ? " sum" : ""}">${val(withStar(formatUsd(x.nanoAiu, view.currency), partial))}</td><td class="num">${escapeHtml(perCall)}</td><td class="num${flagged ? " flag" : ""}" title="${escapeHtml(growthTitle)}">${escapeHtml(growth)}${flagged ? " ▲" : ""}</td></tr>`;
  });
  const anyFlag = list.some((x) => x.growth !== undefined && x.growth >= GROWTH_FLAG);
  const tip = anyFlag
    ? `<p><b>▲</b> Later calls in this session cost ${GROWTH_FLAG}× or more than its first ones: the context kept growing. Starting a fresh session for a new task is usually cheaper.</p>`
    : "";
  return `<section class="box"><h2>Costliest sessions<small>${escapeHtml(scope)} · top ${list.length}</small></h2><div class="tablewrap"><table><thead><tr><th>Session</th><th>Dates</th><th>Main model</th><th>Calls</th><th>Tokens</th><th>${escapeHtml(costLabel(view))}</th><th>Per call</th><th>Growth</th></tr></thead><tbody>${rows.join("")}</tbody></table></div><div class="fine">${tip}<p>Bar = share of the month's estimated cost. Growth = cost of the last 5 calls ÷ the first 5.</p></div></section>`;
}

function healthBox(s: Snapshot): string {
  const h = s.health;
  const fact = (k: string, v: number, warn = false) =>
    `<div class="fact"><span>${escapeHtml(k)}</span><span class="num${warn && v > 0 ? " star" : ""}">${v}</span></div>`;
  return `<section class="box"><h2>Data health<small>read-only · nothing leaves this computer</small></h2><div class="facts">
${fact("Sessions this month", s.sessions.length)}
${fact("Months of history", s.history?.length ?? 1)}
${fact("Unreadable logs", h.unreadableFiles, true)}
${fact("Sessions without per-call data", h.sessionsWithoutUsage)}
${fact("Lines in an unknown format", h.unrecognized, true)}
${fact("Malformed lines", h.malformed, true)}
${fact("Over-long lines skipped (may be usage)", h.overlong, true)}
${h.overlongOther > 0 ? fact("Over-long lines skipped (not usage)", h.overlongOther) : ""}
</div><h2 style="margin-top:14px">Not covered</h2><ul class="plain">${NOT_COVERED.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></section>`;
}

function stateNote(h: Health): string {
  if (h.state === "no-dir")
    return `<section class="note alert"><p>No Copilot session logs were found. Set <b>copilotUsageMonitor.copilotHome</b> if Copilot keeps them somewhere other than COPILOT_HOME or the default folder in your home directory.</p></section>`;
  if (h.state === "permission")
    return `<section class="note alert"><p>The Copilot session log folder could not be read on this computer.</p></section>`;
  if (h.state === "format-changed")
    return `<section class="note alert"><p>${escapeHtml(`${h.unrecognized > 0 ? `${plural(h.unrecognized, "line")} in a format this version doesn't recognize. ` : ""}Copilot may have changed its log format, so figures may be incomplete.`)}</p></section>`;
  return "";
}

/** The whole panel document for a snapshot (or the loading state). */
export function renderPanelHtml(s: Snapshot | undefined, cspSource: string, view: ViewOptions = DEFAULT_VIEW): string {
  if (!s) return page(`${topBar(undefined, view)}<p class="muted">Loading…</p>`, cspSource);
  const badge = s.current
    ? `${shortId(s.current.folderId)} · ${s.current.live ? "live" : "ended"}${s.current.pinned ? " · pinned" : ""}`
    : "none";
  const body = `${topBar(s, view)}
${stateNote(s.health)}
${navBar(s, view)}
${kpis(s, view)}
${trend(s, view)}
${dailyTrend(s, view)}
<div class="cols">
<div>
${tilesBox("Today in detail", "9 metrics", s.today, s.health, true, view)}
${tilesBox("Current session", badge, s.current?.totals, s.health, false, view)}
</div>
<div>
${modelTable(s, view)}
${calendar(s, view)}
</div>
</div>
<div class="cols even">
<div>${projectsBox(s, view)}</div>
<div>${toolsBox(s, view)}</div>
</div>
${sessionsBox(s, view)}
${healthBox(s)}`;
  return page(body, cspSource);
}
