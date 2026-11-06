// Tools (D32): per-tool table for the viewed month; each row filters to calls
// that used that tool (D26). Session totals carry no tool data.
import { costLabel, currencyCode, formatCount, formatUsd } from "../format";
import type { Snapshot, ToolSummary, ViewOptions } from "../types";
import { filterHref } from "./links";
import { card, escapeHtml, foldedTable, monthTitle, plural, projectLabel, TABLE_LIMIT, val, viewedName, viewedStart, withStar } from "./shared";

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

export function toolsBox(s: Snapshot, view: ViewOptions): string {
  const list: ToolSummary[] = s.month?.tools ?? [];
  const scope = monthTitle(viewedStart(s));
  const partial = s.health.partial;
  const active = s.filter?.tool;
  const totals = s.month?.totalsSessions ?? 0;
  const month = viewedName(s);
  if (list.length === 0) {
    const text = totals > 0
      ? `No tool use logged in ${month}. Tool use is logged per model call; the ${plural(totals, "session")} counted from session totals ${totals === 1 ? "has" : "have"} no tool data.`
      : `No tool use logged in ${month}${s.filter?.project ? " for this filter" : ""}.`;
    return card("tools-title", "tools", "By tool", scope, `<p class="muted">${escapeHtml(text)}</p>`);
  }
  const added = list.filter((t) => !t.builtIn);
  const rows = list.map((t) => {
    const on = t.name === active;
    const href = filterHref("tool", on ? "" : t.name);
    const kind = t.builtIn ? `<span class="tag">built-in</span>` : `<span class="tag add">added</span>`;
    return {
      keep: on,
      html: `<tr${on ? ' class="on"' : ""}><td><a class="rowlink num" href="${escapeHtml(href)}" aria-label="${escapeHtml(on ? `${t.name}, filtered. Clear the tool filter` : `${t.name}. Show only calls that used this tool`)}" title="${on ? "Clear the tool filter" : "Show only calls that used this tool"}">${escapeHtml(t.name)}</a>${on ? ` <span class="tag on" aria-hidden="true">filtered</span>` : ""}</td><td>${kind}</td><td class="num">${t.uses}</td><td class="num">${t.calls}</td><td class="num${view.unit === "tokens" ? " sum" : ""}">${val(withStar(formatCount(t.tokens), partial))}</td><td class="num${view.unit === "cost" ? " sum" : ""}">${val(withStar(formatUsd(t.nanoAiu), partial))}</td></tr>`,
    };
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
  const totalsNote = totals > 0
    ? `<p>${escapeHtml(`${plural(totals, "session")} counted from session totals ${totals === 1 ? "is" : "are"} not in this table: session totals have no tool data.`)}</p>`
    : "<p>Session totals from Copilot before 1.0.99 have no tool data, so they are never in this table.</p>";
  return card("tools-title", "tools", "By tool", `${scope} · ${plural(list.length, "tool")} · click to filter`, `${foldedTable(`<th>Tool</th><th>Kind</th><th>Uses</th><th>Calls</th><th>Tokens</th><th>${costLabel()}</th>`, rows, undefined, `Usage by tool, ${scope}`)}<div class="fine"><p>${escapeHtml(addedNote)}</p><p>Uses = times the model invoked the tool. Calls / Tokens / ${escapeHtml(currencyCode())} = the model calls that invoked it; a call that used two tools counts for both, so rows do not add up to the month.${escapeHtml(note)}</p>${totalsNote}</div>`);
}

export function renderTools(s: Snapshot, view: ViewOptions): string {
  return toolsBox(s, view);
}
