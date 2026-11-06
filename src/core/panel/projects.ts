// Projects (D32): per-project table for the viewed month; each row filters to that project (D26).
import { costLabel, formatCount, formatUsd } from "../format";
import { NO_PROJECT } from "../store";
import type { GroupSummary, Snapshot, ViewOptions } from "../types";
import { filterHref } from "./links";
import { CALLS_MISSING_NOTE, callsCell, card, DASH, escapeHtml, foldedTable, monthTitle, plural, titleAttr, val, viewedName, viewedStart, withStar } from "./shared";

function share(part: { sum: number; reported: number }, whole: number | undefined): number {
  return whole && part.reported > 0 ? Math.round((100 * part.sum) / whole) : 0;
}

export function projectsBox(s: Snapshot, view: ViewOptions): string {
  const list: GroupSummary[] = s.month?.projects ?? [];
  const scope = monthTitle(viewedStart(s));
  const partial = s.health.partial;
  const active = s.filter?.project;
  if (list.length === 0) {
    return card("projects-title", "projects", "By project", scope, `<p class="muted">${escapeHtml(`No project usage logged in ${viewedName(s)}${s.filter?.tool ? " for this filter" : ""}.`)}</p>`);
  }
  const whole = list.reduce((a, g) => a + (view.unit === "cost" ? g.nanoAiu.sum : g.tokens.sum), 0);
  const rows = list.map((g) => {
    const on = g.name === active;
    const pct = share(view.unit === "cost" ? g.nanoAiu : g.tokens, whole);
    const href = filterHref("project", on ? "" : g.name);
    const plain = g.name === NO_PROJECT ? g.name : (g.label ?? g.name);
    const name = g.name === NO_PROJECT ? `<span class="muted">${escapeHtml(g.name)}</span>` : escapeHtml(plain);
    const aria = on ? `${plain}, filtered. Clear the project filter` : `${plain}. Show only this project`;
    return {
      keep: on,
      html: `<tr${on ? ' class="on"' : ""}><td><a class="rowlink" href="${escapeHtml(href)}" aria-label="${escapeHtml(aria)}" title="${on ? "Clear the project filter" : "Show only this project"}">${name}</a>${on ? ` <span class="tag on" aria-hidden="true">filtered</span>` : ""}${pct > 0 ? `<span class="bar f-gemini" style="width:${pct}%" aria-hidden="true"></span>` : ""}</td><td class="num">${g.sessions}</td><td class="num${callsCell(g.calls, g.callsMissing) === DASH ? " muted" : ""}"${titleAttr(g.callsMissing ? CALLS_MISSING_NOTE : undefined)}>${val(callsCell(g.calls, g.callsMissing))}</td><td class="num${view.unit === "tokens" ? " sum" : ""}">${val(withStar(formatCount(g.tokens), partial))}</td><td class="num${view.unit === "cost" ? " sum" : ""}">${val(withStar(formatUsd(g.nanoAiu), partial))}</td></tr>`,
    };
  });
  const note = s.filter?.tool ? ` Only calls that used ${s.filter.tool}.` : "";
  return card("projects-title", "projects", "By project", `${scope} · ${plural(list.length, "project")} · click to filter`, `${foldedTable(`<th>Project</th><th>Sessions</th><th>Calls</th><th>Tokens</th><th>${costLabel()}</th>`, rows, undefined, `Usage by project, ${scope}`)}<div class="fine">Project = the session's GitHub repository, else its folder name (or its title when the folder is named by an ID); full paths are never read. Sessions and calls include sessions counted from session totals.${escapeHtml(note)}</div>`);
}

export function renderProjects(s: Snapshot, view: ViewOptions): string {
  return projectsBox(s, view);
}
