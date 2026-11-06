// Models (D32): the viewed month's table by model, with a Share column.
import { formatCount, formatUsd, money, partialNote, usd } from "../format";
import { modelFamily } from "../store";
import type { Snapshot, Totals, ViewOptions } from "../types";
import { CALLS_MISSING_NOTE, callsCell, card, DASH, sym, escapeHtml, foldedTable, headlineValue, inHundred, monthTitle, plural, titleAttr, tokens, totalsFine, unitWord, val, viewedName, viewedStart, withStar } from "./shared";

export function renderModels(s: Snapshot, view: ViewOptions): string {
  const partial = s.health.partial;
  const t: Totals | undefined = s.month?.totals;
  const scope = monthTitle(viewedStart(s));
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
      const cell = (x: string, note?: string) => `<td class="num${x === DASH ? " muted" : ""}"${titleAttr(note)}>${val(withStar(x, partial))}</td>`;
      // Per call uses per-call records only (their AIU and their count); a session total is not a call.
      const perCall = usd(c.callNanoAiu);
      const perCallRows = c.callNanoAiu.reported;
      const perCallText = perCall === undefined || perCallRows === 0 ? DASH : money(perCall / perCallRows);
      const callsText = callsCell(c.calls, c.callsMissing);
      const shareText = inHundred(v, total);
      const bar = share > 0 ? `<span class="bar f-${fam}" style="width:${share}%" aria-hidden="true"></span>` : "";
      return `<tr><td><span class="chipm f-${fam}" title="${escapeHtml(m)}">${escapeHtml(m)}</span>${bar}</td><td class="num${shareText === DASH ? " muted" : ""}">${shareText === DASH ? val(DASH) : sym(shareText)}</td>${cell(formatCount(c.input), partialNote(c.input))}${cell(formatCount(c.output), partialNote(c.output))}${cell(formatCount(c.cacheRead), partialNote(c.cacheRead))}<td class="num${view.unit === "tokens" ? " sum" : ""}"${titleAttr(partialNote(tok))}>${val(withStar(formatCount(tok), partial))}</td><td class="num${view.unit === "cost" ? " sum" : ""}"${titleAttr(partialNote(c.nanoAiu))}>${val(withStar(formatUsd(c.nanoAiu), partial))}</td>${cell(perCallText)}<td class="num${callsText === DASH ? " muted" : ""}"${titleAttr(c.callsMissing > 0 ? CALLS_MISSING_NOTE : undefined)}>${val(callsText)}</td></tr>`;
    });
  const empty = `No model usage logged in ${viewedName(s)}${s.filter ? " for this filter" : ""}.`;
  const body = rows.length
    ? foldedTable(
        "<th>Model</th><th>Share</th><th>Input</th><th>Output</th><th>Cache read</th><th>Tokens</th><th>USD (est.)</th><th>Per call</th><th>Calls</th>",
        rows.map((html) => ({ html })),
        undefined,
        `Usage by model, ${scope}`,
      )
    : `<p class="muted">${escapeHtml(empty)}</p>`;
  const totalsNote = totalsFine(t?.sessionTotals ?? 0, scope);
  return card("models-title", "models", `${scope} by model`, `${plural(models.length, "model")}${s.filter ? " · filtered" : ""}`, `${body}<div class="fine">${totalsNote}<p>Share = this model's part of the month's ${escapeHtml(unitWord(view))}, out of 100. Per call = estimated USD per model call, from per-call records only. Calls include the request count logged with each session total. "—" means the log did not report the value; it is never shown as 0.</p></div>`);
}
