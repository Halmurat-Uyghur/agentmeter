// Renders the details panel as one static HTML string: no scripts, no remote
// resources, every dynamic string HTML-escaped. Missing values render "—",
// incomplete ones carry "*" plus a reason; a 0 appears only when logged.
import {
  formatAiu,
  formatCount,
  formatDuration,
  LOCAL_BANNER,
  NOT_COVERED,
  partialNote,
  STREAMING_NOTE,
} from "./format";
import { PANEL_CSS } from "./panelCss";
import { addMetrics, heatLevel, modelFamily } from "./store";
import type { Counts, Health, Metric, Snapshot, Totals } from "./types";

const DASH = "—";
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function topBar(s: Snapshot | undefined): string {
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
  return `<header class="top">
  <div><h1>Copilot Usage <span class="pill">Local</span></h1><div class="when">${escapeHtml(when)}</div></div>
  <div class="chips">${chips.join("")}</div>
</header>
<section class="note"><p>${escapeHtml(LOCAL_BANNER)}</p><p>${escapeHtml(STREAMING_NOTE)}</p></section>`;
}

function kpi(cls: string, name: string, sub: string, value: string, note?: string): string {
  return `<div class="kpi ${cls}"${titleAttr(note)}><div><div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(sub)}</div></div><div class="big">${val(value)}</div></div>`;
}

function kpis(s: Snapshot): string {
  const partial = s.health.partial;
  const today = s.today;
  const todayTok = today ? withStar(formatCount(tokens(today)), partial) : DASH;
  const todaySub = today ? `input + output tokens · ${plural(today.records, "call")}` : "input + output tokens · no calls yet";

  const cur = s.current;
  const curTok = cur?.totals ? withStar(formatCount(tokens(cur.totals)), partial) : DASH;
  const curSub = cur
    ? `${shortId(cur.folderId)} · ${cur.live ? "live" : "ended"}${cur.totals ? ` · ${plural(cur.totals.records, "call")}` : ""}`
    : "no session yet";

  const monthName = MONTHS[new Date(s.month?.monthStartMs ?? s.dayStartMs).getMonth()]!;
  const mt = s.month?.totals;
  const active = s.month?.days.filter((d) => d.totals !== undefined).length ?? 0;
  const monthTok = mt ? withStar(formatCount(tokens(mt)), partial) : DASH;
  let monthSub = `${plural(active, "active day")}`;
  if (mt && active > 0) {
    const t = tokens(mt);
    if (t.reported > 0) {
      const avg = formatCount({ sum: Math.round(t.sum / active), reported: t.reported, missing: t.missing });
      monthSub += ` · ${avg} per active day`;
    }
  }

  const aiuToday = today ? withStar(formatAiu(today.nanoAiu), partial) : DASH;
  const aiuMonth = mt ? withStar(formatAiu(mt.nanoAiu), partial) : DASH;

  return `<section class="kpis">
${kpi("k1", "Today", todaySub, todayTok, today ? partialNote(tokens(today)) : undefined)}
${kpi("k2", "Current session", curSub, curTok, cur?.totals ? partialNote(tokens(cur.totals)) : undefined)}
${kpi("k3", monthName, monthSub, monthTok, mt ? partialNote(tokens(mt)) : undefined)}
${kpi("k4", "AIU (as logged)", `today · ${monthName} ${aiuMonth}`, aiuToday, today ? partialNote(today.nanoAiu) : undefined)}
</section>`;
}

const TILE_FIELDS: [string, keyof Counts, (m: Metric) => string][] = [
  ["Input", "input", formatCount],
  ["Output", "output", formatCount],
  ["Cache read", "cacheRead", formatCount],
  ["Cache write", "cacheWrite", formatCount],
  ["Reasoning", "reasoning", formatCount],
  ["Model time", "durationMs", formatDuration],
  ["AIU (as logged)", "nanoAiu", formatAiu],
];

function tilesBox(title: string, badge: string, c: Counts | undefined, health: Health, footReasons: boolean): string {
  const tiles: string[] = [];
  const notes: string[] = [];
  for (const [label, key, fmt] of TILE_FIELDS) {
    const m = c ? (c[key] as Metric) : undefined;
    const text = m ? withStar(fmt(m), health.partial) : DASH;
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
  if (h.overlong > 0) parts.push(`${plural(h.overlong, "over-long line")} skipped`);
  return `Totals may be incomplete: ${parts.join("; ")}.`;
}

function modelTable(t: Totals | undefined, partial: boolean): string {
  const models = t ? Object.keys(t.byModel) : [];
  const total = t ? tokens(t).sum : 0;
  const rows = models
    .map((m) => ({ m, c: t!.byModel[m]! }))
    .sort((a, b) => tokens(b.c).sum - tokens(a.c).sum || a.m.localeCompare(b.m))
    .map(({ m, c }) => {
      const tok = tokens(c);
      const share = total > 0 && tok.reported > 0 ? Math.round((100 * tok.sum) / total) : 0;
      const fam = modelFamily(m);
      const cell = (x: string, note?: string) =>
        `<td class="num${x === DASH ? " muted" : ""}"${titleAttr(note)}>${val(withStar(x, partial))}</td>`;
      return `<tr><td><span class="chipm f-${fam}" title="${escapeHtml(m)}">${escapeHtml(m)}</span>${share > 0 ? `<span class="bar f-${fam}" style="width:${share}%"></span>` : ""}</td>${cell(formatCount(c.input), partialNote(c.input))}${cell(formatCount(c.output), partialNote(c.output))}${cell(formatCount(c.cacheRead), partialNote(c.cacheRead))}<td class="num sum"${titleAttr(partialNote(tok))}>${val(withStar(formatCount(tok), partial))}</td>${cell(formatAiu(c.nanoAiu), partialNote(c.nanoAiu))}<td class="num">${c.records}</td></tr>`;
    });
  const body = rows.length
    ? `<div class="tablewrap"><table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Tokens</th><th>AIU</th><th>Calls</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<p class="muted">No per-call records dated today.</p>`;
  return `<section class="box"><h2>Today by model<small>${plural(models.length, "model")}</small></h2>${body}<div class="fine">Bar = share of today's input + output tokens. "—" means the log did not report the value; it is never shown as 0.</div></section>`;
}

function calendar(s: Snapshot): string {
  const anchor = new Date(s.month?.monthStartMs ?? s.dayStartMs);
  const y = anchor.getFullYear();
  const mo = anchor.getMonth();
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const lead = (new Date(y, mo, 1).getDay() + 6) % 7;
  const days = s.month?.days ?? [];
  const values = days.map((d) => (d.totals ? tokens(d.totals) : undefined));
  const max = Math.max(0, ...values.map((v) => (v && v.reported > 0 ? v.sum : 0)));
  const todayNum = new Date(s.dayStartMs).getDate();
  const sameMonth = new Date(s.dayStartMs).getMonth() === mo;

  const cells: string[] = DOW.map((d) => `<div class="dow">${d}</div>`);
  for (let i = 0; i < lead; i++) cells.push(`<div class="d pad"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const v = values[day - 1];
    const known = day <= days.length;
    if (!known) {
      cells.push(`<div class="d later">${day}</div>`);
      continue;
    }
    const text = v ? withStar(formatCount(v), s.health.partial) : DASH;
    const level = v && v.reported > 0 ? heatLevel(v.sum, max) : 0;
    const now = sameMonth && day === todayNum ? " now" : "";
    const title = v ? `${text} tokens${text.endsWith("*") ? " (may be incomplete)" : ""}` : "No usage records";
    cells.push(`<div class="d${level ? ` h${level}` : ""}${now}" title="${escapeHtml(title)}">${day}<small>${val(text)}</small></div>`);
  }
  const mt = s.month?.totals;
  const swatches = [0, 1, 2, 3, 4]
    .map((l) => `<b class="${l ? `h${l}` : ""}"></b>`)
    .join("");
  return `<section class="box"><h2>Daily tokens — ${MONTHS[mo]} ${y}<small>input + output</small></h2><div class="month">${cells.join("")}</div><div class="scale"><span>Less<span class="sw month-sw">${swatches}</span>More</span><span>Month so far: <b class="num">${val(mt ? withStar(formatCount(tokens(mt)), s.health.partial) : DASH)}</b> tokens · <b class="num">${val(mt ? withStar(formatAiu(mt.nanoAiu), s.health.partial) : DASH)}</b> AIU (as logged)</span></div></section>`;
}

function healthBox(s: Snapshot): string {
  const h = s.health;
  const fact = (k: string, v: number, warn = false) =>
    `<div class="fact"><span>${escapeHtml(k)}</span><span class="num${warn && v > 0 ? " star" : ""}">${v}</span></div>`;
  return `<section class="box"><h2>Data health<small>read-only · nothing leaves this computer</small></h2><div class="facts">
${fact("Sessions this month", s.sessions.length)}
${fact("Unreadable logs", h.unreadableFiles, true)}
${fact("Sessions without per-call data", h.sessionsWithoutUsage)}
${fact("Lines in an unknown format", h.unrecognized, true)}
${fact("Malformed lines", h.malformed, true)}
${fact("Over-long lines skipped", h.overlong, true)}
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
export function renderPanelHtml(s: Snapshot | undefined, cspSource: string): string {
  if (!s) return page(`${topBar(undefined)}<p class="muted">Loading…</p>`, cspSource);
  const badge = s.current
    ? `${shortId(s.current.folderId)} · ${s.current.live ? "live" : "ended"}${s.current.pinned ? " · pinned" : ""}`
    : "none";
  const body = `${topBar(s)}
${stateNote(s.health)}
${kpis(s)}
<div class="cols">
<div>
${tilesBox("Today in detail", "8 metrics", s.today, s.health, true)}
${tilesBox("Current session", badge, s.current?.totals, s.health, false)}
</div>
<div>
${modelTable(s.today, s.health.partial)}
${calendar(s)}
</div>
</div>
${healthBox(s)}`;
  return page(body, cspSource);
}
