// Overview (D32, laid out by A2): the Today hero (with the activity heatmap and the
// cache-reuse ring), Month to date (with the target state), Last 7 days and the
// current session, the last 30 days as bars, then the monthly trend.
import { costLabel, formatCount, formatRange, formatUsd, mixedSources, multiSource, notLiveWord, partialNote, PRIOR_SHORT_NOTE, rangeLabel, rangeWord, SESSION_TOTAL_NOTE, spoken, targetStatus, usd, WEEK_SHORT_NOTE, weekChange, weekCoverage } from "../format";
import { type MonthSummary, type Snapshot, SOURCE_LABEL, type ViewOptions } from "../types";
import { dailyBars, heroCard, monthCard } from "./dashboard";
import { icon, type IconName } from "./icons";
import { commandHref } from "./links";
import { renderSourcesCard } from "./sources";
import {
  callsPhrase,
  DASH,
  escapeHtml,
  headline,
  headlineMetric,
  headlineValue,
  monthKey,
  MONTHS,
  monthTitle,
  plural,
  shortId,
  sym,
  titleAttr,
  unitWord,
  val,
  viewedName,
  withStar,
  scopeSentence,
} from "./shared";

/** A small card laid out like Month to date (design #10): the title row, the figure,
 * then a muted line of context. */
function kpi(cls: string, ic: IconName, name: string, sub: string, value: string, note?: string, state = ""): string {
  const id = `${cls}-title`;
  return `<section class="card kpi ${cls}${state ? ` st-${state}` : ""}" aria-labelledby="${id}"${titleAttr(note)}><h3 id="${id}" class="ch">${icon(ic)}<span>${escapeHtml(name)}</span></h3><div class="big">${val(value)}</div><div class="sub">${sym(sub)}</div></section>`;
}

function kpis(s: Snapshot, view: ViewOptions): string {
  const partial = s.health.partial;
  const cur = s.current;
  const curVal = cur?.totals ? withStar(headline(cur.totals, view), partial) : DASH;
  const curSub = cur
    ? `${shortId(cur.folderId)} · ${cur.live ? "live" : notLiveWord(cur.source)}${cur.totals ? ` · ${callsPhrase(cur.totals.calls, cur.totals.callsMissing)}` : ""}`
    : s.sourceScope
      ? `no ${SOURCE_LABEL[s.sourceScope.source]} session yet`
      : "no session yet";

  // When the history window starts inside the two weeks, the figure is starred and no change is shown.
  const w = s.last7;
  const { last7Short, prior7Short } = weekCoverage(s);
  const wVal = w ? withStar(headline(w, view), partial || last7Short) : DASH;
  const change = weekChange(headlineValue(w, view), headlineValue(s.prior7, view), !prior7Short);
  let wSub = change ? change.charAt(0).toUpperCase() + change.slice(1) : "Nothing logged";
  const wNotes = [
    `Today and the 6 days before it, against the 7 days before that. ${scopeSentence(s)}`,
    last7Short ? WEEK_SHORT_NOTE : prior7Short ? PRIOR_SHORT_NOTE : undefined,
  ];
  // The weekly target (v0.9): the last 7 days' estimated USD against weeklyTargetMax.
  let wState = "";
  if (view.weekTarget) {
    // Under another source, the unfiltered 7 days: the target compares Copilot's logged cost.
    const st = targetStatus(s.targetBasis ? s.targetBasis.last7 : w, view.weekTarget, s.health);
    wState = st.state;
    wSub += ` · Weekly target ${formatRange(view.weekTarget)}${s.targetBasis || mixedSources(w?.sources) ? " (Copilot only)" : ""}: ${rangeWord(st)}`;
    wNotes.unshift(rangeLabel(st));
  }
  const wNote = wNotes.filter(Boolean).join(" ");

  const monthName = viewedName(s);
  const mt = s.month?.totals;
  const active = s.month?.days.filter((d) => d.totals !== undefined).length ?? 0;
  let monthSub = plural(active, "active day");
  const monthTotals = mt?.sessionTotals ?? 0;
  if (monthTotals > 0) monthSub += ` · ${plural(monthTotals, "session total")}`;
  if (mt && active > 0) {
    const t = headlineMetric(mt, view);
    if (t.reported > 0) {
      const avg = { sum: t.sum / active, reported: t.reported, missing: t.missing };
      const avgText = view.unit === "cost" ? formatUsd(avg) : formatCount({ ...avg, sum: Math.round(avg.sum) });
      monthSub += ` · ${avgText} per active day`;
    }
  }
  let monthCls = "";
  const monthNotes = [mt ? partialNote(headlineMetric(mt, view)) : undefined];
  if (view.range) {
    // The target state of the viewed month, spent so far in estimated USD.
    const st = targetStatus(mt, view.range, s.health);
    monthCls += ` st-${st.state}`;
    monthSub += ` · Target ${formatRange(view.range)}${mixedSources(mt?.sources) ? " (Copilot only)" : ""}: ${rangeWord(st)}`;
    monthNotes.unshift(rangeLabel(st));
  }

  const empty = mt
    ? ""
    : `<p class="muted">${escapeHtml(
        multiSource(s.health) || s.filter?.source !== undefined
          ? `No usage logged in ${monthName}${s.filter ? " for this filter" : ""}. Figures appear here after a model call finishes, or when an older Copilot session ends.`
          : `No Copilot usage logged in ${monthName}${s.filter ? " for this filter" : ""}. Figures appear here after Copilot finishes a model call, or when an older Copilot session ends.`,
      )}</p>`;
  // The session-total explanation appears once per section (design #1): a short footnote
  // whose title holds the full O3 text.
  const totalsNote =
    monthTotals > 0
      ? `<div class="fine"${titleAttr(SESSION_TOTAL_NOTE)}><p>${escapeHtml(`${monthName} includes ${plural(monthTotals, "session total")} (older Copilot; each counted on the day it ended).`)}</p></div>`
      : "";
  return `<div class="row2">
${monthCard(s, view, { cls: monthCls, sub: monthSub, note: monthNotes.filter(Boolean).join(" ") || undefined })}
${kpi("k3", "week", "Last 7 days", wSub, wVal, wNote, wState)}
${kpi("k2", "session", "Current session", curSub, curVal, cur?.totals ? partialNote(headlineMetric(cur.totals, view)) : undefined)}
</div>${empty}${totalsNote}`;
}

const STATE_MARK = { under: "▼", in: "✓", over: "▲", unknown: "?" } as const;

/** Monthly bars over the history window; each bar opens that month (D21). */
export function trend(s: Snapshot, view: ViewOptions): string {
  const hist: MonthSummary[] = s.history ?? [];
  if (hist.length === 0) return "";
  const viewed = s.month?.monthStartMs;
  const values = hist.map((h) => headlineValue(h.totals, view));
  const range = view.unit === "cost" ? view.range : undefined;
  // The target compares Copilot's logged USD only (D46, v0.10): say so when other sources are in scope.
  const only = mixedSources(s.month?.totals?.sources) ? " (Copilot only)" : "";
  const top = Math.max(0, ...values.map((v) => v ?? 0), range?.max ?? 0, range?.min ?? 0);
  const scale = top > 0 ? top * 1.08 : 1;
  const pct = (v: number) => Math.max(0, Math.min(100, (100 * v) / scale)).toFixed(1);
  const fmt = (m: Parameters<typeof formatUsd>[0]) => (view.unit === "cost" ? formatUsd(m) : formatCount(m));

  const cols = hist.map((h, i) => {
    const v = values[i];
    const m = h.totals ? headlineMetric(h.totals, view) : undefined;
    const text = m ? withStar(fmt(m), s.health.partial) : DASH;
    const st = range ? targetStatus(h.totals, range, s.health) : { state: "none" as const, partial: false };
    const state = st.state;
    const d = new Date(h.monthStartMs);
    const label = MONTHS[d.getMonth()]!.slice(0, 3) + (d.getMonth() === 0 || i === 0 ? ` ${String(d.getFullYear()).slice(2)}` : "");
    const isSel = h.monthStartMs === viewed;
    const bar = v !== undefined && v > 0 ? `<span class="fill st-${state}" style="height:${pct(v)}%"></span>` : "";
    // A month with no record shows nothing above its bar (design #7); "—" is for a month
    // whose records carry no figure in the unit.
    const said = !h.totals ? "nothing logged" : view.unit === "cost" ? spoken(text === DASH ? text : `${text} est.`) : `${spoken(text)}${text === DASH ? "" : " tokens"}`;
    const title = `${monthTitle(h.monthStartMs)}: ${h.totals ? `${text}${view.unit === "cost" ? ` ${costLabel()}` : " tokens"}` : "no usage records"}${range ? ` · ${rangeLabel(st)}` : ""}`;
    const aria = `${monthTitle(h.monthStartMs)}: ${said}${range ? `, ${spoken(rangeLabel(st))}` : ""}${isSel ? ", viewing" : ""}`;
    // A visible mark beside the month (never colour alone, M2): ▲ over, ✓ in range, ▼ under.
    const mark = range && state !== "none" ? ` ${STATE_MARK[state]}` : "";
    const shown = h.totals ? `<span aria-hidden="true">${text.endsWith("*") ? `${escapeHtml(text.slice(0, -1))}<span class="star">*</span>` : escapeHtml(text)}</span>` : "";
    return `<li><a class="col${isSel ? " sel" : ""}" href="${escapeHtml(commandHref("copilotUsageMonitor.selectMonth", monthKey(h.monthStartMs)))}" aria-label="${escapeHtml(aria)}"${isSel ? ' aria-current="true"' : ""} title="${escapeHtml(title)}"><span class="v">${shown}</span><span class="track" aria-hidden="true">${bar}</span><span class="m" aria-hidden="true">${escapeHtml(label + mark)}</span></a></li>`;
  });

  let band = "";
  if (range) {
    const lo = range.min ?? 0;
    const hi = range.max ?? scale;
    band = `<span class="band" style="bottom:${pct(lo)}%;height:${(Number(pct(hi)) - Number(pct(lo))).toFixed(1)}%" title="${escapeHtml(`Target ${formatRange(range)}${only}`)}"></span>`;
  }
  // "?" (not compared) is listed only when a month in the window has records but no logged amount.
  const anyUnknown = range !== undefined && hist.some((h) => targetStatus(h.totals, range, s.health).state === "unknown");
  const unknownLg = anyUnknown ? ` <b class="st-unknown"></b>${STATE_MARK.unknown} Not compared` : "";
  const legend = range
    ? `<span class="lg"><b class="st-under"></b>${STATE_MARK.under} Under <b class="st-in"></b>${STATE_MARK.in} In range <b class="st-over"></b>${STATE_MARK.over} Over${unknownLg} <b class="bandsw"></b>Target ${escapeHtml(formatRange(range) + only)}</span>`
    : `<span class="lg">${view.unit === "cost" ? "Set copilotUsageMonitor.monthlyTargetMin / Max to see a target band." : `Switch to ${costLabel()} to compare against a target.`}</span>`;
  const filtered = s.filter ? " · filtered" : "";
  return `<section class="card" aria-labelledby="trend-title"><h3 id="trend-title" class="ch">${icon("trend")}<span>Monthly trend</span><small>${plural(hist.length, "month")} · ${escapeHtml(unitWord(view))}${filtered} · click a month to open it</small></h3><div class="trend"><div class="plot">${band}<ol class="tcols" role="list" aria-label="Months, oldest first">${cols.join("")}</ol></div></div><div class="scale">${legend}</div></section>`;
}

export function renderOverview(s: Snapshot, view: ViewOptions): string {
  const sources = renderSourcesCard(s, view);
  return `${heroCard(s, view)}\n${kpis(s, view)}\n${sources ? `${sources}\n` : ""}${dailyBars(s, view)}\n${trend(s, view)}`;
}
