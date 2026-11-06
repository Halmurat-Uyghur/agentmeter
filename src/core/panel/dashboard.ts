// The Overview dashboard cards (A2): the Today hero with the activity heatmap and
// the cache-reuse ring, Month to date, and the last 30 days as bars. Charts are
// inline SVG with a text alternative; no script, no URL. Unknown is "—", never 0.
// Today, the heatmap and the bars read the unfiltered per-day activity; Month to
// date and the ring follow the viewed month and its filter.
import { formatCount, formatUsd, money, partialNote, weekCoverage } from "../format";
import { heatLevel, localDaysBefore } from "../store";
import type { DayStats, Metric, Snapshot, ViewOptions } from "../types";
import { icon } from "./icons";
import {
  callsPhrase,
  DASH,
  escapeHtml,
  headline,
  headlineMetric,
  headlineValue,
  MONTHS,
  plural,
  shortDate,
  sym,
  titleAttr,
  unitWord,
  val,
  viewedName,
  withStar,
} from "./shared";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A day's figure in the chosen unit; undefined when it was not reported. */
export function dayMetric(d: DayStats, view: ViewOptions): Metric {
  return view.unit === "cost" ? d.nanoAiu : d.tokens;
}

export function dayValue(d: DayStats | undefined, view: ViewOptions): number | undefined {
  if (!d) return undefined;
  const m = dayMetric(d, view);
  if (m.reported === 0) return undefined;
  return view.unit === "cost" ? m.sum / 1e11 : m.sum;
}

function fmtMetric(m: Metric, view: ViewOptions): string {
  return view.unit === "cost" ? formatUsd(m) : formatCount(m);
}

function fmtNum(n: number, view: ViewOptions): string {
  return view.unit === "cost" ? money(n) : formatCount({ sum: Math.round(n), reported: 1, missing: 0 });
}

function unitSuffix(view: ViewOptions): string {
  return view.unit === "cost" ? " USD (est.)" : " tokens";
}

/** "estimated USD not reported" / "tokens not reported": a day with records but no figure in the unit. */
export function notReported(view: ViewOptions): string {
  return `${view.unit === "cost" ? "estimated USD" : "tokens"} not reported`;
}

function totalsPart(d: DayStats | undefined): string {
  return d && d.sessionTotals > 0 ? ` (includes ${plural(d.sessionTotals, "session total")})` : "";
}

/**
 * A day's hover text. "no usage records" only when the day has no record; a day whose
 * records carry no figure in the unit (session totals without a logged cost, say) reads
 * "— (estimated USD not reported)", never "no usage records" (D1).
 */
export function dayTitle(t: number, d: DayStats | undefined, view: ViewOptions, partial: boolean): string {
  if (!d) return `${shortDate(t)}: no usage records`;
  const m = dayMetric(d, view);
  if (m.reported === 0) return `${shortDate(t)}: ${DASH} (${notReported(view)})${totalsPart(d)}`;
  return `${shortDate(t)}: ${withStar(fmtMetric(m, view), partial)}${unitSuffix(view)}${totalsPart(d)}`;
}

/** One row of a "Daily figures as a table" fold: undefined `value` = no record that day. */
export interface DayRow {
  label: string;
  value?: string;
  totals?: number;
}

/**
 * Per-day figures as a native fold holding a table (M7): keyboard and screen-reader
 * users can read every day the chart draws. No script; it closes on a re-render.
 */
export function dayTable(caption: string, unitHead: string, rows: DayRow[], summary = "Daily figures as a table"): string {
  if (rows.length === 0) return "";
  const body = rows
    .map((r) => {
      const v = r.value === undefined ? `<td class="muted">nothing logged</td>` : `<td class="num">${val(r.value)}</td>`;
      const n = r.value === undefined ? "<td></td>" : `<td class="num">${r.totals ?? 0}</td>`;
      return `<tr><th scope="row">${escapeHtml(r.label)}</th>${v}${n}</tr>`;
    })
    .join("");
  return `<details class="more daytable"><summary>${escapeHtml(summary)}</summary><div class="tablewrap" tabindex="0" role="region" aria-label="${escapeHtml(`${caption}, scrolls sideways`)}"><table><caption class="sr">${escapeHtml(caption)}</caption><thead><tr><th scope="col">Day</th><th scope="col">${escapeHtml(unitHead)}</th><th scope="col">Session totals</th></tr></thead><tbody>${body}</tbody></table></div></details>`;
}

function dayRow(t: number, d: DayStats | undefined, view: ViewOptions, partial: boolean): DayRow {
  if (!d) return { label: weekdayDate(t) };
  const m = dayMetric(d, view);
  return { label: weekdayDate(t), value: m.reported === 0 ? DASH : withStar(fmtMetric(m, view), partial), totals: d.sessionTotals };
}

function unitHead(view: ViewOptions): string {
  return view.unit === "cost" ? "USD (est.)" : "Tokens";
}

/**
 * A change against an earlier figure, never as a percent: "▲ 2.7×" when larger,
 * "▼ 4 in 10" (the share of the earlier figure) when smaller, "about the same"
 * within a tenth. Undefined when either side is unknown or zero.
 */
export function changeVs(cur: number | undefined, prior: number | undefined): { text: string; dir: "up" | "down" | "same" } | undefined {
  if (cur === undefined || prior === undefined || !(cur > 0) || !(prior > 0)) return undefined;
  const r = cur / prior;
  if (r >= 1) {
    const x = r >= 10 ? String(Math.round(r)) : r.toFixed(1);
    return x === "1.0" ? { text: "about the same", dir: "same" } : { text: `▲ ${x}×`, dir: "up" };
  }
  const n = Math.round(r * 10);
  if (n >= 10) return { text: "about the same", dir: "same" };
  return { text: n === 0 ? "▼ <1 in 10" : `▼ ${n} in 10`, dir: "down" };
}

/** Day start → that day's stats, plus the first day read (days before it are unknown). */
function activityIndex(s: Snapshot): { from: number | undefined; byDay: Map<number, DayStats> } {
  const byDay = new Map<number, DayStats>();
  for (const d of s.activity?.days ?? []) byDay.set(d.dayStartMs, d);
  return { from: s.activity?.fromMs, byDay };
}

function dayStart(base: number, back: number): number {
  return localDaysBefore(new Date(base), back);
}

function weekdayDate(ms: number): string {
  return `${WEEKDAYS[new Date(ms).getDay()]}, ${shortDate(ms)}`;
}

// ------------------------------------------------------------------ Today hero

/** The Today card: a large figure, calls and sessions, then Yesterday, the 7-day
 * average per active day and the change against yesterday; the heatmap and the ring beside. */
export function heroCard(s: Snapshot, view: ViewOptions): string {
  const partial = s.health.partial;
  const { from, byDay } = activityIndex(s);
  const today = s.today;
  const todayStats = byDay.get(s.dayStartMs);
  const fig = today ? withStar(headline(today, view), partial) : DASH;
  const parts = [unitWord(view)];
  if (today) {
    parts.push(callsPhrase(today.calls, today.callsMissing));
    if (todayStats) parts.push(plural(todayStats.sessions, "session"));
    if (today.sessionTotals > 0) parts.push(`includes ${plural(today.sessionTotals, "session total")}`);
  } else parts.push("no calls yet");

  // Yesterday: unknown before the history window; "Nothing logged yesterday" when it has no
  // record; "—" (not reported) when its records carry no figure in the unit (D1).
  const yStart = dayStart(s.dayStartMs, 1);
  const yRead = from !== undefined && yStart >= from;
  const y = yRead ? byDay.get(yStart) : undefined;
  const yVal = dayValue(y, view);
  const yText = y && yVal !== undefined ? withStar(fmtMetric(dayMetric(y, view), view), partial) : DASH;
  const yNote = !yRead
    ? "Yesterday is before the history window."
    : y && yVal === undefined
      ? `Yesterday has usage records, but ${notReported(view)}.${totalsPart(y)}`
      : y && y.sessionTotals > 0
        ? `Includes ${plural(y.sessionTotals, "session total")}.`
        : undefined;

  // 7-day average per active day over today and the 6 days before (not filtered).
  const wStart = dayStart(s.dayStartMs, 6);
  const week: number[] = [];
  for (const d of byDay.values()) {
    if (d.dayStartMs < wStart) continue;
    const v = dayValue(d, view);
    if (v !== undefined) week.push(v);
  }
  const { last7Short } = weekCoverage(s);
  const avgText = week.length > 0 ? withStar(fmtNum(week.reduce((a, b) => a + b, 0) / week.length, view), partial || last7Short) : DASH;
  const avgNote = `Average per active day over today and the 6 days before (${plural(week.length, "active day")}). Not filtered.`;

  const ch = yRead ? changeVs(headlineValue(today, view), yVal) : undefined;
  const chNote = ch
    ? "Today so far against all of yesterday. ▲ shows how many times larger; ▼ how many tenths of yesterday."
    : "No comparison: today or yesterday has nothing logged, or yesterday was not read.";

  const stat = (k: string, html: string, note: string | undefined, cls = "") =>
    `<div${cls ? ` class="${cls.trim()}"` : ""}${titleAttr(note)}><dt>${escapeHtml(k)}</dt><dd class="num">${html}</dd></div>`;
  const nothingYesterday = yRead && !y;
  const stats = nothingYesterday
    ? `${stat("Yesterday", `<span class="muted">Nothing logged yesterday</span>`, undefined, "span2")}${stat("7-day avg", val(avgText), avgNote)}`
    : `${stat("Yesterday", val(yText), yNote)}${stat("7-day avg", val(avgText), avgNote)}${stat("vs yesterday", ch ? `<span class="${ch.dir}">${sym(ch.text)}</span>` : val(DASH), chNote)}`;
  const filtered = s.filter ? `<small>not filtered</small>` : "";
  return `<section class="card hero" aria-labelledby="today-title">
<h3 id="today-title" class="ch">${icon("today")}<span>Today <span class="muted">(${escapeHtml(weekdayDate(s.dayStartMs))})</span></span>${filtered}</h3>
<div class="hero-grid">
<div class="hero-main"${titleAttr(today ? partialNote(headlineMetric(today, view)) : undefined)}>
<div class="big">${val(fig)}</div>
<div class="sub">${escapeHtml(parts.join(" · "))}</div>
<dl class="stats">${stats}</dl>
</div>
${heatmap(s, view)}
${cacheRing(s)}
</div>
</section>`;
}

// ------------------------------------------------------------------ heatmap

const CELL = 12;
const STEP = 15;
const LEFT = 30;
const TOP = 16;
/** Weeks the heatmap draws (design #3): the last 20, or fewer when the window is shorter. */
export const HEAT_WEEKS = 20;

/** Weekday rows (Monday first) × the last HEAT_WEEKS week columns of the history window;
 * the "N active days" count covers the whole window. */
export function heatmap(s: Snapshot, view: ViewOptions): string {
  const { from, byDay } = activityIndex(s);
  if (from === undefined) {
    return `<div class="hero-heat"><p class="lbl">Daily activity</p><p class="muted">No days read yet.</p></div>`;
  }
  const today = s.dayStartMs;
  const todayDow = (new Date(today).getDay() + 6) % 7;
  const capStart = dayStart(today, todayDow + 7 * (HEAT_WEEKS - 1));
  const first = Math.max(from, capStart);
  const firstDow = (new Date(first).getDay() + 6) % 7;
  const gridStart = dayStart(first, firstDow);
  const days: number[] = [];
  for (let i = 0; ; i++) {
    const t = localDaysBefore(new Date(first), -i);
    if (t > today) break;
    days.push(t);
  }
  // Whole-window count and scale: every day with a figure since the window opened.
  let activeAll = 0;
  for (const d of byDay.values()) {
    if (d.dayStartMs >= from && d.dayStartMs <= today && dayValue(d, view) !== undefined) activeAll++;
  }
  const values = days.map((d) => dayValue(byDay.get(d), view));
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const partial = s.health.partial;
  const weekOf = (t: number) => {
    // whole local days since the grid's Monday, DST-safe by rounding
    const n = Math.round((t - gridStart) / 86_400_000);
    return { col: Math.floor(n / 7), row: n % 7 };
  };
  const cols = weekOf(today).col + 1;
  const width = LEFT + cols * STEP;
  const height = TOP + 7 * STEP;
  const cells: string[] = [];
  const months: string[] = [];
  const rowsForTable: DayRow[] = [];
  let lastMonthCol = -3;
  let active = 0;
  let peak: { t: number; v: number } | undefined;
  days.forEach((t, i) => {
    const { col, row } = weekOf(t);
    const v = values[i];
    const d = byDay.get(t);
    const level = v !== undefined ? heatLevel(v, max) : 0;
    if (v !== undefined) {
      active++;
      if (!peak || v > peak.v) peak = { t, v };
    }
    if (d) rowsForTable.push(dayRow(t, d, view, partial));
    const now = t === today ? " now" : "";
    cells.push(`<rect class="hm h${level}${now}" x="${LEFT + col * STEP}" y="${TOP + row * STEP}" width="${CELL}" height="${CELL}" rx="2"><title>${escapeHtml(dayTitle(t, d, view, partial))}</title></rect>`);
    const date = new Date(t);
    if ((date.getDate() === 1 || i === 0) && col - lastMonthCol >= 3) {
      months.push(`<text class="ax" x="${LEFT + col * STEP}" y="11">${MONTHS[date.getMonth()]!.slice(0, 3)}</text>`);
      lastMonthCol = col;
    }
  });
  const rows = [
    [0, "Mon"],
    [2, "Wed"],
    [4, "Fri"],
  ].map(([r, l]) => `<text class="ax" x="0" y="${TOP + (r as number) * STEP + 10}">${l}</text>`);
  const peakText = peak ? `, busiest ${shortDate(peak.t)} (${fmtNum(peak.v, view)}${unitSuffix(view)})` : "";
  const since = first > from ? ` ${plural(activeAll, "active day")} since ${shortDate(from)}.` : "";
  const label = `Daily activity from ${shortDate(days[0]!)} to ${shortDate(today)}: ${active} of ${plural(days.length, "day")} active${peakText}.${since} Stronger colour means more ${view.unit === "cost" ? "estimated USD" : "tokens"}. Not filtered.`;
  const lblTitle = titleAttr(`Days with usage since ${shortDate(from)}, the start of the history window. The grid shows the last ${plural(cols, "week")}.`);
  const table = dayTable(`Days with usage records from ${shortDate(days[0]!)} to ${shortDate(today)}, not filtered`, unitHead(view), rowsForTable, "Active days as a table");
  return `<div class="hero-heat"><p class="lbl"${lblTitle}>Daily activity <b class="hot num">${plural(activeAll, "active day")}</b></p><svg class="heat" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(label)}">${months.join("")}${rows.join("")}${cells.join("")}</svg>${table}</div>`;
}

// ------------------------------------------------------------------ cache ring

/** Cache-read share of prompt tokens in the viewed month, as "N in 100" on a ring. */
export function cacheRing(s: Snapshot): string {
  const c = s.month?.cache;
  const month = viewedName(s);
  const known = c !== undefined && c.prompt.reported > 0 && c.prompt.sum > 0 && c.cacheRead.reported > 0;
  const share = known ? Math.min(1, c.cacheRead.sum / c.prompt.sum) : 0;
  const n = Math.round(100 * share);
  const shown = !known ? DASH : n === 0 && share > 0 ? "<1" : String(n);
  const R = 40;
  const len = 2 * Math.PI * R;
  const arc = known && share > 0 ? `<circle class="ring-fg" cx="50" cy="50" r="${R}" stroke-dasharray="${(len * share).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 50 50)"/>` : "";
  const label = known
    ? `Cache reuse in ${month}: ${shown} in 100 prompt tokens were cache reads${s.filter ? " (filtered)" : ""}.`
    : `Cache reuse in ${month}: not reported.`;
  const sub = known ? `<text class="ring-sub" x="50" y="68">in 100</text>` : "";
  return `<div class="hero-ring"${titleAttr("Prompt tokens that were read from the cache, over the viewed month's sessions. Higher reuse usually means cheaper calls.")}><p class="lbl">Cache reuse</p><svg class="ring" viewBox="0 0 100 100" width="96" height="96" role="img" aria-label="${escapeHtml(label)}"><circle class="ring-bg" cx="50" cy="50" r="${R}"/>${arc}<text class="ring-num" x="50" y="${known ? 54 : 58}">${escapeHtml(shown)}</text>${sub}</svg><p class="muted small">${escapeHtml(`of prompt tokens · ${month}`)}</p></div>`;
}

// ------------------------------------------------------------------ month to date

/** Running total of the viewed month by day, as a small line (0..1 in both axes). */
function sparkline(s: Snapshot, view: ViewOptions): string {
  const mv = s.month;
  if (!mv) return "";
  let run = 0;
  const pts: [number, number][] = [[0, 0]];
  for (let i = 0; i < mv.days.length; i++) {
    run += headlineValue(mv.days[i]!.totals, view) ?? 0;
    pts.push([i + 1, run]);
  }
  if (run <= 0) return "";
  const W = 120;
  const H = 40;
  // x runs over the days so far (the whole month for a past one), so the line fills the card
  const span = Math.max(1, mv.days.length);
  const xy = pts.map(([d, v]) => `${((W * d) / span).toFixed(1)},${(H - 2 - ((H - 4) * v) / run).toFixed(1)}`);
  const lastX = W.toFixed(1);
  const label = `Running total of ${viewedName(s)} by day: ${fmtNum(run, view)}${unitSuffix(view)} after ${plural(mv.days.length, "day")}${s.filter ? " (filtered)" : ""}.`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}"><path class="spark-area" d="M${xy.join(" L")} L${lastX},${H} L0,${H} Z"/><polyline class="spark-line" points="${xy.join(" ")}" vector-effect="non-scaling-stroke"/></svg>`;
}

/** Month to date (or a past month's total), its change against the month before at the
 * same point, and the target state; no projection (D23). */
export function monthCard(s: Snapshot, view: ViewOptions, extra: { cls: string; sub: string; note?: string; foot?: string }): string {
  const mv = s.month;
  const mt = mv?.totals;
  const partial = s.health.partial;
  const isCurrent = mv?.isCurrent !== false;
  const name = viewedName(s);
  const fig = mt ? withStar(headline(mt, view), partial) : DASH;
  const p = mv?.prior;
  const priorName = p ? MONTHS[new Date(p.monthStartMs).getMonth()]! : MONTHS[(new Date(mv?.monthStartMs ?? s.dayStartMs).getMonth() + 11) % 12]!;
  let compare: string;
  if (!p) {
    compare = isCurrent
      ? `<span class="muted">${escapeHtml(`Read 2 or more months (copilotUsageMonitor.historyMonths) to compare with ${priorName}.`)}</span>`
      : `<span class="muted">${escapeHtml(`${priorName} is outside the history window.`)}</span>`;
  } else {
    const when = isCurrent ? `${priorName} at this point` : priorName;
    const ch = changeVs(headlineValue(mt, view), headlineValue(p.totals, view));
    const TOKENS: ViewOptions = { unit: "tokens" };
    const priorTokens = headlineValue(p.totals, TOKENS);
    if (ch) compare = `<span class="delta ${ch.dir}">${sym(ch.text)}</span> <span class="muted">vs ${escapeHtml(when)}</span>`;
    else if (!p.totals) compare = `<span class="muted">${escapeHtml(`Nothing logged in ${when}.`)}</span>`;
    else if (view.unit === "cost" && headlineValue(p.totals, view) === undefined && priorTokens !== undefined && priorTokens > 0) {
      // The month before logged tokens but no cost (session totals without AI credits, say):
      // compare tokens instead of leaving a dead end (design #2).
      const tch = changeVs(headlineValue(mt, TOKENS), priorTokens);
      compare = tch
        ? `<span class="delta ${tch.dir}">${sym(`${tch.text} tokens`)}</span> <span class="muted">vs ${escapeHtml(when)}</span>`
        : `<span class="muted">${escapeHtml(`${priorName} logged tokens but no estimated USD.`)}</span>`;
    } else compare = `<span class="muted">${escapeHtml(`No comparison with ${when}.`)}</span>`;
  }
  const title = isCurrent ? "Month to date" : `${name} total`;
  const small = `${isCurrent ? name : "whole month"}${s.filter ? " · filtered" : ""}`;
  return `<section class="card mtd${extra.cls}" aria-labelledby="mtd-title"${titleAttr(extra.note)}>
<h3 id="mtd-title" class="ch">${icon("month")}<span>${escapeHtml(title)}</span><small>${escapeHtml(small)}</small></h3>
<div class="mtd-body"><div class="mtd-main"><div class="big">${val(fig)}</div><div class="cmp">${compare}</div><div class="sub">${escapeHtml(extra.sub)}</div>${extra.foot ?? ""}</div>${sparkline(s, view)}</div>
</section>`;
}

// ------------------------------------------------------------------ last 30 days

const BAR_DAYS = 30;

/** The last 30 days as bars (not filtered): a dashed average line, today in the
 * accent colour, a three-tick value scale, and Avg/day, Peak and Yesterday chips in the
 * card header; every day also as a table in a fold. */
export function dailyBars(s: Snapshot, view: ViewOptions): string {
  const { from, byDay } = activityIndex(s);
  const partial = s.health.partial;
  const heading = view.unit === "cost" ? "Daily USD (est.)" : "Daily tokens";
  const small = `last ${BAR_DAYS} days${s.filter ? " · not filtered" : ""}`;
  const h3 = `<h3 id="bars-title" class="ch">${icon("bars")}<span>${heading}</span><small>${escapeHtml(small)}</small></h3>`;
  if (from === undefined) {
    return `<section class="card bars" aria-labelledby="bars-title">${h3}<p class="muted">No days read yet.</p></section>`;
  }
  const days = Array.from({ length: BAR_DAYS }, (_, i) => dayStart(s.dayStartMs, BAR_DAYS - 1 - i));
  const values = days.map((t) => (t >= from ? dayValue(byDay.get(t), view) : undefined));
  const known = values.filter((v): v is number => v !== undefined);
  const top = Math.max(0, ...known);
  const scale = top > 0 ? top * 1.1 : 1;
  const W = BAR_DAYS * 10;
  const H = 100;
  const h = (v: number) => Math.max(1, (H * v) / scale);
  const bars: string[] = [];
  const tableRows: DayRow[] = [];
  let peakIdx = -1;
  values.forEach((v, i) => {
    if (v !== undefined && (peakIdx < 0 || v > values[peakIdx]!)) peakIdx = i;
  });
  days.forEach((t, i) => {
    const v = values[i];
    const d = t >= from ? byDay.get(t) : undefined;
    const title = t < from ? `${shortDate(t)}: before the history window` : dayTitle(t, d, view, partial);
    if (t >= from) tableRows.push(dayRow(t, d, view, partial));
    const cls = t === s.dayStartMs ? "dbar-today" : "dbar";
    const hit = `<rect class="bar-hit" x="${i * 10}" y="0" width="10" height="${H}"><title>${escapeHtml(title)}</title></rect>`;
    const bar = v !== undefined && v > 0 ? `<rect class="${cls}" x="${i * 10 + 1.5}" y="${(H - h(v)).toFixed(2)}" width="7" height="${h(v).toFixed(2)}" rx="1"/>` : "";
    bars.push(bar + hit);
  });
  if (known.length === 0) {
    return `<section class="card bars" aria-labelledby="bars-title">${h3}<p class="muted">Nothing logged in the last ${BAR_DAYS} days.</p></section>`;
  }
  const avg = known.reduce((a, b) => a + b, 0) / known.length;
  const avgY = (H - (H * avg) / scale).toFixed(2);
  const avgLine = `<line class="bar-avg" x1="0" x2="${W}" y1="${avgY}" y2="${avgY}" vector-effect="non-scaling-stroke"/>`;
  const yStart = dayStart(s.dayStartMs, 1);
  const y = yStart >= from ? byDay.get(yStart) : undefined;
  const yVal = dayValue(y, view);
  const yText = y && yVal !== undefined ? withStar(fmtMetric(dayMetric(y, view), view), partial) : DASH;
  const yNote = !y ? (yStart >= from ? "Nothing logged yesterday." : "Yesterday is before the history window.") : yVal === undefined ? `Yesterday has usage records, but ${notReported(view)}.` : "All of yesterday.";
  const peakT = days[peakIdx]!;
  const peakText = `${withStar(fmtNum(values[peakIdx]!, view), partial)} · ${shortDate(peakT)}`;
  const avgText = withStar(fmtNum(avg, view), partial);
  const chip = (k: string, v: string, note: string) => `<span class="kchip"${titleAttr(note)}>${escapeHtml(k)} <b class="num">${val(v)}</b></span>`;
  const chips = `<div class="kchips">${chip("Avg/day", avgText, `Average per active day: ${known.length} of the last ${BAR_DAYS} days had usage. The dashed line.`)}${chip("Peak", peakText, "The largest day of the last 30.")}${chip("Yesterday", yText, yNote)}</div>`;
  const read = days.filter((t) => t >= from).length;
  const todayV = values[BAR_DAYS - 1];
  const label = `${heading}, last ${BAR_DAYS} days: ${known.length} of ${plural(read, "day")} read had usage, average ${fmtNum(avg, view)} per active day, peak ${fmtNum(values[peakIdx]!, view)} on ${shortDate(peakT)}, today ${todayV !== undefined ? fmtNum(todayV, view) : byDay.has(s.dayStartMs) ? "not reported" : "nothing logged"}. Not filtered.`;
  const axis = days.map((t, i) => `<span>${i % 7 === 1 || i === BAR_DAYS - 1 ? escapeHtml(i === BAR_DAYS - 1 ? "Today" : shortDate(t)) : ""}</span>`).join("");
  const ticks = `<div class="yaxis" aria-hidden="true"><span class="num">${escapeHtml(fmtNum(scale, view))}</span><span class="num">${escapeHtml(fmtNum(scale / 2, view))}</span><span class="num">${escapeHtml(fmtNum(0, view))}</span></div>`;
  const fine = days[0]! < from ? `<div class="fine"><p>${escapeHtml(`Days before ${shortDate(from)} are outside the history window and have no bar.`)}</p></div>` : "";
  const table = dayTable(`${heading}, last ${BAR_DAYS} days, not filtered`, unitHead(view), tableRows);
  return `<section class="card bars" aria-labelledby="bars-title"><div class="chrow">${h3}${chips}</div><div class="plotgrid"><svg class="barplot" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}">${bars.join("")}${avgLine}</svg>${ticks}<div class="xaxis" aria-hidden="true">${axis}</div></div><div class="scale"><span class="lg"><b class="avgsw"></b>Avg / active day</span><span class="lg"><b class="todaysw"></b>Today</span></div>${fine}${table}</section>`;
}
