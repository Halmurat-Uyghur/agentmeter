// Daily (D32): today in detail (current month), the daily bars and the
// calendar. Session totals are counted on the day their session ended.
import { costLabel, estWord, formatCount, formatUsd, money, SESSION_TOTAL_NOTE } from "../format";
import { dayTable, notReported, type DayRow } from "./dashboard";
import { heatLevel } from "../store";
import type { Metric, Snapshot, Totals, ViewOptions } from "../types";
import {
  card,
  DASH,
  DOW,
  escapeHtml,
  headlineMetric,
  headlineValue,
  MONTHS,
  plural,
  shortDate,
  tilesBox,
  titleAttr,
  tokens,
  unitWord,
  val,
  viewedName,
  withStar,
} from "./shared";

/** " (includes 1 session total)" for a day's title, or "". */
function includesTotals(t: Totals | undefined): string {
  const n = t?.sessionTotals ?? 0;
  return n > 0 ? ` (includes ${plural(n, "session total")})` : "";
}

/** A day's hover text: "no usage records" only without a record; "— (… not reported)"
 * when its records carry no figure in the unit (D1). */
function dayTip(dayStartMs: number, m: Metric | undefined, text: string, word: string, view: ViewOptions, t: Totals | undefined): string {
  const date = shortDate(dayStartMs);
  if (!m) return `${date}: no usage records`;
  if (m.reported === 0) return `${date}: ${DASH} (${notReported(view)})${includesTotals(t)}`;
  return `${date}: ${text}${word}${text.endsWith("*") ? " (may be incomplete)" : ""}${includesTotals(t)}`;
}

/**
 * Daily bars for the viewed month (honours the filter, like the calendar),
 * with a dashed line at the average over days that have records. Days after
 * today render as empty slots. Bars carry no link: there is no day view.
 */
export function dailyTrend(s: Snapshot, view: ViewOptions): string {
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
  const fmt = (m: Metric) => (view.unit === "cost" ? formatUsd(m) : formatCount(m));
  const fmtNum = (n: number) => (view.unit === "cost" ? money(n) : formatCount({ sum: Math.round(n), reported: 1, missing: 0 }));
  const word = view.unit === "cost" ? ` ${costLabel()}` : " tokens";
  const todayStart = s.dayStartMs;

  let peakIdx = -1;
  values.forEach((v, i) => {
    if (v !== undefined && (peakIdx < 0 || v > values[peakIdx]!)) peakIdx = i;
  });

  const cols: string[] = [];
  const rows: DayRow[] = [];
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
    rows.push(m ? { label: shortDate(d.dayStartMs), value: text, totals: d.totals?.sessionTotals ?? 0 } : { label: shortDate(d.dayStartMs) });
    cols.push(`<span class="col${now}" title="${escapeHtml(dayTip(d.dayStartMs, m, text, word, view, d.totals))}"><span class="track">${bar}</span><span class="m">${label}</span></span>`);
  }

  const title = "Daily trend";
  const small = `${MONTHS[mo]} ${y}`;
  if (active.length === 0) {
    return card("trend-title", "bars", title, small, `<p class="muted">${escapeHtml(`No usage logged in ${viewedName(s)}${s.filter ? " for this filter" : ""}.`)}</p>`);
  }
  const avg = active.reduce((a, b) => a + b, 0) / active.length;
  const avgLine = `<span class="avgwrap"><span class="avg" style="bottom:${pct(avg)}%" title="${escapeHtml(`Average per active day: ${fmtNum(avg)}${word}`)}"></span></span>`;
  const peakDay = mv.days[peakIdx]!;
  const peakMetric = headlineMetric(peakDay.totals!, view);
  const partial = s.health.partial;
  const filtered = s.filter ? " · filtered" : "";
  const summary = `${MONTHS[mo]}: ${active.length} of ${plural(mv.days.length, "day")} active, average ${withStar(fmtNum(avg), partial)}${word} per active day, peak ${withStar(fmt(peakMetric), partial)} on ${shortDate(peakDay.dayStartMs)}`;
  const stats = `<span class="lg"><b class="avgsw"></b>Avg / active day <b class="num">${val(withStar(fmtNum(avg), partial))}</b></span><span>Peak <b class="num">${val(withStar(fmt(peakMetric), partial))}</b> on ${escapeHtml(shortDate(peakDay.dayStartMs))} · ${active.length} of ${plural(mv.days.length, "day")} active</span>`;
  const table = dayTable(`Daily ${view.unit === "cost" ? estWord() : "tokens"}, ${MONTHS[mo]} ${y}${s.filter ? ", filtered" : ""}`, view.unit === "cost" ? costLabel() : "Tokens", rows);
  return card(
    "trend-title",
    "bars",
    title,
    `${small} · ${unitWord(view)}${filtered}`,
    `<div class="trend daily" role="img" aria-label="${escapeHtml(summary)}"><div class="plot">${avgLine}${cols.join("")}</div></div><div class="scale">${stats}</div>${table}`,
  );
}

export function calendar(s: Snapshot, view: ViewOptions): string {
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
  const fmt = (m: Metric) => (view.unit === "cost" ? formatUsd(m) : formatCount(m));
  const word = view.unit === "cost" ? estWord() : "tokens";

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
    const isToday = sameMonth && day === todayNum;
    const title = dayTip(days[day - 1]!.dayStartMs, m, text, ` ${word}`, view, days[day - 1]!.totals);
    // A day with no record stays blank (design #7); the title still says so.
    const shown = m ? val(text) : `<span class="sr">no usage records</span>`;
    cells.push(`<div class="d${level ? ` h${level}` : ""}${isToday ? " now" : ""}" title="${escapeHtml(title)}">${day}${isToday ? `<span class="sr"> (today)</span>` : ""}<small>${shown}</small></div>`);
  }
  const mt = s.month?.totals;
  const swatches = [0, 1, 2, 3, 4].map((l) => `<b class="${l ? `h${l}` : ""}"></b>`).join("");
  const heading = view.unit === "cost" ? `Daily ${costLabel()}` : "Daily tokens";
  const sub = view.unit === "cost" ? "logged AI credits × $0.01" : "input + output";
  const so = s.month?.isCurrent === false ? "Month total" : "Month so far";
  return card(
    "calendar-title",
    "daily",
    heading,
    `${MONTHS[mo]} ${y} · ${sub}`,
    `<div class="month">${cells.join("")}</div><div class="scale"><span>Less<span class="sw month-sw" aria-hidden="true">${swatches}</span>More</span><span>${so}: <b class="num">${val(mt ? withStar(formatCount(tokens(mt)), s.health.partial) : DASH)}</b> tokens · <b class="num">${val(mt ? withStar(formatUsd(mt.nanoAiu), s.health.partial) : DASH)}</b> ${escapeHtml(costLabel())}</span></div>`,
  );
}

export function renderDaily(s: Snapshot, view: ViewOptions): string {
  const isCurrent = s.month?.isCurrent !== false;
  const today = isCurrent ? tilesBox("Today in detail", "9 metrics", s.today, s.health, true, s.today ? "" : `<p class="muted">Nothing logged today yet.</p>`, "today") : "";
  const n = s.month?.totals?.sessionTotals ?? 0;
  // Once per section (design #1): one sentence, the full O3 note in its title.
  const foot = n > 0
    ? `<div class="fine"${titleAttr(SESSION_TOTAL_NOTE)}><p>${escapeHtml(`${viewedName(s)} includes ${plural(n, "session total")}: each is counted on the day its session ended, so that day can look larger than the work done on it.`)}</p></div>`
    : "";
  return `${today}\n${dailyTrend(s, view)}\n${calendar(s, view)}${foot}`;
}
