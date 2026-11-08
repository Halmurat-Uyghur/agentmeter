// Shared chrome on every section (D30): document, header, banner, state note,
// the month / unit / filter toolbar and the section nav. Scripts stay off; the
// only links are allowlisted command URIs plus the skip link to #main.
import { costLabel, costNotes, estWord, formatChangedSentence, homeSettings, LOADING_NOTE, PERMISSION_NOTE, LOCAL_BANNER, mixedSources, multiSource, notLiveWord, readingLine, STREAMING_NOTE } from "../format";
import { PANEL_CSS } from "../panelCss";
import { type Health, isSource, type Snapshot, SOURCE_LABEL, type ViewOptions } from "../types";
import { icon, logo } from "./icons";
import { commandHref, filterHref, navToggleHref, sectionHref } from "./links";
import { SECTION_DEFS, type SectionDef, type SectionId } from "./sections";
import { sourceOrigins } from "./sources";
import { clock, escapeHtml, monthKey, monthTitle, plural, projectLabel, viewedStart } from "./shared";

export function page(body: string, cspSource: string, sectionLabel: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)} 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(sectionLabel)} · Copilot Usage (Local)</title>
<style>${PANEL_CSS}</style>
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>`;
}

function rootLabel(h: Health): string {
  return h.rootSource === "setting" ? "Folder: setting" : h.rootSource === "env" ? "Folder: COPILOT_HOME" : "Folder: default";
}

/** The full provenance text (design #4): the local-only banner, the streaming note and,
 * in cost view, the estimate notes (with the Copilot-only note when sources mix). Inside the
 * fold on every section; Data health lays it out openly in its own content (renderHealth). */
export function aboutText(view: ViewOptions, mixed = false): string {
  const costNote = view.unit === "cost" ? costNotes(view, mixed).map((n) => `<p>${escapeHtml(n)}</p>`).join("") : "";
  return `<p>${escapeHtml(LOCAL_BANNER)}</p><p>${escapeHtml(STREAMING_NOTE)}</p>${costNote}`;
}

/** One muted line plus a native fold with the full text. The same markup on every section:
 * the chrome above the month bar must not change height with the section, or the month
 * bar, the section nav and the content move when the reader clicks to another section. */
function aboutNote(view: ViewOptions, mixed = false): string {
  const line = `Local logs on this computer only${view.unit === "cost" ? " · cost is an estimate" : ""} · updates after each model call`;
  return `<section class="about" aria-label="About these figures"><span class="muted">${escapeHtml(line)}</span><details class="more"><summary>About these figures</summary><div class="aboutbody">${aboutText(view, mixed)}</div></details></section>`;
}

export function topBar(s: Snapshot | undefined, view: ViewOptions): string {
  const chips: string[] = [];
  if (s) {
    if (s.current) {
      const c = s.current;
      const state = c.live ? "live" : notLiveWord(c.source);
      chips.push(`<span class="chip${c.live ? " live" : ""}"><i></i>Current session ${state}${c.pinned ? " (pinned)" : ""}</span>`);
    }
    if (s.health.partial)
      chips.push(`<span class="chip warn" title="Some logs or lines could not be read; figures marked * may be incomplete."><i></i>Partial data</span>`);
    if (s.health.state === "format-changed") chips.push(`<span class="chip warn"><i></i>Format changed</span>`);
    const origins = sourceOrigins(s);
    chips.push(`<span class="chip">${escapeHtml(origins ? `Folders: ${origins}` : rootLabel(s.health))}</span>`);
  }
  const reading = s ? readingLine(s.health) : undefined;
  const when = !s ? LOADING_NOTE : reading ?? `Last change ${clock(s.generatedAtMs)} · day starts at local midnight`;
  return `<header class="top">
  <div><h1 class="wordmark">${logo()}<span class="wm">Copilot Usage</span> <span class="pill">Local</span></h1><div class="when">${escapeHtml(when)}</div></div>
  <div class="chips">${chips.join("")}</div>
</header>
${aboutNote(view, mixedSources(s?.month?.totals?.sources))}`;
}

/** Not role="alert": the page re-renders after every model call and would re-announce (O3). */
export function stateNote(h: Health): string {
  const box = (text: string) => `<section class="note alert" aria-labelledby="problem-title"><h2 id="problem-title" class="sr">Problem reading logs</h2><p>${text}</p></section>`;
  const settings = (all: boolean) => homeSettings(h, all).split(/(copilotUsageMonitor\.\w+)/).map((x, i) => (i % 2 ? `<b>${escapeHtml(x)}</b>` : escapeHtml(x))).join("");
  if (h.state === "no-dir" && multiSource(h))
    return box(`No usage logs were found. Set ${settings(false)} if a tool keeps its logs somewhere other than its default folder.`);
  if (h.state === "no-dir")
    return box(`No Copilot session logs were found. Set <b>copilotUsageMonitor.copilotHome</b> if Copilot keeps them somewhere other than COPILOT_HOME or the default folder in your home directory.`);
  if (h.state === "permission") return box(`${escapeHtml(PERMISSION_NOTE)} Check the folder's permissions, or set ${settings(true)}.`);
  if (h.state === "format-changed")
    return box(escapeHtml(`${h.unrecognized > 0 ? `${plural(h.unrecognized, "line")} in a format this version doesn't recognize. ` : ""}${formatChangedSentence(h)}, so figures may be incomplete.`));
  return "";
}

/** Filter chips, month navigation and the tokens / cost switch: the same on every section. */
export function toolbar(s: Snapshot, view: ViewOptions): string {
  const viewed = viewedStart(s);
  const starts = (s.history ?? []).map((h) => h.monthStartMs);
  const i = starts.indexOf(viewed);
  // `label` is escaped like every other string (security note 5); `aria` names a glyph
  // control in words (m4), and a disabled one says why in screen-reader text.
  const link = (cls: string, label: string, href: string | undefined, title: string, aria?: { on: string; off: string }) => {
    const shown = aria ? `<span aria-hidden="true">${escapeHtml(label)}</span>` : escapeHtml(label);
    return href
      ? `<a class="${cls}" href="${escapeHtml(href)}" title="${escapeHtml(title)}"${aria ? ` aria-label="${escapeHtml(aria.on)}"` : ""}>${shown}</a>`
      : `<span class="${cls} off">${shown}${aria ? `<span class="sr">${escapeHtml(aria.off)}</span>` : ""}</span>`;
  };
  const prev = i > 0 ? commandHref("copilotUsageMonitor.selectMonth", monthKey(starts[i - 1]!)) : undefined;
  const next = i >= 0 && i < starts.length - 1 ? commandHref("copilotUsageMonitor.selectMonth", monthKey(starts[i + 1]!)) : undefined;
  const isCurrent = s.month?.isCurrent !== false;
  const back = isCurrent ? "" : link("btn", "This month", commandHref("copilotUsageMonitor.selectMonth", "current"), "Back to the current month");
  const pick = link("btn", "Pick month…", commandHref("copilotUsageMonitor.selectMonth", "pick"), "Choose a month from the history window");
  const unit = (u: ViewOptions["unit"], label: string) =>
    view.unit === u
      ? `<span class="seg on">${label}<span class="sr"> (selected)</span></span>`
      : link("seg", label, commandHref("copilotUsageMonitor.setUnit", u), `Show ${u === "cost" ? estWord() : "tokens"}`);
  const f = s.filter;
  const chip = (kind: "project" | "tool" | "source", label: string, value: string) =>
    `<a class="fchip" href="${escapeHtml(filterHref(kind, ""))}" title="Clear this filter" aria-label="${escapeHtml(`Clear ${kind} filter: ${value}`)}">${escapeHtml(label)}: <b>${escapeHtml(value)}</b><span aria-hidden="true"> ✕</span></a>`;
  const filters = f
    ? `<div class="filters"><span class="muted">Filtered month view, trend and tables:</span>${f.project !== undefined ? chip("project", "Project", projectLabel(s, f.project)) : ""}${f.tool !== undefined ? chip("tool", "Tool", f.tool) : ""}${isSource(f.source) ? chip("source", "Source", SOURCE_LABEL[f.source]) : ""}<span class="muted">Today, the last 7 days, daily activity and the status bar are not filtered.</span></div>`
    : "";
  return `<div class="toolbar" role="group" aria-label="Month, unit and filter">${filters}<div class="nav">
  <div class="months">${link("btn", "‹", prev, "Previous month", { on: "Previous month", off: "No earlier month" })}<b>${escapeHtml(monthTitle(viewed))}</b>${link("btn", "›", next, "Next month", { on: "Next month", off: "No later month" })}${back}${pick}</div>
  <div class="unit">${unit("tokens", "Tokens")}${unit("cost", escapeHtml(costLabel()))}</div>
</div></div>`;
}

/** Text after a nav label (never colour only): the Insights count, a Data health mark. */
function navExtra(s: Snapshot | undefined, id: SectionId): string {
  if (!s) return "";
  if (id === "insights") {
    const n = s.month?.insights?.items.length ?? 0;
    return n > 0 ? `<span class="cnt num" aria-hidden="true"> · ${n}</span><span class="sr"> (${plural(n, "finding")})</span>` : "";
  }
  if (id === "health") {
    const h = s.health;
    if (h.state === "format-changed" || h.state === "no-dir" || h.state === "permission")
      return `<span class="cnt warn" aria-hidden="true"> · !</span><span class="sr"> (needs attention)</span>`;
    if (h.partial) return `<span class="cnt warn" aria-hidden="true"> · *</span><span class="sr"> (partial data)</span>`;
  }
  return "";
}

/** The section menu (A2): Overview on top, then the Usage, Insight and Health groups,
 * each a labelled list; an inline icon and the label on every link. A toggle at the top
 * collapses it to an icon rail (labels stay for screen readers, and each link keeps a
 * tooltip), or expands it again; the choice is the extension's, sent as `collapsed`. */
export function sideNav(s: Snapshot | undefined, active: SectionId, collapsed = false): string {
  const item = (d: SectionDef) => {
    const current = d.id === active ? ' aria-current="page"' : "";
    const tip = collapsed ? ` title="${escapeHtml(d.label)}"` : "";
    return `<li><a href="${escapeHtml(sectionHref(d.id))}"${current}${tip}>${icon(d.icon)}<span class="lbl">${escapeHtml(d.label)}</span>${navExtra(s, d.id)}</a></li>`;
  };
  const lists: string[] = [];
  const groups: string[] = [];
  for (const d of SECTION_DEFS) {
    const g = d.group ?? "";
    if (!groups.includes(g)) groups.push(g);
  }
  for (const g of groups) {
    const items = SECTION_DEFS.filter((d) => (d.group ?? "") === g).map(item).join("");
    if (!g) {
      lists.push(`<ul>${items}</ul>`);
      continue;
    }
    const id = `nav-${g.toLowerCase()}`;
    lists.push(`<p class="grp" id="${id}">${escapeHtml(g)}</p><ul aria-labelledby="${id}">${items}</ul>`);
  }
  const label = collapsed ? "Expand side navigation" : "Collapse side navigation";
  const toggle = `<div class="navtop"><a class="navtoggle" href="${escapeHtml(navToggleHref())}" title="${label}" aria-label="${label}" aria-expanded="${collapsed ? "false" : "true"}">${icon(collapsed ? "navExpand" : "navCollapse")}</a></div>`;
  return `<nav class="sidenav${collapsed ? " collapsed" : ""}" aria-label="Sections">${toggle}${lists.join("")}</nav>`;
}

/** Skip link (first focusable element) and the nav + main shell around a section body. */
export function shell(s: Snapshot | undefined, def: SectionDef, description: string, body: string, navCollapsed = false): string {
  return `<div class="shell${navCollapsed ? " navcollapsed" : ""}">
${sideNav(s, def.id, navCollapsed)}
<main id="main" class="content" aria-labelledby="section-title">
<h2 id="section-title" class="sec">${escapeHtml(def.label)}</h2>
<p class="secdesc">${escapeHtml(description)}</p>
${body}
</main>
</div>`;
}

export function skipLink(def: SectionDef): string {
  return `<a class="skip" href="#main">Skip to ${escapeHtml(def.label)}</a>`;
}
