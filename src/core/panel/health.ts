// Data health (D32): what was read, what was skipped and what is not counted.
import { CHAT_NOT_COVERED, NOT_COVERED, SESSION_TOTAL_NOTE } from "../format";
import type { Snapshot } from "../types";
import { escapeHtml } from "./shared";
import { sourcesHealthBox } from "./sources";

export function healthBox(s: Snapshot): string {
  const h = s.health;
  const fact = (k: string, v: number, warn = false) =>
    `<div class="fact"><span>${escapeHtml(k)}</span><span class="num${warn && v > 0 ? " star" : ""}">${v}</span></div>`;
  // Always shown, first (2.6): Copilot Chat in VS Code is the gap most readers hit.
  const chat = `<div class="note"><p>${escapeHtml(CHAT_NOT_COVERED)}</p></div>`;
  return `${chat}<section class="box"><h3>Logs read<small>read-only · nothing leaves this computer</small></h3><div class="facts">
${fact("Sessions this month", s.sessions.length)}
${fact("Months of history", s.history?.length ?? 1)}
${fact("Unreadable logs", h.unreadableFiles, true)}
${fact("Sessions counted from session totals", h.sessionsFromTotals)}
${fact("Sessions without usage data", h.sessionsWithoutUsage)}
${fact("Lines in an unknown format", h.unrecognized, true)}
${fact("Malformed lines", h.malformed, true)}
${fact("Over-long lines skipped (may be usage)", h.overlong, true)}
${h.overlongOther > 0 ? fact("Over-long lines skipped (not usage)", h.overlongOther) : ""}
${h.shutdownOversize > 0 ? fact("Session-end lines too long to read", h.shutdownOversize, true) : ""}
</div>${h.sessionsFromTotals > 0 ? `<div class="fine">${escapeHtml(SESSION_TOTAL_NOTE)}</div>` : ""}<h3 class="sub">Not covered</h3><ul class="plain">${NOT_COVERED.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></section>${sourcesHealthBox(s)}`;
}

export function renderHealth(s: Snapshot): string {
  return healthBox(s);
}
