// The source dimension in the panel (D40, D46, D49): source chips for table rows, the
// Overview's By source card and the Data health Sources box. Labels come only from
// SOURCE_LABEL and class names only from SOURCES, never from a log. Chips and the card
// appear only when a source other than Copilot has records in scope.
import { COST_SOURCES_NOTE, costLabel, enabledSources, formatCount, formatUsd, mixedSources, SOURCE_HOME_SETTING, SOURCE_TOGGLE_SETTING } from "../format";
import { type Snapshot, type Source, SOURCE_LABEL, SOURCES, type SourceHealth, type ViewOptions } from "../types";
import { filterHref } from "./links";
import { callsCell, card, DASH, escapeHtml, fact, foldedTable, monthTitle, plural, tokens, val, viewedStart, withStar } from "./shared";

/** One chip per source with records, in SOURCES order; "" when none. */
export function sourceChips(sources: Partial<Record<Source, number>> | undefined): string {
  if (!sources) return "";
  return SOURCES.filter((x) => (sources[x] ?? 0) > 0)
    .map((x) => `<span class="srcchip src-${x}">${escapeHtml(SOURCE_LABEL[x])}</span>`)
    .join("");
}

/** True when the viewed month has records of a source other than Copilot (the chips' and notes' gate). */
export function monthMixed(s: Snapshot): boolean {
  return mixedSources(s.month?.totals?.sources);
}

/** Chips for a table row, only when the viewed month mixes sources; with a leading space. */
export function rowChips(s: Snapshot, sources: Partial<Record<Source, number>> | undefined): string {
  if (!monthMixed(s)) return "";
  const html = sourceChips(sources);
  return html ? ` <span class="srcchips">${html}</span>` : "";
}

/** The Overview's By source card for the viewed month (D49): one row per source with records;
 * click a row to filter to that source. Empty unless a non-Copilot source is in scope. */
export function renderSourcesCard(s: Snapshot, view: ViewOptions): string {
  const t = s.month?.totals;
  const active = s.filter?.source;
  if (!t || (!mixedSources(t.sources) && active === undefined)) return "";
  const scope = monthTitle(viewedStart(s));
  const partial = s.health.partial;
  // Counted by the monitor before the 50-row cut; never derived from the capped list.
  const sess = s.month?.sessionsBySource;
  const rows = SOURCES.filter((x) => (t.sources?.[x] ?? 0) > 0 || t.bySource?.[x] !== undefined).map((x) => {
    const c = t.bySource?.[x];
    const on = x === active;
    const label = SOURCE_LABEL[x];
    const href = filterHref("source", on ? "" : x);
    const aria = on ? `${label}, filtered. Clear the source filter` : `${label}. Show only this source`;
    const tok = c ? withStar(formatCount(tokens(c)), partial) : DASH;
    // Claude Code and Codex log no cost: their USD is "—", never 0 (D46).
    const cost = c && x === "copilot" ? withStar(formatUsd(c.nanoAiu), partial) : DASH;
    const calls = c ? callsCell(c.calls, c.callsMissing) : DASH;
    const td = (text: string, sum = false) => `<td class="num${sum ? " sum" : ""}${text === DASH ? " muted" : ""}">${val(text)}</td>`;
    return {
      keep: on,
      html: `<tr${on ? ' class="on"' : ""}><td><a class="rowlink" href="${escapeHtml(href)}" aria-label="${escapeHtml(aria)}" title="${on ? "Clear the source filter" : "Show only this source"}">${escapeHtml(label)}</a> <span class="srcdot src-${x}" aria-hidden="true"></span>${on ? ` <span class="tag on" aria-hidden="true">filtered</span>` : ""}</td>${td(tok, view.unit === "tokens")}${td(cost, view.unit === "cost")}${td(calls)}${sess ? td(String(sess[x] ?? 0)) : ""}</tr>`,
    };
  });
  const body = `${foldedTable(`<th>Source</th><th>Tokens</th><th>${escapeHtml(costLabel())}</th><th>Calls</th>${sess ? "<th>Sessions</th>" : ""}`, rows, undefined, `Usage by source, ${scope}`)}<div class="fine"><p>${escapeHtml(COST_SOURCES_NOTE)}</p></div>`;
  return card("sources-title", "overview", "By source", `${scope} · ${plural(rows.length, "source")} · click to filter`, body, "srccard");
}

/** "Off (copilotUsageMonitor.claudeCode)", "Folder not found (…Home)", "12 files, 4 sessions read". */
function sourceStatus(x: Source, h: SourceHealth): string {
  if (h.state === "off") return x === "copilot" ? "Off" : `Off (${SOURCE_TOGGLE_SETTING[x]})`;
  if (h.state === "no-dir") return `Folder not found (${SOURCE_HOME_SETTING[x]})`;
  if (h.state === "permission") return `Unreadable (${SOURCE_HOME_SETTING[x]})`;
  const read = `${plural(h.files, "file")}, ${plural(h.sessions, "session")} read`;
  return h.state === "format-changed" ? `${read} · the log format may have changed` : read;
}

const ORIGIN: Record<Source, Record<SourceHealth["rootSource"], string>> = {
  copilot: { setting: "setting", env: "COPILOT_HOME", default: "default" },
  "claude-code": { setting: "setting", env: "CLAUDE_CONFIG_DIR", default: "default" },
  codex: { setting: "setting", env: "CODEX_HOME", default: "default" },
};

/** "Copilot default · Claude Code setting": each enabled source's folder origin. */
export function sourceOrigins(s: Snapshot): string | undefined {
  const per = s.health.sources;
  const on = enabledSources(s.health);
  if (!per || !on || !on.some((x) => x !== "copilot")) return undefined;
  return on.map((x) => `${SOURCE_LABEL[x]} ${ORIGIN[x][per[x]!.rootSource]}`).join(" · ");
}

/** Data health's Sources box (D49): one row per source in health.sources, then its counters.
 * Empty when the snapshot carries no per-source health. */
export function sourcesHealthBox(s: Snapshot): string {
  const per = s.health.sources;
  if (!per) return "";
  const rows = SOURCES.filter((x) => per[x] !== undefined).map((x) => {
    const h = per[x]!;
    const head = `<h4 class="srch"><span class="srcchip src-${x}">${escapeHtml(SOURCE_LABEL[x])}</span> <span>${escapeHtml(sourceStatus(x, h))}</span></h4>`;
    if (h.state === "off" || h.state === "no-dir") return head;
    const facts = [
      fact("Unreadable logs", h.unreadableFiles, true),
      fact("Lines in an unknown format", h.unrecognized, true),
      fact("Malformed lines", h.malformed, true),
      fact("Over-long lines skipped (may be usage)", h.overlong, true),
      h.overlongOther > 0 ? fact("Over-long lines skipped (not usage)", h.overlongOther) : "",
      h.capped !== undefined ? fact("Files beyond the cap, not read", h.capped, true) : "",
      h.archived !== undefined ? fact("Archived sessions not read", h.archived) : "",
    ].join("");
    return `${head}<div class="facts">${facts}</div>`;
  });
  return `<section class="box" aria-labelledby="sources-health-title"><h3 id="sources-health-title">Sources<small>one row per tool whose logs this extension can read</small></h3>${rows.join("")}</section>`;
}
